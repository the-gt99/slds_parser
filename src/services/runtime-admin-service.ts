import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Pool } from "pg";

import { createApplication, type ApplicationEnvironment } from "../bootstrap.js";
import type { JsonObject } from "../contracts/index.js";
import type { JobRepository, JobStatus, JobType, SourceRepository } from "../repositories/index.js";

export interface RuntimeLogRecord {
  readonly at: string;
  readonly level: "info" | "error";
  readonly message: string;
}

export interface RuntimeQueueSummary {
  readonly jobType: JobType;
  readonly status: JobStatus;
  readonly count: string;
}

export interface ExternalWorkerStatus {
  readonly serviceName: string;
  readonly available: boolean;
  readonly active: boolean;
  readonly state: string | null;
  readonly subState: string | null;
  readonly mainPid: string | null;
  readonly checkedAt: string;
}

export interface RuntimeStatus {
  readonly worker: ExternalWorkerStatus | null;
  readonly queue: readonly RuntimeQueueSummary[];
  readonly logs: readonly RuntimeLogRecord[];
}

export interface ManualJobRunResult {
  readonly jobId: string;
  readonly status: JobStatus;
  readonly error: string | null;
}

interface RuntimeApplication {
  readonly worker: {
    processById(jobId: string, jobTypes: readonly JobType[], workerId?: string): Promise<boolean>;
  };
  readonly close: () => Promise<void>;
}

interface RuntimeRepositories {
  readonly sources: SourceRepository;
  readonly jobs: JobRepository;
}

type RuntimeAdminEnvironment = ApplicationEnvironment & {
  readonly PARSER_WORKER_SYSTEMD_SERVICE?: string;
};

function positiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

const execFileAsync = promisify(execFile);
type SystemCommandRunner = (command: string, args: readonly string[], timeoutMs: number) => Promise<string>;

const runSystemCommand: SystemCommandRunner = async (command, args, timeoutMs) => {
  const { stdout } = await execFileAsync(command, [...args], { timeout: timeoutMs });
  return stdout;
};

export class RuntimeAdminService {
  private readonly logs: RuntimeLogRecord[] = [];

  constructor(
    private readonly database: Pool,
    private readonly repositories: RuntimeRepositories,
    private readonly environment: RuntimeAdminEnvironment = process.env,
    private readonly createRuntimeApplication: (environment: ApplicationEnvironment, options?: { readonly workerLogError?: (message: string) => void }) => RuntimeApplication = createApplication,
    private readonly commandRunner: SystemCommandRunner = runSystemCommand,
  ) {}

  async status(): Promise<RuntimeStatus> {
    return {
      worker: await this.externalWorkerStatus(),
      queue: await this.queueSummary(),
      logs: this.logs.slice().reverse(),
    };
  }

  async start(): Promise<ExternalWorkerStatus> {
    await this.controlExternalWorker("start");
    const worker = await this.requireExternalWorkerStatus();
    if (!worker.active) throw new Error(`${worker.serviceName} did not become active`);
    this.record("info", `Production worker started: ${worker.serviceName}`);
    return worker;
  }

  async stop(): Promise<ExternalWorkerStatus> {
    await this.controlExternalWorker("stop");
    const worker = await this.requireExternalWorkerStatus();
    if (worker.active) throw new Error(`${worker.serviceName} is still active`);
    this.record("info", `Production worker stopped: ${worker.serviceName}`);
    return worker;
  }

