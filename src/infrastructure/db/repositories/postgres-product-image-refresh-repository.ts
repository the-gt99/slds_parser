import type { ProductImageJobPayload } from "../../../application/job-payloads.js";
import type { ProductImageRefreshRepository } from "../../../repositories/product-image-refresh-repository.js";
import type { SqlExecutor } from "../sql-executor.js";

export class PostgresProductImageRefreshRepository implements ProductImageRefreshRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async enqueueDue(payload: ProductImageJobPayload, intervalMs: number): Promise<boolean> {
    const key = `source-product:${payload.sourceProductId}:images`;
    const result = await this.executor.query(`
      WITH due AS (
        INSERT INTO product_image_refresh_checks(source_product_id, requested_at)
        SELECT $1, NOW() WHERE NOT EXISTS (
          SELECT 1 FROM jobs WHERE job_type IN ('check_product_images','refresh_product_images')
            AND unique_key = $3 AND status IN ('pending','running','retry')
        )
        ON CONFLICT (source_product_id) DO UPDATE SET requested_at = NOW()
          WHERE product_image_refresh_checks.requested_at <= NOW() - $4::BIGINT * INTERVAL '1 millisecond'
        RETURNING source_product_id
      )
      INSERT INTO jobs(job_type,payload,status,available_at,unique_key)
      SELECT 'check_product_images',$2::JSONB,'pending',NOW(),$3 FROM due
      ON CONFLICT (job_type,unique_key) WHERE status IN ('pending','running','retry') DO NOTHING
      RETURNING id`, [payload.sourceProductId, JSON.stringify(payload), key, intervalMs]);
    return result.rows.length > 0;
  }

  async recordCheck(sourceProductId: string, status: "unchanged" | "changed" | "refreshed" | "failed", error?: string): Promise<void> {
    await this.executor.query(`INSERT INTO product_image_refresh_checks(source_product_id,requested_at,checked_at,status,last_error)
      VALUES($1,NOW(),NOW(),$2,$3) ON CONFLICT(source_product_id) DO UPDATE
      SET checked_at=NOW(),status=EXCLUDED.status,last_error=EXCLUDED.last_error`, [sourceProductId, status, error ?? null]);
  }
}
