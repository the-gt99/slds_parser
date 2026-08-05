import type { EntityId } from "../contracts/index.js";
import type { ProductAdminReadModel, ProductListQuery, ProductListResult, ProductSnapshotListQuery, ProductSnapshotListResult } from "./types.js";

export interface ProductAdminRepository {
  getById(sourceProductId: EntityId): Promise<ProductAdminReadModel | null>;
  listProducts?(query: ProductListQuery): Promise<ProductListResult>;
  listSnapshots?(query: ProductSnapshotListQuery): Promise<ProductSnapshotListResult>;
}
