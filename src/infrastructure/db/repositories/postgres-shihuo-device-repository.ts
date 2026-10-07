import type { EntityId } from "../../../contracts/index.js";
import type { ShihuoDeviceRecord, ShihuoDeviceRepository, ShihuoDeviceStatus, ShihuoDiagnosticStage } from "../../../shihuo/index.js";
import type { SqlExecutor, SqlPool } from "../sql-executor.js";
import { PermanentError } from "../../../core/errors/index.js";
import { requireRow } from "./repository-utils.js";
import type { DatabaseRow } from "./row-mappers.js";

const timestamp = (value: unknown): string | null => value == null ? null : value instanceof Date ? value.toISOString() : String(value);

function mapDevice(row: DatabaseRow): ShihuoDeviceRecord {
  return {
    id: String(row.id), name: String(row.name), status: row.status as ShihuoDeviceStatus,
    wireguardPublicKey: String(row.wireguard_public_key), wireguardIp: row.wireguard_ip == null ? null : String(row.wireguard_ip).replace(/\/32$/u, ""),
    onboardingTokenHash: row.onboarding_token_hash == null ? null : String(row.onboarding_token_hash),
    onboardingExpiresAt: timestamp(row.onboarding_expires_at), challenge: String(row.challenge),
    guestProfileCiphertext: row.guest_profile_ciphertext == null ? null : String(row.guest_profile_ciphertext),
    clientPrivateKeyCiphertext: row.client_private_key_ciphertext == null ? null : String(row.client_private_key_ciphertext),
    diagnosticStage: row.diagnostic_stage as ShihuoDiagnosticStage,
    diagnosticMessage: row.diagnostic_message == null ? null : String(row.diagnostic_message),
    lastHandshakeAt: timestamp(row.last_handshake_at), lastTrafficAt: timestamp(row.last_traffic_at),
    lastRequestAt: timestamp(row.last_request_at), lastVerificationAt: timestamp(row.last_verification_at), certificateAcknowledgedAt: timestamp(row.certificate_acknowledged_at),
    completionAcknowledgedAt: timestamp(row.completion_acknowledged_at), createdAt: timestamp(row.created_at) ?? "",
    updatedAt: timestamp(row.updated_at) ?? "", revokedAt: timestamp(row.revoked_at),
  };
}

export class PostgresShihuoDeviceRepository implements ShihuoDeviceRepository {
  constructor(private readonly executor: SqlExecutor, private readonly pool: SqlPool) {}

