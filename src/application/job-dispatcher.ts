import { InvalidJobPayloadError } from "../core/errors/index.js";
import type { JobRecord, SourceRunRepository } from "../repositories/index.js";
import type { CollectionRunner } from "./collection-runner.js";
import type { ExportRunner } from "./export-runner.js";
import { parseCollectProductPayload, parseDiscoverSourcePayload, parseExportProductPayload, parseProcessProductPayload } from "./job-payloads.js";
import type { ProcessingRunner } from "./processing-runner.js";
import type { RunnerResult } from "./runner-result.js";

export interface JobHandler {
  dispatch(job: JobRecord): Promise<RunnerResult>;
  handleTerminalFailure(job: JobRecord, error: unknown): Promise<void>;
}

export class JobDispatcher implements JobHandler {
  constructor(private readonly collection: CollectionRunner, private readonly processing: ProcessingRunner,
    private readonly exports: ExportRunner, private readonly sourceRuns: SourceRunRepository) {}

  async dispatch(job: JobRecord): Promise<RunnerResult> {
    switch (job.jobType) {
      case "discover_source": return await this.collection.discoverSource(parseDiscoverSourcePayload(job.payload));
      case "collect_product": return await this.collection.collectProduct(parseCollectProductPayload(job.payload));
      case "process_product": return await this.processing.processProduct(parseProcessProductPayload(job.payload));
      case "export_product": return await this.exports.exportProduct(parseExportProductPayload(job.payload));
      default: throw new InvalidJobPayloadError(String(job.jobType));
    }
  }

  async handleTerminalFailure(job: JobRecord, error: unknown): Promise<void> {
    if (job.jobType !== "discover_source") return;
    const payload = parseDiscoverSourcePayload(job.payload);
    const run = await this.sourceRuns.findActiveBySource(payload.sourceId);
    if (run !== null) await this.sourceRuns.fail(run.id, { error: error instanceof Error ? error.message : String(error), checkpoint: run.checkpoint, finishedAt: new Date().toISOString() });
  }
}
