import { createPostgresPool } from "../infrastructure/db/index.js";
import { RulesV2Runtime } from "../infrastructure/db/rules-v2-runtime.js";
import { auditRulesV2Dependencies } from "../services/rules-v2-dependency-audit.js";

const pool = createPostgresPool();
const client = await pool.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const snapshot = await new RulesV2Runtime(client, () => 0).snapshot();
  const rows = auditRulesV2Dependencies(snapshot.records);
  await client.query("COMMIT");
  console.info(JSON.stringify({ writes: false, revision: snapshot.revision, conditions: rows.length,
    rules: new Set(rows.map((row) => row.ruleId)).size,
    references: rows.reduce((sum, row) => sum + row.references, 0),
    missingMappings: rows.reduce((sum, row) => sum + row.missingMappings, 0),
    collidingTerms: rows.reduce((sum, row) => sum + row.collidingTerms, 0),
    rows: rows.filter((row) => row.missingMappings > 0 || row.collidingTerms > 0 || row.operator === "absent") }, null, 2));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
