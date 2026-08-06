import { describe, expect, it, vi } from "vitest";

import { Worker, type JobHandler } from "../../src/application/index.js";
import { GoatImageDownloader, GoatProxyPool, GoatSourceAdapter, sanitizeCurlError } from "../../src/integrations/index.js";
import { PostgresGoatProxyRepository } from "../../src/infrastructure/db/index.js";
import { ProxyCredentialsCrypto, type ProxyRecord, type ProxyRepository, type ProxyTestResult } from "../../src/proxies/index.js";
import { ProxyAdminService, type ProxyTester } from "../../src/services/index.js";
import { MemoryJobRepository, MemoryStore, sourceRecord } from "../support/in-memory.js";

const key = Buffer.alloc(32, 7).toString("base64");
const timestamp = "2026-01-01T00:00:00.000Z";

function proxy(overrides: Partial<ProxyRecord> = {}): ProxyRecord {
  return {
    id: "1",
    name: "one",
    protocol: "http",
    host: "proxy-one.test",
    port: 8080,
    credentialsCiphertext: null,
    enabled: true,
    healthStatus: "healthy",
    lastTestedAt: null,
    lastTestLatencyMs: null,
    lastTestError: null,
    lastUsedAt: null,
    successCount: "0",
    failureCount: "0",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

class MemoryProxyRepository implements ProxyRepository {
  readonly records = new Map<string, ProxyRecord>();
  readonly audits: unknown[] = [];
  readonly useRecords: { id: string; success: boolean }[] = [];
  id = 0;
  constructor(records: readonly ProxyRecord[] = []) {
    for (const record of records) this.records.set(record.id, record);
  }
  async list() { return [...this.records.values()].sort((a, b) => Number(a.id) - Number(b.id)); }
  async listAvailable() { return (await this.list()).filter((record) => record.enabled && record.healthStatus === "healthy"); }
  async getById(id: string) { return this.records.get(id) ?? null; }
  async findByName(name: string) { return [...this.records.values()].find((record) => record.name === name) ?? null; }
  async create(input: Parameters<ProxyRepository["create"]>[0]) {
    const record = proxy({ id: String(++this.id), ...input, credentialsCiphertext: input.credentialsCiphertext ?? null, healthStatus: "untested", enabled: input.enabled });
    this.records.set(record.id, record);
    return record;
  }
  async update(id: string, input: Parameters<ProxyRepository["update"]>[1]) {
    const current = this.records.get(id)!;
    const changed = input.protocol !== undefined || input.host !== undefined || input.port !== undefined || Object.prototype.hasOwnProperty.call(input, "credentialsCiphertext");
    const record = { ...current, ...input, ...(changed ? { enabled: false, healthStatus: "untested" as const, lastTestedAt: null, lastTestLatencyMs: null, lastTestError: null } : {}) };
    this.records.set(id, record);
    return record;
  }
  async setEnabled(id: string, enabled: boolean) { const record = { ...this.records.get(id)!, enabled }; this.records.set(id, record); return record; }
  async recordTest(id: string, result: ProxyTestResult) { const record = { ...this.records.get(id)!, healthStatus: result.healthy ? "healthy" as const : "unhealthy" as const, lastTestLatencyMs: result.latencyMs, lastTestError: result.error, lastTestedAt: timestamp }; this.records.set(id, record); return record; }
  async recordUse(id: string, input: { success: boolean; latencyMs: number | null }) { this.useRecords.push({ id, success: input.success }); }
  async audit(input: Parameters<ProxyRepository["audit"]>[0]) { this.audits.push(input); }
}

describe("proxy credentials and admin service", () => {
  it("sanitizes proxy credentials in curl errors", () => {
    expect(sanitizeCurlError("failed http://user:secret@proxy.test and secret", ["secret"])).toBe("failed http://***:***@proxy.test and ***");
  });

  it("encrypts credentials and never exposes them in public DTO", async () => {
    const crypto = new ProxyCredentialsCrypto(key);
    const repository = new MemoryProxyRepository();
    const tester: ProxyTester = { test: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 10, error: null }) };
    const service = new ProxyAdminService(repository, crypto, tester);

    const created = await service.create({ name: "main", protocol: "http", host: "proxy.test", port: 8080, username: "user", password: "secret" }, "admin");
    const stored = [...repository.records.values()][0]!;

    expect(created).toMatchObject({ name: "main", address: "proxy.test:8080", hasCredentials: true, enabled: false });
    expect(JSON.stringify(created)).not.toContain("secret");
    expect(stored.credentialsCiphertext).not.toContain("secret");
    expect(crypto.decrypt(stored.credentialsCiphertext!)).toEqual({ username: "user", password: "secret" });
  });

  it("keeps an existing password when edit fields are empty and requires a successful test before enabling", async () => {
    const crypto = new ProxyCredentialsCrypto(key);
    const repository = new MemoryProxyRepository([proxy({ id: "7", enabled: false, healthStatus: "untested", credentialsCiphertext: crypto.encrypt({ username: "u", password: "p" }) })]);
    const service = new ProxyAdminService(repository, crypto, { test: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 20, error: null }) });

    await expect(service.enable("7", "admin")).rejects.toThrow("Proxy must pass test");
    await service.update("7", { name: "renamed", username: "", password: "" }, "admin");
    expect(crypto.decrypt(repository.records.get("7")!.credentialsCiphertext!)).toEqual({ username: "u", password: "p" });
    await service.test("7", "admin");
    const enabled = await service.enable("7", "admin");

    expect(enabled.enabled).toBe(true);
    expect(JSON.stringify(repository.audits)).not.toContain("password");
  });

  it("stores an unsuccessful proxy test result without enabling the proxy", async () => {
    const repository = new MemoryProxyRepository([proxy({ id: "9", enabled: false, healthStatus: "untested" })]);
    const service = new ProxyAdminService(repository, new ProxyCredentialsCrypto(key), { test: vi.fn().mockResolvedValue({ healthy: false, latencyMs: 15, error: "curl failed" }) });

    const tested = await service.test("9", "admin");

    expect(tested).toMatchObject({ enabled: false, healthStatus: "unhealthy", lastTestError: "curl failed" });
    await expect(service.enable("9", "admin")).rejects.toThrow("Proxy must pass test");
  });
});

