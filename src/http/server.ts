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
  ExportControlFilter,
  JobStatus,
  JobType,
  ProductBatchAction,
  ProductBatchFilter,
  TargetAssignmentRuleDraft,
} from "../repositories/index.js";
import type {
  ClassificationDecisionCommand,
  ClassificationRuleDraft,
  ClassifierAdminService,
  ContentTemplateAdminService,
  CreateTargetTermCommand,
  ExportControlService,
  ProductAdminService,
  ProxyAdminService,
  RuntimeAdminService,
  TargetDictionaryService,
  TargetAssignmentAdminService,
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
  readonly runtime?: RuntimeAdminService;
  readonly wordpressPreview?: WordPressPreviewService;
  readonly exportControl?: ExportControlService;
  readonly contentTemplates?: ContentTemplateAdminService;
  readonly targetAssignments?: TargetAssignmentAdminService;
}

interface QueueQuery {
  readonly sourceId?: string;
  readonly typeCode?: string;
  readonly status?: ClassificationReviewStatus;
  readonly search?: string;
  readonly contextKey?: string;
  readonly limit?: string;
  readonly offset?: string;
}

interface ReviewExamplesParams {
  readonly reviewGroupId: string;
}

interface ExactMatchQuery {
  readonly targetId?: string;
  readonly sourceId?: string;
  readonly typeCode?: string;
  readonly status?: string;
  readonly search?: string;
  readonly limit?: string;
  readonly offset?: string;
}

interface ExactMatchApplyBody {
  readonly targetId?: unknown;
  readonly sourceId?: unknown;
  readonly typeCode?: unknown;
  readonly search?: unknown;
  readonly reviewGroupIds?: unknown;
  readonly limit?: unknown;
}

interface ReviewExamplesQuery {
  readonly search?: string;
  readonly limit?: string;
  readonly offset?: string;
}

interface ReferenceQuery {
  readonly typeCode?: string;
  readonly search?: string;
  readonly limit?: string;
}
interface ReferenceCatalogQuery { readonly typeCode?: string; readonly search?: string; readonly limit?: string; readonly offset?: string }
interface RuleFieldsQuery { readonly sourceId?: string; readonly typeCode?: string }

