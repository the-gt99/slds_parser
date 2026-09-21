import type { TargetAssignmentDTO, UniversalProductDTO } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type { TargetAssignmentConditionRecord, TargetAssignmentRuleRecord } from "../repositories/index.js";

function normalize(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function normalizePhrase(value: string): string {
  return normalize(value).replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(?:wmns|womens|mens)\b/gu, " ").replace(/\s+/gu, " ").trim();
}

function scalar(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(scalar);
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? [String(value)] : [];
}

function nested(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const assignmentRegexCache = new Map<string, RegExp>();

export function compileTargetAssignmentRegex(pattern: string): RegExp {
  const cached = assignmentRegexCache.get(pattern);
  if (cached !== undefined) return cached;
  if (pattern.length > 256) {
    throw new IntegrationContractError("Target assignment regex must contain no more than 256 characters");
  }
  if (/\\[1-9]/u.test(pattern) || pattern.includes("(?")) {
    throw new IntegrationContractError("Target assignment regex cannot contain backreferences or lookaround groups");
  }
  if (/\([^)]*[+*][^)]*\)[+*{]/u.test(pattern)) {
    throw new IntegrationContractError("Target assignment regex cannot contain nested unbounded quantifiers");
  }
  try {
    const compiled = new RegExp(pattern, "iu");
    assignmentRegexCache.set(pattern, compiled);
    return compiled;
  } catch (error) {
    throw new IntegrationContractError(
      `Invalid target assignment regex: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function targetAssignmentFieldValues(product: UniversalProductDTO, field: string): readonly string[] {
  const parts = field.split(".");
  if (field === "product.title") return [product.title];
  if (field === "product.description") return [product.description];
  if (field === "product.sku") return [product.sku];
  if (parts[0] === "resolved" && parts.length === 2) {
    return product.classification?.resolved.filter((item) => item.typeCode === parts[1]).map((item) => item.referenceValueId) ?? [];
  }
  if (parts[0] === "product" && parts[1] === "attribute" && parts.length >= 3) {
    if (field === "product.attribute.ageGroupsJoined") {
      const groups = product.attributes.ageGroups;
      return Array.isArray(groups) && groups.every((value) => typeof value === "string") && groups.length > 0
        ? [groups.join("|")] : [];
    }
    return scalar(nested(product.attributes, parts.slice(2)));
  }
  if (parts[0] === "product" && parts[1] === "metadata" && parts.length >= 3) {
    return scalar(nested(product.metadata, parts.slice(2)));
  }
  if (parts[0] === "product" && parts[1] === "fact" && parts.length >= 3) {
    return scalar(nested(product.sourceFacts, parts.slice(2)));
  }
  if (parts[0] !== "candidate" || parts.length < 3) {
    throw new IntegrationContractError(`Unsupported target assignment field: ${field}`);
  }
  const candidates = product.referenceCandidates.filter((item) => item.typeCode === parts[1]);
  if (parts.length === 3 && parts[2] === "sourceValue") return candidates.map((item) => item.sourceValue);
  if (parts.length === 4 && (parts[2] === "context" || parts[2] === "evidence")) {
    return candidates.flatMap((item) => scalar(item[parts[2] as "context" | "evidence"][parts[3]!]));
  }
  throw new IntegrationContractError(`Unsupported target assignment field: ${field}`);
}

const compiledConditions = new WeakMap<TargetAssignmentConditionRecord, {
  readonly expected: ReadonlySet<string>;
  readonly phrases: readonly string[];
  readonly patterns: readonly RegExp[];
}>();

function compiledCondition(condition: TargetAssignmentConditionRecord) {
  const cached = compiledConditions.get(condition);
  if (cached !== undefined) return cached;
  if (condition.values.length === 0 || condition.values.some((value) => value.trim() === "")) {
    throw new IntegrationContractError(`Target assignment condition ${condition.field} requires non-empty values`);
  }
  if (condition.operator === "equals" && condition.values.length !== 1) throw new IntegrationContractError(`equals requires one value for ${condition.field}`);
  const compiled = { expected: new Set(condition.values.map(normalize)),
    phrases: condition.operator === "contains_phrase" ? condition.values.map(normalizePhrase) : [],
    patterns: condition.operator === "regex" ? condition.values.map(compileTargetAssignmentRegex) : [] };
  compiledConditions.set(condition, compiled);
  return compiled;
}

interface PreparedField { readonly raw: readonly string[]; readonly normalized: ReadonlySet<string>; readonly phrases: readonly string[] }

export function matchesTargetAssignmentCondition(product: UniversalProductDTO, condition: TargetAssignmentConditionRecord,
  fieldValues: (field: string) => readonly string[] = (field) => targetAssignmentFieldValues(product, field),
  cache = new Map<string, PreparedField>()): boolean {
  let field = cache.get(condition.field);
  if (field === undefined) {
    const raw = fieldValues(condition.field);
    field = { raw, normalized: new Set(raw.map(normalize)), phrases: raw.map((value) => ` ${normalizePhrase(value)} `) };
    cache.set(condition.field, field);
  }
  if (condition.operator === "absent") {
    if (condition.values.length > 0 || condition.matchSetId !== undefined) {
      throw new IntegrationContractError(`absent does not accept values for ${condition.field}`);
    }
    return field.raw.length === 0;
  }
  const compiled = compiledCondition(condition);
  const actual = field.normalized;
  if (condition.operator === "equals" || condition.operator === "one_of") return [...actual].some((value) => compiled.expected.has(value));
  if (condition.operator === "contains_phrase") {
    const phrases = compiled.phrases;
    return field.phrases.some((actualPhrase) => {
      return phrases.some((phrase) => actualPhrase.includes(` ${phrase} `));
    });
  }
  if (condition.operator === "regex") {
    const patterns = compiled.patterns;
    return field.raw.some((value) => patterns.some((pattern) => pattern.test(value)));
  }
  throw new IntegrationContractError(`Unsupported target assignment operator: ${String(condition.operator)}`);
}

export function resolveTargetAssignments(
  product: UniversalProductDTO,
  rules: readonly TargetAssignmentRuleRecord[],
  fieldValues?: (field: string) => readonly string[],
): readonly TargetAssignmentDTO[] {
  const fieldCache = new Map<string, PreparedField>();
  const matching = rules.filter((rule) => rule.enabled && rule.conditionGroups.every((group) =>
    group.conditions.some((condition) => matchesTargetAssignmentCondition(product, condition, fieldValues, fieldCache))));
  const groups = new Map<string, TargetAssignmentRuleRecord[]>();
  for (const rule of matching) groups.set(rule.groupCode, [...(groups.get(rule.groupCode) ?? []), rule]);
  const result: TargetAssignmentDTO[] = [];
  for (const [groupCode, groupRules] of groups) {
    const highest = Math.max(...groupRules.map((rule) => rule.priority));
    const winners = groupRules.filter((rule) => rule.priority === highest);
    if (winners.length !== 1) {
      const ruleDetails = winners.map((rule) => `${rule.name} (#${rule.id})`).join(", ");
      throw new IntegrationContractError(
        `Target assignment group ${groupCode} has ${winners.length} equally prioritized matching rules: ${ruleDetails}`,
      );
    }
    const winner = winners[0]!;
    if (winner.actions.length === 0) {
      throw new IntegrationContractError(`Target assignment rule ${winner.id} has no active dictionary actions`);
    }
    for (const action of winner.actions) {
      result.push({
        ...(action.primarySourceBrand === true ? { primarySourceBrand: true } : {}),
        ruleId: winner.id,
        groupCode,
        targetScope: action.targetScope,
        externalValue: action.externalValue,
        externalLabel: action.externalLabel,
        mode: action.mode,
      });
    }
  }
  return result;
}
