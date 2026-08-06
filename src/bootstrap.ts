import { CollectionRunner, ExportRunner, JobDispatcher, ProcessingRunner, ProductOperationPipeline, Worker } from "./application/index.js";
import { loadProcessingConfig, loadWorkerConfig, loadWordPressTargetConfig, type ProcessingEnvironment, type WorkerEnvironment, type WordPressTargetEnvironment } from "./config/index.js";
import { ProductOperationRegistry, SourceAdapterRegistry, SourceProcessorRegistry, TargetExporterRegistry } from "./core/registry/index.js";
import { createPostgresPool, createPostgresRepositories, PostgresProductOperationHistoryRepository, PostgresUnitOfWork, type PoolEnvironment } from "./infrastructure/db/index.js";
import { LocalImageStore } from "./infrastructure/media/index.js";
import { LegacyGoogleTranslationProvider } from "./infrastructure/translation/index.js";
import { GoatImageDownloader, GoatSourceAdapter, GoatSourceProcessor, WordPressExporter, type GoatHttpEnvironment } from "./integrations/index.js";
import { ConvertImagesToWebpOperation, DownloadImagesOperation, NormalizeProductOperation, PublishImagesOperation, TranslateContentOperation, ValidateProcessedProductOperation } from "./processing/index.js";
import { ProductClassifier, TargetReferenceMappingService } from "./services/index.js";

export type PipelineEnvironment = ProcessingEnvironment & GoatHttpEnvironment & WordPressTargetEnvironment;
export type ApplicationEnvironment = PoolEnvironment & WorkerEnvironment & PipelineEnvironment;

export function registerProductOperations(registry: ProductOperationRegistry, environment: ProcessingEnvironment & GoatHttpEnvironment = process.env): void {
  const processing = loadProcessingConfig(environment);
  const imageStore = new LocalImageStore(processing.image);
  const translationProvider = new LegacyGoogleTranslationProvider(processing.translation);
  registry.register(new NormalizeProductOperation());
  registry.register(new TranslateContentOperation(translationProvider, { ...processing.translation, sourceCodes: ["goat"] }));
  registry.register(new DownloadImagesOperation(
    new GoatImageDownloader(environment, { concurrency: processing.image.concurrency }),
    imageStore,
    { concurrency: processing.image.concurrency, sourceCodes: ["goat"] },
  ));
  registry.register(new ConvertImagesToWebpOperation(imageStore, { concurrency: processing.image.concurrency, sourceCodes: ["goat"] }));
  registry.register(new PublishImagesOperation(imageStore, ["goat"]));
  registry.register(new ValidateProcessedProductOperation(["goat"]));
}

export function registerPipelineComponents(registries: {
  readonly adapters: SourceAdapterRegistry;
  readonly processors: SourceProcessorRegistry;
  readonly operations: ProductOperationRegistry;
  readonly exporters: TargetExporterRegistry;
}, environment: PipelineEnvironment = process.env): void {
  registries.adapters.register(GoatSourceAdapter.create(environment));
  registries.processors.register(new GoatSourceProcessor());
  registerProductOperations(registries.operations, environment);
  const wordpress = loadWordPressTargetConfig(environment);
  if (wordpress !== null) registries.exporters.register(new WordPressExporter(wordpress));
}

export function createApplication(environment: ApplicationEnvironment = process.env) {
  const pool = createPostgresPool(environment);
  const repositories = createPostgresRepositories(pool);
  const unitOfWork = new PostgresUnitOfWork(pool);
  const adapters = new SourceAdapterRegistry();
  const processors = new SourceProcessorRegistry();
  const operations = new ProductOperationRegistry();
  const exporters = new TargetExporterRegistry();
  registerPipelineComponents({ adapters, processors, operations, exporters }, environment);
  const classifier = new ProductClassifier(repositories.classifications);
  const targetMappings = new TargetReferenceMappingService(repositories.references);
  const collectionRunner = new CollectionRunner(repositories, unitOfWork, adapters);
  const operationPipeline = new ProductOperationPipeline(
    operations,
    new PostgresProductOperationHistoryRepository(pool),
  );
  const processingRunner = new ProcessingRunner(repositories, unitOfWork, processors, operationPipeline, classifier);
  const exportRunner = new ExportRunner(repositories, exporters, targetMappings);
  const dispatcher = new JobDispatcher(collectionRunner, processingRunner, exportRunner, repositories.sourceRuns);
  const worker = new Worker(repositories.jobs, dispatcher, loadWorkerConfig(environment));
  return { pool, repositories, unitOfWork, adapters, processors, operations, exporters, classifier, targetMappings, collectionRunner, operationPipeline, processingRunner,
    exportRunner, dispatcher, worker, close: () => pool.end() };
}
