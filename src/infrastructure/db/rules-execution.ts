import { AsyncLocalStorage } from "node:async_hooks";
import type { UniversalProductDTO } from "../../contracts/index.js";
import type { ClassificationRepository, ReferenceRepository } from "../../repositories/index.js";
import { ProductClassifier } from "../../services/product-classifier.js";
import type { RulesOperationScope, SupplementalTargetAssignmentResolver } from "../../services/target-reference-mapping-service.js";
import { RulesV2Runtime } from "./rules-v2-runtime.js";
import type { SqlExecutor, SqlPool } from "./sql-executor.js";

interface ExecutionSnapshot {
  readonly mode: "v1" | "v2";
  readonly revision: string;
  readonly runtime?: RulesV2Runtime;
  readonly targetRevisions?: ReadonlyMap<string, string>;
}

/** One DB-selected engine and immutable rule snapshot for an entire business operation. */
export class RulesExecution implements RulesOperationScope {
  private readonly context = new AsyncLocalStorage<ExecutionSnapshot>();
  private cached?: ExecutionSnapshot;
  private loading: Promise<ExecutionSnapshot> | undefined;
  private readonly legacyClassifier: ProductClassifier;
  private readonly v2Classifier: ProductClassifier;
  readonly classifier: Pick<ProductClassifier, "classify" | "version">;

  constructor(private readonly pool: SqlPool & SqlExecutor, private readonly legacy: ClassificationRepository) {
    this.legacyClassifier = new ProductClassifier(legacy);
    const repository: ClassificationRepository = {
      listReferenceTypes: (types) => legacy.listReferenceTypes(types),
      saveProductResult: (input) => legacy.saveProductResult(input),
      findSourceDecisions: (source, inputs) => this.current().runtime!.classificationRepository(legacy).findSourceDecisions(source, inputs),
      getActiveRuleSetRevision: async () => this.current().revision,
      listAllActiveRules: (source) => this.current().runtime!.classificationRepository(legacy).listAllActiveRules(source),
      listActiveRules: (source, types) => this.current().runtime!.classificationRepository(legacy).listActiveRules(source, types),
    };
    this.v2Classifier = new ProductClassifier(repository);
    this.classifier = { version: "1.0.0", classify: (sourceId, product) => this.run(async () => {
      const snapshot = this.current();
      const result = await (snapshot.mode === "v1" ? this.legacyClassifier : this.v2Classifier).classify(sourceId, product);
      if (snapshot.mode === "v1") return result;
      return { ...result, product: { ...result.product, classification: { ...result.product.classification,
        execution: { mode: "v2" as const, revision: snapshot.revision } } } };
    }) };
  }

  private current(): ExecutionSnapshot {
    const current = this.context.getStore();
    if (current === undefined) throw new Error("Rules operation scope is missing");
    return current;
  }

  async state() {
    const state = (await this.pool.query<{ mode: "v1" | "v2"; revision: string; freeze_legacy: boolean }>(
      "SELECT mode, revision::TEXT, freeze_legacy FROM rules_execution_control WHERE singleton")).rows[0];
    if (state === undefined) throw new Error("Rules execution control is missing");
    return state;
  }

  async run<T>(callback: () => Promise<T>): Promise<T> {
    if (this.context.getStore() !== undefined) return callback();
    const snapshot = await this.load();
    return this.context.run(snapshot, callback);
  }

  private async load(): Promise<ExecutionSnapshot> {
    if (this.loading !== undefined) return this.loading;
    const pending = this.readSnapshot();
    this.loading = pending;
    try { return await pending; } finally { this.loading = undefined; }
  }

  private async readSnapshot(): Promise<ExecutionSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const state = (await client.query<{ mode: "v1" | "v2"; revision: string }>("SELECT mode, revision::TEXT FROM rules_execution_control WHERE singleton")).rows[0];
      if (state === undefined) throw new Error("Rules execution control is missing");
      let snapshot = this.cached;
      if (snapshot?.mode !== state.mode || snapshot.revision !== state.revision) {
        snapshot = state.mode === "v1" ? state : { ...state, runtime: RulesV2Runtime.frozen(this.pool, await new RulesV2Runtime(client, () => 0).snapshot()) };
      }
      if (state.mode === "v2") {
        const revisions = await client.query<{ target_id: string; revision: string }>("SELECT target_id::TEXT, revision::TEXT FROM target_export_revisions");
        snapshot = { ...snapshot, targetRevisions: new Map(revisions.rows.map((row) => [row.target_id, row.revision])) };
      }
      await client.query("COMMIT");
      this.cached = snapshot;
      return snapshot;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async prepareProduct(sourceId: string, product: UniversalProductDTO): Promise<UniversalProductDTO> {
    return this.run(async () => this.current().mode === "v1"
      ? (product.classification?.execution?.mode === "v2" ? (await this.legacyClassifier.classify(sourceId, product)).product : product)
      : (await this.classifier.classify(sourceId, product)).product);
  }

  references(legacy: ReferenceRepository): ReferenceRepository {
    const selected = () => this.current().runtime?.referenceRepository() ?? legacy;
    return {
      resolveTargetValue: (...args) => this.run(() => selected().resolveTargetValue(...args)),
      resolveTargetProjections: (...args) => this.run(() => selected().resolveTargetProjections(...args)),
      getTargetMappingRevision: (targetId) => this.run(async () => {
        if (this.current().mode === "v1") return legacy.getTargetMappingRevision(targetId);
        const revision = this.current().targetRevisions?.get(targetId);
        if (revision === undefined) throw new Error(`Target revision ${targetId} is missing`);
        return revision;
      }),
      listTargetAssignmentRules: (...args) => this.run(() => selected().listTargetAssignmentRules(...args)),
      saveTargetProjection: (...args) => this.run(() => selected().saveTargetProjection(...args)),
    };
  }

  supplemental(legacy: SupplementalTargetAssignmentResolver): SupplementalTargetAssignmentResolver {
    return { createTargetAssignmentResolver: (targetId) => this.run(() =>
      (this.current().runtime?.supplemental(legacy) ?? legacy).createTargetAssignmentResolver(targetId)) };
  }
}
