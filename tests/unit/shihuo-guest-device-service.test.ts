import { describe, expect, it, vi } from "vitest";
import { ShihuoGuestDeviceService, ShihuoSecretCrypto, type ShihuoDeviceRecord, type ShihuoDeviceRepository } from "../../src/shihuo/index.js";

const key = Buffer.alloc(32, 7).toString("base64");
const config = { onboardingBaseUrl: "https://parser.example", endpoint: "parser.example:51820", serverPublicKey: "server-public",
  subnet: "10.77.0.0/24", dns: "1.1.1.1", caCertificatePath: "unused", onboardingTtlHours: 24, wgCommand: "wg",
  reconcileService: "", gatewayTokenHash: "961d5cf1ff56cd36374aee671429d741ba0b1207f6935d68e1df9f167e3c3d2e", iosAppUrl: "https://apps.apple.com/app/id875177200", androidAppUrl: "https://www.shihuo.cn/app/" };

function record(overrides: Partial<ShihuoDeviceRecord> = {}): ShihuoDeviceRecord {
  return { id: "1", name: "iPhone Андрей", status: "onboarding", wireguardPublicKey: "client-public", wireguardIp: "10.77.0.10",
    onboardingTokenHash: "hash", onboardingExpiresAt: "2026-09-25T00:00:00.000Z", challenge: "SLDS-TEST",
    guestProfileCiphertext: null, clientPrivateKeyCiphertext: null, diagnosticStage: "wireguard_not_connected", diagnosticMessage: null,
    lastHandshakeAt: null, lastTrafficAt: null, lastRequestAt: null, createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z", revokedAt: null, ...overrides };
}

describe("Shihuo guest device onboarding", () => {
  it("authorizes the gateway by a timing-safe token hash comparison", () => {
    const service = new ShihuoGuestDeviceService({} as never, new ShihuoSecretCrypto(key), {} as never, config);
    expect(service.gatewayAuthorized("Bearer gateway-token-with-at-least-32-characters")).toBe(true);
    expect(service.gatewayAuthorized("Bearer wrong-token")).toBe(false);
  });

  it("encrypts secrets with authenticated encryption", () => {
    const crypto = new ShihuoSecretCrypto(key); const encrypted = crypto.encrypt('{"sk":"secret"}');
    expect(encrypted).not.toContain("secret"); expect(crypto.decrypt(encrypted)).toBe('{"sk":"secret"}');
  });

  it("creates an isolated peer and returns the token only in the onboarding URL", async () => {
    const crypto = new ShihuoSecretCrypto(key); let saved: Parameters<ShihuoDeviceRepository["create"]>[0] | undefined;
    const repository = { create: vi.fn(async (input) => { saved = input; return record({ clientPrivateKeyCiphertext: input.privateKeyCiphertext }); }),
      audit: vi.fn(), list: vi.fn(), getById: vi.fn(), findByTokenHash: vi.fn(), rotateToken: vi.fn(), setStatus: vi.fn(),
      clearPrivateKey: vi.fn(), updateHandshake: vi.fn(), delete: vi.fn() } as unknown as ShihuoDeviceRepository;
    const wireguard = { generateKeyPair: vi.fn().mockResolvedValue({ privateKey: "client-private", publicKey: "client-public" }), reconcile: vi.fn() };
    const service = new ShihuoGuestDeviceService(repository, crypto, wireguard, config, () => new Date("2026-09-24T00:00:00Z"));
    const result = await service.create(" iPhone Андрей ", "admin");
    expect(result.onboardingUrl).toMatch(/^https:\/\/parser\.example\/shihuo\/onboarding\/[A-Za-z0-9_-]+$/u);
    expect(saved?.tokenHash).toMatch(/^[a-f0-9]{64}$/u); expect(saved?.privateKeyCiphertext).not.toContain("client-private");
    expect(saved?.challenge).toBe("DD1391-100");
    expect(saved?.firstHost).toBe(10); expect(result.item).not.toHaveProperty("wireguardPublicKey");
    expect(wireguard.reconcile).toHaveBeenCalledOnce();
  });

  it("accepts only the six guest profile fields from a gateway event", async () => {
    const crypto = new ShihuoSecretCrypto(key); let event: Parameters<ShihuoDeviceRepository["recordGatewayEvent"]>[0] | undefined;
    const repository = { recordGatewayEvent: vi.fn(async (input) => { event = input; return record({ status: "ready" }); }) } as unknown as ShihuoDeviceRepository;
    const service = new ShihuoGuestDeviceService(repository, crypto, {} as never, config);
    const profile = { platform: "ios", "app-v": "7.6.0", sk: "guest", luid: "device", osv: "18.0", "user-agent": "shihuo" };
    await expect(service.gatewayEvent({ wireguardIp: "10.77.0.10", stage: "ready", profile })).resolves.toEqual({ accepted: true });
    expect(JSON.parse(crypto.decrypt(event?.profileCiphertext ?? ""))).toEqual(profile);
    await expect(service.gatewayEvent({ wireguardIp: "10.77.0.10", stage: "ready", profile: { ...profile, cookie: "secret" } })).rejects.toThrow("Guest profile fields are invalid");
  });

  it("builds a full-tunnel WireGuard configuration from encrypted client material", async () => {
    const crypto = new ShihuoSecretCrypto(key); const device = record({ clientPrivateKeyCiphertext: crypto.encrypt("client-private") });
    const repository = { findByTokenHash: vi.fn().mockResolvedValue(device) } as unknown as ShihuoDeviceRepository;
    const service = new ShihuoGuestDeviceService(repository, crypto, {} as never, config);
    const text = await service.configuration("a".repeat(43));
    expect(text).toContain("PrivateKey = client-private"); expect(text).toContain("Address = 10.77.0.10/32");
    expect(text).toContain("AllowedIPs = 0.0.0.0/0, ::/0");
  });
});
