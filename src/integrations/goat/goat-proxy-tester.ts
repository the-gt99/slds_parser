import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProxyCredentials, ProxyRecord, ProxyTestResult } from "../../proxies/index.js";
import type { ProxyTester } from "../../services/index.js";
import { GoatHttpClient, sanitizeCurlError, type GoatHttpEnvironment } from "./goat-http-client.js";

export interface GoatProxyTesterEnvironment extends GoatHttpEnvironment {
  readonly GOAT_PROXY_TEST_URL?: string;
}

function proxyUrl(record: ProxyRecord, credentials: ProxyCredentials | null): string {
  const protocol = record.protocol === "socks5" ? "socks5h" : "http";
  const auth = credentials === null ? "" : `${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@`;
  return `${protocol}://${auth}${record.host}:${record.port}`;
}

function testUrl(environment: GoatProxyTesterEnvironment): string {
  const value = environment.GOAT_PROXY_TEST_URL?.trim() || "https://www.goat.com/";
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.goat.com") throw new Error("GOAT_PROXY_TEST_URL must be an https://www.goat.com URL");
  return url.toString();
}

export class GoatProxyTester implements ProxyTester {
  constructor(private readonly environment: GoatProxyTesterEnvironment = process.env) {}

  async test(record: ProxyRecord, credentials: ProxyCredentials | null): Promise<ProxyTestResult> {
    const started = Date.now();
    try {
      const directory = await mkdtemp(path.join(tmpdir(), "slds-goat-proxy-test-"));
      const client = new GoatHttpClient(
        { ...this.environment, GOAT_COOKIE_JAR_PATH: path.join(directory, "cookies.txt") },
        { proxyUrl: proxyUrl(record, credentials) },
      );
      await client.getBuffer(testUrl(this.environment));
      return { healthy: true, latencyMs: Date.now() - started, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { healthy: false, latencyMs: Date.now() - started, error: sanitizeCurlError(message, credentials === null ? [] : [credentials.username, credentials.password]).slice(0, 500) };
    }
  }
}
