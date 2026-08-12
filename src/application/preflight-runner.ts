import type { WordPressPreviewService } from "../services/index.js";
import type { PreflightProductPayload } from "./job-payloads.js";
import type { RunnerResult } from "./runner-result.js";

export class PreflightRunner {
  constructor(private readonly previews: Pick<WordPressPreviewService, "preview">) {}

  async preflightProduct(payload: PreflightProductPayload): Promise<RunnerResult> {
    await this.previews.preview(payload.sourceProductId, payload.targetId, [], {
      saveExportControl: true,
      refreshWordPress: payload.refreshWordPress !== false,
    });
    return { status: "completed" };
  }
}
