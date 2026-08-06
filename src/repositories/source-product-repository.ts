import type { EntityId } from "../contracts/index.js";
import type {
  SourceProductCollectionCandidate,
  SourceProductCollectionCandidateQuery,
  SourceProductPartRecord,
  SourceProductRecord,
  UpdateSourceProductIdentityInput,
  UpsertDiscoveredSourceProductInput,
  UpsertSourceProductPartInput,
  UpsertSourceProductPartResult,
} from "./types.js";

export interface SourceProductRepository {
  getById(id: EntityId): Promise<SourceProductRecord | null>;
  listCollectionCandidates(input: SourceProductCollectionCandidateQuery): Promise<readonly SourceProductCollectionCandidate[]>;
  listParts(sourceProductId: EntityId): Promise<readonly SourceProductPartRecord[]>;
  upsertDiscovered(input: UpsertDiscoveredSourceProductInput): Promise<SourceProductRecord>;
  updateIdentity(id: EntityId, input: UpdateSourceProductIdentityInput): Promise<SourceProductRecord>;
  upsertPart(input: UpsertSourceProductPartInput): Promise<UpsertSourceProductPartResult>;
}
