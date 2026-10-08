import { describe, expect, it, vi } from "vitest";
import type { ExportContext, JsonObject, ProductImageExportContext } from "../../src/contracts/index.js";
import { WordPressExporter, buildWordPressUpsertPayload } from "../../src/integrations/wordpress/wordpress-exporter.js";
import { validProduct } from "../support/in-memory.js";

const config = { baseUrl: "https://shop.example", authToken: "test", timeoutMs: 1000, jobTimeoutMs: 1000, pollIntervalMs: 100 };
const unusedReferences = { resolveReference: vi.fn(), resolveAssignments: vi.fn(), resolveProjections: vi.fn() };
const snapshot: JsonObject = { product: { target_id: 100, type: "variable", status: "publish", title: "Существующее название",
  sku: "SKU", description_html: "Ручное описание", taxonomies: { pa_brand: [1] }, variations: [], images: [{ attachment_id: 9 }] } };
function context(): ProductImageExportContext {
  return { source: { id: "1", code: "goat", config: {} }, sourceProduct: { id: "2", sourceId: "1", sourceKey: "test", externalId: "200", metadata: {} },
    target: { id: "3", code: "slamdunk", config: {} }, existingExternalId: "100", product: { ...validProduct(),
      images: [{ url: "https://media.example/new.webp", sourceUrl: "https://image.goat.com/photo.png", position: 0,
        contentHash: "b".repeat(64), sourceContentHash: "a".repeat(64), alt: "Product", attributes: {} }] } };
}
function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200 }); }
function transport(current = snapshot) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const action = new URL(String(input)).searchParams.get("slds_target_import_api");
    const body = JSON.parse(String(init?.body)) as { payload: JsonObject };
    if (action === "product-snapshots") return json({ ok: true, items: [{ source_external_id: "200", found: true,
      target_id: 100, matched_by: "source_identity", snapshot }] });
    if (action === "upsert-lookup") return json({ ok: true, target_id: 100, matched_by: "source_identity",
      payload_hash: body.payload.payload_hash, variation_plan: [], snapshot: current, image_identity_mode: "exact_content" });
    if (action === "upsert-jobs") return json({ ok: true, job: { job_id: 9, payload_hash: body.payload.payload_hash,
      status: "done", result: { target_id: 100, operation: "updated", matched_by: "source_identity" } } });
    throw new Error(`Unexpected request: ${action}`);
  });
}

describe("WordPress image-only export", () => {
  it("uses the shared builder, preserves the current title and guards the complete target snapshot", async () => {
    const request = transport(); const submitted = vi.fn();
    const result = await new WordPressExporter(config, request).exportImages({ ...context(), onSubmitted: submitted });
    expect(result.externalId).toBe("100"); expect(request).toHaveBeenCalledTimes(3);
    const sent = JSON.parse(String(request.mock.calls[2]![1]?.body));
    expect(sent.payload.managed_fields).toEqual(["title", "images"]);
    expect(sent.payload.product.title).toBe("Существующее название");
    expect(sent.payload.product).not.toHaveProperty("description_html");
    expect(sent.payload.product).not.toHaveProperty("taxonomies"); expect(sent.payload).not.toHaveProperty("variations");
    expect(sent.patch.expected_target_snapshot).toEqual(snapshot);
    expect(submitted).toHaveBeenCalledWith({ jobId: 9, payloadHash: sent.payload.payload_hash });
    const expected = await buildWordPressUpsertPayload({ ...context(), imageRefreshOnly: true, existingTargetSnapshot: snapshot,
      references: { resolveReference: vi.fn(), resolveAssignments: vi.fn(), resolveProjections: vi.fn() } } as ExportContext);
    expect(sent.payload).toEqual(expected);
  });

  it("blocks a product that changed after the read-only snapshot", async () => {
    const request = transport({ product: { ...(snapshot.product as JsonObject), title: "Изменено вручную" } });
    await expect(new WordPressExporter(config, request).exportImages(context())).rejects.toThrow("changed during");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("blocks creation, unpublished products and empty image sets before any write", async () => {
    for (const product of [{ target_id: 100, type: "variable", status: "draft", title: "Draft" },
      { target_id: 100, type: "simple", status: "publish", title: "Simple" }]) {
      await expect(buildWordPressUpsertPayload({ ...context(), imageRefreshOnly: true,
        existingTargetSnapshot: { product }, references: unusedReferences })).rejects.toThrow("published variable");
    }
    const { existingExternalId: _id, ...missing } = context();
    const request = transport();
    await expect(new WordPressExporter(config, request).exportImages(missing)).rejects.toThrow("cannot create");
    expect(request).not.toHaveBeenCalled();
    await expect(buildWordPressUpsertPayload({ ...context(), product: validProduct(), imageRefreshOnly: true,
      existingTargetSnapshot: snapshot, references: unusedReferences })).rejects.toThrow("erase all");
  });

  it("does not update the wrong target even when the source snapshot lookup succeeds", async () => {
    const request = transport();
    await expect(new WordPressExporter(config, request).exportImages({ ...context(), existingExternalId: "101" })).rejects.toThrow("identity was not confirmed");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("blocks an older WordPress importer that would reuse a changed picture by URL", async () => {
    const original = transport();
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await original(input, init);
      const body = await response.json() as Record<string, unknown>;
      delete body.image_identity_mode;
      return json(body);
    });
    await expect(new WordPressExporter(config, request).exportImages(context())).rejects.toThrow("does not confirm");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
