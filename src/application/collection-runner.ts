import type { DiscoveredSourceProduct, SourceDTO, SourceProductDTO } from "../contracts/index.js";
import { EntityNotFoundError, IntegrationContractError } from "../core/errors/index.js";
import type { SourceAdapterRegistry } from "../core/registry/index.js";
import { hashStableJson, stableJsonStringify } from "../core/utils/index.js";
import type { ExportControlRepository, JobRepository, SourceProductRepository, SourceRepository, SourceRunRepository, UnitOfWork } from "../repositories/index.js";
import type { CollectProductPayload, DiscoverSourcePayload } from "./job-payloads.js";
import type { RunnerResult } from "./runner-result.js";

export interface CollectionRunnerRepositories {
  readonly sources: SourceRepository;
  readonly sourceRuns: SourceRunRepository;
  readonly sourceProducts: SourceProductRepository;
  readonly jobs: JobRepository;
}

const now = (): string => new Date().toISOString();

function sourceDto(source: { readonly id: string; readonly code: string; readonly config: SourceDTO["config"] }): SourceDTO {
  return { id: source.id, code: source.code, config: source.config };
}

export class CollectionRunner {
  constructor(
    private readonly repositories: CollectionRunnerRepositories,
    private readonly unitOfWork: UnitOfWork,
    private readonly adapters: SourceAdapterRegistry,
    private readonly exportControl?: ExportControlRepository,
  ) {}

  async discoverSource(payload: DiscoverSourcePayload): Promise<RunnerResult> {
    const source = await this.repositories.sources.getById(payload.sourceId);
    if (source === null || !source.enabled) throw new EntityNotFoundError("Enabled source", payload.sourceId);
    const adapter = this.adapters.get(source.adapterCode);
    let run = await this.repositories.sourceRuns.findActiveBySource(source.id);
    if (run === null) {
      run = await this.repositories.sourceRuns.create({ sourceId: source.id, runType: payload.runType, coverage: payload.coverage, checkpoint: {} });
    }

    let checkpoint = run.checkpoint;
    while (true) {
      const page = await adapter.discover({ source: sourceDto(source), runType: run.runType, checkpoint });
      if (page.hasMore && stableJsonStringify(page.checkpoint) === stableJsonStringify(checkpoint)) {
        throw new IntegrationContractError(`Discovery checkpoint did not advance for source ${source.id}`);
      }
      const uniqueItems = new Map<string, DiscoveredSourceProduct>();
      for (const item of page.items) uniqueItems.set(item.sourceKey, item);
      await this.unitOfWork.transaction(async (repositories) => {
        for (const item of uniqueItems.values()) {
          const product = await repositories.sourceProducts.upsertDiscovered({
            sourceId: source.id, sourceKey: item.sourceKey,
            ...(item.externalId === undefined ? {} : { externalId: item.externalId }),
            ...(item.slug === undefined ? {} : { slug: item.slug }),
            ...(item.url === undefined ? {} : { url: item.url }),
            discoveryMetadata: item.metadata, status: "discovered", seenAt: now(), runId: run.id,
          });
          if (payload.enqueueCollection !== false) {
            await repositories.jobs.enqueue({ jobType: "collect_product", payload: { sourceProductId: product.id }, uniqueKey: `source-product:${product.id}:collect` });
          }
        }
        await repositories.sourceRuns.recordPage(run.id, {
          checkpoint: page.checkpoint, processedCount: String(page.stats.processed), discoveredCount: String(page.stats.discovered), errorCount: "0", completeness: page.completeness,
        });
        if (!page.hasMore) await repositories.sourceRuns.complete(run.id, { checkpoint: page.checkpoint, completeness: page.completeness, finishedAt: now() });
      });
      checkpoint = page.checkpoint;
      if (!page.hasMore) return { status: "completed" };
    }
  }

