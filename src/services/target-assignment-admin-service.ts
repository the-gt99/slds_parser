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

  async preview(draft: TargetAssignmentRuleDraft) {
    await this.validate(draft);
    return this.previewValidated(draft);
  }

  async create(draft: TargetAssignmentRuleDraft, actor = this.defaultActor) {
    await this.validate(draft);
    const preview = await this.previewValidated(draft);
    if ((preview.conflicts?.length ?? 0) > 0) {
      throw new IntegrationContractError("Rule conflicts with another enabled rule in the same group and priority");
    }
    return this.repository.create(draft, actor);
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
        conditions: rule.conditions,
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

  private async previewValidated(draft: TargetAssignmentRuleDraft) {
    const preview = await this.repository.preview(draft);
    const existing = await this.repository.list(draft.targetId);
    const competing = existing.filter((rule) => rule.enabled && rule.groupCode === draft.groupCode && rule.priority === draft.priority);
    const conflicts = [];
    for (const rule of competing) {
      const overlap = await this.repository.preview({ ...draft, conditions: [...draft.conditions, ...rule.conditions] });
      if (overlap.productCount > 0) conflicts.push({ ruleId: rule.id, ruleName: rule.name, productCount: overlap.productCount });
    }
    return { ...preview, conflicts };
  }

  private async validate(draft: TargetAssignmentRuleDraft): Promise<void> {
    if (!/^\d+$/u.test(draft.targetId)) throw new IntegrationContractError("targetId must be a positive integer");
    if (draft.name.trim() === "" || draft.name.length > 200) throw new IntegrationContractError("Rule name must contain from 1 to 200 characters");
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(draft.groupCode)) throw new IntegrationContractError("groupCode must be a stable lowercase code");
    if (!Number.isInteger(draft.priority) || draft.priority < -10_000 || draft.priority > 10_000) throw new IntegrationContractError("priority is out of range");
    if (draft.conditions.length === 0) throw new IntegrationContractError("At least one target assignment condition is required");
    for (const condition of draft.conditions) {
      if (!/^(?:resolved\.[a-z][a-z0-9_]*|product\.(?:attribute|metadata)\.[a-zA-Z][a-zA-Z0-9_-]*|candidate\.[a-z][a-z0-9_]*\.(?:sourceValue|(?:context|evidence)\.[a-zA-Z][a-zA-Z0-9_-]*))$/u.test(condition.field)) {
        throw new IntegrationContractError(`Unsupported target assignment field: ${condition.field}`);
      }
      if (condition.operator !== "equals" && condition.operator !== "one_of") throw new IntegrationContractError(`Unsupported condition operator: ${condition.operator}`);
      if (condition.values.length === 0 || condition.values.some((value) => value.trim() === "")) throw new IntegrationContractError(`Condition ${condition.field} requires values`);
      if (condition.operator === "equals" && condition.values.length !== 1) throw new IntegrationContractError(`equals requires one value for ${condition.field}`);
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
}
