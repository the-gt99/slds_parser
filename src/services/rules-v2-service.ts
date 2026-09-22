import { IntegrationContractError } from "../core/errors/index.js";
import type { RuleV2Draft, RuleV2ImportedDraft, RulesV2Repository } from "../repositories/index.js";
import { compileTargetAssignmentRegex } from "./target-assignment-rule-matcher.js";
import { validateRulesV2Field } from "./rules-v2-fields.js";
import type { RulesV2WorkbenchQuery } from "./rules-v2-preview.js";

const supportedOperators = new Set(["equals", "one_of", "contains_phrase", "regex", "absent"]);

function validate(draft: RuleV2Draft): void {
  if (!(["draft", "shadow", "disabled"] as readonly string[]).includes(draft.status)) throw new IntegrationContractError("Unsupported rule status");
  if (draft.name.trim() === "") throw new IntegrationContractError("Rule name is required");
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(draft.groupCode)) throw new IntegrationContractError("Group code has invalid format");
  if (!Number.isSafeInteger(draft.priority) || Math.abs(draft.priority) > 2147483647) throw new IntegrationContractError("Priority must fit an integer column");
  if (draft.conditionGroups.length === 0 || draft.conditionGroups.some((group) => group.conditions.length === 0)) throw new IntegrationContractError("Rule v2 requires non-empty condition groups");
  for (const group of draft.conditionGroups) for (const condition of group.conditions) {
    validateRulesV2Field(condition.field);
    if (condition.field.trim() === "" || !supportedOperators.has(condition.operator)) throw new IntegrationContractError("Unsupported rule condition");
    if (condition.operator !== "absent" && (condition.values.length === 0 || condition.values.some((value) => value.trim() === ""))) throw new IntegrationContractError("Rule condition values cannot be empty");
    if (condition.operator === "equals" && condition.values.length !== 1) throw new IntegrationContractError("equals requires exactly one value");
    if (condition.operator === "absent" && (condition.values.length !== 0 || condition.matchSetId !== undefined)) throw new IntegrationContractError("absent does not accept values");
    if (condition.operator === "regex") condition.values.forEach(compileTargetAssignmentRegex);
  }
  if (draft.actions.length === 0) throw new IntegrationContractError("Rule v2 requires at least one action");
  for (const action of draft.actions) if (action.primarySourceBrand !== undefined
    && (typeof action.primarySourceBrand !== "boolean" || action.targetScope !== "product.brand")) {
    throw new IntegrationContractError("Primary source brand can only be set on a brand action");
  }
}

export class RulesV2Service {
  constructor(private readonly repository: RulesV2Repository,
    private readonly evaluator: {
      preview(draft: RuleV2Draft): Promise<object>;
      workbench?(query: RulesV2WorkbenchQuery): Promise<object>;
      startFullPreview?(draft: RuleV2Draft): { id: string };
      fullPreviewStatus?(id: string): object;
    },
    private readonly executionState?: () => Promise<{ mode: "v1" | "v2" }>) {}

