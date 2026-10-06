import { createApplication } from "../bootstrap.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index+1];
}
const limit = Number(option("--limit") ?? "3");
const targetId = option("--target-id");
const sourceId = option("--source-id");
const onlyProduct = option("--source-product-id") ?? null;
const resolveMissing = process.argv.includes("--resolve-missing");
if (resolveMissing && !process.argv.includes("--new-only")) throw new Error("--resolve-missing requires --new-only");
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !targetId || !/^\d+$/u.test(targetId)
  || !sourceId || !/^\d+$/u.test(sourceId) || onlyProduct !== null && !/^\d+$/u.test(onlyProduct)) {
  throw new Error("Provide numeric --source-id, --target-id and --limit 1..10000");
}
const application = createApplication();
try {
  const rows: Record<string,unknown>[] = [];
  let cursor = "0";
  const client = await application.pool.connect();
  try {
    await client.query("SET statement_timeout='20s'");
    while (rows.length < limit) {
      // Bound each read before joining large DTOs. Keyset pagination avoids a
      // full-catalog sort and never holds locks across the whole cohort.
      const page = (await client.query(`WITH links AS MATERIALIZED (
        SELECT w.source_product_id,l.goods_id,l.style_id FROM rules_v2_workbench_items w
        LEFT JOIN shihuo_product_links l USING(source_product_id)
        WHERE w.source_id=$1 AND w.target_id=$2 AND w.issue_codes @> ARRAY['description_missing']::TEXT[]
          AND w.source_product_id>$5::BIGINT
          AND (($7::BOOLEAN AND l.source_product_id IS NULL) OR (NOT $7::BOOLEAN AND l.status='resolved'))
          AND ($4::BIGINT IS NULL OR w.source_product_id=$4)
        ORDER BY w.source_product_id LIMIT 200
      ), eligible AS MATERIALIZED (
        SELECT w.source_product_id,w.title,w.issue_count,l.goods_id,l.style_id,i.id AS internal_product_id
        FROM links l JOIN internal_products i USING(source_product_id)
        JOIN rules_v2_workbench_items w USING(source_product_id)
        WHERE w.source_id=$1 AND w.target_id=$2
      AND w.issue_codes @> ARRAY['description_missing']::TEXT[]
      AND NOT EXISTS(SELECT 1 FROM target_products t WHERE t.internal_product_id=i.id AND t.target_id=$2)
      AND (NOT $6::BOOLEAN OR NOT EXISTS(
        SELECT 1 FROM wordpress_catalog_run_items c JOIN wordpress_catalog_runs r ON r.id=c.run_id
        WHERE r.target_id=$2 AND c.source_product_id=l.source_product_id AND c.match_status='matched'))
      AND (NOT $6::BOOLEAN OR NOT EXISTS(
        SELECT 1 FROM target_product_preflight_reviews p
        WHERE p.target_id=$2 AND p.internal_product_id=i.id AND p.will_create=FALSE AND p.external_id IS NOT NULL))
      AND NOT EXISTS(SELECT 1 FROM product_content_enrichments e WHERE e.source_product_id=l.source_product_id AND e.donor_code='shihuo')
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.job_type='collect_product_content'
        AND j.status IN('pending','running','retry') AND j.unique_key='source-product:' || l.source_product_id::TEXT || ':content:shihuo')
      ), candidates AS (
        SELECT e.source_product_id,e.title,e.issue_count,e.goods_id,e.style_id
        FROM eligible e JOIN internal_products i ON i.id=e.internal_product_id
        CROSS JOIN LATERAL jsonb_to_record(i.data)
          AS content(description TEXT,sku TEXT,attributes JSONB,"translatedContent" JSONB)
        WHERE btrim(COALESCE(content.description,''))=''
          AND (NOT $7::BOOLEAN OR btrim(COALESCE(content.sku,''))<>'')
          AND btrim(COALESCE(content.attributes->>'story',''))=''
          AND btrim(COALESCE(content."translatedContent"->>'description',''))=''
          AND btrim(COALESCE(content."translatedContent"->>'story',''))=''
      ) SELECT (SELECT MAX(source_product_id)::TEXT FROM links) AS cursor,
        COALESCE((SELECT jsonb_agg(candidate) FROM (SELECT * FROM candidates
          ORDER BY issue_count,source_product_id LIMIT $3) candidate),'[]'::JSONB) AS candidates`,
      [sourceId,targetId,limit-rows.length,onlyProduct,cursor,process.argv.includes("--new-only"),resolveMissing])).rows[0];
      if (!page?.cursor) break;
      rows.push(...page.candidates as Record<string,unknown>[]);
      cursor = String(page.cursor);
    }
  } finally {
    await client.query("RESET statement_timeout"); client.release();
  }
  if (process.argv.includes("--apply")) {
    for (let offset=0;offset<rows.length;offset+=100) await application.repositories.jobs.enqueueMany(rows.slice(offset,offset+100).map((row) => ({
      jobType: "collect_product_content",payload: { sourceProductId: String(row.source_product_id),donorCode: "shihuo",
        ...(resolveMissing ? { resolveIfMissing: true } : {}) },
      uniqueKey: `source-product:${row.source_product_id}:content:shihuo`,
    })));
  }
  console.log(JSON.stringify({ mode: process.argv.includes("--apply") ? "enqueued" : "preview", count: rows.length,
    sample: rows.slice(0,10) },null,2));
} finally { await application.close(); }
