import type {
  ClassificationDecisionContext,
  ClassificationDecisionKey,
  ClassificationConfigListQuery,
  ClassificationConfigListResult,
  ClassificationReferenceValueOption,
  ClassificationReviewItem,
  ClassificationReviewQuery,
  ClassificationRuleCandidateRecord,
  TargetClassificationProjectionCommand,
  TargetClassificationProjectionPreview,
  TargetClassificationProjectionRecord,
  CreateClassificationRuleInput,
  CreateClassificationRuleResult,
  SaveClassificationDecisionInput,
  SaveClassificationDecisionResult,
  UpdateClassificationRuleInput,
  UpdateClassificationRuleResult,
} from "./types.js";

export interface ClassificationAdminRepository {
  listConfiguration(query: ClassificationConfigListQuery): Promise<ClassificationConfigListResult>;
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
  updateRule(input: UpdateClassificationRuleInput): Promise<UpdateClassificationRuleResult>;
  setRuleEnabled(input: {
    readonly ruleId: string;
    readonly enabled: boolean;
    readonly actor: string;
    readonly reason?: string;
  }): Promise<{ readonly affectedProductCount: number; readonly revision: string }>;
  listTargetProjections(
    targetId: string,
    resolutionKind: "mapping" | "rule",
    resolutionId: string,
  ): Promise<readonly TargetClassificationProjectionRecord[]>;
  previewTargetProjection(input: TargetClassificationProjectionCommand): Promise<TargetClassificationProjectionPreview>;
  createTargetProjection(input: TargetClassificationProjectionCommand): Promise<{
    readonly projection: TargetClassificationProjectionRecord;
    readonly preview: TargetClassificationProjectionPreview;
    readonly affectedProductCount: number;
  }>;
  deactivateTargetProjection(input: {
    readonly targetId: string;
    readonly projectionId: string;
    readonly actor: string;
    readonly reason?: string;
  }): Promise<{ readonly preview: TargetClassificationProjectionPreview; readonly affectedProductCount: number }>;
}
