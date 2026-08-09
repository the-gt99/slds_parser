import type { EntityId, TargetContentTemplateDTO } from "../contracts/index.js";
import { EntityNotFoundError } from "../core/errors/index.js";
import {
  contentTemplateCatalog,
  validateWordPressContentTemplate,
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
    validateWordPressContentTemplate(command.templateSource);
    return this.unitOfWork.transaction((repositories) => repositories.contentTemplates.createDraft({
      ...command,
      name: command.name.trim(),
      actor,
    }));
  }

  async activate(targetId: EntityId, templateId: EntityId, actor: string): Promise<TargetContentTemplateRecord> {
    await this.requireTarget(targetId);
    return this.unitOfWork.transaction(async (repositories) => {
      const template = await repositories.contentTemplates.getById(templateId);
      if (template === null || template.targetId !== targetId) throw new EntityNotFoundError("Target content template", templateId);
      validateWordPressContentTemplate(template.templateSource);
      return repositories.contentTemplates.activate(templateId, targetId, actor);
    });
  }

  async preview(command: ContentTemplatePreviewCommand) {
    await this.requireTarget(command.targetId);
    validateWordPressContentTemplate(command.templateSource);
    const override: TargetContentTemplateDTO = {
      id: "preview",
      field: command.field,
      revision: 0,
      templateSource: command.templateSource,
    };
    return this.wordpressPreview.preview(command.sourceProductId, command.targetId, [override]);
  }

  private async requireTarget(targetId: EntityId): Promise<void> {
    if (await this.targets.getById(targetId) === null) throw new EntityNotFoundError("Target", targetId);
  }
}
