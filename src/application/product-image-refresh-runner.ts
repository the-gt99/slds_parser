import type { JsonValue, ProductImageDTO, ProductOperationContext } from "../contracts/index.js";
import { EntityNotFoundError, IntegrationContractError, RetryableError } from "../core/errors/index.js";
import type { SourceAdapterRegistry, SourceProcessorRegistry, TargetExporterRegistry } from "../core/registry/index.js";
import { hashStableJson } from "../core/utils/index.js";
import type { InternalProductRepository, SourceProductRepository, SourceRepository, TargetRepository, JobRepository, UnitOfWork } from "../repositories/index.js";
import type { ProductImageRefreshRepository } from "../repositories/product-image-refresh-repository.js";
import type { ImageRefreshClient } from "../processing/media/image-refresh-client.js";
import type { ImageStore } from "../processing/media/image-store.js";
import { imageContentHash, imagePerceptualHash } from "../processing/media/image-fingerprint.js";
import { SourcePartCollector } from "./source-part-collector.js";
import type { ProductImageJobPayload } from "./job-payloads.js";
import type { RunnerResult } from "./runner-result.js";

export interface ProductImageRefreshRepositories {
  readonly sources: SourceRepository;
  readonly sourceProducts: SourceProductRepository;
  readonly internalProducts: InternalProductRepository;
  readonly targets: TargetRepository;
  readonly jobs: JobRepository;
}

/** HTTP validators are bookkeeping; only source identity, order and published bytes affect a media write. */
export function productImagesFingerprint(images: readonly ProductImageDTO[]): string {
  return hashStableJson(images.map((image) => ({ sourceUrl: image.sourceUrl ?? image.url,
    position: image.position, contentHash: image.contentHash ?? null })) as unknown as JsonValue);
}

export class ProductImageRefreshRunner {
  private readonly collector: SourcePartCollector;

