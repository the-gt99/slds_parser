import { describe, expect, it } from "vitest";

import type {
  CollectedSourceProduct,
  DiscoveryResult,
  ExportResult,
  SourceProductPartDTO,
  UniversalProductDTO,
} from "../../src/contracts/index.js";

describe("pipeline DTO contracts", () => {
  it("do not require technical timestamps", () => {
    const part = {
      partKey: "details",
      rawPayload: null,
      parsedPayload: {},
      adapterVersion: "1.0.0",
    } satisfies SourceProductPartDTO;

    const discovery = {
      items: [{ sourceKey: "product-1", metadata: {} }],
      checkpoint: null,
      hasMore: false,
      completeness: "complete",
      stats: { processed: 1, discovered: 1 },
    } satisfies DiscoveryResult;

    const collected = {
      sourceKey: "product-1",
      parts: [part],
    } satisfies CollectedSourceProduct;

    const product = {
      sourceProductId: "9007199254740993",
      title: "Product",
      description: "Description",
      sku: "SKU-1",
      images: [],
      variants: [],
      referenceCandidates: [],
      attributes: {},
      metadata: {},
    } satisfies UniversalProductDTO;

    const exported = {
      externalId: "external-1",
      operation: "created",
      metadata: {},
    } satisfies ExportResult;

    expect({ discovery, collected, product, exported }).toBeDefined();
  });
});
