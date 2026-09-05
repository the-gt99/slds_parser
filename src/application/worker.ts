import { PermanentError, RetryableError } from "../core/errors/index.js";
import type { JobRepository, JobRecord, JobType } from "../repositories/index.js";
import type { JobHandler } from "./job-dispatcher.js";
import { parsePollWordPressVariationPatchesPayload, type PollWordPressVariationPatchesPayload } from "./job-payloads.js";

export interface WorkerClaimPermit {
  run<Result>(callback: () => Promise<Result>): Promise<Result>;
  releaseUnused(): Promise<void>;
}

export interface WorkerOptions {
  readonly workerId: string;
  readonly role?: "all" | "pipeline" | "inventory";
  readonly pollIntervalMs: number;
  readonly lockTimeoutMs: number;
  readonly maxJobAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly wordpressMaxJobAttempts?: number;
  readonly wordpressRetryBaseMs?: number;
  readonly wordpressRetryMaxMs?: number;
  readonly processConcurrency?: number;
  readonly translationConcurrency?: number;
  readonly collectionConcurrency?: number;
  readonly preflightConcurrency?: number;
  readonly classificationApplyConcurrency?: number;
  readonly exportConcurrency?: number;
  readonly exportRefreshConcurrency?: number;
  readonly inventoryRefreshConcurrency?: number;
  readonly inventoryPrepareConcurrency?: number;
  readonly inventorySubmitConcurrency?: number;
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
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (!(cause instanceof Error)) return error.message;
  const code = "code" in cause && typeof cause.code === "string" ? cause.code : cause.name;
  return `${error.message} [${code}: ${cause.message}]`;
}

function usesWordPressRetryPolicy(job: JobRecord, error: unknown): boolean {
  return error instanceof RetryableError
    && error.code.startsWith("WORDPRESS_")
    && (job.jobType === "preflight_product" || job.jobType === "export_product"
      || job.jobType === "prepare_wordpress_variation_patch" || job.jobType === "submit_wordpress_variation_patches"
      || job.jobType === "poll_wordpress_variation_patches");
}

export class Worker {
  private static readonly reclassificationBatchSize = 16;
  private static readonly wordpressVariationPollClaimBatchSize = 100;
  private static readonly wordpressVariationPollRequestSize = 500;

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

