import type { EntityId } from "../contracts/index.js";
import type {
  FailedJobRetryPreview,
  JobAdminListQuery,
  JobAdminListResult,
  JobType,
  ProductAdminReadModel,
  ProductBatchAuditInput,
  ProductBatchCandidate,
  ProductBatchFilter,
  ProductListQuery,
  ProductListResult,
  ProductSnapshotListQuery,
  ProductSnapshotListResult,
} from "./types.js";

export interface ProductAdminRepository {
  getById(sourceProductId: EntityId): Promise<ProductAdminReadModel | null>;
  listProducts?(query: ProductListQuery): Promise<ProductListResult>;
  listSnapshots?(query: ProductSnapshotListQuery): Promise<ProductSnapshotListResult>;
  listBatchCandidates?(filter: ProductBatchFilter): Promise<{ readonly total: number; readonly items: readonly ProductBatchCandidate[] }>;
  saveBatchAudit?(input: ProductBatchAuditInput): Promise<EntityId>;
  listJobs?(query: JobAdminListQuery): Promise<JobAdminListResult>;
  previewFailedJobRetry?(jobType: JobType, limit: number): Promise<FailedJobRetryPreview>;
  listFailedJobRetryIds?(jobType: JobType, limit: number): Promise<readonly EntityId[]>;
}
