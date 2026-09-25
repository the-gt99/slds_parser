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
  { path: "source.code", rulePath: null, name: "Код донора", type: "строка", description: "Источник товара; его полные данные остаются в parts.", example: "goat" },
  { path: "source.productId", rulePath: null, name: "ID в парсере", type: "строка", description: "Внутренний идентификатор записи товара." },
  { path: "source.sourceKey", rulePath: null, name: "Ключ донора", type: "строка", description: "Стабильный ключ для поиска исходных данных." },
  { path: "source.externalId", rulePath: null, name: "Внешний ID", type: "строка или null", description: "ID товара у донора, если он есть." },
  { path: "title", rulePath: "product.title", name: "Название", type: "строка", description: "Исходное название товара." },
  { path: "description", rulePath: "product.description", name: "Описание", type: "строка", description: "Исходное описание. Перевод хранится отдельно." },
  { path: "sku", rulePath: "product.sku", name: "Артикул", type: "строка или null", description: "Артикул товара, если он есть." },
  { path: "characteristics.brand", rulePath: null, name: "Бренд", type: "строка или null", description: "Исходное название бренда, не термин WordPress." },
  { path: "characteristics.model", rulePath: null, name: "Модель", type: "строка или null", description: "Исходная модель, если её можно воспроизводимо выделить." },
  { path: "characteristics.family", rulePath: "product.attribute.family", name: "Семейство модели", type: "строка или null", description: "Линейка или семейство, сообщённое источником. Не заменяет конкретную модель и не выводится из названия.", example: "Air Max 1", source: "GOAT: product.silhouette", transform: "attributes.family → characteristics.family; отсутствует — null" },
  { path: "characteristics.category", rulePath: null, name: "Тип / категория товара", type: "строка или null", description: "Структурный тип товара источника, не категория WordPress. Отдельное поле productType в общем DTO не дублируется.", source: "GOAT: product.productType → product.productCategory → route", transform: "Первое непустое значение → candidate.category → characteristics.category" },
  { path: "characteristics.color", rulePath: null, name: "Цвет", type: "строка или null", description: "Исходное название цвета." },
  { path: "characteristics.material", rulePath: null, name: "Материал", type: "строка или null", description: "Материал, сообщённый источником." },
  { path: "characteristics.shoeHeight", rulePath: null, name: "Высота обуви", type: "строка или null", description: "Только воспроизводимо выделенная высота обуви; не выводится из названия в DTO-проекции." },
  { path: "characteristics.audience", rulePath: null, name: "Аудитория", type: "строка или null", description: "Аудитория как факт товара, не WP-термин." },
  { path: "characteristics.activities", rulePath: null, name: "Виды активности", type: "массив строк", description: "Только явно указанные источником виды активности, не выводятся из категории." },
  { path: "characteristics.ageGroups", rulePath: "product.attribute.ageGroups", name: "Возрастные группы", type: "массив строк", description: "Явно указанные источником возрастные группы. Не вычисляются из audience или размера. Пустой массив означает отсутствие данных.", source: "GOAT: product.ageGroups", transform: "attributes.ageGroups → characteristics.ageGroups; исходные строковые значения без подмены" },
  { path: "characteristics.tags", rulePath: null, name: "Метки источника", type: "массив строк", description: "Исходные технологии и метки; WP-назначения отдельно." },
  { path: "images[]", rulePath: null, name: "Изображения", type: "массив", description: "URL, подпись и порядок без локальных путей и хешей." },
  { path: "variants[].sourceVariantId", rulePath: null, name: "Ключ варианта", type: "строка", description: "Стабильный ключ варианта у источника." },
  { path: "variants[].sku", rulePath: null, name: "Артикул варианта", type: "строка или null", description: "Артикул варианта, если есть." },
  { path: "variants[].size", rulePath: null, name: "Размер", type: "объект", description: "Исходное значение и система размера. Конвертация в WP позже." },
  { path: "variants[].price", rulePath: null, name: "Цена", type: "объект или null", description: "Decimal-строка и валюта; null — цена неизвестна." },
  { path: "variants[].availability", rulePath: null, name: "Наличие", type: "строка", description: "available, unavailable, preorder или unknown." },
  { path: "variants[].quantity", rulePath: null, name: "Количество", type: "число или null", description: "Только подтверждённое количество; null не означает ноль." },
];