  private async transaction<T>(action: (client: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async findPublic(requestHash: string) {
    return this.publicRegistration(this.executor, requestHash);
  }

  private async publicRegistration(executor: SqlExecutor, requestHash: string) {
    const result = await executor.query<DatabaseRow>(`SELECT d.*, r.token_ciphertext, r.expires_at AS public_expires_at
      FROM shihuo_public_registrations r LEFT JOIN shihuo_guest_devices d ON d.id=r.device_id
      WHERE r.request_hash=$1`, [requestHash]);
    const row = result.rows[0];
    if (!row) return null;
    if (row.id == null || new Date(String(row.public_expires_at)).getTime() <= Date.now() || row.status === "revoked") {
      throw new PermanentError("Ссылка истекла. Создайте новую заявку.", { code: "SHIHUO_PUBLIC_LINK_EXPIRED" });
    }
    return { device: mapDevice(row), tokenCiphertext: String(row.token_ciphertext) };
  }

  async createPublic(input: Parameters<ShihuoDeviceRepository["create"]>[0], registration: Parameters<ShihuoDeviceRepository["createPublic"]>[1]) {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(81473192)");
      const existing = await this.publicRegistration(client, registration.requestHash);
      if (existing) return { ...existing, created: false };
      const count = await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM shihuo_public_registrations
        WHERE ip_hash=$1 AND created_at > NOW()-INTERVAL '24 hours'`, [registration.ipHash]);
      if (count.rows[0]!.count >= 3) throw new PermanentError("С этого IP уже созданы три заявки за сутки. Продолжите ранее начатую заявку или попробуйте позже.", { code: "SHIHUO_PUBLIC_RATE_LIMIT" });
      await client.query(`UPDATE shihuo_guest_devices d SET wireguard_ip=NULL, client_private_key_ciphertext=NULL,
        status=CASE WHEN d.status='ready' THEN 'ready' ELSE 'revoked' END,
        diagnostic_stage=CASE WHEN d.status='ready' THEN d.diagnostic_stage ELSE 'revoked' END,
        completion_acknowledged_at=CASE WHEN d.status='ready' THEN COALESCE(d.completion_acknowledged_at,NOW()) ELSE d.completion_acknowledged_at END,
        updated_at=NOW()
        FROM shihuo_public_registrations r WHERE r.device_id=d.id AND r.expires_at<=NOW()
        AND d.wireguard_ip IS NOT NULL`);
      const device = await this.insertDevice(client, input);
      await client.query(`INSERT INTO shihuo_public_registrations(request_hash,ip_hash,device_id,token_ciphertext,expires_at)
        VALUES($1,$2,$3,$4,$5::timestamptz)`, [registration.requestHash, registration.ipHash, device.id, registration.tokenCiphertext, input.expiresAt]);
      return { device, tokenCiphertext: registration.tokenCiphertext, created: true };
    });
  }

  async registerFingerprint(id: EntityId, fingerprint: string): Promise<void> {
    await this.executor.query(`INSERT INTO shihuo_profile_fingerprints(fingerprint,device_id) VALUES($1,$2)
      ON CONFLICT(fingerprint) DO NOTHING`, [fingerprint, id]);
  }

  async randomProductSku(): Promise<string | null> {
    const result = await this.executor.query<DatabaseRow>(
      `SELECT BTRIM(data->>'sku') AS sku
         FROM internal_products TABLESAMPLE SYSTEM (1)
         WHERE status IN ('classified','classification_pending')
           AND data->'metadata'->>'route'='sneakers'
           AND data->'attributes'->>'productType'='sneakers'
           AND COALESCE((data->'metadata'->>'activeVariantCount')::INTEGER, 0) > 0
           AND BTRIM(data->>'sku') ~ '^[A-Za-z0-9][A-Za-z0-9 ._/-]{2,39}$'
           AND NOT EXISTS (SELECT 1 FROM shihuo_guest_devices d WHERE d.challenge=BTRIM(data->>'sku'))
         ORDER BY RANDOM() LIMIT 1`,
    );
    return result.rows[0]?.sku == null ? null : String(result.rows[0].sku);
  }

  async list(): Promise<readonly ShihuoDeviceRecord[]> {
    const result = await this.executor.query<DatabaseRow>("SELECT * FROM shihuo_guest_devices ORDER BY created_at DESC, id DESC");
    return result.rows.map(mapDevice);
  }

  async getById(id: EntityId): Promise<ShihuoDeviceRecord | null> {
    const result = await this.executor.query<DatabaseRow>("SELECT * FROM shihuo_guest_devices WHERE id = $1", [id]);
    return result.rows[0] ? mapDevice(result.rows[0]) : null;
  }

  async findByTokenHash(hash: string): Promise<ShihuoDeviceRecord | null> {
    const result = await this.executor.query<DatabaseRow>(
      "SELECT * FROM shihuo_guest_devices WHERE onboarding_token_hash = $1 AND onboarding_expires_at > NOW()", [hash],
    );
    return result.rows[0] ? mapDevice(result.rows[0]) : null;
  }

  async create(input: Parameters<ShihuoDeviceRepository["create"]>[0]): Promise<ShihuoDeviceRecord> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(81473192)");
      return this.insertDevice(client, input);
    });
  }

  private async insertDevice(executor: SqlExecutor, input: Parameters<ShihuoDeviceRepository["create"]>[0]): Promise<ShihuoDeviceRecord> {
    const result = await executor.query<DatabaseRow>(
      `WITH candidate AS (
         SELECT host($7::inet + slot)::inet AS address FROM generate_series($8::INTEGER, $9::INTEGER) slot
         WHERE NOT EXISTS (SELECT 1 FROM shihuo_guest_devices d WHERE d.wireguard_ip = host($7::inet + slot)::inet)
         ORDER BY slot LIMIT 1
       )
       INSERT INTO shihuo_guest_devices
         (name, wireguard_public_key, onboarding_token_hash, onboarding_expires_at, challenge, client_private_key_ciphertext, wireguard_ip)
       SELECT $1, $2, $3, $4::timestamptz, $5, $6, address FROM candidate RETURNING *`,
      [input.name, input.publicKey, input.tokenHash, input.expiresAt, input.challenge, input.privateKeyCiphertext,
        input.subnet, input.firstHost, input.lastHost],
    );
    if (!result.rows[0]) throw new PermanentError("Все подключения заняты. Попробуйте позже.", { code: "SHIHUO_PUBLIC_CAPACITY" });
    return mapDevice(result.rows[0]);
  }

  async rotateToken(id: EntityId, tokenHash: string, expiresAt: string): Promise<ShihuoDeviceRecord> {
    const result = await this.executor.query<DatabaseRow>(
      `UPDATE shihuo_guest_devices SET onboarding_token_hash=$2, onboarding_expires_at=$3::timestamptz,
       updated_at=NOW() WHERE id=$1 AND status NOT IN ('revoked') RETURNING *`, [id, tokenHash, expiresAt],
    );
    return mapDevice(requireRow(result.rows, "Shihuo device", id));
  }

  async setStatus(id: EntityId, status: ShihuoDeviceStatus, stage: ShihuoDiagnosticStage): Promise<ShihuoDeviceRecord> {
    const result = await this.executor.query<DatabaseRow>(
      `UPDATE shihuo_guest_devices SET status=$2, diagnostic_stage=$3,
       revoked_at=CASE WHEN $2='revoked' THEN NOW() ELSE revoked_at END,
       onboarding_token_hash=CASE WHEN $2='revoked' THEN NULL ELSE onboarding_token_hash END,
       onboarding_expires_at=CASE WHEN $2='revoked' THEN NULL ELSE onboarding_expires_at END,
       client_private_key_ciphertext=CASE WHEN $2='revoked' THEN NULL ELSE client_private_key_ciphertext END,
       wireguard_ip=CASE WHEN $2='revoked' AND EXISTS(SELECT 1 FROM shihuo_public_registrations WHERE device_id=$1) THEN NULL ELSE wireguard_ip END,
       updated_at=NOW()
       WHERE id=$1 RETURNING *`, [id, status, stage],
    );
    return mapDevice(requireRow(result.rows, "Shihuo device", id));
  }

  async clearPrivateKey(id: EntityId): Promise<void> {
    await this.executor.query(
      "UPDATE shihuo_guest_devices SET client_private_key_ciphertext=NULL, updated_at=NOW() WHERE id=$1", [id],
    );
  }

  async acknowledgeCertificate(id: EntityId): Promise<ShihuoDeviceRecord> {
    const result = await this.executor.query<DatabaseRow>(
      "UPDATE shihuo_guest_devices SET certificate_acknowledged_at=COALESCE(certificate_acknowledged_at,NOW()), updated_at=NOW() WHERE id=$1 RETURNING *", [id],
    );
    return mapDevice(requireRow(result.rows, "Shihuo device", id));
  }

  async acknowledgeCompletion(id: EntityId): Promise<ShihuoDeviceRecord> {
    const result = await this.executor.query<DatabaseRow>(
      `UPDATE shihuo_guest_devices SET completion_acknowledged_at=COALESCE(completion_acknowledged_at,NOW()),
       client_private_key_ciphertext=NULL,
       wireguard_ip=CASE WHEN EXISTS(SELECT 1 FROM shihuo_public_registrations WHERE device_id=$1) THEN NULL ELSE wireguard_ip END,
       updated_at=NOW() WHERE id=$1 AND status='ready' RETURNING *`, [id],
    );
    return mapDevice(requireRow(result.rows, "Shihuo device", id));
  }

  async updateHandshake(publicKey: string, handshakeAt: string | null): Promise<void> {
    await this.executor.query(
      `UPDATE shihuo_guest_devices SET last_handshake_at=$2::timestamptz,
       diagnostic_stage=CASE WHEN status='onboarding' AND $2::timestamptz IS NOT NULL AND diagnostic_stage='wireguard_not_connected'
         THEN 'traffic_not_seen' ELSE diagnostic_stage END, updated_at=NOW()
       WHERE wireguard_public_key=$1`, [publicKey, handshakeAt],
    );
  }

  async recordGatewayEvent(input: Parameters<ShihuoDeviceRepository["recordGatewayEvent"]>[0]): Promise<ShihuoDeviceRecord | null> {
    const captured = input.stage === "profile_captured" && input.profileCiphertext !== undefined;
    const result = await this.executor.query<DatabaseRow>(
      `UPDATE shihuo_guest_devices SET
           diagnostic_stage=CASE
             WHEN status='ready' AND $2::text<>'ready' THEN diagnostic_stage
             WHEN $2::text='traffic_not_seen' AND $5::timestamptz IS NOT NULL AND diagnostic_stage<>'wireguard_not_connected' THEN diagnostic_stage
             WHEN $2::text='certificate_not_trusted' AND diagnostic_stage IN ('certificate_trusted','challenge_not_found','authorized_request_rejected','profile_incomplete','profile_captured','ready') THEN diagnostic_stage
             WHEN $2::text='certificate_trusted' AND diagnostic_stage IN ('challenge_not_found','authorized_request_rejected','profile_incomplete','profile_captured','ready') THEN diagnostic_stage
             ELSE $2
           END,
           diagnostic_message=CASE
             WHEN status='ready' AND $2::text<>'ready' THEN diagnostic_message
             WHEN $2::text='traffic_not_seen' AND $5::timestamptz IS NOT NULL AND diagnostic_stage<>'wireguard_not_connected' THEN diagnostic_message
             WHEN $2::text='certificate_not_trusted' AND diagnostic_stage IN ('certificate_trusted','challenge_not_found','authorized_request_rejected','profile_incomplete','profile_captured','ready') THEN diagnostic_message
             WHEN $2::text='certificate_trusted' AND diagnostic_stage IN ('challenge_not_found','authorized_request_rejected','profile_incomplete','profile_captured','ready') THEN diagnostic_message
             ELSE $3
           END,
         guest_profile_ciphertext=COALESCE($4, guest_profile_ciphertext),
         last_handshake_at=COALESCE($5::timestamptz, last_handshake_at),
           last_traffic_at=CASE WHEN $5::timestamptz IS NULL THEN NOW() ELSE last_traffic_at END,
           last_request_at=CASE WHEN $2 IN ('profile_captured','authorized_request_rejected','profile_incomplete') THEN NOW() ELSE last_request_at END,
         updated_at=NOW()
       WHERE wireguard_ip=$1::inet AND status='onboarding' AND completion_acknowledged_at IS NULL RETURNING *`,
      [input.wireguardIp, input.stage, input.message ?? null, captured ? input.profileCiphertext : null, input.handshakeAt ?? null],
    );
    return result.rows[0] ? mapDevice(result.rows[0]) : null;
  }

  async recordVerification(id: EntityId, success: boolean, message?: string, profile?: { fingerprint: string; ciphertext: string }): Promise<ShihuoDeviceRecord> {
    return this.transaction(async (client) => {
      const locked = await client.query<DatabaseRow>("SELECT * FROM shihuo_guest_devices WHERE id=$1 FOR UPDATE", [id]);
      const device = mapDevice(requireRow(locked.rows, "Shihuo device", id));
      if (device.status === "paused" || device.status === "revoked" || device.diagnosticStage === "duplicate_profile") return device;
      if (device.status === "ready") return device;
      if (profile && device.guestProfileCiphertext !== profile.ciphertext) throw new PermanentError("Профиль изменился. Повторите проверку.", { code: "SHIHUO_PROFILE_CHANGED" });
      if (success && profile) {
        const claimed = await client.query<{ device_id: string | null }>(`INSERT INTO shihuo_profile_fingerprints(fingerprint,device_id) VALUES($1,$2)
          ON CONFLICT(fingerprint) DO UPDATE SET fingerprint=EXCLUDED.fingerprint RETURNING device_id`, [profile.fingerprint,id]);
        if (String(claimed.rows[0]!.device_id) !== id) {
          const duplicate = await client.query<DatabaseRow>(`UPDATE shihuo_guest_devices SET status='error', diagnostic_stage='duplicate_profile',
            diagnostic_message='Этот гостевой профиль уже был получен. Повторная заявка не принята.',
            completion_acknowledged_at=NOW(),client_private_key_ciphertext=NULL,
            wireguard_ip=CASE WHEN EXISTS(SELECT 1 FROM shihuo_public_registrations WHERE device_id=$1) THEN NULL ELSE wireguard_ip END,
            last_verification_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`, [id]);
          return mapDevice(duplicate.rows[0]!);
        }
      }
      const result = await client.query<DatabaseRow>(
      `UPDATE shihuo_guest_devices SET status=CASE WHEN $2 THEN 'ready' ELSE 'onboarding' END,
       diagnostic_stage=CASE WHEN $2 THEN 'ready' ELSE 'verification_failed' END,
       diagnostic_message=$3, last_verification_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status NOT IN ('paused','revoked') RETURNING *`, [id, success, message ?? null],
    );
      return mapDevice(requireRow(result.rows, "Shihuo device", id));
    });
  }

  async delete(id: EntityId): Promise<void> {
    await this.executor.query("DELETE FROM shihuo_guest_devices WHERE id=$1", [id]);
  }

  async audit(input: Parameters<ShihuoDeviceRepository["audit"]>[0]): Promise<void> {
    await this.executor.query(
      "INSERT INTO shihuo_guest_device_audit(device_id,action,actor,payload) VALUES($1,$2,$3,$4::jsonb)",
      [input.deviceId, input.action, input.actor, JSON.stringify(input.payload ?? {})],
    );
  }
}
