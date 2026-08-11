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
  navy: "Темно-синий",
  sail: "Парусный",
  cream: "Кремовый",
  ivory: "Айвори",
  "off white": "Молочный",
  "off-white": "Молочный",
  "summit white": "Саммит Вайт",
  "photon dust": "Фотон Даст",
  "university red": "Юниверсити Ред",
  flymesh: "Флаймеш",
  flyweave: "Флайвив",
  ndure: "Эн-Дьюр",
  intelliknit: "ИнтеллиКнит",
  synthetic: "Синтетика",
  knit: "Трикотаж",
  mesh: "Сетка",
  leather: "Кожа",
  suede: "Замша",
  textile: "Текстиль",
  canvas: "Холст",
  nubuck: "Нубук",
  nylon: "Нейлон",
  rubber: "Резина",
  polyester: "Полиэстер",
  neoprene: "Неопрен",
  cotton: "Хлопок",
  denim: "Деним",
  flyknit: "Флайкнит",
  primeknit: "Праймкнит",
  "gore-tex": "Гор-Текс",
  "patent leather": "Лакированная кожа",
  "core black": "Черный",
  "cloud white": "Белый",
  "footwear white": "Белый",
  "metallic silver": "Серебристый металлик",
  "silver metallic": "Серебристый металлик",
  "wolf grey": "Серый",
  carbon: "Карбон",
  "midnight navy": "Темно-синий",
  gum: "Каучуковый",
  "gold metallic": "Золотой металлик",
  "metallic gold": "Золотой металлик",
  "true white": "Белый",
  "team red": "Красный",
  milk: "Молочный",
  "gym red": "Красный",
  "team orange": "Оранжевый",
  "racer blue": "Синий",
  bone: "Светло-бежевый",
  "light bone": "Светло-бежевый",
  "university blue": "Университетский синий",
  "total orange": "Оранжевый",
  "armory navy": "Темно-синий",
  blk: "Черный",
  "ttl orng": "Оранжевый",
  "brght crmsn": "Малиновый",
  "grn glow": "Зеленый",
  "prpl dynsty": "Фиолетовый",
  "mtllc gold": "Золотой",
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

function dictionaryKey(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/gu, " ");
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
  readonly version = "1.2.0";
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
    const story = attribute(product, "story");
    const color = attribute(product, "color");
    const details = attribute(product, "details");
    const upperMaterial = attribute(product, "upperMaterial");

    const translatedDescription = await this.translateVerified("description", description);
    const translatedStory = story !== "" && story === description
      ? translatedDescription
      : await this.translateVerified("story", story);

    return {
      ...product,
      translatedContent: {
        sourceLocale: this.options.sourceLocale,
        targetLocale: this.options.targetLocale,
        description: translatedDescription,
        story: translatedStory,
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
    const direct = ATTRIBUTE_TRANSLATIONS[dictionaryKey(source)];
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
      translated.push(await this.translatePassiveSegment(part.trim()));
    }
    return translated.join("").trim();
  }

  async translatePassiveSegment(source: string): Promise<string> {
    const direct = ATTRIBUTE_TRANSLATIONS[dictionaryKey(source)];
    if (direct !== undefined) return direct;
    const parts = source.split(/(\s*-\s*)/u);
    if (parts.length <= 1) return await this.translateText(source);
    const translated: string[] = [];
    for (const part of parts) {
      if (part === "") continue;
      if (/^\s*-\s*$/u.test(part)) {
        translated.push(" - ");
        continue;
      }
      translated.push(await this.translateText(part.trim()));
    }
    return translated.join("").trim();
  }

  async translateText(source: string): Promise<string> {
    const dictionary = ATTRIBUTE_TRANSLATIONS[dictionaryKey(source)];
    return dictionary ?? await this.provider.translate(source, this.options.sourceLocale, this.options.targetLocale);
  }
}
