import type { EntityId } from "../contracts/index.js";
import type {
  ReferenceValueRecord,
  SaveTargetClassificationProjectionInput,
  TargetClassificationProjectionRecord,
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
    resolutions: readonly { readonly resolutionKind: "mapping" | "rule"; readonly resolutionId: EntityId }[],
  ): Promise<readonly TargetClassificationProjectionRecord[]>;
  saveTargetProjection(input: SaveTargetClassificationProjectionInput): Promise<TargetClassificationProjectionRecord>;
  getTargetMappingRevision(targetId: EntityId): Promise<string>;
}
