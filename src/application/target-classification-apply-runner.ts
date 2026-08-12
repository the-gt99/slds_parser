import type { TargetClassificationImportService } from "../services/index.js";
import type { ApplyTargetClassificationSuggestionPayload } from "./job-payloads.js";
import type { RunnerResult } from "./runner-result.js";

export class TargetClassificationApplyRunner {
  constructor(private readonly service: TargetClassificationImportService) {}

  async apply(payload: ApplyTargetClassificationSuggestionPayload): Promise<RunnerResult> {
    const result = await this.service.applyQueued({
      runId: payload.runId,
      suggestionId: payload.suggestionId,
    }, payload.actor);
    return { status: result.status };
  }

  fail(payload: ApplyTargetClassificationSuggestionPayload, error: string): Promise<void> {
    return this.service.releaseQueued(payload.suggestionId, error);
  }
}
