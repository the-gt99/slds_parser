import { createPostgresPool, createPostgresRepositories } from "../infrastructure/db/index.js";
import { enqueueScheduledGoatDiscovery } from "../services/source-discovery-schedule.js";
const pool = createPostgresPool();
try {
  const job = await enqueueScheduledGoatDiscovery(createPostgresRepositories(pool));
  console.info(JSON.stringify({ jobId: job.id, status: job.status }));
} finally { await pool.end(); }
