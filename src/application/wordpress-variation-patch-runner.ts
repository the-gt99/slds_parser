import type { WordPressTargetConfig } from "../config/index.js";
import type { JsonObject, JsonValue, ProductVariantDTO, TargetProjectionResolutionInput, TargetReferenceResolutionInput } from "../contracts/index.js";
import { IntegrationContractError, MappingMissingError, PermanentError } from "../core/errors/index.js";
import { hashStableJson } from "../core/utils/index.js";
import {
  hasAvailableWordPressVariation,
  matchExistingWordPressVariations,
  previewWordPressVariationPatchItems,
  WordPressExporter,
  WordPressSizeConverter,
  type WordPressCatalogClient,
} from "../integrations/wordpress/index.js";
import type { JobRepository, SourceProductRepository, SourceRepository, TargetContentTemplateRepository, WordPressCatalogAuditSaveInput, WordPressCatalogRepository, WordPressCatalogVariationCandidate } from "../repositories/index.js";
import { buildWordPressCatalogAudit, type TargetReferenceMappingService } from "../services/index.js";
import type { CollectWordPressVariationSourcePayload, PollWordPressVariationPatchesPayload, PrepareWordPressVariationPatchPayload, PrepareWordPressVariationPatchesPayload, SubmitWordPressVariationPatchesPayload } from "./job-payloads.js";
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

export function buildWordPressVariationPatchIdentity(input: {
  readonly targetId: string;
  readonly sourceCode: string;
  readonly sourceExternalId: string;
  readonly matchMethod: string | null;
  readonly sku: string | null;
}): JsonObject {
  const identity: JsonObject = {
    target_id: Number(input.targetId),
    source_code: input.sourceCode,
    source_external_id: input.sourceExternalId,
    external_key: `${input.sourceCode}:${input.sourceExternalId}`,
  };
  if (input.matchMethod === "unique_sku") {
    const expectedSku = input.sku?.trim() ?? "";
    if (expectedSku === "") throw new IntegrationContractError("Legacy SKU match does not contain a SKU");
    return { ...identity, expected_sku: expectedSku };
  }
  return identity;
}

export function wordpressVariationJobOutcome(status: string): "completed" | "failed" | "pending" {
  if (status === "done") return "completed";
  if (status === "error") return "failed";
  return "pending";
}

const freshTargetSnapshotNotice = "fresh_target_snapshot";

export function shouldRefreshWordPressVariationSnapshot(
  error: string,
  notices: readonly JsonObject[],
): boolean {
  return /Variation patch permanent \[(?:variation_identity_conflict|variation_not_found|variation_size_changed)\]/u.test(error)
    && !notices.some((notice) => notice.code === freshTargetSnapshotNotice);
}

export function shouldRefreshWordPressVariationSnapshotBeforeSubmit(error: unknown): boolean {
  return error instanceof IntegrationContractError
    && /^WordPress size pa_[a-z0-9_-]+:\d+ requires full product synchronization before (?:native size )?inventory updates$/u.test(error.message);
}

export function wordpressCatalogItemError(error: unknown): string | null {
  return error instanceof IntegrationContractError || error instanceof MappingMissingError
    || (error instanceof PermanentError && error.code === "GOAT_PRODUCT_NOT_FOUND")
    ? error.message
    : null;
}

export class WordPressVariationPatchRunner {
  private static readonly retainedRunCaches = 4;
  private readonly converter: WordPressSizeConverter;
  private readonly exporter: WordPressExporter;
  private readonly referenceCachesByRun = new Map<
    string,
    Map<string, ReturnType<TargetReferenceMappingService["resolveTargetMapping"]>>
  >();
  private readonly projectionCachesByRun = new Map<
    string,
    Map<string, ReturnType<TargetReferenceMappingService["resolveTargetProjections"]>>
  >();
  private readonly assignmentResolversByRun = new Map<
    string,
    Promise<Awaited<ReturnType<TargetReferenceMappingService["createTargetAssignmentResolver"]>>>
  >();

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

