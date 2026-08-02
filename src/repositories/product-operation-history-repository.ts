import type { EntityId } from "../contracts/index.js";
import type { StartProductOperationExecutionInput, Timestamp } from "./types.js";

export interface ProductOperationHistoryRepository {
  start(input: StartProductOperationExecutionInput): Promise<EntityId>;
  complete(id: EntityId, finishedAt: Timestamp): Promise<void>;
  fail(id: EntityId, error: string, finishedAt: Timestamp): Promise<void>;
}
