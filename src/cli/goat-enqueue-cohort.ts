import { createApplication } from "../bootstrap.js";

const MAX_COHORT_SIZE = 20_000;

function integer(value: string | undefined, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function list(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function ids(value: string | undefined): string[] {
  const result = [...new Set(list(value))];
  if (result.some((item) => !/^[1-9]\d*$/u.test(item))) throw new Error("GOAT_COHORT_PRODUCT_IDS must contain positive integer IDs");
  return result;
}

function routes(value: string | undefined): string[] {
  const result = [...new Set(list(value ?? "sneakers,apparel"))];
  if (result.length === 0 || result.some((item) => !/^[a-z][a-z0-9_-]*$/u.test(item))) {
    throw new Error("GOAT_COHORT_ROUTES must contain source route codes");
  }
  return result;
}

const explicitIds = ids(process.env.GOAT_COHORT_PRODUCT_IDS);
const explicitMode = explicitIds.length > 0;
if (explicitMode && process.env.GOAT_COHORT_PRODUCT_LIMIT !== undefined) {
  throw new Error("Use either GOAT_COHORT_PRODUCT_IDS or GOAT_COHORT_PRODUCT_LIMIT, not both");
}
const limit = explicitMode
  ? explicitIds.length
  : integer(process.env.GOAT_COHORT_PRODUCT_LIMIT, "GOAT_COHORT_PRODUCT_LIMIT", 1, MAX_COHORT_SIZE);
if (limit > MAX_COHORT_SIZE) throw new Error(`Cohort cannot exceed ${MAX_COHORT_SIZE} products`);
const seed = integer(process.env.GOAT_COHORT_SEED ?? "1", "GOAT_COHORT_SEED", 0, 2_147_483_647);
const selectedRoutes = explicitMode ? undefined : routes(process.env.GOAT_COHORT_ROUTES);
const apply = process.env.GOAT_COHORT_APPLY === "true";
if (process.env.GOAT_COHORT_APPLY !== undefined && !["true", "false"].includes(process.env.GOAT_COHORT_APPLY)) {
  throw new Error("GOAT_COHORT_APPLY must be true or false");
}

const application = createApplication();
try {
  const source = (await application.repositories.sources.listEnabled()).find((item) => item.code === "goat");
  if (source === undefined) throw new Error("Enabled GOAT source was not found");
  const candidates = await application.repositories.sourceProducts.listCollectionCandidates({
    sourceId: source.id,
    limit,
    seed,
    ...(explicitMode ? { sourceProductIds: explicitIds } : { routes: selectedRoutes! }),
  });
  if (candidates.length !== limit) {
    throw new Error(`Cohort selection returned ${candidates.length} uncollected products instead of ${limit}; no jobs were created`);
  }
  const routeCounts = Object.entries(candidates.reduce<Record<string, number>>((counts, product) => {
    counts[product.route] = (counts[product.route] ?? 0) + 1;
    return counts;
  }, {})).sort(([left], [right]) => left.localeCompare(right));
  console.log(`GOAT cohort: ${candidates.length}`);
  console.log(`Routes: ${routeCounts.map(([route, count]) => `${route || "unknown"}=${count}`).join(", ")}`);
  console.log(`Selection: ${candidates.slice(0, 20).map((product) => product.id).join(", ")}${candidates.length > 20 ? ", ..." : ""}`);
  if (!apply) {
    console.log("Dry run: set GOAT_COHORT_APPLY=true to enqueue collection jobs");
  } else {
    for (const product of candidates) {
      await application.repositories.jobs.enqueue({
        jobType: "collect_product",
        payload: { sourceProductId: product.id },
        uniqueKey: `source-product:${product.id}:collect`,
      });
    }
    console.log(`Enqueued collect_product jobs: ${candidates.length}`);
  }
} finally {
  await application.close();
}
