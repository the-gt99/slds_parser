import type { UniversalProductDTO } from "../../../contracts/index.js";
import type { ProductOperationHistoryRepository, StartProductOperationExecutionInput } from "../../../repositories/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import { requireRow } from "./repository-utils.js";

export class PostgresProductOperationHistoryRepository implements ProductOperationHistoryRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async startAttempt(input: { readonly attemptId: string; readonly sourceProductId: string; readonly processorVersion: string; readonly processorOutput: UniversalProductDTO; readonly startedAt: string }): Promise<void> {
    await this.executor.query(
      `INSERT INTO product_processing_attempts (
         attempt_id, source_product_id, processor_version, status, processor_output, started_at
       ) VALUES ($1, $2, $3, 'running', $4, $5)`,
      [input.attemptId, input.sourceProductId, input.processorVersion, input.processorOutput, input.startedAt],
    );
  }

  async completeAttempt(attemptId: string, operationsOutput: UniversalProductDTO, classifiedOutput: UniversalProductDTO, finishedAt: string): Promise<void> {
    const result = await this.executor.query<Record<string, unknown>>(
      `UPDATE product_processing_attempts
       SET status = 'completed', operations_output = $2, classified_output = $3,
           finished_at = $4, error = NULL
       WHERE attempt_id = $1 AND status = 'running'
       RETURNING attempt_id`,
      [attemptId, operationsOutput, classifiedOutput, finishedAt],
    );
    requireRow(result.rows, "product processing attempt", attemptId);
  }

  async failAttempt(attemptId: string, error: string, finishedAt: string): Promise<void> {
    const result = await this.executor.query<Record<string, unknown>>(
      `UPDATE product_processing_attempts
       SET status = 'failed', finished_at = $3, error = $2
       WHERE attempt_id = $1 AND status = 'running'
       RETURNING attempt_id`,
      [attemptId, error.slice(0, 2_000), finishedAt],
    );
    requireRow(result.rows, "product processing attempt", attemptId);
  }

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

  async complete(id: string, outputData: UniversalProductDTO, finishedAt: string): Promise<void> {
    const result = await this.executor.query<Record<string, unknown>>(
      `UPDATE product_operation_executions
       SET status = 'completed', output_data = $2, finished_at = $3, error = NULL
       WHERE id = $1 AND status = 'running'
       RETURNING id`,
      [id, outputData, finishedAt],
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
