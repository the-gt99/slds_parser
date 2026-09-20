import type { EntityId } from "../contracts/index.js";
import type { TargetAssignmentConditionGroupRecord } from "./types.js";

export type RuleV2Status = "draft" | "shadow" | "disabled";
export type RuleV2OriginKind = "native" | "exact_mapping" | "classification_rule" | "target_mapping" | "projection" | "target_assignment_rule";

export interface RuleV2Action {
  readonly targetScope: string;
  readonly dictionaryValueId: EntityId;
  readonly externalValue: string;
  readonly externalLabel: string;
  readonly mode: "add" | "replace";
}

export interface RuleV2Record {
  readonly id: EntityId;
  readonly sourceId: EntityId;
  readonly sourceCode: string;
  readonly targetId: EntityId;
  readonly targetCode: string;
  readonly name: string;
  readonly groupCode: string;
  readonly priority: number;
  readonly status: RuleV2Status;
  readonly conditionGroups: readonly TargetAssignmentConditionGroupRecord[];
  readonly actions: readonly RuleV2Action[];
  readonly originKind: RuleV2OriginKind;
  readonly originId: EntityId | null;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuleV2Draft {
  readonly sourceId: EntityId;
  readonly targetId: EntityId;
  readonly name: string;
  readonly groupCode: string;
  readonly priority: number;
  readonly status: RuleV2Status;
  readonly conditionGroups: readonly TargetAssignmentConditionGroupRecord[];
  readonly actions: readonly { readonly targetScope: string; readonly dictionaryValueId: EntityId; readonly mode: "add" | "replace" }[];
  readonly reason?: string;
}

export interface RuleV2Summary {
  readonly native: Record<RuleV2Status, number>;
  readonly legacy: {
    readonly exactMappings: number;
    readonly classificationRules: number;
    readonly targetMappings: number;
    readonly projections: number;
    readonly targetAssignmentRules: number;
  };
}

export interface RulesV2Repository {
  list(targetId?: EntityId): Promise<readonly RuleV2Record[]>;
  summary(): Promise<RuleV2Summary>;
  create(draft: RuleV2Draft, actor: string): Promise<RuleV2Record>;
  update(id: EntityId, draft: RuleV2Draft, expectedRevision: string, actor: string): Promise<RuleV2Record>;
}
