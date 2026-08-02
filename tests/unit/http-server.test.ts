import { describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../../src/http/index.js";
import type { ClassifierAdminService, ProductAdminService, TargetDictionaryService } from "../../src/services/index.js";

const adminToken = "test-admin-token-with-at-least-32-characters";
const auth = {
  token: adminToken,
  username: "admin",
  password: "test-admin-password",
  sessionSecret: "test-session-secret-with-at-least-32-characters",
  wordpressCreatePassword: "test-wordpress-password",
};

function dependencies(database: { query(sql: string): Promise<unknown> }) {
  return {
    database,
    auth,
    classifier: {} as ClassifierAdminService,
    targetDictionaries: {} as TargetDictionaryService,
    productAdmin: {} as ProductAdminService,
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

  it("serves the classifier interface", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const server = createHttpServer(dependencies(database));

    const response = await server.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("SLDS · Классификатор");
    await server.close();
  });

  it("serves a product page and protects its data endpoint", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const productAdmin = {
      getProduct: vi.fn().mockResolvedValue({ sourceProduct: { id: "3" }, product: { title: "YZY Pod" } }),
    } as unknown as ProductAdminService;
    const server = createHttpServer({ ...dependencies(database), productAdmin });

    const page = await server.inject({ method: "GET", url: "/products/3" });
    const unauthorized = await server.inject({ method: "GET", url: "/api/products/3" });
    const authorized = await server.inject({
      method: "GET",
      url: "/api/products/3",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Карточка товара");
    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({ item: { sourceProduct: { id: "3" }, product: { title: "YZY Pod" } } });
    expect(productAdmin.getProduct).toHaveBeenCalledWith("3");
    await server.close();
  });

  it("uses an HttpOnly session and CSRF token for browser mutations", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const classifier = {
      saveDecision: vi.fn().mockResolvedValue({ mappingId: "1", referenceValueId: null, revision: "1", affectedProductCount: 1, affectedExportCount: 0 }),
    } as unknown as ClassifierAdminService;
    const server = createHttpServer({ ...dependencies(database), classifier });
    const login = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "test-admin-password" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const csrfToken = login.json().csrfToken;
    const payload = {
      sourceId: "1", typeCode: "brand", scope: "product.brand",
      normalizedSourceValue: "nike", contextKey: "{}", action: "ignore",
    };

    const forbidden = await server.inject({ method: "POST", url: "/api/classifier/decisions", headers: { cookie }, payload });
    const allowed = await server.inject({
      method: "POST",
      url: "/api/classifier/decisions",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload,
    });

    expect(login.statusCode).toBe(200);
    expect(String(login.headers["set-cookie"])).toContain("HttpOnly");
    expect(forbidden.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(classifier.saveDecision).toHaveBeenCalledWith(expect.anything(), "admin");
    await server.close();
  });

  it("requires a separate short-lived permission before creating a WordPress term", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const targetDictionaries = {
      createTermAndDecide: vi.fn().mockResolvedValue({ dictionaryValue: { id: "88" }, decision: { mappingId: "99" } }),
    } as unknown as TargetDictionaryService;
    const server = createHttpServer({ ...dependencies(database), targetDictionaries });
    const login = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "test-admin-password" },
    });
    const sessionCookie = String(login.headers["set-cookie"]).split(";")[0];
    const csrfToken = login.json().csrfToken;
    const termPayload = {
      sourceId: "1",
      typeCode: "model",
      scope: "product.model",
      normalizedSourceValue: "pegasus trail",
      contextKey: "{}",
      targetScope: "product.model",
      entityType: "models",
      name: "Pegasus Trail",
      slug: "pegasus-trail",
    };

    const forbidden = await server.inject({
      method: "POST",
      url: "/api/targets/10/dictionary/terms",
      headers: { cookie: sessionCookie, "x-csrf-token": csrfToken },
      payload: termPayload,
    });
    const grant = await server.inject({
      method: "POST",
      url: "/api/auth/wordpress-create",
      headers: { cookie: sessionCookie, "x-csrf-token": csrfToken },
      payload: { password: "test-wordpress-password" },
    });
    const permissionCookie = String(grant.headers["set-cookie"]).split(";")[0];
    const allowed = await server.inject({
      method: "POST",
      url: "/api/targets/10/dictionary/terms",
      headers: { cookie: `${sessionCookie}; ${permissionCookie}`, "x-csrf-token": csrfToken },
      payload: termPayload,
    });

    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: "wordpress_create_permission_required" });
    expect(grant.statusCode).toBe(200);
    expect(String(grant.headers["set-cookie"])).toContain("Max-Age=600");
    expect(allowed.statusCode).toBe(201);
    expect(targetDictionaries.createTermAndDecide).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "10", slug: "pegasus-trail" }),
      "admin",
    );
    await server.close();
  });
});
