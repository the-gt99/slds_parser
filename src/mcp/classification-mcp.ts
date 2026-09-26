import { timingSafeEqual } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as z from "zod/v4";

import type { McpConfig } from "../config/index.js";
import type { RuleV2Draft } from "../repositories/index.js";
import type {
  ExportControlService,
  DataSchemaService,
  ProductAdminService,
  RulesV2Service,
  TargetDictionaryService,
  WordPressPreviewService,
} from "../services/index.js";

export interface ClassificationMcpDependencies {
  readonly config: McpConfig;
  readonly dataSchema: DataSchemaService;
  readonly productAdmin: ProductAdminService;
  readonly rulesV2: RulesV2Service;
  readonly targetDictionaries: TargetDictionaryService;
  readonly wordpressPreview: WordPressPreviewService;
  readonly exportControl: ExportControlService;
}

const conditionSchema = z.object({
  field: z.string().min(1).describe("Rules v2 field, for example common.source.productId or candidate.brand.sourceValue"),
  operator: z.enum(["equals", "one_of", "contains_phrase", "regex", "absent"]),
  values: z.array(z.string().min(1)).max(100),
  matchSetId: z.string().regex(/^\d+$/u).optional(),
});

const ruleShape = {
  sourceId: z.string().regex(/^\d+$/u),
  targetId: z.string().regex(/^\d+$/u),
  name: z.string().min(1).max(200),
  groupCode: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u)
    .describe("Only the highest-priority matching rule in one group wins"),
  priority: z.number().int().min(-2_147_483_647).max(2_147_483_647),
  status: z.enum(["draft", "shadow", "disabled"])
    .describe("In active Rules v2, shadow participates in classification; draft and disabled do not"),
  conditionGroups: z.array(z.object({
    conditions: z.array(conditionSchema).min(1).max(20)
      .describe("Conditions inside one group are OR; all groups must match"),
  })).min(1).max(20),
  actions: z.array(z.object({
    targetScope: z.string().min(1).describe("Target scope such as product.brand, product.model or product.category"),
    dictionaryValueId: z.string().regex(/^\d+$/u),
    mode: z.enum(["add", "replace"]),
    primarySourceBrand: z.boolean().optional(),
  })).min(1).max(20),
  reason: z.string().min(1).max(1_000).optional(),
};

const serverInstructions = `Начинай работу с list_sources и list_targets. Для очереди классификации используй
list_classification_workbench в compact-режиме и переходи по страницам через page.nextOffset, пока page.hasMore=true.
Для одного товара используй get_product_classification_context. Полный get_product_context предназначен только для
точечной диагностики и может превышать лимит клиента. Не используй preview правил для поиска или перечисления товаров.
Ищи несколько терминов через search_target_dictionaries; продолжай конкретный запрос через его page.nextOffset.
Отделяй classificationBlockers, которые можно устранить правилами, от dataBlockers, которые требуют исправления данных.
Перед записью правила выполни preview_classification_rule или preview_classification_rules. Создание термина и правила
разрешено только после явного подтверждения пользователя; эти операции не запускают экспорт.`;

const classificationBlockerCodes = new Set([
  "required_brand_missing",
  "required_model_missing",
  "required_category_missing",
]);

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function compactIssue(value: unknown) {
  const issue = objectValue(value);
  return { code: String(issue.code ?? "unknown"), message: String(issue.message ?? "") };
}

