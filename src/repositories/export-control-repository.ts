import type { EntityId, JsonObject } from "../contracts/index.js";
import type {
  ExportControlBatchItemRecord,
  ExportControlBatchRecord,
  ExportCampaignItemRecord,
  ExportCampaignRecord,
  CachedExportControlPreflight,
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
    readonly mode?: "all" | "stale";
    readonly limit: number;
  }): Promise<readonly ExportControlPreflightCandidate[]>;
  savePreflight(input: SaveExportControlPreflightInput): Promise<void>;
  getCachedPreflight(targetId: EntityId, internalProductId: EntityId): Promise<CachedExportControlPreflight | null>;
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
    readonly campaignId?: EntityId;
  }): Promise<{
    readonly batchId: EntityId;
    readonly items: readonly ExportControlBatchItemRecord[];
    readonly jobIds: readonly EntityId[];
  }>;
  listBatches(targetId: EntityId, limit: number): Promise<readonly ExportControlBatchRecord[]>;
  createCampaign(input: {
    readonly targetId: EntityId;
    readonly actor: string;
    readonly reason?: string;
    readonly preflightWindow: number;
    readonly maxExports?: number;
  }): Promise<ExportCampaignRecord>;
  listCampaigns(targetId: EntityId, limit: number): Promise<readonly ExportCampaignRecord[]>;
  getRunningCampaign(): Promise<ExportCampaignRecord | null>;
  setCampaignStatus(input: {
    readonly campaignId: EntityId;
    readonly status: "running" | "paused" | "completed";
    readonly error?: string;
  }): Promise<ExportCampaignRecord>;
  listCampaignItems(campaignId: EntityId, limit: number): Promise<readonly ExportCampaignItemRecord[]>;
  countActivePreflights(targetId: EntityId): Promise<number>;
  prepareCampaignPreflightCandidates(input: {
    readonly campaignId: EntityId;
    readonly limit: number;
  }): Promise<readonly ExportControlPreflightCandidate[]>;
}
