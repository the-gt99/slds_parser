import type { TargetDTO } from "../contracts/index.js";
import { EntityNotFoundError } from "../core/errors/index.js";
import type { TargetExporterRegistry } from "../core/registry/index.js";
import { hashStableJson } from "../core/utils/index.js";
import type { InternalProductRepository, TargetRepository } from "../repositories/index.js";
import type { ReferenceMappingService } from "../services/index.js";
import type { ExportProductPayload } from "./job-payloads.js";
import type { RunnerResult } from "./runner-result.js";

export interface ExportRunnerRepositories {
  readonly internalProducts: InternalProductRepository;
  readonly targets: TargetRepository;
}

export class ExportRunner {
  constructor(
    private readonly repositories: ExportRunnerRepositories,
    private readonly exporters: TargetExporterRegistry,
    private readonly mappings: ReferenceMappingService,
  ) {}

  async exportProduct(payload: ExportProductPayload): Promise<RunnerResult> {
    const internal = await this.repositories.internalProducts.getById(payload.internalProductId);
    if (internal === null) throw new EntityNotFoundError("Internal product", payload.internalProductId);
    const target = await this.repositories.targets.getById(payload.targetId);
    if (target === null) throw new EntityNotFoundError("Target", payload.targetId);
    const exporter = this.exporters.get(target.exporterCode);
    const existing = await this.repositories.targets.findTargetProduct(target.id, internal.id);
    const mappingRevision = await this.mappings.getTargetMappingRevision(target.id);
    const fingerprint = hashStableJson({ contentHash: internal.contentHash, exporterVersion: exporter.version, targetConfig: target.config, mappingRevision });
    if (!payload.force && existing?.lastExportFingerprint === fingerprint) return { status: "skipped" };
    const attemptedAt = new Date().toISOString();
    const targetDto: TargetDTO = { id: target.id, code: target.code, config: target.config };
    try {
      const result = await exporter.export({ target: targetDto, product: internal.data,
        references: { resolveReference: (input) => this.mappings.resolveTargetValue(target.id, input.referenceId, input.targetScope) },
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
