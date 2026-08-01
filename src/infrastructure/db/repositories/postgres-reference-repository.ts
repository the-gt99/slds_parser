import type { EntityId } from "../../../contracts/index.js";
import type { ReferenceRepository, TargetValueMappingRecord } from "../../../repositories/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import { mapTargetValueMapping, type DatabaseRow } from "./row-mappers.js";

export class PostgresReferenceRepository implements ReferenceRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async resolveTargetValue(targetId: EntityId, referenceValueId: EntityId, targetScope: string): Promise<TargetValueMappingRecord | null> {
    const result = await this.executor.query<DatabaseRow>(
      "SELECT * FROM target_value_mappings WHERE target_id = $1 AND reference_value_id = $2 AND target_scope = $3 AND active = TRUE",
      [targetId, referenceValueId, targetScope],
    );
    return result.rows[0] ? mapTargetValueMapping(result.rows[0]) : null;
  }

  async getTargetMappingRevision(targetId: EntityId): Promise<string> {
    const result = await this.executor.query<DatabaseRow>(`SELECT md5(COALESCE(string_agg(concat_ws(E'\\x1f', id::text, reference_value_id::text, target_scope, external_value, external_label, metadata::text, revision::text, updated_at::text), E'\\x1e' ORDER BY id), '')) AS revision FROM target_value_mappings WHERE target_id = $1 AND active = TRUE`, [targetId]);
    return String(result.rows[0]?.revision ?? "");
  }
}
