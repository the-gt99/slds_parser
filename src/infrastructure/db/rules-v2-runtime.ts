import type { UniversalProductDTO } from "../../contracts/index.js";
import { IntegrationContractError } from "../../core/errors/index.js";
import type { ClassificationReferenceTypeRecord, ClassificationRepository, ReferenceRepository, RuleV2Record } from "../../repositories/index.js";
import { RulesV2Snapshot } from "../../services/rules-v2-snapshot.js";
import type { SupplementalTargetAssignmentResolver } from "../../services/target-reference-mapping-service.js";
import type { SqlExecutor } from "./sql-executor.js";
import { mapRuleV2 } from "./repositories/postgres-rules-v2-repository.js";
import type { DatabaseRow } from "./repositories/row-mappers.js";

/** One coalesced refresh per process; a snapshot stays immutable for the whole evaluation. */
export class RulesV2Runtime {
  private cached?: RulesV2Snapshot;
  private loading: Promise<RulesV2Snapshot> | undefined;
  private checkedAt = 0;
  constructor(private readonly db: SqlExecutor, private readonly now = Date.now) {}

  static frozen(db: SqlExecutor, snapshot: RulesV2Snapshot): RulesV2Runtime {
    const runtime = new RulesV2Runtime(db, () => 0);
    runtime.cached = snapshot;
    return runtime;
  }

  async snapshot(): Promise<RulesV2Snapshot> {
    if (this.cached !== undefined && this.now() - this.checkedAt < 1000) return this.cached;
    if (this.loading !== undefined) return this.loading;
    this.loading = this.load();
    try { return await this.loading; } finally { this.loading = undefined; }
  }

  private async load(): Promise<RulesV2Snapshot> {
    const stamp = await this.db.query<DatabaseRow>(`SELECT
      COALESCE(SUM(revision), 0)::TEXT || ':' || COUNT(*)::TEXT || ':' || COALESCE(MAX(updated_at)::TEXT, '') AS revision
      FROM rules_v2`);
    const dictionaryStamp = await this.db.query<DatabaseRow>(`SELECT COALESCE(SUM(revision), 0)::TEXT AS revision FROM target_export_revisions`);
    const revision = `${stamp.rows[0]!.revision}:${dictionaryStamp.rows[0]!.revision}`;
    if (this.cached?.revision === revision) { this.checkedAt = this.now(); return this.cached; }
    const result = await this.db.query<DatabaseRow>(`SELECT rule.*, source.code AS source_code, target.code AS target_code
      FROM rules_v2 rule LEFT JOIN sources source ON source.id = rule.source_id
      LEFT JOIN targets target ON target.id = rule.target_id WHERE rule.status = 'shadow' ORDER BY rule.id`);
    if (!result.rows.some((row) => row.origin_kind !== "native")) throw new IntegrationContractError("Rules v2 migration snapshot is missing");
    const records = result.rows.map(mapRuleV2);
    const dictionaryIds = [...new Set(records.flatMap((rule) => rule.actions.flatMap((action) =>
      action.kind === "resolve_reference" || action.dictionaryValueId === null ? [] : [action.dictionaryValueId])))];
    const dictionary = await this.db.query<DatabaseRow>(`SELECT id::TEXT, target_id::TEXT, active, external_id, name, slug
      FROM target_dictionary_values WHERE id = ANY($1::BIGINT[])`, [dictionaryIds]);
    const values = new Map(dictionary.rows.map((row) => [String(row.id), row]));
    const definitions = await this.db.query<DatabaseRow>(`SELECT code, cardinality, allowed_subject_kinds, metadata
      FROM rules_v2_reference_types WHERE enabled = TRUE`);
    const referenceTypes: ClassificationReferenceTypeRecord[] = definitions.rows.map((row) => ({
      code: String(row.code), cardinality: String(row.cardinality) as ClassificationReferenceTypeRecord["cardinality"],
      allowedSubjectKinds: row.allowed_subject_kinds as ClassificationReferenceTypeRecord["allowedSubjectKinds"],
      metadata: row.metadata as ClassificationReferenceTypeRecord["metadata"],
    }));
    const hydrated = records.flatMap((rule): RuleV2Record[] => {
      const reference = rule.actions.find((action) => action.kind === "resolve_reference");
      if (reference !== undefined || rule.originKind === "target_mapping") return [rule];
      let externalSlug: string | null = null;
      const actions = rule.actions.flatMap((action) => {
        if (action.kind === "resolve_reference") return [];
        const value = values.get(action.dictionaryValueId);
        if (value === undefined || !value.active || String(value.target_id) !== rule.targetId) return [];
        externalSlug = value.slug === null ? null : String(value.slug);
        return [{ ...action, externalValue: String(value.external_id), externalLabel: String(value.name) }];
      });
      // Keep actionless assignments: matching them must report an error, just like the old engine.
      return [{ ...rule, actions, originPayload: { ...rule.originPayload, externalSlug } }];
    });
    this.cached = new RulesV2Snapshot(revision, hydrated, referenceTypes);
    this.checkedAt = this.now();
    return this.cached;
  }

  classificationRepository(audit: ClassificationRepository): ClassificationRepository {
    return {
      listReferenceTypes: async (types) => (await this.snapshot()).listReferenceTypes(types),
      saveProductResult: (input) => audit.saveProductResult(input),
      findSourceDecisions: async (sourceId, inputs) => (await this.snapshot()).decisions(sourceId, inputs),
      getActiveRuleSetRevision: async () => (await this.snapshot()).revision,
      listAllActiveRules: async (sourceId) => (await this.snapshot()).rules(sourceId),
      listActiveRules: async (sourceId, types) => (await this.snapshot()).rules(sourceId).filter((rule) => types.includes(rule.typeCode)),
    };
  }

  referenceRepository(): ReferenceRepository {
    return {
      resolveTargetValue: async (targetId, referenceId, scope) => (await this.snapshot()).mapping(targetId, referenceId, scope),
      resolveTargetProjections: async (targetId, resolutions) => (await this.snapshot()).projections(targetId, resolutions),
      getTargetMappingRevision: async () => `v2:${(await this.snapshot()).revision}`,
      // Source-scoped native and migrated assignments compete together in supplemental().
      listTargetAssignmentRules: async () => [],
      saveTargetProjection: async () => { throw new IntegrationContractError("Use Rules v2 to change assignments in v2 mode"); },
    };
  }

  supplemental(previous?: SupplementalTargetAssignmentResolver): SupplementalTargetAssignmentResolver {
    return { createTargetAssignmentResolver: async (targetId) => {
      const supplemental = await previous?.createTargetAssignmentResolver(targetId);
      return async (product: UniversalProductDTO) => {
        const result = await this.db.query<DatabaseRow>(`SELECT source.id::TEXT, source.code, product.id::TEXT AS product_id,
          product.source_key, product.external_id FROM source_products product
          JOIN sources source ON source.id = product.source_id WHERE product.id = $1`, [product.sourceProductId]);
        const row = result.rows[0];
        if (row === undefined) throw new IntegrationContractError(`Source product ${product.sourceProductId} is missing`);
        const native = (await this.snapshot()).nativeAssignments(targetId, product, {
          id: String(row.id), code: String(row.code), productId: String(row.product_id), sourceKey: String(row.source_key),
          externalId: row.external_id === null ? null : String(row.external_id),
        });
        return [...(await supplemental?.(product) ?? []), ...native];
      };
    } };
  }
}
