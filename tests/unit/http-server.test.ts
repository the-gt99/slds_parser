import { describe, expect, it, vi } from "vitest";
import { IntegrationContractError } from "../../src/core/errors/index.js";
import { createHttpServer } from "../../src/http/index.js";
import type { ClassifierAdminService, ContentTemplateAdminService, ProductAdminService, ProxyAdminService, RuntimeAdminService, TargetDictionaryService } from "../../src/services/index.js";

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
    const classifier = {
      listReviewQueue: vi.fn().mockResolvedValue([]),
      countReviewQueue: vi.fn().mockResolvedValue(321),
      listReviewExamples: vi.fn().mockResolvedValue([]),
    } as unknown as ClassifierAdminService;
    const server = createHttpServer({
      ...dependencies(database),
      classifier,
    });

    const unauthorized = await server.inject({ method: "GET", url: "/api/classifier/queue" });
    const authorized = await server.inject({
      method: "GET",
      url: "/api/classifier/queue?sourceId=1&typeCode=category&status=unresolved&search=sneakers&contextKey=context-women",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const waiting = await server.inject({
      method: "GET",
      url: "/api/classifier/queue?status=waiting_apply",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const examples = await server.inject({
      method: "GET",
      url: "/api/classifier/queue/42/examples",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(waiting.statusCode).toBe(200);
    expect(examples.statusCode).toBe(200);
    expect(authorized.json()).toEqual({ items: [], total: 321 });
    expect(classifier.listReviewQueue).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "1",
      typeCode: "category",
      status: "unresolved",
      search: "sneakers",
      contextKey: "context-women",
    }));
    expect(classifier.listReviewQueue).toHaveBeenCalledWith(expect.objectContaining({ status: "waiting_apply" }));
    expect(classifier.countReviewQueue).toHaveBeenCalledWith(expect.objectContaining({ status: "waiting_apply" }));
    expect(classifier.listReviewExamples).toHaveBeenCalledWith("42");
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
      url: "/api/classifier/configuration?kind=rule&configId=8&referenceValueId=42&status=active&limit=25&offset=50",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(classifier.listConfiguration).toHaveBeenCalledWith(expect.objectContaining({
      kind: "rule",
      configId: "8",
      referenceValueId: "42",
      status: "active",
      includeUsage: true,
      limit: 25,
      offset: 50,
    }));
    expect(response.json()).toEqual({ items: [], total: 0, sources: [], targets: [], types: [], usageIncluded: true });
    await server.close();
  });

  it("can omit expensive classifier configuration usage statistics", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const classifier = {
      listConfiguration: vi.fn().mockResolvedValue({ items: [], total: 0, sources: [], targets: [], types: [] }),
    } as unknown as ClassifierAdminService;
    const server = createHttpServer({ ...dependencies(database), classifier });

    const response = await server.inject({
      method: "GET",
      url: "/api/classifier/configuration?kind=mapping&usage=none",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(classifier.listConfiguration).toHaveBeenCalledWith(expect.objectContaining({
      kind: "mapping",
      includeUsage: false,
    }));
    expect(response.json()).toEqual({ items: [], total: 0, sources: [], targets: [], types: [], usageIncluded: false });
    await server.close();
  });

  it("serves rule fields and audited configuration history", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const classifier = {
      listRuleConditionFields: vi.fn().mockResolvedValue([{ field: "context.brand", exampleValues: ["Nike"] }]),
      listConfigurationHistory: vi.fn().mockResolvedValue([{ id: "1", action: "update" }]),
    } as unknown as ClassifierAdminService;
    const server = createHttpServer({ ...dependencies(database), classifier });
    const headers = { authorization: `Bearer ${adminToken}` };

    const fields = await server.inject({ method: "GET", url: "/api/classifier/rule-fields?sourceId=1&typeCode=model", headers });
    const history = await server.inject({ method: "GET", url: "/api/classifier/configuration/mapping/12/history", headers });

    expect(fields.statusCode).toBe(200);
    expect(history.statusCode).toBe(200);
    expect(classifier.listRuleConditionFields).toHaveBeenCalledWith("1", "model");
    expect(classifier.listConfigurationHistory).toHaveBeenCalledWith("mapping", "12");
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
    expect(response.body).toContain("SLDS · Классификация");
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

  it("serves and protects the content template workflow", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const template = {
      id: "22", targetId: "10", field: "description", name: "Описание", templateSource: "<p>{{ product.sku }}</p>",
      status: "draft", revision: 1, actor: "admin", createdAt: "2026-08-09T00:00:00.000Z", activatedAt: null,
    };
    const contentTemplates = {
      catalog: vi.fn().mockReturnValue({ variables: [], helpers: [], defaults: {} }),
      list: vi.fn().mockResolvedValue([template]),
      preview: vi.fn().mockResolvedValue({ proposed: { fields: { description_html: "<p>SKU</p>" } } }),
      createDraft: vi.fn().mockResolvedValue(template),
      activate: vi.fn().mockResolvedValue({ ...template, status: "active" }),
    } as unknown as ContentTemplateAdminService;
    const server = createHttpServer({ ...dependencies(database), contentTemplates });
    const page = await server.inject({ method: "GET", url: "/content-templates" });
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-admin-password" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const headers = { cookie, "x-csrf-token": login.json().csrfToken };
    const catalog = await server.inject({ method: "GET", url: "/api/content-templates/catalog", headers: { cookie } });
    const preview = await server.inject({ method: "POST", url: "/api/content-templates/preview", headers: { cookie }, payload: { targetId: "10", sourceProductId: "76399", field: "description", name: "Описание", templateSource: "<p>{{ product.sku }}</p>" } });
    const forbidden = await server.inject({ method: "POST", url: "/api/content-templates/drafts", headers: { cookie }, payload: { targetId: "10", field: "description", name: "Описание", templateSource: "<p>{{ product.sku }}</p>" } });
    const saved = await server.inject({ method: "POST", url: "/api/content-templates/drafts", headers, payload: { targetId: "10", field: "description", name: "Описание", templateSource: "<p>{{ product.sku }}</p>" } });
    const activated = await server.inject({ method: "POST", url: "/api/targets/10/content-templates/22/activate", headers, payload: {} });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("SLDS · Шаблоны контента");
    expect(catalog.statusCode).toBe(200);
    expect(preview.statusCode).toBe(200);
    expect(forbidden.statusCode).toBe(403);
    expect(saved.statusCode).toBe(201);
    expect(activated.statusCode).toBe(200);
    expect(contentTemplates.preview).toHaveBeenCalledWith(expect.objectContaining({ sourceProductId: "76399", field: "description" }));
    expect(contentTemplates.activate).toHaveBeenCalledWith("10", "22", "admin");
    await server.close();
  });

  it("serves the runtime interface and protects runtime state", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const runtime = {
      status: vi.fn().mockResolvedValue({
        worker: { serviceName: "slds-parser-worker.service", active: false, state: "inactive", subState: "dead", mainPid: null },
        queue: [],
        logs: [],
      }),
      start: vi.fn().mockResolvedValue({ serviceName: "slds-parser-worker.service", active: true }),
    } as unknown as RuntimeAdminService;
    const server = createHttpServer({ ...dependencies(database), runtime });

    const page = await server.inject({ method: "GET", url: "/runtime" });
    const unauthorized = await server.inject({ method: "GET", url: "/api/runtime" });
    const authorized = await server.inject({ method: "GET", url: "/api/runtime", headers: { authorization: `Bearer ${adminToken}` } });
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-admin-password" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const forbidden = await server.inject({ method: "POST", url: "/api/runtime/start", headers: { cookie }, payload: {} });
    const started = await server.inject({ method: "POST", url: "/api/runtime/start", headers: { cookie, "x-csrf-token": login.json().csrfToken }, payload: {} });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("/runtime");
    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(forbidden.statusCode).toBe(403);
    expect(started.statusCode).toBe(200);
    expect(runtime.status).toHaveBeenCalledOnce();
    expect(runtime.start).toHaveBeenCalledOnce();
    await server.close();
  });

  it("runs only the selected processing job and protects the command with CSRF", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const runtime = {
      runProcessJob: vi.fn().mockResolvedValue({ jobId: "350520", status: "completed", error: null }),
    } as unknown as RuntimeAdminService;
    const server = createHttpServer({ ...dependencies(database), runtime });
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-admin-password" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];

    const forbidden = await server.inject({ method: "POST", url: "/api/jobs/350520/run", headers: { cookie }, payload: {} });
    const executed = await server.inject({ method: "POST", url: "/api/jobs/350520/run", headers: { cookie, "x-csrf-token": login.json().csrfToken }, payload: {} });

    expect(forbidden.statusCode).toBe(403);
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toEqual({ result: { jobId: "350520", status: "completed", error: null } });
    expect(runtime.runProcessJob).toHaveBeenCalledWith("350520");
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

  it("protects product batch preview and apply with CSRF", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const productAdmin = {
      previewBatch: vi.fn().mockResolvedValue({ selectedCount: 1, eligibleCount: 1, jobsToCreate: 1 }),
      applyBatch: vi.fn().mockResolvedValue({ auditId: "1", createdJobIds: ["10"] }),
    } as unknown as ProductAdminService;
    const server = createHttpServer({ ...dependencies(database), productAdmin });
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-admin-password" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const payload = { action: "collect", filter: { source: "goat" }, selectedIds: ["3"], limit: 100 };

    const page = await server.inject({ method: "GET", url: "/products" });
    const forbidden = await server.inject({ method: "POST", url: "/api/products/batch/preview", headers: { cookie }, payload });
    const preview = await server.inject({ method: "POST", url: "/api/products/batch/preview", headers: { cookie, "x-csrf-token": login.json().csrfToken }, payload });
    const applied = await server.inject({ method: "POST", url: "/api/products/batch/apply", headers: { cookie, "x-csrf-token": login.json().csrfToken }, payload });

    expect(page.body).toContain("Заново собрать → затем обработать");
    expect(page.body).toContain("Принудительно переобработать сохранённые данные");
    expect(page.body).toContain("Проверить действие");
    expect(forbidden.statusCode).toBe(403);
    expect(preview.statusCode).toBe(200);
    expect(applied.statusCode).toBe(200);
    expect(productAdmin.previewBatch).toHaveBeenCalledWith(expect.objectContaining({ action: "collect", filter: expect.objectContaining({ sourceCode: "goat", selectedIds: ["3"], limit: 100 }) }));
    expect(productAdmin.applyBatch).toHaveBeenCalledWith(expect.anything(), "admin");
    await server.close();
  });

  it("serves jobs dashboard and failed retry endpoints without allowing export retry", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const productAdmin = {
      listJobs: vi.fn().mockResolvedValue({ items: [], total: 0, summary: { byStatus: [], byTypeStatus: [], errorGroups: [], byJobType: [] } }),
      previewFailedJobRetry: vi.fn((type) => type === "export_product"
        ? Promise.reject(new IntegrationContractError("Export retry is disabled from this administrative action"))
        : Promise.resolve({ retryCount: 2 })),
      retryFailedJobs: vi.fn().mockResolvedValue({ retriedJobIds: ["1", "2"] }),
    } as unknown as ProductAdminService;
    const server = createHttpServer({ ...dependencies(database), productAdmin });
    const headers = { authorization: `Bearer ${adminToken}` };

    const page = await server.inject({ method: "GET", url: "/jobs" });
    const jobs = await server.inject({ method: "GET", url: "/api/jobs?jobType=process_product&status=failed", headers });
    const retry = await server.inject({ method: "POST", url: "/api/jobs/failed/preview-retry", headers, payload: { jobType: "process_product", limit: 10 } });
    const exportRetry = await server.inject({ method: "POST", url: "/api/jobs/failed/preview-retry", headers, payload: { jobType: "export_product", limit: 10 } });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('id="page-numbers"');
    expect(page.body).toContain('id="page-jump"');
    expect(page.body).toContain('Перейти');
    expect(jobs.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(exportRetry.statusCode).toBe(422);
    expect(productAdmin.listJobs).toHaveBeenCalledWith(expect.objectContaining({ jobType: "process_product", status: "failed" }));
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

  it("creates additional WordPress assignments from an internal value", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const classifier = {
      previewReferenceProjection: vi.fn().mockResolvedValue({ observationCount: 8, productCount: 7, affectedSourceProductIds: ["1"], examples: [], duplicate: null, cardinalityConflicts: [] }),
      createReferenceProjection: vi.fn().mockResolvedValue({ projection: { id: "2" }, affectedProductCount: 7 }),
    } as unknown as ClassifierAdminService;
    const server = createHttpServer({ ...dependencies(database), classifier });
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-admin-password" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const headers = { cookie, "x-csrf-token": login.json().csrfToken };
    const payload = { targetId: "10", referenceValueId: "42", targetScope: "product.tag", dictionaryValueId: "88" };

    const preview = await server.inject({ method: "POST", url: "/api/classifier/reference-projections/preview", headers, payload });
    const created = await server.inject({ method: "POST", url: "/api/classifier/reference-projections", headers, payload });

    expect(preview.statusCode).toBe(200);
    expect(created.statusCode).toBe(201);
    expect(classifier.previewReferenceProjection).toHaveBeenCalledWith(payload);
    expect(classifier.createReferenceProjection).toHaveBeenCalledWith(payload, "admin");
    await server.close();
  });

  it("creates a primary WordPress assignment from an internal value", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const classifier = {
      createTargetValueMapping: vi.fn().mockResolvedValue({ mapping: { id: "3" }, affectedProductCount: 7 }),
    } as unknown as ClassifierAdminService;
    const server = createHttpServer({ ...dependencies(database), classifier });
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-admin-password" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const headers = { cookie, "x-csrf-token": login.json().csrfToken };
    const payload = { targetId: "10", referenceValueId: "42", typeCode: "brand", targetScope: "attribute.pa_brand", dictionaryValueId: "88" };

    const created = await server.inject({ method: "POST", url: "/api/classifier/target-mappings", headers, payload });

    expect(created.statusCode).toBe(201);
    expect(classifier.createTargetValueMapping).toHaveBeenCalledWith(payload, "admin");
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

  it("deletes a classifier rule through the audited admin endpoint", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const classifier = {
      deleteRule: vi.fn().mockResolvedValue({ revision: "3", affectedProductCount: 12 }),
    } as unknown as ClassifierAdminService;
    const server = createHttpServer({ ...dependencies(database), classifier });
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-admin-password" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];

    const forbidden = await server.inject({ method: "DELETE", url: "/api/classifier/rules/10", headers: { cookie }, payload: {} });
    const allowed = await server.inject({ method: "DELETE", url: "/api/classifier/rules/10", headers: { cookie, "x-csrf-token": login.json().csrfToken }, payload: {} });

    expect(forbidden.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(classifier.deleteRule).toHaveBeenCalledWith("10", "admin", undefined);
    await server.close();
  });

  it("accepts a classifier rule whose result is selected directly in WordPress", async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const classifier = {
      previewRule: vi.fn().mockResolvedValue({ matchedProducts: 1, affectedProducts: 1, ambiguousObservations: 0, shadowedObservations: 0, examples: [] }),
      createRule: vi.fn().mockResolvedValue({ ruleId: "22", referenceValueId: "23", revision: "1", affectedProductCount: 1 }),
    } as unknown as ClassifierAdminService;
    const server = createHttpServer({ ...dependencies(database), classifier });
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-admin-password" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const headers = { cookie, "x-csrf-token": login.json().csrfToken };
    const payload = {
      sourceId: "1", typeCode: "category", name: "Женские кроссовки", priority: 100,
      conditions: [{ field: "context.audience", operator: "equals", value: "women" }],
      targetLink: { targetId: "10", targetScope: "product.category", dictionaryValueId: "88" },
    };

    const preview = await server.inject({ method: "POST", url: "/api/classifier/rules/preview", headers, payload });
    const created = await server.inject({ method: "POST", url: "/api/classifier/rules", headers, payload });

    expect(preview.statusCode).toBe(200);
    expect(created.statusCode).toBe(201);
    expect(classifier.previewRule).toHaveBeenCalledWith(payload);
    expect(classifier.createRule).toHaveBeenCalledWith(payload, "admin");
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
