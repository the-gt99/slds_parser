import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";

import type { JsonValue } from "../../contracts/index.js";
import { IntegrationContractError, PermanentError, RetryableError } from "../../core/errors/index.js";

export interface GoatHttpEnvironment {
  readonly GOAT_CLI_CURL_BIN?: string;
  readonly GOAT_COOKIE_JAR_PATH?: string;
  readonly GOAT_PROXY_HTTP?: string;
  readonly GOAT_PROXY_SOCKS5?: string;
  readonly GOAT_CF_CLEARANCE?: string;
  readonly GOAT_HTTP_TIMEOUT_MS?: string;
  readonly GOAT_MAX_RESPONSE_BYTES?: string;
  readonly GOAT_SESSION_TTL_MS?: string;
}

export interface GoatHttpClientOptions {
  readonly proxyUrl?: string;
}

export interface GoatHttpResponse {
  readonly status: number;
  readonly body: Buffer;
}

export type GoatRequestExecutor = (url: string) => Promise<Buffer>;

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new PermanentError(`${name} must be a positive integer`, { code: "INVALID_GOAT_CONFIG" });
  return number;
}

export function isGoatHtmlChallenge(body: Buffer): boolean {
  const start = body.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return start.startsWith("<!doctype html") || start.startsWith("<html") || start.includes("cloudflare");
}

