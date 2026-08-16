import type { EntityId } from "../contracts/index.js";
import type {
  TargetAssignmentHistoryRecord,
  TargetAssignmentMatchSetDraft,
  TargetAssignmentMatchSetOverlap,
  TargetAssignmentMatchSetRecord,
  TargetAssignmentRuleDraft,
  TargetAssignmentRulePreview,
  TargetAssignmentRuleRecord,
} from "./types.js";

export interface TargetAssignmentRuleRepository {
  list(targetId: EntityId): Promise<readonly TargetAssignmentRuleRecord[]>;
  preview(draft: TargetAssignmentRuleDraft): Promise<TargetAssignmentRulePreview>;
  create(draft: TargetAssignmentRuleDraft, actor: string): Promise<TargetAssignmentRuleRecord>;
  update(targetId: EntityId, ruleId: EntityId, draft: TargetAssignmentRuleDraft, expectedRevision: string, actor: string, reason?: string): Promise<TargetAssignmentRuleRecord>;
  setEnabled(targetId: EntityId, ruleId: EntityId, enabled: boolean, actor: string, reason?: string): Promise<TargetAssignmentRuleRecord>;
  history(targetId: EntityId, ruleId: EntityId): Promise<readonly TargetAssignmentHistoryRecord[]>;
  listMatchSets(targetId: EntityId): Promise<readonly TargetAssignmentMatchSetRecord[]>;
  createMatchSet(draft: TargetAssignmentMatchSetDraft, actor: string): Promise<TargetAssignmentMatchSetRecord>;
  updateMatchSet(targetId: EntityId, matchSetId: EntityId, draft: TargetAssignmentMatchSetDraft, expectedRevision: string, actor: string): Promise<TargetAssignmentMatchSetRecord>;
  listMatchSetOverlaps(targetId: EntityId): Promise<readonly TargetAssignmentMatchSetOverlap[]>;
}
