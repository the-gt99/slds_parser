import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import QRCode from "qrcode";

import type { EntityId } from "../contracts/index.js";
import type { ShihuoConfig } from "../config/index.js";
import { PermanentError } from "../core/errors/index.js";
import { ShihuoSecretCrypto } from "./secret-crypto.js";
import type { ShihuoDeviceRecord, ShihuoDeviceRepository, ShihuoDeviceStatus } from "./types.js";
import type { ShihuoGuestProfile } from "./types.js";
import type { ShihuoSearchVerifier } from "./search-verifier.js";
import type { WireGuardManager } from "./wireguard-manager.js";

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
const profileKeys = ["platform", "app-v", "sk", "luid", "osv", "user-agent"] as const;

export interface ShihuoAdminDevice {
  readonly id: EntityId; readonly name: string; readonly status: ShihuoDeviceStatus; readonly wireguardIp: string | null;
  readonly diagnosticStage: string; readonly diagnosticMessage: string | null; readonly createdAt: string;
  readonly updatedAt: string; readonly lastHandshakeAt: string | null; readonly lastRequestAt: string | null;
  readonly lastVerificationAt: string | null;
  readonly onboardingExpiresAt: string | null; readonly hasProfile: boolean;
}

function publicDevice(record: ShihuoDeviceRecord): ShihuoAdminDevice {
  return { id: record.id, name: record.name, status: record.status, wireguardIp: record.wireguardIp,
    diagnosticStage: record.diagnosticStage, diagnosticMessage: record.diagnosticMessage, createdAt: record.createdAt,
    updatedAt: record.updatedAt, lastHandshakeAt: record.lastHandshakeAt, lastRequestAt: record.lastRequestAt,
    lastVerificationAt: record.lastVerificationAt,
    onboardingExpiresAt: record.onboardingExpiresAt, hasProfile: record.guestProfileCiphertext !== null };
}

export class ShihuoGuestDeviceService {
  constructor(private readonly repository: ShihuoDeviceRepository, private readonly crypto: ShihuoSecretCrypto,
    private readonly wireguard: WireGuardManager, private readonly config: ShihuoConfig, private readonly verifier: ShihuoSearchVerifier,
    private readonly now = () => new Date()) {}

  async list(): Promise<readonly ShihuoAdminDevice[]> { return (await this.repository.list()).map(publicDevice); }

  private profileFingerprint(profile: ShihuoGuestProfile): string {
    return this.crypto.fingerprint("shihuo-profile-v1", JSON.stringify(profileKeys.map((key) => profile[key])));
  }

  async initializeFingerprints(): Promise<void> {
    const records = [...await this.repository.list()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || Number(a.id)-Number(b.id));
    for (const record of records) {
      if (record.guestProfileCiphertext === null || (record.status !== "ready" && record.completionAcknowledgedAt === null) || record.diagnosticStage === "duplicate_profile") continue;
      const profile = JSON.parse(this.crypto.decrypt(record.guestProfileCiphertext)) as ShihuoGuestProfile;
      await this.repository.registerFingerprint(record.id, this.profileFingerprint(profile));
    }
  }

  async join(requestKey: unknown, ip: string) {
    if (typeof requestKey !== "string" || !/^[a-f0-9]{64}$/u.test(requestKey)) throw new PermanentError("Некорректная заявка.", { code: "INVALID_SHIHUO_DEVICE" });
    const requestHash = tokenHash(requestKey);
    const existing = await this.repository.findPublic(requestHash);
    if (existing) return { onboardingUrl: this.onboardingUrl(this.crypto.decrypt(existing.tokenCiphertext)), expiresAt: existing.device.onboardingExpiresAt };
    const challenge = await this.repository.randomProductSku();
    if (challenge === null) throw new PermanentError("Сейчас нельзя создать заявку. Попробуйте позже.", { code: "SHIHUO_PRODUCT_SKU_UNAVAILABLE" });
    const issued = this.issueToken(); const keys = await this.wireguard.generateKeyPair();
    const result = await this.repository.createPublic({ name: `Гость ${requestHash.slice(0, 10)}`, publicKey: keys.publicKey,
      tokenHash: issued.hash, expiresAt: issued.expiresAt, challenge, privateKeyCiphertext: this.crypto.encrypt(keys.privateKey),
      subnet: this.config.subnet, firstHost: 10, lastHost: 254 },
    { requestHash, ipHash: this.crypto.fingerprint("shihuo-public-ip-v1", ip), tokenCiphertext: this.crypto.encrypt(issued.token) });
    if (result.created) await this.repository.audit({ deviceId: result.device.id, action: "public_create", actor: "public" });
    await this.wireguard.reconcile();
    return { onboardingUrl: this.onboardingUrl(this.crypto.decrypt(result.tokenCiphertext)), expiresAt: result.device.onboardingExpiresAt };
  }

