import { createApplication } from "../bootstrap.js";
import type { JsonObject } from "../contracts/index.js";

const rawLimit = process.env.GOAT_SMOKE_PRODUCT_LIMIT;
const limit = Number(rawLimit);
if (!rawLimit || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
  throw new Error("GOAT_SMOKE_PRODUCT_LIMIT must be an integer from 1 to 100");
}

const sourceConfig: JsonObject = {
  sitemapUrl: "https://www.goat.com/sitemap",
  countryCode: "US",
  discoveryBatchSize: Math.min(limit, 25),
  maxProductsPerRun: limit,
  requestDelayMs: 1_000,
};

const application = createApplication();
try {
  const source = await application.repositories.sources.upsertDefinition({ code: "goat", name: "GOAT", adapterCode: "goat", config: sourceConfig, enabled: true });
  const job = await application.repositories.jobs.enqueue({ jobType: "discover_source", payload: { sourceId: source.id, runType: "smoke", coverage: "limited" }, uniqueKey: `goat:${source.id}:smoke:${Date.now()}` });
  console.log(`GOAT source ID: ${source.id}`);
  console.log(`Discovery job ID: ${job.id}`);
} finally {
  await application.close();
}
