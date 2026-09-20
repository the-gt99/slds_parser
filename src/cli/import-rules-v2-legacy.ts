import { createPostgresPool } from "../infrastructure/db/index.js";
import { RulesV2LegacyImporter } from "../infrastructure/db/rules-v2-legacy-importer.js";

const pool = createPostgresPool();

try {
  const result = await new RulesV2LegacyImporter(pool).sync("rules-v2-legacy-import");
  console.info(JSON.stringify(result));
} finally {
  await pool.end();
}