  constructor(
    private readonly repositories: ProductImageRefreshRepositories,
    private readonly unit: UnitOfWork,
    private readonly adapters: SourceAdapterRegistry,
    private readonly processors: SourceProcessorRegistry,
    private readonly clients: ReadonlyMap<string, ImageRefreshClient>,
    private readonly store: ImageStore,
    private readonly checks: ProductImageRefreshRepository,
    private readonly exporters: TargetExporterRegistry,
    private readonly intervalMs = 86_400_000,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) throw new Error("Image check interval must be at least 60000 ms");
    this.collector = new SourcePartCollector(repositories.sourceProducts, unit, adapters);
  }

  /** Called after successful inventory collection; network work is performed by a separate job. */
  async enqueueDue(payload: ProductImageJobPayload): Promise<void> {
    await this.checks.enqueueDue(payload, this.intervalMs);
  }

  private async load(payload: ProductImageJobPayload) {
    const sourceProduct = await this.repositories.sourceProducts.getById(payload.sourceProductId);
    if (sourceProduct === null) throw new EntityNotFoundError("Source product", payload.sourceProductId);
    const source = await this.repositories.sources.getById(sourceProduct.sourceId);
    if (source === null) throw new EntityNotFoundError("Source", sourceProduct.sourceId);
    const internal = await this.repositories.internalProducts.findBySourceProductId(sourceProduct.id);
    if (internal === null) throw new EntityNotFoundError("Internal product for source product", sourceProduct.id);
    const client = this.clients.get(source.code);
    if (client === undefined) throw new IntegrationContractError(`Source ${source.code} does not support image refresh`);
    return { sourceProduct, source, internal, client };
  }

  private async collectImages(payload: ProductImageJobPayload) {
    const loaded = await this.load(payload);
    const keys = this.adapters.get(loaded.source.adapterCode).imageRefreshPartKeys;
    const processor = this.processors.get(loaded.source.code);
    if (keys === undefined || keys.length === 0 || processor.processImageRefresh === undefined) {
      throw new IntegrationContractError(`Source ${loaded.source.code} does not provide an image refresh contract`);
    }
    const collected = await this.collector.collect(loaded.source, loaded.sourceProduct, keys);
    const images = await processor.processImageRefresh({ source: collected.source,
      sourceProduct: collected.sourceProduct, parts: collected.freshParts });
    // An empty list is honest source data, but it is not permission to erase target media.
    if (images.length === 0) throw new IntegrationContractError("Source image refresh returned no real images");
    const context: ProductOperationContext = { source: collected.source, sourceProduct: collected.sourceProduct };
    return { ...loaded, images, context };
  }

  async check(payload: ProductImageJobPayload): Promise<RunnerResult> {
    const { internal, images, client } = await this.collectImages(payload);
    const previous = [...internal.data.images].sort((a,b) => a.position - b.position);
    const current = [...images].sort((a,b) => a.position - b.position);
    let changed = previous.length !== current.length;
    for (let index = 0; index < current.length && !changed; index += 1) {
      const fresh = current[index]!;
      const old = previous[index];
      if (old === undefined || (old.sourceUrl ?? old.url) !== (fresh.sourceUrl ?? fresh.url)
        || old.position !== fresh.position || old.sourceContentHash === undefined
        || (!old.sourceEtag && !old.sourceLastModified)) {
        changed = true;
        break;
      }
      const inspected = await client.inspect(fresh.sourceUrl ?? fresh.url, {
        ...(old.sourceEtag === undefined ? {} : { etag: old.sourceEtag }),
        ...(old.sourceLastModified === undefined ? {} : { lastModified: old.sourceLastModified }),
      });
      changed = !inspected.unchanged;
    }
    if (changed) {
      await this.repositories.jobs.enqueue({ jobType: "refresh_product_images", payload: { ...payload },
        uniqueKey: `source-product:${payload.sourceProductId}:images` });
    }
    await this.checks.recordCheck(payload.sourceProductId, changed ? "changed" : "unchanged");
    return { status: changed ? "completed" : "skipped" };
  }

  async refresh(payload: ProductImageJobPayload): Promise<RunnerResult> {
    const { source, internal, images, client, context } = await this.collectImages(payload);
    const previous = new Map(internal.data.images.map((image) => [image.sourceUrl ?? image.url, image]));
    const processed: ProductImageDTO[] = [];
    for (const image of images) {
      const sourceUrl = image.sourceUrl ?? image.url;
      const downloaded = await client.downloadImage(sourceUrl);
      const sourceContentHash = imageContentHash(downloaded.body);
      const old = previous.get(sourceUrl);
      const validators = { ...(downloaded.etag === undefined ? {} : { sourceEtag: downloaded.etag }),
        ...(downloaded.lastModified === undefined ? {} : { sourceLastModified: downloaded.lastModified }) };
      let reusable = false;
      if (old?.sourceContentHash === sourceContentHash && old.contentHash && old.webpLocalPath) {
        try { reusable = imageContentHash(await this.store.read(old.webpLocalPath)) === old.contentHash; }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
      if (reusable && old !== undefined) {
        // Replace validator fields even if the server has stopped returning them.
        const { sourceEtag: _etag, sourceLastModified: _modified, ...retained } = old;
        processed.push({ ...retained, position: image.position, ...validators });
        continue;
      }
      // Refresh assets have immutable URLs; a conflict cannot overwrite a live image or its cached WebP.
      const asset = await this.store.storeOriginal(source.code,
        `${context.sourceProduct.id}_${sourceContentHash}`, image.position, downloaded.body);
      const path = await this.store.convertToWebp(asset.localPath);
      const binary = await this.store.read(path);
      processed.push({ ...image, sourceUrl, sourceContentHash, ...validators,
        url: await this.store.publish(path), localPath: path, webpLocalPath: path,
        mimeType: "image/webp", storedFormat: "webp", width: asset.width, height: asset.height,
        contentHash: imageContentHash(binary), perceptualHash: await imagePerceptualHash(binary) });
    }
    const changed = productImagesFingerprint(processed) !== productImagesFingerprint(internal.data.images);
    const data = { ...internal.data, images: processed };
    await this.unit.transaction(async (repositories) => {
      const updated = await repositories.internalProducts.updateDataIfContentHash({ id: internal.id,
        expectedContentHash: internal.contentHash, data, contentHash: hashStableJson(data as unknown as JsonValue) });
      if (updated === null) throw new RetryableError("Internal product changed during image refresh", { code: "IMAGE_REFRESH_CONFLICT" });
      if (changed) {
        await repositories.jobs.enqueue({ jobType: "export_product_images", payload: { ...payload },
          uniqueKey: `source-product:${payload.sourceProductId}:target:${payload.targetId}:images:${productImagesFingerprint(processed)}` });
      }
    });
    await this.checks.recordCheck(payload.sourceProductId, "refreshed");
    return { status: changed ? "completed" : "skipped" };
  }

  async exportImages(payload: ProductImageJobPayload, onSubmitted?: (submission: import("../contracts/index.js").JsonObject) => Promise<void>): Promise<RunnerResult> {
    const target = await this.repositories.targets.getById(payload.targetId);
    if (target === null) throw new EntityNotFoundError("Target", payload.targetId);
    if (!target.enabled && target.config.imageRefreshEnabled !== true) {
      throw new IntegrationContractError("Image export is blocked: target is disabled");
    }
    const { source, sourceProduct, internal } = await this.load(payload);
    const exporter = this.exporters.get(target.exporterCode);
    if (payload.submission !== undefined) {
      if (exporter.resumeExport === undefined) throw new IntegrationContractError("Target cannot resume image exports");
      await exporter.resumeExport(payload.submission.receipt);
      return { status: "completed" };
    }
    if (exporter.exportImages === undefined) throw new IntegrationContractError("Target does not support image-only exports");
    if (!sourceProduct.externalId) throw new IntegrationContractError("Image export requires source external identity");
    const imageHash = productImagesFingerprint(internal.data.images);
    await exporter.exportImages({ source: { id: source.id, code: source.code, config: source.config },
      sourceProduct: { id: sourceProduct.id, sourceId: source.id, sourceKey: sourceProduct.sourceKey,
        externalId: sourceProduct.externalId, metadata: sourceProduct.discoveryMetadata },
      target: { id: target.id, code: target.code, config: target.config }, product: internal.data,
      existingExternalId: payload.externalId,
      ...(onSubmitted === undefined ? {} : { onSubmitted: (receipt) => onSubmitted({ receipt,
        exportedHash: imageHash, exportFingerprint: imageHash }) }),
    });
    // A media update must not mark the full product payload as synchronized.
    return { status: "completed" };
  }

  async fail(payload: ProductImageJobPayload, error: string): Promise<void> {
    await this.checks.recordCheck(payload.sourceProductId, "failed", error);
  }
}
