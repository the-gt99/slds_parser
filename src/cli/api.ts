import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { RulesV2PreviewService } from "../services/rules-v2-preview.js";
import { RulesExecution } from "../infrastructure/db/rules-execution.js";

import { loadAdminApiConfig, loadHttpConfig, loadMcpConfig, loadShihuoConfig, loadTelegramNotificationConfig, loadWordPressTargetConfig } from "../config/index.js";
import { registerProductOperations, registerSourceProcessors } from "../bootstrap.js";
import { ProductOperationRegistry, SourceProcessorRegistry, TargetExporterRegistry } from "../core/registry/index.js";
import { createHttpServer } from "../http/index.js";
import {
  createPostgresPool,
  createPostgresRepositories,
  PostgresClassificationAdminRepository,
  PostgresExportControlRepository,
  PostgresGoatProxyRepository,
  PostgresProductAdminRepository,
  PostgresRuntimeWorkerSettingsRepository,
  PostgresRulesV2Repository,
  PostgresTargetDictionaryRepository,
  PostgresTargetAssignmentRuleRepository,
  PostgresTargetClassificationImportRepository,
  PostgresUnitOfWork,
  PostgresWordPressCatalogRepository,
  PostgresShihuoDeviceRepository,
} from "../infrastructure/db/index.js";
import { GoatProxyTester, TargetDictionaryProviderRegistry, TelegramVariationAutoPauseNotifier, WordPressDictionaryProvider, WordPressExporter, WordPressProductSnapshotReader, WordPressTitleBrandAssignmentResolver } from "../integrations/index.js";
import { ProxyCredentialsCrypto } from "../proxies/index.js";
import { ShihuoGuestDeviceService, ShihuoSecretCrypto, SignedShihuoSearchVerifier, SystemWireGuardManager } from "../shihuo/index.js";
import { ClassifierAdminService, ContentTemplateAdminService, DataSchemaService, ExportControlService, ProductAdminService, ProductClassifier, ProxyAdminService, RulesV2Service, RuntimeAdminService, TargetAssignmentAdminService, TargetClassificationImportService, TargetDictionaryService, TargetReferenceMappingService, WordPressCatalogService, WordPressPreviewService } from "../services/index.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

