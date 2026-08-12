import type { EntityId, TargetContentTemplateDTO } from "../contracts/index.js";
import { EntityNotFoundError } from "../core/errors/index.js";
import {
  contentTemplateCatalog,
  validateWordPressContentTemplateDefinition,
  validateWordPressContentTemplateProfiles,
  type WordPressContentTemplateField,
} from "../integrations/index.js";
import type {
  TargetContentTemplateRecord,
  TargetContentTemplateRepository,
  TargetRepository,
  UnitOfWork,
} from "../repositories/index.js";
import type { WordPressPreviewService } from "./wordpress-preview-service.js";

export interface ContentTemplateDraftCommand {
  readonly targetId: EntityId;
  readonly field: WordPressContentTemplateField;
  readonly name: string;
  readonly templateSource: string;
  readonly profileKey?: string;
  readonly profileName?: string;
  readonly managementMode?: "manage" | "preserve";
  readonly categoryTermIds?: readonly number[];
  readonly requiredContextPaths?: readonly string[];
  readonly preserveExistingStory?: boolean;
}

export interface ContentTemplatePreviewCommand extends ContentTemplateDraftCommand {
  readonly sourceProductId: EntityId;
}

export class ContentTemplateAdminService {
  constructor(
    private readonly templates: TargetContentTemplateRepository,
    private readonly targets: TargetRepository,
    private readonly wordpressPreview: WordPressPreviewService,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  catalog() { return contentTemplateCatalog(); }

  async list(targetId: EntityId, field?: WordPressContentTemplateField): Promise<readonly TargetContentTemplateRecord[]> {
    await this.requireTarget(targetId);
    return this.templates.list(targetId, field);
  }

  async createDraft(command: ContentTemplateDraftCommand, actor: string): Promise<TargetContentTemplateRecord> {
    await this.requireTarget(command.targetId);
    const definition = this.definition(command);
    validateWordPressContentTemplateDefinition(definition);
    return this.unitOfWork.transaction((repositories) => repositories.contentTemplates.createDraft({
      targetId: command.targetId,
      field: command.field,
      name: command.name.trim(),
      templateSource: command.templateSource,
      profileKey: definition.profileKey,
      profileName: definition.profileName,
      managementMode: definition.managementMode,
      categoryTermIds: definition.categoryTermIds,
      requiredContextPaths: definition.requiredContextPaths,
      preserveExistingStory: definition.preserveExistingStory ?? false,
      actor,
    }));
  }

  async activate(targetId: EntityId, templateId: EntityId, actor: string): Promise<TargetContentTemplateRecord> {
    await this.requireTarget(targetId);
    return this.unitOfWork.transaction(async (repositories) => {
      const template = await repositories.contentTemplates.getById(templateId);
      if (template === null || template.targetId !== targetId) throw new EntityNotFoundError("Target content template", templateId);
      await repositories.contentTemplates.lockField(targetId, template.field);
      const active = await repositories.contentTemplates.listActive(targetId);
      validateWordPressContentTemplateProfiles([
        ...active.filter((item) => item.field !== template.field || item.profileKey !== template.profileKey),
        template,
      ]);
      return repositories.contentTemplates.activate(templateId, targetId, actor);
    });
  }

  async preview(command: ContentTemplatePreviewCommand) {
    await this.requireTarget(command.targetId);
    const override: TargetContentTemplateDTO = this.definition(command);
    validateWordPressContentTemplateDefinition(override);
    return this.wordpressPreview.preview(command.sourceProductId, command.targetId, [override]);
  }

  private definition(command: ContentTemplateDraftCommand): TargetContentTemplateDTO {
    return {
      id: "preview",
      field: command.field,
      revision: 0,
      templateSource: command.templateSource,
      profileKey: command.profileKey ?? "default",
      profileName: command.profileName?.trim() || "Основной профиль",
      managementMode: command.managementMode ?? "manage",
      categoryTermIds: [...new Set(command.categoryTermIds ?? [])].sort((left, right) => left - right),
      requiredContextPaths: [...new Set(command.requiredContextPaths ?? [])].sort(),
      preserveExistingStory: command.preserveExistingStory ?? false,
    };
  }

  private async requireTarget(targetId: EntityId): Promise<void> {
    if (await this.targets.getById(targetId) === null) throw new EntityNotFoundError("Target", targetId);
  }
}