// Existing processing snapshots and rules v2 still address these v1 paths.
const legacyRuleFields: readonly DataFieldDefinition[] = [
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
  { path: "attributes.ageGroups", rulePath: "product.attribute.ageGroupsJoined", name: "Возрастные группы с порядком", type: "строка", description: "Для переноса старых точных правил исходный массив соединяется через | без изменения порядка." },
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
  { path: "product.sku", rulePath: "product.sku", name: "Артикул", type: "строка", description: "Пустое значение становится null в общем DTO.", source: "product", transform: "sku" },
  { path: "product.story", rulePath: "product.attribute.story", name: "История", type: "строка", description: "Отдельный маркетинговый текст.", source: "product", transform: "attributes.story" },
  { path: "product.brandName | brand", rulePath: "product.attribute.brand", name: "Бренд", type: "строка", description: "brandName имеет приоритет над brand.", source: "product", transform: "candidate.brand → characteristics.brand" },
  { path: "product.name + color", rulePath: "candidate.model.sourceValue", name: "Модель", type: "строка", description: "Название без подтверждённого конечного colorway.", source: "product", transform: "candidate.model → characteristics.model" },
  { path: "product.silhouette", rulePath: "product.attribute.family", name: "Силуэт", type: "строка", description: "Семейство модели; не конкретная модель.", source: "product", transform: "attributes.family → characteristics.family" },
  { path: "product.ageGroups", rulePath: "product.attribute.ageGroups", name: "Возрастные группы", type: "массив строк", description: "Возрастные группы независимо от пола/аудитории.", source: "product", transform: "attributes.ageGroups → characteristics.ageGroups" },
  { path: "product.singleGender | gender", rulePath: "product.attribute.gender", name: "Пол / аудитория", type: "строка", description: "singleGender имеет приоритет.", source: "product", transform: "attributes.gender → characteristics.audience" },
  { path: "product.productType", rulePath: "product.attribute.productType", name: "Тип товара", type: "строка", description: "Первый приоритет структурной категории.", source: "product", transform: "category: productType → productCategory → route → characteristics.category" },
  { path: "product.productCategory", rulePath: "product.attribute.productCategory", name: "Категория", type: "строка", description: "Второй приоритет структурной категории.", source: "product" },
  { path: "product.taxonomyLevel1..4", rulePath: "product.attribute.taxonomy.taxonomyLevel1", name: "Таксономия", type: "строки", description: "До четырёх уровней дерева GOAT.", source: "product", transform: "attributes.taxonomy" },
  { path: "product.color", rulePath: "product.attribute.color", name: "Цвет", type: "строка", description: "Исходное название цвета.", source: "product", transform: "candidate.color → characteristics.color" },
  { path: "product.upperMaterial", rulePath: "product.attribute.upperMaterial", name: "Материал", type: "строка", description: "Материал верха.", source: "product", transform: "candidate.material → characteristics.material" },
  { path: "product.technologies + midsole", rulePath: "candidate.tag.sourceValue", name: "Технологии", type: "массив", description: "midsole добавляется без дубля.", source: "product", transform: "tag candidates → characteristics.tags" },
  { path: "product.tags", rulePath: "candidate.tag.sourceValue", name: "Метки", type: "массив", description: "Исходные метки без WP-назначений.", source: "product", transform: "tag candidates → characteristics.tags" },
  { path: "product.images", rulePath: null, name: "Изображения", type: "массив", description: "URL и порядок изображений.", source: "product", transform: "images[]" },
  { path: "product.activity | activities | activitiesList", rulePath: "candidate.activity.sourceValue", name: "Вид спорта", type: "массив", description: "Объединяется с удалением дублей.", source: "product", transform: "activity candidates" },
  { path: "offers.offers[]", rulePath: null, name: "Предложения", type: "массив", description: "Источник размеров, цен и наличия.", source: "offers", transform: "variants[]; только new_no_defects" },
  { path: "offers.countryCode", rulePath: "product.metadata.countryCode", name: "Страна", type: "строка", description: "Страна предложений.", source: "offers", transform: "metadata.countryCode" },
];

export class DataSchemaService {
  constructor(private readonly sources: SourceRepository) {}

  async listSources() {
    return (await this.sources.listEnabled()).map((source) => ({
      sourceId: source.id,
      code: source.code,
      name: source.name,
      adapterCode: source.adapterCode,
      enabled: source.enabled,
    }));
  }

  async catalog() {
    const sources = await this.sources.listEnabled();
    return {
      version: "common-product-dto.v1.1",
      common: { name: "Общий DTO", description: "Компактный общий контракт товара. В карточке товара доступен как commonDto.", fields: commonFields },
      legacy: { name: "Служебные поля v1", description: "Действующие пути обработки и правил v2. Не входят в общий контракт; сохранены для совместимости.", fields: legacyRuleFields },
      donors: sources.map((source) => ({ id: source.id, code: source.code, name: source.name,
        description: source.code === "goat" ? "Поля parts product и offers и их преобразование в общий DTO." : "Схема донора ещё не описана.",
        fields: source.code === "goat" ? goatFields : [] })),
      ruleFields: legacyRuleFields.filter((field) => field.rulePath !== null).map(({ rulePath, name, type, description }) => ({ path: rulePath!, name, type, description })),
      v2RuleFields: [
        ...commonFields.filter((field) => !["images[]", "variants[].size", "variants[].price"].includes(field.path))
          .map((field) => ({ path: `common.${field.path.replaceAll("[]", ".*")}`, name: `Общий DTO: ${field.name}`, type: field.type, description: field.description })),
        ...legacyRuleFields.filter((field) => field.rulePath?.startsWith("product.attribute.") || field.rulePath?.startsWith("product.metadata.") || field.rulePath?.startsWith("product.fact."))
          .map(({ rulePath, name, type, description }) => ({ path: rulePath!, name: `Данные донора: ${name}`, type, description })),
      ],
    };
  }
}
