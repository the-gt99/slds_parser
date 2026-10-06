import { createApplication } from "../bootstrap.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index+1];
}
const limit = Number(option("--limit") ?? "3");
const targetId = option("--target-id");
const sourceId = option("--source-id");
const onlyProduct = option("--source-product-id") ?? null;
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !targetId || !/^\d+$/u.test(targetId)
  || !sourceId || !/^\d+$/u.test(sourceId) || onlyProduct !== null && !/^\d+$/u.test(onlyProduct)) {
  throw new Error("Provide numeric --source-id, --target-id and --limit 1..10000");
}
const application = createApplication();
try {
  const rows = (await application.pool.query(`SELECT w.source_product_id,w.title,w.issue_count,l.goods_id,l.style_id
    FROM shihuo_product_links l
    JOIN internal_products i USING(source_product_id)
    JOIN rules_v2_workbench_items w USING(source_product_id)
    WHERE l.status='resolved' AND w.source_id=$1 AND w.target_id=$2
      AND w.issue_codes @> ARRAY['description_missing']::TEXT[]
      AND ($4::BIGINT IS NULL OR l.source_product_id=$4)
      AND btrim(COALESCE(i.data->>'description',''))=''
      AND btrim(COALESCE(i.data->'attributes'->>'story',''))=''
      AND btrim(COALESCE(i.data->'translatedContent'->>'description',''))=''
      AND btrim(COALESCE(i.data->'translatedContent'->>'story',''))=''
      AND NOT EXISTS(SELECT 1 FROM target_products t WHERE t.internal_product_id=i.id AND t.target_id=$2)
      AND NOT EXISTS(SELECT 1 FROM product_content_enrichments e WHERE e.source_product_id=l.source_product_id AND e.donor_code='shihuo')
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.job_type='collect_product_content'
        AND j.status IN('pending','running','retry') AND j.payload->>'sourceProductId'=l.source_product_id::TEXT)
    ORDER BY w.issue_count,l.source_product_id LIMIT $3`, [sourceId,targetId,limit,onlyProduct])).rows;
  if (process.argv.includes("--apply")) {
    for (let offset=0;offset<rows.length;offset+=100) await application.repositories.jobs.enqueueMany(rows.slice(offset,offset+100).map((row) => ({
      jobType: "collect_product_content",payload: { sourceProductId: String(row.source_product_id),donorCode: "shihuo" },
      uniqueKey: `source-product:${row.source_product_id}:content:shihuo`,
    })));
  }
  console.log(JSON.stringify({ mode: process.argv.includes("--apply") ? "enqueued" : "preview", count: rows.length,
    sample: rows.slice(0,10) },null,2));
} finally { await application.close(); }
