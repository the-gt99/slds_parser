import type { ExportContext, JsonValue } from "../contracts/index.js";
import { loadWordPressTargetConfig } from "../config/index.js";
import { createPostgresPool, createPostgresRepositories, PostgresTargetDictionaryRepository } from "../infrastructure/db/index.js";
import { loadRulesV2AuditBaseline } from "../infrastructure/db/rules-v2-audit-baseline.js";
import { RulesV2Runtime } from "../infrastructure/db/rules-v2-runtime.js";
import { ProductClassifier } from "../services/product-classifier.js";
import { DirectRulesV2Assignments } from "../services/rules-v2-direct-assignments.js";
import { TargetReferenceMappingService } from "../services/target-reference-mapping-service.js";
import { WordPressExporter, WordPressTitleBrandAssignmentResolver } from "../integrations/index.js";
import { stableJsonStringify } from "../core/utils/index.js";

const ids = (process.env.RULES_V2_PAYLOAD_IDS ?? "").split(",").filter(Boolean);
if (ids.length === 0 || ids.length > 20 || ids.some((id) => !/^\d+$/u.test(id))) throw new Error("Provide 1 to 20 explicit RULES_V2_PAYLOAD_IDS");
const config = loadWordPressTargetConfig();
if (config === null) throw new Error("WordPress configuration is required");
const pool = createPostgresPool();
const client = await pool.connect();
let transactionOpen = false;
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  transactionOpen = true;
  const repositories = createPostgresRepositories(client);
  const baseline = await loadRulesV2AuditBaseline(client);
  const runtime = new RulesV2Runtime(client, () => 0);
  const snapshot = await runtime.snapshot();
  const classifiers = [new ProductClassifier(baseline.classifications), new ProductClassifier(runtime.classificationRepository(baseline.classifications))];
  const supplemental = new WordPressTitleBrandAssignmentResolver(new PostgresTargetDictionaryRepository({
    connect: async () => ({ query: (sql, values) => client.query(sql, values), release() {} }), async end() {},
  }));
  const mappings = [new TargetReferenceMappingService(baseline.targets, supplemental), new TargetReferenceMappingService(runtime.referenceRepository(), runtime.supplemental(supplemental))];
  const targetId = (await client.query<{ id: string }>("SELECT id::TEXT FROM targets WHERE code = 'slamdunk'")).rows[0]?.id;
  if (targetId === undefined) throw new Error("Target is missing");
  const target = await repositories.targets.getById(targetId);
  if (target === null) throw new Error("Target is missing");
  const direct = new DirectRulesV2Assignments(snapshot.records, targetId);
  const titleBrandAssignments = await supplemental.createTargetAssignmentResolver(targetId);
  const contentTemplates = await repositories.contentTemplates.listActive(targetId);
  const exporter = new WordPressExporter(config);
  await client.query("COMMIT");
  transactionOpen = false;
  let payloads = 0;
  let preflightPassed = 0;
  let preflightBlocked = 0;
  let mismatches = 0;
  let directMismatches = 0;
  const results: unknown[] = [];
  for (const id of ids) {
    const sourceProduct = await repositories.sourceProducts.getById(id);
    if (sourceProduct === null) throw new Error(`Source product ${id} is missing`);
    const source = await repositories.sources.getById(sourceProduct.sourceId);
    if (source === null) throw new Error(`Source of ${id} is missing`);
    const internal = await repositories.internalProducts.findBySourceProductId(id);
    if (internal === null) throw new Error(`Product ${id} has no DTO`);
    const saved = await repositories.targets.findProductSnapshot(targetId, id);
    const targetProduct = await repositories.targets.findTargetProduct(targetId, internal.id);
    const existingExternalId = targetProduct?.externalId ?? saved?.externalId;
    const outcomes: { payload?: JsonValue; error?: string }[] = [];
    const { classification: _savedClassification, ...unclassified } = internal.data;
    const directSource = { id: source.id, code: source.code, productId: id,
      sourceKey: sourceProduct.sourceKey, externalId: sourceProduct.externalId };
    for (let index = 0; index < 3; index++) {
      const classified = (await classifiers[index === 0 ? 0 : 1]!.classify(source.id, internal.data)).product;
      const product = index === 0 ? classified : index === 1 ? { ...classified, classification: { ...classified.classification,
        execution: { mode: "v2" as const, revision: snapshot.revision } } }
        : unclassified;
      const mapping = mappings[index === 0 ? 0 : 1]!;
      const context: ExportContext = {
        source: { id: source.id, code: source.code, config: source.config },
        sourceProduct: { id, sourceId: source.id, sourceKey: sourceProduct.sourceKey,
          ...(sourceProduct.externalId === null ? {} : { externalId: sourceProduct.externalId }),
          ...(sourceProduct.slug === null ? {} : { slug: sourceProduct.slug }),
          ...(sourceProduct.url === null ? {} : { url: sourceProduct.url }), metadata: sourceProduct.discoveryMetadata },
        target: { id: target.id, code: target.code, config: target.config }, product, contentTemplates,
        ...(existingExternalId === undefined ? {} : { existingExternalId }),
        ...(saved === null ? {} : { existingTargetSnapshot: saved.payload }),
        references: { resolveReference: (input) => mapping.resolveTargetMapping(targetId, input.referenceId, input.targetScope),
          resolveProjections: (inputs) => mapping.resolveTargetProjections(targetId, inputs),
          resolveAssignments: index !== 2 ? (dto) => mapping.resolveTargetAssignments(targetId, dto)
            : async (dto) => [...new Map([...(await titleBrandAssignments(dto)), ...direct.resolve(dto, directSource)]
              .map((assignment) => [`${assignment.targetScope}\u0000${assignment.externalValue}\u0000${assignment.mode}`, assignment])).values()],
          ...(index !== 2 ? {} : { resolveDirect: async (dto) => direct.resolveTerms(dto, directSource) }) },
      };
      try { outcomes.push({ payload: await exporter.buildPayload(context) }); }
      catch (error) { outcomes.push({ error: error instanceof Error ? error.message : String(error) }); }
    }
    const equal = stableJsonStringify(outcomes[0] as JsonValue) === stableJsonStringify(outcomes[1] as JsonValue);
    if (!equal) mismatches++;
    const directEqual = stableJsonStringify(outcomes[1] as JsonValue) === stableJsonStringify(outcomes[2] as JsonValue);
    if (!directEqual) directMismatches++;
    const payload = outcomes[2]!.payload;
    if (equal && directEqual && payload !== undefined) {
      payloads++;
      // upsert-lookup is the existing read-only WordPress preflight, never export/upsert.
      try {
        const preflight = await exporter.preflightPayload(payload as Parameters<WordPressExporter["preflightPayload"]>[0]);
        preflightPassed++;
        results.push({ id, equal, directEqual, payloadHash: (payload as { payload_hash?: string }).payload_hash,
          preflight: { willCreate: preflight.willCreate, externalId: preflight.externalId, matchedBy: preflight.matchedBy } });
      } catch (error) {
        preflightBlocked++;
        results.push({ id, equal, directEqual, preflightError: error instanceof Error ? error.message : String(error) });
      }
    } else results.push({ id, equal, directEqual, outcomes });
  }
  const ruleStamp = (await client.query<{ revision: string }>(`SELECT
    COALESCE(SUM(revision), 0)::TEXT || ':' || COUNT(*)::TEXT || ':' || COALESCE(MAX(updated_at)::TEXT, '') AS revision
    FROM rules_v2`)).rows[0]!.revision;
  const dictionaryStamp = (await client.query<{ revision: string }>(
    "SELECT COALESCE(SUM(revision), 0)::TEXT AS revision FROM target_export_revisions")).rows[0]!.revision;
  const revisionChanged = `${ruleStamp}:${dictionaryStamp}` !== snapshot.revision;
  console.info(JSON.stringify({ revision: snapshot.revision, revisionChanged, checked: ids.length, payloads, mismatches, directMismatches,
    preflightPassed, preflightBlocked, writes: false, results }, null, 2));
  if (mismatches > 0 || directMismatches > 0 || payloads === 0 || preflightBlocked > 0 || revisionChanged) process.exitCode = 1;
} catch (error) { if (transactionOpen) await client.query("ROLLBACK"); throw error; }
finally { client.release(); await pool.end(); }
