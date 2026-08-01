import type { QueryResultRow } from "pg";

import type { JsonObject, JsonValue, UniversalProductDTO } from "../../../contracts/index.js";
import type {
  InternalProductRecord,
  JobRecord,
  ReferenceValueRecord,
  SourceProductPartRecord,
  SourceProductRecord,
  SourceRecord,
  SourceRunRecord,
  TargetProductRecord,
  TargetRecord,
  TargetValueMappingRecord,
} from "../../../repositories/index.js";

export type DatabaseRow = QueryResultRow & Record<string, unknown>;

function text(row: DatabaseRow, key: string): string {
  return String(row[key]);
}

function nullableText(row: DatabaseRow, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function timestamp(row: DatabaseRow, key: string): string {
  const value = row[key];
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableTimestamp(row: DatabaseRow, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined
    ? null
    : value instanceof Date ? value.toISOString() : String(value);
}

export function mapSource(row: DatabaseRow): SourceRecord {
  return { id: text(row, "id"), code: text(row, "code"), name: text(row, "name"), adapterCode: text(row, "adapter_code"), config: row.config as JsonObject, enabled: Boolean(row.enabled), createdAt: timestamp(row, "created_at"), updatedAt: timestamp(row, "updated_at") };
}

export function mapSourceRun(row: DatabaseRow): SourceRunRecord {
  return { id: text(row, "id"), sourceId: text(row, "source_id"), runType: text(row, "run_type"), coverage: text(row, "coverage"), status: row.status as SourceRunRecord["status"], completeness: row.completeness as SourceRunRecord["completeness"], checkpoint: row.checkpoint as JsonValue, processedCount: text(row, "processed_count"), discoveredCount: text(row, "discovered_count"), errorCount: text(row, "error_count"), startedAt: timestamp(row, "started_at"), finishedAt: nullableTimestamp(row, "finished_at"), lastError: nullableText(row, "last_error") };
}

export function mapSourceProduct(row: DatabaseRow): SourceProductRecord {
  return { id: text(row, "id"), sourceId: text(row, "source_id"), sourceKey: text(row, "source_key"), externalId: nullableText(row, "external_id"), slug: nullableText(row, "slug"), url: nullableText(row, "url"), discoveryMetadata: row.discovery_metadata as JsonObject, status: text(row, "status"), firstSeenAt: timestamp(row, "first_seen_at"), lastSeenAt: timestamp(row, "last_seen_at"), lastSeenRunId: nullableText(row, "last_seen_run_id"), createdAt: timestamp(row, "created_at"), updatedAt: timestamp(row, "updated_at") };
}

export function mapSourceProductPart(row: DatabaseRow): SourceProductPartRecord {
  return { id: text(row, "id"), sourceProductId: text(row, "source_product_id"), partKey: text(row, "part_key"), rawPayload: row.raw_payload as JsonValue, parsedPayload: row.parsed_payload as JsonValue, contentHash: text(row, "content_hash"), sourceUpdatedAt: nullableTimestamp(row, "source_updated_at"), fetchedAt: timestamp(row, "fetched_at"), adapterVersion: text(row, "adapter_version"), createdAt: timestamp(row, "created_at"), updatedAt: timestamp(row, "updated_at") };
}

export function mapInternalProduct(row: DatabaseRow): InternalProductRecord {
  return { id: text(row, "id"), sourceProductId: text(row, "source_product_id"), data: row.data as UniversalProductDTO, inputHash: text(row, "input_hash"), contentHash: text(row, "content_hash"), processorVersion: text(row, "processor_version"), status: text(row, "status"), processedAt: nullableTimestamp(row, "processed_at"), lastError: nullableText(row, "last_error"), createdAt: timestamp(row, "created_at"), updatedAt: timestamp(row, "updated_at") };
}

export function mapReferenceValue(row: DatabaseRow): ReferenceValueRecord {
  return { id: text(row, "id"), typeId: text(row, "type_id"), code: text(row, "code"), name: text(row, "name"), parentId: nullableText(row, "parent_id"), metadata: row.metadata as JsonObject, enabled: Boolean(row.enabled) };
}

export function mapTargetValueMapping(row: DatabaseRow): TargetValueMappingRecord {
  return { id: text(row, "id"), targetId: text(row, "target_id"), referenceValueId: text(row, "reference_value_id"), targetScope: text(row, "target_scope"), externalValue: text(row, "external_value"), externalLabel: text(row, "external_label"), metadata: row.metadata as JsonObject };
}

export function mapTarget(row: DatabaseRow): TargetRecord {
  return { id: text(row, "id"), code: text(row, "code"), name: text(row, "name"), exporterCode: text(row, "exporter_code"), config: row.config as JsonObject, enabled: Boolean(row.enabled), createdAt: timestamp(row, "created_at"), updatedAt: timestamp(row, "updated_at") };
}

export function mapTargetProduct(row: DatabaseRow): TargetProductRecord {
  return { id: text(row, "id"), targetId: text(row, "target_id"), internalProductId: text(row, "internal_product_id"), externalId: nullableText(row, "external_id"), status: text(row, "status"), lastExportedHash: nullableText(row, "last_exported_hash"), lastExportFingerprint: nullableText(row, "last_export_fingerprint"), lastAttemptAt: nullableTimestamp(row, "last_attempt_at"), syncedAt: nullableTimestamp(row, "synced_at"), lastError: nullableText(row, "last_error"), createdAt: timestamp(row, "created_at"), updatedAt: timestamp(row, "updated_at") };
}

export function mapJob(row: DatabaseRow): JobRecord {
  return { id: text(row, "id"), jobType: row.job_type as JobRecord["jobType"], payload: row.payload as JsonValue, status: row.status as JobRecord["status"], attempts: Number(row.attempts), availableAt: timestamp(row, "available_at"), lockedAt: nullableTimestamp(row, "locked_at"), lockedBy: nullableText(row, "locked_by"), uniqueKey: text(row, "unique_key"), lastError: nullableText(row, "last_error"), createdAt: timestamp(row, "created_at"), updatedAt: timestamp(row, "updated_at"), finishedAt: nullableTimestamp(row, "finished_at") };
}
