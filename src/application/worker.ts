import { PermanentError, RetryableError } from "../core/errors/index.js";
import type { JobRepository, JobRecord, JobType } from "../repositories/index.js";
import type { JobHandler } from "./job-dispatcher.js";

export interface WorkerOptions {
  readonly workerId: string;
  readonly pollIntervalMs: number;
  readonly lockTimeoutMs: number;
  readonly maxJobAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly processConcurrency?: number;
}

export type WorkerSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;
export type WorkerLogger = (message: string) => void;

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
    private readonly logError: WorkerLogger = console.error) {}

  async processNext(jobTypes?: readonly JobType[], workerId = this.options.workerId): Promise<boolean> {
    const job = await this.jobs.claimNext(workerId, this.options.lockTimeoutMs, jobTypes);
    if (job === null) return false;
    try {
      await this.dispatcher.dispatch(job);
      await this.jobs.complete(job.id);
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
    return true;
  }

  async run(signal: AbortSignal): Promise<void> {
    const generalJobTypes = ["discover_source", "collect_product", "export_product"] satisfies readonly JobType[];
    const processConcurrency = this.options.processConcurrency ?? 1;
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    try {
      await Promise.all([
        this.runLane(controller.signal, generalJobTypes, `${this.options.workerId}:general`),
        ...Array.from({ length: processConcurrency }, (_, index) =>
          this.runLane(controller.signal, ["process_product"], `${this.options.workerId}:process-${index + 1}`)),
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
