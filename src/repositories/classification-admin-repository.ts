import type {
  ClassificationDecisionContext,
  ClassificationDecisionKey,
  ClassificationReferenceValueOption,
  ClassificationReviewItem,
  ClassificationReviewQuery,
  ClassificationRuleCandidateRecord,
  CreateClassificationRuleInput,
  CreateClassificationRuleResult,
  SaveClassificationDecisionInput,
  SaveClassificationDecisionResult,
} from "./types.js";

export interface ClassificationAdminRepository {
  listReviewQueue(query: ClassificationReviewQuery): Promise<readonly ClassificationReviewItem[]>;
  listReferenceValues(
    typeCode: string,
    search: string | undefined,
    limit: number,
  ): Promise<readonly ClassificationReferenceValueOption[]>;
  listRuleCandidates(
    sourceId: string,
    typeCode: string,
  ): Promise<readonly ClassificationRuleCandidateRecord[]>;
  getDecisionContext(key: ClassificationDecisionKey): Promise<ClassificationDecisionContext | null>;
  saveDecision(input: SaveClassificationDecisionInput): Promise<SaveClassificationDecisionResult>;
  createRule(input: CreateClassificationRuleInput): Promise<CreateClassificationRuleResult>;
}
