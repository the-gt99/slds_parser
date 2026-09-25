import { spawn } from "node:child_process";

import { PermanentError } from "../core/errors/index.js";
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

export function createShihuoSignedHeaders(profile: ShihuoGuestProfile, config: ShihuoSignerConfig): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, [config.script], {
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
    const timeout = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("Shihuo signer timed out")); }, 30_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => { if (stdout.length < 65_536) stdout += value; });
    child.stderr.on("data", (value: string) => { if (stderr.length < 4_096) stderr += value; });
    child.on("error", finish);
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error(`Shihuo signer failed (${code}): ${stderr.trim().slice(0, 200)}`));
      try {
        const value: unknown = JSON.parse(stdout);
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid signer output");
        const headers = value as Record<string, unknown>;
        if (["sh-sign", "sh-ba", "sh-jt", "timestamp"].some((key) => typeof headers[key] !== "string" || !headers[key])) throw new Error("incomplete signer output");
        settled = true; clearTimeout(timeout); resolve(Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")));
      } catch (error) { finish(error instanceof Error ? error : new Error("Invalid Shihuo signer output")); }
    });
    child.stdin.end(JSON.stringify(profile));
  });
}

function searchArticle(article: string): string {
  return article.trim().replace(/^([A-Za-z0-9]+)\s+([A-Za-z0-9]{3})$/u, "$1-$2");
}

export class SignedShihuoSearchVerifier implements ShihuoSearchVerifier {
  constructor(private readonly config: ShihuoSignerConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async verify(profile: ShihuoGuestProfile, article: string): Promise<ShihuoSearchVerification> {
    const keyword = searchArticle(article);
    const headers = await createShihuoSignedHeaders(profile, this.config);
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
