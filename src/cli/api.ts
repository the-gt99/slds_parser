import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { loadAdminApiConfig, loadHttpConfig, loadWordPressTargetConfig } from "../config/index.js";
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
  PostgresTargetDictionaryRepository,
  PostgresTargetAssignmentRuleRepository,
  PostgresUnitOfWork,
} from "../infrastructure/db/index.js";
import { GoatProxyTester, TargetDictionaryProviderRegistry, WordPressDictionaryProvider, WordPressExporter, WordPressProductSnapshotReader } from "../integrations/index.js";
import { ProxyCredentialsCrypto } from "../proxies/index.js";
import { ClassifierAdminService, ContentTemplateAdminService, ExportControlService, ProductAdminService, ProductClassifier, ProxyAdminService, RuntimeAdminService, TargetAssignmentAdminService, TargetDictionaryService, TargetReferenceMappingService, WordPressPreviewService } from "../services/index.js";

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
    const wordpress = loadWordPressTargetConfig();
    pool = createPostgresPool();
    const repositories = createPostgresRepositories(pool);
    const providers = new TargetDictionaryProviderRegistry();
    if (wordpress !== null) providers.register(new WordPressDictionaryProvider(wordpress));
    const targetDictionaryRepository = new PostgresTargetDictionaryRepository(pool);
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
    );
    const targetAssignments = new TargetAssignmentAdminService(
      new PostgresTargetAssignmentRuleRepository(pool),
      targetDictionaryRepository,
      providers,
    );
    const productAdmin = new ProductAdminService(
      new PostgresProductAdminRepository(pool),
      providers,
      operations,
      repositories.jobs,
      new ProductClassifier(repositories.classifications),
    );
    const targetMappings = new TargetReferenceMappingService(repositories.references);
    const exportControlRepository = new PostgresExportControlRepository(pool);
    const wordpressPreview = wordpress === null
      ? undefined
      : new WordPressPreviewService(repositories, exporters, targetMappings, targetDictionaryRepository, new WordPressProductSnapshotReader(wordpress), exportControlRepository);
    const exportControl = wordpressPreview === undefined
      ? undefined
      : new ExportControlService(exportControlRepository, repositories.jobs);
    const contentTemplates = wordpressPreview === undefined
      ? undefined
      : new ContentTemplateAdminService(repositories.contentTemplates, repositories.targets, wordpressPreview, new PostgresUnitOfWork(pool));
    const proxies = process.env.PARSER_PROXY_ENCRYPTION_KEY?.trim()
      ? new ProxyAdminService(new PostgresGoatProxyRepository(pool), new ProxyCredentialsCrypto(process.env.PARSER_PROXY_ENCRYPTION_KEY), new GoatProxyTester())
      : undefined;
    runtime = new RuntimeAdminService(pool, repositories);
    server = createHttpServer({ database: pool, auth: admin, classifier, targetDictionaries, targetAssignments, productAdmin, runtime, ...(proxies === undefined ? {} : { proxies }), ...(wordpressPreview === undefined ? {} : { wordpressPreview }), ...(exportControl === undefined ? {} : { exportControl }), ...(contentTemplates === undefined ? {} : { contentTemplates }) });

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
