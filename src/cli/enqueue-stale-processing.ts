import { registerSourceProcessors } from "../bootstrap.js";
import { SourceProcessorRegistry } from "../core/registry/index.js";
import { createPostgresPool, createPostgresRepositories } from "../infrastructure/db/index.js";

const apply = process.env.STALE_PROCESSING_APPLY === "true";
if (process.env.STALE_PROCESSING_APPLY !== undefined && !["true", "false"].includes(process.env.STALE_PROCESSING_APPLY)) {
  throw new Error("STALE_PROCESSING_APPLY must be true or false");
}

const configuredLimit = process.env.STALE_PROCESSING_LIMIT === undefined
  ? 20_000
  : Number(process.env.STALE_PROCESSING_LIMIT);
if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1 || configuredLimit > 100_000) {
  throw new Error("STALE_PROCESSING_LIMIT must be an integer from 1 to 100000");
}

const pool = createPostgresPool();
try {
  const repositories = createPostgresRepositories(pool);
  const registry = new SourceProcessorRegistry();
  registerSourceProcessors(registry);
  const sources = await repositories.sources.listEnabled();
  const expectedVersions = sources.map((source) => ({
    sourceId: source.id,
    sourceCode: source.code,
    processorVersion: registry.get(source.code).version,
  }));
  const result = await pool.query<{ source_product_id: string; source_code: string; processor_version: string }>(
    `SELECT internal.source_product_id::TEXT AS source_product_id,
            source.code AS source_code,
            internal.processor_version
     FROM internal_products internal
     JOIN source_products product ON product.id = internal.source_product_id
     JOIN sources source ON source.id = product.source_id
     JOIN JSONB_TO_RECORDSET($1::JSONB) expected(source_id BIGINT, processor_version TEXT)
       ON expected.source_id = source.id
     WHERE internal.processor_version IS DISTINCT FROM expected.processor_version
     ORDER BY internal.source_product_id
     LIMIT $2`,
    [JSON.stringify(expectedVersions.map((item) => ({ source_id: item.sourceId, processor_version: item.processorVersion }))), configuredLimit],
  );

  console.log(`Outdated processed products: ${result.rowCount ?? result.rows.length}`);
  for (const expected of expectedVersions) {
    const count = result.rows.filter((row) => row.source_code === expected.sourceCode).length;
    console.log(`${expected.sourceCode}: ${count}, current processor ${expected.processorVersion}`);
  }
  if (!apply) {
    console.log("Dry run: set STALE_PROCESSING_APPLY=true to enqueue process_product jobs");
  } else {
    for (const row of result.rows) {
      await repositories.jobs.enqueue({
        jobType: "process_product",
        payload: { sourceProductId: row.source_product_id, force: false },
        uniqueKey: `source-product:${row.source_product_id}:process`,
      });
    }
    console.log(`Enqueued process_product jobs: ${result.rows.length}`);
  }
} finally {
  await pool.end();
}
