import { spawn } from "node:child_process";

import { PermanentError, RetryableError } from "../core/errors/index.js";
import type { ShihuoGuestProfile } from "./types.js";

const SEARCH_URL = "https://sh-gateway.shihuo.cn/v3/sh-api/daga/search/goods/v1";

export interface ShihuoSearchVerification {
  readonly httpStatus: number;
  readonly goodsCount: number;
}

export interface ShihuoSearchVerifier {
  verify(profile: ShihuoGuestProfile, article: string): Promise<ShihuoSearchVerification>;
}

export interface ShihuoSignerConfig {
  readonly python: string;
  readonly script: string;
  readonly assetDirectory: string;
}

export interface ShihuoHeaderSigner {
  sign(profile: ShihuoGuestProfile): Promise<Record<string, string>>;
  close(): void;
}

interface SignerRequest {
  readonly id: string;
  readonly profile: ShihuoGuestProfile;
  readonly resolve: (headers: Record<string, string>) => void;
  readonly reject: (error: Error) => void;
}

function signerHeaders(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid signer output");
  const headers = value as Record<string, unknown>;
  if (["sh-sign", "sh-ba", "sh-jt", "timestamp"].some((key) => typeof headers[key] !== "string" || !headers[key])) {
    throw new Error("incomplete signer output");
  }
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function createShihuoSignedHeaders(
  profile: ShihuoGuestProfile,
  config: ShihuoSignerConfig,
  spawnImpl: typeof spawn = spawn,
  timeoutMs = 30_000,
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(config.python, [config.script], {
      env: { ...process.env, SHIHUO_SIGNER_ASSET_DIR: config.assetDirectory },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = ""; let stderr = ""; let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new RetryableError("Shihuo signer timed out", { code: "SHIHUO_SIGNER_TIMEOUT" }));
    }, timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => { if (stdout.length < 65_536) stdout += value; });
    child.stderr.on("data", (value: string) => { if (stderr.length < 4_096) stderr += value; });
    child.on("error", finish);
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code === null) {
        return finish(new RetryableError(`Shihuo signer was interrupted by ${signal ?? "unknown signal"}`, {
          code: "SHIHUO_SIGNER_INTERRUPTED",
        }));
      }
      if (code !== 0) return finish(new Error(`Shihuo signer failed (${code}): ${stderr.trim().slice(0, 200)}`));
      try {
        const headers = signerHeaders(JSON.parse(stdout));
        settled = true; clearTimeout(timeout); resolve(headers);
      } catch (error) { finish(error instanceof Error ? error : new Error("Invalid Shihuo signer output")); }
    });
    child.stdin.end(JSON.stringify(profile));
  });
}

export class PersistentShihuoSigner implements ShihuoHeaderSigner {
  private child: ReturnType<typeof spawn> | undefined;
  private active: SignerRequest | undefined;
  private readonly queue: SignerRequest[] = [];
  private stdout = "";
  private stderr = "";
  private sequence = 0;
  private requestCount = 0;
  private timeout: NodeJS.Timeout | undefined;
  private closed = false;
  private rotating = false;

  constructor(
    private readonly config: ShihuoSignerConfig,
    private readonly spawnImpl: typeof spawn = spawn,
    private readonly timeoutMs = 30_000,
    private readonly maxRequestsPerProcess = 1_000,
  ) {}

