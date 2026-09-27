import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
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

export interface ShihuoGuestSessionClaim {
  run<Result>(callback: () => Promise<Result>): Promise<Result>;
  releaseUnused(): Promise<void>;
}

interface ReservedSession {
  readonly lease: ShihuoGuestSessionLease;
  consumed: boolean;
  released: boolean;
}

export class ShihuoGuestSessionPool {
  private readonly reservedSession = new AsyncLocalStorage<ReservedSession>();

  constructor(private readonly repository: ShihuoSessionRepository, private readonly crypto: ShihuoSecretCrypto,
    private readonly config: ShihuoConfig, private readonly now: () => number = Date.now) {}
  async acquire(): Promise<ShihuoGuestSessionLease | null> {
    const reserved = this.reservedSession.getStore();
    if (reserved !== undefined && !reserved.consumed && !reserved.released) {
      reserved.consumed = true;
      return reserved.lease;
    }
    return this.acquireDirect();
  }

  async reserveClaim(): Promise<ShihuoGuestSessionClaim | null> {
    const lease = await this.acquireDirect();
    if (lease === null) return null;
    const state: ReservedSession = { lease, consumed: false, released: false };
    const releaseUnused = async (): Promise<void> => {
      if (state.consumed || state.released) return;
      state.released = true;
      await this.repository.releaseUnused(lease.deviceId, lease.owner);
    };
    return {
      run: async <Result>(callback: () => Promise<Result>): Promise<Result> => this.reservedSession.run(state, async () => {
        try { return await callback(); }
        finally { await releaseUnused(); }
      }),
      releaseUnused,
    };
  }

  private async acquireDirect(): Promise<(ShihuoGuestSessionLease & { readonly owner: string }) | null> {
    const owner = randomUUID(); const leased = await this.repository.acquire(owner, this.config.sessionLeaseSeconds); if (!leased) return null;
    const profile = JSON.parse(this.crypto.decrypt(leased.profileCiphertext)) as ShihuoGuestProfile;
    const releaseAt = (seconds: number) => new Date(this.now() + seconds * 1000).toISOString();
    return { deviceId: leased.deviceId, owner, profile,
      success: () => this.repository.releaseSuccess(leased.deviceId, owner, releaseAt(this.config.betweenProductsSeconds)),
      fail: (reason, risk = false) => this.repository.releaseFailure(leased.deviceId, owner, releaseAt(risk ? this.config.riskCooldownSeconds : this.config.failureCooldownSeconds), reason, false) };
  }
}
