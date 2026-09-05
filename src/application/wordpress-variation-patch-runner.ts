import type { WordPressTargetConfig } from "../config/index.js";
import type { JsonObject, ProductVariantDTO, TargetProjectionResolutionInput, TargetReferenceResolutionInput } from "../contracts/index.js";
import { IntegrationContractError, MappingMissingError } from "../core/errors/index.js";
import { hashStableJson } from "../core/utils/index.js";
import {
  changedWordPressVariationPatchItems,
  matchExistingWordPressVariations,
  previewWordPressVariationPatchItems,
  WordPressExporter,
  WordPressSizeConverter,
  type WordPressCatalogClient,
  type WordPressPatchSubmission,
} from "../integrations/wordpress/index.js";
import type { JobRepository, SourceProductRepository, SourceRepository, TargetContentTemplateRepository, WordPressCatalogAuditSaveInput, WordPressCatalogRepository, WordPressCatalogVariationCandidate } from "../repositories/index.js";
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

export function wordpressCatalogItemError(error: unknown): string | null {
  return error instanceof IntegrationContractError || error instanceof MappingMissingError
    ? error.message
    : null;
}

interface PendingWordPressVariationPatch {
  readonly payload: JsonObject;
  readonly resolve: (submission: WordPressPatchSubmission) => void;
  readonly reject: (error: unknown) => void;
}

export class WordPressVariationPatchSubmitter {
  private readonly pending: PendingWordPressVariationPatch[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;

  constructor(
    private readonly client: Pick<WordPressCatalogClient, "submitVariationPatches">,
    private readonly delayMs = 50,
  ) {}

  submit(payload: JsonObject): Promise<WordPressPatchSubmission> {
    const promise = new Promise<WordPressPatchSubmission>((resolve, reject) => {
      this.pending.push({ payload, resolve, reject });
    });
    if (this.pending.length >= 100 && !this.flushing) {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
      void this.flush();
    } else {
      this.schedule();
    }
    return promise;
  }

  private schedule(): void {
    if (this.timer !== undefined || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.delayMs);
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.pending.length === 0) return;
    this.flushing = true;
    const batch = this.pending.splice(0, 100);
    try {
      const submissions = await this.client.submitVariationPatches(batch.map((item) => item.payload));
      const byIndex = new Map(submissions.map((submission) => [submission.index, submission]));
      for (const [index, item] of batch.entries()) {
        const submission = byIndex.get(index);
        if (submission === undefined) {
          item.reject(new IntegrationContractError(`WordPress did not return variation patch result ${index}`));
        } else {
          item.resolve(submission);
        }
      }
    } catch (error) {
      for (const item of batch) item.reject(error);
    } finally {
      this.flushing = false;
      this.schedule();
    }
  }
}

export class WordPressVariationPatchRunner {
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
  private readonly submitter: WordPressVariationPatchSubmitter;

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
    this.submitter = new WordPressVariationPatchSubmitter(client);
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
    }));
    let referenceCache = this.referenceCachesByRun.get(payload.runId);
    if (referenceCache === undefined) {
      referenceCache = new Map<string, ReturnType<TargetReferenceMappingService["resolveTargetMapping"]>>();
      this.referenceCachesByRun.set(payload.runId, referenceCache);
    }
    let projectionCache = this.projectionCachesByRun.get(payload.runId);
    if (projectionCache === undefined) {
      projectionCache = new Map<string, ReturnType<TargetReferenceMappingService["resolveTargetProjections"]>>();
      this.projectionCachesByRun.set(payload.runId, projectionCache);
    }
    let assignmentResolver = this.assignmentResolversByRun.get(payload.runId);
    if (assignmentResolver === undefined && candidates[0] !== undefined) {
      assignmentResolver = this.mappings.createTargetAssignmentResolver(candidates[0].target.id);
      this.assignmentResolversByRun.set(payload.runId, assignmentResolver);
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
        product: candidate.product,
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
          jobType: "refresh_wordpress_variation_patch",
          payload: { runId: payload.runId, itemId: candidate.item.id, wordpressProductId: candidate.item.wordpressProductId },
          uniqueKey: `wordpress-variation-refresh:${payload.runId}:${candidate.item.id}`,
        });
      }
    }
    await this.repository.saveAudits(auditResults);
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
      if (liveVariants.length === 0) {
        throw new IntegrationContractError("GOAT не вернул ни одной вариации; автоматическое снятие всех размеров с продажи запрещено");
      }
      const currentWordPress = await this.client.readProduct(payload.wordpressProductId);
      if (currentWordPress === null) {
        throw new IntegrationContractError(`WordPress product not found: ${payload.wordpressProductId}`);
      }
      const refreshedProduct = await this.sourceProducts.getById(sourceProduct.id);
      if (refreshedProduct?.externalId === null || refreshedProduct === null) {
        throw new IntegrationContractError(`Source refresh did not resolve externalId for product ${sourceProduct.id}`);
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
      const patchPayload = await this.buildPatchPayload(effectiveCandidate, payload.runId, liveVariants);
      if (patchPayload === null) return { status: "skipped" };
      const submission = await this.submitter.submit(patchPayload);
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
      const message = wordpressCatalogItemError(error);
      if (message === null) throw error;
      await this.repository.saveVariationPreparation({ itemId: candidate.item.id, status: "skipped", notices: [], error: message });
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
        resolveReference: (input) => this.mappings.resolveTargetMapping(candidate.target.id, input.referenceId, input.targetScope),
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
    const changedItems = changedWordPressVariationPatchItems(matched.items, candidate.item.payload);
    if (changedItems.length === 0) {
      await this.repository.saveVariationPreparation({
        itemId: candidate.item.id,
        status: "skipped",
        notices: [...matched.ignored, { code: "no_variation_changes", message: "Цена и наличие уже совпадают с WordPress" }],
      });
      return null;
    }
    const basis = {
      contract_version: "slds.wordpress.variation-patch.v2",
      mode: "patch_existing_variations",
      identity: buildWordPressVariationPatchIdentity({
        targetId: candidate.item.wordpressProductId,
        sourceCode: candidate.source.code,
        sourceExternalId: candidate.sourceProduct.externalId!,
        matchMethod: candidate.item.matchMethod,
        sku: candidate.item.sku,
      }),
      variations: { items: changedItems },
    } as JsonObject;
    const patchPayload = { ...basis, idempotency_key: `catalog-${runId}-${candidate.item.id}-${hashStableJson(basis).slice(0, 32)}` } as JsonObject;
    await this.repository.saveVariationPreparation({ itemId: candidate.item.id, status: "ready", payload: patchPayload,
      notices: [...matched.ignored, { code: "live_source_refresh", message: "Цены, наличие и текущее состояние WordPress получены непосредственно перед постановкой WordPress job" }] });
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
      const outcome = wordpressVariationJobOutcome(status);
      if (outcome === "completed") {
        await this.repository.saveVariationJobResult({ itemId: item.id, status: "completed", result: job! });
      } else if (outcome === "failed") {
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
