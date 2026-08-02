import type { ProductOperationHistoryRepository, StartProductOperationExecutionInput } from "../../../repositories/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import { requireRow } from "./repository-utils.js";

export class PostgresProductOperationHistoryRepository implements ProductOperationHistoryRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async start(input: StartProductOperationExecutionInput): Promise<string> {
    const result = await this.executor.query<Record<string, unknown>>(
      `INSERT INTO product_operation_executions (
         attempt_id, source_product_id, operation_code, operation_name,
         operation_version, sequence, status, started_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'running', $7)
       RETURNING id`,
      [
        input.attemptId,
        input.sourceProductId,
        input.operationCode,
        input.operationName,
        input.operationVersion,
        input.sequence,
        input.startedAt,
      ],
    );
    return String(requireRow(result.rows, "product operation execution", input.operationCode).id);
  }

  async complete(id: string, finishedAt: string): Promise<void> {
    const result = await this.executor.query<Record<string, unknown>>(
      `UPDATE product_operation_executions
       SET status = 'completed', finished_at = $2, error = NULL
       WHERE id = $1 AND status = 'running'
       RETURNING id`,
      [id, finishedAt],
    );
    requireRow(result.rows, "product operation execution", id);
  }

  async fail(id: string, error: string, finishedAt: string): Promise<void> {
    const result = await this.executor.query<Record<string, unknown>>(
      `UPDATE product_operation_executions
       SET status = 'failed', finished_at = $3, error = $2
       WHERE id = $1 AND status = 'running'
       RETURNING id`,
      [id, error.slice(0, 2_000), finishedAt],
    );
    requireRow(result.rows, "product operation execution", id);
  }
}
