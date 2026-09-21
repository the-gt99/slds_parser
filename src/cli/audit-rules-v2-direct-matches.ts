import type { UniversalProductDTO } from "../contracts/index.js";
import { createPostgresPool } from "../infrastructure/db/index.js";
import { loadRulesV2AuditBaseline } from "../infrastructure/db/rules-v2-audit-baseline.js";
import { RulesV2Runtime } from "../infrastructure/db/rules-v2-runtime.js";
import { ProductClassifier } from "../services/product-classifier.js";
import { directCandidateConditions, directCandidateField } from "../services/rules-v2-direct-candidate.js";
import { DirectRulesV2Index, matchesDirectRulesV2Conditions } from "../services/rules-v2-direct-fields.js";
import { buildDirectTargetRulePlans } from "../services/rules-v2-direct-plan.js";
import { DirectRulesV2Selector } from "../services/rules-v2-direct-selector.js";

const limit = Number(process.env.RULES_V2_DIRECT_MATCH_LIMIT ?? "100");
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid direct match audit limit");
const pool = createPostgresPool();
const client = await pool.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const baseline = await loadRulesV2AuditBaseline(client);
  const runtime = new RulesV2Runtime(client, () => 0);
  const snapshot = await runtime.snapshot();
  const classifier = new ProductClassifier(runtime.classificationRepository(baseline.classifications));
  const selector = new DirectRulesV2Selector(snapshot.records);
  const plans = buildDirectTargetRulePlans(snapshot.records);
  const plansBySourceRule = new Map<string, typeof plans[number][]>();
  for (const plan of plans) {
    const entries = plansBySourceRule.get(plan.sourceRuleId) ?? [];
    entries.push(plan);
    plansBySourceRule.set(plan.sourceRuleId, entries);
  }
  const targetIds = [...new Set(plans.map((plan) => plan.targetId))];
  const sourceRules = snapshot.records.flatMap((rule) => {
    if (rule.status !== "shadow" || rule.sourceId === null
      || (rule.originKind !== "exact_mapping" && rule.originKind !== "classification_rule")) return [];
    const action = rule.actions.find((item) => item.kind === "resolve_reference");
    if (action?.kind !== "resolve_reference" || action.resolutionStatus !== "confirmed") return [];
    return [{ rule, groups: directCandidateConditions(rule), referenceType: action.referenceType }];
  });
  const bySource = new Map<string, typeof sourceRules>();
  const byOrigin = new Map<string, string>();
  for (const rule of snapshot.records) if (rule.originId !== null
    && (rule.originKind === "exact_mapping" || rule.originKind === "classification_rule")) {
    byOrigin.set(`${rule.originKind}:${rule.originId}`, rule.id);
  }
  for (const entry of sourceRules) {
    const lookup = JSON.stringify([entry.rule.sourceId, entry.referenceType]);
    const entries = bySource.get(lookup) ?? [];
    entries.push(entry);
    bySource.set(lookup, entries);
  }
  const indexes = new Map([...bySource].map(([sourceId, entries]) => [sourceId, new DirectRulesV2Index(entries)]));
  const rows = (await client.query<{ id: string; source_id: string; code: string; source_key: string;
    external_id: string | null; data: UniversalProductDTO }>(`SELECT product.id::TEXT, product.source_id::TEXT,
      source.code, product.source_key, product.external_id, internal.data FROM source_products product
      JOIN sources source ON source.id = product.source_id JOIN internal_products internal ON internal.source_product_id = product.id
      WHERE internal.data ? 'referenceCandidates' ORDER BY product.id LIMIT $1`, [limit])).rows;
  let missedWinners = 0;
  let extraMatches = 0;
  let productsWithExtras = 0;
  let selectionMismatches = 0;
  let termMismatches = 0;
  const examples: unknown[] = [];
  for (const row of rows) {
    const classified = await classifier.classify(row.source_id, row.data);
    const expected = new Map<string, { status: string; sourceRuleId: string | null }>();
    for (const item of classified.product.classification.resolved) expected.set(item.candidateKey, {
      status: "resolved", sourceRuleId: byOrigin.get(`${item.resolutionKind === "mapping" ? "exact_mapping" : "classification_rule"}:${item.resolutionId}`) ?? null,
    });
    for (const item of classified.product.classification.ignored) expected.set(item.candidateKey, {
      status: "ignored", sourceRuleId: byOrigin.get(`exact_mapping:${item.mappingId}`) ?? null,
    });
    for (const item of classified.product.classification.unresolved) expected.set(item.candidateKey, {
      status: item.reason === "rule_ambiguous" ? "ambiguous" : "unresolved", sourceRuleId: null,
    });
    const selected = selector.select({ id: row.source_id, code: row.code, productId: row.id,
      sourceKey: row.source_key, externalId: row.external_id }, row.data);
    const different = selected.filter((item) => JSON.stringify({ status: item.status, sourceRuleId: item.sourceRuleId })
      !== JSON.stringify(expected.get(item.candidateKey)));
    selectionMismatches += different.length;
    const termDifferences: unknown[] = [];
    const resolutions = classified.product.classification.resolved.map((item) => ({
      resolutionKind: item.resolutionKind, resolutionId: item.resolutionId, referenceId: item.referenceValueId,
    }));
    for (const targetId of targetIds) {
      const direct = selected.flatMap((item) => item.status === "resolved" && item.sourceRuleId !== null
        ? (plansBySourceRule.get(item.sourceRuleId) ?? []).filter((plan) => plan.targetId === targetId).flatMap((plan) => plan.actions)
        : []);
      const projectionKey = (kind: string, id: string, scope: string, dictionaryId: string, value: string) =>
        `${kind}:${id}:${scope}:${dictionaryId}:${value}`;
      const directProjections = [...new Set(direct.filter((action) => action.originKind !== "target_mapping")
        .map((action) => projectionKey(action.originKind, action.originId, action.targetScope,
          action.dictionaryValueId, action.externalValue)))].sort();
      const currentProjections = [...new Set(snapshot.projections(targetId, resolutions).map((projection) =>
        projectionKey("referenceValueId" in projection ? "reference_projection" : "classification_projection",
          projection.id, projection.targetScope, projection.dictionaryValueId, projection.externalValue)))].sort();
      if (JSON.stringify(directProjections) !== JSON.stringify(currentProjections)) termDifferences.push({ targetId,
        section: "projections", direct: directProjections.slice(0, 15), current: currentProjections.slice(0, 15) });
      for (const reference of classified.product.classification.resolved) {
        const sourceRuleId = byOrigin.get(`${reference.resolutionKind === "mapping" ? "exact_mapping" : "classification_rule"}:${reference.resolutionId}`);
        for (const plan of sourceRuleId === undefined ? [] : plansBySourceRule.get(sourceRuleId) ?? []) {
          if (plan.targetId !== targetId) continue;
          for (const action of plan.actions.filter((item) => item.originKind === "target_mapping")) {
            const current = snapshot.mapping(targetId, reference.referenceValueId, action.targetScope);
            if (current?.externalValue !== action.externalValue || current.externalLabel !== action.externalLabel) {
              termDifferences.push({ targetId, section: "mapping", sourceRuleId, action, current });
            }
          }
        }
      }
    }
    termMismatches += termDifferences.length;
    const winners = new Set(classified.product.classification.resolved.map((item) => byOrigin.get(
      `${item.resolutionKind === "mapping" ? "exact_mapping" : "classification_rule"}:${item.resolutionId}`)).filter(
      (value): value is string => value !== undefined));
    const matching = new Set<string>();
    for (const candidate of row.data.referenceCandidates) {
      const read = (field: string) => directCandidateField(candidate, field);
      for (const { rule, groups } of indexes.get(JSON.stringify([row.source_id, candidate.typeCode]))?.select(read) ?? []) {
        if (matchesDirectRulesV2Conditions(row.data, groups, read)) matching.add(rule.id);
      }
    }
    const missed = [...winners].filter((id) => !matching.has(id));
    const extra = [...matching].filter((id) => !winners.has(id));
    missedWinners += missed.length;
    extraMatches += extra.length;
    if (extra.length > 0) productsWithExtras++;
    if ((missed.length > 0 || extra.length > 0 || different.length > 0 || termDifferences.length > 0)
      && examples.length < 20) examples.push({ productId: row.id,
      winnerCount: winners.size, matchedCount: matching.size, missed, extra: extra.slice(0, 20),
      different: different.slice(0, 10).map((item) => ({ actual: item, expected: expected.get(item.candidateKey) })),
      termDifferences: termDifferences.slice(0, 10) });
  }
  await client.query("COMMIT");
  console.info(JSON.stringify({ writes: false, revision: snapshot.revision, sourceRules: sourceRules.length,
    products: rows.length, missedWinners, extraMatches, productsWithExtras, selectionMismatches, termMismatches, examples }, null, 2));
  if (missedWinners > 0 || selectionMismatches > 0 || termMismatches > 0) process.exitCode = 1;
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
