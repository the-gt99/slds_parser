import type { JobRepository, SourceRepository } from "../repositories/index.js";

/** Collect only products first discovered in this pass; active jobs share one key. */
export async function enqueueScheduledGoatDiscovery(repositories: {
  readonly sources: SourceRepository; readonly jobs: JobRepository;
}) {
  const source = (await repositories.sources.listEnabled()).find((item) => item.code === "goat");
  if (source === undefined) throw new Error("Enabled GOAT source is required for scheduled discovery");
  return repositories.jobs.enqueue({ jobType: "discover_source",
    payload: { sourceId: source.id, runType: "full", coverage: "catalog", enqueueCollection: false, enqueueNewCollection: true },
    uniqueKey: `source:${source.id}:scheduled-discovery` });
}
