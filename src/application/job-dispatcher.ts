import { InvalidJobPayloadError } from "../core/errors/index.js";
import type { ExportControlRepository, JobRecord, SourceRunRepository } from "../repositories/index.js";
import type { CollectionRunner } from "./collection-runner.js";
import type { ExportRunner } from "./export-runner.js";
import { parseCollectProductPayload, parseDiscoverSourcePayload, parseExportProductPayload, parsePreflightProductPayload, parseProcessProductPayload } from "./job-payloads.js";
import type { PreflightRunner } from "./preflight-runner.js";
import type { ProcessingRunner } from "./processing-runner.js";
import type { RunnerResult } from "./runner-result.js";

export interface JobHandler {
  dispatch(job: JobRecord): Promise<RunnerResult>;
  handleTerminalFailure(job: JobRecord, error: unknown): Promise<void>;
}

export class JobDispatcher implements JobHandler {
  constructor(private readonly collection: CollectionRunner, private readonly processing: ProcessingRunner,
    private readonly exports: ExportRunner, private readonly sourceRuns: SourceRunRepository,
    private readonly preflights?: PreflightRunner,
    private readonly exportControl?: ExportControlRepository) {}

  async dispatch(job: JobRecord): Promise<RunnerResult> {
    switch (job.jobType) {
      case "discover_source": return await this.collection.discoverSource(parseDiscoverSourcePayload(job.payload));
      case "collect_product": return await this.collection.collectProduct(parseCollectProductPayload(job.payload));
      case "process_product": return await this.processing.processProduct(parseProcessProductPayload(job.payload));
      case "preflight_product": {
        if (this.preflights === undefined) throw new InvalidJobPayloadError("preflight_product is not configured");
        return await this.preflights.preflightProduct(parsePreflightProductPayload(job.payload));
      }
      case "export_product": return await this.exports.exportProduct(parseExportProductPayload(job.payload));
      default: throw new InvalidJobPayloadError(String(job.jobType));
    }
  }

  async handleTerminalFailure(job: JobRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    if (job.jobType === "preflight_product" && this.exportControl !== undefined) {
      const payload = parsePreflightProductPayload(job.payload);
      await this.exportControl.savePreflightError({
        targetId: payload.targetId,
        sourceProductId: payload.sourceProductId,
        error: message,
      });
      return;
    }
    if (job.jobType !== "discover_source") return;
    const payload = parseDiscoverSourcePayload(job.payload);
    const run = await this.sourceRuns.findActiveBySource(payload.sourceId);
    if (run !== null) await this.sourceRuns.fail(run.id, { error: message, checkpoint: run.checkpoint, finishedAt: new Date().toISOString() });
  }
}
