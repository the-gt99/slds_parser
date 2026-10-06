import type { ContentEnrichmentRecord, ContentEnrichmentRepository } from "../../../repositories/content-enrichment-repository.js";
import type { SqlPool } from "../sql-executor.js";

function map(row: Record<string, unknown>): ContentEnrichmentRecord {
  return { id: String(row.id), sourceProductId: String(row.source_product_id), donorCode: String(row.donor_code),
    donorProductKey: String(row.donor_product_key), article: String(row.article), sourceLocale: String(row.source_locale),
    targetLocale: String(row.target_locale), parserVersion: String(row.parser_version),
    rawPayload: row.raw_payload as ContentEnrichmentRecord["rawPayload"], cleanedText: String(row.cleaned_text),
    translatedText: row.translated_text == null ? null : String(row.translated_text),
    status: row.status as ContentEnrichmentRecord["status"], reason: row.reason == null ? null : String(row.reason) };
}

export class PostgresContentEnrichmentRepository implements ContentEnrichmentRepository {
  constructor(private readonly pool: SqlPool) {}
  async get(id: string): Promise<ContentEnrichmentRecord | null> {
    const client = await this.pool.connect();
    try { const r = await client.query("SELECT * FROM product_content_enrichments WHERE id=$1", [id]);
      return r.rows[0] ? map(r.rows[0]) : null; } finally { client.release(); }
  }
  async latestApplied(sourceProductId: string): Promise<ContentEnrichmentRecord | null> {
    const client = await this.pool.connect();
    try { const r = await client.query(`SELECT * FROM product_content_enrichments
      WHERE source_product_id=$1 AND status='applied' ORDER BY id DESC LIMIT 1`, [sourceProductId]);
      return r.rows[0] ? map(r.rows[0]) : null; } finally { client.release(); }
  }
  async save(input: Parameters<ContentEnrichmentRepository["save"]>[0]): Promise<ContentEnrichmentRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(`INSERT INTO product_content_enrichments
        (source_product_id,donor_code,donor_product_key,article,source_locale,target_locale,parser_version,raw_payload,cleaned_text,status,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
        ON CONFLICT(source_product_id,donor_code,field) DO UPDATE SET
          donor_product_key=EXCLUDED.donor_product_key,article=EXCLUDED.article,source_locale=EXCLUDED.source_locale,
          target_locale=EXCLUDED.target_locale,parser_version=EXCLUDED.parser_version,raw_payload=EXCLUDED.raw_payload,
          cleaned_text=EXCLUDED.cleaned_text,status=EXCLUDED.status,reason=EXCLUDED.reason,
          translated_text=NULL,updated_at=NOW()
        WHERE product_content_enrichments.status <> 'applied' RETURNING *`,
      [input.sourceProductId,input.donorCode,input.donorProductKey,input.article,input.sourceLocale,input.targetLocale,
        input.parserVersion,input.rawPayload,input.cleanedText,input.status,input.reason]);
      const existing = r.rows[0] ?? (await client.query(`SELECT * FROM product_content_enrichments
        WHERE source_product_id=$1 AND donor_code=$2`, [input.sourceProductId,input.donorCode])).rows[0];
      if (!existing) throw new Error("Content enrichment was not saved");
      const record = map(existing);
      if (record.status === "collected") await client.query(`INSERT INTO jobs(job_type,payload,status,unique_key)
        VALUES('translate_product_content',$1::jsonb,'pending',$2) ON CONFLICT DO NOTHING`,
      [{ sourceProductId: record.sourceProductId, enrichmentId: record.id }, `content-enrichment:${record.id}:translate`]);
      await client.query("COMMIT"); return record;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async skip(id: string, reason: string): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query("UPDATE product_content_enrichments SET status='skipped',reason=$2,updated_at=NOW() WHERE id=$1 AND status='collected'", [id,reason]); }
    finally { client.release(); }
  }
  async apply(input: Parameters<ContentEnrichmentRepository["apply"]>[0]): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(`UPDATE internal_products SET data=$3::jsonb,content_hash=$4,updated_at=NOW()
        WHERE id=$1 AND content_hash=$2 RETURNING source_product_id`,
      [input.internalProductId,input.expectedContentHash,input.data,input.contentHash]);
      if (!r.rows[0]) { await client.query("ROLLBACK"); return false; }
      const saved = await client.query(`UPDATE product_content_enrichments SET translated_text=$2,status='applied',reason=NULL,updated_at=NOW()
        WHERE id=$1 AND source_product_id=$3 AND status='collected' RETURNING id`,
      [input.enrichmentId,input.translatedText,r.rows[0].source_product_id]);
      if (!saved.rows[0]) { await client.query("ROLLBACK"); return false; }
      await client.query(`INSERT INTO jobs(job_type,payload,status,unique_key)
        VALUES('retranslate_product',$1::jsonb,'pending',$2) ON CONFLICT DO NOTHING`,
      [{ sourceProductId: String(r.rows[0].source_product_id),reclassifyAfter: true }, `content-enrichment:${input.enrichmentId}:retranslate`]);
      await client.query("COMMIT"); return true;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
}
