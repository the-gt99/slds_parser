import { stableJsonStringify } from "../core/utils/index.js";
import type { JsonValue } from "../contracts/index.js";
import { createPostgresPool, createPostgresRepositories } from "../infrastructure/db/index.js";
import type { SqlExecutor, SqlPool } from "../infrastructure/db/sql-executor.js";
import { RulesExecution } from "../infrastructure/db/rules-execution.js";
import { ProductClassifier } from "../services/product-classifier.js";

const ids = (process.env.RULES_V2_SMOKE_IDS ?? "").split(",").filter(Boolean);
if (ids.length === 0 || ids.length > 20 || ids.some((id) => !/^\d+$/u.test(id))) {
  throw new Error("Provide 1 to 20 explicit RULES_V2_SMOKE_IDS");
}
const pool = createPostgresPool();
const client = await pool.connect();
try {
  await client.query("CREATE TEMP TABLE rules_execution_control (LIKE public.rules_execution_control INCLUDING ALL) ON COMMIT PRESERVE ROWS");
  await client.query(`INSERT INTO pg_temp.rules_execution_control
    SELECT singleton, 'v2', revision, legacy_revision, freeze_legacy, updated_at FROM public.rules_execution_control`);
  const bound: SqlPool & SqlExecutor = {
    query: (sql, values) => client.query(sql, values),
    connect: async () => ({ query: (sql, values) => client.query(sql, values), release() {} }),
    end: async () => {},
  };
  const repositories = createPostgresRepositories(client);
  const old = new ProductClassifier(repositories.classifications);
  const selected = new RulesExecution(bound, repositories.classifications);
  const results: { id: string; equal: boolean; engine: string }[] = [];
  for (const id of ids) {
    const sourceProduct = await repositories.sourceProducts.getById(id);
    if (sourceProduct === null) throw new Error(`Source product ${id} is missing`);
    const internal = await repositories.internalProducts.findBySourceProductId(id);
    if (internal === null) throw new Error(`Internal product ${id} is missing`);
    const legacy = await old.classify(sourceProduct.sourceId, internal.data);
    const v2 = await selected.classifier.classify(sourceProduct.sourceId, internal.data);
    const { execution, ...classification } = v2.product.classification;
    const equal = stableJsonStringify({ classification: legacy.product.classification, observations: legacy.observations } as unknown as JsonValue)
      === stableJsonStringify({ classification, observations: v2.observations } as unknown as JsonValue);
    results.push({ id, equal, engine: execution?.mode ?? "missing" });
  }
  console.info(JSON.stringify({ writes: false, results }));
  if (results.some((result) => !result.equal || result.engine !== "v2")) process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
