import type { EntityId } from "../contracts/index.js";
import type {
  TargetDictionaryQuery,
  TargetDictionaryValueInput,
  TargetDictionaryValueRecord,
  TargetRecord,
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
}
