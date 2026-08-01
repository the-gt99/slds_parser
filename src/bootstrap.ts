import { CollectionRunner, ExportRunner, JobDispatcher, ProcessingRunner, Worker } from "./application/index.js";
import { loadWorkerConfig, type WorkerEnvironment } from "./config/index.js";
import { SourceAdapterRegistry, SourceProcessorRegistry, TargetExporterRegistry } from "./core/registry/index.js";
import { createPostgresPool, createPostgresRepositories, PostgresUnitOfWork, type PoolEnvironment } from "./infrastructure/db/index.js";
import { GoatSourceAdapter, GoatSourceProcessor } from "./integrations/index.js";
import { ReferenceMappingService } from "./services/index.js";

export type ApplicationEnvironment = PoolEnvironment & WorkerEnvironment;

export function registerPipelineComponents(registries: {
  readonly adapters: SourceAdapterRegistry;
  readonly processors: SourceProcessorRegistry;
  readonly exporters: TargetExporterRegistry;
}): void {
  registries.adapters.register(GoatSourceAdapter.create());
  registries.processors.register(new GoatSourceProcessor());
}

export function createApplication(environment: ApplicationEnvironment = process.env) {
  const pool = createPostgresPool(environment);
  const repositories = createPostgresRepositories(pool);
  const unitOfWork = new PostgresUnitOfWork(pool);
  const adapters = new SourceAdapterRegistry();
  const processors = new SourceProcessorRegistry();
  const exporters = new TargetExporterRegistry();
  registerPipelineComponents({ adapters, processors, exporters });
  const mappings = new ReferenceMappingService(repositories.references);
  const collectionRunner = new CollectionRunner(repositories, unitOfWork, adapters);
  const processingRunner = new ProcessingRunner(repositories, unitOfWork, processors, mappings);
  const exportRunner = new ExportRunner(repositories, exporters, mappings);
  const dispatcher = new JobDispatcher(collectionRunner, processingRunner, exportRunner, repositories.sourceRuns);
  const worker = new Worker(repositories.jobs, dispatcher, loadWorkerConfig(environment));
  return { pool, repositories, unitOfWork, adapters, processors, exporters, mappings, collectionRunner, processingRunner,
    exportRunner, dispatcher, worker, close: () => pool.end() };
}
