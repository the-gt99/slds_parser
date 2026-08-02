import type { EntityId } from "../contracts/index.js";
import type { ProductAdminReadModel } from "./types.js";

export interface ProductAdminRepository {
  getById(sourceProductId: EntityId): Promise<ProductAdminReadModel | null>;
}
