import type { WordPressTargetConfig } from "../config/index.js";
import type { JsonObject, ProductVariantDTO } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import { hashStableJson } from "../core/utils/index.js";
import {
  matchExistingWordPressVariations,
  previewWordPressVariationPatchItems,
  WordPressExporter,
  WordPressSizeConverter,
  type WordPressCatalogClient,
} from "../integrations/wordpress/index.js";
import type { JobRepository, SourceProductRepository, SourceRepository, TargetContentTemplateRepository, WordPressCatalogRepository, WordPressCatalogVariationCandidate } from "../repositories/index.js";
import { buildWordPressCatalogAudit, type TargetReferenceMappingService } from "../services/index.js";
import type { PollWordPressVariationPatchesPayload, PrepareWordPressVariationPatchesPayload, RefreshWordPressVariationPatchPayload } from "./job-payloads.js";
import type { ExportSourceRefresher } from "./export-source-refresher.js";
import type { RunnerResult } from "./runner-result.js";

function record(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function jobId(value: JsonObject): string | null {
  const id = String(value.job_id ?? "");
  return /^\d+$/u.test(id) ? id : null;
}

export class WordPressVariationPatchRunner {
  private readonly converter: WordPressSizeConverter;
  private readonly exporter: WordPressExporter;

  constructor(
    private readonly repository: WordPressCatalogRepository,
    private readonly jobs: JobRepository,
    private readonly mappings: TargetReferenceMappingService,
    private readonly contentTemplates: TargetContentTemplateRepository,
    private readonly sources: SourceRepository,
    private readonly sourceProducts: SourceProductRepository,
    private readonly sourceRefresher: ExportSourceRefresher,
    private readonly client: WordPressCatalogClient,
    wordpressConfig: WordPressTargetConfig,
    private readonly currentTime: () => number = Date.now,
  ) {
    this.converter = new WordPressSizeConverter(wordpressConfig);
    this.exporter = new WordPressExporter(wordpressConfig);
  }

  async prepare(payload: PrepareWordPressVariationPatchesPayload): Promise<RunnerResult> {
    const run = await this.repository.getRun(payload.runId);
    if (run === null) throw new IntegrationContractError(`WordPress catalog run not found: ${payload.runId}`);
    const candidates = await this.repository.listVariationCandidates({
      runId: payload.runId,
      afterWordPressProductId: payload.afterCursor,
      throughWordPressProductId: payload.throughCursor,
    });
    const activeTemplates = candidates.length === 0 ? [] : await this.contentTemplates.listActive(candidates[0]!.target.id);
    const templates = activeTemplates.map((template) => ({
      id: template.id, field: template.field, revision: template.revision, templateSource: template.templateSource,
      profileKey: template.profileKey, profileName: template.profileName, managementMode: template.managementMode,
      categoryTermIds: template.categoryTermIds, requiredContextPaths: template.requiredContextPaths,
      preserveExistingStory: template.preserveExistingStory ?? false,
    }));
    for (const candidate of candidates) {
      const context = {
        source: candidate.source,
        sourceProduct: candidate.sourceProduct,
        target: candidate.target,
        product: candidate.product,
        existingExternalId: candidate.item.wordpressProductId,
        existingTargetSnapshot: candidate.item.payload,
        references: {
          resolveReference: (input) => this.mappings.resolveTargetValue(candidate.target.id, input.referenceId, input.targetScope),
          resolveProjections: (inputs) => this.mappings.resolveTargetProjections(candidate.target.id, inputs),
          resolveAssignments: (product) => this.mappings.resolveTargetAssignments(candidate.target.id, product),
        },
        contentTemplates: templates,
      } satisfies Parameters<WordPressExporter["previewPayload"]>[0];
      if (run.auditRequested && candidate.item.auditStatus === "pending") {
        try {
          const fullDraft = await this.exporter.previewPayload(context);
          await this.repository.saveAudit({ itemId: candidate.item.id, status: "ready", result: buildWordPressCatalogAudit(fullDraft, candidate.item.payload) });
        } catch (error) {
          if (!(error instanceof IntegrationContractError)) throw error;
          await this.repository.saveAudit({ itemId: candidate.item.id, status: "blocked", error: error.message,
            result: { risk: "blocked", blockers: [{ code: "payload_contract", message: error.message }] } });
        }
      }
      if (run.variationSyncRequested) {
        await this.jobs.enqueue({
          jobType: "refresh_wordpress_variation_patch",
          payload: { runId: payload.runId, itemId: candidate.item.id, wordpressProductId: candidate.item.wordpressProductId },
          uniqueKey: `wordpress-variation-refresh:${payload.runId}:${candidate.item.id}`,
        });
      }
    }
    return { status: "completed" };
  }

  async refresh(payload: RefreshWordPressVariationPatchPayload): Promise<RunnerResult> {
    const cursor = (BigInt(payload.wordpressProductId) - 1n).toString();
    const candidates = await this.repository.listVariationCandidates({
      runId: payload.runId,
      afterWordPressProductId: cursor,
      throughWordPressProductId: payload.wordpressProductId,
    });
    const candidate = candidates.find((item) => item.item.id === payload.itemId);
    if (candidate === undefined) return { status: "skipped" };
    try {
      const sourceProduct = await this.sourceProducts.getById(candidate.sourceProduct.id);
      if (sourceProduct === null) throw new IntegrationContractError(`Source product not found: ${candidate.sourceProduct.id}`);
      const source = await this.sources.getById(sourceProduct.sourceId);
      if (source === null) throw new IntegrationContractError(`Source not found: ${sourceProduct.sourceId}`);
      const liveVariants = await this.sourceRefresher.refresh(source, sourceProduct);
      if (liveVariants === null) throw new IntegrationContractError(`Source ${source.code} does not provide live variation refresh`);
      const refreshedProduct = await this.sourceProducts.getById(sourceProduct.id);
      if (refreshedProduct?.externalId === null || refreshedProduct === null) {
        throw new IntegrationContractError(`Source refresh did not resolve externalId for product ${sourceProduct.id}`);
      }
      const effectiveCandidate: WordPressCatalogVariationCandidate = {
        ...candidate,
        sourceProduct: {
          id: refreshedProduct.id,
          sourceId: refreshedProduct.sourceId,
          sourceKey: refreshedProduct.sourceKey,
          externalId: refreshedProduct.externalId,
          ...(refreshedProduct.slug === null ? {} : { slug: refreshedProduct.slug }),
          ...(refreshedProduct.url === null ? {} : { url: refreshedProduct.url }),
          metadata: refreshedProduct.discoveryMetadata,
        },
      };
      const patchPayload = await this.buildPatchPayload(effectiveCandidate, payload.runId, liveVariants);
      if (patchPayload === null) return { status: "skipped" };
      const [submission] = await this.client.submitVariationPatches([patchPayload]);
      if (submission === undefined) throw new IntegrationContractError("WordPress did not return a variation patch result");
      const wordpressJobId = submission.job === undefined ? null : jobId(submission.job);
      if (!submission.accepted || wordpressJobId === null) {
        await this.repository.saveVariationJobResult({ itemId: candidate.item.id, status: "failed", result: record(submission as unknown),
          error: submission.error ?? submission.code ?? "WordPress rejected variation patch" });
        return { status: "completed" };
      }
      await this.repository.saveVariationSubmission({ itemId: candidate.item.id, wordpressJobId, result: submission.job! });
      await this.enqueuePoll(payload.runId, [wordpressJobId], 0);
      return { status: "completed" };
    } catch (error) {
      if (!(error instanceof IntegrationContractError)) throw error;
      await this.repository.saveVariationPreparation({ itemId: candidate.item.id, status: "skipped", notices: [], error: error.message });
      return { status: "completed" };
    }
  }

  private async buildPatchPayload(candidate: WordPressCatalogVariationCandidate, runId: string, liveVariants: readonly ProductVariantDTO[]): Promise<JsonObject | null> {
    const draft = await previewWordPressVariationPatchItems({
      source: candidate.source,
      sourceProduct: candidate.sourceProduct,
      target: candidate.target,
      product: candidate.product,
      liveVariants,
      existingExternalId: candidate.item.wordpressProductId,
      existingTargetSnapshot: candidate.item.payload,
      references: {
        resolveReference: (input) => this.mappings.resolveTargetValue(candidate.target.id, input.referenceId, input.targetScope),
        resolveProjections: (inputs) => this.mappings.resolveTargetProjections(candidate.target.id, inputs),
        resolveAssignments: (product) => this.mappings.resolveTargetAssignments(candidate.target.id, product),
      },
    }, this.converter);
    const matched = matchExistingWordPressVariations(draft, candidate.item.payload);
    if (matched.items.length === 0 || matched.items.length > 100) {
      const error = matched.items.length === 0
        ? "Нет безопасных существующих вариаций для обновления"
        : "У товара больше 100 обновляемых вариаций; требуется отдельная партия";
      await this.repository.saveVariationPreparation({ itemId: candidate.item.id, status: "skipped", notices: matched.ignored, error });
      return null;
    }
    const basis = {
      contract_version: "slds.wordpress.variation-patch.v1",
      mode: "patch_existing_variations",
      identity: {
        target_id: Number(candidate.item.wordpressProductId),
        source_code: candidate.source.code,
        source_external_id: candidate.sourceProduct.externalId!,
        external_key: `${candidate.source.code}:${candidate.sourceProduct.externalId!}`,
      },
      variations: { items: matched.items },
    } as JsonObject;
    const patchPayload = { ...basis, idempotency_key: `catalog-${runId}-${candidate.item.id}-${hashStableJson(basis).slice(0, 32)}` } as JsonObject;
    await this.repository.saveVariationPreparation({ itemId: candidate.item.id, status: "ready", payload: patchPayload,
      notices: [...matched.ignored, { code: "live_source_refresh", message: "Цены и наличие получены непосредственно перед постановкой WordPress job" }] });
    return patchPayload;
  }

  async poll(payload: PollWordPressVariationPatchesPayload): Promise<RunnerResult> {
    const items = await this.repository.listSubmittedVariationItems(payload.runId, payload.jobIds);
    if (items.length === 0) return { status: "skipped" };
    const jobs = await this.client.readJobs(items.map((item) => item.wordpressJobId!));
    const byId = new Map(jobs.flatMap((job) => {
      const id = jobId(job);
      return id === null ? [] : [[id, job] as const];
    }));
    const remaining: string[] = [];
    for (const item of items) {
      const id = item.wordpressJobId!;
      const job = byId.get(id);
      const status = String(job?.status ?? "");
      if (status === "completed") {
        await this.repository.saveVariationJobResult({ itemId: item.id, status: "completed", result: job! });
      } else if (status === "failed" || status === "error") {
        await this.repository.saveVariationJobResult({ itemId: item.id, status: "failed", result: job!, error: String(job?.last_error ?? "WordPress job failed") });
      } else {
        remaining.push(id);
      }
    }
    if (remaining.length > 0) {
      if (payload.poll >= 720) throw new IntegrationContractError(`WordPress variation jobs did not finish: ${remaining.join(", ")}`);
      await this.enqueuePoll(payload.runId, remaining, payload.poll + 1);
    }
    return { status: "completed" };
  }

  async failRefresh(itemId: string, error: string): Promise<void> {
    await this.repository.saveVariationPreparation({ itemId, status: "failed", notices: [], error });
  }

  async failPoll(runId: string, jobIds: readonly string[], error: string): Promise<void> {
    const items = await this.repository.listSubmittedVariationItems(runId, jobIds);
    await Promise.all(items.map((item) => this.repository.saveVariationJobResult({
      itemId: item.id,
      status: "failed",
      result: item.variationResult ?? {},
      error,
    })));
  }

  private async enqueuePoll(runId: string, jobIds: readonly string[], poll: number): Promise<void> {
    await this.jobs.enqueue({
      jobType: "poll_wordpress_variation_patches",
      payload: { runId, jobIds: [...jobIds], poll },
      uniqueKey: `wordpress-variation-poll:${runId}:${poll}:${jobIds.join("-")}`,
      availableAt: new Date(this.currentTime() + 10_000).toISOString(),
    });
  }
}
