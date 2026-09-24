import type { EntityId } from "../contracts/index.js";

export type ShihuoDeviceStatus = "onboarding" | "ready" | "paused" | "revoked" | "error";
export type ShihuoDiagnosticStage = "wireguard_not_connected" | "traffic_not_seen" | "certificate_not_trusted"
  | "certificate_trusted" | "challenge_not_found" | "authorized_request_rejected" | "profile_incomplete"
  | "profile_captured" | "verification_in_progress" | "verification_failed" | "ready" | "paused" | "revoked" | "error";

export interface ShihuoGuestProfile {
  readonly platform: string;
  readonly "app-v": string;
  readonly sk: string;
  readonly luid: string;
  readonly osv: string;
  readonly "user-agent": string;
}

export interface ShihuoDeviceRecord {
  readonly id: EntityId;
  readonly name: string;
  readonly status: ShihuoDeviceStatus;
  readonly wireguardPublicKey: string;
  readonly wireguardIp: string;
  readonly onboardingTokenHash: string | null;
  readonly onboardingExpiresAt: string | null;
  readonly challenge: string;
  readonly guestProfileCiphertext: string | null;
  readonly clientPrivateKeyCiphertext: string | null;
  readonly diagnosticStage: ShihuoDiagnosticStage;
  readonly diagnosticMessage: string | null;
  readonly lastHandshakeAt: string | null;
  readonly lastTrafficAt: string | null;
  readonly lastRequestAt: string | null;
  readonly lastVerificationAt: string | null;
  readonly certificateAcknowledgedAt: string | null;
  readonly completionAcknowledgedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt: string | null;
}

export interface ShihuoDeviceRepository {
  randomProductSku(): Promise<string | null>;
  list(): Promise<readonly ShihuoDeviceRecord[]>;
  getById(id: EntityId): Promise<ShihuoDeviceRecord | null>;
  findByTokenHash(hash: string): Promise<ShihuoDeviceRecord | null>;
  create(input: { readonly name: string; readonly publicKey: string; readonly tokenHash: string; readonly expiresAt: string; readonly challenge: string; readonly privateKeyCiphertext: string; readonly subnet: string; readonly firstHost: number; readonly lastHost: number }): Promise<ShihuoDeviceRecord>;
  rotateToken(id: EntityId, tokenHash: string, expiresAt: string): Promise<ShihuoDeviceRecord>;
  setStatus(id: EntityId, status: ShihuoDeviceStatus, stage: ShihuoDiagnosticStage): Promise<ShihuoDeviceRecord>;
  clearPrivateKey(id: EntityId): Promise<void>;
  acknowledgeCertificate(id: EntityId): Promise<ShihuoDeviceRecord>;
  acknowledgeCompletion(id: EntityId): Promise<ShihuoDeviceRecord>;
  updateHandshake(publicKey: string, handshakeAt: string | null): Promise<void>;
  recordGatewayEvent(input: { readonly wireguardIp: string; readonly stage: ShihuoDiagnosticStage; readonly message?: string | null; readonly profileCiphertext?: string; readonly handshakeAt?: string }): Promise<ShihuoDeviceRecord | null>;
  recordVerification(id: EntityId, success: boolean, message?: string): Promise<ShihuoDeviceRecord>;
  delete(id: EntityId): Promise<void>;
  audit(input: { readonly deviceId: EntityId | null; readonly action: string; readonly actor: string; readonly payload?: Record<string, unknown> }): Promise<void>;
}
