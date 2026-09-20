import type { EntityId } from "../contracts/index.js";
import type { TargetAssignmentConditionGroupRecord } from "./types.js";

export type RuleV2Status = "draft" | "shadow" | "disabled";
export type RuleV2OriginKind = "native" | "exact_mapping" | "classification_rule" | "target_mapping"
  | "classification_projection" | "reference_projection" | "target_assignment_rule";

export interface RuleV2Action {
  readonly primarySourceBrand?: boolean;
  readonly kind?: "assign_target_term";
  readonly targetScope: string;
  readonly dictionaryValueId: EntityId;
  readonly externalValue: string;
  readonly externalLabel: string;
  readonly mode: "add" | "replace";
}

export interface RuleV2ReferenceAction {
  readonly kind: "resolve_reference";
  readonly referenceType: string;
  readonly referenceValueId: EntityId | null;
  readonly referenceValueCode: string | null;
  readonly referenceValueName: string | null;
  readonly resolutionStatus: "confirmed" | "ignored";
}

export type RuleV2StoredAction = RuleV2Action | RuleV2ReferenceAction;

export interface RuleV2Record {
  readonly id: EntityId;
  readonly sourceId: EntityId | null;
  readonly sourceCode: string | null;
  readonly targetId: EntityId | null;
  readonly targetCode: string | null;
  readonly name: string;
  readonly groupCode: string;
  readonly priority: number;
  readonly status: RuleV2Status;
  readonly conditionGroups: readonly TargetAssignmentConditionGroupRecord[];
  readonly actions: readonly RuleV2StoredAction[];
  readonly originKind: RuleV2OriginKind;
  readonly originId: EntityId | null;
  readonly originRevision: string;
  readonly originPayload: Readonly<Record<string, unknown>>;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuleV2Draft {
  readonly previewRuleId?: EntityId;
  readonly sourceId: EntityId;
  readonly targetId: EntityId;
  readonly name: string;
  readonly groupCode: string;
  readonly priority: number;
  readonly status: RuleV2Status;
  readonly conditionGroups: readonly TargetAssignmentConditionGroupRecord[];
  readonly actions: readonly { readonly targetScope: string; readonly dictionaryValueId: EntityId; readonly mode: "add" | "replace"; readonly primarySourceBrand?: boolean }[];
  readonly reason?: string;
}

export interface RuleV2Summary {
  readonly catalog?: { readonly total: number; readonly exact: number; readonly conditional: number };
  readonly native: Record<RuleV2Status, number>;
  readonly legacy: {
    readonly exactMappings: number;
    readonly classificationRules: number;
    readonly targetMappings: number;
    readonly projections: number;
    readonly targetAssignmentRules: number;
  };
  readonly origins: Readonly<Record<RuleV2OriginKind, number>>;
}

export interface RulesV2LegacyImportResult {
  readonly counts: Readonly<Record<Exclude<RuleV2OriginKind, "native">, number>>;
  readonly total: number;
}

export interface RulesV2Repository {
  list(targetId?: EntityId, query?: { readonly search?: string; readonly offset?: number; readonly limit?: number }): Promise<readonly RuleV2Record[]>;
  summary(): Promise<RuleV2Summary>;
  create(draft: RuleV2Draft, actor: string): Promise<RuleV2Record>;
  update(id: EntityId, draft: RuleV2Draft, expectedRevision: string, actor: string): Promise<RuleV2Record>;
  updateImported?(id: EntityId, draft: RuleV2ImportedDraft, expectedRevision: string, actor: string): Promise<RuleV2Record>;
}

export interface RuleV2ImportedDraft {
  readonly name: string;
  readonly priority: number;
  readonly status: RuleV2Status;
  readonly conditionGroups: RuleV2Record["conditionGroups"];
  readonly actions: RuleV2Record["actions"];
}
