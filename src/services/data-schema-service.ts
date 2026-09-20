import type { SourceRepository } from "../repositories/index.js";

export interface DataFieldDefinition {
  readonly path: string;
  readonly rulePath: string | null;
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly example?: string;
  readonly source?: string;
  readonly transform?: string;
}

const commonFields: readonly DataFieldDefinition[] = [
  { path: "title", rulePath: "product.title", name: "Название", type: "строка", description: "Итоговое название товара.", example: "Nike Air Max 1 '86 OG" },
  { path: "description", rulePath: "product.description", name: "Описание", type: "строка", description: "Исходное описание товара без подмены историей бренда." },
  { path: "sku", rulePath: "product.sku", name: "Артикул", type: "строка", description: "Артикул товара из источника." },
  { path: "attributes.brand", rulePath: "product.attribute.brand", name: "Бренд источника", type: "строка", description: "Бренд до классификации.", example: "Nike" },
  { path: "attributes.family", rulePath: "product.attribute.family", name: "Семейство / силуэт", type: "строка", description: "Семейство модели, используемое как контекст.", example: "Air Max 1" },
  { path: "attributes.gender", rulePath: "product.attribute.gender", name: "Аудитория", type: "строка", description: "Аудитория источника; не является WordPress-термином сама по себе.", example: "men" },
  { path: "attributes.color", rulePath: "product.attribute.color", name: "Цвет", type: "строка", description: "Название расцветки источника." },
  { path: "attributes.story", rulePath: "product.attribute.story", name: "История", type: "строка", description: "Маркетинговая история. Хранится отдельно от description." },
  { path: "attributes.details", rulePath: "product.attribute.details", name: "Детали", type: "строка", description: "Дополнительные сведения о товаре." },
  { path: "attributes.upperMaterial", rulePath: "product.attribute.upperMaterial", name: "Материал верха", type: "строка", description: "Материал, заявленный источником." },
  { path: "attributes.midsole", rulePath: "product.attribute.midsole", name: "Технология подошвы", type: "строка", description: "Название технологии или материала межподошвы." },
  { path: "attributes.composition", rulePath: "product.attribute.composition", name: "Состав", type: "строка", description: "Состав товара из источника." },
  { path: "attributes.ageGroups", rulePath: "product.attribute.ageGroups", name: "Возрастные группы", type: "массив строк", description: "Возрастные группы источника." },
  { path: "attributes.categoryRaw", rulePath: "product.attribute.categoryRaw", name: "Маркетинговая категория", type: "строка", description: "Неструктурная категория источника." },
  { path: "attributes.productCategory", rulePath: "product.attribute.productCategory", name: "Категория товара", type: "строка", description: "Структурная категория источника." },
  { path: "attributes.productType", rulePath: "product.attribute.productType", name: "Тип товара", type: "строка", description: "Самый точный структурный тип товара." },
  { path: "attributes.taxonomy.taxonomyLevel1", rulePath: "product.attribute.taxonomy.taxonomyLevel1", name: "Таксономия, уровень 1", type: "строка", description: "Первый уровень дерева источника." },
  { path: "attributes.taxonomy.taxonomyLevel2", rulePath: "product.attribute.taxonomy.taxonomyLevel2", name: "Таксономия, уровень 2", type: "строка", description: "Второй уровень дерева источника." },
  { path: "attributes.taxonomy.taxonomyLevel3", rulePath: "product.attribute.taxonomy.taxonomyLevel3", name: "Таксономия, уровень 3", type: "строка", description: "Третий уровень дерева источника." },
  { path: "attributes.taxonomy.taxonomyLevel4", rulePath: "product.attribute.taxonomy.taxonomyLevel4", name: "Таксономия, уровень 4", type: "строка", description: "Четвёртый уровень дерева источника." },
  { path: "attributes.season", rulePath: "product.attribute.season", name: "Сезон источника", type: "строка", description: "Сезон только при наличии реального значения; год релиза сюда не переносится." },
  { path: "attributes.releaseDate", rulePath: "product.attribute.releaseDate", name: "Дата релиза", type: "строка", description: "Дата релиза, не сезон." },
  { path: "metadata.route", rulePath: "product.metadata.route", name: "Маршрут каталога", type: "строка", description: "Ветка discovery, например sneakers или apparel." },
  { path: "metadata.countryCode", rulePath: "product.metadata.countryCode", name: "Страна офферов", type: "строка", description: "Страна, для которой получены предложения." },
  { path: "referenceCandidates.*.sourceValue", rulePath: "candidate.{type}.sourceValue", name: "Кандидат справочника", type: "строка / массив", description: "Бренд, модель, категория, цвет, материал, технология или вид спорта до сопоставления." },
  { path: "referenceCandidates.*.context.brand", rulePath: "candidate.{type}.context.brand", name: "Контекст кандидата: бренд", type: "строка", description: "Бренд, уточняющий смысл кандидата модели или другого справочника." },
  { path: "referenceCandidates.*.context.family", rulePath: "candidate.{type}.context.family", name: "Контекст кандидата: семейство", type: "строка", description: "Семейство или силуэт, уточняющий модель." },
  { path: "referenceCandidates.*.context.audience", rulePath: "candidate.{type}.context.audience", name: "Контекст кандидата: аудитория", type: "строка", description: "Аудитория товара в контексте классификации." },
  { path: "referenceCandidates.*.context.productType", rulePath: "candidate.{type}.context.productType", name: "Контекст кандидата: тип", type: "строка", description: "Структурный тип товара в контексте кандидата." },
  { path: "referenceCandidates.*.context.productCategory", rulePath: "candidate.{type}.context.productCategory", name: "Контекст кандидата: категория", type: "строка", description: "Структурная категория в контексте кандидата." },
  { path: "referenceCandidates.*.context.route", rulePath: "candidate.{type}.context.route", name: "Контекст кандидата: маршрут", type: "строка", description: "Ветка discovery, в которой найден товар." },
  { path: "referenceCandidates.*.context.ageGroups", rulePath: "candidate.{type}.context.ageGroups", name: "Контекст кандидата: возраст", type: "массив строк", description: "Возрастные группы в контексте кандидата." },
  { path: "referenceCandidates.*.evidence.merchandisingCategory", rulePath: "candidate.{type}.evidence.merchandisingCategory", name: "Доказательство: категория", type: "строка", description: "Категория источника, сохранённая как доказательство классификации." },
  { path: "classification.resolved.*", rulePath: "resolved.{type}", name: "Сопоставленное значение", type: "массив", description: "Подтверждённые внутренние значения после старого классификатора." },
  { path: "variants[].size", rulePath: null, name: "Размер", type: "объект", description: "Исходный размер. Конвертация в WordPress остаётся отдельной логикой exporter-а." },
  { path: "variants[].price", rulePath: null, name: "Цена", type: "объект", description: "Decimal-строка и валюта без float." },
  { path: "variants[].inventory", rulePath: null, name: "Наличие", type: "объект", description: "Статус наличия и точное количество, только если источник его сообщил." },
  { path: "images[]", rulePath: null, name: "Изображения", type: "массив", description: "Исходные и опубликованные изображения с хешами." },
];

