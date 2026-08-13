import { InvalidJobPayloadError } from "../core/errors/index.js";
import type { ExportControlRepository, JobRecord, SourceRunRepository } from "../repositories/index.js";
import type { CollectionRunner } from "./collection-runner.js";
import type { ExportRunner } from "./export-runner.js";
import { parseApplyTargetClassificationSuggestionPayload, parseCollectProductPayload, parseDiscoverSourcePayload, parseExportProductPayload, parsePollWordPressVariationPatchesPayload, parsePreflightProductPayload, parsePrepareWordPressVariationPatchesPayload, parseProcessProductPayload, parseReclassifyProductPayload, parseRefreshWordPressVariationPatchPayload, parseSyncTargetClassificationsPayload, parseSyncWordPressCatalogPayload } from "./job-payloads.js";
import type { PreflightRunner } from "./preflight-runner.js";
import type { ProcessingRunner } from "./processing-runner.js";
import type { TargetClassificationSyncRunner } from "./target-classification-sync-runner.js";
import type { TargetClassificationApplyRunner } from "./target-classification-apply-runner.js";
import type { RunnerResult } from "./runner-result.js";
import type { WordPressCatalogSyncRunner } from "./wordpress-catalog-sync-runner.js";
import type { WordPressVariationPatchRunner } from "./wordpress-variation-patch-runner.js";

export interface JobHandler {
  dispatch(job: JobRecord): Promise<RunnerResult>;
  handleTerminalFailure(job: JobRecord, error: unknown): Promise<void>;
}

export class JobDispatcher implements JobHandler {
  constructor(private readonly collection: CollectionRunner, private readonly processing: ProcessingRunner,
    private readonly exports: ExportRunner, private readonly sourceRuns: SourceRunRepository,
    private readonly preflights?: PreflightRunner,
    private readonly exportControl?: ExportControlRepository,
    private readonly classificationSync?: TargetClassificationSyncRunner,
    private readonly classificationApply?: TargetClassificationApplyRunner,
    private readonly wordpressCatalogSync?: WordPressCatalogSyncRunner,
    private readonly wordpressVariationPatches?: WordPressVariationPatchRunner) {}

  async dispatch(job: JobRecord): Promise<RunnerResult> {
    switch (job.jobType) {
      case "discover_source": return await this.collection.discoverSource(parseDiscoverSourcePayload(job.payload));
      case "collect_product": return await this.collection.collectProduct(parseCollectProductPayload(job.payload));
      case "process_product": return await this.processing.processProduct(parseProcessProductPayload(job.payload));
      case "reclassify_product": return await this.processing.reclassifyProduct(parseReclassifyProductPayload(job.payload));
      case "sync_target_classifications": {
        if (this.classificationSync === undefined) throw new InvalidJobPayloadError("sync_target_classifications is not configured");
        return await this.classificationSync.sync(parseSyncTargetClassificationsPayload(job.payload));
      }
      case "apply_target_classification_suggestion": {
        if (this.classificationApply === undefined) throw new InvalidJobPayloadError("apply_target_classification_suggestion is not configured");
        return await this.classificationApply.apply(parseApplyTargetClassificationSuggestionPayload(job.payload));
      }
      case "preflight_product": {
        if (this.preflights === undefined) throw new InvalidJobPayloadError("preflight_product is not configured");
        return await this.preflights.preflightProduct(parsePreflightProductPayload(job.payload));
      }
      case "sync_wordpress_catalog": {
        if (this.wordpressCatalogSync === undefined) throw new InvalidJobPayloadError("sync_wordpress_catalog is not configured");
        return await this.wordpressCatalogSync.sync(parseSyncWordPressCatalogPayload(job.payload));
      }
      case "prepare_wordpress_variation_patches": {
        if (this.wordpressVariationPatches === undefined) throw new InvalidJobPayloadError("prepare_wordpress_variation_patches is not configured");
        return await this.wordpressVariationPatches.prepare(parsePrepareWordPressVariationPatchesPayload(job.payload));
      }
      case "refresh_wordpress_variation_patch": {
        if (this.wordpressVariationPatches === undefined) throw new InvalidJobPayloadError("refresh_wordpress_variation_patch is not configured");
        return await this.wordpressVariationPatches.refresh(parseRefreshWordPressVariationPatchPayload(job.payload));
      }
      case "poll_wordpress_variation_patches": {
        if (this.wordpressVariationPatches === undefined) throw new InvalidJobPayloadError("poll_wordpress_variation_patches is not configured");
        return await this.wordpressVariationPatches.poll(parsePollWordPressVariationPatchesPayload(job.payload));
      }
      case "export_product": return await this.exports.exportProduct(parseExportProductPayload(job.payload));
      default: throw new InvalidJobPayloadError(String(job.jobType));
    }
  }

  async handleTerminalFailure(job: JobRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    if (job.jobType === "preflight_product" && this.exportControl !== undefined) {
      const payload = parsePreflightProductPayload(job.payload);
      await this.exportControl.savePreflightError({
        targetId: payload.targetId,
        sourceProductId: payload.sourceProductId,
        error: message,
      });
      return;
    }
    if (job.jobType === "sync_target_classifications" && this.classificationSync !== undefined) {
      const payload = parseSyncTargetClassificationsPayload(job.payload);
      await this.classificationSync.fail(payload.runId, message);
      return;
    }
    if (job.jobType === "apply_target_classification_suggestion" && this.classificationApply !== undefined) {
      const payload = parseApplyTargetClassificationSuggestionPayload(job.payload);
      await this.classificationApply.fail(payload, message);
      return;
    }
    if (job.jobType === "sync_wordpress_catalog" && this.wordpressCatalogSync !== undefined) {
      const payload = parseSyncWordPressCatalogPayload(job.payload);
      await this.wordpressCatalogSync.fail(payload.runId, message);
      return;
    }
    if (job.jobType === "refresh_wordpress_variation_patch" && this.wordpressVariationPatches !== undefined) {
      const payload = parseRefreshWordPressVariationPatchPayload(job.payload);
      await this.wordpressVariationPatches.failRefresh(payload.itemId, message);
      return;
    }
    if (job.jobType === "poll_wordpress_variation_patches" && this.wordpressVariationPatches !== undefined) {
      const payload = parsePollWordPressVariationPatchesPayload(job.payload);
      await this.wordpressVariationPatches.failPoll(payload.runId, payload.jobIds, message);
      return;
    }
    if (job.jobType !== "discover_source") return;
    const payload = parseDiscoverSourcePayload(job.payload);
    const run = await this.sourceRuns.findActiveBySource(payload.sourceId);
    if (run !== null) await this.sourceRuns.fail(run.id, { error: message, checkpoint: run.checkpoint, finishedAt: new Date().toISOString() });
  }
}
