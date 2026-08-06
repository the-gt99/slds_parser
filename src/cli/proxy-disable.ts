import { createPostgresPool, PostgresGoatProxyRepository } from "../infrastructure/db/index.js";
import { GoatProxyTester } from "../integrations/index.js";
import { ProxyCredentialsCrypto } from "../proxies/index.js";
import { ProxyAdminService } from "../services/index.js";

const id = process.argv[2];
if (!id || !/^\d+$/u.test(id)) throw new Error("Usage: npm run proxy:disable -- <proxy-id>");

const pool = createPostgresPool();
try {
  const service = new ProxyAdminService(new PostgresGoatProxyRepository(pool), new ProxyCredentialsCrypto(process.env.PARSER_PROXY_ENCRYPTION_KEY), new GoatProxyTester());
  const proxy = await service.disable(id, "proxy-disable-cli");
  console.info(`Proxy ${proxy.id} enabled=${proxy.enabled}`);
} finally {
  await pool.end();
}
