import type { EntityId, JsonObject } from "../contracts/index.js";
import type {
  ExportControlBatchItemRecord,
  ExportControlBatchRecord,
  ExportControlExportCandidate,
  ExportControlFilter,
  ExportControlListQuery,
  ExportControlListResult,
  ExportControlPreflightCandidate,
  SaveExportControlPreflightInput,
} from "./types.js";

export interface ExportControlRepository {
  list(query: ExportControlListQuery): Promise<ExportControlListResult>;
  preparePreflightCandidates(input: {
    readonly targetId: EntityId;
    readonly sourceProductIds?: readonly EntityId[];
    readonly limit: number;
  }): Promise<readonly ExportControlPreflightCandidate[]>;
  savePreflight(input: SaveExportControlPreflightInput): Promise<void>;
  savePreflightError(input: {
    readonly targetId: EntityId;
    readonly sourceProductId: EntityId;
    readonly error: string;
  }): Promise<void>;
  listExportCandidates(input: {
    readonly targetId: EntityId;
    readonly sourceProductIds?: readonly EntityId[];
    readonly filter?: ExportControlFilter;
    readonly limit: number;
  }): Promise<readonly ExportControlExportCandidate[]>;
  createBatch(input: {
    readonly targetId: EntityId;
    readonly filter: JsonObject;
    readonly actor: string;
    readonly reason?: string;
    readonly candidates: readonly ExportControlExportCandidate[];
  }): Promise<{
    readonly batchId: EntityId;
    readonly items: readonly ExportControlBatchItemRecord[];
    readonly jobIds: readonly EntityId[];
  }>;
  listBatches(targetId: EntityId, limit: number): Promise<readonly ExportControlBatchRecord[]>;
}
