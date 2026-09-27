import type { EntityId } from "../../../contracts/index.js";
import type { ProxyRecord, ProxyRepository, ProxyTestResult, SaveProxyInput, UpdateProxyInput } from "../../../proxies/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import { requireRow } from "./repository-utils.js";
import type { DatabaseRow } from "./row-mappers.js";

function text(row: DatabaseRow, key: string): string {
  return String(row[key]);
}

function nullableText(row: DatabaseRow, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function nullableTimestamp(row: DatabaseRow, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value);
}

function integer(row: DatabaseRow, key: string): number {
  return Number(row[key]);
}

function nullableInteger(row: DatabaseRow, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined ? null : Number(value);
}

function mapProxy(row: DatabaseRow): ProxyRecord {
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    protocol: row.protocol as ProxyRecord["protocol"],
    host: text(row, "host"),
    port: integer(row, "port"),
    serviceCode: row.service_code as ProxyRecord["serviceCode"],
    countryCode: text(row, "country_code"),
    shihuoDeviceId: nullableText(row, "shihuo_device_id"),
    shihuoDeviceName: nullableText(row, "shihuo_device_name"),
    credentialsCiphertext: nullableText(row, "credentials_ciphertext"),
    enabled: Boolean(row.enabled),
    healthStatus: row.health_status as ProxyRecord["healthStatus"],
    lastTestedAt: nullableTimestamp(row, "last_tested_at"),
    lastTestLatencyMs: nullableInteger(row, "last_test_latency_ms"),
    lastTestError: nullableText(row, "last_test_error"),
    lastUsedAt: nullableTimestamp(row, "last_used_at"),
    successCount: text(row, "success_count"),
    failureCount: text(row, "failure_count"),
    createdAt: nullableTimestamp(row, "created_at") ?? "",
    updatedAt: nullableTimestamp(row, "updated_at") ?? "",
  };
}

