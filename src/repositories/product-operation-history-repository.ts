import type { EntityId, UniversalProductDTO } from "../contracts/index.js";
import type { StartProductOperationExecutionInput, Timestamp } from "./types.js";

export interface ProductOperationHistoryRepository {
  startAttempt(input: { readonly attemptId: string; readonly sourceProductId: EntityId; readonly processorVersion: string; readonly processorOutput: UniversalProductDTO; readonly startedAt: Timestamp }): Promise<void>;
  completeAttempt(attemptId: string, operationsOutput: UniversalProductDTO, classifiedOutput: UniversalProductDTO, finishedAt: Timestamp): Promise<void>;
  failAttempt(attemptId: string, error: string, finishedAt: Timestamp): Promise<void>;
  start(input: StartProductOperationExecutionInput): Promise<EntityId>;
  complete(id: EntityId, outputData: UniversalProductDTO, finishedAt: Timestamp): Promise<void>;
  fail(id: EntityId, error: string, finishedAt: Timestamp): Promise<void>;
}
