export function buildCatalogQuery(filters, page, pageSize) {
  const query = new URLSearchParams({ limit: String(pageSize), offset: String((Math.max(1, page) - 1) * pageSize) });
  for (const [key, value] of Object.entries(filters)) if (String(value || "").trim()) query.set(key, String(value).trim());
  return query;
}

export function catalogPagination(total, requestedPage, pageSize) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const totalPages = Math.max(1, Math.ceil(safeTotal / pageSize));
  const page = Math.max(1, Math.min(totalPages, Number(requestedPage) || 1));
  return {
    page,
    totalPages,
    first: safeTotal === 0 ? 0 : (page - 1) * pageSize + 1,
    last: Math.min(page * pageSize, safeTotal),
  };
}

export function priceIsNewerThanSnapshot(snapshotFetchedAt, variationCheckedAt) {
  if (!snapshotFetchedAt || !variationCheckedAt) return false;
  const snapshot = new Date(snapshotFetchedAt).valueOf();
  const price = new Date(variationCheckedAt).valueOf();
  return Number.isFinite(snapshot) && Number.isFinite(price) && price > snapshot;
}
