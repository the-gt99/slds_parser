import type { EntityId } from "../contracts/index.js";
import type { SourceRecord } from "./types.js";

export interface UpsertSourceDefinitionInput {
  readonly code: string;
  readonly name: string;
  readonly adapterCode: string;
  readonly config: import("../contracts/index.js").JsonObject;
  readonly enabled: boolean;
}

export interface SourceRepository {
  getById(id: EntityId): Promise<SourceRecord | null>;
  listEnabled(): Promise<readonly SourceRecord[]>;
  upsertDefinition(input: UpsertSourceDefinitionInput): Promise<SourceRecord>;
}
