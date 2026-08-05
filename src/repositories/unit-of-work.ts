import type { ClassificationRepository } from "./classification-repository.js";
import type { InternalProductRepository } from "./internal-product-repository.js";
import type { JobRepository } from "./job-repository.js";
import type { ProductOperationHistoryRepository } from "./product-operation-history-repository.js";
import type { ReferenceRepository } from "./reference-repository.js";
import type { SourceProductRepository } from "./source-product-repository.js";
import type { SourceRunRepository } from "./source-run-repository.js";
import type { SourceRepository } from "./source-repository.js";
import type { TargetRepository } from "./target-repository.js";

export interface TransactionRepositories {
  readonly classifications: ClassificationRepository;
  readonly sources: SourceRepository;
  readonly sourceRuns: SourceRunRepository;
  readonly sourceProducts: SourceProductRepository;
  readonly internalProducts: InternalProductRepository;
  readonly references: ReferenceRepository;
  readonly targets: TargetRepository;
  readonly jobs: JobRepository;
  readonly productOperationHistory: ProductOperationHistoryRepository;
}

export interface UnitOfWork {
  transaction<Result>(
    callback: (repositories: TransactionRepositories) => Promise<Result>,
  ): Promise<Result>;
}
