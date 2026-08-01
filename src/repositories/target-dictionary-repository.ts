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
