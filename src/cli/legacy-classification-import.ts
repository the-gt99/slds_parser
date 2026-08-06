import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { TargetDictionaryProviderRegistry, WordPressDictionaryProvider } from "../integrations/index.js";
import {
  createPostgresPool,
  createPostgresRepositories,
  PostgresClassificationAdminRepository,
  PostgresTargetDictionaryRepository,
  type SqlExecutor,
  type SqlPool,
} from "../infrastructure/db/index.js";
import type { ClassificationReviewItem, TargetDictionaryValueRecord } from "../repositories/index.js";
import { ClassifierAdminService, normalizeSourceValue } from "../services/index.js";
import { loadWordPressTargetConfig } from "../config/index.js";

type CandidateKind = "mapping" | "rule" | "projection";
type CandidateStatus = "accepted" | "rejected" | "conflict" | "already_exists";

interface LegacyCandidate {
  readonly kind: CandidateKind;
  readonly group: string;
  readonly typeCode: string;
  readonly sourceValue: string;
  readonly targetName: string;
  readonly entityType: string;
  readonly targetScope: string;
  readonly sourceScopes?: readonly string[];
  readonly provenance: readonly string[];
}

interface PlannedCandidate extends LegacyCandidate {
  readonly status: CandidateStatus;
  readonly reason: string;
  readonly dictionaryValue?: TargetDictionaryValueRecord;
  readonly reviews: readonly ClassificationReviewItem[];
  readonly existingMappingIds: readonly string[];
  readonly affectedSourceProductIds: readonly string[];
}

const COLOR_PAIRS = [
  ["Pink", "Розовый"],
  ["Black", "Черный"],
  ["White", "Белый"],
  ["Grey", "Серый"],
  ["Gray", "Серый"],
  ["Blue", "Синий"],
  ["Green", "Зеленый"],
  ["Red", "Красный"],
  ["Brown", "Коричневый"],
  ["Beige", "Бежевый"],
  ["Orange", "Оранжевый"],
  ["Yellow", "Желтый"],
  ["Purple", "Фиолетовый"],
  ["Multi-Color", "Многоцветный"],
  ["Silver", "Серебристый"],
  ["Gold", "Золотой"],
  ["Cream", "Кремовый"],
] as const;

const COLOR_CANDIDATES: readonly LegacyCandidate[] = COLOR_PAIRS.map(([sourceValue, targetName]) => ({
  kind: "mapping",
  group: "colors",
  typeCode: "color",
  sourceValue,
  targetName,
  entityType: "colors",
  targetScope: "product.color",
  provenance: ["explicit-safe-list:2026-08-06", "requires-current-pa_tsvet-term"],
}));

const MATERIAL_PAIRS = [
  ["Leather", "Кожа"],
  ["Suede", "Замша"],
  ["Mesh", "Сетка"],
  ["Synthetic", "Синтетика"],
  ["Textile", "Текстиль"],
  ["Canvas", "Холст"],
  ["Nubuck", "Нубук"],
  ["Nylon", "Нейлон"],
  ["Denim", "Джинсовый"],
  ["Rubber", "Резина"],
  ["Polyester", "Полиэстер"],
  ["Neoprene", "Неопрен"],
  ["Cotton", "Хлопок"],
] as const;

const MATERIAL_CANDIDATES: readonly LegacyCandidate[] = MATERIAL_PAIRS.map(([sourceValue, targetName]) => ({
  kind: "mapping",
  group: "materials",
  typeCode: "material",
  sourceValue,
  targetName,
  entityType: "materials",
  targetScope: "product.material",
  provenance: ["explicit-safe-list:2026-08-06", "requires-current-pa_material-term"],
}));

const V1_MANUAL_BRAND_PAIRS = [
  ["Anta", "ANTA"],
  ["HOKA", "HOKA"],
  ["Koyo Bear", "Koyo Bear"],
  ["Maison Mihara Yasuhiro", "Maison Mihara Yasuhiro"],
  ["Spunge", "Spunge"],
  ["Supreme", "Supreme"],
  ["UGG", "UGG"],
  ["YZY", "YZY"],
] as const;

