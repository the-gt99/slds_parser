import type { EntityId } from "../contracts/index.js";
import type {
  ReferenceValueRecord,
  SaveTargetClassificationProjectionInput,
  TargetClassificationProjectionRecord,
  TargetAssignmentRuleRecord,
  TargetReferenceProjectionRecord,
  TargetValueMappingRecord,
} from "./types.js";

export interface ReferenceRepository {
  resolveTargetValue(
    targetId: EntityId,
    referenceValueId: EntityId,
    targetScope: string,
  ): Promise<TargetValueMappingRecord | null>;
  resolveTargetProjections(
    targetId: EntityId,
    resolutions: readonly { readonly resolutionKind: "mapping" | "rule"; readonly resolutionId: EntityId; readonly referenceId: EntityId }[],
  ): Promise<readonly (TargetClassificationProjectionRecord | TargetReferenceProjectionRecord)[]>;
  saveTargetProjection(input: SaveTargetClassificationProjectionInput): Promise<TargetClassificationProjectionRecord>;
  getTargetMappingRevision(targetId: EntityId): Promise<string>;
  listTargetAssignmentRules(targetId: EntityId): Promise<readonly TargetAssignmentRuleRecord[]>;
}
