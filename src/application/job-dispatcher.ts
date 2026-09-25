import { InvalidJobPayloadError } from "../core/errors/index.js";
import type { ExportControlRepository, JobRecord, SourceRunRepository } from "../repositories/index.js";
import type { CollectionRunner } from "./collection-runner.js";
import type { ExportRunner } from "./export-runner.js";
import { parseApplyTargetClassificationSuggestionPayload, parseCollectProductPayload, parseCollectWordPressVariationSourcePayload, parseDiscoverSourcePayload, parseExportProductPayload, parsePollWordPressVariationPatchesPayload, parsePreflightProductPayload, parsePrepareWordPressVariationPatchPayload, parsePrepareWordPressVariationPatchesPayload, parseProcessProductPayload, parseReclassifyProductPayload, parseResolveShihuoProductPayload, parseRetranslateProductPayload, parseRefreshExportSourcePayload, parseSubmitWordPressVariationPatchesPayload, parseSyncTargetClassificationsPayload, parseSyncWordPressCatalogPayload } from "./job-payloads.js";
import type { ExportSourceRefreshRunner } from "./export-source-refresh-runner.js";
import type { PreflightRunner } from "./preflight-runner.js";
import type { ProcessingRunner } from "./processing-runner.js";
import type { RetranslationRunner } from "./retranslation-runner.js";
import type { TargetClassificationSyncRunner } from "./target-classification-sync-runner.js";
import type { TargetClassificationApplyRunner } from "./target-classification-apply-runner.js";
import type { RunnerResult } from "./runner-result.js";
import type { WordPressCatalogSyncRunner } from "./wordpress-catalog-sync-runner.js";
import type { WordPressVariationPatchRunner } from "./wordpress-variation-patch-runner.js";
import type { ShihuoResolutionRunner } from "./shihuo-resolution-runner.js";

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
    private readonly wordpressVariationPatches?: WordPressVariationPatchRunner,
    private readonly retranslations?: RetranslationRunner,
    private readonly exportSourceRefreshes?: ExportSourceRefreshRunner,
    private readonly shihuoResolutions?: ShihuoResolutionRunner) {}

  async dispatch(job: JobRecord): Promise<RunnerResult> {
    switch (job.jobType) {
      case "discover_source": return await this.collection.discoverSource(parseDiscoverSourcePayload(job.payload));
      case "collect_product": return await this.collection.collectProduct(parseCollectProductPayload(job.payload));
      case "process_product": return await this.processing.processProduct(parseProcessProductPayload(job.payload));
      case "reclassify_product": return await this.processing.reclassifyProduct(parseReclassifyProductPayload(job.payload));
      case "retranslate_product": {
        if (this.retranslations === undefined) throw new InvalidJobPayloadError("retranslate_product is not configured");
        return await this.retranslations.retranslateProduct(parseRetranslateProductPayload(job.payload));
      }
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
      case "collect_wordpress_variation_source": {
        if (this.wordpressVariationPatches === undefined) throw new InvalidJobPayloadError("collect_wordpress_variation_source is not configured");
        return await this.wordpressVariationPatches.collect(parseCollectWordPressVariationSourcePayload(job.payload));
      }
      case "prepare_wordpress_variation_patch": {
        if (this.wordpressVariationPatches === undefined) throw new InvalidJobPayloadError("prepare_wordpress_variation_patch is not configured");
        return await this.wordpressVariationPatches.preparePatch(parsePrepareWordPressVariationPatchPayload(job.payload));
      }
      case "submit_wordpress_variation_patches": {
        if (this.wordpressVariationPatches === undefined) throw new InvalidJobPayloadError("submit_wordpress_variation_patches is not configured");
        return await this.wordpressVariationPatches.submit(parseSubmitWordPressVariationPatchesPayload(job.payload));
      }
      case "poll_wordpress_variation_patches": {
        if (this.wordpressVariationPatches === undefined) throw new InvalidJobPayloadError("poll_wordpress_variation_patches is not configured");
        return await this.wordpressVariationPatches.poll(parsePollWordPressVariationPatchesPayload(job.payload));
      }
      case "export_product": return await this.exports.exportProduct(parseExportProductPayload(job.payload));
      case "refresh_export_source": {
        if (this.exportSourceRefreshes === undefined) throw new InvalidJobPayloadError("refresh_export_source is not configured");
        return await this.exportSourceRefreshes.refresh(parseRefreshExportSourcePayload(job.payload));
      }
      case "resolve_shihuo_product": {
        if (this.shihuoResolutions === undefined) throw new InvalidJobPayloadError("resolve_shihuo_product is not configured");
        return await this.shihuoResolutions.resolve(parseResolveShihuoProductPayload(job.payload));
      }
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
    if (job.jobType === "refresh_export_source" && this.exportSourceRefreshes !== undefined) {
      const payload = parseRefreshExportSourcePayload(job.payload);
      await this.exportSourceRefreshes.saveError(payload.refreshId, message);
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
      if (payload.mode !== "inventory") await this.wordpressCatalogSync.fail(payload.runId, message);
      return;
    }
    if ((job.jobType === "collect_wordpress_variation_source" || job.jobType === "prepare_wordpress_variation_patch")
      && this.wordpressVariationPatches !== undefined) {
      const payload = job.jobType === "collect_wordpress_variation_source"
        ? parseCollectWordPressVariationSourcePayload(job.payload)
        : parsePrepareWordPressVariationPatchPayload(job.payload);
      await this.wordpressVariationPatches.failItem(payload.itemId, message);
      return;
    }
    if (job.jobType === "submit_wordpress_variation_patches" && this.wordpressVariationPatches !== undefined) {
      const payload = parseSubmitWordPressVariationPatchesPayload(job.payload);
      await this.wordpressVariationPatches.failSubmission(payload.runId, payload.itemIds, message);
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