const V1_MANUAL_BRAND_CANDIDATES: readonly LegacyCandidate[] = V1_MANUAL_BRAND_PAIRS.map(([sourceValue, targetName]) => ({
  kind: "mapping",
  group: "v1-manual-brands",
  typeCode: "brand",
  sourceValue,
  targetName,
  entityType: "brands",
  targetScope: "product.brand",
  provenance: ["parser-v1:target_classifier_mapping.match_method=manual_confirmed", "confirmed_by=dashboard", "test-probe-excluded"],
}));

const TECHNOLOGY_CANDIDATES: readonly LegacyCandidate[] = [
  "Air",
  "Boost",
  "React",
  "Flyknit",
  "Primeknit",
  "Zoom Air",
  "Air Max",
  "Fresh Foam",
  "Gel",
].map((sourceValue) => ({
  kind: "mapping",
  group: "technology-tags",
  typeCode: "tag",
  sourceValue,
  targetName: sourceValue,
  entityType: "tags",
  targetScope: "product.tag",
  sourceScopes: ["product.tag.technology", "product.tag.source"],
  provenance: ["legacy-technology-candidate-list", "requires-exact-current-product_tag"],
}));

function normalizeDictionaryName(value: string): string {
  return normalizeSourceValue(value).replace(/ё/gu, "е");
}

