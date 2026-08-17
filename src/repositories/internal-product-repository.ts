import type { EntityId } from "../contracts/index.js";
import type { InternalProductRecord, UpsertInternalProductInput } from "./types.js";

export interface InternalProductRepository {
  getById(id: EntityId): Promise<InternalProductRecord | null>;
  findBySourceProductId(sourceProductId: EntityId): Promise<InternalProductRecord | null>;
  upsert(input: UpsertInternalProductInput): Promise<InternalProductRecord>;
  updateDataIfContentHash(input: {
    readonly id: EntityId;
    readonly expectedContentHash: string;
    readonly data: InternalProductRecord["data"];
    readonly contentHash: string;
  }): Promise<InternalProductRecord | null>;
}