export function maskProxyCredentials(value: string): string {
  return value.replace(/\b(https?|socks5h?):\/\/[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1://***:***@");
}

export function sanitizeCurlError(value: string, credentials: readonly string[] = []): string {
  let result = maskProxyCredentials(value);
  for (const credential of credentials) {
    if (credential !== "") result = result.split(credential).join("***");
  }
  return result;
}

function proxyCredentialHints(proxy: string | undefined): readonly string[] {
  if (proxy === undefined) return [];
  try {
    const url = new URL(proxy);
    return [decodeURIComponent(url.username), decodeURIComponent(url.password)].filter((item) => item !== "");
  } catch {
    return [];
  }
}

export function assertGoatHttpStatus(status: number, url: string): void {
  if (status >= 200 && status < 300) return;
  if (status === 404 && url.includes("/product_templates/")) throw new PermanentError("GOAT product was not found", { code: "GOAT_PRODUCT_NOT_FOUND" });
  if (status === 403 || status === 408 || status === 425 || status === 429 || status >= 500) {
    throw new RetryableError(`GOAT request failed with HTTP ${status}`, { code: "GOAT_HTTP_RETRYABLE" });
  }
  if (status >= 400) throw new PermanentError(`GOAT request failed with HTTP ${status}`, { code: "GOAT_HTTP_PERMANENT" });
  throw new RetryableError(`GOAT transport returned invalid HTTP status ${status}`, { code: "GOAT_TRANSPORT" });
}

export class GoatHttpClient {
  readonly #bin: string;
  readonly #cookieJar: string;
  readonly #proxy: string | undefined;
  readonly #clearance: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #sessionTtlMs: number;
  #sessionWarmedAt = 0;
  #warming: Promise<void> | undefined;

  constructor(private readonly environment: GoatHttpEnvironment = process.env, options: GoatHttpClientOptions = {}) {
    this.#bin = environment.GOAT_CLI_CURL_BIN?.trim() ?? "";
    if (this.#bin === "") throw new PermanentError("GOAT_CLI_CURL_BIN is required; curl-impersonate is not configured", { code: "GOAT_CURL_NOT_CONFIGURED" });
    this.#cookieJar = environment.GOAT_COOKIE_JAR_PATH?.trim() ?? "";
    if (this.#cookieJar === "") throw new PermanentError("GOAT_COOKIE_JAR_PATH is required", { code: "INVALID_GOAT_CONFIG" });
    const httpProxy = environment.GOAT_PROXY_HTTP?.trim();
    const socksProxy = environment.GOAT_PROXY_SOCKS5?.trim();
    if (httpProxy && socksProxy) throw new PermanentError("Configure only one GOAT proxy", { code: "INVALID_GOAT_CONFIG" });
    this.#proxy = options.proxyUrl?.trim() || httpProxy || socksProxy || undefined;
    this.#clearance = environment.GOAT_CF_CLEARANCE?.trim() || undefined;
    this.#timeoutMs = positiveInteger(environment.GOAT_HTTP_TIMEOUT_MS, 25_000, "GOAT_HTTP_TIMEOUT_MS");
    this.#maxBytes = positiveInteger(environment.GOAT_MAX_RESPONSE_BYTES, 10 * 1024 * 1024, "GOAT_MAX_RESPONSE_BYTES");
    this.#sessionTtlMs = positiveInteger(environment.GOAT_SESSION_TTL_MS, 600_000, "GOAT_SESSION_TTL_MS");
  }

  async getBuffer(url: string): Promise<Buffer> {
    await this.#ensureSession(false);
    let response = await this.#execute(url, false);
    if (response.status === 403) {
      await this.#ensureSession(true);
      response = await this.#execute(url, false);
    }
    assertGoatHttpStatus(response.status, url);
    if (isGoatHtmlChallenge(response.body)) throw new RetryableError("GOAT returned an HTML challenge", { code: "GOAT_CHALLENGE" });
    return response.body;
  }

  async getJson(url: string, expected: "product" | "offers"): Promise<JsonValue> {
    const body = await this.getBuffer(url);
    try {
      return JSON.parse(body.toString("utf8")) as JsonValue;
    } catch (cause) {
      throw new IntegrationContractError(`GOAT ${expected} response is not valid JSON`, { cause });
    }
  }

  async #ensureSession(force: boolean): Promise<void> {
    if (!force && Date.now() - this.#sessionWarmedAt < this.#sessionTtlMs) return;
    if (this.#warming) return this.#warming;
    this.#warming = (async () => {
      const response = await this.#execute("https://www.goat.com/", true);
      assertGoatHttpStatus(response.status, "https://www.goat.com/");
      this.#sessionWarmedAt = Date.now();
    })();
    try { await this.#warming; } finally { this.#warming = undefined; }
  }

  #command(args: readonly string[]): { command: string; args: string[] } {
    const extension = extname(this.#bin).toLowerCase();
    if (process.platform === "win32" && extension === ".cmd") {
      const powershellWrapper = join(dirname(this.#bin), "goat-curl.ps1");
      if (!existsSync(powershellWrapper)) throw new PermanentError("Windows .cmd GOAT wrapper requires a sibling goat-curl.ps1", { code: "GOAT_CURL_NOT_CONFIGURED" });
      return { command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", powershellWrapper, ...args] };
    }
    if (process.platform === "win32" && extension === ".ps1") {
      return { command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.#bin, ...args] };
    }
    return { command: this.#bin, args: [...args] };
  }

  async #execute(url: string, warmup: boolean): Promise<GoatHttpResponse> {
    const marker = `__GOAT_STATUS_${crypto.randomUUID()}__`;
    const seconds = String(Math.ceil(this.#timeoutMs / 1000));
    const headers = warmup
      ? ["Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"]
      : ["Accept: application/json, text/plain, */*"];
    headers.push(
      "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      "Referer: https://www.goat.com/",
      "Origin: https://www.goat.com",
      "Accept-Language: en-US,en;q=0.9",
    );
    if (this.#clearance) headers.push(`Cookie: cf_clearance=${this.#clearance}`);
    const args = ["--silent", "--show-error", "--location", "--compressed", "--connect-timeout", seconds, "--max-time", seconds,
      "--cookie", this.#cookieJar, "--cookie-jar", this.#cookieJar, "--write-out", `${marker}%{http_code}`];
    if (this.#proxy) args.push("--proxy", this.#proxy);
    for (const header of headers) args.push("--header", header);
    args.push(url);
    const invocation = this.#command(args);
    return await new Promise<GoatHttpResponse>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderr = "";
      let settled = false;
      const fail = (error: Error): void => { if (settled) return; settled = true; reject(error); };
      const watchdog = setTimeout(() => {
        child.kill();
        setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 500).unref();
        fail(new RetryableError("GOAT request timed out", { code: "GOAT_TRANSPORT_TIMEOUT" }));
      }, this.#timeoutMs + 2_000);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > this.#maxBytes + marker.length + 3) {
          child.kill();
          fail(new RetryableError("GOAT response exceeded the configured size limit", { code: "GOAT_RESPONSE_TOO_LARGE" }));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 2_000) stderr += chunk.toString("utf8"); });
      child.on("error", (cause) => fail(new RetryableError("Failed to start GOAT curl transport", { code: "GOAT_TRANSPORT", cause })));
      child.on("close", (code) => {
        clearTimeout(watchdog);
        if (settled) return;
        if (code !== 0) { fail(new RetryableError(`GOAT curl transport failed with exit code ${String(code)}`, { code: "GOAT_TRANSPORT", cause: sanitizeCurlError(stderr.trim(), proxyCredentialHints(this.#proxy)) })); return; }
        const output = Buffer.concat(chunks);
        const markerBuffer = Buffer.from(marker);
        const markerAt = output.lastIndexOf(markerBuffer);
        if (markerAt < 0) { fail(new RetryableError("GOAT curl response had no status marker", { code: "GOAT_TRANSPORT" })); return; }
        const status = Number(output.subarray(markerAt + markerBuffer.length).toString("ascii"));
        settled = true;
        resolve({ status, body: output.subarray(0, markerAt) });
      });
    });
  }
}