function compactWorkbench(value: object) {
  const result = objectValue(value);
  const items = Array.isArray(result.items) ? result.items : [];
  const blockerDefinitions: Record<string, string> = {};
  const compactItems = items.map((rawItem) => {
    const item = objectValue(rawItem);
    const blockers = (Array.isArray(item.blockers) ? item.blockers : []).map(compactIssue);
    blockers.forEach((blocker) => { blockerDefinitions[blocker.code] = blocker.message; });
    const classificationBlockers = blockers.filter((blocker) => classificationBlockerCodes.has(blocker.code));
    const dataBlockers = blockers.filter((blocker) => !classificationBlockerCodes.has(blocker.code));
    const candidates = Object.fromEntries(Object.entries(objectValue(item.candidates)).map(([scope, rawCandidates]) => [
      scope,
      (Array.isArray(rawCandidates) ? rawCandidates : []).map((rawCandidate) => {
        const candidate = objectValue(rawCandidate);
        return { key: candidate.key, sourceValue: candidate.sourceValue, context: candidate.context };
      }),
    ]));
    const targetResult = objectValue(item.result);
    const trace = Array.isArray(item.trace) ? item.trace : [];
    const conflicts = (Array.isArray(item.conflicts) ? item.conflicts : []).map(compactIssue);
    return {
      sourceProductId: item.sourceProductId,
      sourceExternalId: item.sourceExternalId,
      title: item.title,
      sku: item.sku,
      updatedAt: item.updatedAt,
      status: item.status,
      classificationBlockers: classificationBlockers.map((blocker) => blocker.code),
      dataBlockers: dataBlockers.map((blocker) => blocker.code),
      conflicts,
      canRulesResolveAllBlockers: dataBlockers.length === 0 && conflicts.length === 0,
      candidates,
      resultingTargetFields: targetResult.fields,
      facts: {
        imageCount: targetResult.imageCount,
        variantCount: targetResult.variantCount,
        descriptionPresent: targetResult.descriptionPresent,
      },
      appliedRules: trace.map((rawTrace) => {
        const entry = objectValue(rawTrace);
        return { kind: entry.kind, name: entry.name, ruleId: entry.ruleId, groupCode: entry.groupCode };
      }),
    };
  });
  return {
    mode: result.mode,
    requiredTargetFields: result.requiredTargetFields,
    blockerDefinitions,
    counts: result.counts,
    index: result.index,
    filteredCount: result.filteredCount,
    page: result.page,
    items: compactItems,
  };
}

