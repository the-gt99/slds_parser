import { createHash } from "node:crypto";

import type { TextTranslationProvider } from "../../processing/index.js";
import type { SqlExecutor } from "../db/sql-executor.js";

interface CacheKey {
  readonly providerCode: string;
  readonly providerVersion: string;
  readonly sourceLocale: string;
  readonly targetLocale: string;
  readonly sourceHash: string;
  readonly sourceText: string;
}

export interface TranslationCacheRepository {
  find(key: CacheKey): Promise<string | null>;
  save(key: CacheKey, translatedText: string): Promise<string>;
}

interface CacheRow {
  readonly source_text: string;
  readonly translated_text: string;
}

export class PostgresTranslationCacheRepository implements TranslationCacheRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async find(key: CacheKey): Promise<string | null> {
    const result = await this.executor.query<CacheRow>(
      `SELECT source_text, translated_text
       FROM translation_cache
       WHERE provider_code = $1 AND provider_version = $2
         AND source_locale = $3 AND target_locale = $4 AND source_hash = $5`,
      [key.providerCode, key.providerVersion, key.sourceLocale, key.targetLocale, key.sourceHash],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (row.source_text !== key.sourceText) throw new Error("Translation cache hash collision detected");
    return row.translated_text;
  }

  async save(key: CacheKey, translatedText: string): Promise<string> {
    const result = await this.executor.query<CacheRow>(
      `INSERT INTO translation_cache (
         provider_code, provider_version, source_locale, target_locale,
         source_hash, source_text, translated_text
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (provider_code, provider_version, source_locale, target_locale, source_hash)
       DO UPDATE SET last_used_at = NOW(), hit_count = translation_cache.hit_count + 1
       RETURNING source_text, translated_text`,
      [key.providerCode, key.providerVersion, key.sourceLocale, key.targetLocale, key.sourceHash, key.sourceText, translatedText],
    );
    const row = result.rows[0];
    if (row === undefined || row.source_text !== key.sourceText) throw new Error("Translation cache hash collision detected");
    return row.translated_text;
  }
}

export class CachedTranslationProvider implements TextTranslationProvider {
  readonly code: string;
  readonly version: string;
  readonly #inFlight = new Map<string, Promise<string>>();
  readonly #memory = new Map<string, string>();

  constructor(
    private readonly delegate: TextTranslationProvider,
    private readonly cache: TranslationCacheRepository,
  ) {
    this.code = delegate.code;
    this.version = delegate.version;
  }

  async translate(text: string, sourceLocale: string, targetLocale: string): Promise<string> {
    const key: CacheKey = {
      providerCode: this.code,
      providerVersion: this.version,
      sourceLocale,
      targetLocale,
      sourceHash: createHash("sha256").update(text, "utf8").digest("hex"),
      sourceText: text,
    };
    const inFlightKey = [this.code, this.version, sourceLocale, targetLocale, key.sourceHash].join(":"),
      remembered = this.#memory.get(inFlightKey);
    if (remembered !== undefined) return remembered;
    const cached = await this.cache.find(key);
    if (cached !== null) {
      this.remember(inFlightKey, cached);
      return cached;
    }
    const existing = this.#inFlight.get(inFlightKey);
    if (existing !== undefined) return await existing;
    const pending = this.delegate.translate(text, sourceLocale, targetLocale)
      .then(async (translated) => {
        const saved = await this.cache.save(key, translated);
        this.remember(inFlightKey, saved);
        return saved;
      })
      .finally(() => this.#inFlight.delete(inFlightKey));
    this.#inFlight.set(inFlightKey, pending);
    return await pending;
  }

  private remember(key: string, value: string): void {
    if (this.#memory.size >= 10_000) {
      const oldest = this.#memory.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#memory.delete(oldest);
    }
    this.#memory.set(key, value);
  }
}
