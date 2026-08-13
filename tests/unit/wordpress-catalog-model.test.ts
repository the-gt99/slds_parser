import { describe, expect, it } from "vitest";

import { buildCatalogQuery, catalogPagination, priceIsNewerThanSnapshot } from "../../public/wordpress-catalog-model.js";

describe("wordpress catalog frontend model", () => {
  it("builds a stable server-side filter and pagination query", () => {
    const query = buildCatalogQuery({ search: " Nike ", audit: "ready", risk: "", change: "taxonomy:pa_brand" }, 3, 40);
    expect(Object.fromEntries(query)).toEqual({ limit: "40", offset: "80", search: "Nike", audit: "ready", change: "taxonomy:pa_brand" });
  });

  it("clamps normal pagination to the available range", () => {
    expect(catalogPagination(220_029, 9_999, 40)).toEqual({ page: 5_501, totalPages: 5_501, first: 220_001, last: 220_029 });
    expect(catalogPagination(0, 5, 40)).toEqual({ page: 1, totalPages: 1, first: 0, last: 0 });
  });

  it("reports when a price-only result is newer than the full snapshot", () => {
    expect(priceIsNewerThanSnapshot("2026-08-13T14:48:00Z", "2026-08-13T21:37:00Z")).toBe(true);
    expect(priceIsNewerThanSnapshot("2026-08-13T14:48:00Z", null)).toBe(false);
  });
});
