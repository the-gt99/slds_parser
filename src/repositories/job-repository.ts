import type { EntityId } from "../contracts/index.js";
import type { EnqueueJobInput, JobRecord, JobType, RetryJobInput } from "./types.js";

export interface JobRepository {
  enqueue(input: EnqueueJobInput): Promise<JobRecord>;
  enqueueMany(inputs: readonly EnqueueJobInput[]): Promise<readonly JobRecord[]>;
  claimNext(workerId: string, lockTimeoutMs: number, jobTypes?: readonly JobType[]): Promise<JobRecord | null>;
  claimMany(workerId: string, lockTimeoutMs: number, jobType: JobType, limit: number): Promise<readonly JobRecord[]>;
  claimById(id: EntityId, workerId: string, jobTypes: readonly JobType[]): Promise<JobRecord | null>;
  complete(id: EntityId): Promise<void>;
  retry(id: EntityId, input: RetryJobInput): Promise<void>;
  fail(id: EntityId, error: string): Promise<void>;
}
