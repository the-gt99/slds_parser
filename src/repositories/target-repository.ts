import type { EntityId } from "../contracts/index.js";
import type {
  SaveExportFailureInput,
  SaveExportSuccessInput,
  SaveTargetProductSnapshotInput,
  TargetProductRecord,
  TargetProductSnapshotRecord,
  TargetRecord,
} from "./types.js";

export interface TargetRepository {
  getById(id: EntityId): Promise<TargetRecord | null>;
  listEnabled(): Promise<readonly TargetRecord[]>;
  findTargetProduct(targetId: EntityId, internalProductId: EntityId): Promise<TargetProductRecord | null>;
  findProductSnapshot(targetId: EntityId, sourceProductId: EntityId): Promise<TargetProductSnapshotRecord | null>;
  saveProductSnapshot(input: SaveTargetProductSnapshotInput): Promise<TargetProductSnapshotRecord>;
  saveExportSuccess(input: SaveExportSuccessInput): Promise<TargetProductRecord>;
  saveExportFailure(input: SaveExportFailureInput): Promise<TargetProductRecord>;
}
