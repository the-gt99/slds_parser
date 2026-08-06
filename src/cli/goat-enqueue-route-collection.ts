import { createPostgresPool } from "../infrastructure/db/index.js";

function route(value: string | undefined): string {
  const result = value?.trim() ?? "";
  if (!/^[a-z][a-z0-9_-]*$/u.test(result)) throw new Error("GOAT_ROUTE_COLLECTION_ROUTE must be a source route code");
  return result;
}

function boolean(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

const selectedRoute = route(process.env.GOAT_ROUTE_COLLECTION_ROUTE);
const apply = boolean(process.env.GOAT_ROUTE_COLLECTION_APPLY, "GOAT_ROUTE_COLLECTION_APPLY", false);
const pool = createPostgresPool();

try {
  const source = await pool.query<{ readonly id: string }>(
    "SELECT id::TEXT FROM sources WHERE code = 'goat' AND enabled = TRUE ORDER BY id LIMIT 1",
  );
  const sourceId = source.rows[0]?.id;
  if (sourceId === undefined) throw new Error("Enabled GOAT source was not found");

  const candidateSql = `
    FROM source_products product
    WHERE product.source_id = $1
      AND COALESCE(product.discovery_metadata->>'route', '') = $2
      AND NOT EXISTS (
        SELECT 1 FROM source_product_parts part WHERE part.source_product_id = product.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM jobs job
        WHERE job.job_type = 'collect_product'
          AND job.status IN ('pending', 'running', 'retry')
          AND job.unique_key = 'source-product:' || product.id::TEXT || ':collect'
      )`;

  const candidates = await pool.query<{ readonly count: string }>(`SELECT COUNT(*)::TEXT AS count ${candidateSql}`, [sourceId, selectedRoute]);
  const candidateCount = candidates.rows[0]?.count ?? "0";
  console.log(`GOAT route collection: route=${selectedRoute}, candidates=${candidateCount}, enqueueProcessing=false`);

  if (!apply) {
    console.log("Dry run: set GOAT_ROUTE_COLLECTION_APPLY=true to enqueue all collection jobs");
  } else {
    const result = await pool.query<{ readonly candidates: string; readonly enqueued: string }>(
      `WITH candidates AS MATERIALIZED (
         SELECT product.id ${candidateSql}
       ), inserted AS (
         INSERT INTO jobs (job_type, payload, status, available_at, unique_key)
         SELECT 'collect_product',
                jsonb_build_object('sourceProductId', id::TEXT, 'enqueueProcessing', FALSE),
                'pending', NOW(), 'source-product:' || id::TEXT || ':collect'
         FROM candidates
         ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry') DO NOTHING
         RETURNING id
       )
       SELECT (SELECT COUNT(*)::TEXT FROM candidates) AS candidates,
              COUNT(*)::TEXT AS enqueued
       FROM inserted`,
      [sourceId, selectedRoute],
    );
    const counts = result.rows[0];
    console.log(`Enqueued collect_product jobs: ${counts?.enqueued ?? "0"}/${counts?.candidates ?? "0"}`);
  }
} finally {
  await pool.end();
}
