import type { EntityId } from "../../src/contracts/index.js";
import type { ClassificationMappingMatchRecord, ClassificationRuleRecord, CompleteSourceRunInput, CreateSourceRunInput, EnqueueJobInput, FailSourceRunInput, InternalProductRecord, JobRecord, JobRepository, ProductClassificationObservationInput, RecordSourceRunPageInput, ReferenceRepository, RetryJobInput, SaveExportFailureInput, SaveExportSuccessInput, SourceProductPartRecord, SourceProductRecord, SourceRecord, SourceRunRecord, TargetContentTemplateRecord, TargetProductRecord, TargetProductSnapshotRecord, TargetRecord, TargetValueMappingRecord, TransactionRepositories, UnitOfWork, UpdateSourceProductIdentityInput, UpsertDiscoveredSourceProductInput, UpsertInternalProductInput, UpsertSourceProductPartInput, UpsertSourceProductPartResult } from "../../src/repositories/index.js";

const timestamp = "2026-01-01T00:00:00.000Z";

export class MemoryStore {
  readonly sources = new Map<string, SourceRecord>();
  readonly runs = new Map<string, SourceRunRecord>();
  readonly products = new Map<string, SourceProductRecord>();
  readonly parts = new Map<string, SourceProductPartRecord>();
  readonly internals = new Map<string, InternalProductRecord>();
  readonly targets = new Map<string, TargetRecord>();
  readonly targetProducts = new Map<string, TargetProductRecord>();
  readonly targetSnapshots = new Map<string, TargetProductSnapshotRecord>();
  readonly contentTemplates = new Map<string, TargetContentTemplateRecord>();
  readonly jobs = new Map<string, JobRecord>();
  readonly classificationTypes = new Set(["brand", "category", "merchandising_category", "gender", "condition", "box_condition", "size_system", "size", "color", "model", "product_family", "tag", "material", "season", "shoe_height", "activity"]);
  readonly classificationDecisions = new Map<string, Omit<ClassificationMappingMatchRecord, "candidateKey">>();
  readonly classificationRules: ClassificationRuleRecord[] = [];
  readonly classificationObservations = new Map<string, ProductClassificationObservationInput>();
  mappingRevision = "revision-1";
  transactionCount = 0;
  #ids = 0;
  id(): string { return String(++this.#ids); }
}

export function sourceRecord(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return { id: "1", code: "fake", name: "Fake", adapterCode: "fake-adapter", config: {}, enabled: true, createdAt: timestamp, updatedAt: timestamp, ...overrides };
}
export function targetRecord(overrides: Partial<TargetRecord> = {}): TargetRecord {
  return { id: "10", code: "fake-target", name: "Target", exporterCode: "fake-exporter", config: {}, enabled: true, createdAt: timestamp, updatedAt: timestamp, ...overrides };
}

export function createMemoryRepositories(store: MemoryStore): TransactionRepositories {
  return {
    classifications: {
      listReferenceTypes: async (typeCodes) => typeCodes.filter((typeCode) => store.classificationTypes.has(typeCode)).map((code) => ({
        code,
        cardinality: ["category", "merchandising_category", "tag", "material", "activity"].includes(code) ? "multiple" as const : "single" as const,
        allowedSubjectKinds: ["size", "condition", "box_condition"].includes(code) ? ["variant"] as const : ["product"] as const,
        metadata: {},
      })),
      findSourceDecisions: async (sourceId, inputs) => inputs.flatMap((input) => {
        const decision = store.classificationDecisions.get(`${sourceId}/${input.typeCode}/${input.scope}/${input.normalizedSourceValue}/${input.contextKey}`);
        return decision === undefined ? [] : [{ candidateKey: input.candidateKey, ...decision }];
      }),
      listActiveRules: async (sourceId, typeCodes) => store.classificationRules.filter((rule) => rule.sourceId === sourceId && typeCodes.includes(rule.typeCode)),
      saveProductResult: async (input) => {
        for (const key of [...store.classificationObservations.keys()]) if (key.startsWith(`${input.sourceProductId}/`)) store.classificationObservations.delete(key);
        for (const observation of input.observations) store.classificationObservations.set(`${input.sourceProductId}/${observation.candidate.key}`, observation);
      },
    },
    sources: {
      getById: async (id) => store.sources.get(id) ?? null,
      listEnabled: async () => [...store.sources.values()].filter((item) => item.enabled),
      upsertDefinition: async (input) => { const old = [...store.sources.values()].find((item) => item.code === input.code); const record: SourceRecord = { id: old?.id ?? store.id(), code: input.code, name: input.name, adapterCode: input.adapterCode, config: input.config, enabled: input.enabled, createdAt: old?.createdAt ?? timestamp, updatedAt: timestamp }; store.sources.set(record.id, record); return record; },
    },
    sourceRuns: {
      findActiveBySource: async (sourceId) => [...store.runs.values()].find((run) => run.sourceId === sourceId && run.status === "running") ?? null,
      create: async (input: CreateSourceRunInput) => { const id = store.id(); const run: SourceRunRecord = { id, ...input, status: "running", completeness: "unknown", processedCount: "0", discoveredCount: "0", errorCount: "0", startedAt: timestamp, finishedAt: null, lastError: null }; store.runs.set(id, run); return run; },
      recordPage: async (id: EntityId, input: RecordSourceRunPageInput) => { const old = store.runs.get(id)!; const run: SourceRunRecord = { ...old, checkpoint: input.checkpoint, processedCount: String(Number(old.processedCount) + Number(input.processedCount)), discoveredCount: String(Number(old.discoveredCount) + Number(input.discoveredCount)), errorCount: String(Number(old.errorCount) + Number(input.errorCount)), completeness: input.completeness }; store.runs.set(id, run); return run; },
      complete: async (id: EntityId, input: CompleteSourceRunInput) => { const run: SourceRunRecord = { ...store.runs.get(id)!, ...input, status: "completed", lastError: null }; store.runs.set(id, run); return run; },
      fail: async (id: EntityId, input: FailSourceRunInput) => { const run: SourceRunRecord = { ...store.runs.get(id)!, checkpoint: input.checkpoint, status: "failed", finishedAt: input.finishedAt, lastError: input.error }; store.runs.set(id, run); return run; },
    },
    sourceProducts: {
      getById: async (id) => store.products.get(id) ?? null,
      listCollectionCandidates: async (input) => {
        const active = new Set([...store.jobs.values()].flatMap((job) => job.jobType === "collect_product"
          && ["pending", "running", "retry"].includes(job.status)
          && typeof job.payload === "object" && job.payload !== null && !Array.isArray(job.payload)
          ? [String((job.payload as { readonly sourceProductId?: unknown }).sourceProductId ?? "")] : []));
        const available = [...store.products.values()].filter((product) => product.sourceId === input.sourceId
          && ![...store.parts.values()].some((part) => part.sourceProductId === product.id)
          && !active.has(product.id));
        const selected = input.sourceProductIds === undefined
          ? (input.routes ?? []).flatMap((route, index, routes) => available
              .filter((product) => product.discoveryMetadata.route === route)
              .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey))
              .slice(0, Math.floor(input.limit / routes.length) + (index < input.limit % routes.length ? 1 : 0)))
          : input.sourceProductIds.flatMap((id) => {
              const product = available.find((item) => item.id === id);
              return product === undefined ? [] : [product];
            });
        return selected.slice(0, input.limit).map((product) => ({
          id: product.id,
          sourceKey: product.sourceKey,
          route: typeof product.discoveryMetadata.route === "string" ? product.discoveryMetadata.route : "",
        }));
      },
      listParts: async (id) => [...store.parts.values()].filter((part) => part.sourceProductId === id).sort((a, b) => a.partKey.localeCompare(b.partKey)),
      upsertDiscovered: async (input: UpsertDiscoveredSourceProductInput) => { const previous = [...store.products.values()].find((item) => item.sourceId === input.sourceId && item.sourceKey === input.sourceKey); const id = previous?.id ?? store.id(); const record: SourceProductRecord = { id, sourceId: input.sourceId, sourceKey: input.sourceKey, externalId: input.externalId ?? previous?.externalId ?? null, slug: input.slug ?? previous?.slug ?? null, url: input.url ?? previous?.url ?? null, discoveryMetadata: input.discoveryMetadata, status: input.status, firstSeenAt: previous?.firstSeenAt ?? input.seenAt, lastSeenAt: input.seenAt, lastSeenRunId: input.runId, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp }; store.products.set(id, record); return record; },
      updateIdentity: async (id: EntityId, input: UpdateSourceProductIdentityInput) => { const old = store.products.get(id)!; const record = { ...old, ...(input.externalId === undefined ? {} : { externalId: input.externalId }), ...(input.slug === undefined ? {} : { slug: input.slug }), ...(input.url === undefined ? {} : { url: input.url }) }; store.products.set(id, record); return record; },
      upsertPart: async (input: UpsertSourceProductPartInput): Promise<UpsertSourceProductPartResult> => { const key = `${input.sourceProductId}/${input.partKey}`; const old = store.parts.get(key); const part: SourceProductPartRecord = { id: old?.id ?? store.id(), sourceProductId: input.sourceProductId, partKey: input.partKey, rawPayload: input.rawPayload, parsedPayload: input.parsedPayload, contentHash: input.contentHash, sourceUpdatedAt: input.sourceUpdatedAt ?? null, fetchedAt: input.fetchedAt, adapterVersion: input.adapterVersion, createdAt: old?.createdAt ?? timestamp, updatedAt: timestamp }; store.parts.set(key, part); return { part, changed: old?.contentHash !== input.contentHash }; },
    },
    internalProducts: {
      getById: async (id) => store.internals.get(id) ?? null,
      findBySourceProductId: async (id) => [...store.internals.values()].find((item) => item.sourceProductId === id) ?? null,
      upsert: async (input: UpsertInternalProductInput) => { const old = [...store.internals.values()].find((item) => item.sourceProductId === input.sourceProductId); const record: InternalProductRecord = { id: old?.id ?? store.id(), ...input, processedAt: input.processedAt ?? null, lastError: input.lastError ?? null, createdAt: old?.createdAt ?? timestamp, updatedAt: timestamp }; store.internals.set(record.id, record); return record; },
    },
    references: {
      resolveTargetValue: async (_targetId: string, _referenceValueId: string, _scope: string): Promise<TargetValueMappingRecord | null> => null,
      resolveTargetProjections: async () => [],
      saveTargetProjection: async () => { throw new Error("Not implemented by in-memory tests"); },
      getTargetMappingRevision: async () => store.mappingRevision,
      listTargetAssignmentRules: async () => [],
    } satisfies ReferenceRepository,
    targets: {
      getById: async (id) => store.targets.get(id) ?? null,
      listEnabled: async () => [...store.targets.values()].filter((item) => item.enabled),
      findTargetProduct: async (targetId, internalId) => store.targetProducts.get(`${targetId}/${internalId}`) ?? null,
      findProductSnapshot: async (targetId, sourceProductId) => store.targetSnapshots.get(`${targetId}/${sourceProductId}`) ?? null,
      saveProductSnapshot: async (input) => {
        const key = `${input.targetId}/${input.sourceProductId}`;
        const old = store.targetSnapshots.get(key);
        const record: TargetProductSnapshotRecord = { id: old?.id ?? store.id(), ...input, createdAt: old?.createdAt ?? timestamp, updatedAt: timestamp };
        store.targetSnapshots.set(key, record);
        return record;
      },
      saveExportSuccess: async (input: SaveExportSuccessInput) => { const key = `${input.targetId}/${input.internalProductId}`; const old = store.targetProducts.get(key); const record: TargetProductRecord = { id: old?.id ?? store.id(), targetId: input.targetId, internalProductId: input.internalProductId, externalId: input.externalId, status: input.status, lastExportedHash: input.exportedHash, lastExportFingerprint: input.exportFingerprint, lastAttemptAt: input.attemptedAt, syncedAt: input.syncedAt, lastError: null, createdAt: old?.createdAt ?? timestamp, updatedAt: timestamp }; store.targetProducts.set(key, record); return record; },
      saveExportFailure: async (input: SaveExportFailureInput) => { const key = `${input.targetId}/${input.internalProductId}`; const old = store.targetProducts.get(key); const record: TargetProductRecord = { id: old?.id ?? store.id(), targetId: input.targetId, internalProductId: input.internalProductId, externalId: old?.externalId ?? null, status: input.status, lastExportedHash: old?.lastExportedHash ?? null, lastExportFingerprint: old?.lastExportFingerprint ?? null, lastAttemptAt: input.attemptedAt, syncedAt: old?.syncedAt ?? null, lastError: input.error, createdAt: old?.createdAt ?? timestamp, updatedAt: timestamp }; store.targetProducts.set(key, record); return record; },
    },
    contentTemplates: {
      list: async (targetId, field) => [...store.contentTemplates.values()]
        .filter((item) => item.targetId === targetId && (field === undefined || item.field === field))
        .sort((left, right) => right.revision - left.revision),
      listActive: async (targetId) => [...store.contentTemplates.values()]
        .filter((item) => item.targetId === targetId && item.status === "active"),
      getById: async (id) => store.contentTemplates.get(id) ?? null,
      createDraft: async (input) => {
        const revision = Math.max(0, ...[...store.contentTemplates.values()]
          .filter((item) => item.targetId === input.targetId && item.field === input.field)
          .map((item) => item.revision)) + 1;
        const record: TargetContentTemplateRecord = { id: store.id(), ...input, status: "draft", revision, createdAt: timestamp, activatedAt: null };
        store.contentTemplates.set(record.id, record);
        return record;
      },
      activate: async (id, targetId, actor) => {
        const selected = store.contentTemplates.get(id);
        if (selected === undefined || selected.targetId !== targetId) throw new Error(`Template not found: ${id}`);
        for (const [key, item] of store.contentTemplates) {
          if (item.targetId === targetId && item.field === selected.field && item.status === "active") {
            store.contentTemplates.set(key, { ...item, status: "archived" });
          }
        }
        const active: TargetContentTemplateRecord = { ...selected, status: "active", actor, activatedAt: timestamp };
        store.contentTemplates.set(id, active);
        return active;
      },
    },
    jobs: new MemoryJobRepository(store),
    productOperationHistory: {
      startAttempt: async () => {},
      completeAttempt: async () => {},
      failAttempt: async () => {},
      start: async () => store.id(),
      complete: async () => {},
      fail: async () => {},
    },
  };
}

