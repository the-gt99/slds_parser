import type { EntityId } from "../contracts/index.js";

export type ShihuoResolutionStatus = "pending" | "resolved" | "not_found" | "article_mismatch" | "temporarily_blocked" | "failed";

export interface ShihuoProductLink {
  readonly sourceProductId: EntityId;
  readonly sourceArticle: string;
  readonly normalizedArticle: string;
  readonly goodsId: string | null;
  readonly styleId: string | null;
  readonly status: ShihuoResolutionStatus;
  readonly confirmedArticle: string | null;
  readonly confirmedAt: string | null;
  readonly lastCardLoadedAt: string | null;
  readonly lastErrorCode: string | null;
}

export interface ShihuoProductVariant {
  readonly skuId: string;
  readonly size: string | null;
  readonly color: string | null;
  readonly price: string | null;
  readonly currency: "CNY";
  readonly available: boolean;
  readonly quantity: null;
}

export interface ShihuoSupplier {
  readonly name: string | null;
  readonly store: string | null;
  readonly price: string | null;
  readonly currency: "CNY";
}

export interface ShihuoProductCard {
  readonly article: string;
  readonly goodsId: string;
  readonly styleId: string;
  readonly title: string | null;
  readonly brand: string | null;
  readonly model: string | null;
  readonly currency: "CNY";
  readonly minPrice: string | null;
  readonly variants: readonly ShihuoProductVariant[];
  readonly suppliers: readonly ShihuoSupplier[];
  readonly attributes: Readonly<Record<string, readonly string[]>>;
  readonly detailUrl: string;
  readonly httpStatus: number;
}

export interface ShihuoResolutionResult {
  readonly status: Exclude<ShihuoResolutionStatus, "pending">;
  readonly sourceProductId: EntityId;
  readonly article: string;
  readonly goodsId?: string;
  readonly styleId?: string;
  readonly errorCode?: string;
  readonly card?: ShihuoProductCard;
}

export interface ShihuoLeasedSession {
  readonly deviceId: EntityId;
  readonly leaseOwner: string;
  readonly profileCiphertext: string;
}

export interface ShihuoSessionRepository {
  acquire(owner: string, leaseSeconds: number): Promise<ShihuoLeasedSession | null>;
  releaseSuccess(deviceId: EntityId, owner: string, nextAvailableAt: string): Promise<void>;
  releaseFailure(deviceId: EntityId, owner: string, nextAvailableAt: string, reason: string, pause: boolean): Promise<void>;
}

export interface ShihuoProductLinkRepository {
  get(sourceProductId: EntityId): Promise<ShihuoProductLink | null>;
  savePending(sourceProductId: EntityId, article: string, normalizedArticle: string): Promise<ShihuoProductLink>;
  saveResolved(input: { readonly sourceProductId: EntityId; readonly article: string; readonly normalizedArticle: string; readonly confirmedArticle: string; readonly goodsId: string; readonly styleId: string; readonly loadedAt: string }): Promise<ShihuoProductLink>;
  saveOutcome(sourceProductId: EntityId, status: Exclude<ShihuoResolutionStatus, "pending" | "resolved">, errorCode: string | null): Promise<ShihuoProductLink>;
  touchCard(sourceProductId: EntityId, loadedAt: string): Promise<void>;
}
