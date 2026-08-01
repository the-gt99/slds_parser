import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPostgresPool,
  runMigrations,
} from "../infrastructure/db/index.js";

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../infrastructure/db/migrations",
);

const pool = createPostgresPool();

try {
  const applied = await runMigrations({ pool, migrationsDirectory });
  console.info(
    applied.length === 0
      ? "No pending migrations"
      : `Applied migrations: ${applied.join(", ")}`,
  );
} finally {
  await pool.end();
}
