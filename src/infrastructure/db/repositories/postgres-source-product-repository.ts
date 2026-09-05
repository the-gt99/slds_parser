import { SourceIdentityConflictError } from "../../../core/errors/index.js";
import type { EntityId } from "../../../contracts/index.js";
import type { SourceProductCollectionCandidate, SourceProductCollectionCandidateQuery, SourceProductPartRecord, SourceProductRecord, SourceProductRepository, UpdateSourceProductIdentityInput, UpsertDiscoveredSourceProductInput, UpsertDiscoveredSourceProductResult, UpsertSourceProductPartInput, UpsertSourceProductPartResult } from "../../../repositories/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import { isExternalIdentityConflict, requireRow } from "./repository-utils.js";
import { mapSourceProduct, mapSourceProductPart, type DatabaseRow } from "./row-mappers.js";

export class PostgresSourceProductRepository implements SourceProductRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async getById(id: EntityId): Promise<SourceProductRecord | null> {
    const result = await this.executor.query<DatabaseRow>("SELECT * FROM source_products WHERE id = $1", [id]);
    return result.rows[0] ? mapSourceProduct(result.rows[0]) : null;
  }

  async listCollectionCandidates(input: SourceProductCollectionCandidateQuery): Promise<readonly SourceProductCollectionCandidate[]> {
    const uncollected = `NOT EXISTS (
      SELECT 1 FROM source_product_parts part WHERE part.source_product_id = product.id
    ) AND NOT EXISTS (
      SELECT 1 FROM jobs job
      WHERE job.job_type = 'collect_product'
        AND job.status IN ('pending', 'running', 'retry')
        AND job.unique_key = 'source-product:' || product.id::TEXT || ':collect'
    )`;
    const explicitIds = input.sourceProductIds;
    const result = explicitIds !== undefined
      ? await this.executor.query<DatabaseRow>(
          `WITH selected AS (
             SELECT id, ordinal FROM UNNEST($2::BIGINT[]) WITH ORDINALITY AS item(id, ordinal)
           )
           SELECT product.id, product.source_key,
                  COALESCE(product.discovery_metadata->>'route', '') AS route
           FROM selected
           JOIN source_products product ON product.id = selected.id
           WHERE product.source_id = $1 AND ${uncollected}
           ORDER BY selected.ordinal`,
          [input.sourceId, explicitIds],
        )
      : await this.executor.query<DatabaseRow>(
          `WITH requested_routes AS (
             SELECT route, ordinal,
                    ($3::INTEGER / CARDINALITY($2::TEXT[]))
                      + CASE WHEN ordinal <= ($3::INTEGER % CARDINALITY($2::TEXT[])) THEN 1 ELSE 0 END AS quota
             FROM UNNEST($2::TEXT[]) WITH ORDINALITY AS item(route, ordinal)
           ), ranked AS (
             SELECT product.id, product.source_key,
                    COALESCE(product.discovery_metadata->>'route', '') AS route,
                    requested_routes.ordinal AS route_ordinal,
                    ROW_NUMBER() OVER (
                      PARTITION BY requested_routes.route
                      ORDER BY HASHTEXTEXTENDED(product.source_key, $4::BIGINT), product.id
                    ) AS route_rank,
                    requested_routes.quota
             FROM source_products product
             JOIN requested_routes
               ON requested_routes.route = COALESCE(product.discovery_metadata->>'route', '')
             WHERE product.source_id = $1 AND ${uncollected}
           )
           SELECT id, source_key, route
           FROM ranked
           WHERE route_rank <= quota
           ORDER BY route_rank, route_ordinal, id
           LIMIT $3`,
          [input.sourceId, input.routes ?? [], input.limit, input.seed],
        );
    return result.rows.map((row) => ({ id: String(row.id), sourceKey: String(row.source_key), route: String(row.route) }));
  }

  async listParts(sourceProductId: EntityId): Promise<readonly SourceProductPartRecord[]> {
    const result = await this.executor.query<DatabaseRow>("SELECT * FROM source_product_parts WHERE source_product_id = $1 ORDER BY part_key", [sourceProductId]);
    return result.rows.map(mapSourceProductPart);
  }

  async upsertDiscovered(input: UpsertDiscoveredSourceProductInput): Promise<UpsertDiscoveredSourceProductResult> {
    try {
      const result = await this.executor.query<DatabaseRow>(`WITH product_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtextextended($1::TEXT || ':' || $2, 0))
      ), previous AS MATERIALIZED (
        SELECT discovery_fingerprint FROM source_products, product_lock WHERE source_id = $1 AND source_key = $2
      ), upserted AS (
        INSERT INTO source_products (source_id, source_key, external_id, slug, url, discovery_metadata, discovery_fingerprint, discovery_changed_at, status, first_seen_at, last_seen_at, last_seen_run_id)
        SELECT $1, $2, $3, $4, $5, $6::jsonb, $10, $8, $7, $8, $8, $9 FROM product_lock
        ON CONFLICT (source_id, source_key) DO UPDATE SET
          external_id = COALESCE(EXCLUDED.external_id, source_products.external_id),
          slug = COALESCE(EXCLUDED.slug, source_products.slug),
          url = COALESCE(EXCLUDED.url, source_products.url),
          discovery_metadata = EXCLUDED.discovery_metadata,
          discovery_fingerprint = EXCLUDED.discovery_fingerprint,
          discovery_changed_at = CASE WHEN source_products.discovery_fingerprint IS DISTINCT FROM EXCLUDED.discovery_fingerprint THEN EXCLUDED.last_seen_at ELSE source_products.discovery_changed_at END,
          status = EXCLUDED.status, last_seen_at = EXCLUDED.last_seen_at,
          last_seen_run_id = EXCLUDED.last_seen_run_id, updated_at = NOW()
        RETURNING *
      ) SELECT upserted.*,
          NOT EXISTS (SELECT 1 FROM previous) AS created,
          NOT EXISTS (SELECT 1 FROM previous WHERE discovery_fingerprint IS NOT DISTINCT FROM $10) AS discovery_changed
        FROM upserted`, [input.sourceId, input.sourceKey, input.externalId ?? null, input.slug ?? null, input.url ?? null, input.discoveryMetadata, input.status, input.seenAt, input.runId, input.discoveryFingerprint]);
      const row = requireRow(result.rows, "source product", input.sourceKey);
      return { product: mapSourceProduct(row), created: Boolean(row.created), discoveryChanged: Boolean(row.discovery_changed) };
    } catch (error) {
      if (isExternalIdentityConflict(error) && input.externalId !== undefined && input.externalId !== null) throw new SourceIdentityConflictError(input.sourceId, input.externalId, { cause: error });
      throw error;
    }
  }

  async updateIdentity(id: EntityId, input: UpdateSourceProductIdentityInput): Promise<SourceProductRecord> {
    const assignments: string[] = [];
    const values: unknown[] = [id];
    for (const [column, value] of [["external_id", input.externalId], ["slug", input.slug], ["url", input.url]] as const) {
      if (value !== undefined) { values.push(value); assignments.push(`${column} = $${values.length}`); }
    }
    if (assignments.length === 0) {
      const existing = await this.getById(id);
      if (!existing) throw new Error(`source product not found: ${id}`);
      return existing;
    }
    assignments.push("updated_at = NOW()");
    let sourceId: string | null = null;
    if (input.externalId !== undefined && input.externalId !== null) {
      const source = await this.executor.query<DatabaseRow>("SELECT source_id FROM source_products WHERE id = $1", [id]);
      sourceId = source.rows[0] ? String(source.rows[0].source_id) : null;
    }
    try {
      const result = await this.executor.query<DatabaseRow>(`UPDATE source_products SET ${assignments.join(", ")} WHERE id = $1 RETURNING *`, values);
      return mapSourceProduct(requireRow(result.rows, "source product", id));
    } catch (error) {
      if (isExternalIdentityConflict(error) && input.externalId !== undefined && input.externalId !== null) {
        throw new SourceIdentityConflictError(sourceId ?? "unknown", input.externalId, { cause: error });
      }
      throw error;
    }
  }

  async upsertPart(input: UpsertSourceProductPartInput): Promise<UpsertSourceProductPartResult> {
    const result = await this.executor.query<DatabaseRow>(`WITH part_lock AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended(($1::bigint)::text || ':' || $2, 0))), previous AS MATERIALIZED (SELECT content_hash FROM source_product_parts, part_lock WHERE source_product_id = $1::bigint AND part_key = $2), upserted AS (INSERT INTO source_product_parts (source_product_id, part_key, raw_payload, parsed_payload, content_hash, source_updated_at, fetched_at, adapter_version) SELECT $1::bigint, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8 FROM part_lock ON CONFLICT (source_product_id, part_key) DO UPDATE SET raw_payload = EXCLUDED.raw_payload, parsed_payload = EXCLUDED.parsed_payload, content_hash = EXCLUDED.content_hash, source_updated_at = EXCLUDED.source_updated_at, fetched_at = EXCLUDED.fetched_at, adapter_version = EXCLUDED.adapter_version, updated_at = NOW() RETURNING *) SELECT upserted.*, (previous.content_hash IS NULL OR previous.content_hash IS DISTINCT FROM $5) AS changed FROM upserted LEFT JOIN previous ON TRUE`, [input.sourceProductId, input.partKey, JSON.stringify(input.rawPayload), JSON.stringify(input.parsedPayload), input.contentHash, input.sourceUpdatedAt ?? null, input.fetchedAt, input.adapterVersion]);
    const row = requireRow(result.rows, "source product part", `${input.sourceProductId}/${input.partKey}`);
    return { part: mapSourceProductPart(row), changed: Boolean(row.changed) };
  }
}
