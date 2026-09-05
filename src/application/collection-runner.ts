import type { DiscoveredSourceProduct, SourceDTO } from "../contracts/index.js";
import { EntityNotFoundError, IntegrationContractError } from "../core/errors/index.js";
import type { SourceAdapterRegistry } from "../core/registry/index.js";
import { hashStableJson, stableJsonStringify } from "../core/utils/index.js";
import type { SourceProductRepository, SourceRepository, SourceRunRepository, UnitOfWork } from "../repositories/index.js";
import type { CollectProductPayload, DiscoverSourcePayload } from "./job-payloads.js";
import type { RunnerResult } from "./runner-result.js";
import { SourcePartCollector } from "./source-part-collector.js";

export interface CollectionRunnerRepositories {
  readonly sources: SourceRepository;
  readonly sourceRuns: SourceRunRepository;
  readonly sourceProducts: SourceProductRepository;
}

const now = (): string => new Date().toISOString();

function sourceDto(source: { readonly id: string; readonly code: string; readonly config: SourceDTO["config"] }): SourceDTO {
  return { id: source.id, code: source.code, config: source.config };
}

export class CollectionRunner {
  private readonly partCollector: SourcePartCollector;

  constructor(
    private readonly repositories: CollectionRunnerRepositories,
    private readonly unitOfWork: UnitOfWork,
    private readonly adapters: SourceAdapterRegistry,
    partCollector?: SourcePartCollector,
  ) {
    this.partCollector = partCollector ?? new SourcePartCollector(repositories.sourceProducts, unitOfWork, adapters);
  }

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
          const discovered = await repositories.sourceProducts.upsertDiscovered({
            sourceId: source.id, sourceKey: item.sourceKey,
            ...(item.externalId === undefined ? {} : { externalId: item.externalId }),
            ...(item.slug === undefined ? {} : { slug: item.slug }),
            ...(item.url === undefined ? {} : { url: item.url }),
            discoveryMetadata: item.metadata, status: "discovered", seenAt: now(), runId: run.id,
            discoveryFingerprint: hashStableJson({
              sourceKey: item.sourceKey,
              externalId: item.externalId ?? null,
              slug: item.slug ?? null,
              url: item.url ?? null,
              metadata: item.metadata,
            }),
          });
          if (payload.enqueueCollection !== false || (payload.enqueueNewCollection === true && discovered.created)) {
            await repositories.jobs.enqueue({ jobType: "collect_product", payload: { sourceProductId: discovered.product.id }, uniqueKey: `source-product:${discovered.product.id}:collect` });
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
    await this.partCollector.collect(source, product, payload.requestedPartKeys, async (repositories) => {
      if (payload.enqueueProcessing !== false) {
        // ProcessingRunner owns the full input hash, including processor and operation versions.
        // Enqueue after every successful collection so code changes are applied even when source JSON is unchanged.
        await repositories.jobs.enqueue({ jobType: "process_product", payload: { sourceProductId: product.id, force: false }, uniqueKey: `source-product:${product.id}:process` });
      }
    });
    return { status: "completed" };
  }
}
