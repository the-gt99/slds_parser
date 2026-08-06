import type { EntityId } from "../contracts/index.js";

export type ProxyProtocol = "http" | "socks5";
export type ProxyHealthStatus = "untested" | "healthy" | "unhealthy";
export type ProxyAuditAction = "create" | "update" | "test" | "enable" | "disable";

export interface ProxyCredentials {
  readonly username: string;
  readonly password: string;
}

export interface ProxyRecord {
  readonly id: EntityId;
  readonly name: string;
  readonly protocol: ProxyProtocol;
  readonly host: string;
  readonly port: number;
  readonly credentialsCiphertext: string | null;
  readonly enabled: boolean;
  readonly healthStatus: ProxyHealthStatus;
  readonly lastTestedAt: string | null;
  readonly lastTestLatencyMs: number | null;
  readonly lastTestError: string | null;
  readonly lastUsedAt: string | null;
  readonly successCount: string;
  readonly failureCount: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProxyPublicDTO {
  readonly id: EntityId;
  readonly name: string;
  readonly protocol: ProxyProtocol;
  readonly address: string;
  readonly host: string;
  readonly port: number;
  readonly hasCredentials: boolean;
  readonly enabled: boolean;
  readonly healthStatus: ProxyHealthStatus;
  readonly lastTestedAt: string | null;
  readonly lastTestLatencyMs: number | null;
  readonly lastTestError: string | null;
  readonly lastUsedAt: string | null;
  readonly successCount: string;
  readonly failureCount: string;
}

export interface SaveProxyInput {
  readonly name: string;
  readonly protocol: ProxyProtocol;
  readonly host: string;
  readonly port: number;
  readonly credentialsCiphertext?: string | null;
  readonly enabled: boolean;
}

export interface UpdateProxyInput {
  readonly name?: string;
  readonly protocol?: ProxyProtocol;
  readonly host?: string;
  readonly port?: number;
  readonly credentialsCiphertext?: string | null;
}

export interface ProxyTestResult {
  readonly healthy: boolean;
  readonly latencyMs: number | null;
  readonly error: string | null;
}

export interface ProxyRepository {
  list(): Promise<readonly ProxyRecord[]>;
  listAvailable(): Promise<readonly ProxyRecord[]>;
  getById(id: EntityId): Promise<ProxyRecord | null>;
  findByName(name: string): Promise<ProxyRecord | null>;
  create(input: SaveProxyInput): Promise<ProxyRecord>;
  update(id: EntityId, input: UpdateProxyInput): Promise<ProxyRecord>;
  setEnabled(id: EntityId, enabled: boolean): Promise<ProxyRecord>;
  recordTest(id: EntityId, result: ProxyTestResult): Promise<ProxyRecord>;
  recordUse(id: EntityId, input: { readonly success: boolean; readonly latencyMs: number | null }): Promise<void>;
  audit(input: { readonly proxyId: EntityId | null; readonly action: ProxyAuditAction; readonly actor: string; readonly payload: Record<string, unknown> }): Promise<void>;
}
