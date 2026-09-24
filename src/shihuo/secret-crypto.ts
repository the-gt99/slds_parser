import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

function decodeKey(raw: string | undefined): Buffer {
  const value = raw?.trim() ?? "";
  if (value === "") throw new Error("PARSER_PROXY_ENCRYPTION_KEY is required for Shihuo device secrets");
  const key = /^[0-9a-f]{64}$/iu.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("PARSER_PROXY_ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}

export class ShihuoSecretCrypto {
  readonly #key: Buffer;
  constructor(rawKey: string | undefined) { this.#key = decodeKey(rawKey); }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
  }

  decrypt(value: string): string {
    const [version, iv, tag, ciphertext] = value.split(":");
    if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error("Shihuo secret ciphertext is invalid");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  }
}
