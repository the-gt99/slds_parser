import { createPostgresPool, PostgresGoatProxyRepository } from "../infrastructure/db/index.js";
import { GoatProxyTester } from "../integrations/index.js";
import { ProxyCredentialsCrypto } from "../proxies/index.js";
import { ProxyAdminService } from "../services/index.js";

const id = process.argv[2];
if (!id || !/^\d+$/u.test(id)) throw new Error("Usage: npm run proxy:test -- <proxy-id>");

const pool = createPostgresPool();
try {
  const service = new ProxyAdminService(new PostgresGoatProxyRepository(pool), new ProxyCredentialsCrypto(process.env.PARSER_PROXY_ENCRYPTION_KEY), new GoatProxyTester());
  const proxy = await service.test(id, "proxy-test-cli");
  console.info(`Proxy ${proxy.id} health=${proxy.healthStatus} latencyMs=${proxy.lastTestLatencyMs ?? "null"}`);
} finally {
  await pool.end();
}