export class MemoryJobRepository implements JobRepository {
  constructor(private readonly store: MemoryStore) {}
  async enqueue(input: EnqueueJobInput): Promise<JobRecord> { const active = [...this.store.jobs.values()].find((j) => j.jobType === input.jobType && j.uniqueKey === input.uniqueKey && ["pending", "running", "retry"].includes(j.status)); if (active) return active; const id = this.store.id(); const job: JobRecord = { id, jobType: input.jobType, payload: input.payload, status: "pending", attempts: 0, availableAt: input.availableAt ?? timestamp, lockedAt: null, lockedBy: null, uniqueKey: input.uniqueKey, lastError: null, createdAt: timestamp, updatedAt: timestamp, finishedAt: null }; this.store.jobs.set(id, job); return job; }
  async enqueueMany(inputs: readonly EnqueueJobInput[]): Promise<readonly JobRecord[]> { return Promise.all(inputs.map((input) => this.enqueue(input))); }
  async claimNext(workerId: string, _lockTimeoutMs: number, jobTypes?: readonly JobRecord["jobType"][]): Promise<JobRecord | null> { const job = [...this.store.jobs.values()].find((j) => ["pending", "retry"].includes(j.status) && (jobTypes === undefined || jobTypes.includes(j.jobType))); if (!job) return null; const claimed: JobRecord = { ...job, status: "running", attempts: job.attempts + 1, lockedAt: timestamp, lockedBy: workerId }; this.store.jobs.set(job.id, claimed); return claimed; }
  async claimById(id: EntityId, workerId: string, jobTypes: readonly JobRecord["jobType"][]): Promise<JobRecord | null> { const job = this.store.jobs.get(id); if (!job || !["pending", "retry"].includes(job.status) || !jobTypes.includes(job.jobType)) return null; const claimed: JobRecord = { ...job, status: "running", attempts: job.attempts + 1, lockedAt: timestamp, lockedBy: workerId }; this.store.jobs.set(job.id, claimed); return claimed; }
  async complete(id: EntityId): Promise<void> { this.store.jobs.set(id, { ...this.store.jobs.get(id)!, status: "completed", lockedAt: null, lockedBy: null, finishedAt: timestamp }); }
  async retry(id: EntityId, input: RetryJobInput): Promise<void> { this.store.jobs.set(id, { ...this.store.jobs.get(id)!, status: "retry", availableAt: input.availableAt, lastError: input.error, lockedAt: null, lockedBy: null }); }
  async fail(id: EntityId, error: string): Promise<void> { this.store.jobs.set(id, { ...this.store.jobs.get(id)!, status: "failed", lastError: error, lockedAt: null, lockedBy: null, finishedAt: timestamp }); }
}

export class MemoryUnitOfWork implements UnitOfWork {
  constructor(private readonly store: MemoryStore, private readonly repositories: TransactionRepositories) {}
  async transaction<Result>(callback: (repositories: TransactionRepositories) => Promise<Result>): Promise<Result> { this.store.transactionCount++; return callback(this.repositories); }
}

export function seedProduct(store: MemoryStore, overrides: Partial<SourceProductRecord> = {}): SourceProductRecord {
  const record: SourceProductRecord = { id: "2", sourceId: "1", sourceKey: "product-1", externalId: null, slug: null, url: null, discoveryMetadata: {}, status: "discovered", firstSeenAt: timestamp, lastSeenAt: timestamp, lastSeenRunId: null, createdAt: timestamp, updatedAt: timestamp, ...overrides }; store.products.set(record.id, record); return record;
}

export const validProduct = (sourceProductId = "2") => ({ sourceProductId, title: "Product", description: "Description", sku: "SKU", images: [], variants: [], referenceCandidates: [], attributes: {}, metadata: {} });
