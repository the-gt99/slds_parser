import { CollectionRunner, ExportRunner, ExportSourceRefresher, ExportSourceRefreshRunner, JobDispatcher, PreflightRunner, ProcessingRunner, ProductOperationPipeline, RetranslationRunner, ShihuoResolutionRunner, TargetClassificationApplyRunner, TargetClassificationSyncRunner, Worker, WordPressCatalogSyncRunner, WordPressVariationPatchRunner } from "./application/index.js";
import { loadProcessingConfig, loadShihuoConfig, loadTelegramNotificationConfig, loadWorkerConfig, loadWordPressTargetConfig, type ProcessingEnvironment, type ShihuoEnvironment, type TelegramNotificationEnvironment, type WorkerEnvironment, type WordPressTargetEnvironment } from "./config/index.js";
import { ProductOperationRegistry, SourceAdapterRegistry, SourceProcessorRegistry, TargetExporterRegistry } from "./core/registry/index.js";
import { createPostgresPool, createPostgresRepositories, PostgresClassificationAdminRepository, PostgresExportControlRepository, PostgresGoatProxyRepository, PostgresProductOperationHistoryRepository, PostgresRuntimeWorkerSettingsRepository, PostgresShihuoProductLinkRepository, PostgresShihuoSessionRepository, PostgresTargetClassificationImportRepository, PostgresTargetDictionaryRepository, PostgresUnitOfWork, PostgresWordPressCatalogRepository, type PoolEnvironment } from "./infrastructure/db/index.js";
import { LocalImageStore, S3ImageStore } from "./infrastructure/media/index.js";
import { CachedTranslationProvider, createTranslationProvider, PostgresTranslationCacheRepository, type TranslationCacheRepository } from "./infrastructure/translation/index.js";
import { ShoeHeightApiProvider } from "./infrastructure/vision/index.js";
import { GoatImageDownloader, GoatProxyPool, GoatSourceAdapter, GoatSourceProcessor, TargetDictionaryProviderRegistry, TelegramVariationAutoPauseNotifier, WordPressCatalogClient, WordPressClassificationAssignmentReader, WordPressDictionaryProvider, WordPressExporter, WordPressProductSnapshotReader, WordPressTitleBrandAssignmentResolver, type GoatHttpEnvironment, type GoatProxyPoolEnvironment } from "./integrations/index.js";
import { ConvertImagesToWebpOperation, DetectShoeHeightOperation, DownloadImagesOperation, NormalizeProductOperation, PublishImagesOperation, TranslateContentOperation, ValidateProcessedProductOperation } from "./processing/index.js";
import { ClassifierAdminService, ExportControlService, ProductClassifier, TargetClassificationImportService, TargetReferenceMappingService, WordPressCatalogService, WordPressPreviewService } from "./services/index.js";
import { RulesExecution } from "./infrastructure/db/rules-execution.js";
import { EcbShihuoCurrencyConverter, PersistentShihuoSigner, ShihuoGuestSessionPool, ShihuoInventoryService, ShihuoProductClient, ShihuoProductResolver, ShihuoSearchClient, ShihuoSecretCrypto } from "./shihuo/index.js";
import { PostgresContentEnrichmentRepository } from "./infrastructure/db/repositories/postgres-content-enrichment-repository.js";
import { ApplyContentEnrichmentOperation } from "./processing/operations/apply-content-enrichment-operation.js";
import { ContentEnrichmentRunner, type ProductContentDonor } from "./application/content-enrichment-runner.js";
import { hashStableJson } from "./core/utils/index.js";
import { ShihuoDescriptionDonor } from "./shihuo/description-donor.js";
import { ProductImageRefreshRunner } from "./application/product-image-refresh-runner.js";
import { PostgresProductImageRefreshRepository } from "./infrastructure/db/repositories/postgres-product-image-refresh-repository.js";