describe("GoatProxyPool", () => {
  it("uses deterministic round-robin and does not exceed available sessions", async () => {
    const repository = new MemoryProxyRepository([proxy({ id: "1", name: "one" }), proxy({ id: "2", name: "two" })]);
    const pool = new GoatProxyPool(repository, { GOAT_PROXY_POOL_ENABLED: "true", PARSER_PROXY_ENCRYPTION_KEY: key, GOAT_CLI_CURL_BIN: "curl", GOAT_COOKIE_JAR_PATH: "/tmp/goat.jar" });

    const first = await pool.tryAcquire();
    const second = await pool.tryAcquire();
    const third = await pool.tryAcquire();

    expect(first?.proxyId).toBe("1");
    expect(second?.proxyId).toBe("2");
    expect(third).toBeNull();
    await first?.release(true, 11);
    await second?.release(false, 12);
    expect(repository.useRecords).toEqual([{ id: "1", success: true }, { id: "2", success: false }]);
  });

  it("excludes disabled proxies from new leases and allows a retry to use another proxy", async () => {
    const repository = new MemoryProxyRepository([proxy({ id: "1", enabled: false }), proxy({ id: "2", name: "two" }), proxy({ id: "3", name: "three" })]);
    const pool = new GoatProxyPool(repository, { GOAT_PROXY_POOL_ENABLED: "true", PARSER_PROXY_ENCRYPTION_KEY: key, GOAT_CLI_CURL_BIN: "curl", GOAT_COOKIE_JAR_PATH: "/tmp/goat.jar" });

    const firstAttempt = await pool.tryAcquire();
    await firstAttempt?.release(false, 1);
    const retryAttempt = await pool.tryAcquire();

    expect(firstAttempt?.proxyId).toBe("2");
    expect(retryAttempt?.proxyId).toBe("3");
    await retryAttempt?.release(true, 1);
  });

  it("releases an unused claim permit without recording a proxy failure", async () => {
    const repository = new MemoryProxyRepository([proxy({ id: "1" })]);
    const pool = new GoatProxyPool(repository, { GOAT_PROXY_POOL_ENABLED: "true", PARSER_PROXY_ENCRYPTION_KEY: key, GOAT_CLI_CURL_BIN: "curl", GOAT_COOKIE_JAR_PATH: "/tmp/goat.jar" });
    const permit = await pool.reserveClaim();

    await permit?.releaseUnused();

    expect(repository.useRecords).toEqual([]);
    expect(await pool.tryAcquire()).not.toBeNull();
  });
});