  async runProcessJob(jobId: string): Promise<ManualJobRunResult> {
    const application = this.createRuntimeApplication(this.environment, {
      workerLogError: (message) => this.record("error", message),
    });
    const workerId = `${this.environment.WORKER_ID?.trim() || "admin"}:manual-process-${jobId}`;
    this.record("info", `Manual processing requested for job ${jobId}`);
    try {
      const processed = await application.worker.processById(jobId, ["process_product"], workerId);
      if (!processed) throw new Error(`Job ${jobId} is not a pending or retry process_product job`);
      const result = await this.database.query<{ status: JobStatus; last_error: string | null }>(
        `SELECT status, last_error FROM jobs WHERE id = $1`,
        [jobId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error(`Job ${jobId} was not found after processing`);
      this.record(row.status === "completed" ? "info" : "error", `Manual processing finished for job ${jobId}: ${row.status}`);
      return { jobId, status: row.status, error: row.last_error };
    } finally {
      await application.close();
    }
  }

  async enqueueGoatDiscovery(input: { readonly discoveryBatchSize?: unknown; readonly requestDelayMs?: unknown; readonly enqueueCollection?: unknown }) {
    const discoveryBatchSize = positiveInteger(input.discoveryBatchSize, "discoveryBatchSize", 500);
    const requestDelayMs = positiveInteger(input.requestDelayMs, "requestDelayMs", 1_000);
    const enqueueCollection = input.enqueueCollection === true;
    const config: JsonObject = {
      sitemapUrl: "https://www.goat.com/sitemap",
      countryCode: "US",
      discoveryBatchSize,
      requestDelayMs,
    };
    const source = await this.repositories.sources.upsertDefinition({ code: "goat", name: "GOAT", adapterCode: "goat", config, enabled: true });
    const job = await this.repositories.jobs.enqueue({
      jobType: "discover_source",
      payload: { sourceId: source.id, runType: "full", coverage: "catalog", enqueueCollection },
      uniqueKey: `goat:${source.id}:admin-discovery:${Date.now()}`,
    });
    this.record("info", `GOAT discovery job enqueued: ${job.id}`);
    return { source, job };
  }

  private serviceName(): string {
    return this.environment.PARSER_WORKER_SYSTEMD_SERVICE?.trim() || "slds-parser-worker.service";
  }

  private record(level: RuntimeLogRecord["level"], message: string): void {
    this.logs.push({ at: new Date().toISOString(), level, message });
    while (this.logs.length > 200) this.logs.shift();
  }

  private async queueSummary(): Promise<RuntimeQueueSummary[]> {
    const result = await this.database.query<RuntimeQueueSummary>(
      `SELECT job_type AS "jobType", status, COUNT(*)::TEXT AS count
         FROM jobs
        WHERE status IN ('pending', 'running', 'retry', 'failed')
        GROUP BY job_type, status
        ORDER BY job_type, status`,
    );
    return result.rows;
  }

  private async controlExternalWorker(action: "start" | "stop"): Promise<void> {
    const serviceName = this.serviceName();
    try {
      await this.commandRunner("systemctl", [action, serviceName, "--no-pager"], 15_000);
    } catch (error) {
      this.record("error", `Cannot ${action} production worker ${serviceName}: ${error instanceof Error ? error.message : String(error)}`);
      throw new Error(`Cannot ${action} production worker ${serviceName}`);
    }
  }

  private async requireExternalWorkerStatus(): Promise<ExternalWorkerStatus> {
    const worker = await this.externalWorkerStatus();
    if (worker === null) throw new Error(`Systemd service ${this.serviceName()} is not available`);
    return worker;
  }

  private async externalWorkerStatus(): Promise<ExternalWorkerStatus | null> {
    const serviceName = this.serviceName();
    try {
      const stdout = await this.commandRunner("systemctl", [
        "show",
        serviceName,
        "-p", "ActiveState",
        "-p", "SubState",
        "-p", "MainPID",
        "--no-pager",
      ], 2_000);
      const values = Object.fromEntries(stdout.trim().split(/\r?\n/u).map((line) => {
        const separator = line.indexOf("=");
        return separator === -1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
      }));
      const state = values.ActiveState || null;
      return {
        serviceName,
        available: true,
        active: state === "active",
        state,
        subState: values.SubState || null,
        mainPid: values.MainPID && values.MainPID !== "0" ? values.MainPID : null,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }
}