  private trimRunCaches(activeRunId: string): void {
    const runIds = [...new Set([
      ...this.referenceCachesByRun.keys(),
      ...this.projectionCachesByRun.keys(),
      ...this.assignmentResolversByRun.keys(),
    ])].filter((runId) => runId !== activeRunId);
    while (runIds.length >= WordPressVariationPatchRunner.retainedRunCaches) {
      const oldest = runIds.shift();
      if (oldest === undefined) break;
      this.referenceCachesByRun.delete(oldest);
      this.projectionCachesByRun.delete(oldest);
      this.assignmentResolversByRun.delete(oldest);
    }
  }

  async prepare(payload: PrepareWordPressVariationPatchesPayload): Promise<RunnerResult> {
    return this.mappings.runWithRules(() => this.prepareUnderRules(payload));
  }

  private async prepareUnderRules(payload: PrepareWordPressVariationPatchesPayload): Promise<RunnerResult> {
    this.trimRunCaches(payload.runId);
    const run = await this.repository.getRun(payload.runId);
    if (run === null) throw new IntegrationContractError(`WordPress catalog run not found: ${payload.runId}`);
    const candidates = await this.repository.listVariationCandidates({
      runId: payload.runId,
      afterWordPressProductId: payload.afterCursor,
      throughWordPressProductId: payload.throughCursor,
    });
    const cacheKey = payload.runId + ":" + (candidates[0] === undefined ? "" : await this.mappings.getTargetMappingRevision(candidates[0].target.id));
    this.trimRunCaches(cacheKey);
    const activeTemplates = candidates.length === 0 ? [] : await this.contentTemplates.listActive(candidates[0]!.target.id);
    const templates = activeTemplates.map((template) => ({
      id: template.id, field: template.field, revision: template.revision, templateSource: template.templateSource,
      profileKey: template.profileKey, profileName: template.profileName, managementMode: template.managementMode,
      categoryTermIds: template.categoryTermIds, requiredContextPaths: template.requiredContextPaths,
    }));
    let referenceCache = this.referenceCachesByRun.get(cacheKey);
    if (referenceCache === undefined) {
      referenceCache = new Map<string, ReturnType<TargetReferenceMappingService["resolveTargetMapping"]>>();
      this.referenceCachesByRun.set(cacheKey, referenceCache);
    }
    let projectionCache = this.projectionCachesByRun.get(cacheKey);
    if (projectionCache === undefined) {
      projectionCache = new Map<string, ReturnType<TargetReferenceMappingService["resolveTargetProjections"]>>();
      this.projectionCachesByRun.set(cacheKey, projectionCache);
    }
    let assignmentResolver = this.assignmentResolversByRun.get(cacheKey);
    if (assignmentResolver === undefined && candidates[0] !== undefined) {
      assignmentResolver = this.mappings.createTargetAssignmentResolver(candidates[0].target.id);
      this.assignmentResolversByRun.set(cacheKey, assignmentResolver);
    }
    const resolveAssignments = assignmentResolver === undefined
      ? async () => []
      : await assignmentResolver;
    const resolveReference = (targetId: string, input: TargetReferenceResolutionInput) => {
      const key = `${targetId}:${input.referenceId}:${input.targetScope}`;
      const cached = referenceCache.get(key);
      if (cached !== undefined) return cached;
      const resolution = this.mappings.resolveTargetMapping(targetId, input.referenceId, input.targetScope);
      referenceCache.set(key, resolution);
      return resolution;
    };
    const resolveProjections = (targetId: string, inputs: readonly TargetProjectionResolutionInput[]) => {
      const resolutions = inputs.map((input) => {
        const key = `${targetId}:${input.resolutionKind}:${input.resolutionId}:${input.referenceId}`;
        const cached = projectionCache.get(key);
        if (cached !== undefined) return cached;
        const resolution = this.mappings.resolveTargetProjections(targetId, [input]);
        projectionCache.set(key, resolution);
        return resolution;
      });
      return Promise.all(resolutions).then((items) => items.flat());
    };
    const auditResults: WordPressCatalogAuditSaveInput[] = [];
    for (const candidate of candidates) {
      const context = {
        source: candidate.source,
        sourceProduct: candidate.sourceProduct,
        target: candidate.target,
        product: await this.mappings.prepareProduct(candidate.source.id, candidate.product),
        existingExternalId: candidate.item.wordpressProductId,
        existingTargetSnapshot: candidate.item.payload,
        references: {
          resolveReference: (input) => resolveReference(candidate.target.id, input),
          resolveProjections: (inputs) => resolveProjections(candidate.target.id, inputs),
          resolveAssignments,
        },
        contentTemplates: templates,
      } satisfies Parameters<WordPressExporter["previewPayload"]>[0];
      if (run.auditRequested && candidate.item.auditStatus === "pending") {
        try {
          const fullDraft = await this.exporter.previewPayload(context);
          auditResults.push({ itemId: candidate.item.id, status: "ready", result: buildWordPressCatalogAudit(fullDraft, candidate.item.payload) });
        } catch (error) {
          const message = wordpressCatalogItemError(error);
          if (message === null) throw error;
          auditResults.push({ itemId: candidate.item.id, status: "blocked", error: message,
            result: { risk: "blocked", blockers: [{ code: "payload_contract", message }] } });
        }
      }
      if (run.variationSyncRequested) {
        await this.jobs.enqueue({
          jobType: "collect_wordpress_variation_source",
          payload: { runId: payload.runId, itemId: candidate.item.id, wordpressProductId: candidate.item.wordpressProductId },
          uniqueKey: `wordpress-variation-collect:${payload.runId}:${candidate.item.id}`,
        });
      }
    }
    await this.repository.saveAudits(auditResults);
    return { status: "completed" };
  }

