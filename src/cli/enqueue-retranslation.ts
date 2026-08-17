import { loadProcessingConfig } from "../config/index.js";
import { DeepLTranslationProvider, LegacyGoogleTranslationProvider } from "../infrastructure/translation/index.js";
import { createPostgresPool } from "../infrastructure/db/index.js";

const apply = process.env.RETRANSLATION_APPLY === "true";
if (process.env.RETRANSLATION_APPLY !== undefined && !["true", "false"].includes(process.env.RETRANSLATION_APPLY)) {
  throw new Error("RETRANSLATION_APPLY must be true or false");
}
const limit = process.env.RETRANSLATION_LIMIT === undefined ? 500_000 : Number(process.env.RETRANSLATION_LIMIT);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500_000) {
  throw new Error("RETRANSLATION_LIMIT must be an integer from 1 to 500000");
}

const processing = loadProcessingConfig();
const provider = processing.translation.provider === "deepl"
  ? new DeepLTranslationProvider(processing.translation)
  : new LegacyGoogleTranslationProvider(processing.translation);
const identity = {
  providerCode: provider.code,
  providerVersion: provider.version,
  sourceLocale: processing.translation.sourceLocale,
  targetLocale: processing.translation.targetLocale,
};

const pool = createPostgresPool();
try {
  const eligibilitySql = `
    FROM internal_products internal
    WHERE COALESCE(internal.data #>> '{translatedContent,providerCode}', '') <> $1
       OR COALESCE(internal.data #>> '{translatedContent,providerVersion}', '') <> $2
       OR COALESCE(internal.data #>> '{translatedContent,sourceLocale}', '') <> $3
       OR COALESCE(internal.data #>> '{translatedContent,targetLocale}', '') <> $4`;
  const parameters = [identity.providerCode, identity.providerVersion, identity.sourceLocale, identity.targetLocale];
  const products = await pool.query<{ count: string }>(`SELECT COUNT(*)::TEXT AS count ${eligibilitySql}`, parameters);
  const texts = await pool.query<{ occurrences: string; occurrence_characters: string; distinct_texts: string; distinct_characters: string }>(
    `WITH eligible AS (SELECT internal.data ${eligibilitySql}),
     values_to_translate AS (
       SELECT value
       FROM eligible
       CROSS JOIN LATERAL (VALUES
         (data ->> 'description'),
         (data #>> '{attributes,story}'),
         (data #>> '{attributes,color}'),
         (data #>> '{attributes,details}'),
         (data #>> '{attributes,upperMaterial}')
       ) input(value)
       WHERE BTRIM(COALESCE(value, '')) <> ''
     ), distinct_values AS (SELECT DISTINCT value FROM values_to_translate)
     SELECT
       (SELECT COUNT(*)::TEXT FROM values_to_translate) AS occurrences,
       (SELECT COALESCE(SUM(CHAR_LENGTH(value)), 0)::TEXT FROM values_to_translate) AS occurrence_characters,
       (SELECT COUNT(*)::TEXT FROM distinct_values) AS distinct_texts,
       (SELECT COALESCE(SUM(CHAR_LENGTH(value)), 0)::TEXT FROM distinct_values) AS distinct_characters`,
    parameters,
  );
  const cache = await pool.query<{ entries: string; characters: string }>(
    `SELECT COUNT(*)::TEXT AS entries, COALESCE(SUM(CHAR_LENGTH(source_text)), 0)::TEXT AS characters
     FROM translation_cache
     WHERE provider_code = $1 AND provider_version = $2 AND source_locale = $3 AND target_locale = $4`,
    parameters,
  );
  console.log(JSON.stringify({
    provider: identity,
    eligibleProducts: Number(products.rows[0]?.count ?? 0),
    sourceTextUpperBound: {
      occurrences: Number(texts.rows[0]?.occurrences ?? 0),
      occurrenceCharacters: Number(texts.rows[0]?.occurrence_characters ?? 0),
      distinctTexts: Number(texts.rows[0]?.distinct_texts ?? 0),
      distinctCharacters: Number(texts.rows[0]?.distinct_characters ?? 0),
    },
    cache: {
      entries: Number(cache.rows[0]?.entries ?? 0),
      characters: Number(cache.rows[0]?.characters ?? 0),
    },
  }));

  if (!apply) {
    console.log("Dry run: set RETRANSLATION_APPLY=true to enqueue retranslate_product jobs");
  } else {
    const enqueued = await pool.query<{ id: string }>(
      `INSERT INTO jobs (job_type, payload, status, available_at, unique_key)
       SELECT 'retranslate_product', jsonb_build_object('sourceProductId', candidate.source_product_id::TEXT),
              'pending', NOW(), 'source-product:' || candidate.source_product_id::TEXT || ':retranslate'
       FROM (
         SELECT internal.source_product_id
         ${eligibilitySql}
         ORDER BY internal.source_product_id
         LIMIT $5
       ) candidate
       ON CONFLICT (job_type, unique_key) WHERE status IN ('pending', 'running', 'retry')
       DO NOTHING
       RETURNING id::TEXT`,
      [...parameters, limit],
    );
    console.log(`Enqueued retranslate_product jobs: ${enqueued.rowCount ?? enqueued.rows.length}`);
  }
} finally {
  await pool.end();
}
