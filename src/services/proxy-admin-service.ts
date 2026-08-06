import type { EntityId } from "../contracts/index.js";
import { PermanentError } from "../core/errors/index.js";
import { ProxyCredentialsCrypto, type ProxyCredentials, type ProxyProtocol, type ProxyPublicDTO, type ProxyRecord, type ProxyRepository, type ProxyTestResult } from "../proxies/index.js";

export interface ProxyCommand {
  readonly name?: unknown;
  readonly protocol?: unknown;
  readonly host?: unknown;
  readonly port?: unknown;
  readonly username?: unknown;
  readonly password?: unknown;
}

export interface ProxyTester {
  test(record: ProxyRecord, credentials: ProxyCredentials | null): Promise<ProxyTestResult>;
}

export function publicProxy(record: ProxyRecord): ProxyPublicDTO {
  return {
    id: record.id,
    name: record.name,
    protocol: record.protocol,
    host: record.host,
    port: record.port,
    address: `${record.host}:${record.port}`,
    hasCredentials: record.credentialsCiphertext !== null,
    enabled: record.enabled,
    healthStatus: record.healthStatus,
    lastTestedAt: record.lastTestedAt,
    lastTestLatencyMs: record.lastTestLatencyMs,
    lastTestError: record.lastTestError,
    lastUsedAt: record.lastUsedAt,
    successCount: record.successCount,
    failureCount: record.failureCount,
  };
}

function validateName(value: unknown): string {
  if (typeof value !== "string") throw new PermanentError("Proxy name is required", { code: "INVALID_PROXY_INPUT" });
  const name = value.trim();
  if (name.length < 1 || name.length > 80) throw new PermanentError("Proxy name must be 1-80 characters", { code: "INVALID_PROXY_INPUT" });
  return name;
}

function validateProtocol(value: unknown): ProxyProtocol {
  if (value !== "http" && value !== "socks5") throw new PermanentError("Proxy protocol must be http or socks5", { code: "INVALID_PROXY_INPUT" });
  return value;
}

export function validateProxyHost(value: unknown): string {
  if (typeof value !== "string") throw new PermanentError("Proxy host is required", { code: "INVALID_PROXY_INPUT" });
  const host = value.trim();
  if (host.length < 1 || host.length > 255) throw new PermanentError("Proxy host must be 1-255 characters", { code: "INVALID_PROXY_INPUT" });
  if (/[:/?#@\\\s]/u.test(host)) throw new PermanentError("Proxy host must not contain protocol, port, path, query or credentials", { code: "INVALID_PROXY_INPUT" });
  if (!/^[a-z0-9.-]+$/iu.test(host)) throw new PermanentError("Proxy host contains unsupported characters", { code: "INVALID_PROXY_INPUT" });
  return host;
}

function validatePort(value: unknown): number {
  const port = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new PermanentError("Proxy port must be an integer from 1 to 65535", { code: "INVALID_PROXY_INPUT" });
  return port;
}

function credentials(command: ProxyCommand, crypto: ProxyCredentialsCrypto): { readonly ciphertext?: string } {
  const username = typeof command.username === "string" ? command.username.trim() : "";
  const password = typeof command.password === "string" ? command.password : "";
  if (username === "" && password === "") return {};
  if (username === "" || password === "") throw new PermanentError("Proxy username and password must be provided together", { code: "INVALID_PROXY_INPUT" });
  if (username.length > 256 || password.length > 512) throw new PermanentError("Proxy credentials are too long", { code: "INVALID_PROXY_INPUT" });
  return { ciphertext: crypto.encrypt({ username, password }) };
}

export class ProxyAdminService {
  constructor(
    private readonly repository: ProxyRepository,
    private readonly crypto: ProxyCredentialsCrypto,
    private readonly tester: ProxyTester,
  ) {}

  async list(): Promise<readonly ProxyPublicDTO[]> {
    return (await this.repository.list()).map(publicProxy);
  }

  async get(id: EntityId): Promise<ProxyPublicDTO> {
    const record = await this.repository.getById(id);
    if (record === null) throw new PermanentError("Proxy was not found", { code: "PROXY_NOT_FOUND" });
    return publicProxy(record);
  }

  async create(command: ProxyCommand, actor: string): Promise<ProxyPublicDTO> {
    const secret = credentials(command, this.crypto);
    const record = await this.repository.create({
      name: validateName(command.name),
      protocol: validateProtocol(command.protocol),
      host: validateProxyHost(command.host),
      port: validatePort(command.port),
      ...(secret.ciphertext === undefined ? {} : { credentialsCiphertext: secret.ciphertext }),
      enabled: false,
    });
    await this.repository.audit({ proxyId: record.id, action: "create", actor, payload: { name: record.name, protocol: record.protocol, host: record.host, port: record.port, hasCredentials: record.credentialsCiphertext !== null } });
    return publicProxy(record);
  }

  async update(id: EntityId, command: ProxyCommand, actor: string): Promise<ProxyPublicDTO> {
    const previous = await this.repository.getById(id);
    if (previous === null) throw new PermanentError("Proxy was not found", { code: "PROXY_NOT_FOUND" });
    const secret = credentials(command, this.crypto);
    const record = await this.repository.update(id, {
      ...(command.name === undefined ? {} : { name: validateName(command.name) }),
      ...(command.protocol === undefined ? {} : { protocol: validateProtocol(command.protocol) }),
      ...(command.host === undefined ? {} : { host: validateProxyHost(command.host) }),
      ...(command.port === undefined ? {} : { port: validatePort(command.port) }),
      ...(secret.ciphertext === undefined ? {} : { credentialsCiphertext: secret.ciphertext }),
    });
    await this.repository.audit({ proxyId: id, action: "update", actor, payload: { name: record.name, protocol: record.protocol, host: record.host, port: record.port, hasCredentials: record.credentialsCiphertext !== null } });
    return publicProxy(record);
  }

  async test(id: EntityId, actor: string): Promise<ProxyPublicDTO> {
    const record = await this.repository.getById(id);
    if (record === null) throw new PermanentError("Proxy was not found", { code: "PROXY_NOT_FOUND" });
    const decrypted = record.credentialsCiphertext === null ? null : this.crypto.decrypt(record.credentialsCiphertext);
    const result = await this.tester.test(record, decrypted);
    const updated = await this.repository.recordTest(id, result);
    await this.repository.audit({ proxyId: id, action: "test", actor, payload: { healthy: result.healthy, latencyMs: result.latencyMs, error: result.error } });
    return publicProxy(updated);
  }

  async enable(id: EntityId, actor: string): Promise<ProxyPublicDTO> {
    const record = await this.repository.getById(id);
    if (record === null) throw new PermanentError("Proxy was not found", { code: "PROXY_NOT_FOUND" });
    if (record.healthStatus !== "healthy") throw new PermanentError("Proxy must pass test before enabling", { code: "PROXY_NOT_HEALTHY" });
    const updated = await this.repository.setEnabled(id, true);
    await this.repository.audit({ proxyId: id, action: "enable", actor, payload: { enabled: true } });
    return publicProxy(updated);
  }

  async disable(id: EntityId, actor: string): Promise<ProxyPublicDTO> {
    const updated = await this.repository.setEnabled(id, false);
    await this.repository.audit({ proxyId: id, action: "disable", actor, payload: { enabled: false } });
    return publicProxy(updated);
  }
}
