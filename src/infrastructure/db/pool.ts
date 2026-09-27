import { Pool } from "pg";

export interface PoolEnvironment {
  readonly DATABASE_URL?: string;
}

export function createPostgresPool(
  environment: PoolEnvironment = process.env,
): Pool {
  const connectionString = environment.DATABASE_URL?.trim();

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required to create a PostgreSQL connection pool",
    );
  }

  const pool = new Pool({ connectionString });
  pool.on("error", (error) => {
    console.error(`PostgreSQL idle client error: ${error.message}`);
  });
  return pool;
}
