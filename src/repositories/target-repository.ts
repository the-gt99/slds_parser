import type { EntityId } from "../contracts/index.js";
import type {
  SaveExportFailureInput,
  SaveExportSuccessInput,
  TargetProductRecord,
  TargetRecord,
} from "./types.js";

export interface TargetRepository {
  getById(id: EntityId): Promise<TargetRecord | null>;
  listEnabled(): Promise<readonly TargetRecord[]>;
  findTargetProduct(targetId: EntityId, internalProductId: EntityId): Promise<TargetProductRecord | null>;
  saveExportSuccess(input: SaveExportSuccessInput): Promise<TargetProductRecord>;
  saveExportFailure(input: SaveExportFailureInput): Promise<TargetProductRecord>;
}
