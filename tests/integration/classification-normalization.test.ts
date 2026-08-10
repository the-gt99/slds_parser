import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresTargetAssignmentRuleRepository, type SqlPool } from "../../src/infrastructure/db/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const integration = databaseUrl === undefined || databaseUrl === "" ? describe.skip : describe;
const schema = `classification_normalization_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve("src/infrastructure/db/migrations");

async function applyThrough(client: PoolClient, lastMigration: string): Promise<void> {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql") && name <= lastMigration)
    .sort();
  for (const name of names) await client.query(await readFile(path.join(migrationsDirectory, name), "utf8"));
}

integration("classification observation normalization migration", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let client: PoolClient;

  beforeAll(async () => {
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
  }, 120_000);

  afterAll(async () => {
    if (client !== undefined) {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      client.release();
    }
    await pool.end();
  }, 120_000);

  it("preserves observations and deduplicates candidate, evidence, and product state", async () => {
    await applyThrough(client, "032_make_classification_rule_resolution_linear.sql");
    await client.query(`
      WITH source AS (
        INSERT INTO sources (code, name, adapter_code) VALUES ('migration-test', 'Migration test', 'test') RETURNING id
      ), product AS (
        INSERT INTO source_products (
          source_id, source_key, status, first_seen_at, last_seen_at
        ) SELECT id, 'product-1', 'collected', NOW(), NOW() FROM source RETURNING id, source_id
      ), internal AS (
        INSERT INTO internal_products (
          source_product_id, data, input_hash, content_hash, processor_version, status
        ) SELECT id, '{}'::JSONB, 'input', 'content', '2.9.0', 'classification_pending' FROM product
      )
      INSERT INTO source_reference_observations (
        source_id, source_product_id, candidate_key, reference_type_id, scope,
        subject_kind, source_value, normalized_source_value, context, context_key,
        evidence, status, issue_reason, classifier_version, classification_fingerprint,
        processor_version
      )
      SELECT product.source_id, product.id, candidate_key, type.id, 'product.brand',
        'product', source_value, normalized_source_value, '{"brand":"Nike"}'::JSONB,
        '{"brand":"Nike"}', '{"title":"Air Max"}'::JSONB, 'unresolved',
        'mapping_missing', '1.0.0', 'fingerprint-1', '2.9.0'
      FROM product
      CROSS JOIN reference_types type
      CROSS JOIN (VALUES
        ('brand-primary', 'Nike', 'nike'),
        ('brand-secondary', 'NIKE', 'nike')
      ) candidate(candidate_key, source_value, normalized_source_value)
      WHERE type.code = 'brand'
    `);

    const previous = await client.query("SELECT id::TEXT FROM source_reference_observations ORDER BY id");
    await client.query(await readFile(path.join(migrationsDirectory, "033_normalize_classification_observations.sql"), "utf8"));

    const relation = await client.query<{ readonly relkind: string }>(
      "SELECT relkind FROM pg_class WHERE oid = 'source_reference_observations'::REGCLASS",
    );
    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*)::INTEGER FROM source_reference_observations) AS observations,
        (SELECT COUNT(*)::INTEGER FROM source_product_classification_links) AS links,
        (SELECT COUNT(*)::INTEGER FROM classification_candidates) AS candidates,
        (SELECT COUNT(*)::INTEGER FROM source_product_classification_evidence) AS evidence,
        (SELECT COUNT(*)::INTEGER FROM source_product_classification_states) AS states
    `);
    const migrated = await client.query("SELECT id::TEXT FROM source_reference_observations ORDER BY id");

    expect(relation.rows[0]?.relkind).toBe("v");
    expect(counts.rows[0]).toEqual({ observations: 2, links: 2, candidates: 1, evidence: 1, states: 1 });
    expect(migrated.rows).toEqual(previous.rows);

    await client.query(await readFile(path.join(migrationsDirectory, "034_remove_legacy_classification_observation_view.sql"), "utf8"));
    await client.query(await readFile(path.join(migrationsDirectory, "035_optimize_classification_review_search.sql"), "utf8"));
    await client.query(await readFile(path.join(migrationsDirectory, "036_target_reference_projections.sql"), "utf8"));
    await client.query(await readFile(path.join(migrationsDirectory, "037_require_rule_source.sql"), "utf8"));
    await client.query("SELECT rebuild_classification_review_read_model()");
    const finalRelations = await client.query(`
      SELECT
        TO_REGCLASS('${schema}.source_reference_observations')::TEXT AS legacy,
        TO_REGCLASS('${schema}.classification_observation_read_model')::TEXT AS read_model,
        TO_REGCLASS('${schema}.target_reference_projections')::TEXT AS reference_projections,
        TO_REGCLASS('${schema}.classification_review_groups_source_value_trgm_idx')::TEXT AS search_index,
        TO_REGCLASS('${schema}.classification_review_groups_source_value_prefix_idx')::TEXT AS prefix_index,
        (SELECT attnotnull FROM pg_attribute
         WHERE attrelid = '${schema}.source_reference_rules'::REGCLASS AND attname = 'source_id') AS rule_source_required,
        (SELECT COUNT(*)::INTEGER FROM classification_observation_read_model) AS observations
    `);
    expect(finalRelations.rows[0]).toEqual({
      legacy: null,
      read_model: "classification_observation_read_model",
      reference_projections: "target_reference_projections",
      search_index: "classification_review_groups_source_value_trgm_idx",
      prefix_index: "classification_review_groups_source_value_prefix_idx",
      rule_source_required: true,
      observations: 2,
    });
  }, 120_000);

  it("applies target assignment schema and runs repository queries", async () => {
    await client.query(await readFile(path.join(migrationsDirectory, "038_target_assignment_rules.sql"), "utf8"));
    const target = (await client.query(
      "INSERT INTO targets (code, name, exporter_code, enabled) VALUES ('assignment-test', 'Assignment test', 'test', FALSE) RETURNING id::TEXT",
    )).rows[0]!;
    const dictionary = (await client.query(
      `INSERT INTO target_dictionary_values (target_id, entity_type, external_id, name, taxonomy)
       VALUES ($1, 'product_categories', '900', 'Special sandals', 'product_cat') RETURNING id::TEXT`,
      [target.id],
    )).rows[0]!;
    const source = (await client.query(
      "INSERT INTO sources (code, name, adapter_code) VALUES ('assignment-source', 'Assignment source', 'test') RETURNING id::TEXT",
    )).rows[0]!;
    const product = (await client.query(
      `INSERT INTO source_products (source_id, source_key, status, first_seen_at, last_seen_at)
       VALUES ($1, 'sandals', 'processed', NOW(), NOW()) RETURNING id::TEXT`,
      [source.id],
    )).rows[0]!;
    await client.query(
      `INSERT INTO internal_products (source_product_id, data, input_hash, content_hash, processor_version, status)
       VALUES ($1, $2::JSONB, 'input', 'content', 'test', 'classified')`,
      [product.id, JSON.stringify({ title: "Special sandals", sku: "SANDAL-1", attributes: {}, metadata: {}, referenceCandidates: [], classification: { resolved: [{ typeCode: "model", referenceValueId: "500" }] } })],
    );

    const repository = new PostgresTargetAssignmentRuleRepository({
      connect: async () => ({ query: client.query.bind(client), release: () => {} }),
      end: async () => {},
    } satisfies SqlPool);
    const draft = {
      targetId: String(target.id), name: "Special sandals", groupCode: "sandal_leaf", priority: 300,
      conditions: [{ field: "resolved.model", operator: "equals" as const, values: ["500"] }],
      actions: [{ targetScope: "product.category", dictionaryValueId: String(dictionary.id), mode: "replace" as const }],
    };

    const preview = await repository.preview(draft);
    const created = await repository.create(draft, "integration-test");
    const disabled = await repository.setEnabled(String(target.id), created.id, false, "integration-test");

    expect(preview).toMatchObject({ productCount: 1, examples: [{ sourceProductId: String(product.id), title: "Special sandals" }] });
    expect((await repository.list(String(target.id))).map((rule) => rule.id)).toEqual([created.id]);
    expect(disabled.enabled).toBe(false);
  }, 120_000);
});
