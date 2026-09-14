import type { JsonValue } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import { hashStableJson } from "../core/utils/index.js";
import type { WordPressCatalogRepository } from "../repositories/index.js";
import type { WordPressCatalogClient } from "../integrations/wordpress/index.js";
import type { SyncWordPressCatalogPayload } from "./job-payloads.js";
import type { RunnerResult } from "./runner-result.js";

export class WordPressCatalogSyncRunner {
  constructor(
    private readonly repository: WordPressCatalogRepository,
    private readonly client: WordPressCatalogClient,
    private readonly pageSize = 500,
  ) {}

  async sync(payload: SyncWordPressCatalogPayload): Promise<RunnerResult> {
    const run = await this.repository.getRun(payload.runId);
    if (run === null) throw new IntegrationContractError(`WordPress catalog run not found: ${payload.runId}`);
    if (payload.mode === "inventory") {
      if (!run.catalogComplete) throw new IntegrationContractError("Inventory reconciliation requires a complete catalog");
      const candidates = await this.repository.listInventoryCandidates(payload.runId, payload.cursor, 100);
      const snapshots = await Promise.all(candidates.map((item) => this.client.readProduct(item.wordpressProductId)));
      const items = candidates.map((candidate, index) => {
        const item = snapshots[index];
        if (item === null || item === undefined) throw new IntegrationContractError(`WordPress inventory product not found: ${candidate.wordpressProductId}`);
        const canonical = item.identity.source_code === candidate.sourceCode
          && String(item.identity.source_external_id ?? "") === candidate.sourceExternalId;
        const legacy = candidate.sourceCode === "goat" && String(item.identity.legacy_goat_id ?? "") === candidate.sourceExternalId
          && !item.identity.source_external_id;
        if (!canonical && !legacy) throw new IntegrationContractError(`WordPress inventory identity mismatch: ${candidate.wordpressProductId}`);
        return { wordpressProductId: item.targetId, identity: item.identity, snapshot: item.snapshot,
          contentHash: hashStableJson(item.snapshot as JsonValue) };
      });
      await this.repository.savePage({ runId: payload.runId, inventoryOnly: true,
        expectedCursor: run.catalogCursor, nextCursor: run.catalogCursor, hasMore: false,
        fetchedAt: new Date().toISOString(), items });
      if (candidates.length === 100) await this.repository.enqueueInventoryReconciliation(payload.runId, candidates.at(-1)!.id);
      return { status: "completed" };
    }
    if (run.status !== "running") return { status: "skipped" };
    if (run.catalogCursor !== payload.cursor) {
      if (BigInt(run.catalogCursor) > BigInt(payload.cursor)) return { status: "skipped" };
      throw new IntegrationContractError(`WordPress catalog run cursor is behind job cursor: ${run.catalogCursor}/${payload.cursor}`);
    }

    const page = await this.client.readPage(payload.cursor, this.pageSize);
    let previous = BigInt(payload.cursor);
    const ids = new Set<string>();
    for (const item of page.items) {
      const current = BigInt(item.targetId);
      if (current <= previous || ids.has(item.targetId)) {
        throw new IntegrationContractError(`WordPress catalog page is not strictly ordered after cursor ${payload.cursor}`);
      }
      previous = current;
      ids.add(item.targetId);
    }
    if (page.items.length > 0 && page.nextCursor !== page.items.at(-1)!.targetId) {
      throw new IntegrationContractError("WordPress catalog next cursor does not match the final product ID");
    }
    if (page.items.length === 0 && page.nextCursor !== payload.cursor) {
      throw new IntegrationContractError("Empty WordPress catalog page advanced its cursor");
    }

    const fetchedAt = new Date().toISOString();
    await this.repository.savePage({
      runId: payload.runId,
      expectedCursor: payload.cursor,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      fetchedAt,
      items: page.items.map((item) => ({
        wordpressProductId: item.targetId,
        identity: item.identity,
        snapshot: item.snapshot,
        contentHash: hashStableJson(item.snapshot as JsonValue),
      })),
    });
    return { status: "completed" };
  }

  async fail(runId: string, error: string): Promise<void> {
    await this.repository.failRun(runId, error);
  }
}
