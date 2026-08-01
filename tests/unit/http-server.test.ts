import { describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../../src/http/index.js";

describe("HTTP server", () => {
  it("returns healthy status when PostgreSQL is available", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }) };
    const server = createHttpServer(database);

    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(database.query).toHaveBeenCalledWith("SELECT 1");
    await server.close();
  });

  it("returns 503 without exposing a database error", async () => {
    const database = { query: vi.fn().mockRejectedValue(new Error("connection secret")) };
    const server = createHttpServer(database);

    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable" });
    expect(response.body).not.toContain("connection secret");
    await server.close();
  });
});
