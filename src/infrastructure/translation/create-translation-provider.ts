import type { loadProcessingConfig } from "../../config/processing-config.js";
import type { TextTranslationProvider } from "../../processing/content/text-translation-provider.js";
import { DeepLTranslationProvider } from "./deep-l-translation-provider.js";
import { LegacyGoogleTranslationProvider } from "./legacy-google-translation-provider.js";
import { OpenRouterTranslationProvider } from "./openrouter-translation-provider.js";

export function createTranslationProvider(options: ReturnType<typeof loadProcessingConfig>["translation"]): TextTranslationProvider {
  switch (options.provider) {
    case "deepl": return new DeepLTranslationProvider(options);
    case "google": return new LegacyGoogleTranslationProvider(options);
    case "openrouter": return new OpenRouterTranslationProvider(options);
  }
}