export class PostgresGoatProxyRepository implements ProxyRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async list(): Promise<readonly ProxyRecord[]> {
    const result = await this.executor.query<DatabaseRow>(`SELECT proxy.*, device.name AS shihuo_device_name
      FROM goat_proxies proxy LEFT JOIN shihuo_guest_devices device ON device.id=proxy.shihuo_device_id ORDER BY proxy.id`);
    return result.rows.map(mapProxy);
  }

  async listAvailable(): Promise<readonly ProxyRecord[]> {
    const result = await this.executor.query<DatabaseRow>("SELECT *, NULL::TEXT AS shihuo_device_name FROM goat_proxies WHERE service_code='goat' AND enabled = TRUE AND health_status = 'healthy' ORDER BY id");
    return result.rows.map(mapProxy);
  }

  async tryAcquireSessionLease(input: Parameters<NonNullable<ProxyRepository["tryAcquireSessionLease"]>>[0]) {
    const result = await this.executor.query<DatabaseRow>(
      `WITH capacity AS (
         SELECT COUNT(*)::INTEGER * $2::INTEGER AS total_slots
         FROM goat_proxies WHERE service_code='goat' AND enabled = TRUE AND health_status = 'healthy'
       ), active AS (
         SELECT COUNT(*)::INTEGER AS active_slots FROM goat_proxy_session_leases WHERE leased_until > NOW()
       ), candidate AS (
         SELECT proxy.id AS proxy_id, slot.session_slot
         FROM goat_proxies proxy
         CROSS JOIN LATERAL GENERATE_SERIES(1, $2::INTEGER) AS slot(session_slot)
         CROSS JOIN capacity
         CROSS JOIN active
         LEFT JOIN goat_proxy_session_leases lease
           ON lease.proxy_id = proxy.id AND lease.session_slot = slot.session_slot AND lease.leased_until > NOW()
         WHERE proxy.service_code='goat' AND proxy.enabled = TRUE AND proxy.health_status = 'healthy' AND lease.proxy_id IS NULL
           AND capacity.total_slots - active.active_slots > $3::INTEGER
         ORDER BY proxy.last_used_at NULLS FIRST, proxy.id, slot.session_slot
         LIMIT 1
       ), leased AS (
         INSERT INTO goat_proxy_session_leases (proxy_id, session_slot, owner_id, leased_until)
         SELECT proxy_id, session_slot, $1, NOW() + ($4::BIGINT * INTERVAL '1 millisecond') FROM candidate
         ON CONFLICT (proxy_id, session_slot) DO UPDATE
           SET owner_id = EXCLUDED.owner_id, leased_until = EXCLUDED.leased_until, created_at = NOW()
           WHERE goat_proxy_session_leases.leased_until <= NOW()
         RETURNING proxy_id, session_slot
       )
       SELECT proxy.*, NULL::TEXT AS shihuo_device_name, leased.session_slot
       FROM leased JOIN goat_proxies proxy ON proxy.id = leased.proxy_id`,
      [input.ownerId, input.concurrencyPerProxy, input.headroom, input.ttlMs],
    );
    const row = result.rows[0];
    return row === undefined ? null : { proxy: mapProxy(row), sessionSlot: integer(row, "session_slot") };
  }

  async releaseSessionLease(input: Parameters<NonNullable<ProxyRepository["releaseSessionLease"]>>[0]): Promise<void> {
    await this.executor.query(
      `DELETE FROM goat_proxy_session_leases
       WHERE proxy_id = $1 AND session_slot = $2 AND owner_id = $3`,
      [input.proxyId, input.sessionSlot, input.ownerId],
    );
  }

  async getById(id: EntityId): Promise<ProxyRecord | null> {
    const result = await this.executor.query<DatabaseRow>(`SELECT proxy.*, device.name AS shihuo_device_name
      FROM goat_proxies proxy LEFT JOIN shihuo_guest_devices device ON device.id=proxy.shihuo_device_id WHERE proxy.id=$1`, [id]);
    return result.rows[0] ? mapProxy(result.rows[0]) : null;
  }

  async findByName(name: string): Promise<ProxyRecord | null> {
    const result = await this.executor.query<DatabaseRow>(`SELECT proxy.*, device.name AS shihuo_device_name
      FROM goat_proxies proxy LEFT JOIN shihuo_guest_devices device ON device.id=proxy.shihuo_device_id WHERE proxy.name=$1`, [name]);
    return result.rows[0] ? mapProxy(result.rows[0]) : null;
  }

  async create(input: SaveProxyInput): Promise<ProxyRecord> {
    const result = await this.executor.query<DatabaseRow>(
      `WITH inserted AS (
         INSERT INTO goat_proxies (name, protocol, host, port, credentials_ciphertext, enabled, service_code, country_code, shihuo_device_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
       ) SELECT inserted.*, device.name AS shihuo_device_name FROM inserted
       LEFT JOIN shihuo_guest_devices device ON device.id=inserted.shihuo_device_id`,
      [input.name, input.protocol, input.host, input.port, input.credentialsCiphertext ?? null, input.enabled,
        input.serviceCode, input.countryCode, input.shihuoDeviceId],
    );
    return mapProxy(requireRow(result.rows, "proxy", input.name));
  }

  async update(id: EntityId, input: UpdateProxyInput): Promise<ProxyRecord> {
    const result = await this.executor.query<DatabaseRow>(
      `WITH previous AS (SELECT service_code, shihuo_device_id FROM goat_proxies WHERE id=$1 FOR UPDATE),
       cleared AS (
         UPDATE shihuo_guest_devices device SET outbound_proxy_ciphertext=NULL, updated_at=NOW()
         FROM previous WHERE $12::BOOLEAN AND previous.service_code='shihuo' AND device.id=previous.shihuo_device_id
         RETURNING device.id
       ), updated AS (UPDATE goat_proxies
       SET name = COALESCE($2, name),
           protocol = COALESCE($3, protocol),
           host = COALESCE($4, host),
           port = COALESCE($5, port),
           credentials_ciphertext = CASE WHEN $6::BOOLEAN THEN $7 ELSE credentials_ciphertext END,
           service_code = COALESCE($8, service_code), country_code = COALESCE($9, country_code),
           shihuo_device_id = CASE WHEN $10::BOOLEAN THEN $11 ELSE shihuo_device_id END,
           health_status = CASE WHEN $12::BOOLEAN THEN 'untested' ELSE health_status END,
           last_tested_at = CASE WHEN $12::BOOLEAN THEN NULL ELSE last_tested_at END,
           last_test_latency_ms = CASE WHEN $12::BOOLEAN THEN NULL ELSE last_test_latency_ms END,
           last_test_error = CASE WHEN $12::BOOLEAN THEN NULL ELSE last_test_error END,
           enabled = CASE WHEN $12::BOOLEAN THEN FALSE ELSE enabled END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *) SELECT updated.*, device.name AS shihuo_device_name,
         (SELECT COUNT(*) FROM cleared) AS cleared_count FROM updated
       LEFT JOIN shihuo_guest_devices device ON device.id=updated.shihuo_device_id`,
      [
        id,
        input.name ?? null,
        input.protocol ?? null,
        input.host ?? null,
        input.port ?? null,
        Object.prototype.hasOwnProperty.call(input, "credentialsCiphertext"),
        input.credentialsCiphertext ?? null,
        input.serviceCode ?? null,
        input.countryCode ?? null,
        Object.prototype.hasOwnProperty.call(input, "shihuoDeviceId"),
        input.shihuoDeviceId ?? null,
        input.protocol !== undefined || input.host !== undefined || input.port !== undefined
          || Object.prototype.hasOwnProperty.call(input, "credentialsCiphertext")
          || input.serviceCode !== undefined || Object.prototype.hasOwnProperty.call(input, "shihuoDeviceId"),
      ],
    );
    return mapProxy(requireRow(result.rows, "proxy", id));
  }

  async setEnabled(id: EntityId, enabled: boolean, shihuoOutboundProxyCiphertext?: string | null): Promise<ProxyRecord> {
    const result = await this.executor.query<DatabaseRow>(
      `WITH updated AS (
         UPDATE goat_proxies SET enabled=$2, updated_at=NOW() WHERE id=$1 RETURNING *
       ), assigned AS (
         UPDATE shihuo_guest_devices device SET
           outbound_proxy_ciphertext=CASE WHEN $2 THEN $3 ELSE NULL END, updated_at=NOW()
         FROM updated WHERE updated.service_code='shihuo' AND device.id=updated.shihuo_device_id RETURNING device.id
       ) SELECT updated.*, device.name AS shihuo_device_name,
         (SELECT COUNT(*) FROM assigned) AS assigned_count FROM updated
       LEFT JOIN shihuo_guest_devices device ON device.id=updated.shihuo_device_id`,
      [id, enabled, shihuoOutboundProxyCiphertext ?? null],
    );
    return mapProxy(requireRow(result.rows, "proxy", id));
  }

  async recordTest(id: EntityId, result: ProxyTestResult): Promise<ProxyRecord> {
    const updated = await this.executor.query<DatabaseRow>(
      `UPDATE goat_proxies
       SET health_status = $2,
           last_tested_at = NOW(),
           last_test_latency_ms = $3,
           last_test_error = $4,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, result.healthy ? "healthy" : "unhealthy", result.latencyMs, result.error],
    );
    return mapProxy(requireRow(updated.rows, "proxy", id));
  }

  async recordUse(id: EntityId, input: { readonly success: boolean; readonly latencyMs: number | null }): Promise<void> {
    await this.executor.query(
      `UPDATE goat_proxies
       SET last_used_at = NOW(),
           last_test_latency_ms = COALESCE($3, last_test_latency_ms),
           success_count = success_count + CASE WHEN $2 THEN 1 ELSE 0 END,
           failure_count = failure_count + CASE WHEN $2 THEN 0 ELSE 1 END,
           updated_at = NOW()
       WHERE id = $1`,
      [id, input.success, input.latencyMs],
    );
  }

  async audit(input: { readonly proxyId: EntityId | null; readonly action: "create" | "update" | "test" | "enable" | "disable"; readonly actor: string; readonly payload: Record<string, unknown> }): Promise<void> {
    await this.executor.query(
      "INSERT INTO goat_proxy_audit (proxy_id, action, actor, payload) VALUES ($1, $2, $3, $4::jsonb)",
      [input.proxyId, input.action, input.actor, JSON.stringify(input.payload)],
    );
  }
}
