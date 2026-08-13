export function buildCatalogQuery(filters: Record<string, unknown>, page: number, pageSize: number): URLSearchParams;
export function catalogPagination(total: number, requestedPage: number, pageSize: number): {
  page: number;
  totalPages: number;
  first: number;
  last: number;
};
export function priceIsNewerThanSnapshot(snapshotFetchedAt?: string | null, variationCheckedAt?: string | null): boolean;
