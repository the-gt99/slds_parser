import type { ClassificationRepository, ReferenceRepository } from "../../repositories/index.js";
import type { SqlExecutor } from "./sql-executor.js";
import { PostgresClassificationRepository } from "./repositories/postgres-classification-repository.js";
import { PostgresReferenceRepository } from "./repositories/postgres-reference-repository.js";
import { mapTargetValueMapping, mapTargetClassificationProjection, mapTargetReferenceProjection, type DatabaseRow } from "./repositories/row-mappers.js";

/** Freeze legacy data independently from rules_v2 for a bounded read-only audit transaction. */
export async function loadRulesV2AuditBaseline(db: SqlExecutor) {
  const legacy = new PostgresClassificationRepository(db);
  const references = new PostgresReferenceRepository(db);
  const sourceIds = (await db.query<{ id: string }>("SELECT id::TEXT FROM sources")).rows.map((row) => row.id);
  const targetIds = (await db.query<{ id: string }>("SELECT id::TEXT FROM targets")).rows.map((row) => row.id);
  const types = await legacy.listReferenceTypes((await db.query<{ code: string }>("SELECT code FROM reference_types")).rows.map((row) => row.code));
  const rules = new Map(await Promise.all(sourceIds.map(async (id) => [id, await legacy.listAllActiveRules(id)] as const)));
  const decisions = (await db.query<DatabaseRow>(`SELECT mapping.*, type.code AS type_code
    FROM source_reference_mappings mapping JOIN reference_types type ON type.id = mapping.reference_type_id
    LEFT JOIN reference_values value ON value.id = mapping.reference_value_id AND value.type_id = type.id
    WHERE mapping.status IN ('confirmed', 'ignored') AND (mapping.status = 'ignored' OR value.enabled = TRUE)`)).rows;
  const decisionKey = (...parts: unknown[]) => JSON.stringify(parts);
  const decisionIndex = new Map(decisions.map((row) => [decisionKey(String(row.source_id), row.type_code, row.scope, row.normalized_source_value, row.context_key), row]));
  const classifications: ClassificationRepository = {
    listReferenceTypes: async (codes) => types.filter((type) => codes.includes(type.code)),
    getActiveRuleSetRevision: async () => "audit-frozen-v1",
    listAllActiveRules: async (sourceId) => rules.get(sourceId) ?? [],
    listActiveRules: async (sourceId, codes) => (rules.get(sourceId) ?? []).filter((rule) => codes.includes(rule.typeCode)),
    findSourceDecisions: async (sourceId, inputs) => inputs.flatMap((input) => {
      const row = decisionIndex.get(decisionKey(sourceId, input.typeCode, input.scope, input.normalizedSourceValue, input.contextKey));
      return row === undefined ? [] : [{ candidateKey: input.candidateKey, mappingId: String(row.id),
        referenceValueId: row.reference_value_id === null ? null : String(row.reference_value_id),
        status: row.status as "confirmed" | "ignored", revision: String(row.revision) }];
    }),
    saveProductResult: async () => { throw new Error("Audit is read-only"); },
  };
  const mappings = (await db.query<DatabaseRow>("SELECT * FROM target_value_mappings WHERE active = TRUE")).rows.map(mapTargetValueMapping);
  const mappingIndex = new Map(mappings.map((item) => [decisionKey(item.targetId, item.referenceValueId, item.targetScope), item]));
  const specific = (await db.query<DatabaseRow>(`SELECT projection.*, dictionary.external_id AS external_value,
    dictionary.name AS external_label, dictionary.slug AS external_slug FROM target_classification_projections projection
    JOIN target_dictionary_values dictionary ON dictionary.id = projection.dictionary_value_id
      AND dictionary.target_id = projection.target_id AND dictionary.active = TRUE
    WHERE projection.active = TRUE ORDER BY projection.id`)).rows.map(mapTargetClassificationProjection);
  const canonical = (await db.query<DatabaseRow>(`SELECT projection.*, dictionary.external_id AS external_value,
    dictionary.name AS external_label, dictionary.slug AS external_slug FROM target_reference_projections projection
    JOIN target_dictionary_values dictionary ON dictionary.id = projection.dictionary_value_id
      AND dictionary.target_id = projection.target_id AND dictionary.active = TRUE
    WHERE projection.active = TRUE ORDER BY projection.id`)).rows.map(mapTargetReferenceProjection);
  const specificIndex = new Map<string, typeof specific>();
  for (const item of specific) { const key = decisionKey(item.targetId, item.resolutionKind, item.resolutionId); const list = specificIndex.get(key) ?? []; list.push(item); specificIndex.set(key, list); }
  const canonicalIndex = new Map<string, typeof canonical>();
  for (const item of canonical) { const key = decisionKey(item.targetId, item.referenceValueId); const list = canonicalIndex.get(key) ?? []; list.push(item); canonicalIndex.set(key, list); }
  const assignments = new Map(await Promise.all(targetIds.map(async (id) => [id, await references.listTargetAssignmentRules(id)] as const)));
  const order = (a: { id: string }, b: { id: string }) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
  const targets: ReferenceRepository = {
    resolveTargetValue: async (target, reference, scope) => mappingIndex.get(decisionKey(target, reference, scope)) ?? null,
    resolveTargetProjections: async (target, resolutions) => {
      const selectedSpecific = new Map<string, typeof specific[number]>();
      const selectedCanonical = new Map<string, typeof canonical[number]>();
      for (const resolution of resolutions) {
        for (const item of specificIndex.get(decisionKey(target, resolution.resolutionKind, resolution.resolutionId)) ?? []) selectedSpecific.set(item.id, item);
        for (const item of canonicalIndex.get(decisionKey(target, resolution.referenceId)) ?? []) selectedCanonical.set(item.id, item);
      }
      return [...[...selectedSpecific.values()].sort(order), ...[...selectedCanonical.values()].sort(order)];
    },
    listTargetAssignmentRules: async (id) => assignments.get(id) ?? [],
    getTargetMappingRevision: async () => "audit-frozen-v1",
    saveTargetProjection: async () => { throw new Error("Audit is read-only"); },
  };
  return { classifications, targets };
}
