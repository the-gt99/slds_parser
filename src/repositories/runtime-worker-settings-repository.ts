export interface WorkerConcurrencySettings {
  readonly collectionConcurrency: number;
  readonly processConcurrency: number;
  readonly preflightConcurrency: number;
}

export interface AppliedWorkerConcurrencySettings extends WorkerConcurrencySettings {
  readonly revision: string;
  readonly workerId: string;
  readonly appliedAt: string;
}

export interface RuntimeWorkerSettingsRecord extends WorkerConcurrencySettings {
  readonly revision: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
  readonly applied: AppliedWorkerConcurrencySettings | null;
}

export interface RuntimeWorkerSettingsRepository {
  getOrCreate(defaults: WorkerConcurrencySettings): Promise<RuntimeWorkerSettingsRecord>;
  save(settings: WorkerConcurrencySettings, actor: string): Promise<RuntimeWorkerSettingsRecord>;
  loadAndMarkApplied(defaults: WorkerConcurrencySettings, workerId: string): Promise<RuntimeWorkerSettingsRecord>;
}
