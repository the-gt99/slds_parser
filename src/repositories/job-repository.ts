import type { EntityId } from "../contracts/index.js";
import type { EnqueueJobInput, JobRecord, JobType, RetryJobInput } from "./types.js";

export interface JobRepository {
  enqueue(input: EnqueueJobInput): Promise<JobRecord>;
  claimNext(workerId: string, lockTimeoutMs: number, jobTypes?: readonly JobType[]): Promise<JobRecord | null>;
  complete(id: EntityId): Promise<void>;
  retry(id: EntityId, input: RetryJobInput): Promise<void>;
  fail(id: EntityId, error: string): Promise<void>;
}
