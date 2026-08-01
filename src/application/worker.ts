import { PermanentError, RetryableError } from "../core/errors/index.js";
import type { JobRepository, JobRecord } from "../repositories/index.js";
import type { JobHandler } from "./job-dispatcher.js";

export interface WorkerOptions {
  readonly workerId: string;
  readonly pollIntervalMs: number;
  readonly lockTimeoutMs: number;
  readonly maxJobAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
}

export type WorkerSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

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
    private readonly currentTime: () => number = Date.now) {}

  async processNext(): Promise<boolean> {
    const job = await this.jobs.claimNext(this.options.workerId, this.options.lockTimeoutMs);
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
          } catch {
            // The job is already terminal; a cleanup failure must not run it again.
          }
        }
      }
    }
    return true;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const processed = await this.processNext();
      if (!processed && !signal.aborted) await this.sleep(this.options.pollIntervalMs, signal);
    }
  }
}
