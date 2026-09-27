import { afterEach, describe, expect, it, vi } from "vitest";
import { createPostgresPool } from "../../src/infrastructure/db/pool.js";

describe("PostgreSQL pool", () => {
  afterEach(() => vi.restoreAllMocks());

  it("handles an idle client error without an unhandled error event", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = createPostgresPool({ DATABASE_URL: "postgres://user:password@127.0.0.1:5432/database" });

    expect(() => pool.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    expect(error).toHaveBeenCalledWith("PostgreSQL idle client error: Connection terminated unexpectedly");
    await pool.end();
  });
});