function compactPreview(value: object) {
  const preview = objectValue(value);
  const conflicts = Array.isArray(preview.conflicts) ? preview.conflicts : [];
  const examples = Array.isArray(preview.examples) ? preview.examples : [];
  return {
    mode: preview.mode,
    scope: preview.scope,
    writes: preview.writes,
    examined: preview.examined,
    productCount: preview.productCount,
    conflictCount: conflicts.length,
    conflicts: conflicts.slice(0, 3),
    examples: examples.slice(0, 3),
  };
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function rule(input: z.infer<z.ZodObject<typeof ruleShape>>): RuleV2Draft {
  return {
    sourceId: input.sourceId,
    targetId: input.targetId,
    name: input.name,
    groupCode: input.groupCode,
    priority: input.priority,
    status: input.status,
    conditionGroups: input.conditionGroups.map((group) => ({
      conditions: group.conditions.map((condition) => ({
        field: condition.field,
        operator: condition.operator,
        values: condition.values,
        ...(condition.matchSetId === undefined ? {} : { matchSetId: condition.matchSetId }),
      })),
    })),
    actions: input.actions.map((action) => ({
      targetScope: action.targetScope,
      dictionaryValueId: action.dictionaryValueId,
      mode: action.mode,
      ...(action.primarySourceBrand === undefined ? {} : { primarySourceBrand: action.primarySourceBrand }),
    })),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

function previewCount(preview: object, field: "productCount" | "conflicts"): number {
  const value = (preview as Record<string, unknown>)[field];
  if (field === "conflicts" && Array.isArray(value)) return value.length;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error(`Rules v2 preview did not return ${field}`);
}

function exactProductId(draft: RuleV2Draft): string | null {
  for (const group of draft.conditionGroups) {
    if (group.conditions.length !== 1) continue;
    const condition = group.conditions[0]!;
    if (condition.field === "common.source.productId" && condition.operator === "equals"
      && condition.values.length === 1 && /^\d+$/u.test(condition.values[0]!)) return condition.values[0]!;
  }
  return null;
}

export function createClassificationMcpServer(dependencies: ClassificationMcpDependencies): McpServer {
  const server = new McpServer(
    { name: "slds-classification", version: "1.1.0" },
    { instructions: serverInstructions },
  );

  server.registerTool("list_classification_workbench", {
    description: "List one deterministic page of products evaluated by active Rules v2. compact is the default and is safe for batches: it separates classificationBlockers from dataBlockers and omits verbose trace changes. Continue with offset=page.nextOffset while page.hasMore=true. Use full only for at most 3 products.",
    inputSchema: {
      sourceId: z.string().regex(/^\d+$/u),
      targetId: z.string().regex(/^\d+$/u),
      search: z.string().max(500).optional(),
      status: z.enum(["incomplete", "conflict", "ready", "all"]).default("incomplete"),
      missingField: z.enum(["brand", "model", "category"]).optional(),
      variants: z.enum(["with", "without", "all"]).default("all"),
      sort: z.enum(["latest", "title", "problems", "rule_gaps", "data_ready"]).default("rule_gaps"),
      productId: z.string().regex(/^\d+$/u).optional(),
      detail: z.enum(["compact", "full"]).default("compact"),
      limit: z.number().int().min(1).max(25).default(10),
      offset: z.number().int().min(0).max(1_000_000).default(0),
    },
  }, async (input) => {
    if (input.detail === "full" && input.limit > 3) throw new Error("Full workbench detail is limited to 3 products; use compact pagination for batches");
    const result = await dependencies.rulesV2.workbench({
      sourceId: input.sourceId,
      targetId: input.targetId,
      ...(input.search === undefined ? {} : { search: input.search }),
      status: input.status,
      ...(input.missingField === undefined ? {} : { missingField: input.missingField }),
      variants: input.variants,
      sort: input.sort,
      ...(input.productId === undefined ? {} : { productId: input.productId }),
      limit: input.limit,
      offset: input.offset,
    });
    return textResult(input.detail === "compact" ? compactWorkbench(result) : result);
  });

  server.registerTool("get_product_classification_context", {
    description: "Read compact Rules v2 classification context for exactly one product: blockers split by type, source candidates, resulting target terms and applied rules. Prefer this over get_product_context during classification.",
    inputSchema: {
      sourceId: z.string().regex(/^\d+$/u),
      targetId: z.string().regex(/^\d+$/u),
      sourceProductId: z.string().regex(/^\d+$/u),
    },
  }, async ({ sourceId, targetId, sourceProductId }) => {
    const compact = compactWorkbench(await dependencies.rulesV2.workbench({
      sourceId, targetId, productId: sourceProductId, limit: 1, offset: 0,
    }));
    return textResult({
      mode: compact.mode,
      requiredTargetFields: compact.requiredTargetFields,
      blockerDefinitions: compact.blockerDefinitions,
      item: compact.items[0] ?? null,
    });
  });

  server.registerTool("get_product_context", {
    description: "Read the full diagnostic product snapshot including raw parts, DTO, operation history and jobs. This response can exceed 50 KB. Do not use it for batch classification; use get_product_classification_context instead.",
    inputSchema: { sourceProductId: z.string().regex(/^\d+$/u) },
  }, async ({ sourceProductId }) => textResult(await dependencies.productAdmin.getProduct(sourceProductId)));

  server.registerTool("list_classification_rules", {
    description: "List one Rules v2 page and confirm whether it is authoritative. Use targetId, a narrow search and a small limit. Continue with offset + page.limit while page.hasMore=true.",
    inputSchema: {
      targetId: z.string().regex(/^\d+$/u).optional(),
      search: z.string().max(500).optional(),
      limit: z.number().int().min(1).max(25).default(10),
      offset: z.number().int().min(0).max(1_000_000).default(0),
    },
  }, async ({ targetId, search, limit, offset }) => textResult(await dependencies.rulesV2.overview(
    targetId,
    { ...(search === undefined ? {} : { search }), limit, offset },
  )));

  server.registerTool("list_sources", {
    description: "List enabled product sources and return their exact sourceId values for workbench and Rules v2 calls.",
    inputSchema: {},
  }, async () => textResult({ items: await dependencies.dataSchema.listSources() }));

  server.registerTool("list_targets", {
    description: "List compact configured targets with exact targetId values and dictionary capabilities. This tool does not enable or modify a target.",
    inputSchema: {},
  }, async () => textResult({ items: (await dependencies.targetDictionaries.listTargets()).map((target) => ({
    targetId: target.id,
    code: target.code,
    name: target.name,
    exporterCode: target.exporterCode,
    enabled: target.enabled,
    dictionary: {
      providerCode: target.dictionary.providerCode,
      configured: target.dictionary.configured,
      supportedEntityTypes: target.dictionary.supportedEntityTypes,
      creatableEntityTypes: target.dictionary.creatableEntityTypes,
      classificationCapabilities: target.dictionary.classificationCapabilities,
      termRelationCapabilities: target.dictionary.termRelationCapabilities,
    },
  })) }));

  server.registerTool("search_target_dictionary", {
    description: "Search one page of the locally synchronized target dictionary. It never creates or changes terms. Continue with offset=page.nextOffset while page.hasMore=true.",
    inputSchema: {
      targetId: z.string().regex(/^\d+$/u),
      entityType: z.string().min(1).max(200),
      search: z.string().max(500).optional(),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).max(1_000_000).default(0),
    },
  }, async ({ targetId, entityType, search, limit, offset }) => {
    const values = await dependencies.targetDictionaries.listValues({
      targetId, entityType, ...(search === undefined ? {} : { search }), limit: limit + 1, offset,
    });
    const hasMore = values.length > limit;
    return textResult({
      items: values.slice(0, limit),
      page: { offset, limit, hasMore, nextOffset: hasMore ? offset + limit : null },
    });
  });

  server.registerTool("search_target_dictionaries", {
    description: "Batch up to 20 narrow dictionary searches in one read-only call. Each query returns at most 5 items and its own page cursor; continue only queries whose page.hasMore=true using page.nextOffset.",
    inputSchema: {
      targetId: z.string().regex(/^\d+$/u),
      queries: z.array(z.object({
        requestId: z.string().min(1).max(100),
        entityType: z.string().min(1).max(200),
        search: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(5).default(5),
        offset: z.number().int().min(0).max(1_000_000).default(0),
      })).min(1).max(20),
    },
  }, async ({ targetId, queries }) => textResult({
    results: await Promise.all(queries.map(async (query) => {
      const values = await dependencies.targetDictionaries.listValues({
        targetId,
        entityType: query.entityType,
        search: query.search,
        limit: query.limit + 1,
        offset: query.offset,
      });
      const hasMore = values.length > query.limit;
      return {
        requestId: query.requestId,
        entityType: query.entityType,
        search: query.search,
        items: values.slice(0, query.limit),
        page: {
          offset: query.offset,
          limit: query.limit,
          hasMore,
          nextOffset: hasMore ? query.offset + query.limit : null,
        },
      };
    })),
  }));

  server.registerTool("list_saved_preflights", {
    description: "List one cursor-based page of saved WordPress preflights. This is read-only. To continue, pass both cursorAt and cursorId returned by the previous response; never pass only one cursor field.",
    inputSchema: {
      targetId: z.string().regex(/^\d+$/u),
      status: z.enum(["checking", "ready", "blocked", "error", "stale"]).optional(),
      operation: z.enum(["create", "update"]).optional(),
      riskLevel: z.enum(["none", "review", "danger"]).optional(),
      changeFlag: z.string().regex(/^[a-z0-9_:.-]{1,80}$/u).optional(),
      search: z.string().max(500).optional(),
      cursorAt: z.string().optional(),
      cursorId: z.string().regex(/^\d+$/u).optional(),
      limit: z.number().int().min(1).max(100).default(25),
    },
  }, async (input) => textResult(await dependencies.exportControl.list({
    targetId: input.targetId,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.operation === undefined ? {} : { operation: input.operation }),
    ...(input.riskLevel === undefined ? {} : { riskLevel: input.riskLevel }),
    ...(input.changeFlag === undefined ? {} : { changeFlag: input.changeFlag }),
    ...(input.search === undefined ? {} : { search: input.search }),
    ...(input.cursorAt === undefined || input.cursorId === undefined
      ? {} : { cursor: { checkedAt: input.cursorAt, id: input.cursorId } }),
    limit: input.limit,
  })));

  server.registerTool("get_wordpress_preflight", {
    description: "Build the real WordPress payload preview and show current/proposed fields, taxonomies, variations, images, blockers and diff. refreshWordPress=true performs a read-only remote lookup and refreshes the local snapshot; it never exports.",
    inputSchema: {
      sourceProductId: z.string().regex(/^\d+$/u),
      targetId: z.string().regex(/^\d+$/u),
      refreshWordPress: z.boolean().default(false),
    },
  }, async ({ sourceProductId, targetId, refreshWordPress }) => textResult(await dependencies.wordpressPreview.preview(
    sourceProductId,
    targetId,
    [],
    { refreshWordPress },
  )));

  server.registerTool("create_target_term", {
    description: "Create a missing model, category, tag or other supported term on WordPress and store it in the local dictionary. Use only after an exact dictionary search and explicit user confirmation. This changes WordPress but does not classify or export a product.",
    inputSchema: {
      sourceId: z.string().regex(/^\d+$/u),
      targetId: z.string().regex(/^\d+$/u),
      entityType: z.string().min(1).max(200),
      name: z.string().min(1).max(200),
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).optional(),
      parentExternalId: z.string().regex(/^\d+$/u).optional()
        .describe("WordPress parent term ID; supported only for product_categories"),
      relatedTerm: z.object({
        relationCode: z.string().min(1).max(200),
        entityType: z.string().min(1).max(200),
        mode: z.enum(["create", "existing", "none"]),
        externalId: z.string().regex(/^\d+$/u).optional(),
      }).optional(),
      confirmed: z.literal(true).describe("Must be true only after the user explicitly approved creating the WordPress term"),
    },
  }, async ({ confirmed: _confirmed, ...input }) => {
    const existing = await dependencies.targetDictionaries.listValues({
      targetId: input.targetId,
      entityType: input.entityType,
      search: input.name,
      limit: 200,
      offset: 0,
    });
    const normalizedName = input.name.trim().normalize("NFKC").toLocaleLowerCase("ru-RU");
    const normalizedSlug = input.slug?.trim().toLocaleLowerCase("en-US");
    const duplicate = existing.find((item) => item.name.trim().normalize("NFKC").toLocaleLowerCase("ru-RU") === normalizedName
      || (normalizedSlug !== undefined && item.slug?.trim().toLocaleLowerCase("en-US") === normalizedSlug));
    if (duplicate !== undefined) {
      throw new Error(`Target term already exists in the synchronized dictionary: ${duplicate.id}/${duplicate.externalId}`);
    }
    const result = await dependencies.targetDictionaries.createTermForRulesV2({
      sourceId: input.sourceId,
      targetId: input.targetId,
      entityType: input.entityType,
      name: input.name,
      ...(input.slug === undefined ? {} : { slug: input.slug }),
      ...(input.parentExternalId === undefined ? {} : { parentExternalId: input.parentExternalId }),
      ...(input.relatedTerm === undefined ? {} : { relatedTerm: {
        relationCode: input.relatedTerm.relationCode,
        entityType: input.relatedTerm.entityType,
        mode: input.relatedTerm.mode,
        ...(input.relatedTerm.externalId === undefined ? {} : { externalId: input.relatedTerm.externalId }),
      } }),
    }, "mcp-genspark");
    return textResult({ result });
  });

  server.registerTool("preview_classification_rule", {
    description: "Preview a Rules v2 target classification rule on a read-only sample. For one product, use common.source.productId equals its ID. Always inspect conflicts and call this before create_classification_rule.",
    inputSchema: ruleShape,
  }, async (input) => textResult({ preview: await dependencies.rulesV2.preview(rule(input)) }));

  server.registerTool("preview_classification_rules", {
    description: "Preview up to 10 exact-product Rules v2 proposals in one read-only call. Every proposal must contain common.source.productId equals one ID. Returns compact counts, conflicts and examples; it never writes.",
    inputSchema: {
      rules: z.array(z.object({
        requestId: z.string().min(1).max(100),
        ...ruleShape,
      })).min(1).max(10),
    },
  }, async ({ rules }) => {
    const items = [];
    for (const input of rules) {
      const { requestId, ...ruleInput } = input;
      const draft = rule(ruleInput);
      const sourceProductId = exactProductId(draft);
      if (sourceProductId === null) throw new Error(`Batch preview ${requestId} requires an exact common.source.productId equals condition`);
      const preview = await dependencies.rulesV2.preview(draft);
      items.push({ requestId, sourceProductId, preview: compactPreview(preview) });
    }
    return textResult({ items });
  });

  server.registerTool("create_classification_rule", {
    description: "Create an active Rules v2 classification for exactly one product after explicit user confirmation. A standalone common.source.productId equals condition is mandatory; the fresh preview must match one product without conflicts.",
    inputSchema: {
      ...ruleShape,
      expectedSampleProductCount: z.number().int().min(0),
      expectedSampleConflictCount: z.number().int().min(0),
    },
  }, async ({ expectedSampleProductCount, expectedSampleConflictCount, ...input }) => {
    const draft = rule(input);
    const sourceProductId = exactProductId(draft);
    if (sourceProductId === null) throw new Error("MCP writes require an exact common.source.productId equals condition");
    if (draft.status !== "shadow") throw new Error("MCP product classification must use shadow status so Rules v2 applies it");
    const preview = await dependencies.rulesV2.preview(draft);
    const productCount = previewCount(preview, "productCount");
    const conflictCount = previewCount(preview, "conflicts");
    if (productCount !== expectedSampleProductCount || conflictCount !== expectedSampleConflictCount) {
      throw new Error("Rule preview changed; preview it again before creating the rule");
    }
    if (productCount !== 1) throw new Error(`Exact product rule must match one product, matched ${productCount}`);
    if (conflictCount > 0) throw new Error("A rule with preview conflicts cannot be created through MCP");
    const result = await dependencies.rulesV2.create(draft, "mcp-genspark");
    return textResult({ preview, rule: result });
  });

  return server;
}

