import { IntegrationContractError } from "../core/errors/index.js";
import type { RuleV2Draft, RulesV2Repository, TargetAssignmentRuleRepository } from "../repositories/index.js";

const supportedOperators = new Set(["equals", "one_of", "contains_phrase", "regex", "absent"]);

function validate(draft: RuleV2Draft): void {
  if (!(["draft", "shadow", "disabled"] as readonly string[]).includes(draft.status)) throw new IntegrationContractError("Rule v2 cannot be authoritative yet");
  if (draft.name.trim() === "") throw new IntegrationContractError("Rule name is required");
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(draft.groupCode)) throw new IntegrationContractError("Group code has invalid format");
  if (!Number.isSafeInteger(draft.priority)) throw new IntegrationContractError("Priority must be an integer");
  if (draft.conditionGroups.length === 0 || draft.conditionGroups.some((group) => group.conditions.length === 0)) throw new IntegrationContractError("Rule v2 requires non-empty condition groups");
  for (const group of draft.conditionGroups) for (const condition of group.conditions) {
    if (condition.field.trim() === "" || !supportedOperators.has(condition.operator)) throw new IntegrationContractError("Unsupported rule condition");
    if (condition.operator !== "absent" && (condition.values.length === 0 || condition.values.some((value) => value.trim() === ""))) throw new IntegrationContractError("Rule condition values cannot be empty");
  }
  if (draft.actions.length === 0) throw new IntegrationContractError("Rule v2 requires at least one action");
}

export class RulesV2Service {
  constructor(private readonly repository: RulesV2Repository, private readonly legacyPreview: TargetAssignmentRuleRepository) {}

  async overview(targetId?: string) {
    const [summary, items] = await Promise.all([this.repository.summary(), this.repository.list(targetId)]);
    return { mode: "shadow", authoritative: false, summary, items };
  }

  async preview(draft: RuleV2Draft) {
    validate(draft);
    const result = await this.legacyPreview.preview({ sourceId: draft.sourceId, targetId: draft.targetId, name: draft.name, groupCode: draft.groupCode,
      priority: draft.priority, enabled: draft.status === "shadow", conditionGroups: draft.conditionGroups, actions: draft.actions });
    return { ...result, mode: "shadow", writes: false };
  }

  async create(draft: RuleV2Draft, actor: string) { validate(draft); return this.repository.create(draft, actor); }
  async update(id: string, draft: RuleV2Draft, revision: string, actor: string) { validate(draft); return this.repository.update(id, draft, revision, actor); }
}
