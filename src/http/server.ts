import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { AdminApiConfig } from "../config/index.js";
import { AppError } from "../core/errors/index.js";
import type {
  ClassificationRuleConditionRecord,
  ClassificationReviewStatus,
} from "../repositories/index.js";
import type {
  ClassificationDecisionCommand,
  ClassificationRuleDraft,
  ClassifierAdminService,
  CreateTargetTermCommand,
  ProductAdminService,
  ProxyAdminService,
  TargetDictionaryService,
  WordPressPreviewService,
} from "../services/index.js";
import { AdminAuth, type AdminAuthContext } from "./admin-auth.js";
import { registerStaticUi } from "./static-ui.js";

export interface DatabaseHealthClient {
  query(sql: string): Promise<unknown>;
}

export interface HttpServerDependencies {
  readonly database: DatabaseHealthClient;
  readonly auth: AdminApiConfig;
  readonly classifier: ClassifierAdminService;
  readonly targetDictionaries: TargetDictionaryService;
  readonly productAdmin: ProductAdminService;
  readonly proxies?: ProxyAdminService;
  readonly wordpressPreview?: WordPressPreviewService;
}

interface QueueQuery {
  readonly sourceId?: string;
  readonly typeCode?: string;
  readonly status?: ClassificationReviewStatus;
  readonly search?: string;
  readonly limit?: string;
  readonly offset?: string;
}

interface ReferenceQuery {
  readonly typeCode?: string;
  readonly search?: string;
  readonly limit?: string;
}

interface TargetParams { readonly targetId: string }
interface ProductParams { readonly productId: string }
interface ProductListQuery { readonly search?: string; readonly source?: string; readonly stage?: string; readonly classification?: string; readonly targetStatus?: string; readonly limit?: string; readonly offset?: string }
interface SnapshotListQuery { readonly search?: string; readonly limit?: string; readonly offset?: string }
interface PreviewQuery { readonly targetId?: string }
interface DictionaryQuery { readonly entityType?: string; readonly search?: string; readonly limit?: string; readonly offset?: string }
interface ProjectionQuery { readonly targetId?: string; readonly resolutionKind?: string; readonly resolutionId?: string }
interface ProjectionParams { readonly targetId: string; readonly projectionId: string }
interface ConfigQuery { readonly kind?: string; readonly sourceId?: string; readonly targetId?: string; readonly typeCode?: string; readonly status?: string; readonly search?: string; readonly limit?: string; readonly offset?: string }
interface RuleParams { readonly ruleId: string }
interface RuleStatusBody { readonly reason?: unknown }
interface SyncBody { readonly entityTypes?: readonly string[] }
interface LoginBody { readonly username?: unknown; readonly password?: unknown }
interface WordPressGrantBody { readonly password?: unknown }
interface ProxyParams { readonly proxyId: string }
interface ProxyBody {
  readonly name?: unknown;
  readonly protocol?: unknown;
  readonly host?: unknown;
  readonly port?: unknown;
  readonly username?: unknown;
  readonly password?: unknown;
}

class HttpInputError extends Error {}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > maximum) {
    throw new HttpInputError(`Expected an integer from 0 to ${maximum}`);
  }
  return number;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new HttpInputError(`${field} is required`);
  return value;
}

