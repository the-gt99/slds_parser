import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClassificationMcpServer, registerClassificationMcp } from "../../src/mcp/index.js";
import type { ExportControlService, ProductAdminService, RulesV2Service, TargetDictionaryService, WordPressPreviewService } from "../../src/services/index.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(closeCallbacks.splice(0).map((close) => close()));
});

async function connectedClient(options: {
  readonly rulesV2?: Partial<RulesV2Service>;
  readonly targetDictionaries?: Partial<TargetDictionaryService>;
  readonly wordpressPreview?: Partial<WordPressPreviewService>;
} = {}) {
  const server = createClassificationMcpServer({
    config: { token: "m".repeat(32) },
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
      "get_product_context",
      "list_classification_rules",
      "search_target_dictionary",
      "list_saved_preflights",
      "get_wordpress_preflight",
      "create_target_term",
      "preview_classification_rule",
      "create_classification_rule",
    ]));
    expect(tools.tools.map((tool) => tool.name)).not.toContain("execute_sql");
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