  async collectProduct(payload: CollectProductPayload): Promise<RunnerResult> {
    const product = await this.repositories.sourceProducts.getById(payload.sourceProductId);
    if (product === null) throw new EntityNotFoundError("Source product", payload.sourceProductId);
    const source = await this.repositories.sources.getById(product.sourceId);
    if (source === null) throw new EntityNotFoundError("Source", product.sourceId);
    const adapter = this.adapters.get(source.adapterCode);
    if (payload.refreshForExport === true && this.exportControl === undefined) {
      throw new IntegrationContractError("Export source refresh is not configured");
    }
    if (payload.refreshForExport === true && payload.enqueueProcessing === false) {
      throw new IntegrationContractError("Export source refresh requires processing");
    }
    if (payload.refreshForExport === true && payload.requestedPartKeys !== undefined) {
      throw new IntegrationContractError("Export source refresh part keys are owned by the source adapter");
    }
    const requestedPartKeys = payload.refreshForExport === true
      ? adapter.exportRefreshPartKeys
      : payload.requestedPartKeys;
    if (payload.refreshForExport === true && (requestedPartKeys === undefined || requestedPartKeys.length === 0)) {
      throw new IntegrationContractError(`Source adapter ${adapter.code} does not define export refresh parts`);
    }
    const dto: SourceProductDTO = { id: product.id, sourceId: product.sourceId, sourceKey: product.sourceKey,
      ...(product.externalId === null ? {} : { externalId: product.externalId }), ...(product.slug === null ? {} : { slug: product.slug }),
      ...(product.url === null ? {} : { url: product.url }), metadata: product.discoveryMetadata };
    const collected = await adapter.collectProduct({ source: sourceDto(source), product: dto, ...(requestedPartKeys === undefined ? {} : { requestedPartKeys }) });
    if (collected.sourceKey !== product.sourceKey) throw new IntegrationContractError(`Collected sourceKey does not match product ${product.id}`);
    const parts = new Map<string, (typeof collected.parts)[number]>();
    for (const part of collected.parts) {
      if (parts.has(part.partKey)) throw new IntegrationContractError(`Duplicate collected part: ${part.partKey}`);
      parts.set(part.partKey, part);
    }
    for (const requested of requestedPartKeys ?? []) {
      if (!parts.has(requested)) throw new IntegrationContractError(`Requested part is missing: ${requested}`);
    }
    const fetchedAt = now();
    await this.unitOfWork.transaction(async (repositories) => {
      await repositories.sourceProducts.updateIdentity(product.id, {
        ...(collected.externalId === undefined ? {} : { externalId: collected.externalId }),
        ...(collected.slug === undefined ? {} : { slug: collected.slug }), ...(collected.url === undefined ? {} : { url: collected.url }),
      });
      for (const part of parts.values()) {
        await repositories.sourceProducts.upsertPart({ sourceProductId: product.id, partKey: part.partKey,
          rawPayload: part.rawPayload, parsedPayload: part.parsedPayload, contentHash: hashStableJson(part.parsedPayload),
          ...(part.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: part.sourceUpdatedAt }), fetchedAt, adapterVersion: part.adapterVersion });
      }
    });
    const exportRefreshPartKeys = adapter.exportRefreshPartKeys ?? [];
    if (this.exportControl !== undefined && exportRefreshPartKeys.length > 0
      && exportRefreshPartKeys.every((partKey) => parts.has(partKey))) {
      await this.exportControl.markSourceRefreshed(product.id, fetchedAt);
    }
    if (payload.enqueueProcessing !== false) {
      // ProcessingRunner owns the full input hash, including processor and operation versions.
      // Enqueue after every successful collection so code changes are applied even when source JSON is unchanged.
      await this.repositories.jobs.enqueue({ jobType: "process_product", payload: { sourceProductId: product.id, force: false }, uniqueKey: `source-product:${product.id}:process` });
    }
    return { status: "completed" };
  }
}