export type PipelineEnvironment = ProcessingEnvironment & GoatHttpEnvironment & WordPressTargetEnvironment & GoatProxyPoolEnvironment;
export type ApplicationEnvironment = PoolEnvironment & WorkerEnvironment & PipelineEnvironment & TelegramNotificationEnvironment & ShihuoEnvironment;

export interface ApplicationOptions {
  readonly workerLogError?: (message: string) => void;
}

function proxyPoolEnabled(environment: GoatProxyPoolEnvironment): boolean {
  return environment.GOAT_PROXY_POOL_ENABLED === "1" || environment.GOAT_PROXY_POOL_ENABLED?.toLowerCase() === "true";
}

function inventoryProxyHeadroom(environment: GoatProxyPoolEnvironment): number {
  const raw = environment.GOAT_PROXY_INVENTORY_HEADROOM?.trim() || "1";
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 64) {
    throw new Error("GOAT_PROXY_INVENTORY_HEADROOM must be an integer from 0 to 64");
  }
  return parsed;
}

export function registerProductOperations(registry: ProductOperationRegistry, environment: ProcessingEnvironment & GoatHttpEnvironment = process.env, proxyPool?: GoatProxyPool, translationCache?: TranslationCacheRepository, enrichment?: ApplyContentEnrichmentOperation): void {
  const processing = loadProcessingConfig(environment);
  const imageStore = processing.image.storage.type === "s3"
    ? new S3ImageStore({ ...processing.image, ...processing.image.storage })
    : new LocalImageStore(processing.image);
  const configuredTranslationProvider = createTranslationProvider(processing.translation);
  const translationProvider = translationCache === undefined
    ? configuredTranslationProvider
    : new CachedTranslationProvider(configuredTranslationProvider, translationCache);
  registry.register(new NormalizeProductOperation());
  if (enrichment !== undefined) registry.register(enrichment);
  registry.register(new TranslateContentOperation(translationProvider, { ...processing.translation, sourceCodes: ["goat"],
    ...(enrichment === undefined ? {} : { dependsOn: ["normalize-product", enrichment.code] }) }));
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
}, environment: PipelineEnvironment = process.env, proxyPool?: GoatProxyPool, translationCache?: TranslationCacheRepository, enrichment?: ApplyContentEnrichmentOperation): void {
  registries.adapters.register(GoatSourceAdapter.create(environment, proxyPool));
  registerSourceProcessors(registries.processors);
  registerProductOperations(registries.operations, environment, proxyPool, translationCache, enrichment);
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
  const translationCache = new PostgresTranslationCacheRepository(pool);
  const contentEnrichments = new PostgresContentEnrichmentRepository(pool);
  const contentDonors = new Map<string, ProductContentDonor>();
  registerPipelineComponents({ adapters, processors, operations, exporters }, environment, proxyPool, translationCache,
    new ApplyContentEnrichmentOperation(contentEnrichments, async (product,record) =>
      await contentDonors.get(record.donorCode)?.validate(product,record) ?? false));
  const targetDictionary = new PostgresTargetDictionaryRepository(pool);
  const titleBrandAssignments = new WordPressTitleBrandAssignmentResolver(targetDictionary);
  const rulesExecution = new RulesExecution(pool, repositories.classifications, titleBrandAssignments);
  const classifier = rulesExecution.classifier;
  const targetMappings = new TargetReferenceMappingService(
    rulesExecution.references(repositories.references),
    rulesExecution.supplemental(titleBrandAssignments),
    rulesExecution,
  );
  const workerOptions = loadWorkerConfig(environment);
  const shihuoConfig = loadShihuoConfig(environment);
  const shihuoSigner = shihuoConfig === null ? undefined : new PersistentShihuoSigner({
    python: shihuoConfig.signerPython,
    script: shihuoConfig.signerScript,
    assetDirectory: shihuoConfig.signerAssetDirectory,
  });
  const shihuoSessions = shihuoConfig === null ? undefined : new ShihuoGuestSessionPool(
    new PostgresShihuoSessionRepository(pool),
    new ShihuoSecretCrypto(environment.PARSER_PROXY_ENCRYPTION_KEY),
    shihuoConfig,
  );
  const shihuoResolver = shihuoConfig === null ? undefined : new ShihuoProductResolver(
    shihuoSessions!,
    new ShihuoSearchClient(shihuoSigner!),
    new ShihuoProductClient(), new PostgresShihuoProductLinkRepository(pool), repositories.internalProducts, shihuoConfig.betweenRequestsMs,
  );
  const shihuoInventory = shihuoResolver === undefined || shihuoConfig?.inventoryEnabled !== true ? undefined : new ShihuoInventoryService(
    shihuoResolver, new PostgresShihuoProductLinkRepository(pool), new EcbShihuoCurrencyConverter(),
  );
  const processingConfig = loadProcessingConfig(environment);
  if (shihuoResolver !== undefined) contentDonors.set("shihuo", new ShihuoDescriptionDonor(shihuoResolver,
    new PostgresShihuoProductLinkRepository(pool),processingConfig.translation.targetLocale));
  const contentEnrichmentRunner = new ContentEnrichmentRunner(repositories.internalProducts,contentEnrichments,contentDonors,
    new CachedTranslationProvider(createTranslationProvider(processingConfig.translation),translationCache),
    async (sourceProductId,targetId) => {
      const target = await repositories.targets.getById(targetId);
      const product = await repositories.sourceProducts.getById(sourceProductId);
      const source = product === null ? null : await repositories.sources.getById(product.sourceId);
      if (wordpress === null || target?.exporterCode !== "wordpress" || !product?.externalId || !source) {
        throw new Error("Content eligibility requires a configured target and source identity");
      }
      const [remote] = await new WordPressProductSnapshotReader(wordpress).read(source.code,[product.externalId]);
      if (!remote || remote.errorCode && remote.errorCode !== "target_not_found") throw new Error("Content eligibility lookup did not return a confirmed result");
      if (!remote.found) return true;
      if (!remote.externalId || !remote.snapshot) throw new Error("Content eligibility returned an incomplete existing product");
      await repositories.targets.saveProductSnapshot({ targetId,sourceProductId,externalId: remote.externalId,
        sourceExternalId: product.externalId,payload: remote.snapshot,contentHash: hashStableJson(remote.snapshot),
        fetchedAt: new Date().toISOString() });
      return false;
    });
  const exportControl = new PostgresExportControlRepository(pool);
  const exportCampaigns = new ExportControlService(exportControl, repositories.jobs, workerOptions.exportConcurrency ?? 1);
  const collectionRunner = new CollectionRunner(repositories, unitOfWork, adapters);
  const operationPipeline = new ProductOperationPipeline(
    operations,
    new PostgresProductOperationHistoryRepository(pool),
  );
  const processingRunner = new ProcessingRunner(repositories, unitOfWork, processors, operationPipeline, classifier, rulesExecution);
  const translationOperation = operations.list().find((operation): operation is TranslateContentOperation => operation instanceof TranslateContentOperation);
  if (translationOperation === undefined) throw new Error("Translate content operation is not registered");
  const retranslationRunner = new RetranslationRunner(repositories, translationOperation);
  const sourceRefresher = new ExportSourceRefresher(repositories.sourceProducts, unitOfWork, adapters, processors);
  let refreshSourceBeforeExport = true;
  const exportRunner = new ExportRunner(repositories, exporters, targetMappings, sourceRefresher,
    () => refreshSourceBeforeExport, Date.now, exportControl);
  const exportSourceRefreshRunner = new ExportSourceRefreshRunner(
    repositories.sources, repositories.sourceProducts, repositories.internalProducts, exportControl, sourceRefresher,
  );
  const runtimeWorkerSettings = new PostgresRuntimeWorkerSettingsRepository(pool);
  const wordpress = loadWordPressTargetConfig(environment);
  const telegram = loadTelegramNotificationConfig(environment);
  const wordpressCatalog = new PostgresWordPressCatalogRepository(pool);
  const wordpressCatalogService = new WordPressCatalogService(
    wordpressCatalog,
    repositories.sources,
    repositories.targets,
    telegram === null ? undefined : new TelegramVariationAutoPauseNotifier(telegram),
    options.workerLogError ?? console.error,
  );
  const wordpressCatalogSync = wordpress === null
    ? undefined
    : new WordPressCatalogSyncRunner(wordpressCatalog, new WordPressCatalogClient(wordpress));
  const imageStore = processingConfig.image.storage.type === "s3"
    ? new S3ImageStore({ ...processingConfig.image, ...processingConfig.image.storage })
    : new LocalImageStore(processingConfig.image);
  const imageRefreshes = new ProductImageRefreshRunner(repositories, unitOfWork, adapters, processors,
    new Map([["goat", new GoatImageDownloader(environment, { concurrency: 1 }, undefined, proxyPool)]]),
    imageStore, new PostgresProductImageRefreshRepository(pool), exporters,
    processingConfig.image.checkIntervalMs);
  const wordpressVariationPatches = wordpress === null
    ? undefined
    : new WordPressVariationPatchRunner(wordpressCatalog, repositories.jobs, targetMappings, repositories.contentTemplates,
      repositories.sources, repositories.sourceProducts, sourceRefresher, new WordPressCatalogClient(wordpress), wordpress, shihuoInventory,
      Date.now, imageRefreshes, options.workerLogError ?? console.error);
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
    preflightRunner, exportControl, classificationSyncRunner, classificationApplyRunner, wordpressCatalogSync,
    wordpressVariationPatches, retranslationRunner, exportSourceRefreshRunner,
    shihuoResolver === undefined ? undefined : new ShihuoResolutionRunner(shihuoResolver), repositories.jobs, contentEnrichmentRunner, imageRefreshes);
  const worker = new Worker(
    repositories.jobs,
    dispatcher,
    { ...workerOptions, shihuoConcurrency: shihuoConfig?.concurrency ?? 0 },
    undefined,
    Date.now,
    options.workerLogError ?? console.error,
    async (jobTypes) => {
        const needsShihuoSession = jobTypes.length === 2 && jobTypes.includes("collect_product_content") && jobTypes.includes("translate_product_content") || (jobTypes.length === 2
          ? jobTypes.includes("resolve_shihuo_product") && jobTypes.includes("collect_wordpress_shihuo_inventory")
          : jobTypes.length === 1 && (jobTypes[0] === "resolve_shihuo_product" || jobTypes[0] === "collect_wordpress_shihuo_inventory"));
        if (needsShihuoSession) return shihuoSessions?.reserveClaim() ?? null;
        const needsGoatProxy = jobTypes.length === 1
          && (jobTypes[0] === "collect_product" || jobTypes[0] === "collect_wordpress_variation_source"
            || jobTypes[0] === "collect_wordpress_goat_inventory"
            || jobTypes[0] === "check_product_images" || jobTypes[0] === "refresh_product_images"
            || jobTypes[0] === "refresh_export_source");
        return needsGoatProxy && proxyPool !== undefined
          ? proxyPool.reserveClaim(jobTypes[0] === "collect_wordpress_variation_source" || jobTypes[0] === "collect_wordpress_goat_inventory"
            ? 0 : inventoryProxyHeadroom(environment))
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
  return { pool, repositories, unitOfWork, adapters, processors, operations, exporters, classifier, targetMappings, collectionRunner, operationPipeline, processingRunner, retranslationRunner,
    sourceRefresher, exportRunner, preflightRunner, exportControl, wordpressCatalog, wordpressCatalogSync, wordpressVariationPatches, shihuoResolver, contentEnrichmentRunner, contentEnrichments, dispatcher, worker,
    close: async () => { shihuoSigner?.close(); await pool.end(); } };
}
