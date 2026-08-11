import { registerSourceProcessors } from "../bootstrap.js";
import { loadWordPressTargetConfig } from "../config/index.js";
import { SourceProcessorRegistry } from "../core/registry/index.js";
import {
  createPostgresPool,
  createPostgresRepositories,
  PostgresClassificationAdminRepository,
  PostgresTargetDictionaryRepository,
} from "../infrastructure/db/index.js";
import { TargetDictionaryProviderRegistry, WordPressDictionaryProvider } from "../integrations/index.js";
import { ClassifierAdminService } from "../services/index.js";

const defaultTypes = ["brand", "model", "color", "material", "tag"] as const;

function types(value: string | undefined): string[] {
  const requested = [...new Set((value ?? defaultTypes.join(","))
    .split(",").map((item) => item.trim()).filter(Boolean))];
  if (requested.length === 0 || requested.some((item) => !/^[a-z][a-z0-9_]*$/u.test(item))) {
    throw new Error("CLASSIFIER_EXACT_MATCH_TYPES must contain classifier type codes separated by commas");
  }
  return requested;
}

const selectedTypes = types(process.env.CLASSIFIER_EXACT_MATCH_TYPES);
const apply = process.env.CLASSIFIER_EXACT_MATCH_APPLY === "true";
if (process.env.CLASSIFIER_EXACT_MATCH_APPLY !== undefined
  && !["true", "false"].includes(process.env.CLASSIFIER_EXACT_MATCH_APPLY)) {
  throw new Error("CLASSIFIER_EXACT_MATCH_APPLY must be true or false");
}
const targetCode = process.env.CLASSIFIER_EXACT_MATCH_TARGET?.trim() || "slamdunk";
const sourceCode = process.env.CLASSIFIER_EXACT_MATCH_SOURCE?.trim() || "goat";

const pool = createPostgresPool();
try {
  const wordpress = loadWordPressTargetConfig();
  if (wordpress === null) throw new Error("WordPress dictionary provider is not configured");
  const repositories = createPostgresRepositories(pool);
  const dictionaries = new PostgresTargetDictionaryRepository(pool);
  const providers = new TargetDictionaryProviderRegistry();
  providers.register(new WordPressDictionaryProvider(wordpress));
  const processors = new SourceProcessorRegistry();
  registerSourceProcessors(processors);
  const target = (await dictionaries.listTargets()).find((item) => item.code === targetCode);
  if (target === undefined) throw new Error(`Target was not found: ${targetCode}`);
  if (target.enabled) throw new Error(`Target ${targetCode} must be disabled before exact classification matches are applied`);
  const source = (await repositories.sources.listEnabled()).find((item) => item.code === sourceCode);
  if (source === undefined) throw new Error(`Enabled source was not found: ${sourceCode}`);
  const classifier = new ClassifierAdminService(
    new PostgresClassificationAdminRepository(pool),
    repositories.classifications,
    dictionaries,
    providers,
    "classifier-exact-match",
    { [source.id]: processors.get(source.code).version },
  );

  let exactCount = 0;
  let productCount = 0;
  for (const typeCode of selectedTypes) {
    const preview = await classifier.listExactMatches({
      targetId: target.id,
      sourceId: source.id,
      typeCode,
      status: "ready",
      limit: 100,
      offset: 0,
    });
    exactCount += preview.summary.readyCount;
    productCount += preview.summary.readyProductCount;
    for (const match of preview.items) {
      const dictionary = match.targets[0]!;
      console.log(`${match.typeCode}: ${match.sourceValue} -> ${dictionary.name} (#${dictionary.externalId})`);
    }
    if (preview.total > preview.items.length) console.log(`... and ${preview.total - preview.items.length} more ${typeCode} matches`);
  }
  console.log(`Exact matches: ${exactCount}; observations in products: ${productCount}`);

  if (!apply) {
    console.log("Dry run: set CLASSIFIER_EXACT_MATCH_APPLY=true to save decisions");
  } else {
    let appliedCount = 0;
    let affectedProducts = 0;
    for (const typeCode of selectedTypes) {
      while (true) {
        const batch = await classifier.applyExactMatches({
          targetId: target.id,
          sourceId: source.id,
          typeCode,
          limit: 50,
        }, "classifier-exact-match");
        appliedCount += batch.appliedCount;
        affectedProducts += batch.affectedProductCount;
        if (batch.failed !== null) throw new Error(`Exact match group ${batch.failed.reviewGroupId} failed: ${batch.failed.message}`);
        if (batch.remainingCount === 0) break;
        if (batch.appliedCount === 0) throw new Error(`Exact match batch for ${typeCode} made no progress`);
      }
    }
    console.log(`Saved decisions: ${appliedCount}; affected product jobs: ${affectedProducts}`);
  }
} finally {
  await pool.end();
}
