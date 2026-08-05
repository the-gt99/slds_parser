import { createApplication } from "../bootstrap.js";
import type { JsonObject } from "../contracts/index.js";

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const sourceConfig: JsonObject = {
  sitemapUrl: "https://www.goat.com/sitemap",
  countryCode: "US",
  discoveryBatchSize: positiveInteger(process.env.GOAT_DISCOVERY_BATCH_SIZE, 500, "GOAT_DISCOVERY_BATCH_SIZE"),
  requestDelayMs: positiveInteger(process.env.GOAT_DISCOVERY_REQUEST_DELAY_MS, 1_000, "GOAT_DISCOVERY_REQUEST_DELAY_MS"),
};

const application = createApplication();
try {
  const source = await application.repositories.sources.upsertDefinition({ code: "goat", name: "GOAT", adapterCode: "goat", config: sourceConfig, enabled: true });
  const job = await application.repositories.jobs.enqueue({
    jobType: "discover_source",
    payload: { sourceId: source.id, runType: "full", coverage: "catalog", enqueueCollection: false },
    uniqueKey: `goat:${source.id}:discovery-only:${Date.now()}`,
  });
  console.log(`GOAT source ID: ${source.id}`);
  console.log(`Discovery-only job ID: ${job.id}`);
} finally {
  await application.close();
}
