import { EntityNotFoundError, IntegrationContractError } from "../core/errors/index.js";
import type {
  SourceRepository,
  TargetRepository,
  WordPressCatalogMatchStatus,
  WordPressCatalogRepository,
} from "../repositories/index.js";

export class WordPressCatalogService {
  constructor(
    private readonly repository: WordPressCatalogRepository,
    private readonly sources: SourceRepository,
    private readonly targets: TargetRepository,
  ) {}

  async createRun(input: {
    readonly targetId: string;
    readonly sourceCode: string;
    readonly auditRequested: boolean;
    readonly variationSyncRequested: boolean;
    readonly actor: string;
    readonly reason?: string;
  }) {
    const target = await this.targets.getById(input.targetId);
    if (target === null) throw new EntityNotFoundError("target", input.targetId);
    const sourceCode = input.sourceCode.trim().toLocaleLowerCase("en-US");
    const source = (await this.sources.listEnabled()).find((item) => item.code.toLocaleLowerCase("en-US") === sourceCode);
    if (source === undefined) throw new IntegrationContractError(`Enabled source not found: ${sourceCode}`);
    return this.repository.createRun({ ...input, sourceCode });
  }

  async listRuns(targetId: string, limit = 20) {
    return this.repository.listRuns(targetId, Math.max(1, Math.min(100, limit)));
  }

  async getRun(runId: string) {
    const run = await this.repository.getRun(runId);
    if (run === null) throw new EntityNotFoundError("wordpress catalog run", runId);
    return run;
  }

  async listItems(input: {
    readonly runId: string;
    readonly matchStatus?: WordPressCatalogMatchStatus;
    readonly limit: number;
    readonly offset: number;
  }) {
    await this.getRun(input.runId);
    return this.repository.listItems({
      ...input,
      limit: Math.max(1, Math.min(200, input.limit)),
      offset: Math.max(0, input.offset),
    });
  }
}