  sign(profile: ShihuoGuestProfile): Promise<Record<string, string>> {
    if (this.closed) return Promise.reject(new Error("Shihuo signer is closed"));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: String(++this.sequence), profile, resolve, reject });
      this.pump();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new RetryableError("Shihuo signer was stopped", { code: "SHIHUO_SIGNER_INTERRUPTED" });
    this.rejectActive(error);
    for (const request of this.queue.splice(0)) request.reject(error);
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }

  private start(): void {
    const child = this.spawnImpl(this.config.python, [this.config.script, "--server"], {
      env: { ...process.env, SHIHUO_SIGNER_ASSET_DIR: this.config.assetDirectory },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.stdout = "";
    this.stderr = "";
    this.requestCount = 0;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => this.handleStdout(child, value));
    child.stderr.on("data", (value: string) => { if (this.stderr.length < 4_096) this.stderr += value; });
    child.on("error", (error) => this.handleExit(child, new RetryableError("Shihuo signer failed to start", {
      code: "SHIHUO_SIGNER_INTERRUPTED", cause: error,
    })));
    child.on("close", (code, signal) => {
      const detail = code === null ? signal ?? "unknown signal" : `exit code ${code}`;
      this.handleExit(child, new RetryableError(`Shihuo signer stopped with ${detail}`, { code: "SHIHUO_SIGNER_INTERRUPTED" }));
    });
  }

  private pump(): void {
    if (this.closed || this.active !== undefined || this.queue.length === 0 || this.rotating) return;
    if (this.child === undefined) this.start();
    const child = this.child!;
    const request = this.queue.shift()!;
    this.active = request;
    this.timeout = setTimeout(() => {
      const error = new RetryableError("Shihuo signer timed out", { code: "SHIHUO_SIGNER_TIMEOUT" });
      this.rejectActive(error);
      child.kill("SIGKILL");
    }, this.timeoutMs);
    child.stdin!.write(`${JSON.stringify({ id: request.id, profile: request.profile })}\n`, (error) => {
      if (error === null || error === undefined) return;
      this.rejectActive(new RetryableError("Shihuo signer input failed", { code: "SHIHUO_SIGNER_INTERRUPTED", cause: error }));
      child.kill("SIGKILL");
    });
  }

  private handleStdout(child: ReturnType<typeof spawn>, value: string): void {
    if (child !== this.child) return;
    this.stdout += value;
    for (;;) {
      const newline = this.stdout.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdout.slice(0, newline);
      this.stdout = this.stdout.slice(newline + 1);
      if (line.trim() === "") continue;
      this.handleResponse(child, line);
    }
    if (this.stdout.length > 65_536) this.protocolFailure(child, "Shihuo signer output was too large");
  }

  private handleResponse(child: ReturnType<typeof spawn>, line: string): void {
    const active = this.active;
    try {
      const value: unknown = JSON.parse(line);
      if (active === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("unexpected signer response");
      }
      const response = value as Record<string, unknown>;
      if (response.id !== active.id) throw new Error("signer response id mismatch");
      const headers = response.ok === true ? signerHeaders(response.headers) : undefined;
      this.clearActive();
      if (response.ok !== true) {
        active.reject(new Error(`Shihuo signer failed: ${String(response.error ?? "unknown error").slice(0, 200)}`));
      } else {
        active.resolve(headers!);
      }
      this.requestCount += 1;
      if (this.requestCount >= this.maxRequestsPerProcess) {
        this.rotating = true;
        child.kill("SIGTERM");
      } else {
        this.pump();
      }
    } catch (error) {
      this.protocolFailure(child, error instanceof Error ? error.message : "Invalid Shihuo signer response");
    }
  }

  private protocolFailure(child: ReturnType<typeof spawn>, message: string): void {
    this.rejectActive(new RetryableError(message, { code: "SHIHUO_SIGNER_INTERRUPTED" }));
    child.kill("SIGKILL");
  }

  private handleExit(child: ReturnType<typeof spawn>, error: Error): void {
    if (child !== this.child) return;
    this.child = undefined;
    this.rotating = false;
    if (this.active !== undefined) this.rejectActive(error);
    if (!this.closed) this.pump();
  }

  private clearActive(): void {
    if (this.timeout !== undefined) clearTimeout(this.timeout);
    this.timeout = undefined;
    this.active = undefined;
  }

  private rejectActive(error: Error): void {
    const active = this.active;
    this.clearActive();
    active?.reject(error);
  }
}

function searchArticle(article: string): string {
  return article.trim().replace(/^([A-Za-z0-9]+)\s+([A-Za-z0-9]{3})$/u, "$1-$2");
}

export class SignedShihuoSearchVerifier implements ShihuoSearchVerifier {
  constructor(private readonly signer: ShihuoHeaderSigner, private readonly fetchImpl: typeof fetch = fetch) {}

  async verify(profile: ShihuoGuestProfile, article: string): Promise<ShihuoSearchVerification> {
    const keyword = searchArticle(article);
    const headers = await this.signer.sign(profile);
    const payload = { from: "home", isHot: "false", keywords: keyword, needAttrs: 1, page: "1", pageSize: "20",
      page_route: "homeSearchList", predictSex: "2", use_type: "2", user_input: keyword };
    const response = await this.fetchImpl(SEARCH_URL, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new PermanentError(`Shihuo verification returned HTTP ${response.status}`, { code: "SHIHUO_VERIFICATION_FAILED" });
    const value: unknown = await response.json();
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PermanentError("Shihuo verification returned invalid JSON", { code: "SHIHUO_VERIFICATION_FAILED" });
    const body = value as Record<string, unknown>; const code = body.status ?? body.code;
    const data = body.data;
    if (code !== 0 || data === null || typeof data !== "object" || Array.isArray(data) || !Array.isArray((data as Record<string, unknown>).lists)) {
      throw new PermanentError(`Shihuo verification returned API status ${String(code)}`, { code: "SHIHUO_VERIFICATION_FAILED" });
    }
    const goodsCount = ((data as Record<string, unknown>).lists as unknown[]).filter((item) => item !== null && typeof item === "object" && !Array.isArray(item) && Boolean((item as Record<string, unknown>).goods_id)).length;
    if (goodsCount === 0) throw new PermanentError("Shihuo verification returned no products", { code: "SHIHUO_VERIFICATION_FAILED" });
    return { httpStatus: response.status, goodsCount };
  }
}
