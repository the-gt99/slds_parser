import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { loadWordPressTargetConfig } from "../config/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import { TargetDictionaryProviderRegistry, WordPressDictionaryProvider } from "../integrations/index.js";
import {
  createPostgresPool,
  PostgresTargetAssignmentRuleRepository,
  PostgresTargetDictionaryRepository,
} from "../infrastructure/db/index.js";
import type { TargetAssignmentRuleDraft, TargetDictionaryValueRecord } from "../repositories/index.js";
import { TargetAssignmentAdminService } from "../services/index.js";

interface FootwearCategoryRule {
  readonly code: string;
  readonly label: string;
  readonly menCategory: string;
  readonly womenCategory: string;
  readonly priority: number;
  readonly aliases: readonly string[];
  readonly models: readonly string[];
}

interface FootwearRuleConfig {
  readonly categories: readonly FootwearCategoryRule[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new IntegrationContractError(`${field} must be a list`);
  const result = value.map((item) => String(item).trim());
  if (result.length === 0 || result.some((item) => item === "")) {
    throw new IntegrationContractError(`${field} must contain non-empty values`);
  }
  const normalized = result.map((item) => item.normalize("NFKC").toLocaleLowerCase("en-US"));
  if (new Set(normalized).size !== normalized.length) throw new IntegrationContractError(`${field} contains duplicates`);
  return result;
}

export function parseFootwearRuleConfig(value: unknown): FootwearRuleConfig {
  if (!isRecord(value) || !Array.isArray(value.categories) || value.categories.length === 0) {
    throw new IntegrationContractError("Footwear rule configuration has an invalid structure");
  }
  const categories = value.categories.map((entry, index) => {
    if (!isRecord(entry)) throw new IntegrationContractError(`categories[${index}] must be an object`);
    const code = String(entry.code ?? "").trim();
    const label = String(entry.label ?? "").trim();
    const menCategory = String(entry.menCategory ?? "").trim();
    const womenCategory = String(entry.womenCategory ?? "").trim();
    const priority = Number(entry.priority);
    if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(code) || label === "" || menCategory === "" || womenCategory === "") {
      throw new IntegrationContractError(`categories[${index}] has invalid names`);
    }
    if (!Number.isInteger(priority)) throw new IntegrationContractError(`categories[${index}].priority must be an integer`);
    return {
      code,
      label,
      menCategory,
      womenCategory,
      priority,
      aliases: strings(entry.aliases, `categories[${index}].aliases`),
      models: strings(entry.models, `categories[${index}].models`),
    };
  });
  if (new Set(categories.map((item) => item.code)).size !== categories.length) {
    throw new IntegrationContractError("Footwear category codes must be unique");
  }
  return { categories };
}

function dictionaryByName(values: readonly TargetDictionaryValueRecord[], name: string): TargetDictionaryValueRecord {
  const normalized = name.normalize("NFKC").toLocaleLowerCase("ru-RU");
  const matches = values.filter((item) => item.name.normalize("NFKC").toLocaleLowerCase("ru-RU") === normalized);
  if (matches.length !== 1) throw new IntegrationContractError(`WordPress category must resolve exactly once: ${name}`);
  return matches[0]!;
}

function ruleDraft(input: {
  readonly targetId: string;
  readonly category: FootwearCategoryRule;
  readonly audience: "men" | "women";
  readonly dictionaryValueId: string;
  readonly modelSetId: string;
  readonly aliasSetId: string;
  readonly aliases: boolean;
}): TargetAssignmentRuleDraft {
  const audienceLabel = input.audience === "men" ? "Мужские" : "Женские";
  const categoryName = input.audience === "men" ? input.category.menCategory : input.category.womenCategory;
  return {
    targetId: input.targetId,
    name: input.aliases
      ? `Признаки ${input.category.aliases.join("/")} → ${categoryName}`
      : `Модели ${input.category.label} → ${categoryName}`,
    groupCode: "shoe_leaf_category",
    priority: input.aliases ? input.category.priority - 100 : input.category.priority,
    enabled: true,
    conditionGroups: [
      ...(input.aliases ? [
        { conditions: [{ field: "candidate.category.context.productCategory", operator: "equals" as const, values: ["shoes"] }] },
        { conditions: [{ field: "product.title", operator: "contains_phrase" as const, values: [], matchSetId: input.aliasSetId }] },
      ] : [
        { conditions: [{ field: "candidate.model.sourceValue", operator: "contains_phrase" as const, values: [], matchSetId: input.modelSetId }] },
      ]),
      { conditions: [{ field: "candidate.category.context.audience", operator: "equals", values: [input.audience] }] },
    ],
    actions: [{ targetScope: "product.category", dictionaryValueId: input.dictionaryValueId, mode: "replace" }],
  };
}

