import { timingSafeEqual } from "node:crypto";

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

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
  TargetDictionaryService,
} from "../services/index.js";

export interface DatabaseHealthClient {
  query(sql: string): Promise<unknown>;
}

export interface HttpServerDependencies {
  readonly database: DatabaseHealthClient;
  readonly adminToken: string;
  readonly classifier: ClassifierAdminService;
  readonly targetDictionaries: TargetDictionaryService;
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
interface DictionaryQuery { readonly entityType?: string; readonly search?: string; readonly limit?: string; readonly offset?: string }
interface SyncBody { readonly entityTypes?: readonly string[] }

class HttpInputError extends Error {}

function safeTokenEquals(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  const match = typeof header === "string" ? /^Bearer\s+(.+)$/iu.exec(header) : null;
  return match?.[1]?.trim() ?? "";
}

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
    ...(optionalString(body.reason) === undefined ? {} : { reason: optionalString(body.reason)! }),
  };
}

export function createHttpServer(dependencies: HttpServerDependencies): FastifyInstance {
  const server = Fastify({ logger: true });
  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!safeTokenEquals(dependencies.adminToken, bearerToken(request))) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };

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

  server.post("/api/classifier/decisions", { preHandler: requireAdmin }, async (request) => ({
    decision: await dependencies.classifier.saveDecision(decisionBody(request.body)),
  }));

  server.post("/api/classifier/rules/preview", { preHandler: requireAdmin }, async (request) => ({
    preview: await dependencies.classifier.previewRule(ruleBody(request.body)),
  }));

  server.post("/api/classifier/rules", { preHandler: requireAdmin }, async (request, reply) => reply.code(201).send({
    rule: await dependencies.classifier.createRule(ruleBody(request.body)),
  }));

  server.get("/api/targets", { preHandler: requireAdmin }, async () => ({
    items: await dependencies.targetDictionaries.listTargets(),
  }));

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
    { preHandler: requireAdmin },
    async (request) => ({
      sync: await dependencies.targetDictionaries.sync(entityId(request.params.targetId, "targetId"), request.body?.entityTypes),
    }),
  );

  server.post<{ Params: TargetParams }>(
    "/api/targets/:targetId/dictionary/terms",
    { preHandler: requireAdmin },
    async (request, reply) => reply.code(201).send({
      result: await dependencies.targetDictionaries.createTermAndDecide(targetTermBody(entityId(request.params.targetId, "targetId"), request.body)),
    }),
  );

  return server;
}