function uniqueByName(values: readonly TargetDictionaryValueRecord[]): ReadonlyMap<string, TargetDictionaryValueRecord> {
  const grouped = new Map<string, TargetDictionaryValueRecord[]>();
  for (const value of values) {
    const key = normalizeDictionaryName(value.name);
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  return new Map([...grouped].flatMap(([key, matches]) => matches.length === 1 ? [[key, matches[0]!] as const] : []));
}

export function legacyImportCandidates(): readonly LegacyCandidate[] {
  return [...COLOR_CANDIDATES, ...MATERIAL_CANDIDATES, ...V1_MANUAL_BRAND_CANDIDATES, ...TECHNOLOGY_CANDIDATES];
}

export function classifyLegacyCandidate(input: {
  readonly candidate: LegacyCandidate;
  readonly dictionary: TargetDictionaryValueRecord | undefined;
  readonly dictionaryDuplicateCount: number;
  readonly reviews: readonly ClassificationReviewItem[];
  readonly existingMappingIds: readonly string[];
}): PlannedCandidate {
  const affectedSourceProductIds = [...new Set(input.reviews.flatMap((review) => review.examples.map((example) => example.sourceProductId)))].sort((a, b) => Number(a) - Number(b));
  if (input.dictionaryDuplicateCount > 1) {
    return { ...input.candidate, status: "conflict", reason: "target_term_not_unique", reviews: input.reviews, existingMappingIds: input.existingMappingIds, affectedSourceProductIds };
  }
  if (input.dictionary === undefined) {
    return { ...input.candidate, status: "rejected", reason: "target_term_missing", reviews: input.reviews, existingMappingIds: input.existingMappingIds, affectedSourceProductIds };
  }
  if (input.existingMappingIds.length > 0 && input.reviews.length === 0) {
    return { ...input.candidate, status: "already_exists", reason: "mapping_already_exists", dictionaryValue: input.dictionary, reviews: input.reviews, existingMappingIds: input.existingMappingIds, affectedSourceProductIds };
  }
  if (input.reviews.length === 0) {
    return { ...input.candidate, status: "already_exists", reason: "no_unresolved_observations", dictionaryValue: input.dictionary, reviews: input.reviews, existingMappingIds: input.existingMappingIds, affectedSourceProductIds };
  }
  if (input.candidate.typeCode === "tag" && !input.reviews.every((review) => (input.candidate.sourceScopes ?? [input.candidate.targetScope]).includes(review.scope))) {
    return { ...input.candidate, status: "rejected", reason: "tag_scope_not_safe", dictionaryValue: input.dictionary, reviews: input.reviews, existingMappingIds: input.existingMappingIds, affectedSourceProductIds };
  }
  return { ...input.candidate, status: "accepted", reason: "safe_current_dictionary_match", dictionaryValue: input.dictionary, reviews: input.reviews, existingMappingIds: input.existingMappingIds, affectedSourceProductIds };
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function writeJsonl(path: string, values: readonly unknown[]) {
  await writeFile(path, values.map(jsonLine).join(""), "utf8");
}

async function sha256(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function existingMappings(pool: SqlPool, sourceId: string, typeCode: string, normalizedSourceValue: string): Promise<readonly string[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ id: string }>(
      `SELECT mapping.id::TEXT AS id
       FROM source_reference_mappings mapping
       JOIN reference_types type ON type.id = mapping.reference_type_id
       WHERE mapping.source_id = $1
         AND type.code = $2
         AND mapping.normalized_source_value = $3
         AND mapping.status = 'confirmed'
       ORDER BY mapping.id`,
      [sourceId, typeCode, normalizedSourceValue],
    );
    return result.rows.map((row) => row.id);
  } finally {
    client.release();
  }
}

async function planningContext(pool: SqlPool) {
  const repositories = createPostgresRepositories(pool as unknown as SqlExecutor);
  const adminRepository = new PostgresClassificationAdminRepository(pool);
  const dictionaries = new PostgresTargetDictionaryRepository(pool);
  const target = (await dictionaries.listTargets()).find((item) => item.code === (process.env.LEGACY_CLASSIFICATION_IMPORT_TARGET ?? "slamdunk"));
  if (target === undefined) throw new Error("Target was not found");
  if (target.enabled) throw new Error(`Target ${target.code} must stay disabled for legacy classification import`);
  const source = (await repositories.sources.listEnabled()).find((item) => item.code === (process.env.LEGACY_CLASSIFICATION_IMPORT_SOURCE ?? "goat"));
  if (source === undefined) throw new Error("Source was not found");
  return { repositories, adminRepository, dictionaries, target, source };
}

async function buildPlan(pool: SqlPool): Promise<readonly PlannedCandidate[]> {
  const { adminRepository, dictionaries, target, source } = await planningContext(pool);
  const reviewsByType = new Map<string, readonly ClassificationReviewItem[]>();
  const dictionariesByEntity = new Map<string, readonly TargetDictionaryValueRecord[]>();

  for (const typeCode of [...new Set(legacyImportCandidates().map((candidate) => candidate.typeCode))]) {
    reviewsByType.set(typeCode, await adminRepository.listReviewQueue({ sourceId: source.id, typeCode, status: "unresolved", limit: 100_000, offset: 0 }));
  }
  for (const entityType of [...new Set(legacyImportCandidates().map((candidate) => candidate.entityType))]) {
    dictionariesByEntity.set(entityType, await dictionaries.listValues({ targetId: target.id, entityType, limit: 100_000, offset: 0 }));
  }

  const planned: PlannedCandidate[] = [];
  for (const candidate of legacyImportCandidates()) {
    const normalizedSource = normalizeSourceValue(candidate.sourceValue);
    const dictionaryValues = dictionariesByEntity.get(candidate.entityType) ?? [];
    const dictionaryMatches = dictionaryValues.filter((value) => normalizeDictionaryName(value.name) === normalizeDictionaryName(candidate.targetName));
    const dictionary = uniqueByName(dictionaryValues).get(normalizeDictionaryName(candidate.targetName));
    const allowedScopes = candidate.sourceScopes ?? [candidate.targetScope];
    const reviews = (reviewsByType.get(candidate.typeCode) ?? []).filter((review) =>
      review.normalizedSourceValue === normalizedSource && allowedScopes.includes(review.scope));
    planned.push(classifyLegacyCandidate({
      candidate,
      dictionary,
      dictionaryDuplicateCount: dictionaryMatches.length,
      reviews,
      existingMappingIds: await existingMappings(pool, source.id, candidate.typeCode, normalizedSource),
    }));
  }
  return planned;
}

async function applyPlan(pool: SqlPool, plan: readonly PlannedCandidate[]) {
  const { repositories, adminRepository, dictionaries } = await planningContext(pool);
  const wordpress = loadWordPressTargetConfig();
  if (wordpress === null) throw new Error("WordPress target environment is not configured");
  const providers = new TargetDictionaryProviderRegistry();
  providers.register(new WordPressDictionaryProvider(wordpress));
  const classifier = new ClassifierAdminService(adminRepository, repositories.classifications, dictionaries, providers, "legacy-classification-import");
  const target = (await dictionaries.listTargets()).find((item) => item.code === (process.env.LEGACY_CLASSIFICATION_IMPORT_TARGET ?? "slamdunk"));
  if (target === undefined) throw new Error("Target was not found");

  const results = [];
  for (const candidate of plan.filter((item) => item.status === "accepted")) {
    for (const review of candidate.reviews) {
      if (candidate.dictionaryValue === undefined) throw new Error(`Accepted candidate has no dictionary value: ${candidate.sourceValue}`);
      const result = await classifier.saveDecision({
        sourceId: review.sourceId,
        typeCode: review.typeCode,
        scope: review.scope,
        normalizedSourceValue: review.normalizedSourceValue,
        contextKey: review.contextKey,
        action: "confirm",
        targetLink: {
          targetId: target.id,
          targetScope: candidate.targetScope,
          dictionaryValueId: candidate.dictionaryValue.id,
        },
        reason: `Безопасный перенос legacy classification: ${candidate.group}`,
      }, "legacy-classification-import");
      results.push({
        sourceValue: candidate.sourceValue,
        targetName: candidate.targetName,
        mappingId: result.mappingId,
        referenceValueId: result.referenceValueId,
        affectedProductCount: result.affectedProductCount,
        affectedExportCount: result.affectedExportCount,
      });
    }
  }
  return results;
}

async function main() {
  const apply = process.env.LEGACY_CLASSIFICATION_IMPORT_APPLY === "true";
  if (process.env.LEGACY_CLASSIFICATION_IMPORT_APPLY !== undefined && !["true", "false"].includes(process.env.LEGACY_CLASSIFICATION_IMPORT_APPLY)) {
    throw new Error("LEGACY_CLASSIFICATION_IMPORT_APPLY must be true or false");
  }
  const auditDir = process.env.LEGACY_CLASSIFICATION_IMPORT_AUDIT_DIR?.trim()
    || "state/audits/2026-08-06-legacy-classification-import";
  await mkdir(auditDir, { recursive: true });
  const pool = createPostgresPool();
  try {
    const plan = await buildPlan(pool);
    const accepted = plan.filter((item) => item.status === "accepted");
    const rejected = plan.filter((item) => item.status === "rejected");
    const conflicts = plan.filter((item) => item.status === "conflict");
    const already = plan.filter((item) => item.status === "already_exists");
    const applyResult = apply ? await applyPlan(pool, plan) : [];

    const files = {
      candidates: join(auditDir, "candidates.jsonl"),
      accepted: join(auditDir, "accepted.jsonl"),
      rejected: join(auditDir, "rejected.jsonl"),
      conflicts: join(auditDir, "conflicts.jsonl"),
      applyResult: join(auditDir, "apply-result.json"),
      summary: join(auditDir, "summary.md"),
    };
    await writeJsonl(files.candidates, plan);
    await writeJsonl(files.accepted, accepted);
    await writeJsonl(files.rejected, rejected);
    await writeJsonl(files.conflicts, conflicts);
    await writeFile(files.applyResult, `${JSON.stringify({ apply, results: applyResult }, null, 2)}\n`, "utf8");
    const hashes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, path]) => [name, await sha256(path)] as const)));
    await writeFile(files.summary, [
      "# Legacy Classification Import",
      "",
      `apply: ${apply}`,
      `candidates: ${plan.length}`,
      `accepted: ${accepted.length}`,
      `rejected: ${rejected.length}`,
      `conflicts: ${conflicts.length}`,
      `already_exists: ${already.length}`,
      `applied_decisions: ${applyResult.length}`,
      "",
      "## SHA-256",
      ...Object.entries(hashes).map(([name, hash]) => `- ${name}: ${hash}`),
      "",
    ].join("\n"), "utf8");
    hashes.summary = await sha256(files.summary);
    console.info(JSON.stringify({
      apply,
      auditDir,
      candidates: plan.length,
      accepted: accepted.length,
      rejected: rejected.length,
      conflicts: conflicts.length,
      alreadyExists: already.length,
      appliedDecisions: applyResult.length,
      hashes,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