  async collect(payload: CollectWordPressVariationSourcePayload): Promise<RunnerResult> {
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
      const sourceHash = hashStableJson(liveVariants as unknown as JsonValue);
      let unchanged = payload.force !== true && candidate.item.variationAppliedSourceHash === sourceHash;
      if (unchanged && liveVariants.length === 0) {
        const currentWordPress = await this.client.readProduct(payload.wordpressProductId);
        if (currentWordPress === null) {
          throw new IntegrationContractError(`WordPress product not found: ${payload.wordpressProductId}`);
        }
        unchanged = !hasAvailableWordPressVariation(currentWordPress.snapshot);
      }
      await this.repository.saveVariationSource({
        runId: payload.runId,
        itemId: candidate.item.id,
        wordpressProductId: payload.wordpressProductId,
        sourceHash,
        variants: liveVariants,
        unchanged,
        force: payload.force === true,
      });
      return { status: "completed" };
    } catch (error) {
      const message = wordpressCatalogItemError(error);
      if (message === null) throw error;
      await this.repository.saveVariationPreparation({ itemId: candidate.item.id, status: "skipped", notices: [], error: message });
      return { status: "completed" };
    }
  }

  async preparePatch(payload: PrepareWordPressVariationPatchPayload): Promise<RunnerResult> {
    return this.mappings.runWithRules(() => this.preparePatchUnderRules(payload));
  }

  private async preparePatchUnderRules(payload: PrepareWordPressVariationPatchPayload): Promise<RunnerResult> {
    const cursor = (BigInt(payload.wordpressProductId) - 1n).toString();
    const candidates = await this.repository.listVariationCandidates({
      runId: payload.runId,
      afterWordPressProductId: cursor,
      throughWordPressProductId: payload.wordpressProductId,
    });
    const candidate = candidates.find((item) => item.item.id === payload.itemId);
    if (candidate === undefined) return { status: "skipped" };
    if (candidate.item.variationStatus !== "refreshing" || candidate.item.variationSourceHash === null) {
      return { status: "skipped" };
    }
    try {
      const refreshedProduct = await this.sourceProducts.getById(candidate.sourceProduct.id);
      if (refreshedProduct?.externalId === null || refreshedProduct === null) {
        throw new IntegrationContractError(`Source refresh did not resolve externalId for product ${candidate.sourceProduct.id}`);
      }
      let targetSnapshot = candidate.item.payload;
      if (payload.force === true || candidate.item.variationSourceVariants.length === 0) {
        const currentWordPress = await this.client.readProduct(candidate.item.wordpressProductId);
        if (currentWordPress === null) {
          throw new IntegrationContractError(`WordPress product not found: ${candidate.item.wordpressProductId}`);
        }
        targetSnapshot = currentWordPress.snapshot;
      }
      const effectiveCandidate: WordPressCatalogVariationCandidate = {
        ...candidate,
        item: { ...candidate.item, payload: targetSnapshot },
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
      let patchPayload: JsonObject | null;
      try {
        patchPayload = await this.buildPatchPayload(effectiveCandidate, payload.runId, candidate.item.variationSourceVariants);
      } catch (error) {
        if (payload.force === true || !shouldRefreshWordPressVariationSnapshotBeforeSubmit(error)) throw error;
        const currentWordPress = await this.client.readProduct(candidate.item.wordpressProductId);
        if (currentWordPress === null) {
          throw new IntegrationContractError(`WordPress product not found: ${candidate.item.wordpressProductId}`);
        }
        patchPayload = await this.buildPatchPayload({
          ...effectiveCandidate,
          item: { ...effectiveCandidate.item, payload: currentWordPress.snapshot },
        }, payload.runId, candidate.item.variationSourceVariants, true);
      }
      if (patchPayload === null) return { status: "skipped" };
      if (!await this.repository.isVariationAutoSyncRunning(payload.runId)) {
        await this.repository.enqueueReadyVariationBatches(payload.runId, 100);
      }
      return { status: "completed" };
    } catch (error) {
      const message = wordpressCatalogItemError(error);
      if (message === null) throw error;
      await this.repository.saveVariationPreparation({ itemId: candidate.item.id, status: "skipped", notices: [], error: message });
      return { status: "completed" };
    }
  }

  async submit(payload: SubmitWordPressVariationPatchesPayload): Promise<RunnerResult> {
    const items = await this.repository.listVariationSubmissionItems(payload.runId, payload.itemIds);
    if (items.length === 0) return { status: "skipped" };
    const prepared = items.filter((item): item is typeof item & { variationPayload: JsonObject } => item.variationPayload !== null);
    if (prepared.length !== items.length) throw new IntegrationContractError("WordPress variation batch contains an item without a prepared payload");
    const submissions = await this.client.submitVariationPatches(prepared.map((item) => item.variationPayload));
    const byIndex = new Map(submissions.map((submission) => [submission.index, submission] as const));
    if (byIndex.size !== prepared.length || prepared.some((_, index) => !byIndex.has(index))) {
      throw new IntegrationContractError("WordPress returned an incomplete variation patch batch");
    }
    const wordpressJobIds: string[] = [];
    for (const [index, item] of prepared.entries()) {
      const submission = byIndex.get(index);
      if (submission === undefined) throw new IntegrationContractError(`WordPress did not return variation patch result ${index}`);
      const wordpressJobId = submission.job === undefined ? null : jobId(submission.job);
      if (!submission.accepted || wordpressJobId === null) {
        await this.repository.saveVariationJobResult({ itemId: item.id, status: "failed", result: record(submission as unknown),
          error: submission.error ?? submission.code ?? "WordPress rejected variation patch" });
        continue;
      }
      await this.repository.saveVariationSubmission({ itemId: item.id, wordpressJobId, result: submission.job! });
      wordpressJobIds.push(wordpressJobId);
    }
    if (wordpressJobIds.length > 0) await this.enqueuePoll(payload.runId, wordpressJobIds, 0);
    return { status: "completed" };
  }

  private async buildPatchPayload(
    candidate: WordPressCatalogVariationCandidate,
    runId: string,
    liveVariants: readonly ProductVariantDTO[],
    targetSnapshotRefreshed = false,
  ): Promise<JsonObject | null> {
    if (liveVariants.length === 0) {
      await this.repository.saveVariationPreparation({
        itemId: candidate.item.id,
        status: "skipped",
        notices: [{ code: "empty_source_offers", message: "GOAT не вернул вариации; WordPress оставлен без изменений" }],
        error: "Пустой список GOAT offers не подтверждает отсутствие остатков",
      });
      return null;
    }
    const cacheKey = runId + ":" + await this.mappings.getTargetMappingRevision(candidate.target.id);
    this.trimRunCaches(cacheKey);
    let referenceCache = this.referenceCachesByRun.get(cacheKey);
    if (referenceCache === undefined) {
      referenceCache = new Map();
      this.referenceCachesByRun.set(cacheKey, referenceCache);
    }
    let projectionCache = this.projectionCachesByRun.get(cacheKey);
    if (projectionCache === undefined) {
      projectionCache = new Map();
      this.projectionCachesByRun.set(cacheKey, projectionCache);
    }
    let assignmentResolver = this.assignmentResolversByRun.get(cacheKey);
    if (assignmentResolver === undefined) {
      assignmentResolver = this.mappings.createTargetAssignmentResolver(candidate.target.id);
      this.assignmentResolversByRun.set(cacheKey, assignmentResolver);
    }
    const resolveAssignments = await assignmentResolver;
    const resolveReference = (input: TargetReferenceResolutionInput) => {
      const key = `${candidate.target.id}:${input.referenceId}:${input.targetScope}`;
      const cached = referenceCache.get(key);
      if (cached !== undefined) return cached;
      const result = this.mappings.resolveTargetMapping(candidate.target.id, input.referenceId, input.targetScope);
      referenceCache.set(key, result);
      return result;
    };
    const resolveProjections = (inputs: readonly TargetProjectionResolutionInput[]) => Promise.all(inputs.map((input) => {
      const key = `${candidate.target.id}:${input.resolutionKind}:${input.resolutionId}:${input.referenceId}`;
      const cached = projectionCache.get(key);
      if (cached !== undefined) return cached;
      const result = this.mappings.resolveTargetProjections(candidate.target.id, [input]);
      projectionCache.set(key, result);
      return result;
    })).then((items) => items.flat());
    const draft = await previewWordPressVariationPatchItems({
      source: candidate.source,
      sourceProduct: candidate.sourceProduct,
      target: candidate.target,
      product: await this.mappings.prepareProduct(candidate.source.id, candidate.product),
      liveVariants,
      existingExternalId: candidate.item.wordpressProductId,
      existingTargetSnapshot: candidate.item.payload,
      references: {
        resolveReference,
        resolveProjections,
        resolveAssignments,
      },
    }, this.converter);
    const matched = matchExistingWordPressVariations(draft, candidate.item.payload);
    if (matched.items.length === 0 || matched.items.length > 100) {
      const error = matched.items.length === 0
        ? "Нет безопасных вариаций для обновления или создания"
        : "У товара больше 100 обновляемых вариаций; требуется отдельная партия";
      await this.repository.saveVariationPreparation({ itemId: candidate.item.id, status: "skipped", notices: matched.ignored, error });
      return null;
    }
    const basis = {
      contract_version: "slds.wordpress.variation-patch.v3",
      mode: "upsert_variations",
      identity: buildWordPressVariationPatchIdentity({
        targetId: candidate.item.wordpressProductId,
        sourceCode: candidate.source.code,
        sourceExternalId: candidate.sourceProduct.externalId!,
        matchMethod: candidate.item.matchMethod,
        sku: candidate.item.sku,
      }),
      variations: { items: matched.items },
    } as JsonObject;
    const patchPayload = { ...basis, idempotency_key: `catalog-${runId}-${candidate.item.id}-${hashStableJson(basis).slice(0, 32)}` } as JsonObject;
    await this.repository.saveVariationPreparation({ itemId: candidate.item.id, status: "ready", payload: patchPayload,
      notices: [
        ...matched.ignored,
        { code: "live_source_refresh", message: "Цены и наличие получены непосредственно перед постановкой WordPress job; WordPress повторно проверит identity и размер перед записью" },
        ...(targetSnapshotRefreshed ? [{ code: freshTargetSnapshotNotice, message: "Вариации WordPress перечитаны после конфликта identity" }] : []),
      ] });
    return patchPayload;
  }

  private async retryWithFreshTargetSnapshot(
    runId: string,
    item: Awaited<ReturnType<WordPressCatalogRepository["listSubmittedVariationItems"]>>[number],
  ): Promise<void> {
    const currentWordPress = await this.client.readProduct(item.wordpressProductId);
    if (currentWordPress === null) {
      throw new IntegrationContractError(`WordPress product not found: ${item.wordpressProductId}`);
    }
    const cursor = (BigInt(item.wordpressProductId) - 1n).toString();
    const candidates = await this.repository.listVariationCandidates({
      runId,
      afterWordPressProductId: cursor,
      throughWordPressProductId: item.wordpressProductId,
      itemId: item.id,
    });
    const candidate = candidates.find((entry) => entry.item.id === item.id);
    if (candidate === undefined) throw new IntegrationContractError(`WordPress catalog item not found: ${item.id}`);
    const refreshedProduct = await this.sourceProducts.getById(candidate.sourceProduct.id);
    if (refreshedProduct?.externalId === null || refreshedProduct === null) {
      throw new IntegrationContractError(`Source refresh did not resolve externalId for product ${candidate.sourceProduct.id}`);
    }
    const effectiveCandidate: WordPressCatalogVariationCandidate = {
      ...candidate,
      item: { ...candidate.item, payload: currentWordPress.snapshot },
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
    const patchPayload = await this.buildPatchPayload(effectiveCandidate, runId, item.variationSourceVariants, true);
    if (patchPayload !== null && !await this.repository.isVariationAutoSyncRunning(runId)) {
      await this.repository.enqueueReadyVariationBatches(runId, 100);
    }
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
      const outcome = wordpressVariationJobOutcome(status);
      if (outcome === "completed") {
        await this.repository.saveVariationJobResult({ itemId: item.id, status: "completed", result: job! });
      } else if (outcome === "failed") {
        const error = String(job?.last_error ?? "WordPress job failed");
        if (shouldRefreshWordPressVariationSnapshot(error, item.variationNotices)) {
          try {
            await this.retryWithFreshTargetSnapshot(payload.runId, item);
            continue;
          } catch (retryError) {
            const message = wordpressCatalogItemError(retryError);
            if (message === null) throw retryError;
            await this.repository.saveVariationJobResult({ itemId: item.id, status: "failed", result: job!, error: `${error} Fresh snapshot retry failed: ${message}` });
            continue;
          }
        }
        await this.repository.saveVariationJobResult({ itemId: item.id, status: "failed", result: job!, error });
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

  async failItem(itemId: string, error: string): Promise<void> {
    await this.repository.saveVariationPreparation({ itemId, status: "failed", notices: [], error });
  }

  async failSubmission(runId: string, itemIds: readonly string[], error: string): Promise<void> {
    await this.repository.failVariationItems(runId, itemIds, error);
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
