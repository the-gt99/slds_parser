import { EntityNotFoundError, IntegrationContractError } from "../core/errors/index.js";
import type { TargetDictionaryProviderRegistry } from "../integrations/index.js";
import type {
  TargetAssignmentRuleDraft,
  TargetAssignmentRuleRepository,
  TargetDictionaryRepository,
} from "../repositories/index.js";

function stringMap(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => typeof entry === "string" && entry.trim() ? [[key, entry.trim()]] : []));
}

export class TargetAssignmentAdminService {
  constructor(
    private readonly repository: TargetAssignmentRuleRepository,
    private readonly dictionaries: TargetDictionaryRepository,
    private readonly providers: TargetDictionaryProviderRegistry,
    private readonly defaultActor = "admin-api",
  ) {}

  list(targetId: string) { return this.repository.list(targetId); }

  listMatchSets(targetId: string) { return this.repository.listMatchSets(targetId); }

  listMatchSetOverlaps(targetId: string) { return this.repository.listMatchSetOverlaps(targetId); }

  history(targetId: string, ruleId: string) { return this.repository.history(targetId, ruleId); }

  async preview(draft: TargetAssignmentRuleDraft, excludeRuleId?: string) {
    await this.validate(draft);
    return this.previewValidated(draft, excludeRuleId);
  }

  async create(draft: TargetAssignmentRuleDraft, actor = this.defaultActor) {
    await this.validate(draft);
    if (draft.enabled !== false) {
      const preview = await this.previewValidated(draft);
      if ((preview.conflicts?.length ?? 0) > 0) {
        throw new IntegrationContractError("Rule conflicts with another enabled rule in the same group and priority");
      }
    }
    return this.repository.create(draft, actor);
  }

  async update(targetId: string, ruleId: string, draft: TargetAssignmentRuleDraft, expectedRevision: string, actor = this.defaultActor, reason?: string) {
    await this.validate(draft);
    const preview = await this.previewValidated(draft, ruleId);
    if ((preview.conflicts?.length ?? 0) > 0) throw new IntegrationContractError("Rule conflicts with another enabled rule in the same group and priority");
    return this.repository.update(targetId, ruleId, draft, expectedRevision, actor, reason);
  }

  async createMatchSet(draft: Parameters<TargetAssignmentRuleRepository["createMatchSet"]>[0], actor = this.defaultActor) {
    this.validateMatchSet(draft);
    return this.repository.createMatchSet(draft, actor);
  }

  async updateMatchSet(targetId: string, matchSetId: string, draft: Parameters<TargetAssignmentRuleRepository["updateMatchSet"]>[2], expectedRevision: string, actor = this.defaultActor) {
    this.validateMatchSet(draft);
    return this.repository.updateMatchSet(targetId, matchSetId, draft, expectedRevision, actor);
  }

  async setEnabled(targetId: string, ruleId: string, enabled: boolean, actor = this.defaultActor, reason?: string) {
    if (enabled) {
      const rule = (await this.repository.list(targetId)).find((item) => item.id === ruleId);
      if (rule === undefined) throw new EntityNotFoundError("Target assignment rule", ruleId);
      const preview = await this.previewValidated({
        targetId: rule.targetId,
        name: rule.name,
        groupCode: rule.groupCode,
        priority: rule.priority,
        conditionGroups: rule.conditionGroups,
        actions: rule.actions.map((action) => ({
          targetScope: action.targetScope,
          dictionaryValueId: action.dictionaryValueId,
          mode: action.mode,
        })),
      });
      if ((preview.conflicts?.length ?? 0) > 0) {
        throw new IntegrationContractError("Rule conflicts with another enabled rule in the same group and priority");
      }
    }
    return this.repository.setEnabled(targetId, ruleId, enabled, actor, reason);
  }

  private async previewValidated(draft: TargetAssignmentRuleDraft, excludeRuleId?: string) {
    const preview = await this.repository.preview(draft);
    const existing = await this.repository.list(draft.targetId);
    const competing = existing.filter((rule) => rule.id !== excludeRuleId && rule.enabled && rule.groupCode === draft.groupCode && rule.priority === draft.priority);
    const conflicts = [];
    for (const rule of competing) {
      const overlap = await this.repository.preview({ ...draft, conditionGroups: [...draft.conditionGroups, ...rule.conditionGroups] });
      if (overlap.productCount > 0) conflicts.push({ ruleId: rule.id, ruleName: rule.name, productCount: overlap.productCount });
    }
    return { ...preview, conflicts };
  }

