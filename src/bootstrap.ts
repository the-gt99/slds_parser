import { CollectionRunner, ExportRunner, JobDispatcher, ProcessingRunner, ProductOperationPipeline, Worker } from "./application/index.js";
import { loadProcessingConfig, loadWorkerConfig, loadWordPressTargetConfig, type ProcessingEnvironment, type WorkerEnvironment, type WordPressTargetEnvironment } from "./config/index.js";
import { ProductOperationRegistry, SourceAdapterRegistry, SourceProcessorRegistry, TargetExporterRegistry } from "./core/registry/index.js";
import { createPostgresPool, createPostgresRepositories, PostgresGoatProxyRepository, PostgresProductOperationHistoryRepository, PostgresUnitOfWork, type PoolEnvironment } from "./infrastructure/db/index.js";
import { LocalImageStore } from "./infrastructure/media/index.js";
import { LegacyGoogleTranslationProvider } from "./infrastructure/translation/index.js";
import { ShoeHeightApiProvider } from "./infrastructure/vision/index.js";
import { GoatImageDownloader, GoatProxyPool, GoatSourceAdapter, GoatSourceProcessor, WordPressExporter, type GoatHttpEnvironment, type GoatProxyPoolEnvironment } from "./integrations/index.js";
import { ConvertImagesToWebpOperation, DetectShoeHeightOperation, DownloadImagesOperation, NormalizeProductOperation, PublishImagesOperation, TranslateContentOperation, ValidateProcessedProductOperation } from "./processing/index.js";
import { ProductClassifier, TargetReferenceMappingService } from "./services/index.js";

export type PipelineEnvironment = ProcessingEnvironment & GoatHttpEnvironment & WordPressTargetEnvironment & GoatProxyPoolEnvironment;
export type ApplicationEnvironment = PoolEnvironment & WorkerEnvironment & PipelineEnvironment;

export interface ApplicationOptions {
  readonly workerLogError?: (message: string) => void;
}

function proxyPoolEnabled(environment: GoatProxyPoolEnvironment): boolean {
  return environment.GOAT_PROXY_POOL_ENABLED === "1" || environment.GOAT_PROXY_POOL_ENABLED?.toLowerCase() === "true";
}

export function registerProductOperations(registry: ProductOperationRegistry, environment: ProcessingEnvironment & GoatHttpEnvironment = process.env, proxyPool?: GoatProxyPool): void {
  const processing = loadProcessingConfig(environment);
  const imageStore = new LocalImageStore(processing.image);
  const translationProvider = new LegacyGoogleTranslationProvider(processing.translation);
  registry.register(new NormalizeProductOperation());
  registry.register(new TranslateContentOperation(translationProvider, { ...processing.translation, sourceCodes: ["goat"] }));
  registry.register(new DownloadImagesOperation(
    new GoatImageDownloader(environment, { concurrency: processing.image.transportConcurrency }, undefined, proxyPool),
    imageStore,
    { concurrency: processing.image.operationConcurrency, sourceCodes: ["goat"] },
  ));
  if (processing.shoeHeight !== null) {
    registry.register(new DetectShoeHeightOperation(
      new ShoeHeightApiProvider(processing.shoeHeight),
      imageStore,
      { sourceImagePosition: processing.shoeHeight.sourceImagePosition, eligibleCategoryValues: ["sneakers"], sourceCodes: ["goat"] },
    ));
  }
  registry.register(new ConvertImagesToWebpOperation(imageStore, { concurrency: processing.image.operationConcurrency, sourceCodes: ["goat"] }));
  registry.register(new PublishImagesOperation(imageStore, ["goat"]));
  registry.register(new ValidateProcessedProductOperation(["goat"]));
}

export function registerSourceProcessors(registry: SourceProcessorRegistry): void {
  registry.register(new GoatSourceProcessor());
}

export function registerPipelineComponents(registries: {
  readonly adapters: SourceAdapterRegistry;
  readonly processors: SourceProcessorRegistry;
  readonly operations: ProductOperationRegistry;
  readonly exporters: TargetExporterRegistry;
}, environment: PipelineEnvironment = process.env, proxyPool?: GoatProxyPool): void {
  registries.adapters.register(GoatSourceAdapter.create(environment, proxyPool));
  registerSourceProcessors(registries.processors);
  registerProductOperations(registries.operations, environment, proxyPool);
  const wordpress = loadWordPressTargetConfig(environment);
  if (wordpress !== null) registries.exporters.register(new WordPressExporter(wordpress));
}

export function createApplication(environment: ApplicationEnvironment = process.env, options: ApplicationOptions = {}) {
  const pool = createPostgresPool(environment);
  const repositories = createPostgresRepositories(pool);
  const proxyPool = proxyPoolEnabled(environment)
    ? new GoatProxyPool(new PostgresGoatProxyRepository(pool), environment)
    : undefined;
  const unitOfWork = new PostgresUnitOfWork(pool);
  const adapters = new SourceAdapterRegistry();
  const processors = new SourceProcessorRegistry();
  const operations = new ProductOperationRegistry();
  const exporters = new TargetExporterRegistry();
  registerPipelineComponents({ adapters, processors, operations, exporters }, environment, proxyPool);
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
  const worker = new Worker(
    repositories.jobs,
    dispatcher,
    loadWorkerConfig(environment),
    undefined,
    Date.now,
    options.workerLogError ?? console.error,
    proxyPool === undefined
      ? undefined
      : async (jobTypes) => jobTypes.length === 1 && jobTypes[0] === "collect_product" ? proxyPool.reserveClaim() : { run: async (callback) => callback(), releaseUnused: async () => {} },
  );
  return { pool, repositories, unitOfWork, adapters, processors, operations, exporters, classifier, targetMappings, collectionRunner, operationPipeline, processingRunner,
    exportRunner, dispatcher, worker, close: () => pool.end() };
}
