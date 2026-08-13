import { PermanentError, RetryableError } from "../core/errors/index.js";
import type { JobRepository, JobRecord, JobType } from "../repositories/index.js";
import type { JobHandler } from "./job-dispatcher.js";

export interface WorkerClaimPermit {
  run<Result>(callback: () => Promise<Result>): Promise<Result>;
  releaseUnused(): Promise<void>;
}

export interface WorkerOptions {
  readonly workerId: string;
  readonly pollIntervalMs: number;
  readonly lockTimeoutMs: number;
  readonly maxJobAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly processConcurrency?: number;
  readonly collectionConcurrency?: number;
  readonly preflightConcurrency?: number;
  readonly classificationApplyConcurrency?: number;
}

export interface WorkerConcurrency {
  readonly processConcurrency: number;
  readonly collectionConcurrency: number;
  readonly preflightConcurrency: number;
  readonly classificationApplyConcurrency: number;
}

export type WorkerSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;
export type WorkerLogger = (message: string) => void;
export type WorkerClaimPermitProvider = (jobTypes: readonly JobType[]) => Promise<WorkerClaimPermit | null>;
export type WorkerConcurrencyProvider = () => Promise<WorkerConcurrency>;
export interface ExportCampaignCoordinator { tickCampaign(): Promise<boolean> }
export interface WordPressVariationAutoCoordinator { tickVariationAutoSync(): Promise<boolean> }

