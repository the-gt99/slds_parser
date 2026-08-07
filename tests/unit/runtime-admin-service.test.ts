import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { JobRepository, SourceRepository } from "../../src/repositories/index.js";
import { RuntimeAdminService } from "../../src/services/index.js";

const repositories = {
  sources: {} as SourceRepository,
  jobs: {} as JobRepository,
};

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
});
