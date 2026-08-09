import { createPostgresPool } from "../infrastructure/db/index.js";

const pool = createPostgresPool();
const client = await pool.connect();

try {
  await client.query("BEGIN");
  try {
    await client.query("SELECT rebuild_classification_review_read_model()");
    await client.query("COMMIT");
    console.info("Проекция очереди классификатора пересобрана");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
} finally {
  client.release();
  await pool.end();
}
