import type { ShihuoProductResolver } from "../shihuo/index.js";
import type { ResolveShihuoProductPayload } from "./job-payloads.js";
import type { RunnerResult } from "./runner-result.js";

export class ShihuoResolutionRunner {
  constructor(private readonly resolver: ShihuoProductResolver) {}
  async resolve(payload: ResolveShihuoProductPayload): Promise<RunnerResult> {
    await this.resolver.resolveSourceProduct(payload.sourceProductId);
    return { status: "completed" };
  }
}