  async processWordPressVariationPollBatch(workerId: string): Promise<boolean> {
    const jobs = await this.jobs.claimMany(
      workerId,
      this.options.lockTimeoutMs,
      "poll_wordpress_variation_patches",
      Worker.wordpressVariationPollClaimBatchSize,
    );
    if (jobs.length === 0) return false;

    const valid: Array<{ job: JobRecord; payload: PollWordPressVariationPatchesPayload }> = [];
    for (const job of jobs) {
      try {
        valid.push({ job, payload: parsePollWordPressVariationPatchesPayload(job.payload) });
      } catch {
        await this.processClaimed(job);
      }
    }

    for (const batch of this.buildWordPressVariationPollBatches(valid)) {
      await this.processWordPressVariationPollJobs(batch);
    }
    return true;
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
      await this.handleClaimedFailure(job, error);
    }
  }

  private async handleClaimedFailure(job: JobRecord, error: unknown): Promise<void> {
    const wordpressPolicy = usesWordPressRetryPolicy(job, error);
    const maxAttempts = wordpressPolicy
      ? (this.options.wordpressMaxJobAttempts ?? this.options.maxJobAttempts)
      : this.options.maxJobAttempts;
    const retryBaseMs = wordpressPolicy
      ? (this.options.wordpressRetryBaseMs ?? this.options.retryBaseMs)
      : this.options.retryBaseMs;
    const retryMaxMs = wordpressPolicy
      ? (this.options.wordpressRetryMaxMs ?? this.options.retryMaxMs)
      : this.options.retryMaxMs;
    if (error instanceof RetryableError && job.attempts < maxAttempts) {
      const delay = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.max(0, job.attempts - 1)));
      await this.jobs.retry(job.id, { error: errorText(error), availableAt: new Date(this.currentTime() + delay).toISOString() });
      return;
    }
    await this.jobs.fail(job.id, errorText(error));
    if (error instanceof PermanentError || !(error instanceof RetryableError) || job.attempts >= maxAttempts) {
      try {
        await this.dispatcher.handleTerminalFailure(job, error);
      } catch (cleanupError) {
        this.logError(`Terminal cleanup failed for job ${job.id}: ${errorText(cleanupError)}`);
      }
    }
  }

  private buildWordPressVariationPollBatches(
    entries: ReadonlyArray<{ job: JobRecord; payload: PollWordPressVariationPatchesPayload }>,
  ): Array<ReadonlyArray<{ job: JobRecord; payload: PollWordPressVariationPatchesPayload }>> {
    const batches: Array<Array<{ job: JobRecord; payload: PollWordPressVariationPatchesPayload }>> = [];
    const byRunAndPoll = new Map<string, Array<Array<{ job: JobRecord; payload: PollWordPressVariationPatchesPayload }>>>();
    for (const entry of entries) {
      const groupKey = `${entry.payload.runId}:${entry.payload.poll}`;
      let runBatches = byRunAndPoll.get(groupKey);
      if (runBatches === undefined) {
        runBatches = [];
        byRunAndPoll.set(groupKey, runBatches);
      }
      const current = runBatches.at(-1);
      const currentIds = current === undefined
        ? new Set<string>()
        : new Set(current.flatMap((item) => item.payload.jobIds));
      const combinedIds = new Set([...currentIds, ...entry.payload.jobIds]);
      if (current === undefined || combinedIds.size > Worker.wordpressVariationPollRequestSize) {
        const next = [entry];
        runBatches.push(next);
        batches.push(next);
      } else {
        current.push(entry);
      }
    }
    return batches;
  }

  private async processWordPressVariationPollJobs(
    entries: ReadonlyArray<{ job: JobRecord; payload: PollWordPressVariationPatchesPayload }>,
  ): Promise<void> {
    const first = entries[0];
    if (first === undefined) return;
    const payload: PollWordPressVariationPatchesPayload = {
      runId: first.payload.runId,
      jobIds: [...new Set(entries.flatMap((entry) => entry.payload.jobIds))],
      poll: first.payload.poll,
    };
    try {
      await this.dispatcher.dispatch({
        ...first.job,
        payload: { runId: payload.runId, jobIds: [...payload.jobIds], poll: payload.poll },
      });
    } catch (error) {
      for (const entry of entries) await this.handleClaimedFailure(entry.job, error);
      return;
    }
    for (const entry of entries) {
      try {
        await this.jobs.complete(entry.job.id);
      } catch (error) {
        await this.handleClaimedFailure(entry.job, error);
      }
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    const role = this.options.role ?? "all";
    const runPipeline = role === "all" || role === "pipeline";
    const runInventory = role === "all" || role === "inventory";
    const discoveryJobTypes = ["discover_source"] satisfies readonly JobType[];
    const collectionJobTypes = ["collect_product"] satisfies readonly JobType[];
    const retranslationJobTypes = ["retranslate_product"] satisfies readonly JobType[];
    const exportJobTypes = ["export_product"] satisfies readonly JobType[];
    const exportRefreshJobTypes = ["refresh_export_source"] satisfies readonly JobType[];
    const preflightJobTypes = ["preflight_product"] satisfies readonly JobType[];
    const classificationSyncJobTypes = ["sync_target_classifications"] satisfies readonly JobType[];
    const classificationApplyJobTypes = ["apply_target_classification_suggestion"] satisfies readonly JobType[];
    const wordpressCatalogJobTypes = ["sync_wordpress_catalog"] satisfies readonly JobType[];
    const wordpressVariationJobTypes = ["prepare_wordpress_variation_patches"] satisfies readonly JobType[];
    const wordpressVariationCollectJobTypes = ["collect_wordpress_variation_source"] satisfies readonly JobType[];
    const wordpressVariationPrepareJobTypes = ["prepare_wordpress_variation_patch"] satisfies readonly JobType[];
    const wordpressVariationSubmitJobTypes = ["submit_wordpress_variation_patches"] satisfies readonly JobType[];
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
        ...(runPipeline ? [
        this.runLane(controller.signal, discoveryJobTypes, `${this.options.workerId}:discovery`),
        ...Array.from({ length: configuredConcurrency.collectionConcurrency }, (_, index) =>
          this.runLane(controller.signal, collectionJobTypes, `${this.options.workerId}:collection-${index + 1}`)),
        ...Array.from({ length: configuredConcurrency.processConcurrency }, (_, index) =>
          this.runProcessingLane(controller.signal, `${this.options.workerId}:process-${index + 1}`)),
        ...Array.from({ length: this.options.translationConcurrency ?? 1 }, (_, index) =>
          this.runLane(controller.signal, retranslationJobTypes, `${this.options.workerId}:translation-${index + 1}`)),
        ...Array.from({ length: configuredConcurrency.preflightConcurrency }, (_, index) =>
          this.runLane(controller.signal, preflightJobTypes, `${this.options.workerId}:preflight-${index + 1}`)),
        this.runLane(controller.signal, classificationSyncJobTypes, `${this.options.workerId}:classification-sync`),
        this.runLane(controller.signal, wordpressCatalogJobTypes, `${this.options.workerId}:wordpress-catalog`),
        ...Array.from({ length: configuredConcurrency.preflightConcurrency }, (_, index) =>
          this.runLane(controller.signal, wordpressVariationJobTypes, `${this.options.workerId}:wordpress-audit-${index + 1}`)),
        ...Array.from({ length: configuredConcurrency.classificationApplyConcurrency }, (_, index) =>
          this.runLane(controller.signal, classificationApplyJobTypes, `${this.options.workerId}:classification-apply-${index + 1}`)),
        ...Array.from({ length: this.options.exportConcurrency ?? 1 }, (_, index) =>
          this.runLane(controller.signal, exportJobTypes, `${this.options.workerId}:export-${index + 1}`)),
        ...Array.from({ length: this.options.exportRefreshConcurrency ?? 1 }, (_, index) =>
          this.runLane(controller.signal, exportRefreshJobTypes, `${this.options.workerId}:export-refresh-${index + 1}`)),
        ...(this.exportCampaigns === undefined ? [] : [this.runExportCampaignLane(controller.signal)]),
        ] : []),
        ...(runInventory ? [
          this.runWordPressVariationPollLane(controller.signal, `${this.options.workerId}:inventory-poll`),
          ...Array.from({ length: this.options.inventoryRefreshConcurrency ?? 1 }, (_, index) =>
            this.runLane(controller.signal, wordpressVariationCollectJobTypes, `${this.options.workerId}:inventory-collect-${index + 1}`)),
          ...Array.from({ length: this.options.inventoryPrepareConcurrency ?? 4 }, (_, index) =>
            this.runLane(controller.signal, wordpressVariationPrepareJobTypes, `${this.options.workerId}:inventory-prepare-${index + 1}`)),
          ...Array.from({ length: this.options.inventorySubmitConcurrency ?? 2 }, (_, index) =>
            this.runLane(controller.signal, wordpressVariationSubmitJobTypes, `${this.options.workerId}:inventory-submit-${index + 1}`)),
          ...(this.wordpressVariationAuto === undefined ? [] : [this.runWordPressVariationAutoLane(controller.signal)]),
        ] : []),
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

  private async runWordPressVariationPollLane(signal: AbortSignal, workerId: string): Promise<void> {
    while (!signal.aborted) {
      const processed = await this.processWordPressVariationPollBatch(workerId);
      if (!processed && !signal.aborted) await this.sleep(this.options.pollIntervalMs, signal);
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
