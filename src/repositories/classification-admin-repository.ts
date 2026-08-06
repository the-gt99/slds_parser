import type {
  ClassificationDecisionContext,
  ClassificationDecisionPreview,
  ClassificationDecisionKey,
  ClassificationConfigListQuery,
  ClassificationConfigListResult,
  ClassificationReferenceValueOption,
  ClassificationReviewItem,
  ClassificationReviewQuery,
  ClassificationRuleCandidateRecord,
  ClassificationRuleAdminRecord,
  ClassificationRuleConditionFieldOption,
  ClassificationConfigHistoryRecord,
  TargetValueMappingAdminRecord,
  TargetValueMappingCommand,
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
    currentProcessorVersion?: string,
  ): Promise<readonly ClassificationRuleCandidateRecord[]>;
  getRule(ruleId: string): Promise<ClassificationRuleAdminRecord | null>;
  listRuleConditionFields(
    sourceId: string,
    typeCode: string,
    currentProcessorVersion?: string,
  ): Promise<readonly ClassificationRuleConditionFieldOption[]>;
  listConfigurationHistory(kind: "mapping" | "rule" | "target_mapping" | "projection", id: string): Promise<readonly ClassificationConfigHistoryRecord[]>;
  getDecisionContext(key: ClassificationDecisionKey): Promise<ClassificationDecisionContext | null>;
  previewDecision(input: SaveClassificationDecisionInput): Promise<ClassificationDecisionPreview>;
  saveDecision(input: SaveClassificationDecisionInput): Promise<SaveClassificationDecisionResult>;
  createRule(input: CreateClassificationRuleInput): Promise<CreateClassificationRuleResult>;
  updateRule(input: UpdateClassificationRuleInput): Promise<UpdateClassificationRuleResult>;
  setRuleEnabled(input: {
    readonly ruleId: string;
    readonly enabled: boolean;
    readonly actor: string;
    readonly reason?: string;
    readonly affectedSourceProductIds: readonly string[];
  }): Promise<{ readonly affectedProductCount: number; readonly revision: string }>;
  getTargetValueMapping(mappingId: string): Promise<TargetValueMappingAdminRecord | null>;
  previewTargetValueMapping(input: TargetValueMappingCommand): Promise<TargetClassificationProjectionPreview>;
  updateTargetValueMapping(input: TargetValueMappingCommand): Promise<{
    readonly mapping: TargetValueMappingAdminRecord;
    readonly preview: TargetClassificationProjectionPreview;
    readonly affectedProductCount: number;
  }>;
  setTargetValueMappingEnabled(input: {
    readonly mappingId: string;
    readonly enabled: boolean;
    readonly actor: string;
    readonly reason?: string;
  }): Promise<{ readonly affectedProductCount: number; readonly revision: string }>;
  listTargetProjections(
    targetId: string,
    resolutionKind: "mapping" | "rule",
    resolutionId: string,
  ): Promise<readonly TargetClassificationProjectionRecord[]>;
  getTargetProjection(targetId: string, projectionId: string): Promise<TargetClassificationProjectionRecord | null>;
  previewTargetProjection(input: TargetClassificationProjectionCommand): Promise<TargetClassificationProjectionPreview>;
  createTargetProjection(input: TargetClassificationProjectionCommand): Promise<{
    readonly projection: TargetClassificationProjectionRecord;
    readonly preview: TargetClassificationProjectionPreview;
    readonly affectedProductCount: number;
  }>;
  updateTargetProjection(input: TargetClassificationProjectionCommand & { readonly projectionId: string }): Promise<{
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