async function main(): Promise<void> {
  const configPath = process.env.WORDPRESS_FOOTWEAR_RULES_PATH?.trim() || "config/wordpress-footwear-rules.json";
  const apply = ["1", "true"].includes(process.env.WORDPRESS_FOOTWEAR_RULES_APPLY?.toLocaleLowerCase("en-US") ?? "");
  const preserveExisting = process.env.WORDPRESS_FOOTWEAR_RULES_REPLACE !== "1";
  const config = parseFootwearRuleConfig(JSON.parse(await readFile(configPath, "utf8")));
  const wordpress = loadWordPressTargetConfig();
  if (wordpress === null) throw new IntegrationContractError("WordPress target configuration is required");
  const pool = createPostgresPool();
  try {
    const dictionaries = new PostgresTargetDictionaryRepository(pool);
    const target = (await dictionaries.listTargets()).find((item) => item.code === (process.env.WORDPRESS_FOOTWEAR_TARGET ?? "slamdunk"));
    if (target === undefined) throw new IntegrationContractError("Target was not found");
    if (target.enabled) throw new IntegrationContractError(`Target ${target.code} must stay disabled during footwear rule import`);
    const categoryValues = await dictionaries.listValues({ targetId: target.id, entityType: "product_categories", limit: 100_000, offset: 0 });
    const providers = new TargetDictionaryProviderRegistry();
    providers.register(new WordPressDictionaryProvider(wordpress));
    const repository = new PostgresTargetAssignmentRuleRepository(pool);
    const admin = new TargetAssignmentAdminService(repository, dictionaries, providers, "footwear-rule-import");
    const sets = new Map((await admin.listMatchSets(target.id)).map((item) => [item.code, item]));
    const rules = await admin.list(target.id);
    const results = [];

    for (const category of config.categories) {
      const saveSet = async (kind: "models" | "aliases", configured: readonly string[]) => {
        const code = `footwear_${category.code}_${kind}`;
        const existing = sets.get(code);
        const merged = preserveExisting && existing !== undefined
          ? [...new Map([...existing.values, ...configured].map((item) => [item.normalize("NFKC").toLocaleLowerCase("en-US"), item])).values()]
          : [...configured];
        if (!apply) return { id: existing?.id ?? "preview", code, values: merged, changed: existing === undefined || merged.length !== existing.values.length };
        const draft = { targetId: target.id, code, name: `${category.label}: ${kind === "models" ? "модели" : "английские признаки"}`, values: merged,
          reason: "Импорт правил категорий обуви из утверждённой таблицы" };
        const saved = existing === undefined
          ? await admin.createMatchSet(draft)
          : await admin.updateMatchSet(target.id, existing.id, draft, existing.revision);
        sets.set(code, saved);
        return { id: saved.id, code, values: saved.values, changed: true };
      };
      const modelSet = await saveSet("models", category.models);
      const aliasSet = await saveSet("aliases", category.aliases);
      for (const audience of ["men", "women"] as const) {
        const categoryName = audience === "men" ? category.menCategory : category.womenCategory;
        const dictionary = dictionaryByName(categoryValues, categoryName);
        for (const aliases of [false, true]) {
          const draft = ruleDraft({ targetId: target.id, category, audience, dictionaryValueId: dictionary.id,
            modelSetId: modelSet.id, aliasSetId: aliasSet.id, aliases });
          const existing = rules.find((item) => item.name === draft.name && item.groupCode === draft.groupCode);
          if (apply) {
            if (existing === undefined) await admin.create(draft);
            else await admin.update(target.id, existing.id, draft, existing.revision, "footwear-rule-import", "Повторный импорт правил категорий обуви");
          }
          results.push({ name: draft.name, existing: existing !== undefined, action: apply ? (existing === undefined ? "created" : "updated") : "preview" });
        }
      }
    }
    console.log(JSON.stringify({ mode: apply ? "apply" : "preview", target: target.code, preserveExisting,
      categories: config.categories.map((item) => ({ code: item.code, models: item.models.length, aliases: item.aliases.length })), rules: results }, null, 2));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