function entityId(value: unknown, field: string): string {
  const id = requiredString(value, field);
  if (!/^\d+$/u.test(id) || BigInt(id) <= 0n) throw new HttpInputError(`${field} must be a positive integer`);
  return id;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function decisionBody(value: unknown): ClassificationDecisionCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpInputError("JSON object is required");
  const body = value as Record<string, unknown>;
  const action = body.action;
  if (action !== "confirm" && action !== "ignore") throw new HttpInputError("action must be confirm or ignore");
  let targetLink: ClassificationDecisionCommand["targetLink"];
  if (body.targetLink !== undefined) {
    if (body.targetLink === null || typeof body.targetLink !== "object" || Array.isArray(body.targetLink)) {
      throw new HttpInputError("targetLink must be an object");
    }
    const link = body.targetLink as Record<string, unknown>;
    targetLink = {
      targetId: entityId(link.targetId, "targetLink.targetId"),
      targetScope: requiredString(link.targetScope, "targetLink.targetScope"),
      dictionaryValueId: entityId(link.dictionaryValueId, "targetLink.dictionaryValueId"),
    };
  }
  return {
    sourceId: entityId(body.sourceId, "sourceId"),
    typeCode: requiredString(body.typeCode, "typeCode"),
    scope: requiredString(body.scope, "scope"),
    normalizedSourceValue: requiredString(body.normalizedSourceValue, "normalizedSourceValue"),
    contextKey: requiredString(body.contextKey, "contextKey"),
    action,
    ...(optionalString(body.referenceValueId) === undefined ? {} : { referenceValueId: entityId(body.referenceValueId, "referenceValueId") }),
    ...(targetLink === undefined ? {} : { targetLink }),
    ...(optionalString(body.reason) === undefined ? {} : { reason: optionalString(body.reason)! }),
  };
}

function ruleBody(value: unknown): ClassificationRuleDraft {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpInputError("JSON object is required");
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.conditions)) throw new HttpInputError("conditions must be an array");
  const conditions = body.conditions.map((condition): ClassificationRuleConditionRecord => {
    if (condition === null || typeof condition !== "object" || Array.isArray(condition)) {
      throw new HttpInputError("Each condition must be an object");
    }
    const item = condition as Record<string, unknown>;
    const operator = item.operator;
    if (operator !== "equals" && operator !== "contains" && operator !== "all_words" && operator !== "regex") {
      throw new HttpInputError("Unknown rule operator");
    }
    return {
      field: requiredString(item.field, "condition.field"),
      operator,
      value: requiredString(item.value, "condition.value"),
    };
  });
  return {
    sourceId: entityId(body.sourceId, "sourceId"),
    typeCode: requiredString(body.typeCode, "typeCode"),
    name: requiredString(body.name, "name"),
    priority: Number(body.priority ?? 0),
    conditions,
    referenceValueId: entityId(body.referenceValueId, "referenceValueId"),
    ...(optionalString(body.reason) === undefined ? {} : { reason: optionalString(body.reason)! }),
  };
}

function projectionBody(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpInputError("JSON object is required");
  const body = value as Record<string, unknown>;
  const resolutionKind = requiredString(body.resolutionKind, "resolutionKind");
  if (resolutionKind !== "mapping" && resolutionKind !== "rule") throw new HttpInputError("resolutionKind must be mapping or rule");
  const parsedKind: "mapping" | "rule" = resolutionKind;
  return {
    targetId: entityId(body.targetId, "targetId"),
    resolutionKind: parsedKind,
    resolutionId: entityId(body.resolutionId, "resolutionId"),
    targetScope: requiredString(body.targetScope, "targetScope"),
    dictionaryValueId: entityId(body.dictionaryValueId, "dictionaryValueId"),
    ...(optionalString(body.reason) === undefined ? {} : { reason: optionalString(body.reason)! }),
  };
}

function projectionReason(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return optionalString((value as Record<string, unknown>).reason);
}

function configKind(value: string | undefined) {
  if (value === undefined || value === "") return undefined;
  if (value !== "mapping" && value !== "rule" && value !== "target_mapping" && value !== "projection") {
    throw new HttpInputError("kind must be mapping, rule, target_mapping or projection");
  }
  return value;
}

function configStatus(value: string | undefined) {
  if (value === undefined || value === "") return undefined;
  if (value !== "active" && value !== "inactive" && value !== "ignored") {
    throw new HttpInputError("status must be active, inactive or ignored");
  }
  return value;
}

