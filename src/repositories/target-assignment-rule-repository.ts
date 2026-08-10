import type { EntityId } from "../contracts/index.js";
import type { TargetAssignmentRuleDraft, TargetAssignmentRulePreview, TargetAssignmentRuleRecord } from "./types.js";

export interface TargetAssignmentRuleRepository {
  list(targetId: EntityId): Promise<readonly TargetAssignmentRuleRecord[]>;
  preview(draft: TargetAssignmentRuleDraft): Promise<TargetAssignmentRulePreview>;
  create(draft: TargetAssignmentRuleDraft, actor: string): Promise<TargetAssignmentRuleRecord>;
  setEnabled(targetId: EntityId, ruleId: EntityId, enabled: boolean, actor: string, reason?: string): Promise<TargetAssignmentRuleRecord>;
}
