import type { TransactionRepositories } from "../../../repositories/index.js";
import type { SqlExecutor } from "../sql-executor.js";
import { PostgresClassificationRepository } from "./postgres-classification-repository.js";
import { PostgresClassificationAdminRepository } from "./postgres-classification-admin-repository.js";
import { PostgresInternalProductRepository } from "./postgres-internal-product-repository.js";
import { PostgresJobRepository } from "./postgres-job-repository.js";
import { PostgresGoatProxyRepository } from "./postgres-goat-proxy-repository.js";
import { PostgresProductOperationHistoryRepository } from "./postgres-product-operation-history-repository.js";
import { PostgresProductAdminRepository } from "./postgres-product-admin-repository.js";
import { PostgresExportControlRepository } from "./postgres-export-control-repository.js";
import { PostgresReferenceRepository } from "./postgres-reference-repository.js";
import { PostgresSourceProductRepository } from "./postgres-source-product-repository.js";
import { PostgresSourceRepository } from "./postgres-source-repository.js";
import { PostgresSourceRunRepository } from "./postgres-source-run-repository.js";
import { PostgresTargetRepository } from "./postgres-target-repository.js";
import { PostgresTargetContentTemplateRepository } from "./postgres-target-content-template-repository.js";
import { PostgresTargetDictionaryRepository } from "./postgres-target-dictionary-repository.js";
import { PostgresTargetAssignmentRuleRepository } from "./postgres-target-assignment-rule-repository.js";
import { PostgresTargetClassificationImportRepository } from "./postgres-target-classification-import-repository.js";
import { PostgresWordPressCatalogRepository } from "./postgres-wordpress-catalog-repository.js";
import { PostgresShihuoDeviceRepository } from "./postgres-shihuo-device-repository.js";
import { PostgresShihuoProductLinkRepository, PostgresShihuoSessionRepository } from "./postgres-shihuo-product-repository.js";

export { PostgresClassificationRepository } from "./postgres-classification-repository.js";
export { PostgresClassificationAdminRepository } from "./postgres-classification-admin-repository.js";
export { PostgresInternalProductRepository } from "./postgres-internal-product-repository.js";
export { PostgresJobRepository } from "./postgres-job-repository.js";
export { PostgresGoatProxyRepository } from "./postgres-goat-proxy-repository.js";
export { PostgresProductOperationHistoryRepository } from "./postgres-product-operation-history-repository.js";
export { PostgresProductAdminRepository } from "./postgres-product-admin-repository.js";
export { PostgresExportControlRepository } from "./postgres-export-control-repository.js";
export { PostgresReferenceRepository } from "./postgres-reference-repository.js";
export { PostgresRuntimeWorkerSettingsRepository } from "./postgres-runtime-worker-settings-repository.js";
export { PostgresSourceProductRepository } from "./postgres-source-product-repository.js";
export { PostgresSourceRepository } from "./postgres-source-repository.js";
export { PostgresSourceRunRepository } from "./postgres-source-run-repository.js";
export { PostgresTargetRepository } from "./postgres-target-repository.js";
export { PostgresTargetContentTemplateRepository } from "./postgres-target-content-template-repository.js";
export { PostgresTargetDictionaryRepository } from "./postgres-target-dictionary-repository.js";
export { PostgresTargetAssignmentRuleRepository } from "./postgres-target-assignment-rule-repository.js";
export { PostgresRulesV2Repository } from "./postgres-rules-v2-repository.js";
export { PostgresTargetClassificationImportRepository } from "./postgres-target-classification-import-repository.js";
export { PostgresWordPressCatalogRepository } from "./postgres-wordpress-catalog-repository.js";
export { PostgresShihuoDeviceRepository } from "./postgres-shihuo-device-repository.js";
export { PostgresShihuoProductLinkRepository, PostgresShihuoSessionRepository } from "./postgres-shihuo-product-repository.js";

export function createPostgresRepositories(executor: SqlExecutor): TransactionRepositories {
  return {
    classifications: new PostgresClassificationRepository(executor),
    sources: new PostgresSourceRepository(executor),
    sourceRuns: new PostgresSourceRunRepository(executor),
    sourceProducts: new PostgresSourceProductRepository(executor),
    internalProducts: new PostgresInternalProductRepository(executor),
    references: new PostgresReferenceRepository(executor),
    targets: new PostgresTargetRepository(executor),
    contentTemplates: new PostgresTargetContentTemplateRepository(executor),
    jobs: new PostgresJobRepository(executor),
    productOperationHistory: new PostgresProductOperationHistoryRepository(executor),
  };
}
