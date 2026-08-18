import type { EntityId } from "../../../contracts/index.js";
import type {
  CreateTargetContentTemplateDraftInput,
  TargetContentTemplateField,
  TargetContentTemplateRecord,
  TargetContentTemplateRepository,
} from "../../../repositories/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import { requireRow } from "./repository-utils.js";
import type { DatabaseRow } from "./row-mappers.js";

function mapTemplate(row: DatabaseRow): TargetContentTemplateRecord {
  return {
    id: String(row.id),
    targetId: String(row.target_id),
    field: String(row.field_code) as TargetContentTemplateField,
    name: String(row.name),
    templateSource: String(row.template_source),
    profileKey: String(row.profile_key),
    profileName: String(row.profile_name),
    managementMode: String(row.management_mode) as TargetContentTemplateRecord["managementMode"],
    categoryTermIds: Array.isArray(row.category_term_ids) ? row.category_term_ids.map(Number) : [],
    requiredContextPaths: Array.isArray(row.required_context_paths) ? row.required_context_paths.map(String) : [],
    status: String(row.status) as TargetContentTemplateRecord["status"],
    revision: Number(row.revision),
    actor: String(row.actor),
    createdAt: new Date(String(row.created_at)).toISOString(),
    activatedAt: row.activated_at === null ? null : new Date(String(row.activated_at)).toISOString(),
  };
}

export class PostgresTargetContentTemplateRepository implements TargetContentTemplateRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async list(targetId: EntityId, field?: TargetContentTemplateField): Promise<readonly TargetContentTemplateRecord[]> {
    const result = await this.executor.query<DatabaseRow>(
      `SELECT * FROM target_content_templates
       WHERE target_id = $1 AND ($2::TEXT IS NULL OR field_code = $2)
       ORDER BY field_code, revision DESC`,
      [targetId, field ?? null],
    );
    return result.rows.map(mapTemplate);
  }

  async listActive(targetId: EntityId): Promise<readonly TargetContentTemplateRecord[]> {
    const result = await this.executor.query<DatabaseRow>(
      "SELECT * FROM target_content_templates WHERE target_id = $1 AND status = 'active' ORDER BY field_code",
      [targetId],
    );
    return result.rows.map(mapTemplate);
  }

  async getById(id: EntityId): Promise<TargetContentTemplateRecord | null> {
    const result = await this.executor.query<DatabaseRow>("SELECT * FROM target_content_templates WHERE id = $1", [id]);
    return result.rows[0] === undefined ? null : mapTemplate(result.rows[0]);
  }

  async lockField(targetId: EntityId, field: TargetContentTemplateField): Promise<void> {
    await this.executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1::TEXT || ':' || $2::TEXT, 0))", [targetId, field]);
  }

  async createDraft(input: CreateTargetContentTemplateDraftInput): Promise<TargetContentTemplateRecord> {
    await this.lockField(input.targetId, input.field);
    const result = await this.executor.query<DatabaseRow>(
      `INSERT INTO target_content_templates (
         target_id, field_code, name, template_source, profile_key, profile_name,
         management_mode, category_term_ids, required_context_paths, status, revision, actor
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::BIGINT[], $9::TEXT[], 'draft',
         COALESCE((SELECT MAX(revision) + 1 FROM target_content_templates WHERE target_id = $1 AND field_code = $2), 1),
         $10
       )
       RETURNING *`,
      [input.targetId, input.field, input.name, input.templateSource, input.profileKey, input.profileName,
        input.managementMode, input.categoryTermIds, input.requiredContextPaths, input.actor],
    );
    return mapTemplate(requireRow(result.rows, "target content template draft", `${input.targetId}/${input.field}`));
  }

  async activate(id: EntityId, targetId: EntityId, actor: string): Promise<TargetContentTemplateRecord> {
    const selected = await this.executor.query<DatabaseRow>(
      `SELECT * FROM target_content_templates
       WHERE id = $1 AND target_id = $2 AND status IN ('draft', 'archived')
       FOR UPDATE`,
      [id, targetId],
    );
    const row = requireRow(selected.rows, "target content template activation", id);
    await this.executor.query(
      `UPDATE target_content_templates
       SET status = 'archived'
       WHERE target_id = $1 AND field_code = $2 AND profile_key = $3 AND status = 'active'`,
      [targetId, String(row.field_code), String(row.profile_key)],
    );
    const result = await this.executor.query<DatabaseRow>(
      `UPDATE target_content_templates
       SET status = 'active', actor = $3, activated_at = NOW()
       WHERE id = $1 AND target_id = $2
       RETURNING *`,
      [id, targetId, actor],
    );
    return mapTemplate(requireRow(result.rows, "target content template activation", id));
  }
}
