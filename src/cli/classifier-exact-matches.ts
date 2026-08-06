import {
  createPostgresPool,
  createPostgresRepositories,
  PostgresClassificationAdminRepository,
  PostgresTargetDictionaryRepository,
} from "../infrastructure/db/index.js";
import type { ClassificationReviewItem, TargetDictionaryValueRecord } from "../repositories/index.js";
import { ClassifierAdminService, normalizeSourceValue } from "../services/index.js";

const CAPABILITIES = {
  brand: { entityType: "brands", targetScope: "product.brand" },
  model: { entityType: "models", targetScope: "product.model" },
  color: { entityType: "colors", targetScope: "product.color" },
  material: { entityType: "materials", targetScope: "product.material" },
  tag: { entityType: "tags", targetScope: "product.tag" },
} as const;

type SupportedType = keyof typeof CAPABILITIES;

function types(value: string | undefined): SupportedType[] {
  const requested = [...new Set((value ?? Object.keys(CAPABILITIES).join(","))
    .split(",").map((item) => item.trim()).filter(Boolean))];
  const unknown = requested.filter((item) => !(item in CAPABILITIES));
  if (requested.length === 0 || unknown.length > 0) {
    throw new Error(`CLASSIFIER_EXACT_MATCH_TYPES supports only: ${Object.keys(CAPABILITIES).join(", ")}`);
  }
  return requested as SupportedType[];
}

function stringMap(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) =>
    typeof item === "string" && item.trim() !== "" ? [[key, item.trim()]] : []));
}

function uniqueDictionaryValues(values: readonly TargetDictionaryValueRecord[]): ReadonlyMap<string, TargetDictionaryValueRecord> {
  const grouped = new Map<string, TargetDictionaryValueRecord[]>();
  for (const value of values) {
    const key = normalizeSourceValue(value.name);
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  return new Map([...grouped.entries()].flatMap(([key, matches]) => matches.length === 1 ? [[key, matches[0]!] as const] : []));
}

function exactMatches(
  reviews: readonly ClassificationReviewItem[],
  values: readonly TargetDictionaryValueRecord[],
): readonly { readonly review: ClassificationReviewItem; readonly dictionary: TargetDictionaryValueRecord }[] {
  const dictionary = uniqueDictionaryValues(values);
  return reviews.flatMap((review) => {
    const match = dictionary.get(review.normalizedSourceValue);
    return match === undefined ? [] : [{ review, dictionary: match }];
  });
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
  const repositories = createPostgresRepositories(pool);
  const adminRepository = new PostgresClassificationAdminRepository(pool);
  const classifier = new ClassifierAdminService(adminRepository, repositories.classifications, "classifier-exact-match");
  const dictionaries = new PostgresTargetDictionaryRepository(pool);
  const target = (await dictionaries.listTargets()).find((item) => item.code === targetCode);
  if (target === undefined) throw new Error(`Target was not found: ${targetCode}`);
  if (target.enabled) throw new Error(`Target ${targetCode} must be disabled before exact classification matches are applied`);
  const source = (await repositories.sources.listEnabled()).find((item) => item.code === sourceCode);
  if (source === undefined) throw new Error(`Enabled source was not found: ${sourceCode}`);
  const entityOverrides = stringMap(target.config.dictionaryEntityMap);
  const scopeOverrides = stringMap(target.config.targetScopeMap);
  const matches: {
    readonly review: ClassificationReviewItem;
    readonly dictionary: TargetDictionaryValueRecord;
    readonly targetScope: string;
  }[] = [];
  for (const typeCode of selectedTypes) {
    const capability = CAPABILITIES[typeCode];
    const entityType = entityOverrides[typeCode] ?? capability.entityType;
    const [reviews, values] = await Promise.all([
      adminRepository.listReviewQueue({ sourceId: source.id, typeCode, status: "unresolved", limit: 100_000, offset: 0 }),
      dictionaries.listValues({ targetId: target.id, entityType, limit: 100_000, offset: 0 }),
    ]);
    matches.push(...exactMatches(reviews, values).map((match) => ({
      ...match,
      targetScope: scopeOverrides[capability.targetScope] ?? capability.targetScope,
    })));
  }

  const productCount = matches.reduce((count, match) => count + match.review.productCount, 0);
  console.log(`Exact matches: ${matches.length}; observations in products: ${productCount}`);
  for (const match of matches.slice(0, 100)) {
    console.log(`${match.review.typeCode}: ${match.review.sourceValue} -> ${match.dictionary.name} (#${match.dictionary.externalId})`);
  }
  if (matches.length > 100) console.log(`... and ${matches.length - 100} more`);

  if (!apply) {
    console.log("Dry run: set CLASSIFIER_EXACT_MATCH_APPLY=true to save decisions");
  } else {
    let affectedProducts = 0;
    for (const match of matches) {
      const decision = await classifier.saveDecision({
        sourceId: match.review.sourceId,
        typeCode: match.review.typeCode,
        scope: match.review.scope,
        normalizedSourceValue: match.review.normalizedSourceValue,
        contextKey: match.review.contextKey,
        action: "confirm",
        targetLink: {
          targetId: target.id,
          targetScope: match.targetScope,
          dictionaryValueId: match.dictionary.id,
        },
        reason: "Однозначное точное совпадение с актуальным справочником target",
      }, "classifier-exact-match");
      affectedProducts += decision.affectedProductCount;
    }
    console.log(`Saved decisions: ${matches.length}; affected product jobs: ${affectedProducts}`);
  }
} finally {
  await pool.end();
}