  gatewayAuthorized(value: string | undefined): boolean {
    const token = /^Bearer\s+(.+)$/iu.exec(value ?? "")?.[1]?.trim();
    if (!token) return false;
    const actual = Buffer.from(tokenHash(token), "hex");
    const expected = Buffer.from(this.config.gatewayTokenHash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async gatewayPeers() {
    return { items: (await this.repository.list()).filter((item) => item.wireguardIp !== null && item.status !== "paused" && item.status !== "revoked" && item.status !== "error" && item.completionAcknowledgedAt === null
      && item.onboardingExpiresAt !== null && Date.parse(item.onboardingExpiresAt) > this.now().getTime()).map((item) => ({
      id: item.id, publicKey: item.wireguardPublicKey, wireguardIp: item.wireguardIp, challenge: item.challenge,
    })) };
  }

  async gatewayEvent(value: unknown) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PermanentError("Gateway event must be an object", { code: "INVALID_SHIHUO_GATEWAY_EVENT" });
    const body = value as Record<string, unknown>; const wireguardIp = typeof body.wireguardIp === "string" ? body.wireguardIp : "";
    const allowedStages = ["traffic_not_seen", "certificate_not_trusted", "certificate_trusted", "challenge_not_found", "authorized_request_rejected", "profile_incomplete", "profile_captured"] as const;
    const stage = allowedStages.find((candidate) => candidate === body.stage);
    if (!/^10\.77\.0\.\d{1,3}$/u.test(wireguardIp) || stage === undefined) throw new PermanentError("Gateway event is invalid", { code: "INVALID_SHIHUO_GATEWAY_EVENT" });
    let profileCiphertext: string | undefined;
    if (stage === "profile_captured") {
      if (body.profile === null || typeof body.profile !== "object" || Array.isArray(body.profile)) throw new PermanentError("Guest profile is required", { code: "INVALID_SHIHUO_GATEWAY_EVENT" });
      const profile = body.profile as Record<string, unknown>; const keys = profileKeys;
      if (Object.keys(profile).length !== keys.length || keys.some((key) => typeof profile[key] !== "string" || !(profile[key] as string))) throw new PermanentError("Guest profile fields are invalid", { code: "INVALID_SHIHUO_GATEWAY_EVENT" });
      profileCiphertext = this.crypto.encrypt(JSON.stringify(Object.fromEntries(keys.map((key) => [key, profile[key]]))));
    }
    const handshakeAt = typeof body.handshakeAt === "number" && Number.isSafeInteger(body.handshakeAt) && body.handshakeAt > 0 ? new Date(body.handshakeAt * 1_000).toISOString() : undefined;
    const item = await this.repository.recordGatewayEvent({ wireguardIp, stage, ...(typeof body.message === "string" ? { message: body.message.slice(0, 200) } : {}), ...(profileCiphertext ? { profileCiphertext } : {}), ...(handshakeAt ? { handshakeAt } : {}) });
    return { accepted: item !== null };
  }

  private issueToken(): { token: string; hash: string; expiresAt: string } {
    const token = randomBytes(32).toString("base64url");
    return { token, hash: tokenHash(token), expiresAt: new Date(this.now().getTime() + this.config.onboardingTtlHours * 3_600_000).toISOString() };
  }

  private onboardingUrl(token: string): string { return `${this.config.onboardingBaseUrl}/shihuo/onboarding/${token}`; }

  async create(nameValue: unknown, actor: string) {
    if (typeof nameValue !== "string" || nameValue.trim().length < 1 || nameValue.trim().length > 100) throw new PermanentError("Device name must be 1-100 characters", { code: "INVALID_SHIHUO_DEVICE" });
    const name = nameValue.trim(); const challenge = await this.repository.randomProductSku();
    if (challenge === null) throw new PermanentError("No real product SKU is available for Shihuo onboarding", { code: "SHIHUO_PRODUCT_SKU_UNAVAILABLE" });
    const issued = this.issueToken(); const keys = await this.wireguard.generateKeyPair();
    const record = await this.repository.create({ name, publicKey: keys.publicKey, tokenHash: issued.hash, expiresAt: issued.expiresAt,
      challenge, privateKeyCiphertext: this.crypto.encrypt(keys.privateKey), subnet: this.config.subnet, firstHost: 10, lastHost: 254 });
    await this.repository.audit({ deviceId: record.id, action: "create", actor, payload: { name, wireguardIp: record.wireguardIp } });
    await this.wireguard.reconcile();
    return { item: publicDevice(record), onboardingUrl: this.onboardingUrl(issued.token) };
  }

  async rotateLink(id: EntityId, actor: string) {
    const issued = this.issueToken(); const record = await this.repository.rotateToken(id, issued.hash, issued.expiresAt);
    await this.repository.audit({ deviceId: id, action: "rotate_link", actor });
    return { item: publicDevice(record), onboardingUrl: this.onboardingUrl(issued.token) };
  }

  async setStatus(id: EntityId, status: "paused" | "onboarding", actor: string): Promise<ShihuoAdminDevice> {
    const record = await this.repository.setStatus(id, status, status === "paused" ? "paused" : "wireguard_not_connected");
    await this.repository.audit({ deviceId: id, action: status === "paused" ? "pause" : "resume", actor });
    await this.wireguard.reconcile(); return publicDevice(record);
  }

  async revoke(id: EntityId, actor: string): Promise<ShihuoAdminDevice> {
    const record = await this.repository.setStatus(id, "revoked", "revoked");
    await this.repository.clearPrivateKey(id); await this.repository.audit({ deviceId: id, action: "revoke", actor });
    await this.wireguard.reconcile(); return publicDevice(record);
  }

  async delete(id: EntityId, actor: string): Promise<void> {
    const record = await this.repository.getById(id);
    if (record === null) throw new PermanentError("Shihuo device was not found", { code: "ENTITY_NOT_FOUND" });
    if (record.status !== "revoked") throw new PermanentError("Revoke the device before deleting it", { code: "INVALID_SHIHUO_DEVICE_STATE" });
    await this.repository.audit({ deviceId: id, action: "delete", actor, payload: { name: record.name } });
    await this.repository.delete(id); await this.wireguard.reconcile();
  }

  async onboarding(token: string) {
    const record = await this.validToken(token);
    const handshakeTime = record.lastHandshakeAt === null ? Number.NaN : Date.parse(record.lastHandshakeAt);
    const wireguardConnected = Number.isFinite(handshakeTime) && this.now().getTime() - handshakeTime < 180_000;
    return { name: record.name, challenge: record.challenge, status: record.status, diagnosticStage: record.diagnosticStage,
      diagnosticMessage: record.diagnosticMessage, expiresAt: record.onboardingExpiresAt, iosAppUrl: this.config.iosAppUrl,
      androidAppUrl: this.config.androidAppUrl, lastHandshakeAt: record.lastHandshakeAt, lastRequestAt: record.lastRequestAt,
      wireguardConnected,
      profileCaptured: record.guestProfileCiphertext !== null,
      lastVerificationAt: record.lastVerificationAt,
      certificateAcknowledged: record.certificateAcknowledgedAt !== null,
      completionAcknowledged: record.completionAcknowledgedAt !== null };
  }

  async acknowledgeCertificate(token: string) {
    const record = await this.validToken(token);
    const updated = await this.repository.acknowledgeCertificate(record.id);
    if (record.certificateAcknowledgedAt === null) await this.repository.audit({ deviceId: record.id, action: "certificate_acknowledged", actor: "onboarding" });
    return { acknowledged: updated.certificateAcknowledgedAt !== null };
  }

  async acknowledgeCompletion(token: string) {
    const record = await this.validToken(token);
    if (record.status !== "ready" || record.guestProfileCiphertext === null) throw new PermanentError("Shihuo onboarding is not ready", { code: "INVALID_SHIHUO_DEVICE_STATE" });
    const updated = await this.repository.acknowledgeCompletion(record.id);
    if (record.completionAcknowledgedAt === null) await this.repository.audit({ deviceId: record.id, action: "onboarding_complete", actor: "onboarding" });
    await this.wireguard.reconcile();
    return { completed: updated.completionAcknowledgedAt !== null };
  }

  async verify(token: string) {
    const record = await this.validToken(token);
    if (record.diagnosticStage === "duplicate_profile") return { verified: false, duplicate: true, message: record.diagnosticMessage };
    if (record.status === "ready") return { verified: true };
    if (record.guestProfileCiphertext === null) throw new PermanentError("Shihuo guest profile has not been captured", { code: "INVALID_SHIHUO_DEVICE_STATE" });
    let profile: ShihuoGuestProfile;
    try { profile = JSON.parse(this.crypto.decrypt(record.guestProfileCiphertext)) as ShihuoGuestProfile; }
    catch { throw new PermanentError("Shihuo guest profile cannot be read", { code: "SHIHUO_VERIFICATION_FAILED" }); }
    let result;
    try {
      result = await this.verifier.verify(profile, record.challenge);
    } catch {
      const message = "Тестовый запрос к Shihuo не прошёл. Повторите проверку позже.";
      const failed = await this.repository.recordVerification(record.id, false, message, { fingerprint: this.profileFingerprint(profile), ciphertext: record.guestProfileCiphertext });
      if (failed.status === "ready") return { verified: true };
      await this.repository.audit({ deviceId: record.id, action: "profile_verification_failed", actor: "onboarding" });
      return { verified: false, message };
    }
    const verified = await this.repository.recordVerification(record.id, true, undefined, { fingerprint: this.profileFingerprint(profile), ciphertext: record.guestProfileCiphertext });
    if (verified.diagnosticStage === "duplicate_profile") {
      await this.repository.audit({ deviceId: record.id, action: "profile_duplicate", actor: "onboarding" });
      await this.wireguard.reconcile();
      return { verified: false, duplicate: true, message: verified.diagnosticMessage };
    }
    if (verified.status !== "ready") throw new PermanentError("Заявка приостановлена или отозвана.", { code: "INVALID_SHIHUO_DEVICE_STATE" });
    await this.repository.audit({ deviceId: record.id, action: "profile_verified", actor: "onboarding", payload: { httpStatus: result.httpStatus, goodsCount: result.goodsCount } });
    return { verified: true, goodsCount: result.goodsCount };
  }

  async configuration(token: string): Promise<string> {
    const record = await this.validToken(token);
    if (record.clientPrivateKeyCiphertext === null) throw new PermanentError("WireGuard configuration is no longer available", { code: "SHIHUO_CONFIG_UNAVAILABLE" });
    const privateKey = this.crypto.decrypt(record.clientPrivateKeyCiphertext);
    return `[Interface]\nPrivateKey = ${privateKey}\nAddress = ${record.wireguardIp}/32\nDNS = ${this.config.dns}\n\n[Peer]\nPublicKey = ${this.config.serverPublicKey}\nEndpoint = ${this.config.endpoint}\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n`;
  }

  async configurationQr(token: string): Promise<string> {
    return QRCode.toString(await this.configuration(token), { type: "svg", errorCorrectionLevel: "M", margin: 1 });
  }

  async certificate(token: string): Promise<Buffer> { await this.validToken(token); return readFile(this.config.caCertificatePath); }

  async check(token: string) {
    const record = await this.validToken(token);
    if (record.status === "ready" && record.guestProfileCiphertext !== null) {
      return { ready: true, status: "ready", stage: "ready", message: "Устройство готово" };
    }
    const messages: Record<string, string> = {
      wireguard_not_connected: "WireGuard ещё не подключён.", traffic_not_seen: "VPN подключён, но трафик Shihuo ещё не замечен.",
      certificate_not_trusted: "Трафик виден, но сертификат не установлен или для него не включено полное доверие.",
      certificate_trusted: "Сертификат работает. Ожидается проверочный поиск в Shihuo.",
      challenge_not_found: "Shihuo работает через VPN, но проверочный поиск ещё не найден.",
      authorized_request_rejected: "Обнаружена авторизованная сессия. Выйдите из аккаунта Shihuo и повторите поиск.",
      profile_incomplete: "Запрос найден, но обязательные поля гостевого профиля отсутствуют.", error: "Настройку не удалось проверить.",
      profile_captured: "Гостевой профиль получен. Ожидается тестовый запрос к Shihuo.",
      verification_failed: "Тестовый запрос к Shihuo не прошёл.",
      paused: "Устройство приостановлено.", revoked: "Устройство отозвано.",
    };
    return { ready: false, status: record.status, stage: record.diagnosticStage,
      message: record.diagnosticMessage || messages[record.diagnosticStage] || "Ожидается проверочный поиск." };
  }

  private async validToken(token: string): Promise<ShihuoDeviceRecord> {
    if (!/^[A-Za-z0-9_-]{40,60}$/u.test(token)) throw new PermanentError("Onboarding link is invalid or expired", { code: "ENTITY_NOT_FOUND" });
    const record = await this.repository.findByTokenHash(tokenHash(token));
    if (record === null || record.status === "revoked") throw new PermanentError("Onboarding link is invalid or expired", { code: "ENTITY_NOT_FOUND" });
    return record;
  }
}
