import type { SourceDTO, SourceProductDTO, TargetDTO } from "../contracts/index.js";
import { EntityNotFoundError } from "../core/errors/index.js";
import type { TargetExporterRegistry } from "../core/registry/index.js";
import { hashStableJson } from "../core/utils/index.js";
import type { InternalProductRepository, SourceProductRepository, SourceRepository, TargetContentTemplateRepository, TargetRepository } from "../repositories/index.js";
import type { TargetReferenceMappingService } from "../services/index.js";
import type { ExportProductPayload } from "./job-payloads.js";
import type { RunnerResult } from "./runner-result.js";

export interface ExportRunnerRepositories {
  readonly sources: SourceRepository;
  readonly sourceProducts: SourceProductRepository;
  readonly internalProducts: InternalProductRepository;
  readonly targets: TargetRepository;
  readonly contentTemplates: TargetContentTemplateRepository;
}

export class ExportRunner {
  constructor(
    private readonly repositories: ExportRunnerRepositories,
    private readonly exporters: TargetExporterRegistry,
    private readonly mappings: TargetReferenceMappingService,
  ) {}

  async exportProduct(payload: ExportProductPayload): Promise<RunnerResult> {
    const internal = await this.repositories.internalProducts.getById(payload.internalProductId);
    if (internal === null) throw new EntityNotFoundError("Internal product", payload.internalProductId);
    const sourceProduct = await this.repositories.sourceProducts.getById(internal.sourceProductId);
    if (sourceProduct === null) throw new EntityNotFoundError("Source product", internal.sourceProductId);
    const source = await this.repositories.sources.getById(sourceProduct.sourceId);
    if (source === null) throw new EntityNotFoundError("Source", sourceProduct.sourceId);
    const target = await this.repositories.targets.getById(payload.targetId);
    if (target === null) throw new EntityNotFoundError("Target", payload.targetId);
    const exporter = this.exporters.get(target.exporterCode);
    const existing = await this.repositories.targets.findTargetProduct(target.id, internal.id);
    const contentTemplates = [...await this.repositories.contentTemplates.listActive(target.id)]
      .sort((left, right) => left.field.localeCompare(right.field));
    const mappingRevision = await this.mappings.getTargetMappingRevision(target.id);
    const fingerprint = hashStableJson({ contentHash: internal.contentHash, exporterVersion: exporter.version, targetConfig: target.config, mappingRevision,
      contentTemplates: contentTemplates.map((template) => ({ id: template.id, field: template.field, revision: template.revision, templateSource: template.templateSource })) });
    if (!payload.force && payload.approval === undefined && existing?.lastExportFingerprint === fingerprint) return { status: "skipped" };
    const attemptedAt = new Date().toISOString();
    const sourceDto: SourceDTO = { id: source.id, code: source.code, config: source.config };
    const sourceProductDto: SourceProductDTO = {
      id: sourceProduct.id,
      sourceId: sourceProduct.sourceId,
      sourceKey: sourceProduct.sourceKey,
      ...(sourceProduct.externalId === null ? {} : { externalId: sourceProduct.externalId }),
      ...(sourceProduct.slug === null ? {} : { slug: sourceProduct.slug }),
      ...(sourceProduct.url === null ? {} : { url: sourceProduct.url }),
      metadata: sourceProduct.discoveryMetadata,
    };
    const targetDto: TargetDTO = { id: target.id, code: target.code, config: target.config };
    try {
      const result = await exporter.export({ source: sourceDto, sourceProduct: sourceProductDto, target: targetDto, product: internal.data,
        references: {
          resolveReference: (input) => this.mappings.resolveTargetValue(target.id, input.referenceId, input.targetScope),
          resolveProjections: (inputs) => this.mappings.resolveTargetProjections(target.id, inputs),
          resolveAssignments: (product) => this.mappings.resolveTargetAssignments(target.id, product),
        },
        contentTemplates: contentTemplates.map((template) => ({ id: template.id, field: template.field, revision: template.revision, templateSource: template.templateSource })),
        ...(payload.approval === undefined ? {} : { approval: {
          payloadHash: payload.approval.payloadHash,
          willCreate: payload.approval.willCreate,
          externalId: payload.approval.externalId,
          matchedBy: payload.approval.matchedBy,
        } }),
        ...(existing?.externalId === null || existing?.externalId === undefined ? {} : { existingExternalId: existing.externalId }) });
      await this.repositories.targets.saveExportSuccess({ targetId: target.id, internalProductId: internal.id, externalId: result.externalId,
        status: "synced", exportedHash: internal.contentHash, exportFingerprint: fingerprint, attemptedAt, syncedAt: new Date().toISOString() });
      return { status: "completed" };
    } catch (error) {
      try {
        await this.repositories.targets.saveExportFailure({ targetId: target.id, internalProductId: internal.id, status: "failed",
          error: error instanceof Error ? error.message : String(error), attemptedAt });
      } catch (saveError) {
        if (error instanceof Error && error.cause === undefined) {
          Object.defineProperty(error, "cause", { value: saveError, configurable: true });
        }
      }
      throw error;
    }
  }
}