interface TargetParams { readonly targetId: string }
interface TargetAssignmentRuleParams extends TargetParams { readonly ruleId: string; readonly action: string }
interface ProductParams { readonly productId: string }
interface ProductListQuery { readonly search?: string; readonly source?: string; readonly stage?: string; readonly classification?: string; readonly targetStatus?: string; readonly limit?: string; readonly offset?: string }
interface ProductBatchBody {
  readonly action?: unknown;
  readonly filter?: unknown;
  readonly selectedIds?: unknown;
  readonly limit?: unknown;
  readonly force?: unknown;
  readonly reason?: unknown;
}
interface SnapshotListQuery { readonly search?: string; readonly limit?: string; readonly offset?: string }
interface JobsQuery { readonly jobType?: string; readonly status?: string; readonly search?: string; readonly limit?: string; readonly offset?: string }
interface JobParams { readonly jobId: string }
interface RetryFailedBody { readonly jobType?: unknown; readonly limit?: unknown; readonly reason?: unknown }
interface PreviewQuery { readonly targetId?: string }
interface ExportControlQuery {
  readonly targetId?: string;
  readonly status?: string;
  readonly operation?: string;
  readonly risk?: string;
  readonly change?: string;
  readonly search?: string;
  readonly cursorAt?: string;
  readonly cursorId?: string;
  readonly limit?: string;
}
interface ExportControlBody {
  readonly targetId?: unknown;
  readonly sourceProductIds?: unknown;
  readonly limit?: unknown;
  readonly filter?: unknown;
  readonly reason?: unknown;
}
interface DictionaryQuery { readonly entityType?: string; readonly search?: string; readonly limit?: string; readonly offset?: string }
interface ProjectionQuery { readonly targetId?: string; readonly resolutionKind?: string; readonly resolutionId?: string }
interface ProjectionParams { readonly targetId: string; readonly projectionId: string }
interface ReferenceProjectionQuery { readonly targetId?: string; readonly referenceValueId?: string }
interface ConfigParams { readonly kind: string; readonly configId: string }
interface TargetMappingParams { readonly mappingId: string }
interface ConfigQuery { readonly kind?: string; readonly configId?: string; readonly referenceValueId?: string; readonly sourceId?: string; readonly targetId?: string; readonly typeCode?: string; readonly status?: string; readonly search?: string; readonly usage?: string; readonly limit?: string; readonly offset?: string }
interface RuleParams { readonly ruleId: string }
interface RuleStatusBody { readonly reason?: unknown }
interface SyncBody { readonly entityTypes?: readonly string[] }
interface TargetAssignmentRuleBody {
  readonly name?: unknown;
  readonly groupCode?: unknown;
  readonly priority?: unknown;
  readonly conditions?: unknown;
  readonly actions?: unknown;
  readonly reason?: unknown;
}
interface LoginBody { readonly username?: unknown; readonly password?: unknown }
interface RuntimeDiscoveryBody { readonly discoveryBatchSize?: unknown; readonly requestDelayMs?: unknown; readonly enqueueCollection?: unknown }
interface ProxyParams { readonly proxyId: string }
interface ProxyBody {
  readonly name?: unknown;
  readonly protocol?: unknown;
  readonly host?: unknown;
  readonly port?: unknown;
  readonly username?: unknown;
  readonly password?: unknown;
}
interface ContentTemplateQuery { readonly targetId?: string; readonly field?: string }
interface ContentTemplateParams { readonly targetId: string; readonly templateId: string }
interface ContentTemplateBody {
  readonly targetId?: unknown;
  readonly sourceProductId?: unknown;
  readonly field?: unknown;
  readonly name?: unknown;
  readonly templateSource?: unknown;
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

function contentTemplateField(value: unknown): "description" | "short_description" {
  if (value !== "description" && value !== "short_description") {
    throw new HttpInputError("field must be description or short_description");
  }
  return value;
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
  let targetLink: ClassificationRuleDraft["targetLink"];
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
  const referenceValueId = optionalString(body.referenceValueId);
  return {
    sourceId: entityId(body.sourceId, "sourceId"),
    typeCode: requiredString(body.typeCode, "typeCode"),
    name: requiredString(body.name, "name"),
    priority: Number(body.priority ?? 0),
    conditions,
    ...(referenceValueId === undefined ? {} : { referenceValueId: entityId(referenceValueId, "referenceValueId") }),
    ...(targetLink === undefined ? {} : { targetLink }),
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

function entityIds(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HttpInputError(`${field} must be an array`);
  return [...new Set(value.map((item, index) => entityId(item, `${field}[${index}]`)))];
}

function exportControlStatus(value: unknown) {
  if (value === undefined || value === "") return undefined;
  if (!["checking", "ready", "blocked", "error", "stale"].includes(String(value))) throw new HttpInputError("Unknown export control status");
  return value as "checking" | "ready" | "blocked" | "error" | "stale";
}

function exactMatchStatus(value: unknown): "ready" | "duplicate" | "conflict" | undefined {
  if (value === undefined || value === "") return undefined;
  if (value !== "ready" && value !== "duplicate" && value !== "conflict") {
    throw new HttpInputError("status must be ready, duplicate or conflict");
  }
  return value;
}

function exportControlOperation(value: unknown): "create" | "update" | undefined {
  if (value === undefined || value === "") return undefined;
  if (value !== "create" && value !== "update") throw new HttpInputError("operation must be create or update");
  return value;
}

function exportControlRisk(value: unknown): "none" | "review" | "danger" | undefined {
  if (value === undefined || value === "") return undefined;
  if (value !== "none" && value !== "review" && value !== "danger") throw new HttpInputError("risk must be none, review or danger");
  return value;
}

function exportControlChange(value: unknown): string | undefined {
  const change = optionalString(value);
  if (change !== undefined && !/^[a-z0-9_:.-]{1,80}$/u.test(change)) throw new HttpInputError("Invalid change filter");
  return change;
}

function exportControlFilter(value: unknown): ExportControlFilter | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpInputError("filter must be an object");
  const filter = value as Record<string, unknown>;
  const status = exportControlStatus(filter.status);
  const operation = exportControlOperation(filter.operation);
  const riskLevel = exportControlRisk(filter.riskLevel ?? filter.risk);
  const changeFlag = exportControlChange(filter.changeFlag ?? filter.change);
  const search = optionalString(filter.search);
  return {
    ...(status === undefined ? {} : { status }),
    ...(operation === undefined ? {} : { operation }),
    ...(riskLevel === undefined ? {} : { riskLevel }),
    ...(changeFlag === undefined ? {} : { changeFlag }),
    ...(search === undefined ? {} : { search }),
  };
}
function referenceProjectionBody(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpInputError("JSON object is required");
  const body = value as Record<string, unknown>;
  return {
    targetId: entityId(body.targetId, "targetId"),
    referenceValueId: entityId(body.referenceValueId, "referenceValueId"),
    targetScope: requiredString(body.targetScope, "targetScope"),
    dictionaryValueId: entityId(body.dictionaryValueId, "dictionaryValueId"),
    ...(optionalString(body.reason) === undefined ? {} : { reason: optionalString(body.reason)! }),
  };
}

function referenceTargetMappingBody(value: unknown) {
  const body = referenceProjectionBody(value);
  const record = value as Record<string, unknown>;
  return { ...body, typeCode: requiredString(record.typeCode, "typeCode") };
}

function projectionReason(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return optionalString((value as Record<string, unknown>).reason);
}

function targetOutputBody(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpInputError("JSON object is required");
  const body = value as Record<string, unknown>;
  return {
    targetScope: requiredString(body.targetScope, "targetScope"),
    dictionaryValueId: entityId(body.dictionaryValueId, "dictionaryValueId"),
    ...(optionalString(body.reason) === undefined ? {} : { reason: optionalString(body.reason)! }),
  };
}

function targetMappingBody(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpInputError("JSON object is required");
  const body = value as Record<string, unknown>;
  return {
    dictionaryValueId: entityId(body.dictionaryValueId, "dictionaryValueId"),
    ...(optionalString(body.reason) === undefined ? {} : { reason: optionalString(body.reason)! }),
  };
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

function jobType(value: unknown): JobType {
  if (value !== "discover_source" && value !== "collect_product" && value !== "process_product" && value !== "preflight_product" && value !== "export_product") {
    throw new HttpInputError("jobType must be discover_source, collect_product, process_product, preflight_product or export_product");
  }
  return value;
}

function optionalJobType(value: string | undefined): JobType | undefined {
  return value === undefined || value === "" ? undefined : jobType(value);
}

function optionalJobStatus(value: string | undefined): JobStatus | undefined {
  if (value === undefined || value === "") return undefined;
  if (value !== "pending" && value !== "running" && value !== "retry" && value !== "completed" && value !== "failed") {
    throw new HttpInputError("status must be pending, running, retry, completed or failed");
  }
  return value;
}

function batchAction(value: unknown): ProductBatchAction {
  if (value !== "collect" && value !== "collect_and_process" && value !== "process" && value !== "reprocess" && value !== "retry_failed_processing" && value !== "export") {
    throw new HttpInputError("Unknown product batch action");
  }
  return value;
}

function batchFilter(value: unknown, selectedIds: unknown, limitValue: unknown): ProductBatchFilter {
  const filter = value === null || typeof value !== "object" || Array.isArray(value) ? {} : value as Record<string, unknown>;
  let parsedIds: readonly string[] | undefined;
  if (selectedIds !== undefined) {
    if (!Array.isArray(selectedIds) || selectedIds.length > 1_000) throw new HttpInputError("selectedIds must contain at most 1000 IDs");
    parsedIds = selectedIds.map((id) => entityId(id, "selectedIds"));
  }
  const limit = limitValue === undefined
    ? 100
    : positiveInteger(String(limitValue), 100, 5_000);
  if (limit === 0) throw new HttpInputError("Batch limit must be from 1 to 5000");
  return {
    ...(optionalString(filter.search) === undefined ? {} : { search: optionalString(filter.search)! }),
    ...(optionalString(filter.source) === undefined ? {} : { sourceCode: optionalString(filter.source)! }),
    ...(optionalString(filter.stage) === undefined ? {} : { stage: optionalString(filter.stage)! }),
    ...(optionalString(filter.classification) === undefined ? {} : { classificationStatus: optionalString(filter.classification)! }),
    ...(optionalString(filter.targetStatus) === undefined ? {} : { targetStatus: optionalString(filter.targetStatus)! }),
    ...(parsedIds === undefined ? {} : { selectedIds: parsedIds }),
    limit,
  };
}

function productBatchBody(value: ProductBatchBody | undefined) {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpInputError("JSON object is required");
  return {
    action: batchAction(value.action),
    filter: batchFilter(value.filter, value.selectedIds, value.limit),
    force: value.force === true,
    ...(optionalString(value.reason) === undefined ? {} : { reason: optionalString(value.reason)! }),
  };
}

function targetTermBody(targetId: string, value: unknown): CreateTargetTermCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpInputError("JSON object is required");
  const body = value as Record<string, unknown>;
  const decision = decisionBody({ ...body, action: "confirm" });
  let relatedTerm: CreateTargetTermCommand["relatedTerm"];
  if (body.relatedTerm !== undefined) {
    if (body.relatedTerm === null || typeof body.relatedTerm !== "object" || Array.isArray(body.relatedTerm)) {
      throw new HttpInputError("relatedTerm must be an object");
    }
    const related = body.relatedTerm as Record<string, unknown>;
    const mode = related.mode;
    if (mode !== "create" && mode !== "existing" && mode !== "none") throw new HttpInputError("relatedTerm.mode must be create, existing or none");
    relatedTerm = {
      relationCode: requiredString(related.relationCode, "relatedTerm.relationCode"),
      entityType: requiredString(related.entityType, "relatedTerm.entityType"),
      mode,
      ...(mode === "existing" ? { externalId: entityId(related.externalId, "relatedTerm.externalId") } : {}),
    };
  }
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
    ...(relatedTerm === undefined ? {} : { relatedTerm }),
    ...(optionalString(body.reason) === undefined ? {} : { reason: optionalString(body.reason)! }),
  };
}

function targetAssignmentRuleBody(targetId: string, value: TargetAssignmentRuleBody | undefined): TargetAssignmentRuleDraft {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpInputError("JSON object is required");
  if (!Array.isArray(value.conditions) || !Array.isArray(value.actions)) throw new HttpInputError("conditions and actions must be arrays");
  const priority = Number(value.priority);
  if (!Number.isInteger(priority)) throw new HttpInputError("priority must be an integer");
  return {
    targetId,
    name: requiredString(value.name, "name"),
    groupCode: requiredString(value.groupCode, "groupCode"),
    priority,
    conditions: value.conditions.map((item, index) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) throw new HttpInputError(`conditions[${index}] must be an object`);
      const condition = item as Record<string, unknown>;
      if (condition.operator !== "equals" && condition.operator !== "one_of") throw new HttpInputError(`conditions[${index}].operator is invalid`);
      if (!Array.isArray(condition.values)) throw new HttpInputError(`conditions[${index}].values must be an array`);
      return { field: requiredString(condition.field, `conditions[${index}].field`), operator: condition.operator as "equals" | "one_of", values: condition.values.map((entry) => requiredString(entry, `conditions[${index}].values`)) };
    }),
    actions: value.actions.map((item, index) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) throw new HttpInputError(`actions[${index}] must be an object`);
      const action = item as Record<string, unknown>;
      if (action.mode !== "add" && action.mode !== "replace") throw new HttpInputError(`actions[${index}].mode is invalid`);
      return { targetScope: requiredString(action.targetScope, `actions[${index}].targetScope`), dictionaryValueId: entityId(action.dictionaryValueId, `actions[${index}].dictionaryValueId`), mode: action.mode as "add" | "replace" };
    }),
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
  const actor = (request: FastifyRequest): string => authContexts.get(request)?.operator ?? "unknown";
  const proxyService = (): ProxyAdminService => {
    if (dependencies.proxies === undefined) throw new HttpInputError("Proxy management is not configured");
    return dependencies.proxies;
  };
  const runtimeService = (): RuntimeAdminService => {
    if (dependencies.runtime === undefined) throw new HttpInputError("Runtime management is not configured");
    return dependencies.runtime;
  };
  const contentTemplateService = (): ContentTemplateAdminService => {
    if (dependencies.contentTemplates === undefined) throw new HttpInputError("Content template management is not configured");
    return dependencies.contentTemplates;
  };
  const exportControlService = (): ExportControlService => {
    if (dependencies.exportControl === undefined) throw new HttpInputError("Export control is not configured");
    return dependencies.exportControl;
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
      ? { authenticated: false }
      : {
          authenticated: true,
          operator: context.operator,
          csrfToken: context.csrf,
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

  server.get<{ Querystring: QueueQuery }>("/api/classifier/queue", { preHandler: requireAdmin }, async (request) => {
    const limit = positiveInteger(request.query.limit, 50, 200);
    if (limit === 0) throw new HttpInputError("Expected an integer from 1 to 200");
    if (request.query.status !== undefined
      && request.query.status !== "unresolved"
      && request.query.status !== "ambiguous"
      && request.query.status !== "waiting_apply") {
      throw new HttpInputError("status must be unresolved, ambiguous or waiting_apply");
    }
    const query = {
      ...(request.query.sourceId === undefined ? {} : { sourceId: entityId(request.query.sourceId, "sourceId") }),
      ...(request.query.typeCode === undefined ? {} : { typeCode: request.query.typeCode }),
      ...(request.query.status === undefined ? {} : { status: request.query.status }),
      ...(request.query.search === undefined ? {} : { search: request.query.search }),
      ...(request.query.contextKey === undefined ? {} : { contextKey: request.query.contextKey }),
      limit,
      offset: positiveInteger(request.query.offset, 0, 1_000_000),
    };
    const [items, total] = await Promise.all([
      dependencies.classifier.listReviewQueue(query),
      dependencies.classifier.countReviewQueue(query),
    ]);
    return { items, total };
  });

  server.get<{ Params: ReviewExamplesParams; Querystring: ReviewExamplesQuery }>(
    "/api/classifier/queue/:reviewGroupId/examples",
    { preHandler: requireAdmin },
    async (request) => {
      const limit = positiveInteger(request.query.limit, 3, 100);
      if (limit === 0) throw new HttpInputError("Expected an integer from 1 to 100");
      return dependencies.classifier.listReviewExamples(
        entityId(request.params.reviewGroupId, "reviewGroupId"),
        {
          ...(optionalString(request.query.search) === undefined ? {} : { search: optionalString(request.query.search)! }),
          limit,
          offset: positiveInteger(request.query.offset, 0, 1_000_000),
        },
      );
    },
  );

  server.get<{ Querystring: ExactMatchQuery }>(
    "/api/classifier/exact-matches",
    { preHandler: requireAdmin },
    async (request) => {
      const limit = positiveInteger(request.query.limit, 50, 200);
      if (limit === 0) throw new HttpInputError("Expected an integer from 1 to 200");
      return dependencies.classifier.listExactMatches({
        targetId: entityId(request.query.targetId, "targetId"),
        ...(optionalString(request.query.sourceId) === undefined ? {} : { sourceId: entityId(request.query.sourceId, "sourceId") }),
        ...(optionalString(request.query.typeCode) === undefined ? {} : { typeCode: optionalString(request.query.typeCode)! }),
        ...(exactMatchStatus(request.query.status) === undefined ? {} : { status: exactMatchStatus(request.query.status)! }),
        ...(optionalString(request.query.search) === undefined ? {} : { search: optionalString(request.query.search)! }),
        limit,
        offset: positiveInteger(request.query.offset, 0, 1_000_000),
      });
    },
  );

  server.post<{ Body: ExactMatchApplyBody }>(
    "/api/classifier/exact-matches/apply",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => {
      const limit = request.body?.limit === undefined
        ? undefined
        : positiveInteger(String(request.body.limit), 50, 50);
      if (limit === 0) throw new HttpInputError("Expected an integer from 1 to 50");
      const reviewGroupIds = entityIds(request.body?.reviewGroupIds, "reviewGroupIds");
      if (reviewGroupIds !== undefined && (reviewGroupIds.length === 0 || reviewGroupIds.length > 50)) {
        throw new HttpInputError("reviewGroupIds must contain from 1 to 50 IDs");
      }
      return {
        result: await dependencies.classifier.applyExactMatches({
          targetId: entityId(request.body?.targetId, "targetId"),
          ...(optionalString(request.body?.sourceId) === undefined ? {} : { sourceId: entityId(request.body?.sourceId, "sourceId") }),
          ...(optionalString(request.body?.typeCode) === undefined ? {} : { typeCode: optionalString(request.body?.typeCode)! }),
          ...(optionalString(request.body?.search) === undefined ? {} : { search: optionalString(request.body?.search)! }),
          ...(reviewGroupIds === undefined ? {} : { reviewGroupIds }),
          ...(limit === undefined ? {} : { limit }),
        }, actor(request)),
      };
    },
  );

  server.get<{ Querystring: ReferenceQuery }>("/api/classifier/reference-values", { preHandler: requireAdmin }, async (request) => {
    const typeCode = requiredString(request.query.typeCode, "typeCode");
    const limit = positiveInteger(request.query.limit, 50, 200);
    if (limit === 0) throw new HttpInputError("Expected an integer from 1 to 200");
    return { items: await dependencies.classifier.listReferenceValues(typeCode, request.query.search, limit) };
  });

  server.get<{ Querystring: RuleFieldsQuery }>("/api/classifier/rule-fields", { preHandler: requireAdmin }, async (request) => ({
    items: await dependencies.classifier.listRuleConditionFields(
      entityId(request.query.sourceId, "sourceId"),
      requiredString(request.query.typeCode, "typeCode"),
    ),
  }));

  server.get<{ Querystring: ConfigQuery }>("/api/classifier/configuration", { preHandler: requireAdmin }, async (request) => {
    const limit = positiveInteger(request.query.limit, 50, 200);
    if (limit === 0) throw new HttpInputError("Expected an integer from 1 to 200");
    const includeUsage = request.query.usage !== "none";
    const result = await dependencies.classifier.listConfiguration({
      ...(configKind(request.query.kind) === undefined ? {} : { kind: configKind(request.query.kind)! }),
      ...(request.query.configId === undefined || request.query.configId === "" ? {} : { configId: entityId(request.query.configId, "configId") }),
      ...(request.query.referenceValueId === undefined || request.query.referenceValueId === "" ? {} : { referenceValueId: entityId(request.query.referenceValueId, "referenceValueId") }),
      ...(request.query.sourceId === undefined || request.query.sourceId === "" ? {} : { sourceId: entityId(request.query.sourceId, "sourceId") }),
      ...(request.query.targetId === undefined || request.query.targetId === "" ? {} : { targetId: entityId(request.query.targetId, "targetId") }),
      ...(optionalString(request.query.typeCode) === undefined ? {} : { typeCode: optionalString(request.query.typeCode)! }),
      ...(configStatus(request.query.status) === undefined ? {} : { status: configStatus(request.query.status)! }),
      ...(optionalString(request.query.search) === undefined ? {} : { search: optionalString(request.query.search)! }),
      includeUsage,
      limit,
      offset: positiveInteger(request.query.offset, 0, 1_000_000),
    });
    return { ...result, usageIncluded: includeUsage };
  });

  server.get<{ Querystring: ReferenceCatalogQuery }>("/api/classifier/reference-catalog", { preHandler: requireAdmin }, async (request) => {
    const limit = positiveInteger(request.query.limit, 50, 200);
    if (limit === 0) throw new HttpInputError("Expected an integer from 1 to 200");
    return dependencies.classifier.listReferenceCatalog({
      ...(optionalString(request.query.typeCode) === undefined ? {} : { typeCode: optionalString(request.query.typeCode)! }),
      ...(optionalString(request.query.search) === undefined ? {} : { search: optionalString(request.query.search)! }),
      limit,
      offset: positiveInteger(request.query.offset, 0, 1_000_000),
    });
  });

  server.get<{ Params: ConfigParams }>("/api/classifier/configuration/:kind/:configId/history", { preHandler: requireAdmin }, async (request) => ({
    items: await dependencies.classifier.listConfigurationHistory(
      configKind(request.params.kind)!,
      entityId(request.params.configId, "configId"),
    ),
  }));

  server.post("/api/classifier/decisions/preview", { preHandler: [requireAdmin, requireMutationAccess] }, async (request) => ({
    preview: await dependencies.classifier.previewDecision(decisionBody(request.body)),
  }));

  server.post("/api/classifier/decisions", { preHandler: [requireAdmin, requireMutationAccess] }, async (request) => ({
    decision: await dependencies.classifier.saveDecision(decisionBody(request.body), actor(request)),
  }));

  server.post<{ Params: TargetMappingParams }>("/api/classifier/target-mappings/:mappingId/preview", { preHandler: [requireAdmin, requireMutationAccess] }, async (request) => ({
    preview: await dependencies.classifier.previewTargetValueMapping(
      entityId(request.params.mappingId, "mappingId"),
      targetMappingBody(request.body).dictionaryValueId,
    ),
  }));

  server.patch<{ Params: TargetMappingParams }>("/api/classifier/target-mappings/:mappingId", { preHandler: [requireAdmin, requireMutationAccess] }, async (request) => {
    const body = targetMappingBody(request.body);
    return { mapping: await dependencies.classifier.updateTargetValueMapping(
      entityId(request.params.mappingId, "mappingId"),
      body.dictionaryValueId,
      actor(request),
      body.reason,
    ) };
  });

  for (const [suffix, enabled] of [["deactivate", false], ["reactivate", true]] as const) {
    server.post<{ Params: TargetMappingParams }>(`/api/classifier/target-mappings/:mappingId/${suffix}`, { preHandler: [requireAdmin, requireMutationAccess] }, async (request) => ({
      mapping: await dependencies.classifier.setTargetValueMappingEnabled(
        entityId(request.params.mappingId, "mappingId"), enabled, actor(request), projectionReason(request.body),
      ),
    }));
  }

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

  server.delete<{ Params: RuleParams; Body: RuleStatusBody }>(
    "/api/classifier/rules/:ruleId",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => ({
      rule: await dependencies.classifier.deleteRule(
        entityId(request.params.ruleId, "ruleId"),
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

  server.post("/api/classifier/target-mappings", { preHandler: [requireAdmin, requireMutationAccess] }, async (request, reply) => reply.code(201).send({
    mapping: await dependencies.classifier.createTargetValueMapping(referenceTargetMappingBody(request.body), actor(request)),
  }));

  server.get<{ Querystring: ReferenceProjectionQuery }>("/api/classifier/reference-projections", { preHandler: requireAdmin }, async (request) => ({
    items: await dependencies.classifier.listReferenceProjections(
      entityId(request.query.targetId, "targetId"),
      entityId(request.query.referenceValueId, "referenceValueId"),
    ),
  }));

  server.post("/api/classifier/reference-projections/preview", { preHandler: [requireAdmin, requireMutationAccess] }, async (request) => ({
    preview: await dependencies.classifier.previewReferenceProjection(referenceProjectionBody(request.body)),
  }));

  server.post("/api/classifier/reference-projections", { preHandler: [requireAdmin, requireMutationAccess] }, async (request, reply) => reply.code(201).send({
    projection: await dependencies.classifier.createReferenceProjection(referenceProjectionBody(request.body), actor(request)),
  }));

  server.post<{ Params: ProjectionParams }>(
    "/api/targets/:targetId/reference-projections/:projectionId/deactivate",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => ({
      projection: await dependencies.classifier.deactivateReferenceProjection(
        entityId(request.params.targetId, "targetId"),
        entityId(request.params.projectionId, "projectionId"),
        actor(request),
        projectionReason(request.body),
      ),
    }),
  );

  server.patch<{ Params: ProjectionParams }>(
    "/api/targets/:targetId/classification-projections/:projectionId",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => {
      const body = targetOutputBody(request.body);
      return { projection: await dependencies.classifier.updateTargetProjection(
        entityId(request.params.targetId, "targetId"),
        entityId(request.params.projectionId, "projectionId"),
        body,
        actor(request),
      ) };
    },
  );

  server.post<{ Params: ProjectionParams }>(
    "/api/targets/:targetId/classification-projections/:projectionId/preview-update",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => ({
      preview: await dependencies.classifier.previewTargetProjectionUpdate(
        entityId(request.params.targetId, "targetId"),
        entityId(request.params.projectionId, "projectionId"),
        targetOutputBody(request.body),
      ),
    }),
  );

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

  server.get("/api/content-templates/catalog", { preHandler: requireAdmin }, async () => contentTemplateService().catalog());

  server.get<{ Querystring: ContentTemplateQuery }>("/api/content-templates", { preHandler: requireAdmin }, async (request) => ({
    items: await contentTemplateService().list(
      entityId(request.query.targetId, "targetId"),
      request.query.field === undefined || request.query.field === "" ? undefined : contentTemplateField(request.query.field),
    ),
  }));

  server.post<{ Body: ContentTemplateBody }>(
    "/api/content-templates/preview",
    { preHandler: requireAdmin },
    async (request) => ({
      item: await contentTemplateService().preview({
        targetId: entityId(request.body?.targetId, "targetId"),
        sourceProductId: entityId(request.body?.sourceProductId, "sourceProductId"),
        field: contentTemplateField(request.body?.field),
        name: requiredString(request.body?.name, "name"),
        templateSource: requiredString(request.body?.templateSource, "templateSource"),
      }),
    }),
  );

  server.post<{ Body: ContentTemplateBody }>(
    "/api/content-templates/drafts",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request, reply) => reply.code(201).send({
      item: await contentTemplateService().createDraft({
        targetId: entityId(request.body?.targetId, "targetId"),
        field: contentTemplateField(request.body?.field),
        name: requiredString(request.body?.name, "name"),
        templateSource: requiredString(request.body?.templateSource, "templateSource"),
      }, actor(request)),
    }),
  );

  server.post<{ Params: ContentTemplateParams }>(
    "/api/targets/:targetId/content-templates/:templateId/activate",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => ({
      item: await contentTemplateService().activate(
        entityId(request.params.targetId, "targetId"),
        entityId(request.params.templateId, "templateId"),
        actor(request),
      ),
    }),
  );

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

  server.get<{ Querystring: ExportControlQuery }>("/api/export-control", { preHandler: requireAdmin }, async (request) => {
    const limit = positiveInteger(request.query.limit, 50, 100);
    if (limit === 0) throw new HttpInputError("Expected an integer from 1 to 100");
    const cursorAt = optionalString(request.query.cursorAt);
    const cursorId = optionalString(request.query.cursorId);
    if ((cursorAt === undefined) !== (cursorId === undefined)) throw new HttpInputError("Both cursorAt and cursorId are required");
    if (cursorAt !== undefined && Number.isNaN(new Date(cursorAt).valueOf())) throw new HttpInputError("cursorAt must be a timestamp");
    return exportControlService().list({
      targetId: entityId(request.query.targetId, "targetId"),
      ...(exportControlStatus(request.query.status) === undefined ? {} : { status: exportControlStatus(request.query.status)! }),
      ...(exportControlOperation(request.query.operation) === undefined ? {} : { operation: exportControlOperation(request.query.operation)! }),
      ...(exportControlRisk(request.query.risk) === undefined ? {} : { riskLevel: exportControlRisk(request.query.risk)! }),
      ...(exportControlChange(request.query.change) === undefined ? {} : { changeFlag: exportControlChange(request.query.change)! }),
      ...(optionalString(request.query.search) === undefined ? {} : { search: optionalString(request.query.search)! }),
      ...(cursorAt === undefined ? {} : { cursor: { checkedAt: cursorAt, id: entityId(cursorId, "cursorId") } }),
      limit,
    });
  });

  server.post<{ Body: ExportControlBody }>(
    "/api/export-control/preflights",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => {
      const sourceProductIds = entityIds(request.body?.sourceProductIds, "sourceProductIds");
      const limit = positiveInteger(String(request.body?.limit ?? "100"), 100, 100);
      if (limit === 0) throw new HttpInputError("Expected an integer from 1 to 100");
      return { result: await exportControlService().enqueuePreflights({
        targetId: entityId(request.body?.targetId, "targetId"),
        ...(sourceProductIds === undefined ? {} : { sourceProductIds }),
        limit,
      }) };
    },
  );

  server.post<{ Body: ExportControlBody }>(
    "/api/export-control/export/preview",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => {
      const sourceProductIds = entityIds(request.body?.sourceProductIds, "sourceProductIds");
      const filter = exportControlFilter(request.body?.filter);
      return { preview: await exportControlService().previewExport({
        targetId: entityId(request.body?.targetId, "targetId"),
        ...(sourceProductIds === undefined ? {} : { sourceProductIds }),
        ...(filter === undefined ? {} : { filter }),
      }) };
    },
  );

  server.post<{ Body: ExportControlBody }>(
    "/api/export-control/export",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => {
      const sourceProductIds = entityIds(request.body?.sourceProductIds, "sourceProductIds");
      const filter = exportControlFilter(request.body?.filter);
      const reason = optionalString(request.body?.reason);
      return { result: await exportControlService().applyExport({
        targetId: entityId(request.body?.targetId, "targetId"),
        ...(sourceProductIds === undefined ? {} : { sourceProductIds }),
        ...(filter === undefined ? {} : { filter }),
        ...(reason === undefined ? {} : { reason }),
      }, actor(request)) };
    },
  );

  server.get<{ Querystring: { readonly targetId?: string; readonly limit?: string } }>(
    "/api/export-control/batches",
    { preHandler: requireAdmin },
    async (request) => ({ items: await exportControlService().listBatches(
      entityId(request.query.targetId, "targetId"),
      positiveInteger(request.query.limit, 20, 100),
    ) }),
  );

  server.post<{ Body: ProductBatchBody }>(
    "/api/products/batch/preview",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => ({ preview: await dependencies.productAdmin.previewBatch(productBatchBody(request.body)) }),
  );

  server.post<{ Body: ProductBatchBody }>(
    "/api/products/batch/apply",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => ({ result: await dependencies.productAdmin.applyBatch(productBatchBody(request.body), actor(request)) }),
  );

  server.get("/api/operations", { preHandler: requireAdmin }, async () => ({ items: dependencies.productAdmin.listOperations() }));

  server.get("/api/runtime", { preHandler: requireAdmin }, async () => runtimeService().status());

  server.get<{ Querystring: JobsQuery }>("/api/jobs", { preHandler: requireAdmin }, async (request) => {
    const limit = positiveInteger(request.query.limit, 50, 200);
    if (limit === 0) throw new HttpInputError("Expected an integer from 1 to 200");
    return dependencies.productAdmin.listJobs({
      ...(optionalJobType(request.query.jobType) === undefined ? {} : { jobType: optionalJobType(request.query.jobType)! }),
      ...(optionalJobStatus(request.query.status) === undefined ? {} : { status: optionalJobStatus(request.query.status)! }),
      ...(optionalString(request.query.search) === undefined ? {} : { search: optionalString(request.query.search)! }),
      limit,
      offset: positiveInteger(request.query.offset, 0, 1_000_000),
    });
  });

  server.post<{ Body: RetryFailedBody }>(
    "/api/jobs/failed/preview-retry",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => ({
      preview: await dependencies.productAdmin.previewFailedJobRetry(
        jobType(request.body?.jobType),
        positiveInteger(String(request.body?.limit ?? "100"), 100, 5_000),
      ),
    }),
  );

  server.post<{ Body: RetryFailedBody }>(
    "/api/jobs/failed/retry",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => ({
      result: await dependencies.productAdmin.retryFailedJobs(
        jobType(request.body?.jobType),
        positiveInteger(String(request.body?.limit ?? "100"), 100, 5_000),
        actor(request),
        projectionReason(request.body),
      ),
    }),
  );

  server.post<{ Params: JobParams }>(
    "/api/jobs/:jobId/run",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => {
      try {
        return { result: await runtimeService().runProcessJob(entityId(request.params.jobId, "jobId")) };
      } catch (error) {
        throw new HttpInputError(error instanceof Error ? error.message : "Job cannot be processed");
      }
    },
  );

  server.post(
    "/api/runtime/start",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async () => {
      try {
        return { worker: await runtimeService().start() };
      } catch (error) {
        throw new HttpInputError(error instanceof Error ? error.message : "Runtime cannot be started");
      }
    },
  );

  server.post(
    "/api/runtime/stop",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async () => {
      try {
        return { worker: await runtimeService().stop() };
      } catch (error) {
        throw new HttpInputError(error instanceof Error ? error.message : "Runtime cannot be stopped");
      }
    },
  );

  server.post<{ Body: RuntimeDiscoveryBody }>(
    "/api/runtime/goat/discovery",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => {
      try {
        return { item: await runtimeService().enqueueGoatDiscovery(request.body ?? {}) };
      } catch (error) {
        throw new HttpInputError(error instanceof Error ? error.message : "Invalid discovery settings");
      }
    },
  );

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
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request, reply) => reply.code(201).send({
      result: await dependencies.targetDictionaries.createTermAndDecide(
        targetTermBody(entityId(request.params.targetId, "targetId"), request.body),
        actor(request),
      ),
    }),
  );

  server.get<{ Params: TargetParams }>("/api/targets/:targetId/assignment-rules", { preHandler: requireAdmin }, async (request) => ({
    items: await dependencies.targetAssignments?.list(entityId(request.params.targetId, "targetId")) ?? [],
  }));

  server.post<{ Params: TargetParams; Body: TargetAssignmentRuleBody }>(
    "/api/targets/:targetId/assignment-rules/preview",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => {
      if (dependencies.targetAssignments === undefined) throw new HttpInputError("Target assignment rules are not configured");
      return { preview: await dependencies.targetAssignments.preview(targetAssignmentRuleBody(entityId(request.params.targetId, "targetId"), request.body)) };
    },
  );

  server.post<{ Params: TargetParams; Body: TargetAssignmentRuleBody }>(
    "/api/targets/:targetId/assignment-rules",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request, reply) => {
      if (dependencies.targetAssignments === undefined) throw new HttpInputError("Target assignment rules are not configured");
      return reply.code(201).send({ rule: await dependencies.targetAssignments.create(targetAssignmentRuleBody(entityId(request.params.targetId, "targetId"), request.body), actor(request)) });
    },
  );

  server.post<{ Params: TargetAssignmentRuleParams; Body: { readonly reason?: unknown } }>(
    "/api/targets/:targetId/assignment-rules/:ruleId/:action",
    { preHandler: [requireAdmin, requireMutationAccess] },
    async (request) => {
      if (dependencies.targetAssignments === undefined) throw new HttpInputError("Target assignment rules are not configured");
      const action = request.params.action;
      if (action !== "enable" && action !== "disable") throw new HttpInputError("action must be enable or disable");
      return { rule: await dependencies.targetAssignments.setEnabled(
        entityId(request.params.targetId, "targetId"),
        entityId(request.params.ruleId, "ruleId"),
        action === "enable",
        actor(request),
        optionalString(request.body?.reason),
      ) };
    },
  );

  return server;
}