  private async validate(draft: TargetAssignmentRuleDraft): Promise<void> {
    if (!/^\d+$/u.test(draft.targetId)) throw new IntegrationContractError("targetId must be a positive integer");
    if (draft.name.trim() === "" || draft.name.length > 200) throw new IntegrationContractError("Rule name must contain from 1 to 200 characters");
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(draft.groupCode)) throw new IntegrationContractError("groupCode must be a stable lowercase code");
    if (!Number.isInteger(draft.priority) || draft.priority < -10_000 || draft.priority > 10_000) throw new IntegrationContractError("priority is out of range");
    if (draft.conditionGroups.length === 0 || draft.conditionGroups.some((group) => group.conditions.length === 0)) {
      throw new IntegrationContractError("At least one non-empty target assignment condition group is required");
    }
    for (const condition of draft.conditionGroups.flatMap((group) => group.conditions)) {
      if (!/^(?:resolved\.[a-z][a-z0-9_]*|product\.(?:attribute|metadata|fact)\.[a-zA-Z][a-zA-Z0-9_-]*|candidate\.[a-z][a-z0-9_]*\.(?:sourceValue|(?:context|evidence)\.[a-zA-Z][a-zA-Z0-9_-]*))$/u.test(condition.field)) {
        throw new IntegrationContractError(`Unsupported target assignment field: ${condition.field}`);
      }
      if (condition.operator !== "equals" && condition.operator !== "one_of" && condition.operator !== "contains_phrase") {
        throw new IntegrationContractError(`Unsupported condition operator: ${condition.operator}`);
      }
      if (condition.matchSetId === undefined && (condition.values.length === 0 || condition.values.some((value) => value.trim() === ""))) throw new IntegrationContractError(`Condition ${condition.field} requires values or a match set`);
      if (condition.matchSetId !== undefined && condition.values.length > 0) throw new IntegrationContractError(`Condition ${condition.field} cannot contain inline values and a match set together`);
      if (condition.matchSetId !== undefined && condition.operator === "equals") throw new IntegrationContractError(`equals cannot use a match set for ${condition.field}; use one_of`);
      if (condition.operator === "equals" && condition.matchSetId === undefined && condition.values.length !== 1) throw new IntegrationContractError(`equals requires one value for ${condition.field}`);
    }
    if (draft.actions.length === 0) throw new IntegrationContractError("At least one target assignment action is required");
    const target = (await this.dictionaries.listTargets()).find((item) => item.id === draft.targetId);
    if (target === undefined) throw new EntityNotFoundError("Target", draft.targetId);
    const providerCode = typeof target.config.dictionaryProviderCode === "string" && target.config.dictionaryProviderCode.trim()
      ? target.config.dictionaryProviderCode.trim() : target.exporterCode;
    const provider = this.providers.get(providerCode);
    const entityOverrides = stringMap(target.config.dictionaryEntityMap);
    const scopeOverrides = stringMap(target.config.targetScopeMap);
    const capabilities = provider.classificationCapabilities.map((item) => ({
      ...item,
      entityType: entityOverrides[item.typeCode] ?? item.entityType,
      targetScope: scopeOverrides[item.targetScope] ?? item.targetScope,
    }));
    for (const action of draft.actions) {
      const capability = capabilities.find((item) => item.targetScope === action.targetScope);
      if (capability === undefined) throw new IntegrationContractError(`Unsupported target assignment scope: ${action.targetScope}`);
      if (action.mode !== "add" && action.mode !== "replace") throw new IntegrationContractError(`Unsupported target assignment mode: ${action.mode}`);
      const dictionary = await this.dictionaries.getValue(draft.targetId, action.dictionaryValueId);
      if (dictionary === null || dictionary.entityType !== capability.entityType) {
        throw new IntegrationContractError(`Dictionary value cannot be assigned to ${action.targetScope}`);
      }
    }
  }

  private validateMatchSet(draft: Parameters<TargetAssignmentRuleRepository["createMatchSet"]>[0]): void {
    if (!/^\d+$/u.test(draft.targetId)) throw new IntegrationContractError("targetId must be a positive integer");
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(draft.code)) throw new IntegrationContractError("Match set code must be a stable lowercase code");
    if (draft.name.trim() === "" || draft.name.length > 200) throw new IntegrationContractError("Match set name must contain from 1 to 200 characters");
    if (draft.values.length === 0 || draft.values.some((value) => value.trim() === "")) throw new IntegrationContractError("Match set requires non-empty values");
    const normalized = draft.values.map((value) => value.trim().normalize("NFKC").toLocaleLowerCase("en-US"));
    if (new Set(normalized).size !== normalized.length) throw new IntegrationContractError("Match set contains duplicate values");
  }
}