  async updateImported(id: string, raw: unknown, revision: string, actor: string) {
    const object = (value: unknown): Record<string, unknown> => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new IntegrationContractError("Expected an object");
      return value as Record<string, unknown>;
    };
    const draft = object(raw);
    if (typeof draft.name !== "string" || draft.name.trim() === "" || typeof draft.priority !== "number"
      || !Number.isSafeInteger(draft.priority) || Math.abs(draft.priority) > 2147483647
      || !["draft", "shadow", "disabled"].includes(String(draft.status))) throw new IntegrationContractError("Invalid imported rule properties");
    if (!Array.isArray(draft.conditionGroups) || draft.conditionGroups.length === 0 || !Array.isArray(draft.actions) || draft.actions.length === 0) throw new IntegrationContractError("Conditions and actions are required");
    for (const rawGroup of draft.conditionGroups) {
      const group = object(rawGroup);
      if (!Array.isArray(group.conditions) || group.conditions.length === 0) throw new IntegrationContractError("Empty condition group");
      for (const rawCondition of group.conditions) {
        const condition = object(rawCondition);
        if (typeof condition.field !== "string" || condition.field.trim() === ""
          || ![...supportedOperators, "contains", "all_words"].includes(String(condition.operator))
          || !Array.isArray(condition.values) || condition.values.some((v) => typeof v !== "string" || v.trim() === "")) throw new IntegrationContractError("Invalid imported condition");
        if (condition.operator === "absent" ? condition.values.length !== 0 : condition.values.length === 0) throw new IntegrationContractError("Invalid condition values");
        if (condition.operator === "equals" && condition.values.length !== 1) throw new IntegrationContractError("equals requires one value");
        if (condition.operator === "regex") for (const pattern of condition.values) {
          if (pattern.length > 256) throw new IntegrationContractError("Regex exceeds 256 characters");
          try { new RegExp(pattern, "iu"); } catch { throw new IntegrationContractError("Invalid regex"); }
        }
      }
    }
    for (const rawAction of draft.actions) {
      const action = object(rawAction);
      if (action.kind === "resolve_reference") {
        if (typeof action.referenceType !== "string" || !["confirmed", "ignored"].includes(String(action.resolutionStatus))
          || (action.resolutionStatus === "confirmed" && !/^\d+$/u.test(String(action.referenceValueId)))) throw new IntegrationContractError("Invalid reference action");
      } else if ((action.kind !== undefined && action.kind !== "assign_target_term") || typeof action.targetScope !== "string"
        || !/^\d+$/u.test(String(action.dictionaryValueId)) || !["add", "replace"].includes(String(action.mode))) throw new IntegrationContractError("Invalid target action");
      if (action.primarySourceBrand !== undefined && (typeof action.primarySourceBrand !== "boolean" || action.targetScope !== "product.brand")) throw new IntegrationContractError("Invalid primary source brand action");
    }
    if (this.repository.updateImported === undefined) throw new IntegrationContractError("Imported rule editing is unavailable");
    return this.repository.updateImported(id, draft as unknown as RuleV2ImportedDraft, revision, actor);
  }

  async overview(targetId?: string, query: { readonly search?: string; readonly offset?: number } = {}) {
    const offset = query.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new IntegrationContractError("Invalid rules page offset");
    const [summary, items] = await Promise.all([this.repository.summary(), this.repository.list(targetId, { ...query, offset, limit: 101 })]);
    const active = (await this.executionState?.())?.mode === "v2";
    return { mode: active ? "active" : "shadow", authoritative: active, summary, items: items.slice(0, 100), page: { offset, limit: 100, hasMore: items.length > 100 } };
  }

  async preview(draft: RuleV2Draft) {
    validate(draft);
    const mode = (await this.executionState?.())?.mode === "v2" ? "active" : "shadow";
    return { ...await this.evaluator.preview(draft), mode, writes: false };
  }

  async workbench(query: RulesV2WorkbenchQuery) {
    if (this.evaluator.workbench === undefined) throw new IntegrationContractError("Rules v2 workbench is unavailable");
    return this.evaluator.workbench(query);
  }

  startFullPreview(draft: RuleV2Draft) {
    validate(draft);
    if (this.evaluator.startFullPreview === undefined) throw new IntegrationContractError("Full preview is unavailable");
    return this.evaluator.startFullPreview(draft);
  }

  fullPreviewStatus(id: string) {
    if (this.evaluator.fullPreviewStatus === undefined) throw new IntegrationContractError("Full preview is unavailable");
    return this.evaluator.fullPreviewStatus(id);
  }

  async create(draft: RuleV2Draft, actor: string) { validate(draft); return this.repository.create(draft, actor); }
  async update(id: string, draft: RuleV2Draft, revision: string, actor: string) { validate(draft); return this.repository.update(id, draft, revision, actor); }
}
