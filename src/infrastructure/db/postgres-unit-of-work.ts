import type { TransactionRepositories, UnitOfWork } from "../../repositories/index.js";
import { createPostgresRepositories } from "./repositories/index.js";
import type { SqlPool } from "./sql-executor.js";

/**
 * Restricts atomic database changes to a short transaction. Perform HTTP calls
 * and other slow external work before opening this transaction.
 */
export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: SqlPool) {}

  async transaction<Result>(callback: (repositories: TransactionRepositories) => Promise<Result>): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const result = await callback(createPostgresRepositories(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } finally {
          throw error;
        }
      }
    } finally {
      client.release();
    }
  }
}
