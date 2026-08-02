import type {
  JsonValue,
  ProductOperation,
  UniversalProductDTO,
} from "../../contracts/index.js";
import { IntegrationContractError } from "../../core/errors/index.js";
import type { TextTranslationProvider } from "../content/index.js";

const ATTRIBUTE_TRANSLATIONS: Readonly<Record<string, string>> = {
  black: "Черный",
  white: "Белый",
  blue: "Синий",
  green: "Зеленый",
  red: "Красный",
  grey: "Серый",
  gray: "Серый",
  brown: "Коричневый",
  beige: "Бежевый",
  pink: "Розовый",
  orange: "Оранжевый",
  yellow: "Желтый",
  purple: "Фиолетовый",
  violet: "Фиолетовый",
  "multi-color": "Многоцветный",
  multicolor: "Многоцветный",
  "multi color": "Многоцветный",
  gold: "Золотой",
  silver: "Серебристый",
  lime: "Лайм",
  navy: "Флот",
};

export interface TranslateContentOperationOptions {
  readonly sourceLocale: string;
  readonly targetLocale: string;
  readonly sourceCodes?: readonly string[];
}

function attribute(product: UniversalProductDTO, key: string): string {
  const value = product.attributes[key];
  return typeof value === "string" ? value : "";
}

function containsLatin(value: string): boolean {
  return /[A-Za-z]/u.test(value);
}

function containsCyrillic(value: string): boolean {
  return /[А-Яа-яЁё]/u.test(value);
}

function normalizeComparison(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function suspiciousTranslation(source: string, translated: string): boolean {
  const normalizedSource = normalizeComparison(source);
  const normalizedTranslation = normalizeComparison(translated);
  if (normalizedSource === "" || normalizedTranslation === "" || normalizedSource === normalizedTranslation) return true;
  if (containsCyrillic(normalizedTranslation)) return false;
  return containsLatin(normalizedTranslation);
}

export class TranslateContentOperation implements ProductOperation {
  readonly code = "translate-content";
  readonly name = "Перевод контента";
  readonly version = "1.0.0";
  readonly dependsOn = ["normalize-product"];
  readonly sourceCodes?: readonly string[];
  readonly configurationFingerprint: JsonValue;

  constructor(
    private readonly provider: TextTranslationProvider,
    private readonly options: TranslateContentOperationOptions,
  ) {
    if (options.sourceCodes !== undefined) this.sourceCodes = options.sourceCodes;
    this.configurationFingerprint = {
      provider: provider.code,
      providerVersion: provider.version,
      sourceLocale: options.sourceLocale,
      targetLocale: options.targetLocale,
    };
  }

  async execute(product: UniversalProductDTO): Promise<UniversalProductDTO> {
    const description = product.description;
    const story = attribute(product, "story") || description;
    const color = attribute(product, "color");
    const details = attribute(product, "details");
    const upperMaterial = attribute(product, "upperMaterial");

    return {
      ...product,
      translatedContent: {
        sourceLocale: this.options.sourceLocale,
        targetLocale: this.options.targetLocale,
        description: await this.translateVerified("description", description),
        story: await this.translateVerified("story", story),
        color: await this.translateVerified("color", color),
        details: await this.translateVerified("details", details),
        upperMaterial: await this.translateVerified("upperMaterial", upperMaterial),
      },
    };
  }

  async translateVerified(field: string, source: string): Promise<string> {
    if (source === "") return "";
    const translated = ["color", "details", "upperMaterial"].includes(field)
      ? await this.translatePassiveAttribute(source)
      : await this.translateText(source);
    const result = translated.trim();
    if (result === "") throw new IntegrationContractError(`Translation returned an empty ${field}`);
    if (field === "details") return result;
    if (containsLatin(source) && !containsCyrillic(source) && suspiciousTranslation(source, result)) {
      throw new IntegrationContractError(`Translation verification failed for ${field}`);
    }
    if (field === "color" && containsLatin(result)) {
      throw new IntegrationContractError("Translation verification failed for color");
    }
    return result;
  }

  async translatePassiveAttribute(source: string): Promise<string> {
    const direct = ATTRIBUTE_TRANSLATIONS[source.toLowerCase()];
    if (direct !== undefined) return direct;
    const parts = source.split(/(\s*[\/,;|]\s*)/u);
    if (parts.length <= 1) return await this.translateText(source);
    const translated: string[] = [];
    for (const part of parts) {
      if (part === "") continue;
      if (/^\s*[\/,;|]\s*$/u.test(part)) {
        const delimiter = part.trim();
        translated.push(delimiter === "/" ? "/ " : `${delimiter} `);
        continue;
      }
      translated.push(await this.translateText(part.trim()));
    }
    return translated.join("").trim();
  }

  async translateText(source: string): Promise<string> {
    const dictionary = ATTRIBUTE_TRANSLATIONS[source.toLowerCase()];
    return dictionary ?? await this.provider.translate(source, this.options.sourceLocale, this.options.targetLocale);
  }
}