function safeTokenEquals(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorized(request: FastifyRequest, token: string): boolean {
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === "string" ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1]?.trim() : undefined;
  return bearer !== undefined && safeTokenEquals(token, bearer);
}

function methodNotAllowed(reply: FastifyReply) {
  return reply.code(405).send({
    jsonrpc: "2.0",
    error: { code: -32_000, message: "Method not allowed." },
    id: null,
  });
}

export function registerClassificationMcp(
  app: FastifyInstance,
  dependencies: ClassificationMcpDependencies,
): void {
  const requireMcp = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!authorized(request, dependencies.config.token)) await reply.code(401).send({ error: "unauthorized" });
  };

  app.post("/mcp", { preHandler: requireMcp }, async (request, reply) => {
    const server = createClassificationMcpServer(dependencies);
    const transport = new StreamableHTTPServerTransport({});
    reply.hijack();
    try {
      await server.connect(transport as Parameters<McpServer["connect"]>[0]);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error }, "MCP request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32_603, message: "Internal server error" }, id: null }));
      }
    } finally {
      await Promise.allSettled([transport.close(), server.close()]);
    }
  });
  app.get("/mcp", { preHandler: requireMcp }, async (_request, reply) => methodNotAllowed(reply));
  app.delete("/mcp", { preHandler: requireMcp }, async (_request, reply) => methodNotAllowed(reply));
}
