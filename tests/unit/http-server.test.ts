import { describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../../src/http/index.js";
import type { ClassifierAdminService, TargetDictionaryService } from "../../src/services/index.js";

const adminToken = "test-admin-token-with-at-least-32-characters";

function dependencies(database: { query(sql: string): Promise<unknown> }) {
  return {
    database,
    adminToken,
    classifier: {} as ClassifierAdminService,
    targetDictionaries: {} as TargetDictionaryService,
  };
}

describe("HTTP server", () => {
  it("returns healthy status when PostgreSQL is available", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }) };
    const server = createHttpServer(dependencies(database));

    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(database.query).toHaveBeenCalledWith("SELECT 1");
    await server.close();
  });

  it("returns 503 without exposing a database error", async () => {
    const database = { query: vi.fn().mockRejectedValue(new Error("connection secret")) };
    const server = createHttpServer(dependencies(database));

    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable" });
    expect(response.body).not.toContain("connection secret");
    await server.close();
  });

  it("protects classifier endpoints with a bearer token", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const classifier = { listReviewQueue: vi.fn().mockResolvedValue([]) } as unknown as ClassifierAdminService;
    const server = createHttpServer({
      ...dependencies(database),
      classifier,
    });

    const unauthorized = await server.inject({ method: "GET", url: "/api/classifier/queue" });
    const authorized = await server.inject({
      method: "GET",
      url: "/api/classifier/queue",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({ items: [] });
    await server.close();
  });

  it("rejects malformed identifiers before reaching classifier commands", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const classifier = { saveDecision: vi.fn() } as unknown as ClassifierAdminService;
    const server = createHttpServer({ ...dependencies(database), classifier });

    const response = await server.inject({
      method: "POST",
      url: "/api/classifier/decisions",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        sourceId: "goat",
        typeCode: "brand",
        scope: "product.brand",
        normalizedSourceValue: "nike",
        contextKey: "{}",
        action: "ignore",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(classifier.saveDecision).not.toHaveBeenCalled();
    await server.close();
  });
});
