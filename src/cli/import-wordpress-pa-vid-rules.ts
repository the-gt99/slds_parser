import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { loadWordPressTargetConfig } from "../config/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import { TargetDictionaryProviderRegistry, WordPressDictionaryProvider } from "../integrations/index.js";
import {
  createPostgresPool,
  PostgresTargetAssignmentRuleRepository,
  PostgresTargetDictionaryRepository,
  type SqlPool,
} from "../infrastructure/db/index.js";
import type {
  TargetAssignmentConditionRecord,
  TargetAssignmentRuleDraft,
  TargetDictionaryValueRecord,
} from "../repositories/index.js";
import { TargetAssignmentAdminService } from "../services/index.js";

interface LegacyTagValue {
  readonly id: string | number;
  readonly label?: string;
}

interface LegacyRule {
  readonly type: string;
  readonly pattern?: string;
  readonly values?: readonly LegacyTagValue[];
}

interface LegacyGroup {
  readonly rules?: readonly LegacyRule[];
}

interface LegacyValueLogic {
  readonly groups?: readonly LegacyGroup[];
}

interface LegacyPaVidConfig {
  readonly name: string;
  readonly slug: string;
  readonly apply_mode: string;
  readonly values: readonly string[];
  readonly value_logic: Readonly<Record<string, LegacyValueLogic>>;
}

interface InternalReferenceLink {
  readonly externalId: string;
  readonly referenceValueId: string;
  readonly typeCode: string;
}

