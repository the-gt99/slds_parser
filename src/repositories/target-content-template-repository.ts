import type { EntityId } from "../contracts/index.js";
import type {
  CreateTargetContentTemplateDraftInput,
  TargetContentTemplateField,
  TargetContentTemplateRecord,
} from "./types.js";

export interface TargetContentTemplateRepository {
  list(targetId: EntityId, field?: TargetContentTemplateField): Promise<readonly TargetContentTemplateRecord[]>;
  listActive(targetId: EntityId): Promise<readonly TargetContentTemplateRecord[]>;
  getById(id: EntityId): Promise<TargetContentTemplateRecord | null>;
  lockField(targetId: EntityId, field: TargetContentTemplateField): Promise<void>;
  createDraft(input: CreateTargetContentTemplateDraftInput): Promise<TargetContentTemplateRecord>;
  activate(id: EntityId, targetId: EntityId, actor: string): Promise<TargetContentTemplateRecord>;
}
