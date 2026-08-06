import { describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../../src/http/index.js";
import type { ClassifierAdminService, ProductAdminService, ProxyAdminService, TargetDictionaryService } from "../../src/services/index.js";

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

  it("lists classifier configuration with admin auth and server pagination", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const classifier = {
      listConfiguration: vi.fn().mockResolvedValue({ items: [], total: 0, sources: [], targets: [], types: [] }),
    } as unknown as ClassifierAdminService;
    const server = createHttpServer({ ...dependencies(database), classifier });

    const response = await server.inject({
      method: "GET",
      url: "/api/classifier/configuration?kind=rule&status=active&limit=25&offset=50",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(classifier.listConfiguration).toHaveBeenCalledWith(expect.objectContaining({
      kind: "rule",
      status: "active",
      limit: 25,
      offset: 50,
    }));
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

  it("serves the proxy interface", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const server = createHttpServer(dependencies(database));

    const response = await server.inject({ method: "GET", url: "/proxies" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("SLDS · Прокси");
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

  it("serves read-only product, operation and snapshot registries", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const productAdmin = {
      listProducts: vi.fn().mockResolvedValue({ items: [], total: 0, sources: [] }),
      listOperations: vi.fn().mockReturnValue([{ code: "normalize", name: "Нормализация", version: "1", dependsOn: [], sourceCodes: null }]),
      listSnapshots: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    } as unknown as ProductAdminService;
    const server = createHttpServer({ ...dependencies(database), productAdmin });
    const headers = { authorization: `Bearer ${adminToken}` };

    const products = await server.inject({ method: "GET", url: "/api/products?limit=25&offset=0", headers });
    const operations = await server.inject({ method: "GET", url: "/api/operations", headers });
    const snapshots = await server.inject({ method: "GET", url: "/api/wordpress-snapshots?search=2916861", headers });

    expect(products.statusCode).toBe(200);
    expect(operations.json().items[0].code).toBe("normalize");
    expect(snapshots.statusCode).toBe(200);
    expect(productAdmin.listProducts).toHaveBeenCalledWith(expect.objectContaining({ limit: 25, offset: 0 }));
    expect(productAdmin.listSnapshots).toHaveBeenCalledWith(expect.objectContaining({ search: "2916861" }));
    await server.close();
  });

  it("delegates WordPress preview to the read-only preview service", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const wordpressPreview = { preview: vi.fn().mockResolvedValue({ externalId: "2916861", diff: {} }) };
    const server = createHttpServer({ ...dependencies(database), wordpressPreview: wordpressPreview as never });
    const response = await server.inject({ method: "GET", url: "/api/products/3/wordpress-preview?targetId=10", headers: { authorization: `Bearer ${adminToken}` } });

    expect(response.statusCode).toBe(200);
    expect(wordpressPreview.preview).toHaveBeenCalledWith("3", "10");
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

  it("protects projection mutations with CSRF and never calls WordPress write services", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const classifier = {
      previewTargetProjection: vi.fn().mockResolvedValue({ observationCount: 18, productCount: 18, affectedSourceProductIds: ["1"], examples: [], duplicate: null, cardinalityConflicts: [] }),
      createTargetProjection: vi.fn().mockResolvedValue({ projection: { id: "1" }, affectedProductCount: 1 }),
    } as unknown as ClassifierAdminService;
    const targetDictionaries = { createTermAndDecide: vi.fn() } as unknown as TargetDictionaryService;
    const server = createHttpServer({ ...dependencies(database), classifier, targetDictionaries });
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-admin-password" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const payload = { targetId: "10", resolutionKind: "mapping", resolutionId: "99", targetScope: "product.tag", dictionaryValueId: "88" };

    const forbidden = await server.inject({ method: "POST", url: "/api/classifier/projections", headers: { cookie }, payload });
    const preview = await server.inject({ method: "POST", url: "/api/classifier/projections/preview", headers: { cookie, "x-csrf-token": login.json().csrfToken }, payload });
    const created = await server.inject({ method: "POST", url: "/api/classifier/projections", headers: { cookie, "x-csrf-token": login.json().csrfToken }, payload });

    expect(forbidden.statusCode).toBe(403);
    expect(preview.statusCode).toBe(200);
    expect(created.statusCode).toBe(201);
    expect(classifier.previewTargetProjection).toHaveBeenCalledWith(payload);
    expect(classifier.createTargetProjection).toHaveBeenCalledWith(payload, "admin");
    expect(targetDictionaries.createTermAndDecide).not.toHaveBeenCalled();
    await server.close();
  });

  it("protects classifier rule activation with CSRF", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const classifier = {
      setRuleEnabled: vi.fn().mockResolvedValue({ revision: "2", affectedProductCount: 3 }),
    } as unknown as ClassifierAdminService;
    const server = createHttpServer({ ...dependencies(database), classifier });
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-admin-password" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];

    const forbidden = await server.inject({ method: "POST", url: "/api/classifier/rules/10/deactivate", headers: { cookie }, payload: {} });
    const allowed = await server.inject({ method: "POST", url: "/api/classifier/rules/10/deactivate", headers: { cookie, "x-csrf-token": login.json().csrfToken }, payload: {} });

    expect(forbidden.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(classifier.setRuleEnabled).toHaveBeenCalledWith("10", false, "admin", undefined);
    await server.close();
  });

  it("protects proxy management with admin auth and CSRF without exposing credentials", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const proxies = {
      list: vi.fn().mockResolvedValue([{ id: "1", name: "main", protocol: "http", address: "proxy.test:8080", host: "proxy.test", port: 8080, hasCredentials: true, enabled: false, healthStatus: "healthy", lastTestedAt: null, lastTestLatencyMs: null, lastTestError: null, lastUsedAt: null, successCount: "0", failureCount: "0" }]),
      create: vi.fn().mockResolvedValue({ id: "1", name: "main", hasCredentials: true }),
    } as unknown as ProxyAdminService;
    const server = createHttpServer({ ...dependencies(database), proxies });

    const unauthorized = await server.inject({ method: "GET", url: "/api/proxies" });
    const authorized = await server.inject({ method: "GET", url: "/api/proxies", headers: { authorization: `Bearer ${adminToken}` } });
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-admin-password" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const forbidden = await server.inject({ method: "POST", url: "/api/proxies", headers: { cookie }, payload: { name: "main", protocol: "http", host: "proxy.test", port: 8080, username: "u", password: "secret" } });
    const created = await server.inject({ method: "POST", url: "/api/proxies", headers: { cookie, "x-csrf-token": login.json().csrfToken }, payload: { name: "main", protocol: "http", host: "proxy.test", port: 8080, username: "u", password: "secret" } });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.body).not.toContain("secret");
    expect(authorized.body).not.toContain("ciphertext");
    expect(forbidden.statusCode).toBe(403);
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain("secret");
    expect(proxies.create).toHaveBeenCalledWith(expect.objectContaining({ password: "secret" }), "admin");
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
