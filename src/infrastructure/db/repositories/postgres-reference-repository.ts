import type { EntityId } from "../../../contracts/index.js";
import type { ReferenceRepository, ReferenceValueRecord, ResolveSourceValueInput, TargetValueMappingRecord } from "../../../repositories/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import { mapReferenceValue, mapTargetValueMapping, type DatabaseRow } from "./row-mappers.js";

export class PostgresReferenceRepository implements ReferenceRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async resolveSourceValue(input: ResolveSourceValueInput): Promise<ReferenceValueRecord | null> {
    const result = await this.executor.query<DatabaseRow>(`SELECT rv.* FROM source_value_mappings svm JOIN reference_types rt ON rt.id = svm.reference_type_id JOIN reference_values rv ON rv.id = svm.reference_value_id WHERE rt.code = $1 AND svm.source_id = $2 AND svm.scope = $3 AND svm.normalized_source_value = $4 AND svm.status = $5 AND rv.enabled = TRUE`, [input.typeCode, input.sourceId, input.scope, input.normalizedSourceValue, input.status]);
    return result.rows[0] ? mapReferenceValue(result.rows[0]) : null;
  }

  async resolveTargetValue(targetId: EntityId, referenceValueId: EntityId, targetScope: string): Promise<TargetValueMappingRecord | null> {
    const result = await this.executor.query<DatabaseRow>("SELECT * FROM target_value_mappings WHERE target_id = $1 AND reference_value_id = $2 AND target_scope = $3", [targetId, referenceValueId, targetScope]);
    return result.rows[0] ? mapTargetValueMapping(result.rows[0]) : null;
  }

  async getTargetMappingRevision(targetId: EntityId): Promise<string> {
    const result = await this.executor.query<DatabaseRow>(`SELECT md5(COALESCE(string_agg(concat_ws(E'\\x1f', id::text, reference_value_id::text, target_scope, external_value, external_label, metadata::text, updated_at::text), E'\\x1e' ORDER BY id), '')) AS revision FROM target_value_mappings WHERE target_id = $1`, [targetId]);
    return String(result.rows[0]?.revision ?? "");
  }
}
