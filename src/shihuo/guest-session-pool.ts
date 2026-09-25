import { randomUUID } from "node:crypto";
import type { ShihuoConfig } from "../config/index.js";
import type { ShihuoGuestProfile } from "./types.js";
import type { ShihuoSessionRepository } from "./product-types.js";
import { ShihuoSecretCrypto } from "./secret-crypto.js";

export interface ShihuoGuestSessionLease {
  readonly deviceId: string;
  readonly profile: ShihuoGuestProfile;
  success(): Promise<void>;
  fail(reason: string, risk?: boolean): Promise<void>;
}

export class ShihuoGuestSessionPool {
  constructor(private readonly repository: ShihuoSessionRepository, private readonly crypto: ShihuoSecretCrypto,
    private readonly config: ShihuoConfig, private readonly now: () => number = Date.now) {}
  async acquire(): Promise<ShihuoGuestSessionLease | null> {
    const owner = randomUUID(); const leased = await this.repository.acquire(owner, this.config.sessionLeaseSeconds); if (!leased) return null;
    const profile = JSON.parse(this.crypto.decrypt(leased.profileCiphertext)) as ShihuoGuestProfile;
    const releaseAt = (seconds: number) => new Date(this.now() + seconds * 1000).toISOString();
    return { deviceId: leased.deviceId, profile,
      success: () => this.repository.releaseSuccess(leased.deviceId, owner, releaseAt(this.config.betweenProductsSeconds)),
      fail: (reason, risk = false) => this.repository.releaseFailure(leased.deviceId, owner, releaseAt(risk ? this.config.riskCooldownSeconds : this.config.failureCooldownSeconds), reason, false) };
  }
}
