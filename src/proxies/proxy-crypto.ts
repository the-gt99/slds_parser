import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { PermanentError } from "../core/errors/index.js";
import type { ProxyCredentials } from "./types.js";

const VERSION = "v1";

function decodeKey(raw: string | undefined): Buffer {
  const value = raw?.trim() ?? "";
  if (value === "") throw new PermanentError("PARSER_PROXY_ENCRYPTION_KEY is required for proxy credentials", { code: "INVALID_PROXY_CONFIG" });
  const key = /^[0-9a-f]{64}$/iu.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) throw new PermanentError("PARSER_PROXY_ENCRYPTION_KEY must decode to 32 bytes", { code: "INVALID_PROXY_CONFIG" });
  return key;
}

export class ProxyCredentialsCrypto {
  readonly #key: Buffer;

  constructor(key: string | undefined) {
    this.#key = decodeKey(key);
  }

  encrypt(credentials: ProxyCredentials): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(credentials), "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
  }

  decrypt(value: string): ProxyCredentials {
    const [version, iv, tag, ciphertext] = value.split(":");
    if (version !== VERSION || !iv || !tag || !ciphertext) throw new PermanentError("Proxy credentials ciphertext is invalid", { code: "INVALID_PROXY_SECRET" });
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const json = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(json) as Partial<ProxyCredentials>;
    if (typeof parsed.username !== "string" || typeof parsed.password !== "string") {
      throw new PermanentError("Proxy credentials payload is invalid", { code: "INVALID_PROXY_SECRET" });
    }
    return { username: parsed.username, password: parsed.password };
  }
}

export function proxyCredentialsCryptoFromEnv(environment: { readonly PARSER_PROXY_ENCRYPTION_KEY?: string }): ProxyCredentialsCrypto {
  return new ProxyCredentialsCrypto(environment.PARSER_PROXY_ENCRYPTION_KEY);
}
