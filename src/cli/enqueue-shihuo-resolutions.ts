import { createApplication } from "../bootstrap.js";

function runId(): string {
  const index = process.argv.indexOf("--run-id");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || !/^\d+$/u.test(value)) throw new Error("--run-id must be a numeric id");
  return value;
}

const application = createApplication();
try {
  const selectedRunId = runId();
  const result = await application.pool.query<{ queued_count: number }>(
    `WITH candidates AS (
       SELECT DISTINCT item.source_product_id
       FROM wordpress_catalog_run_items item
       LEFT JOIN shihuo_product_links link ON link.source_product_id = item.source_product_id
       WHERE item.run_id = $1
         AND item.match_status = 'matched'
         AND item.source_product_id IS NOT NULL
         AND link.source_product_id IS NULL
     ), queued AS (
       INSERT INTO jobs(job_type, payload, status, available_at, unique_key)
       SELECT 'resolve_shihuo_product',
              JSONB_BUILD_OBJECT('sourceProductId', candidate.source_product_id::TEXT),
              'pending', NOW(),
              'shihuo-resolution:' || $1::TEXT || ':' || candidate.source_product_id::TEXT
       FROM candidates candidate
       ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry')
       DO UPDATE SET unique_key = jobs.unique_key
       RETURNING id
     )
     SELECT COUNT(*)::INTEGER AS queued_count FROM queued`,
    [selectedRunId],
  );
  console.log(JSON.stringify({ runId: selectedRunId, queuedCount: result.rows[0]?.queued_count ?? 0 }));
} finally {
  await application.close();
}
