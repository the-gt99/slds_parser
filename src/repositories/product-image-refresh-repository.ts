import type { ProductImageJobPayload } from "../application/job-payloads.js";

export interface ProductImageRefreshRepository {
  enqueueDue(payload: ProductImageJobPayload, intervalMs: number): Promise<boolean>;
  recordCheck(sourceProductId: string, status: "unchanged" | "changed" | "refreshed" | "failed", error?: string): Promise<void>;
}
