import type { EntityId } from "../contracts/index.js";
import type {
  CompleteSourceRunInput,
  CreateSourceRunInput,
  FailSourceRunInput,
  RecordSourceRunPageInput,
  SourceRunRecord,
} from "./types.js";

export interface SourceRunRepository {
  findActiveBySource(sourceId: EntityId): Promise<SourceRunRecord | null>;
  create(input: CreateSourceRunInput): Promise<SourceRunRecord>;
  recordPage(id: EntityId, input: RecordSourceRunPageInput): Promise<SourceRunRecord>;
  complete(id: EntityId, input: CompleteSourceRunInput): Promise<SourceRunRecord>;
  fail(id: EntityId, input: FailSourceRunInput): Promise<SourceRunRecord>;
}