interface PlannedSportRule {
  readonly name: string;
  readonly priority: number;
  readonly dictionaryValue: TargetDictionaryValueRecord;
  readonly patterns: readonly string[];
  readonly tagIds: readonly string[];
  readonly references: ReadonlyMap<string, readonly string[]>;
  readonly unmappedTagIds: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseLegacyPaVidConfig(value: unknown): LegacyPaVidConfig {
  if (!isRecord(value) || !Array.isArray(value.values) || !isRecord(value.value_logic)) {
    throw new IntegrationContractError("Legacy pa_vid configuration has an invalid structure");
  }
  const values = value.values.map((entry) => String(entry).trim());
  if (values.length === 0 || values.some((entry) => entry === "")) {
    throw new IntegrationContractError("Legacy pa_vid configuration has no valid values");
  }
  return {
    name: String(value.name ?? "").trim(),
    slug: String(value.slug ?? "").trim(),
    apply_mode: String(value.apply_mode ?? "").trim(),
    values,
    value_logic: value.value_logic as Readonly<Record<string, LegacyValueLogic>>,
  };
}

export function unwrapPhpRegex(value: string): string {
  const pattern = value.trim();
  if (!pattern.startsWith("/")) throw new IntegrationContractError(`Unsupported legacy regex: ${value}`);
  const closing = pattern.lastIndexOf("/");
  if (closing <= 0) throw new IntegrationContractError(`Unsupported legacy regex: ${value}`);
  const flags = pattern.slice(closing + 1);
  if (!/^[iu]*$/u.test(flags)) throw new IntegrationContractError(`Unsupported legacy regex flags: ${flags}`);
  const body = pattern.slice(1, closing);
  if (body.trim() === "") throw new IntegrationContractError("Legacy regex cannot be empty");
  return body;
}

function legacyRules(config: LegacyPaVidConfig, name: string): readonly LegacyRule[] {
  return (config.value_logic[name]?.groups ?? []).flatMap((group) => group.rules ?? []);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function extractLegacyPatterns(config: LegacyPaVidConfig, name: string): readonly string[] {
  return unique(legacyRules(config, name)
    .filter((rule) => rule.type === "text" && typeof rule.pattern === "string")
    .map((rule) => unwrapPhpRegex(rule.pattern!)));
}

export function extractLegacyTagIds(config: LegacyPaVidConfig, name: string): readonly string[] {
  return unique(legacyRules(config, name)
    .filter((rule) => rule.type === "tag")
    .flatMap((rule) => rule.values ?? [])
    .map((entry) => String(entry.id)));
}

async function queryRows<Row extends Record<string, unknown>>(pool: SqlPool, sql: string, parameters: readonly unknown[] = []): Promise<readonly Row[]> {
  const client = await pool.connect();
  try {
    return (await client.query<Row>(sql, [...parameters])).rows;
  } finally {
    client.release();
  }
}

async function referenceLinks(pool: SqlPool, targetId: string, externalIds: readonly string[]): Promise<readonly InternalReferenceLink[]> {
  if (externalIds.length === 0) return [];
  return (await queryRows<{ external_id: string; reference_value_id: string; type_code: string }>(pool, `
    WITH wanted AS (
      SELECT id, external_id
      FROM target_dictionary_values
      WHERE target_id = $1 AND entity_type = 'tags' AND active = TRUE AND external_id = ANY($2::TEXT[])
    ), links AS (
      SELECT wanted.external_id, mapping.reference_value_id, type.code AS type_code
      FROM wanted
      JOIN target_value_mappings mapping ON mapping.dictionary_value_id = wanted.id AND mapping.active = TRUE
      JOIN reference_values value ON value.id = mapping.reference_value_id AND value.enabled = TRUE
      JOIN reference_types type ON type.id = value.type_id
      UNION
      SELECT wanted.external_id, projection.reference_value_id, type.code
      FROM wanted
      JOIN target_reference_projections projection ON projection.dictionary_value_id = wanted.id AND projection.active = TRUE
      JOIN reference_values value ON value.id = projection.reference_value_id AND value.enabled = TRUE
      JOIN reference_types type ON type.id = value.type_id
      UNION
      SELECT wanted.external_id, mapping.reference_value_id, type.code
      FROM wanted
      JOIN target_classification_projections projection ON projection.dictionary_value_id = wanted.id AND projection.active = TRUE
      JOIN source_reference_mappings mapping ON mapping.id = projection.mapping_id AND mapping.status = 'confirmed'
      JOIN reference_values value ON value.id = mapping.reference_value_id AND value.enabled = TRUE
      JOIN reference_types type ON type.id = value.type_id
      UNION
      SELECT wanted.external_id, rule.reference_value_id, type.code
      FROM wanted
      JOIN target_classification_projections projection ON projection.dictionary_value_id = wanted.id AND projection.active = TRUE
      JOIN source_reference_rules rule ON rule.id = projection.rule_id AND rule.enabled = TRUE
      JOIN reference_values value ON value.id = rule.reference_value_id AND value.enabled = TRUE
      JOIN reference_types type ON type.id = value.type_id
    )
    SELECT external_id, reference_value_id::TEXT, type_code
    FROM links
    ORDER BY external_id, type_code, reference_value_id
  `, [targetId, externalIds])).map((row) => ({
    externalId: row.external_id,
    referenceValueId: row.reference_value_id,
    typeCode: row.type_code,
  }));
}

function referencesByType(tagIds: readonly string[], links: readonly InternalReferenceLink[]): ReadonlyMap<string, readonly string[]> {
  const selected = new Set(tagIds);
  const grouped = new Map<string, string[]>();
  for (const link of links) {
    if (!selected.has(link.externalId)) continue;
    grouped.set(link.typeCode, [...(grouped.get(link.typeCode) ?? []), link.referenceValueId]);
  }
  return new Map([...grouped].map(([typeCode, values]) => [typeCode, unique(values)]));
}

function inlineConditions(plan: PlannedSportRule): readonly TargetAssignmentConditionRecord[] {
  const regex = plan.patterns.flatMap((pattern) => ([
    { field: "product.title", operator: "regex", values: [pattern] },
    { field: "product.description", operator: "regex", values: [pattern] },
  ] as const));
  const references = [...plan.references].map(([typeCode, values]) => ({
    field: `resolved.${typeCode}`,
    operator: "one_of" as const,
    values,
  }));
  return [...regex, ...references];
}

function codePart(index: number, typeCode: string): string {
  return `legacy_vid_${String(index + 1).padStart(2, "0")}_${typeCode}`;
}

function draftFor(plan: PlannedSportRule, targetId: string, conditions: readonly TargetAssignmentConditionRecord[]): TargetAssignmentRuleDraft {
  return {
    targetId,
    name: `Вид спорта: ${plan.name} (импорт WordPress)`,
    groupCode: "legacy_pa_vid",
    priority: plan.priority,
    enabled: false,
    conditionGroups: [{ conditions }],
    actions: [{ targetScope: "product.activity", dictionaryValueId: plan.dictionaryValue.id, mode: "add" }],
  };
}

async function main(): Promise<void> {
  const path = process.env.LEGACY_PA_VID_RULES_PATH?.trim();
  if (!path) throw new IntegrationContractError("LEGACY_PA_VID_RULES_PATH is required");
  const apply = process.env.LEGACY_PA_VID_APPLY?.toLowerCase() === "true" || process.env.LEGACY_PA_VID_APPLY === "1";
  const previewRules = process.env.LEGACY_PA_VID_PREVIEW !== "0" && process.env.LEGACY_PA_VID_PREVIEW?.toLowerCase() !== "false";
  const config = parseLegacyPaVidConfig(JSON.parse(await readFile(path, "utf8")));
  if (config.slug !== "vid" || config.apply_mode !== "append") {
    throw new IntegrationContractError("Only the legacy vid/append configuration can be imported");
  }

  const wordpress = loadWordPressTargetConfig();
  if (wordpress === null) throw new IntegrationContractError("WordPress target configuration is required");
  const pool = createPostgresPool();
  try {
    const dictionaries = new PostgresTargetDictionaryRepository(pool);
    const target = (await dictionaries.listTargets()).find((item) => item.code === (process.env.LEGACY_PA_VID_TARGET ?? "slamdunk"));
    if (target === undefined) throw new IntegrationContractError("Target was not found");
    if (target.enabled) throw new IntegrationContractError(`Target ${target.code} must stay disabled during pa_vid import`);
    const activityValues = await dictionaries.listValues({ targetId: target.id, entityType: "activities", limit: 1000, offset: 0 });
    const activityByName = new Map(activityValues.map((item) => [item.name.trim().normalize("NFKC").toLocaleLowerCase("ru-RU"), item]));
    const allTagIds = unique(config.values.flatMap((name) => extractLegacyTagIds(config, name)));
    const links = await referenceLinks(pool, target.id, allTagIds);
    const mappedTagIds = new Set(links.map((link) => link.externalId));
    const plans: PlannedSportRule[] = config.values.map((name, index) => {
      const dictionaryValue = activityByName.get(name.normalize("NFKC").toLocaleLowerCase("ru-RU"));
      if (dictionaryValue === undefined) throw new IntegrationContractError(`WordPress activity term is missing: ${name}`);
      const tagIds = extractLegacyTagIds(config, name);
      return {
        name,
        priority: config.values.length - index,
        dictionaryValue,
        patterns: extractLegacyPatterns(config, name),
        tagIds,
        references: referencesByType(tagIds, links),
        unmappedTagIds: tagIds.filter((id) => !mappedTagIds.has(id)),
      };
    });

    const providers = new TargetDictionaryProviderRegistry();
    providers.register(new WordPressDictionaryProvider(wordpress));
    const repository = new PostgresTargetAssignmentRuleRepository(pool);
    const admin = new TargetAssignmentAdminService(repository, dictionaries, providers, "legacy-pa-vid-import");
    const previews = [];
    for (const plan of plans) {
      const conditions = inlineConditions(plan);
      if (conditions.length === 0) throw new IntegrationContractError(`Legacy activity has no usable conditions: ${plan.name}`);
      const preview = previewRules ? await admin.preview(draftFor(plan, target.id, conditions)) : null;
      previews.push({
        name: plan.name,
        priority: plan.priority,
        patterns: plan.patterns.length,
        tagIds: plan.tagIds.length,
        mappedTagIds: plan.tagIds.length - plan.unmappedTagIds.length,
        unmappedTagIds: plan.unmappedTagIds.length,
        references: Object.fromEntries([...plan.references].map(([typeCode, values]) => [typeCode, values.length])),
        productCount: preview?.productCount ?? null,
        examples: preview?.examples ?? [],
      });
    }

    const appliedRules = [];
    if (apply) {
      const existingSets = new Map((await admin.listMatchSets(target.id)).map((item) => [item.code, item]));
      const existingRules = await admin.list(target.id);
      for (const [index, plan] of plans.entries()) {
        const conditions: TargetAssignmentConditionRecord[] = plan.patterns.flatMap((pattern) => ([
          { field: "product.title", operator: "regex", values: [pattern] },
          { field: "product.description", operator: "regex", values: [pattern] },
        ]));
        for (const [typeCode, values] of plan.references) {
          const code = codePart(index, typeCode);
          const draft = { targetId: target.id, code, name: `${plan.name}: ${typeCode}`, values, reason: "Импорт старой логики pa_vid из WordPress" };
          const existing = existingSets.get(code);
          const saved = existing === undefined
            ? await admin.createMatchSet(draft)
            : await admin.updateMatchSet(target.id, existing.id, draft, existing.revision);
          existingSets.set(code, saved);
          conditions.push({ field: `resolved.${typeCode}`, operator: "one_of", values: [], matchSetId: saved.id });
        }
        const draft = draftFor(plan, target.id, conditions);
        const matches = existingRules.filter((item) => item.groupCode === draft.groupCode && item.name === draft.name);
        if (matches.length > 1) throw new IntegrationContractError(`Duplicate imported assignment rules: ${draft.name}`);
        const saved = matches[0] === undefined
          ? await admin.create(draft)
          : await admin.update(target.id, matches[0].id, draft, matches[0].revision, "legacy-pa-vid-import", "Повторный импорт старой логики pa_vid");
        appliedRules.push({ id: saved.id, name: saved.name, enabled: saved.enabled, revision: saved.revision });
      }
    }

    const dictionaryTagIds = new Set((await dictionaries.listValues({ targetId: target.id, entityType: "tags", limit: 100_000, offset: 0 })).map((item) => item.externalId));
    console.log(JSON.stringify({
      mode: apply ? "apply" : "preview",
      rulePreviewExecuted: previewRules,
      target: { id: target.id, code: target.code, enabled: target.enabled },
      source: { values: config.values.length, tagReferences: allTagIds.length },
      coverage: {
        dictionaryTagIds: allTagIds.filter((id) => dictionaryTagIds.has(id)).length,
        mappedTagIds: mappedTagIds.size,
        unmappedTagIds: allTagIds.filter((id) => !mappedTagIds.has(id)).length,
      },
      rules: previews,
      appliedRules,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
