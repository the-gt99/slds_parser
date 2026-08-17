import { CollectionRunner, ExportRunner, ExportSourceRefresher, JobDispatcher, PreflightRunner, ProcessingRunner, ProductOperationPipeline, TargetClassificationApplyRunner, TargetClassificationSyncRunner, Worker, WordPressCatalogSyncRunner, WordPressVariationPatchRunner } from "./application/index.js";
import { loadProcessingConfig, loadWorkerConfig, loadWordPressTargetConfig, type ProcessingEnvironment, type WorkerEnvironment, type WordPressTargetEnvironment } from "./config/index.js";
import { ProductOperationRegistry, SourceAdapterRegistry, SourceProcessorRegistry, TargetExporterRegistry } from "./core/registry/index.js";
import { createPostgresPool, createPostgresRepositories, PostgresClassificationAdminRepository, PostgresExportControlRepository, PostgresGoatProxyRepository, PostgresProductOperationHistoryRepository, PostgresRuntimeWorkerSettingsRepository, PostgresTargetClassificationImportRepository, PostgresTargetDictionaryRepository, PostgresUnitOfWork, PostgresWordPressCatalogRepository, type PoolEnvironment } from "./infrastructure/db/index.js";
import { LocalImageStore } from "./infrastructure/media/index.js";
import { LegacyGoogleTranslationProvider } from "./infrastructure/translation/index.js";
import { ShoeHeightApiProvider } from "./infrastructure/vision/index.js";
import { GoatImageDownloader, GoatProxyPool, GoatSourceAdapter, GoatSourceProcessor, TargetDictionaryProviderRegistry, WordPressCatalogClient, WordPressClassificationAssignmentReader, WordPressDictionaryProvider, WordPressExporter, WordPressProductSnapshotReader, WordPressTitleBrandAssignmentResolver, type GoatHttpEnvironment, type GoatProxyPoolEnvironment } from "./integrations/index.js";
import { ConvertImagesToWebpOperation, DetectShoeHeightOperation, DownloadImagesOperation, NormalizeProductOperation, PublishImagesOperation, TranslateContentOperation, ValidateProcessedProductOperation } from "./processing/index.js";
import { ClassifierAdminService, ExportControlService, ProductClassifier, TargetClassificationImportService, TargetReferenceMappingService, WordPressCatalogService, WordPressPreviewService } from "./services/index.js";

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
  const targetDictionary = new PostgresTargetDictionaryRepository(pool);
  const targetMappings = new TargetReferenceMappingService(
    repositories.references,
    new WordPressTitleBrandAssignmentResolver(targetDictionary),
  );
  const exportControl = new PostgresExportControlRepository(pool);
  const exportCampaigns = new ExportControlService(exportControl, repositories.jobs);
  const collectionRunner = new CollectionRunner(repositories, unitOfWork, adapters);
  const operationPipeline = new ProductOperationPipeline(
    operations,
    new PostgresProductOperationHistoryRepository(pool),
  );
  const processingRunner = new ProcessingRunner(repositories, unitOfWork, processors, operationPipeline, classifier);
  const sourceRefresher = new ExportSourceRefresher(repositories.sourceProducts, unitOfWork, adapters, processors);
  let refreshSourceBeforeExport = true;
  const exportRunner = new ExportRunner(repositories, exporters, targetMappings, sourceRefresher, () => refreshSourceBeforeExport);
  const runtimeWorkerSettings = new PostgresRuntimeWorkerSettingsRepository(pool);
  const wordpress = loadWordPressTargetConfig(environment);
  const wordpressCatalog = new PostgresWordPressCatalogRepository(pool);
  const wordpressCatalogService = new WordPressCatalogService(wordpressCatalog, repositories.sources, repositories.targets);
  const wordpressCatalogSync = wordpress === null
    ? undefined
    : new WordPressCatalogSyncRunner(wordpressCatalog, new WordPressCatalogClient(wordpress));
  const wordpressVariationPatches = wordpress === null
    ? undefined
    : new WordPressVariationPatchRunner(wordpressCatalog, repositories.jobs, targetMappings, repositories.contentTemplates,
      repositories.sources, repositories.sourceProducts, sourceRefresher, new WordPressCatalogClient(wordpress), wordpress);
  const preflightRunner = wordpress === null
    ? undefined
    : new PreflightRunner(new WordPressPreviewService(
      repositories,
      exporters,
      targetMappings,
      targetDictionary,
      new WordPressProductSnapshotReader(wordpress),
      exportControl,
    ));
  const classificationImportRepository = new PostgresTargetClassificationImportRepository(pool);
  const classificationSyncRunner = wordpress === null
    ? undefined
    : new TargetClassificationSyncRunner(classificationImportRepository, new WordPressClassificationAssignmentReader(wordpress));
  const classificationApplyRunner = wordpress === null
    ? undefined
    : (() => {
        const providers = new TargetDictionaryProviderRegistry();
        providers.register(new WordPressDictionaryProvider(wordpress));
        const adminClassifier = new ClassifierAdminService(
          new PostgresClassificationAdminRepository(pool),
          repositories.classifications,
          new PostgresTargetDictionaryRepository(pool),
          providers,
          "classification-apply-worker",
        );
        return new TargetClassificationApplyRunner(
          new TargetClassificationImportService(classificationImportRepository, adminClassifier, wordpress.baseUrl),
        );
      })();
  const dispatcher = new JobDispatcher(collectionRunner, processingRunner, exportRunner, repositories.sourceRuns,
    preflightRunner, exportControl, classificationSyncRunner, classificationApplyRunner, wordpressCatalogSync, wordpressVariationPatches);
  const workerOptions = loadWorkerConfig(environment);
  const worker = new Worker(
    repositories.jobs,
    dispatcher,
    workerOptions,
    undefined,
    Date.now,
    options.workerLogError ?? console.error,
    proxyPool === undefined
      ? undefined
      : async (jobTypes) => {
        const needsGoatProxy = jobTypes.length === 1
          && (jobTypes[0] === "collect_product" || jobTypes[0] === "refresh_wordpress_variation_patch"
            || (jobTypes[0] === "export_product" && refreshSourceBeforeExport));
        return needsGoatProxy
          ? proxyPool.reserveClaim()
          : { run: async (callback) => callback(), releaseUnused: async () => {} };
      },
    async () => {
      const settings = await runtimeWorkerSettings.loadAndMarkApplied({
        collectionConcurrency: workerOptions.collectionConcurrency ?? 1,
        processConcurrency: workerOptions.processConcurrency ?? 1,
        preflightConcurrency: workerOptions.preflightConcurrency ?? 1,
        classificationApplyConcurrency: workerOptions.classificationApplyConcurrency ?? 1,
        refreshSourceBeforeExport: true,
      }, workerOptions.workerId);
      refreshSourceBeforeExport = settings.refreshSourceBeforeExport;
      return {
        collectionConcurrency: settings.collectionConcurrency,
        processConcurrency: settings.processConcurrency,
        preflightConcurrency: settings.preflightConcurrency,
        classificationApplyConcurrency: settings.classificationApplyConcurrency,
      };
    },
    exportCampaigns,
    wordpress === null ? undefined : wordpressCatalogService,
  );
  return { pool, repositories, unitOfWork, adapters, processors, operations, exporters, classifier, targetMappings, collectionRunner, operationPipeline, processingRunner,
    sourceRefresher, exportRunner, preflightRunner, exportControl, wordpressCatalog, wordpressCatalogSync, wordpressVariationPatches, dispatcher, worker, close: () => pool.end() };
}
