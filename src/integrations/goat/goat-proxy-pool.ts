import { AsyncLocalStorage } from "node:async_hooks";

import type { EntityId } from "../../contracts/index.js";
import { ProxyCredentialsCrypto, type ProxyCredentials, type ProxyRecord, type ProxyRepository } from "../../proxies/index.js";
import { GoatHttpClient, type GoatHttpEnvironment } from "./goat-http-client.js";

export interface GoatProxyPoolEnvironment extends GoatHttpEnvironment {
  readonly GOAT_PROXY_POOL_ENABLED?: string;
  readonly PARSER_PROXY_ENCRYPTION_KEY?: string;
}

export interface GoatProxyLease {
  readonly proxyId: EntityId;
  readonly proxyName: string;
  readonly publicProxy: { readonly id: EntityId; readonly name: string };
  client(cookieJarSuffix?: string): GoatHttpClient;
  release(success: boolean | null, latencyMs: number | null): Promise<void>;
}

export interface WorkerClaimPermit {
  run<Result>(callback: () => Promise<Result>): Promise<Result>;
  releaseUnused(): Promise<void>;
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function buildProxyUrl(record: ProxyRecord, credentials: ProxyCredentials | null): string {
  const protocol = record.protocol === "socks5" ? "socks5h" : "http";
  const auth = credentials === null ? "" : `${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@`;
  return `${protocol}://${auth}${record.host}:${record.port}`;
}

class Lease implements GoatProxyLease {
  readonly publicProxy: { readonly id: EntityId; readonly name: string };
  readonly #clients = new Map<string, GoatHttpClient>();
  readonly #startedAt = Date.now();
  #released = false;

  constructor(
    private readonly pool: GoatProxyPool,
    private readonly environment: GoatProxyPoolEnvironment,
    private readonly record: ProxyRecord,
    private readonly credentials: ProxyCredentials | null,
  ) {
    this.publicProxy = { id: record.id, name: record.name };
  }

  get proxyId(): EntityId { return this.record.id; }
  get proxyName(): string { return this.record.name; }

  client(cookieJarSuffix = ""): GoatHttpClient {
    const existing = this.#clients.get(cookieJarSuffix);
    if (existing !== undefined) return existing;
    const baseCookieJar = this.environment.GOAT_COOKIE_JAR_PATH?.trim();
    const clientEnvironment: GoatHttpEnvironment = {
      ...this.environment,
      ...(baseCookieJar === undefined || baseCookieJar === "" ? {} : { GOAT_COOKIE_JAR_PATH: `${baseCookieJar}${cookieJarSuffix}.proxy-${this.record.id}` }),
    };
    const created = new GoatHttpClient(clientEnvironment, { proxyUrl: buildProxyUrl(this.record, this.credentials) });
    this.#clients.set(cookieJarSuffix, created);
    return created;
  }

  async release(success: boolean | null, latencyMs: number | null): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    await this.pool.release(this.record.id, success, latencyMs ?? Date.now() - this.#startedAt);
  }
}

export class GoatProxyPool {
  readonly #storage = new AsyncLocalStorage<GoatProxyLease>();
  readonly #crypto: ProxyCredentialsCrypto;
  readonly #active = new Set<EntityId>();
  #roundRobin = 0;

  constructor(
    private readonly repository: ProxyRepository,
    private readonly environment: GoatProxyPoolEnvironment = process.env,
    crypto?: ProxyCredentialsCrypto,
  ) {
    this.#crypto = crypto ?? new ProxyCredentialsCrypto(environment.PARSER_PROXY_ENCRYPTION_KEY);
  }

  get enabled(): boolean {
    return isEnabled(this.environment.GOAT_PROXY_POOL_ENABLED);
  }

  currentLease(): GoatProxyLease | undefined {
    return this.#storage.getStore();
  }

  async reserveClaim(): Promise<WorkerClaimPermit | null> {
    if (!this.enabled) return { run: async (callback) => callback(), releaseUnused: async () => {} };
    const lease = await this.tryAcquire();
    if (lease === null) return null;
    let used = false;
    return {
      run: async (callback) => {
        used = true;
        let success = false;
        let latencyMs: number | null = null;
        const started = Date.now();
        try {
          const result = await this.#storage.run(lease, callback);
          success = true;
          latencyMs = Date.now() - started;
          return result;
        } finally {
          await lease.release(success, latencyMs);
        }
      },
      releaseUnused: async () => {
        if (!used) await lease.release(null, null);
      },
    };
  }

  async acquireForImage(): Promise<GoatProxyLease | null> {
    if (!this.enabled) return null;
    while (true) {
      const lease = await this.tryAcquire();
      if (lease !== null) return lease;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async tryAcquire(): Promise<GoatProxyLease | null> {
    const available = (await this.repository.listAvailable()).filter((record) => !this.#active.has(record.id));
    if (available.length === 0) return null;
    const record = available[this.#roundRobin % available.length]!;
    this.#roundRobin += 1;
    this.#active.add(record.id);
    const credentials = record.credentialsCiphertext === null ? null : this.#crypto.decrypt(record.credentialsCiphertext);
    return new Lease(this, this.environment, record, credentials);
  }

  async release(id: EntityId, success: boolean | null, latencyMs: number | null): Promise<void> {
    this.#active.delete(id);
    if (success !== null) await this.repository.recordUse(id, { success, latencyMs });
  }
}
