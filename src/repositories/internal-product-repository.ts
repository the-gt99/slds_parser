import type { EntityId } from "../contracts/index.js";
import type { InternalProductRecord, UpsertInternalProductInput } from "./types.js";

export interface InternalProductRepository {
  findBySourceProductId(sourceProductId: EntityId): Promise<InternalProductRecord | null>;
  upsert(input: UpsertInternalProductInput): Promise<InternalProductRecord>;
}
