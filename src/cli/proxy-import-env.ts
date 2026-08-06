import { createPostgresPool, PostgresGoatProxyRepository } from "../infrastructure/db/index.js";
import { ProxyCredentialsCrypto, type ProxyProtocol } from "../proxies/index.js";
import { validateProxyHost } from "../services/index.js";

function envProxy(): { readonly protocol: ProxyProtocol; readonly value: string } | null {
  const http = process.env.GOAT_PROXY_HTTP?.trim() || process.env.GOAT_HTTP_PROXY?.trim();
  const socks5 = process.env.GOAT_PROXY_SOCKS5?.trim() || process.env.GOAT_SOCKS5_PROXY?.trim();
  if (http && socks5) throw new Error("Only one GOAT proxy env value can be imported");
  if (http) return { protocol: "http", value: http };
  if (socks5) return { protocol: "socks5", value: socks5 };
  return null;
}

function parseProxy(protocol: ProxyProtocol, value: string): { readonly host: string; readonly port: number; readonly username?: string; readonly password?: string } {
  const parsed = new URL(value);
  const expected = protocol === "socks5" ? ["socks5:", "socks5h:"] : ["http:", "https:"];
  if (!expected.includes(parsed.protocol)) throw new Error("Env proxy protocol does not match selected import source");
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") throw new Error("Env proxy URL must not contain path, query or fragment");
  const host = validateProxyHost(parsed.hostname);
  const port = Number(parsed.port || (protocol === "http" && parsed.protocol === "https:" ? 443 : 0));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Env proxy URL must contain a valid port");
  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  return { host, port, ...(username === "" && password === "" ? {} : { username, password }) };
}

const imported = envProxy();
if (imported === null) {
  console.info("No GOAT proxy env value found");
  process.exit(0);
}

const name = process.env.GOAT_PROXY_IMPORT_NAME?.trim() || "production-env";
const parsed = parseProxy(imported.protocol, imported.value);
const crypto = new ProxyCredentialsCrypto(process.env.PARSER_PROXY_ENCRYPTION_KEY);
const pool = createPostgresPool();
try {
  const repository = new PostgresGoatProxyRepository(pool);
  const ciphertext = parsed.username === undefined ? null : crypto.encrypt({ username: parsed.username, password: parsed.password ?? "" });
  const existing = await repository.findByName(name);
  const record = existing === null
    ? await repository.create({ name, protocol: imported.protocol, host: parsed.host, port: parsed.port, credentialsCiphertext: ciphertext, enabled: false })
    : await repository.update(existing.id, { protocol: imported.protocol, host: parsed.host, port: parsed.port, credentialsCiphertext: ciphertext });
  await repository.audit({ proxyId: record.id, action: existing === null ? "create" : "update", actor: "proxy-import-env", payload: { name: record.name, protocol: record.protocol, host: record.host, port: record.port, hasCredentials: record.credentialsCiphertext !== null } });
  console.info(`Imported GOAT proxy record ${record.id}; enabled=false`);
} finally {
  await pool.end();
}
