import type { TransactionRepositories } from "../../../repositories/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import { PostgresInternalProductRepository } from "./postgres-internal-product-repository.js";
import { PostgresJobRepository } from "./postgres-job-repository.js";
import { PostgresReferenceRepository } from "./postgres-reference-repository.js";
import { PostgresSourceProductRepository } from "./postgres-source-product-repository.js";
import { PostgresSourceRepository } from "./postgres-source-repository.js";
import { PostgresSourceRunRepository } from "./postgres-source-run-repository.js";
import { PostgresTargetRepository } from "./postgres-target-repository.js";

export { PostgresInternalProductRepository } from "./postgres-internal-product-repository.js";
export { PostgresJobRepository } from "./postgres-job-repository.js";
export { PostgresReferenceRepository } from "./postgres-reference-repository.js";
export { PostgresSourceProductRepository } from "./postgres-source-product-repository.js";
export { PostgresSourceRepository } from "./postgres-source-repository.js";
export { PostgresSourceRunRepository } from "./postgres-source-run-repository.js";
export { PostgresTargetRepository } from "./postgres-target-repository.js";

export function createPostgresRepositories(executor: SqlExecutor): TransactionRepositories {
  return {
    sources: new PostgresSourceRepository(executor),
    sourceRuns: new PostgresSourceRunRepository(executor),
    sourceProducts: new PostgresSourceProductRepository(executor),
    internalProducts: new PostgresInternalProductRepository(executor),
    references: new PostgresReferenceRepository(executor),
    targets: new PostgresTargetRepository(executor),
    jobs: new PostgresJobRepository(executor),
  };
}
