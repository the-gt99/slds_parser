import type { EntityId } from "../contracts/index.js";
import type { SourceRecord } from "./types.js";

export interface SourceRepository {
  getById(id: EntityId): Promise<SourceRecord | null>;
  listEnabled(): Promise<readonly SourceRecord[]>;
}
