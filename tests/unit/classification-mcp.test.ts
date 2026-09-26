import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClassificationMcpServer, registerClassificationMcp } from "../../src/mcp/index.js";
import type { DataSchemaService, ExportControlService, ProductAdminService, RulesV2Service, TargetDictionaryService, WordPressPreviewService } from "../../src/services/index.js";

const closeCallbacks: Array<() => Promise<void>> = [];

function resultText(value: unknown): string {
  const content = (value as { readonly content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("Tool result has no content array");
  const first = content[0] as { readonly type?: unknown; readonly text?: unknown } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string") throw new Error("Tool result has no text content");
  return first.text;
}

afterEach(async () => {
  await Promise.allSettled(closeCallbacks.splice(0).map((close) => close()));
});

async function connectedClient(options: {
  readonly rulesV2?: Partial<RulesV2Service>;
  readonly dataSchema?: Partial<DataSchemaService>;
  readonly targetDictionaries?: Partial<TargetDictionaryService>;
  readonly wordpressPreview?: Partial<WordPressPreviewService>;
} = {}) {
  const server = createClassificationMcpServer({
    config: { token: "m".repeat(32) },
    dataSchema: (options.dataSchema ?? { listSources: async () => [] }) as DataSchemaService,
    exportControl: {} as ExportControlService,
    productAdmin: {} as ProductAdminService,
    rulesV2: (options.rulesV2 ?? {}) as RulesV2Service,
    targetDictionaries: (options.targetDictionaries ?? {}) as TargetDictionaryService,
    wordpressPreview: (options.wordpressPreview ?? {}) as WordPressPreviewService,
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport as Transport);
  await client.connect(clientTransport as Transport);
  closeCallbacks.push(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  return client;
}

const ruleArguments = {
  sourceId: "1",
  targetId: "10",
  name: "Точный цвет товара",
  groupCode: "mcp_product_color",
  priority: 100,
  status: "shadow",
  conditionGroups: [{ conditions: [{ field: "common.source.productId", operator: "equals", values: ["77"] }] }],
  actions: [{ targetScope: "product.color", dictionaryValueId: "7", mode: "replace" }],
};

describe("classification MCP", () => {
  it("protects the HTTP endpoint with its dedicated bearer token", async () => {
    const app = Fastify();
    registerClassificationMcp(app, {
      config: { token: "m".repeat(32) },
      dataSchema: { listSources: async () => [] } as unknown as DataSchemaService,
      exportControl: {} as ExportControlService,
      productAdmin: {} as ProductAdminService,
      rulesV2: {} as RulesV2Service,
      targetDictionaries: {} as TargetDictionaryService,
      wordpressPreview: {} as WordPressPreviewService,
    });
    closeCallbacks.push(() => app.close());
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    };
    const unauthorized = await app.inject({ method: "POST", url: "/mcp", payload });
    const authorized = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${"m".repeat(32)}`, accept: "application/json, text/event-stream" },
      payload,
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.body).toContain("slds-classification");
  });

  it("publishes focused active-engine classification tools", async () => {
    const client = await connectedClient({});
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "list_classification_workbench",
      "get_product_classification_context",
      "get_product_context",
      "list_classification_rules",
      "list_sources",
      "search_target_dictionary",
      "search_target_dictionaries",
      "list_saved_preflights",
      "get_wordpress_preflight",
      "create_target_term",
      "preview_classification_rule",
      "preview_classification_rules",
      "create_classification_rule",
    ]));
    expect(tools.tools.map((tool) => tool.name)).not.toContain("execute_sql");
  });

  it("returns compact discoverable source and target identifiers", async () => {
    const client = await connectedClient({
      dataSchema: { listSources: vi.fn().mockResolvedValue([{ sourceId: "1", code: "goat", name: "GOAT", adapterCode: "goat", enabled: true }]) },
      targetDictionaries: { listTargets: vi.fn().mockResolvedValue([{
        id: "2", code: "slamdunk", name: "Slamdunk", exporterCode: "wordpress", enabled: false,
        config: { secret: "must-not-leak" }, createdAt: "2026-01-01", updatedAt: "2026-01-01",
        dictionary: { providerCode: "wordpress", configured: true, supportedEntityTypes: ["brands"],
          creatableEntityTypes: ["brands"], classificationCapabilities: [], termRelationCapabilities: [] },
      }]) },
    });
    const sources = await client.callTool({ name: "list_sources", arguments: {} });
    const targets = await client.callTool({ name: "list_targets", arguments: {} });
    expect(sources.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining('"sourceId":"1"') })]);
    expect(targets.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining('"targetId":"2"') })]);
    expect(JSON.stringify(targets.content)).not.toContain("must-not-leak");
  });

  it("returns compact paginated workbench data and separates blocker types", async () => {
    const workbench = vi.fn().mockResolvedValue({
      mode: "resulting_target_dto",
      requiredTargetFields: [{ scope: "product.brand" }],
      counts: { ready: 0, incomplete: 1, conflict: 0 },
      index: { complete: true, indexed: 1, total: 1 },
      filteredCount: 1,
      page: { offset: 0, limit: 10, hasMore: false, nextOffset: null },
      items: [{
        sourceProductId: "77", sourceExternalId: "goat-77", title: "Test", sku: null,
        updatedAt: "2026-01-01", status: "incomplete",
        blockers: [
          { code: "required_brand_missing", message: "Brand" },
          { code: "variants_missing", message: "Variants" },
        ],
        conflicts: [],
        result: { fields: { "product.color": [{ id: "5", label: "Red" }] }, imageCount: 1, variantCount: 0, descriptionPresent: true },
        candidates: { "product.brand": [{ key: "brand:1", sourceValue: "Nike", context: {} }] },
        trace: [{ kind: "rule", name: "Brand rule", ruleId: "9", groupCode: "brand", changes: { verbose: true } }],
      }],
    });
    const client = await connectedClient({ rulesV2: { workbench } });
    const response = await client.callTool({
      name: "list_classification_workbench",
      arguments: { sourceId: "1", targetId: "10", limit: 10 },
    });
    const text = resultText(response);
    const result = JSON.parse(text) as { items: Array<Record<string, unknown>>; page: { nextOffset: number | null } };
    expect(result.items[0]?.classificationBlockers).toEqual(["required_brand_missing"]);
    expect(result.items[0]?.dataBlockers).toEqual(["variants_missing"]);
    expect((result as unknown as { blockerDefinitions: Record<string, string> }).blockerDefinitions).toEqual({
      required_brand_missing: "Brand",
      variants_missing: "Variants",
    });
    expect(result.items[0]?.canRulesResolveAllBlockers).toBe(false);
    expect(result.page.nextOffset).toBeNull();
    expect(text).not.toContain("verbose");
  });

  it("paginates single and batch target dictionary searches", async () => {
    const listValues = vi.fn().mockImplementation(async ({ search }: { search?: string }) => [
      { id: `${search}-1`, name: "One" },
      { id: `${search}-2`, name: "Two" },
      { id: `${search}-3`, name: "Three" },
    ]);
    const client = await connectedClient({ targetDictionaries: { listValues } });
    const single = await client.callTool({
      name: "search_target_dictionary",
      arguments: { targetId: "10", entityType: "brands", search: "Nike", limit: 2, offset: 0 },
    });
    const singleJson = JSON.parse(resultText(single)) as { items: unknown[]; page: { hasMore: boolean; nextOffset: number } };
    expect(singleJson.items).toHaveLength(2);
    expect(singleJson.page).toEqual(expect.objectContaining({ hasMore: true, nextOffset: 2 }));
    expect(listValues).toHaveBeenCalledWith(expect.objectContaining({ limit: 3, offset: 0 }));

    const batch = await client.callTool({
      name: "search_target_dictionaries",
      arguments: { targetId: "10", queries: [
        { requestId: "brand", entityType: "brands", search: "Nike", limit: 2 },
        { requestId: "model", entityType: "models", search: "Air Max", limit: 2 },
      ] },
    });
    const batchJson = JSON.parse(resultText(batch)) as { results: Array<{ requestId: string; items: unknown[] }> };
    expect(batchJson.results.map((item) => item.requestId)).toEqual(["brand", "model"]);
    expect(batchJson.results.every((item) => item.items.length === 2)).toBe(true);
  });

  it("previews a compact batch of exact-product rules without writing", async () => {
    const preview = vi.fn().mockResolvedValue({
      mode: "active", scope: "sample", writes: false, examined: 1, productCount: 1,
      examples: [{ sourceProductId: "77", title: "Test", actions: [] }], conflicts: [],
    });
    const client = await connectedClient({ rulesV2: { preview } });
    const response = await client.callTool({
      name: "preview_classification_rules",
      arguments: { rules: [
        { requestId: "first", ...ruleArguments },
        { requestId: "second", ...ruleArguments, conditionGroups: [{ conditions: [{ field: "common.source.productId", operator: "equals", values: ["78"] }] }] },
      ] },
    });
    const result = JSON.parse(resultText(response)) as { items: Array<{ requestId: string; sourceProductId: string }> };
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: "first", sourceProductId: "77" }),
      expect.objectContaining({ requestId: "second", sourceProductId: "78" }),
    ]));
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it("refuses a rule when the fresh preview count differs", async () => {
    const create = vi.fn();
    const client = await connectedClient({ rulesV2: {
      preview: vi.fn().mockResolvedValue({ productCount: 2, conflicts: [] }),
      create,
    } });
    const result = await client.callTool({
      name: "create_classification_rule",
      arguments: { ...ruleArguments, expectedSampleProductCount: 1, expectedSampleConflictCount: 0 },
    });
    expect(result.isError).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a previewed Rules v2 classification with a dedicated audit actor", async () => {
    const create = vi.fn().mockResolvedValue({ id: "11", revision: "20" });
    const client = await connectedClient({ rulesV2: {
      preview: vi.fn().mockResolvedValue({ productCount: 1, conflicts: [] }),
      create,
    } });
    const result = await client.callTool({
      name: "create_classification_rule",
      arguments: { ...ruleArguments, expectedSampleProductCount: 1, expectedSampleConflictCount: 0 },
    });
    expect(result.isError).not.toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ status: "shadow", targetId: "10" }), "mcp-genspark");
  });

  it("returns a real WordPress preflight without exporting", async () => {
    const preview = vi.fn().mockResolvedValue({ readiness: { ready: false }, payload: { name: "Test" } });
    const client = await connectedClient({ wordpressPreview: { preview } });
    const result = await client.callTool({
      name: "get_wordpress_preflight",
      arguments: { sourceProductId: "77", targetId: "10", refreshWordPress: true },
    });
    expect(result.isError).not.toBe(true);
    expect(preview).toHaveBeenCalledWith("77", "10", [], { refreshWordPress: true });
  });

  it("does not create a target term already present in the synchronized dictionary", async () => {
    const createTermForRulesV2 = vi.fn();
    const client = await connectedClient({ targetDictionaries: {
      listValues: vi.fn().mockResolvedValue([{ id: "5", externalId: "101", name: "Air Max", slug: "air-max" }]),
      createTermForRulesV2,
    } });
    const result = await client.callTool({
      name: "create_target_term",
      arguments: { sourceId: "1", targetId: "10", entityType: "models", name: "Air Max", confirmed: true },
    });
    expect(result.isError).toBe(true);
    expect(createTermForRulesV2).not.toHaveBeenCalled();
  });
});
