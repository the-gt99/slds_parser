import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import type { AdminApiConfig } from "../config/index.js";

const SESSION_COOKIE = "slds_parser_session";
const WORDPRESS_COOKIE = "slds_parser_wordpress_create";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const WORDPRESS_TTL_SECONDS = 10 * 60;

interface SignedPayload {
  readonly sub: string;
  readonly exp: number;
  readonly csrf: string;
  readonly scope: "admin" | "wordpress:create";
}

export interface AdminAuthContext {
  readonly operator: string;
  readonly csrf: string | null;
  readonly method: "bearer" | "session";
}

function safeEquals(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookies(request: FastifyRequest): Readonly<Record<string, string>> {
  const header = request.headers.cookie;
  if (typeof header !== "string") return {};
  return Object.fromEntries(header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) return [];
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    return name === "" ? [] : [[name, value]];
  }));
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export class AdminAuth {
  constructor(private readonly config: AdminApiConfig) {}

  authenticate(request: FastifyRequest): AdminAuthContext | null {
    const authorization = request.headers.authorization;
    const bearer = typeof authorization === "string" ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1]?.trim() : undefined;
    if (bearer !== undefined && safeEquals(this.config.token, bearer)) {
      return { operator: "api-token", csrf: null, method: "bearer" };
    }
    const payload = this.verify(cookies(request)[SESSION_COOKIE], "admin");
    return payload === null
      ? null
      : { operator: payload.sub, csrf: payload.csrf, method: "session" };
  }

  login(username: string, password: string, reply: FastifyReply): { readonly operator: string; readonly csrf: string } | null {
    if (!safeEquals(this.config.username, username) || !safeEquals(this.config.password, password)) return null;
    const payload: SignedPayload = {
      sub: this.config.username,
      exp: Math.floor(Date.now() / 1_000) + SESSION_TTL_SECONDS,
      csrf: randomBytes(24).toString("base64url"),
      scope: "admin",
    };
    reply.header("Set-Cookie", cookie(SESSION_COOKIE, this.sign(payload), SESSION_TTL_SECONDS));
    return { operator: payload.sub, csrf: payload.csrf };
  }

  logout(reply: FastifyReply): void {
    reply.header("Set-Cookie", [clearCookie(SESSION_COOKIE), clearCookie(WORDPRESS_COOKIE)]);
  }

  grantWordPressCreate(
    request: FastifyRequest,
    password: string,
    reply: FastifyReply,
  ): { readonly expiresIn: number } | null {
    if (this.config.wordpressCreatePassword === null || !safeEquals(this.config.wordpressCreatePassword, password)) return null;
    const session = this.authenticate(request);
    if (session === null) return null;
    const payload: SignedPayload = {
      sub: session.operator,
      exp: Math.floor(Date.now() / 1_000) + WORDPRESS_TTL_SECONDS,
      csrf: session.csrf ?? "",
      scope: "wordpress:create",
    };
    reply.header("Set-Cookie", cookie(WORDPRESS_COOKIE, this.sign(payload), WORDPRESS_TTL_SECONDS));
    return { expiresIn: WORDPRESS_TTL_SECONDS };
  }

  hasWordPressCreate(request: FastifyRequest, context: AdminAuthContext): boolean {
    if (context.method === "bearer") {
      const provided = request.headers["x-wordpress-create-token"];
      return this.config.wordpressCreatePassword !== null
        && typeof provided === "string"
        && safeEquals(this.config.wordpressCreatePassword, provided);
    }
    const payload = this.verify(cookies(request)[WORDPRESS_COOKIE], "wordpress:create");
    return payload !== null && payload.sub === context.operator && payload.csrf === context.csrf;
  }

  csrfMatches(request: FastifyRequest, context: AdminAuthContext): boolean {
    if (context.method === "bearer") return true;
    const provided = request.headers["x-csrf-token"];
    return typeof provided === "string" && context.csrf !== null && safeEquals(context.csrf, provided);
  }

  wordpressCreateConfigured(): boolean {
    return this.config.wordpressCreatePassword !== null;
  }

  private sign(payload: SignedPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.config.sessionSecret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  private verify(value: string | undefined, scope: SignedPayload["scope"]): SignedPayload | null {
    if (value === undefined) return null;
    const separator = value.lastIndexOf(".");
    if (separator <= 0) return null;
    const encoded = value.slice(0, separator);
    const signature = value.slice(separator + 1);
    const expected = createHmac("sha256", this.config.sessionSecret).update(encoded).digest("base64url");
    if (!safeEquals(expected, signature)) return null;
    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<SignedPayload>;
      if (typeof payload.sub !== "string" || typeof payload.exp !== "number" || typeof payload.csrf !== "string"
        || payload.scope !== scope || payload.exp <= Math.floor(Date.now() / 1_000)) return null;
      return payload as SignedPayload;
    } catch {
      return null;
    }
  }
}