async function main(): Promise<void> {
  let pool: Pool | undefined;
  let server: FastifyInstance | undefined;
  let runtime: RuntimeAdminService | undefined;
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`Received ${signal}, stopping API`);

    try {
      if (server) await server.close();
      if (pool) await pool.end();
    } catch (error) {
      console.error(`Failed to stop API: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  };

  const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

  try {
    const config = loadHttpConfig();
    const admin = loadAdminApiConfig();
    const mcp = loadMcpConfig();
    const wordpress = loadWordPressTargetConfig();
    const shihuoConfig = loadShihuoConfig();
    const telegram = loadTelegramNotificationConfig();
    pool = createPostgresPool();
    const repositories = createPostgresRepositories(pool);
    const providers = new TargetDictionaryProviderRegistry();
    if (wordpress !== null) providers.register(new WordPressDictionaryProvider(wordpress));
    const targetDictionaryRepository = new PostgresTargetDictionaryRepository(pool);
    const titleBrandAssignments = new WordPressTitleBrandAssignmentResolver(targetDictionaryRepository);
    const rulesExecution = new RulesExecution(pool, repositories.classifications, titleBrandAssignments);
    const processors = new SourceProcessorRegistry();
    registerSourceProcessors(processors);
    const sources = await repositories.sources.listEnabled();
    const currentProcessorVersions = Object.fromEntries(sources.map((source) => [source.id, processors.get(source.code).classificationVersion]));
    const classifier = new ClassifierAdminService(
      new PostgresClassificationAdminRepository(pool),
      repositories.classifications,
      targetDictionaryRepository,
      providers,
      "admin-api",
      currentProcessorVersions,
    );
    const operations = new ProductOperationRegistry();
    registerProductOperations(operations);
    const exporters = new TargetExporterRegistry();
    if (wordpress !== null) exporters.register(new WordPressExporter(wordpress));
    const targetDictionaries = new TargetDictionaryService(
      targetDictionaryRepository,
      providers,
      classifier,
      repositories.sources,
    );
    const targetAssignmentRepository = new PostgresTargetAssignmentRuleRepository(pool);
    const targetAssignments = new TargetAssignmentAdminService(
      targetAssignmentRepository,
      targetDictionaryRepository,
      providers,
    );
    const targetClassificationImport = wordpress === null
      ? undefined
      : new TargetClassificationImportService(
        new PostgresTargetClassificationImportRepository(pool),
        classifier,
        wordpress.baseUrl,
      );
    const productAdmin = new ProductAdminService(
      new PostgresProductAdminRepository(pool),
      providers,
      operations,
      repositories.jobs,
      rulesExecution.classifier,
    );
    const targetMappings = new TargetReferenceMappingService(
      rulesExecution.references(repositories.references),
      rulesExecution.supplemental(titleBrandAssignments),
      rulesExecution,
    );
    const exportControlRepository = new PostgresExportControlRepository(pool);
    const wordpressPreview = wordpress === null
      ? undefined
      : new WordPressPreviewService(repositories, exporters, targetMappings, targetDictionaryRepository, new WordPressProductSnapshotReader(wordpress), exportControlRepository);
    const exportControl = wordpressPreview === undefined
      ? undefined
      : new ExportControlService(exportControlRepository, repositories.jobs);
    const wordpressCatalog = wordpress === null
      ? undefined
      : new WordPressCatalogService(
          new PostgresWordPressCatalogRepository(pool),
          repositories.sources,
          repositories.targets,
          telegram === null ? undefined : new TelegramVariationAutoPauseNotifier(telegram),
        );
    const contentTemplates = wordpressPreview === undefined
      ? undefined
      : new ContentTemplateAdminService(repositories.contentTemplates, repositories.targets, wordpressPreview, new PostgresUnitOfWork(pool));
    const proxies = process.env.PARSER_PROXY_ENCRYPTION_KEY?.trim()
      ? new ProxyAdminService(new PostgresGoatProxyRepository(pool), new ProxyCredentialsCrypto(process.env.PARSER_PROXY_ENCRYPTION_KEY), new GoatProxyTester())
      : undefined;
    const shihuo = shihuoConfig === null ? undefined : new ShihuoGuestDeviceService(
      new PostgresShihuoDeviceRepository(pool), new ShihuoSecretCrypto(process.env.PARSER_PROXY_ENCRYPTION_KEY),
      new SystemWireGuardManager(shihuoConfig.wgCommand, shihuoConfig.reconcileService), shihuoConfig,
      new SignedShihuoSearchVerifier({ python: shihuoConfig.signerPython, script: shihuoConfig.signerScript, assetDirectory: shihuoConfig.signerAssetDirectory }),
    );
    runtime = new RuntimeAdminService(pool, repositories, process.env, undefined, undefined, new PostgresRuntimeWorkerSettingsRepository(pool));
    const dataSchema = new DataSchemaService(repositories.sources);
    const rulesV2 = new RulesV2Service(new PostgresRulesV2Repository(pool), new RulesV2PreviewService(pool), () => rulesExecution.state());
    server = createHttpServer({ database: pool, auth: admin, ...(mcp === null ? {} : { mcp }), classifier, targetDictionaries, targetAssignments, dataSchema, rulesV2, productAdmin, runtime, ...(targetClassificationImport === undefined ? {} : { targetClassificationImport }), ...(proxies === undefined ? {} : { proxies }), ...(shihuo === undefined ? {} : { shihuo }), ...(wordpressPreview === undefined ? {} : { wordpressPreview }), ...(exportControl === undefined ? {} : { exportControl }), ...(contentTemplates === undefined ? {} : { contentTemplates }), ...(wordpressCatalog === undefined ? {} : { wordpressCatalog }) });

    for (const signal of signals) {
      process.once(signal, () => void shutdown(signal));
    }

    await server.listen(config);
  } catch (error) {
    for (const signal of signals) process.removeAllListeners(signal);
    await Promise.allSettled([server?.close(), pool?.end()]);
    console.error(`Failed to start API: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

await main();