describe("GOAT pool integration", () => {
  it("keeps one proxy attached to product and offers within a collect attempt", async () => {
    const repository = new MemoryProxyRepository([proxy({ id: "4", name: "leased" })]);
    const pool = new GoatProxyPool(repository, { GOAT_PROXY_POOL_ENABLED: "true", PARSER_PROXY_ENCRYPTION_KEY: key, GOAT_CLI_CURL_BIN: "curl", GOAT_COOKIE_JAR_PATH: "/tmp/goat.jar" });
    const adapter = new GoatSourceAdapter(undefined, async (_url, expected) => expected === "product" ? { id: "100", name: "Shoe", images: [] } : [], process.env, pool);
    const permit = await pool.reserveClaim();

    const collected = await permit!.run(() => adapter.collectProduct({
      source: { id: "1", code: "goat", config: { sitemapUrl: "https://fixture", countryCode: "US", discoveryBatchSize: 1, requestDelayMs: 0 } },
      product: { sourceKey: "shoe", metadata: {} },
    }));

    expect(collected.parts.map((part) => (part.parsedPayload as { _transport?: { proxy: { id: string } } })._transport?.proxy.id)).toEqual(["4", "4"]);
  });

  it("image downloader keeps the global concurrency limit while using pool leases", async () => {
    const repository = new MemoryProxyRepository([proxy({ id: "1" }), proxy({ id: "2" })]);
    const pool = new GoatProxyPool(repository, { GOAT_PROXY_POOL_ENABLED: "true", PARSER_PROXY_ENCRYPTION_KEY: key, GOAT_CLI_CURL_BIN: "curl", GOAT_COOKIE_JAR_PATH: "/tmp/goat.jar" });
    const clients: string[] = [];
    let active = 0;
    let maxActive = 0;
    const releases: (() => void)[] = [];
    vi.spyOn(pool, "tryAcquire");
    const downloader = new GoatImageDownloader({ GOAT_COOKIE_JAR_PATH: "/tmp/goat.jar" }, { concurrency: 2 }, (environment) => ({
      getBuffer: vi.fn(async () => {
        clients.push(environment.GOAT_COOKIE_JAR_PATH ?? "");
        active += 1; maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return Buffer.from("ok");
      }),
    }), pool, (lease, suffix) => ({
      getBuffer: vi.fn(async () => {
        clients.push(`${suffix}.proxy-${lease.proxyId}`);
        active += 1; maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return Buffer.from("ok");
      }),
    }));

    const downloads = ["a", "b", "c"].map((url) => downloader.download(url, { source: sourceRecord(), sourceProduct: { id: "1", sourceId: "1", sourceKey: "x", metadata: {} } }));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()!(); releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()!();
    await Promise.all(downloads);

    expect(maxActive).toBe(2);
    expect(repository.useRecords.filter((item) => item.success)).toHaveLength(3);
    expect(clients.every((jar) => jar.includes(".images-") && jar.includes(".proxy-"))).toBe(true);
  });
});

describe("worker collection claim guard", () => {
  it("does not claim collection jobs when no proxy permit is available", async () => {
    const store = new MemoryStore();
    const jobs = new MemoryJobRepository(store);
    const job = await jobs.enqueue({ jobType: "collect_product", payload: { sourceProductId: "1" }, uniqueKey: "collect-1" });
    const handler: JobHandler = { dispatch: vi.fn(), handleTerminalFailure: vi.fn() };
    const worker = new Worker(jobs, handler, { workerId: "w", pollIntervalMs: 1, lockTimeoutMs: 100, maxJobAttempts: 3, retryBaseMs: 1, retryMaxMs: 10 }, async () => {}, Date.now, console.error, async () => null);

    const processed = await worker.processNext(["collect_product"], "w:collection-1");

    expect(processed).toBe(false);
    expect(store.jobs.get(job.id)).toMatchObject({ status: "pending", attempts: 0 });
    expect(handler.dispatch).not.toHaveBeenCalled();
  });
});

describe("PostgresGoatProxyRepository", () => {
  it("queries only enabled healthy proxies for leases and writes audit payload as jsonb", async () => {
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const executor = { query: vi.fn(async (text: string, values?: readonly unknown[]) => { calls.push({ text, ...(values === undefined ? {} : { values }) }); return { rows: [], rowCount: 0 }; }) };
    const repository = new PostgresGoatProxyRepository(executor);

    await repository.listAvailable();
    await repository.audit({ proxyId: "1", action: "test", actor: "admin", payload: { healthy: true } });

    expect(calls[0]?.text).toContain("enabled = TRUE AND health_status = 'healthy'");
    expect(calls[1]?.text).toContain("goat_proxy_audit");
    expect(calls[1]?.values?.[3]).toBe("{\"healthy\":true}");
  });
});