function targetTermBody(targetId: string, value: unknown): CreateTargetTermCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpInputError("JSON object is required");
  const body = value as Record<string, unknown>;
  const decision = decisionBody({ ...body, action: "confirm" });
  return {
    sourceId: decision.sourceId,
    typeCode: decision.typeCode,
    scope: decision.scope,
    normalizedSourceValue: decision.normalizedSourceValue,
    contextKey: decision.contextKey,
    targetId,
    targetScope: requiredString(body.targetScope, "targetScope"),
    entityType: requiredString(body.entityType, "entityType"),
    name: requiredString(body.name, "name"),
    ...(optionalString(body.slug) === undefined ? {} : { slug: optionalString(body.slug)! }),
    ...(optionalString(body.parentExternalId) === undefined
      ? {}
      : { parentExternalId: entityId(body.parentExternalId, "parentExternalId") }),
    ...(optionalString(body.reason) === undefined ? {} : { reason: optionalString(body.reason)! }),
  };
}

export function createHttpServer(dependencies: HttpServerDependencies): FastifyInstance {
  const server = Fastify({ logger: true });
  const auth = new AdminAuth(dependencies.auth);
  const authContexts = new WeakMap<FastifyRequest, AdminAuthContext>();
  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const context = auth.authenticate(request);
    if (context === null) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    authContexts.set(request, context);
  };
  const requireMutationAccess = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const context = authContexts.get(request);
    if (context === undefined || !auth.csrfMatches(request, context)) {
      await reply.code(403).send({ error: "csrf_failed" });
    }
  };
  const requireWordPressCreate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const context = authContexts.get(request);
    if (context === undefined || !auth.hasWordPressCreate(request, context)) {
      await reply.code(403).send({ error: "wordpress_create_permission_required" });
    }
  };
  const actor = (request: FastifyRequest): string => authContexts.get(request)?.operator ?? "unknown";
  const proxyService = (): ProxyAdminService => {
    if (dependencies.proxies === undefined) throw new HttpInputError("Proxy management is not configured");
    return dependencies.proxies;
  };

  registerStaticUi(server);

  server.setErrorHandler((error, request, reply) => {
    if (!(error instanceof Error)) {
      request.log.error({ err: error }, "Unhandled API error");
      return reply.code(500).send({ error: "internal_error" });
    }
    if (error instanceof HttpInputError || ("validation" in error && error.validation !== undefined)) {
      return reply.code(400).send({ error: "invalid_request", message: error.message });
    }
    if (error instanceof AppError) {
      const status = error.code === "ENTITY_NOT_FOUND"
        ? 404
        : error.code === "TARGET_DICTIONARY_REQUEST_FAILED"
          ? 502
          : 422;
      return reply.code(status).send({ error: error.code.toLowerCase(), message: error.message });
    }
    request.log.error({ err: error }, "Unhandled API error");
    return reply.code(500).send({ error: "internal_error" });
  });

  server.get("/api/health", async (_request, reply) => {
    try {
      await dependencies.database.query("SELECT 1");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  server.get("/api/auth/session", async (request) => {
    const context = auth.authenticate(request);
    return context === null
      ? { authenticated: false, wordpressCreateConfigured: auth.wordpressCreateConfigured() }
      : {
          authenticated: true,
          operator: context.operator,
          csrfToken: context.csrf,
          wordpressCreateAllowed: auth.hasWordPressCreate(request, context),
          wordpressCreateConfigured: auth.wordpressCreateConfigured(),
        };
  });

  server.post<{ Body: LoginBody }>("/api/auth/login", async (request, reply) => {
    const username = requiredString(request.body?.username, "username");
    const password = requiredString(request.body?.password, "password");
    const result = auth.login(username, password, reply);
    if (result === null) return reply.code(401).send({ error: "invalid_credentials" });
    return { authenticated: true, operator: result.operator, csrfToken: result.csrf };
  });

  server.post(
    "/api/auth/logout",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (_request, reply) => {
      auth.logout(reply);
      return { authenticated: false };
    },
  );

  server.post<{ Body: WordPressGrantBody }>(
    "/api/auth/wordpress-create",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request, reply) => {
      const password = requiredString(request.body?.password, "password");
      const result = auth.grantWordPressCreate(request, password, reply);
      if (result === null) return reply.code(403).send({ error: "invalid_wordpress_create_credentials" });
      return { allowed: true, expiresIn: result.expiresIn };
    },
  );

  server.get<{ Querystring: QueueQuery }>("/api/classifier/queue", { preHandler: requireAdmin }, async (request) => {
    const limit = positiveInteger(request.query.limit, 50, 200);
    if (limit === 0) throw new HttpInputError("Expected an integer from 1 to 200");
    if (request.query.status !== undefined && request.query.status !== "unresolved" && request.query.status !== "ambiguous") {
      throw new HttpInputError("status must be unresolved or ambiguous");
    }
    const items = await dependencies.classifier.listReviewQueue({
      ...(request.query.sourceId === undefined ? {} : { sourceId: entityId(request.query.sourceId, "sourceId") }),
      ...(request.query.typeCode === undefined ? {} : { typeCode: request.query.typeCode }),
      ...(request.query.status === undefined ? {} : { status: request.query.status }),
      ...(request.query.search === undefined ? {} : { search: request.query.search }),
      limit,
      offset: positiveInteger(request.query.offset, 0, 1_000_000),
    });
    return { items };
  });

  server.get<{ Querystring: ReferenceQuery }>("/api/classifier/reference-values", { preHandler: requireAdmin }, async (request) => {
    const typeCode = requiredString(request.query.typeCode, "typeCode");
    const limit = positiveInteger(request.query.limit, 50, 200);
    if (limit === 0) throw new HttpInputError("Expected an integer from 1 to 200");
    return { items: await dependencies.classifier.listReferenceValues(typeCode, request.query.search, limit) };
  });

  server.get<{ Querystring: ConfigQuery }>("/api/classifier/configuration", { preHandler: requireAdmin }, async (request) => {
    const limit = positiveInteger(request.query.limit, 50, 200);
    if (limit === 0) throw new HttpInputError("Expected an integer from 1 to 200");
    return dependencies.classifier.listConfiguration({
      ...(configKind(request.query.kind) === undefined ? {} : { kind: configKind(request.query.kind)! }),
      ...(request.query.sourceId === undefined || request.query.sourceId === "" ? {} : { sourceId: entityId(request.query.sourceId, "sourceId") }),
      ...(request.query.targetId === undefined || request.query.targetId === "" ? {} : { targetId: entityId(request.query.targetId, "targetId") }),
      ...(optionalString(request.query.typeCode) === undefined ? {} : { typeCode: optionalString(request.query.typeCode)! }),
      ...(configStatus(request.query.status) === undefined ? {} : { status: configStatus(request.query.status)! }),
      ...(optionalString(request.query.search) === undefined ? {} : { search: optionalString(request.query.search)! }),
      limit,
      offset: positiveInteger(request.query.offset, 0, 1_000_000),
    });
  });

  server.post("/api/classifier/decisions", { preHandler: [requireAdmin, requireMutationAccess] }, async (request) => ({
    decision: await dependencies.classifier.saveDecision(decisionBody(request.body), actor(request)),
  }));

  server.post("/api/classifier/rules/preview", { preHandler: [requireAdmin, requireMutationAccess] }, async (request) => ({
    preview: await dependencies.classifier.previewRule(ruleBody(request.body)),
  }));

  server.post("/api/classifier/rules", { preHandler: [requireAdmin, requireMutationAccess] }, async (request, reply) => reply.code(201).send({
    rule: await dependencies.classifier.createRule(ruleBody(request.body), actor(request)),
  }));

  server.patch<{ Params: RuleParams }>("/api/classifier/rules/:ruleId", { preHandler: [requireAdmin, requireMutationAccess] }, async (request) => ({
    rule: await dependencies.classifier.updateRule(entityId(request.params.ruleId, "ruleId"), ruleBody(request.body), actor(request)),
  }));

  server.post<{ Params: RuleParams; Body: RuleStatusBody }>(
    "/api/classifier/rules/:ruleId/deactivate",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => ({
      rule: await dependencies.classifier.setRuleEnabled(
        entityId(request.params.ruleId, "ruleId"),
        false,
        actor(request),
        projectionReason(request.body),
      ),
    }),
  );

  server.post<{ Params: RuleParams; Body: RuleStatusBody }>(
    "/api/classifier/rules/:ruleId/reactivate",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => ({
      rule: await dependencies.classifier.setRuleEnabled(
        entityId(request.params.ruleId, "ruleId"),
        true,
        actor(request),
        projectionReason(request.body),
      ),
    }),
  );

  server.get<{ Querystring: ProjectionQuery }>("/api/classifier/projections", { preHandler: requireAdmin }, async (request) => {
    const resolutionKind = requiredString(request.query.resolutionKind, "resolutionKind");
    if (resolutionKind !== "mapping" && resolutionKind !== "rule") throw new HttpInputError("resolutionKind must be mapping or rule");
    return {
      items: await dependencies.classifier.listTargetProjections(
        entityId(request.query.targetId, "targetId"),
        resolutionKind,
        entityId(request.query.resolutionId, "resolutionId"),
      ),
    };
  });

  server.post("/api/classifier/projections/preview", { preHandler: [requireAdmin, requireMutationAccess] }, async (request) => ({
    preview: await dependencies.classifier.previewTargetProjection(projectionBody(request.body)),
  }));

  server.post("/api/classifier/projections", { preHandler: [requireAdmin, requireMutationAccess] }, async (request, reply) => reply.code(201).send({
    projection: await dependencies.classifier.createTargetProjection(projectionBody(request.body), actor(request)),
  }));

  server.post<{ Params: ProjectionParams }>(
    "/api/targets/:targetId/classification-projections/:projectionId/deactivate",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => ({
      projection: await dependencies.classifier.deactivateTargetProjection(
        entityId(request.params.targetId, "targetId"),
        entityId(request.params.projectionId, "projectionId"),
        actor(request),
        projectionReason(request.body),
      ),
    }),
  );

  server.get("/api/targets", { preHandler: requireAdmin }, async () => ({
    items: await dependencies.targetDictionaries.listTargets(),
  }));

  server.get<{ Querystring: ProductListQuery }>("/api/products", { preHandler: requireAdmin }, async (request) => {
    const limit = positiveInteger(request.query.limit, 50, 200);
    if (limit === 0) throw new HttpInputError("Expected an integer from 1 to 200");
    return dependencies.productAdmin.listProducts({
      ...(optionalString(request.query.search) === undefined ? {} : { search: optionalString(request.query.search)! }),
      ...(optionalString(request.query.source) === undefined ? {} : { sourceCode: optionalString(request.query.source)! }),
      ...(optionalString(request.query.stage) === undefined ? {} : { stage: optionalString(request.query.stage)! }),
      ...(optionalString(request.query.classification) === undefined ? {} : { classificationStatus: optionalString(request.query.classification)! }),
      ...(optionalString(request.query.targetStatus) === undefined ? {} : { targetStatus: optionalString(request.query.targetStatus)! }),
      limit, offset: positiveInteger(request.query.offset, 0, 1_000_000),
    });
  });

  server.get("/api/operations", { preHandler: requireAdmin }, async () => ({ items: dependencies.productAdmin.listOperations() }));

  server.get("/api/proxies", { preHandler: requireAdmin }, async () => ({
    items: await proxyService().list(),
  }));

  server.get<{ Params: ProxyParams }>("/api/proxies/:proxyId", { preHandler: requireAdmin }, async (request) => ({
    item: await proxyService().get(entityId(request.params.proxyId, "proxyId")),
  }));

  server.post<{ Body: ProxyBody }>("/api/proxies", { preHandler: [requireAdmin, requireMutationAccess] }, async (request, reply) => reply.code(201).send({
    item: await proxyService().create(request.body ?? {}, actor(request)),
  }));

  server.patch<{ Params: ProxyParams; Body: ProxyBody }>("/api/proxies/:proxyId", { preHandler: [requireAdmin, requireMutationAccess] }, async (request) => ({
    item: await proxyService().update(entityId(request.params.proxyId, "proxyId"), request.body ?? {}, actor(request)),
  }));

  server.post<{ Params: ProxyParams }>("/api/proxies/:proxyId/test", { preHandler: [requireAdmin, requireMutationAccess] }, async (request) => ({
    item: await proxyService().test(entityId(request.params.proxyId, "proxyId"), actor(request)),
  }));

  server.post<{ Params: ProxyParams }>("/api/proxies/:proxyId/enable", { preHandler: [requireAdmin, requireMutationAccess] }, async (request) => ({
    item: await proxyService().enable(entityId(request.params.proxyId, "proxyId"), actor(request)),
  }));

  server.post<{ Params: ProxyParams }>("/api/proxies/:proxyId/disable", { preHandler: [requireAdmin, requireMutationAccess] }, async (request) => ({
    item: await proxyService().disable(entityId(request.params.proxyId, "proxyId"), actor(request)),
  }));

  server.get<{ Querystring: SnapshotListQuery }>("/api/wordpress-snapshots", { preHandler: requireAdmin }, async (request) => {
    const limit = positiveInteger(request.query.limit, 50, 200);
    if (limit === 0) throw new HttpInputError("Expected an integer from 1 to 200");
    return dependencies.productAdmin.listSnapshots({
      ...(optionalString(request.query.search) === undefined ? {} : { search: optionalString(request.query.search)! }),
      limit, offset: positiveInteger(request.query.offset, 0, 1_000_000),
    });
  });

  server.get<{ Params: ProductParams }>(
    "/api/products/:productId",
    { preHandler: requireAdmin },
    async (request) => ({
      item: await dependencies.productAdmin.getProduct(entityId(request.params.productId, "productId")),
    }),
  );

  server.get<{ Params: ProductParams; Querystring: PreviewQuery }>(
    "/api/products/:productId/wordpress-preview",
    { preHandler: requireAdmin },
    async (request) => {
      if (dependencies.wordpressPreview === undefined) throw new HttpInputError("WordPress preview is not configured");
      return { item: await dependencies.wordpressPreview.preview(
        entityId(request.params.productId, "productId"),
        entityId(request.query.targetId, "targetId"),
      ) };
    },
  );

  server.get<{ Params: TargetParams; Querystring: DictionaryQuery }>(
    "/api/targets/:targetId/dictionary",
    { preHandler: requireAdmin },
    async (request) => {
      const targetId = entityId(request.params.targetId, "targetId");
      const entityType = requiredString(request.query.entityType, "entityType");
      const limit = positiveInteger(request.query.limit, 50, 200);
      if (limit === 0) throw new HttpInputError("Expected an integer from 1 to 200");
      return { items: await dependencies.targetDictionaries.listValues({
        targetId,
        entityType,
        ...(request.query.search === undefined ? {} : { search: request.query.search }),
        limit,
        offset: positiveInteger(request.query.offset, 0, 1_000_000),
      }) };
    },
  );

  server.post<{ Params: TargetParams; Body: SyncBody }>(
    "/api/targets/:targetId/dictionary/sync",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => ({
      sync: await dependencies.targetDictionaries.sync(entityId(request.params.targetId, "targetId"), request.body?.entityTypes),
    }),
  );

  server.post<{ Params: TargetParams }>(
    "/api/targets/:targetId/dictionary/terms",
    { preHandler: [requireAdmin, requireMutationAccess, requireWordPressCreate] },
    async (request, reply) => reply.code(201).send({
      result: await dependencies.targetDictionaries.createTermAndDecide(
        targetTermBody(entityId(request.params.targetId, "targetId"), request.body),
        actor(request),
      ),
    }),
  );

  return server;
}
