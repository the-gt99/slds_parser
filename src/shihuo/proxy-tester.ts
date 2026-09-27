import { fetch as undiciFetch, ProxyAgent } from "undici";

import type { ProxyCredentials, ProxyRecord, ProxyTestResult } from "../proxies/index.js";
import type { ProxyTester } from "../services/proxy-admin-service.js";

function proxyUrl(record: ProxyRecord, credentials: ProxyCredentials | null): string {
  const auth = credentials === null ? "" : `${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@`;
  return `http://${auth}${record.host}:${record.port}`;
}

function safeError(error: unknown, credentials: ProxyCredentials | null): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of credentials === null ? [] : [credentials.username, credentials.password]) {
    if (secret) message = message.replaceAll(secret, "***");
  }
  return message.slice(0, 500);
}

export class ShihuoProxyTester implements ProxyTester {
  async test(record: ProxyRecord, credentials: ProxyCredentials | null): Promise<ProxyTestResult> {
    const started = Date.now();
    const dispatcher = new ProxyAgent(proxyUrl(record, credentials));
    try {
      const response = await undiciFetch("https://www.shihuo.cn/", {
        dispatcher,
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36" },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status >= 500) throw new Error(`Shihuo returned HTTP ${response.status}`);
      await response.body?.cancel();
      return { healthy: true, latencyMs: Date.now() - started, error: null };
    } catch (error) {
      return { healthy: false, latencyMs: Date.now() - started, error: safeError(error, credentials) };
    } finally {
      await dispatcher.close();
    }
  }
}

