import type { EntityId } from "../contracts/index.js";
import type {
  ClassificationLookupInput,
  ClassificationMappingMatchRecord,
  ClassificationReferenceTypeRecord,
  ClassificationRuleRecord,
  SaveProductClassificationInput,
} from "./types.js";

export interface ClassificationRepository {
  listReferenceTypes(typeCodes: readonly string[]): Promise<readonly ClassificationReferenceTypeRecord[]>;
  findSourceDecisions(
    sourceId: EntityId,
    inputs: readonly ClassificationLookupInput[],
  ): Promise<readonly ClassificationMappingMatchRecord[]>;
  listActiveRules(
    sourceId: EntityId,
    typeCodes: readonly string[],
  ): Promise<readonly ClassificationRuleRecord[]>;
  getActiveRuleSetRevision(sourceId: EntityId): Promise<string>;
  listAllActiveRules(sourceId: EntityId): Promise<readonly ClassificationRuleRecord[]>;
  saveProductResult(input: SaveProductClassificationInput): Promise<void>;
}