const goatFields: readonly DataFieldDefinition[] = [
  { path: "product.name", rulePath: "product.title", name: "Название", type: "строка", description: "Название GOAT.", source: "product", transform: "Копируется в title" },
  { path: "product.description", rulePath: "product.description", name: "Описание", type: "строка", description: "Описание GOAT.", source: "product", transform: "Копируется в description" },
  { path: "product.story", rulePath: "product.attribute.story", name: "История", type: "строка", description: "Отдельный маркетинговый текст.", source: "product", transform: "attributes.story" },
  { path: "product.brandName | brand", rulePath: "product.attribute.brand", name: "Бренд", type: "строка", description: "brandName имеет приоритет над brand.", source: "product", transform: "attributes.brand и candidate.brand" },
  { path: "product.silhouette", rulePath: "product.attribute.family", name: "Силуэт", type: "строка", description: "Контекст модели.", source: "product", transform: "attributes.family" },
  { path: "product.singleGender | gender", rulePath: "product.attribute.gender", name: "Пол / аудитория", type: "строка", description: "singleGender имеет приоритет.", source: "product", transform: "attributes.gender" },
  { path: "product.productType", rulePath: "product.attribute.productType", name: "Тип товара", type: "строка", description: "Первый приоритет структурной категории.", source: "product", transform: "category: productType → productCategory → route" },
  { path: "product.productCategory", rulePath: "product.attribute.productCategory", name: "Категория", type: "строка", description: "Второй приоритет структурной категории.", source: "product" },
  { path: "product.taxonomyLevel1..4", rulePath: "product.attribute.taxonomy.taxonomyLevel1", name: "Таксономия", type: "строки", description: "До четырёх уровней дерева GOAT.", source: "product", transform: "attributes.taxonomy" },
  { path: "product.technologies + midsole", rulePath: "candidate.tag.sourceValue", name: "Технологии", type: "массив", description: "midsole добавляется без дубля.", source: "product", transform: "tag candidates" },
  { path: "product.activity | activities | activitiesList", rulePath: "candidate.activity.sourceValue", name: "Вид спорта", type: "массив", description: "Объединяется с удалением дублей.", source: "product", transform: "activity candidates" },
  { path: "offers.offers[]", rulePath: null, name: "Предложения", type: "массив", description: "Источник размеров, цен и наличия.", source: "offers", transform: "variants[]; только new_no_defects" },
  { path: "offers.countryCode", rulePath: "product.metadata.countryCode", name: "Страна", type: "строка", description: "Страна предложений.", source: "offers", transform: "metadata.countryCode" },
];

export class DataSchemaService {
  constructor(private readonly sources: SourceRepository) {}

  async catalog() {
    const sources = await this.sources.listEnabled();
    return {
      version: "universal-product-dto.v1",
      common: { name: "Общий DTO", description: "Единая форма товара после SourceProcessor и до target exporter-а.", fields: commonFields },
      donors: sources.map((source) => ({ id: source.id, code: source.code, name: source.name,
        description: source.code === "goat" ? "Поля parts product и offers и их преобразование в общий DTO." : "Схема донора ещё не описана.",
        fields: source.code === "goat" ? goatFields : [] })),
      ruleFields: commonFields.filter((field) => field.rulePath !== null).map(({ rulePath, name, type, description }) => ({ path: rulePath!, name, type, description })),
    };
  }
}
