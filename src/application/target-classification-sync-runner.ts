import { IntegrationContractError } from "../core/errors/index.js";
import type { TargetClassificationImportRepository } from "../repositories/index.js";
import type { WordPressClassificationAssignmentReader } from "../integrations/index.js";
import type { SyncTargetClassificationsPayload } from "./job-payloads.js";
import type { RunnerResult } from "./runner-result.js";

const importedTaxonomies = ["pa_brand", "pa_model", "product_cat"] as const;

export class TargetClassificationSyncRunner {
  constructor(
    private readonly repository: TargetClassificationImportRepository,
    private readonly reader: Pick<WordPressClassificationAssignmentReader, "readPage">,
    private readonly pageSize = 2000,
  ) {}

  async sync(payload: SyncTargetClassificationsPayload): Promise<RunnerResult> {
    const run = await this.repository.getRun(payload.runId);
    if (run === null) throw new IntegrationContractError(`Classification sync run does not exist: ${payload.runId}`);
    if (run.status === "completed" || run.status === "failed") return { status: "skipped" };
    if (run.cursor !== payload.cursor) return { status: "skipped" };
    const page = await this.reader.readPage({
      sourceCode: run.sourceCode,
      cursor: payload.cursor,
      limit: this.pageSize,
      taxonomies: importedTaxonomies,
    });
    await this.repository.savePage({
      runId: run.id,
      cursor: payload.cursor,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      items: page.items.map((item) => ({
        targetExternalId: item.targetExternalId,
        sourceExternalId: item.sourceExternalId,
        taxonomies: item.taxonomies,
      })),
    });
    return { status: "completed" };
  }

  fail(runId: string, error: string): Promise<void> {
    return this.repository.failRun(runId, error);
  }
}
