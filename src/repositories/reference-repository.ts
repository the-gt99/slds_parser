import type { EntityId } from "../contracts/index.js";
import type {
  ReferenceValueRecord,
  TargetValueMappingRecord,
} from "./types.js";

export interface ReferenceRepository {
  resolveTargetValue(
    targetId: EntityId,
    referenceValueId: EntityId,
    targetScope: string,
  ): Promise<TargetValueMappingRecord | null>;
  getTargetMappingRevision(targetId: EntityId): Promise<string>;
}