export function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Worker {
  private static readonly reclassificationBatchSize = 16;

  constructor(private readonly jobs: JobRepository, private readonly dispatcher: JobHandler,
    private readonly options: WorkerOptions, private readonly sleep: WorkerSleep = abortableSleep,
    private readonly currentTime: () => number = Date.now,
    private readonly logError: WorkerLogger = console.error,
    private readonly claimPermit?: WorkerClaimPermitProvider,
    private readonly concurrencyProvider?: WorkerConcurrencyProvider,
    private readonly exportCampaigns?: ExportCampaignCoordinator,
    private readonly wordpressVariationAuto?: WordPressVariationAutoCoordinator) {}

  async processNext(jobTypes?: readonly JobType[], workerId = this.options.workerId): Promise<boolean> {
    const permit = this.claimPermit === undefined ? undefined : await this.claimPermit(jobTypes ?? []);
    if (permit === null) return false;
    const job = await this.jobs.claimNext(workerId, this.options.lockTimeoutMs, jobTypes);
    if (job === null) {
      await permit?.releaseUnused();
      return false;
    }
    await this.processClaimed(job, permit);
    return true;
  }

  async processById(jobId: string, jobTypes: readonly JobType[], workerId = this.options.workerId): Promise<boolean> {
    const job = await this.jobs.claimById(jobId, workerId, jobTypes);
    if (job === null) return false;
    await this.processClaimed(job);
    return true;
  }

  async processMany(jobType: JobType, workerId: string, limit: number): Promise<boolean> {
    const jobs = await this.jobs.claimMany(workerId, this.options.lockTimeoutMs, jobType, limit);
    for (const job of jobs) await this.processClaimed(job);
    return jobs.length > 0;
  }

  private async processClaimed(job: JobRecord, permit?: WorkerClaimPermit): Promise<void> {
    const process = async (): Promise<void> => {
      await this.dispatcher.dispatch(job);
      await this.jobs.complete(job.id);
    };
    try {
      if (permit === undefined) await process();
      else await permit.run(process);
    } catch (error) {
      if (error instanceof RetryableError && job.attempts < this.options.maxJobAttempts) {
        const delay = Math.min(this.options.retryMaxMs, this.options.retryBaseMs * (2 ** Math.max(0, job.attempts - 1)));
        await this.jobs.retry(job.id, { error: errorText(error), availableAt: new Date(this.currentTime() + delay).toISOString() });
      } else {
        await this.jobs.fail(job.id, errorText(error));
        if (error instanceof PermanentError || !(error instanceof RetryableError) || job.attempts >= this.options.maxJobAttempts) {
          try {
            await this.dispatcher.handleTerminalFailure(job, error);
          } catch (cleanupError) {
            this.logError(`Terminal cleanup failed for job ${job.id}: ${errorText(cleanupError)}`);
          }
        }
      }
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    const discoveryJobTypes = ["discover_source"] satisfies readonly JobType[];
    const collectionJobTypes = ["collect_product"] satisfies readonly JobType[];
    const exportJobTypes = ["export_product"] satisfies readonly JobType[];
    const preflightJobTypes = ["preflight_product"] satisfies readonly JobType[];
    const classificationSyncJobTypes = ["sync_target_classifications"] satisfies readonly JobType[];
    const classificationApplyJobTypes = ["apply_target_classification_suggestion"] satisfies readonly JobType[];
    const wordpressCatalogJobTypes = ["sync_wordpress_catalog"] satisfies readonly JobType[];
    const wordpressVariationJobTypes = ["prepare_wordpress_variation_patches"] satisfies readonly JobType[];
    const wordpressVariationPollJobTypes = ["poll_wordpress_variation_patches"] satisfies readonly JobType[];
    const wordpressVariationRefreshJobTypes = ["refresh_wordpress_variation_patch"] satisfies readonly JobType[];
    const configuredConcurrency = this.concurrencyProvider === undefined
      ? {
          processConcurrency: this.options.processConcurrency ?? 1,
          collectionConcurrency: this.options.collectionConcurrency ?? 1,
          preflightConcurrency: this.options.preflightConcurrency ?? 1,
          classificationApplyConcurrency: this.options.classificationApplyConcurrency ?? 1,
        }
      : await this.concurrencyProvider();
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    try {
      await Promise.all([
        this.runLane(controller.signal, discoveryJobTypes, `${this.options.workerId}:discovery`),
        ...Array.from({ length: configuredConcurrency.collectionConcurrency }, (_, index) =>
          this.runLane(controller.signal, collectionJobTypes, `${this.options.workerId}:collection-${index + 1}`)),
        ...Array.from({ length: configuredConcurrency.processConcurrency }, (_, index) =>
          this.runProcessingLane(controller.signal, `${this.options.workerId}:process-${index + 1}`)),
        ...Array.from({ length: configuredConcurrency.preflightConcurrency }, (_, index) =>
          this.runLane(controller.signal, preflightJobTypes, `${this.options.workerId}:preflight-${index + 1}`)),
        this.runLane(controller.signal, classificationSyncJobTypes, `${this.options.workerId}:classification-sync`),
        this.runLane(controller.signal, wordpressCatalogJobTypes, `${this.options.workerId}:wordpress-catalog`),
        this.runLane(controller.signal, wordpressVariationJobTypes, `${this.options.workerId}:wordpress-variations`),
        this.runLane(controller.signal, wordpressVariationPollJobTypes, `${this.options.workerId}:wordpress-variation-poll`),
        ...Array.from({ length: configuredConcurrency.collectionConcurrency }, (_, index) =>
          this.runLane(controller.signal, wordpressVariationRefreshJobTypes, `${this.options.workerId}:wordpress-variation-refresh-${index + 1}`)),
        ...Array.from({ length: configuredConcurrency.classificationApplyConcurrency }, (_, index) =>
          this.runLane(controller.signal, classificationApplyJobTypes, `${this.options.workerId}:classification-apply-${index + 1}`)),
        this.runLane(controller.signal, exportJobTypes, `${this.options.workerId}:export`),
        ...(this.exportCampaigns === undefined ? [] : [this.runExportCampaignLane(controller.signal)]),
        ...(this.wordpressVariationAuto === undefined ? [] : [this.runWordPressVariationAutoLane(controller.signal)]),
      ]);
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
    }
  }

  private async runExportCampaignLane(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.exportCampaigns!.tickCampaign();
      } catch (error) {
        this.logError(`Export campaign tick failed: ${errorText(error)}`);
      }
      if (!signal.aborted) await this.sleep(this.options.pollIntervalMs, signal);
    }
  }

  private async runWordPressVariationAutoLane(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.wordpressVariationAuto!.tickVariationAutoSync();
      } catch (error) {
        this.logError(`WordPress variation auto-sync tick failed: ${errorText(error)}`);
      }
      if (!signal.aborted) await this.sleep(this.options.pollIntervalMs, signal);
    }
  }

  private async runLane(signal: AbortSignal, jobTypes: readonly JobType[], workerId: string): Promise<void> {
    while (!signal.aborted) {
      const processed = await this.processNext(jobTypes, workerId);
      if (!processed && !signal.aborted) await this.sleep(this.options.pollIntervalMs, signal);
    }
  }

  private async runProcessingLane(signal: AbortSignal, workerId: string): Promise<void> {
    while (!signal.aborted) {
      const processedProduct = await this.processNext(["process_product"], workerId);
      const processed = processedProduct || await this.processMany(
        "reclassify_product",
        workerId,
        Worker.reclassificationBatchSize,
      );
      if (!processed && !signal.aborted) await this.sleep(this.options.pollIntervalMs, signal);
    }
  }
}
