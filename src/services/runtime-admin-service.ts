import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Pool } from "pg";

import { createApplication, type ApplicationEnvironment } from "../bootstrap.js";
import type { JsonObject } from "../contracts/index.js";
import type { JobRepository, JobStatus, JobType, SourceRepository } from "../repositories/index.js";

export interface RuntimeSettings {
  readonly processConcurrency: number;
  readonly collectionConcurrency: number;
}

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
  readonly running: boolean;
  readonly externalWorker: ExternalWorkerStatus | null;
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
  readonly workerId: string;
  readonly settings: RuntimeSettings;
  readonly queue: readonly RuntimeQueueSummary[];
  readonly logs: readonly RuntimeLogRecord[];
}

interface RuntimeApplication {
  readonly worker: { run(signal: AbortSignal): Promise<void> };
  readonly close: () => Promise<void>;
}

interface RuntimeRepositories {
  readonly sources: SourceRepository;
  readonly jobs: JobRepository;
}

type RuntimeAdminEnvironment = ApplicationEnvironment & {
  readonly PARSER_WORKER_SYSTEMD_SERVICE?: string;
};

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function positiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

const execFileAsync = promisify(execFile);

export class RuntimeAdminService {
  private readonly logs: RuntimeLogRecord[] = [];
  private application: RuntimeApplication | null = null;
  private controller: AbortController | null = null;
  private runningPromise: Promise<void> | null = null;
  private startedAt: string | null = null;
  private stoppedAt: string | null = null;
  private settings: RuntimeSettings;

  constructor(
    private readonly database: Pool,
    private readonly repositories: RuntimeRepositories,
    private readonly environment: RuntimeAdminEnvironment = process.env,
    initialSettings: RuntimeSettings = {
      processConcurrency: integer(environment.WORKER_PROCESS_CONCURRENCY ?? "1", "WORKER_PROCESS_CONCURRENCY", 1, 8),
      collectionConcurrency: integer(environment.WORKER_COLLECTION_CONCURRENCY ?? "1", "WORKER_COLLECTION_CONCURRENCY", 1, 16),
    },
    private readonly createRuntimeApplication: (environment: ApplicationEnvironment, options?: { readonly workerLogError?: (message: string) => void }) => RuntimeApplication = createApplication,
  ) {
    this.settings = initialSettings;
  }

  async status(): Promise<RuntimeStatus> {
    return {
      running: this.application !== null,
      externalWorker: await this.externalWorkerStatus(),
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      workerId: this.workerId(),
      settings: this.settings,
      queue: await this.queueSummary(),
      logs: this.logs.slice().reverse(),
    };
  }

  updateSettings(input: { readonly processConcurrency?: unknown; readonly collectionConcurrency?: unknown }): RuntimeSettings {
    if (this.application !== null) throw new Error("Stop runtime before changing worker settings");
    this.settings = {
      processConcurrency: input.processConcurrency === undefined
        ? this.settings.processConcurrency
        : integer(input.processConcurrency, "processConcurrency", 1, 8),
      collectionConcurrency: input.collectionConcurrency === undefined
        ? this.settings.collectionConcurrency
        : integer(input.collectionConcurrency, "collectionConcurrency", 1, 16),
    };
    this.record("info", `Worker settings updated: processing=${this.settings.processConcurrency}, collection=${this.settings.collectionConcurrency}`);
    return this.settings;
  }

  async start(): Promise<RuntimeSettings> {
    if (this.application !== null) return this.settings;
    const external = await this.externalWorkerStatus();
    if (external?.active) {
      this.record("error", `External worker is already active: ${external.serviceName}`);
      throw new Error(`External worker is already active: ${external.serviceName}`);
    }
    const controller = new AbortController();
    const runtimeEnvironment = {
      ...this.environment,
      WORKER_ID: this.workerId(),
      WORKER_POLL_INTERVAL_MS: this.environment.WORKER_POLL_INTERVAL_MS ?? "1000",
      WORKER_LOCK_TIMEOUT_MS: this.environment.WORKER_LOCK_TIMEOUT_MS ?? "300000",
      WORKER_PROCESS_CONCURRENCY: String(this.settings.processConcurrency),
      WORKER_COLLECTION_CONCURRENCY: String(this.settings.collectionConcurrency),
      MAX_JOB_ATTEMPTS: this.environment.MAX_JOB_ATTEMPTS ?? "3",
      JOB_RETRY_BASE_MS: this.environment.JOB_RETRY_BASE_MS ?? "1000",
      JOB_RETRY_MAX_MS: this.environment.JOB_RETRY_MAX_MS ?? "60000",
    };
    const application = this.createRuntimeApplication(runtimeEnvironment, {
      workerLogError: (message) => this.record("error", message),
    });
    this.application = application;
    this.controller = controller;
    this.startedAt = new Date().toISOString();
    this.stoppedAt = null;
    this.record("info", `Worker started: ${runtimeEnvironment.WORKER_ID}`);
    this.runningPromise = application.worker.run(controller.signal).catch((error: unknown) => {
      this.record("error", `Worker stopped with error: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(async () => {
      await application.close().catch((error: unknown) => {
        this.record("error", `Worker close failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (this.application === application) {
        this.application = null;
        this.controller = null;
        this.runningPromise = null;
        this.stoppedAt = new Date().toISOString();
        this.record("info", "Worker stopped");
      }
    });
    return this.settings;
  }

  async stop(): Promise<void> {
    const controller = this.controller;
    const promise = this.runningPromise;
    if (controller === null || promise === null) return;
    this.record("info", "Worker stop requested");
    controller.abort();
    await promise;
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

  private workerId(): string {
    const base = this.environment.WORKER_ID?.trim() || "admin-worker";
    return `${base}:admin`;
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

  private async externalWorkerStatus(): Promise<ExternalWorkerStatus | null> {
    const serviceName = this.environment.PARSER_WORKER_SYSTEMD_SERVICE?.trim() || "slds-parser-worker.service";
    try {
      const { stdout } = await execFileAsync("systemctl", [
        "show",
        serviceName,
        "-p", "ActiveState",
        "-p", "SubState",
        "-p", "MainPID",
        "--no-pager",
      ], { timeout: 2_000 });
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
