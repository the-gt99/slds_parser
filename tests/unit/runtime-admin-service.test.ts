import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { JobRepository, RuntimeWorkerSettingsRecord, RuntimeWorkerSettingsRepository, SourceRepository } from "../../src/repositories/index.js";
import { RuntimeAdminService } from "../../src/services/index.js";

const repositories = {
  sources: {} as SourceRepository,
  jobs: {} as JobRepository,
};

const workerEnvironment = {
  WORKER_ID: "production",
  WORKER_POLL_INTERVAL_MS: "1000",
  WORKER_LOCK_TIMEOUT_MS: "300000",
  WORKER_COLLECTION_CONCURRENCY: "15",
  WORKER_PROCESS_CONCURRENCY: "10",
  WORKER_PREFLIGHT_CONCURRENCY: "1",
  MAX_JOB_ATTEMPTS: "5",
  JOB_RETRY_BASE_MS: "1000",
  JOB_RETRY_MAX_MS: "60000",
};

function runtimeSettings(overrides: Partial<RuntimeWorkerSettingsRecord> = {}): RuntimeWorkerSettingsRecord {
  return {
    collectionConcurrency: 15,
    processConcurrency: 10,
    preflightConcurrency: 4,
    revision: "2",
    updatedBy: "admin",
    updatedAt: "2026-08-11T12:00:00.000Z",
    applied: null,
    ...overrides,
  };
}

describe("RuntimeAdminService", () => {
  it("processes exactly the selected process job and closes the one-shot application", async () => {
    const database = {
      query: vi.fn().mockResolvedValue({ rows: [{ status: "completed", last_error: null }] }),
    } as unknown as Pool;
    const processById = vi.fn().mockResolvedValue(true);
    const close = vi.fn().mockResolvedValue(undefined);
    const createApplication = vi.fn().mockReturnValue({ worker: { processById }, close });
    const service = new RuntimeAdminService(database, repositories, { WORKER_ID: "production" } as never, createApplication);

    const result = await service.runProcessJob("350520");

    expect(processById).toHaveBeenCalledWith("350520", ["process_product"], "production:manual-process-350520");
    expect(result).toEqual({ jobId: "350520", status: "completed", error: null });
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects a job that was already claimed and still closes the one-shot application", async () => {
    const database = { query: vi.fn() } as unknown as Pool;
    const close = vi.fn().mockResolvedValue(undefined);
    const createApplication = vi.fn().mockReturnValue({ worker: { processById: vi.fn().mockResolvedValue(false) }, close });
    const service = new RuntimeAdminService(database, repositories, {} as never, createApplication);

    await expect(service.runProcessJob("10")).rejects.toThrow("not a pending or retry process_product job");
    expect(database.query).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("controls only the configured production systemd service", async () => {
    const database = { query: vi.fn() } as unknown as Pool;
    const command = vi.fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("ActiveState=active\nSubState=running\nMainPID=123\n");
    const service = new RuntimeAdminService(database, repositories, { PARSER_WORKER_SYSTEMD_SERVICE: "slds-parser-worker.service" } as never, undefined, command);

    const result = await service.start();

    expect(result).toMatchObject({ serviceName: "slds-parser-worker.service", active: true, mainPid: "123" });
    expect(command.mock.calls[0]).toEqual(["systemctl", ["start", "slds-parser-worker.service", "--no-pager"], 15_000]);
    expect(command.mock.calls[1]?.[1]).toContain("slds-parser-worker.service");
  });

  it("saves runtime concurrency and restarts an active worker explicitly", async () => {
    const database = { query: vi.fn() } as unknown as Pool;
    const saved = runtimeSettings();
    const applied = runtimeSettings({ applied: {
      collectionConcurrency: 15,
      processConcurrency: 10,
      preflightConcurrency: 4,
      revision: "2",
      workerId: "production",
      appliedAt: "2026-08-11T12:01:00.000Z",
    } });
    const workerSettings = {
      getOrCreate: vi.fn().mockResolvedValueOnce(runtimeSettings({ revision: "1" })).mockResolvedValueOnce(applied),
      save: vi.fn().mockResolvedValue(saved),
      loadAndMarkApplied: vi.fn(),
    } satisfies RuntimeWorkerSettingsRepository;
    const command = vi.fn()
      .mockResolvedValueOnce("ActiveState=active\nSubState=running\nMainPID=100\n")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("ActiveState=inactive\nSubState=dead\nMainPID=0\n")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("ActiveState=active\nSubState=running\nMainPID=101\n");
    const service = new RuntimeAdminService(database, repositories, workerEnvironment as never, undefined, command, workerSettings);

    const result = await service.saveSettings({
      collectionConcurrency: "15",
      processConcurrency: "10",
      preflightConcurrency: "4",
    }, "admin", true);

    expect(workerSettings.save).toHaveBeenCalledWith({
      collectionConcurrency: 15,
      processConcurrency: 10,
      preflightConcurrency: 4,
    }, "admin");
    expect(command.mock.calls.map((call) => call[1][0])).toEqual(["show", "stop", "show", "start", "show"]);
    expect(result).toEqual({ settings: applied, worker: expect.objectContaining({ active: true, mainPid: "101" }) });
  });
});
