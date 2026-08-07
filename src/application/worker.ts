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
}

export type WorkerSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;
export type WorkerLogger = (message: string) => void;
export type WorkerClaimPermitProvider = (jobTypes: readonly JobType[]) => Promise<WorkerClaimPermit | null>;

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
  constructor(private readonly jobs: JobRepository, private readonly dispatcher: JobHandler,
    private readonly options: WorkerOptions, private readonly sleep: WorkerSleep = abortableSleep,
    private readonly currentTime: () => number = Date.now,
    private readonly logError: WorkerLogger = console.error,
    private readonly claimPermit?: WorkerClaimPermitProvider) {}

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
    const processConcurrency = this.options.processConcurrency ?? 1;
    const collectionConcurrency = this.options.collectionConcurrency ?? 1;
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    try {
      await Promise.all([
        this.runLane(controller.signal, discoveryJobTypes, `${this.options.workerId}:discovery`),
        ...Array.from({ length: collectionConcurrency }, (_, index) =>
          this.runLane(controller.signal, collectionJobTypes, `${this.options.workerId}:collection-${index + 1}`)),
        ...Array.from({ length: processConcurrency }, (_, index) =>
          this.runLane(controller.signal, ["process_product"], `${this.options.workerId}:process-${index + 1}`)),
        this.runLane(controller.signal, exportJobTypes, `${this.options.workerId}:export`),
      ]);
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
    }
  }

  private async runLane(signal: AbortSignal, jobTypes: readonly JobType[], workerId: string): Promise<void> {
    while (!signal.aborted) {
      const processed = await this.processNext(jobTypes, workerId);
      if (!processed && !signal.aborted) await this.sleep(this.options.pollIntervalMs, signal);
    }
  }
}
