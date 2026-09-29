import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AdminApiConfig, McpConfig } from "../config/index.js";

const CLIENT_ID = "slds-work";
const READ_SCOPE = "slds.read";
const WRITE_SCOPE = "slds.write";
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 5 * 60 * 1_000;

interface AuthorizationCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly scope: string;
  readonly subject: string;
  readonly expiresAt: number;
}

interface SignedToken {
  readonly typ: "access" | "refresh";
  readonly sub: string;
  readonly aud: string;
  readonly scope: string;
  readonly exp: number;
}

export interface McpOauthOptions {
  readonly mcp: McpConfig;
  readonly admin: AdminApiConfig;
}

export interface McpAuthorization {
  authenticate(request: FastifyRequest, requiredScope: string): boolean;
  challenge(reply: FastifyReply, requiredScope: string): FastifyReply;
}

function safeEquals(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function values(value: unknown): URLSearchParams {
  if (typeof value === "string") return new URLSearchParams(value);
  if (value !== null && typeof value === "object") {
    return new URLSearchParams(Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }
  return new URLSearchParams();
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  return /^Bearer\s+(.+)$/iu.exec(header)?.[1]?.trim() ?? null;
}

function basicCredentials(request: FastifyRequest): { readonly id: string; readonly secret: string } | null {
  const header = request.headers.authorization;
  const encoded = typeof header === "string" ? /^Basic\s+(.+)$/iu.exec(header)?.[1] : undefined;
  if (encoded === undefined) return null;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { id: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

function requestedScope(value: string | null): string | null {
  const requested = new Set((value ?? `${READ_SCOPE} ${WRITE_SCOPE}`).split(/\s+/u).filter(Boolean));
  if (requested.size === 0 || [...requested].some((scope) => scope !== READ_SCOPE && scope !== WRITE_SCOPE)) return null;
  if (!requested.has(READ_SCOPE)) requested.add(READ_SCOPE);
  return [...requested].join(" ");
}

export function registerMcpOauth(app: FastifyInstance, options: McpOauthOptions): McpAuthorization {
  const baseUrl = options.mcp.publicBaseUrl;
  const redirectUri = options.mcp.oauthRedirectUri;
  if (baseUrl === undefined || redirectUri === undefined) {
    throw new Error("MCP OAuth requires public base URL and redirect URI");
  }
  const issuer = baseUrl;
  const resource = `${baseUrl}/mcp`;
  const metadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
  const codes = new Map<string, AuthorizationCode>();

  const sign = (payload: SignedToken): string => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", options.mcp.token).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  };
  const verify = (token: string, type: SignedToken["typ"]): SignedToken | null => {
    const separator = token.lastIndexOf(".");
    if (separator <= 0) return null;
    const encoded = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    const expected = createHmac("sha256", options.mcp.token).update(encoded).digest("base64url");
    if (!safeEquals(expected, signature)) return null;
    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<SignedToken>;
      if (payload.typ !== type || typeof payload.sub !== "string" || payload.aud !== resource
        || typeof payload.scope !== "string" || typeof payload.exp !== "number"
        || payload.exp <= Math.floor(Date.now() / 1_000)) return null;
      return payload as SignedToken;
    } catch {
      return null;
    }
  };
  const issueTokens = (subject: string, scope: string) => ({
    access_token: sign({ typ: "access", sub: subject, aud: resource, scope, exp: Math.floor(Date.now() / 1_000) + ACCESS_TTL_SECONDS }),
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: sign({ typ: "refresh", sub: subject, aud: resource, scope, exp: Math.floor(Date.now() / 1_000) + REFRESH_TTL_SECONDS }),
    scope,
  });

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => done(null, body));

  const protectedMetadata = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [READ_SCOPE, WRITE_SCOPE],
  };
  app.get("/.well-known/oauth-protected-resource", async () => protectedMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", async () => protectedMetadata);
  app.get("/.well-known/oauth-authorization-server", async () => ({
    issuer,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [READ_SCOPE, WRITE_SCOPE],
  }));

  app.get("/oauth/authorize", async (request, reply) => {
    const query = values(request.query);
    const scope = requestedScope(query.get("scope"));
    const requestedRedirectUri = query.get("redirect_uri") ?? "";
    if (query.get("response_type") !== "code" || query.get("client_id") !== CLIENT_ID
      || requestedRedirectUri !== redirectUri || query.get("code_challenge_method") !== "S256"
      || (query.get("code_challenge") ?? "").length < 43 || query.get("resource") !== resource || scope === null) {
      return reply.code(400).type("text/plain; charset=utf-8").send("Invalid OAuth authorization request");
    }
    const hidden = [...query.entries()].map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join("");
    return reply.type("text/html; charset=utf-8").send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SLDS</title><style>body{font:16px system-ui;max-width:420px;margin:10vh auto;padding:24px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:7px 0}button{cursor:pointer}</style></head><body><h1>SLDS Classification</h1><p>Войдите с учетными данными администратора, чтобы разрешить доступ к классификации.</p><form method="post" action="/oauth/authorize">${hidden}<input name="username" autocomplete="username" placeholder="Логин" required><input name="password" type="password" autocomplete="current-password" placeholder="Пароль" required><button type="submit">Разрешить доступ</button></form></body></html>`);
  });

  app.post("/oauth/authorize", async (request, reply) => {
    const form = values(request.body);
    const requestedRedirectUri = form.get("redirect_uri") ?? "";
    const scope = requestedScope(form.get("scope"));
    if (form.get("response_type") !== "code" || form.get("client_id") !== CLIENT_ID
      || requestedRedirectUri !== redirectUri || form.get("code_challenge_method") !== "S256"
      || (form.get("code_challenge") ?? "").length < 43 || form.get("resource") !== resource || scope === null) {
      return reply.code(400).type("text/plain; charset=utf-8").send("Invalid OAuth authorization request");
    }
    if (!safeEquals(options.admin.username, form.get("username") ?? "")
      || !safeEquals(options.admin.password, form.get("password") ?? "")) {
      return reply.code(401).type("text/plain; charset=utf-8").send("Invalid credentials");
    }
    const code = randomBytes(32).toString("base64url");
    codes.set(code, {
      clientId: CLIENT_ID,
      redirectUri: requestedRedirectUri,
      codeChallenge: form.get("code_challenge")!,
      resource,
      scope,
      subject: options.admin.username,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const location = new URL(requestedRedirectUri);
    location.searchParams.set("code", code);
    const state = form.get("state");
    if (state !== null) location.searchParams.set("state", state);
    return reply.redirect(location.toString());
  });

  app.post("/oauth/token", async (request, reply) => {
    const form = values(request.body);
    const basic = basicCredentials(request);
    const clientId = basic?.id ?? form.get("client_id") ?? "";
    const clientSecret = basic?.secret ?? form.get("client_secret") ?? "";
    if (clientId !== CLIENT_ID || !safeEquals(options.mcp.token, clientSecret)) {
      return reply.code(401).send({ error: "invalid_client" });
    }
    if (form.get("grant_type") === "authorization_code") {
      const codeValue = form.get("code") ?? "";
      const code = codes.get(codeValue);
      codes.delete(codeValue);
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (code === undefined || code.expiresAt <= Date.now() || code.clientId !== clientId
        || code.redirectUri !== form.get("redirect_uri") || code.resource !== form.get("resource")
        || !safeEquals(code.codeChallenge, challenge)) return reply.code(400).send({ error: "invalid_grant" });
      return reply.send(issueTokens(code.subject, code.scope));
    }
    if (form.get("grant_type") === "refresh_token") {
      const token = verify(form.get("refresh_token") ?? "", "refresh");
      if (token === null || (form.get("resource") !== null && form.get("resource") !== resource)) {
        return reply.code(400).send({ error: "invalid_grant" });
      }
      return reply.send(issueTokens(token.sub, token.scope));
    }
    return reply.code(400).send({ error: "unsupported_grant_type" });
  });

  return {
    authenticate(request, requiredScope) {
      const token = bearer(request);
      if (token === null) return false;
      if (safeEquals(options.mcp.token, token)) return true;
      const payload = verify(token, "access");
      return payload !== null && new Set(payload.scope.split(/\s+/u)).has(requiredScope);
    },
    challenge(reply, requiredScope) {
      reply.header("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}", scope="${requiredScope}"`);
      return reply.code(401).send({ error: "unauthorized" });
    },
  };
}

export const mcpOauthClientId = CLIENT_ID;
export const mcpReadScope = READ_SCOPE;
export const mcpWriteScope = WRITE_SCOPE;
