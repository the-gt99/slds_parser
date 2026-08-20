import { EntityNotFoundError, IntegrationContractError } from "../core/errors/index.js";
import type {
  ExportControlRepository,
  InternalProductRepository,
  SourceProductRepository,
  SourceRepository,
} from "../repositories/index.js";
import type { RefreshExportSourcePayload } from "./job-payloads.js";
import type { RunnerResult } from "./runner-result.js";
import type { ExportSourceRefresher } from "./export-source-refresher.js";

export class ExportSourceRefreshRunner {
  constructor(
    private readonly sources: SourceRepository,
    private readonly sourceProducts: SourceProductRepository,
    private readonly internalProducts: InternalProductRepository,
    private readonly repository: ExportControlRepository,
    private readonly refresher: ExportSourceRefresher,
  ) {}

  async refresh(payload: RefreshExportSourcePayload): Promise<RunnerResult> {
    const record = await this.repository.getCampaignSourceRefresh(payload.refreshId);
    if (record === null) throw new EntityNotFoundError("Export source refresh", payload.refreshId);
    if (record.status === "ready") return { status: "skipped" };
    if (record.status !== "pending") throw new IntegrationContractError("Export source refresh уже завершён с ошибкой");
    const internal = await this.internalProducts.getById(record.internalProductId);
    if (internal === null) throw new EntityNotFoundError("Internal product", record.internalProductId);
    if (internal.contentHash !== record.internalContentHash) {
      throw new IntegrationContractError("Товар изменился после постановки source refresh");
    }
    const sourceProduct = await this.sourceProducts.getById(record.sourceProductId);
    if (sourceProduct === null) throw new EntityNotFoundError("Source product", record.sourceProductId);
    const source = await this.sources.getById(sourceProduct.sourceId);
    if (source === null) throw new EntityNotFoundError("Source", sourceProduct.sourceId);
    const variants = await this.refresher.refresh(source, sourceProduct);
    await this.repository.saveCampaignSourceRefresh({ refreshId: record.id, variants });
    return { status: "completed" };
  }

  saveError(refreshId: string, error: string): Promise<void> {
    return this.repository.saveCampaignSourceRefreshError(refreshId, error);
  }
}
