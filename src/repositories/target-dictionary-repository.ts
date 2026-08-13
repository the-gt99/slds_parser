import type { EntityId } from "../contracts/index.js";
import type {
  TargetDictionaryQuery,
  TargetDictionaryValueInput,
  TargetDictionaryValueRecord,
  TargetRecord,
  StartTargetTermCreationInput,
} from "./types.js";

export interface TargetDictionaryRepository {
  listTargets(): Promise<readonly TargetRecord[]>;
  setPreserveExistingBrandTerms(targetId: EntityId, enabled: boolean): Promise<TargetRecord>;
  getValue(targetId: EntityId, valueId: EntityId): Promise<TargetDictionaryValueRecord | null>;
  listValuesByExternalIds(targetId: EntityId, externalIds: readonly string[]): Promise<readonly TargetDictionaryValueRecord[]>;
  listValues(query: TargetDictionaryQuery): Promise<readonly TargetDictionaryValueRecord[]>;
  replaceEntityValues(
    targetId: EntityId,
    entityType: string,
    values: readonly TargetDictionaryValueInput[],
  ): Promise<number>;
  upsertValue(
    targetId: EntityId,
    entityType: string,
    value: TargetDictionaryValueInput,
  ): Promise<TargetDictionaryValueRecord>;
  startTermCreation(input: StartTargetTermCreationInput): Promise<EntityId>;
  completeTermCreation(id: EntityId, externalId: string): Promise<void>;
  failTermCreation(id: EntityId, error: string, externalId?: string): Promise<void>;
}
