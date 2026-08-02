import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { loadAdminApiConfig, loadHttpConfig, loadWordPressTargetConfig } from "../config/index.js";
import { createHttpServer } from "../http/index.js";
import {
  createPostgresPool,
  createPostgresRepositories,
  PostgresClassificationAdminRepository,
  PostgresProductAdminRepository,
  PostgresTargetDictionaryRepository,
} from "../infrastructure/db/index.js";
import { TargetDictionaryProviderRegistry, WordPressDictionaryProvider } from "../integrations/index.js";
import { ClassifierAdminService, ProductAdminService, TargetDictionaryService } from "../services/index.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

async function main(): Promise<void> {
  let pool: Pool | undefined;
  let server: FastifyInstance | undefined;
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
    const classifier = new ClassifierAdminService(
      new PostgresClassificationAdminRepository(pool),
      repositories.classifications,
    );
    const providers = new TargetDictionaryProviderRegistry();
    if (wordpress !== null) providers.register(new WordPressDictionaryProvider(wordpress));
    const targetDictionaries = new TargetDictionaryService(
      new PostgresTargetDictionaryRepository(pool),
      providers,
      classifier,
    );
    const productAdmin = new ProductAdminService(
      new PostgresProductAdminRepository(pool),
      providers,
    );
    server = createHttpServer({ database: pool, auth: admin, classifier, targetDictionaries, productAdmin });

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
