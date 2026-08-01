import type { EntityId } from "../contracts/index.js";
import type {
  ReferenceValueRecord,
  ResolveSourceValueInput,
  TargetValueMappingRecord,
} from "./types.js";

export interface ReferenceRepository {
  resolveSourceValue(input: ResolveSourceValueInput): Promise<ReferenceValueRecord | null>;
  resolveTargetValue(
    targetId: EntityId,
    referenceValueId: EntityId,
    targetScope: string,
  ): Promise<TargetValueMappingRecord | null>;
  getTargetMappingRevision(targetId: EntityId): Promise<string>;
}
