import { AsyncLocalStorage } from "node:async_hooks";
import type { DirectTargetDecisionDTO, ProductRulesV2DTO, SourceDTO, SourceProductDTO, TargetAssignmentDTO, UniversalProductDTO } from "../../contracts/index.js";
import { hashStableJson } from "../../core/utils/index.js";
import type { ClassificationRepository, ReferenceRepository } from "../../repositories/index.js";
import { ProductClassifier } from "../../services/product-classifier.js";
import { DirectRulesV2Assignments } from "../../services/rules-v2-direct-assignments.js";
import { DirectRulesV2Selector } from "../../services/rules-v2-direct-selector.js";
import { prepareReferenceCandidates, validateReferenceCandidates } from "../../services/reference-candidate-validation.js";
import type { RulesV2ProductSource, RulesV2Snapshot } from "../../services/rules-v2-snapshot.js";
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
  private readonly directTargets = new WeakMap<RulesV2Snapshot, Map<string, DirectRulesV2Assignments>>();
  private readonly directSelectors = new WeakMap<RulesV2Snapshot, DirectRulesV2Selector>();
  private readonly directSupplemental = new WeakMap<RulesV2Snapshot, Map<string, (product: UniversalProductDTO,
    resolvedSourceBrand?: boolean) => readonly TargetAssignmentDTO[] | Promise<readonly TargetAssignmentDTO[]>>>();
  readonly classifier: Pick<ProductClassifier, "classify" | "version">;

  constructor(private readonly pool: SqlPool & SqlExecutor, private readonly legacy: ClassificationRepository,
    private readonly titleBrandAssignments?: SupplementalTargetAssignmentResolver) {
    this.legacyClassifier = new ProductClassifier(legacy);
    const repository: ClassificationRepository = {
      listReferenceTypes: (types) => this.current().runtime!.classificationRepository(legacy).listReferenceTypes(types),
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
    return this.run(async () => {
      if (this.current().mode === "v1") {
        if (product.rulesV2 === undefined && product.classification?.execution?.mode !== "v2") return product;
        const { rulesV2: _rulesV2, ...legacyProduct } = product;
        return (await this.legacyClassifier.classify(sourceId, legacyProduct)).product;
      }
      const { classification: _classification, ...unclassified } = product;
      return unclassified;
    });
  }

  async decideProduct(source: SourceDTO, sourceProduct: SourceProductDTO,
    product: UniversalProductDTO): Promise<(UniversalProductDTO & { readonly rulesV2: ProductRulesV2DTO }) | null> {
    return this.run(async () => {
      if (this.current().mode !== "v2") return null;
      const snapshot = await this.current().runtime!.snapshot();
      const prepared = prepareReferenceCandidates(product.referenceCandidates);
      validateReferenceCandidates(prepared, snapshot.listReferenceTypes([...new Set(prepared.map((item) => item.candidate.typeCode))]));
      let selector = this.directSelectors.get(snapshot);
      if (selector === undefined) {
        selector = new DirectRulesV2Selector(snapshot.records);
        this.directSelectors.set(snapshot, selector);
      }
      const selections = selector.select(this.directSource(source, sourceProduct), product);
      const rulesV2: ProductRulesV2DTO = {
        revision: snapshot.revision,
        fingerprint: hashStableJson({ revision: snapshot.revision,
          selections: selections.map((selection) => ({ candidateKey: selection.candidateKey,
            status: selection.status, sourceRuleId: selection.sourceRuleId })) }),
        status: selections.every((selection) => selection.status === "resolved" || selection.status === "ignored")
          ? "complete" : "partial",
        selections,
      };
      const { classification: _classification, rulesV2: _previous, ...unclassified } = product;
      return { ...unclassified, rulesV2 };
    });
  }

  private directSource(source: SourceDTO, sourceProduct: SourceProductDTO): RulesV2ProductSource {
    return { id: source.id, code: source.code, productId: sourceProduct.id,
      sourceKey: sourceProduct.sourceKey, externalId: sourceProduct.externalId ?? null };
  }

  private async directEngine(targetId: string): Promise<{ snapshot: RulesV2Snapshot; engine: DirectRulesV2Assignments }> {
    const snapshot = await this.current().runtime!.snapshot();
    const targets = this.directTargets.get(snapshot) ?? new Map<string, DirectRulesV2Assignments>();
    this.directTargets.set(snapshot, targets);
    let engine = targets.get(targetId);
    if (engine === undefined) {
      engine = new DirectRulesV2Assignments(snapshot.records, targetId);
      targets.set(targetId, engine);
    }
    return { snapshot, engine };
  }

  async resolveDirectTarget(targetId: string, source: SourceDTO, sourceProduct: SourceProductDTO,
    product: UniversalProductDTO): Promise<DirectTargetDecisionDTO | null> {
    return this.run(async () => this.current().mode === "v2"
      ? (await this.directEngine(targetId)).engine.resolveTerms(product, this.directSource(source, sourceProduct)) : null);
  }

  async resolveDirectAssignments(targetId: string, source: SourceDTO, sourceProduct: SourceProductDTO,
    product: UniversalProductDTO): Promise<readonly TargetAssignmentDTO[] | null> {
    return this.run(async () => {
      if (this.current().mode !== "v2") return null;
      const { snapshot, engine } = await this.directEngine(targetId);
      const directSource = this.directSource(source, sourceProduct);
      const assignments = engine.resolve(product, directSource);
      if (this.titleBrandAssignments === undefined) return assignments;
      const resolvers = this.directSupplemental.get(snapshot) ?? new Map();
      this.directSupplemental.set(snapshot, resolvers);
      let resolve = resolvers.get(targetId);
      if (resolve === undefined) {
        resolve = await this.titleBrandAssignments.createTargetAssignmentResolver(targetId);
        resolvers.set(targetId, resolve);
      }
      const brandKeys = new Set(product.referenceCandidates.filter((candidate) => candidate.typeCode === "brand")
        .map((candidate) => candidate.key));
      const sourceBrandResolved = engine.resolveTerms(product, directSource).selections.some((selection) =>
        selection.status === "resolved" && brandKeys.has(selection.candidateKey));
      return [...new Map([...(await resolve(product, sourceBrandResolved)), ...assignments].map((assignment) =>
        [`${assignment.targetScope}\u0000${assignment.externalValue}\u0000${assignment.mode}`, assignment])).values()];
    });
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
