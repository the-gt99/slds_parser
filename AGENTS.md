# SLDS Parser: рабочий контекст проекта

Этот файл — основная память проекта для следующих сессий. Перед изменениями сверяй его с кодом, `README.md`, актуальным `git status`, production jobs и последними миграциями. Снимки состояния и номера коммитов ниже относятся к 6 августа 2026 года и со временем могут устареть.

## Цель

Нужен универсальный конвейер товарных данных, к которому можно подключать разные источники и targets без переписывания ядра:

1. обнаружить и полностью собрать товары источника;
2. преобразовать данные в единый внутренний DTO и выполнить независимые операции обработки;
3. классифицировать значения относительно внутренних и target-справочников;
4. идемпотентно создать или обновить товар на target.

Первая рабочая вертикаль: `GOAT → SLDS Parser → WordPress/WooCommerce slamdunk.shop`.

Проект ещё не закончен. Сбор, обработка, классификатор, административная наблюдаемость, WordPress exporter и `slds.wordpress.product-upsert.v1` уже развёрнуты. Реальный update существующего WooCommerce-товара прошёл успешно и подтвердил идемпотентность повторного экспорта. Главный незакрытый блок теперь не deployment, а бизнес-правила и безопасное масштабирование: sold-out write без offers, коллаборации с несколькими брендами, политика обогащения материалами и формирование правил классификатора на растущих выборках.

## Принципиальные архитектурные границы

Конвейер выглядит так:

`SourceAdapter → сохранённые parts → SourceProcessor → UniversalProductDTO → ProductOperation[] → ProductClassifier → TargetExporter`

Переходы между крупными этапами выполняются через PostgreSQL jobs, а не прямыми вызовами.

- `SourceAdapter` знает протокол конкретного источника: discovery и запросы частей товара.
- `SourceProcessor` знает форму данных источника и переводит сохранённые parts в универсальный DTO. Он не имеет доступа к mappings и target.
- `ProductOperation` получает только универсальный DTO и контекст. Универсальная операция не должна импортировать GOAT или WordPress.
- `ProductClassifier` работает только с универсальными `referenceCandidates`, mappings и правилами. Он не знает поля GOAT и таксономии WordPress.
- `TargetDictionaryProvider` описывает справочники и возможности конкретного target.
- `TargetExporter` отвечает за target payload, создание/обновление и идемпотентность внешнего вызова.

Не переносить target-логику в обработку и не возвращать mappings в `SourceProcessor`. Не добавлять source-specific поля в ядро ради одного сайта.

Новый источник должен требовать адаптер, процессор, регистрацию компонентов и, возможно, собственные правила — но не изменение классификатора. Новый target должен подключаться provider/exporter-адаптерами.

## Почему Node.js

Основной проект написан на Node.js 22, TypeScript и ESM. Причина — большое количество независимого асинхронного I/O и удобное масштабирование worker-процессами.

Успешный PHP/cURL-код старого проекта не является причиной сохранять PHP-архитектуру. Для обхода защиты GOAT Node.js запускает внешний `curl-impersonate`; Playwright и парсинг DOM не являются основным путём.

## Что реализовано

### Ядро и хранение

- универсальные контракты адаптеров, процессоров, операций и exporters;
- PostgreSQL repositories и короткие `UnitOfWork`-транзакции;
- jobs `discover_source`, `collect_product`, `process_product`, `export_product`;
- retry только для явно повторяемых ошибок, exponential backoff и восстановление просроченных locks;
- реестры компонентов и явная регистрация в `src/bootstrap.ts`;
- стабильные input/content hashes и версии компонентов;
- миграции `001`–`014`;
- история выполнения каждой операции в `product_operation_executions`.

### GOAT

- discovery через sitemap для sneakers и apparel;
- DOM страниц не разбирается;
- товар собирается двумя частями: `product` и `offers`;
- сохраняются полный raw payload и проверенное parsed-представление;
- cents преобразуются в decimal-строки без float;
- размеры остаются строками;
- stock status преобразуется в универсальную доступность;
- основная, Instant Ship и last sold цены сохраняются без выдуманных значений;
- транспорт использует `curl-impersonate`, cookie jar и один HTTP- либо SOCKS5-proxy.

Дедупликация товара основана на идентичности источника и `sourceKey`; части upsert-ятся по товару и `partKey`. Варианты имеют стабильный `sourceVariantKey`.

### Операции обработки

Сейчас зарегистрированы шесть операций:

1. нормализация товара;
2. перевод контента;
3. скачивание изображений;
4. проверка и конвертация изображений в WebP;
5. публикация публичных URL изображений;
6. финальная проверка обработанного DTO.

Операция — отдельный файл с `code`, `name`, `version`, опциональными `dependsOn`, `sourceCodes` и `configurationFingerprint`, плюс одна явная регистрация. Наличие файла само по себе ничего не включает.

Пустые media и offers допустимы во внутреннем DTO: товар только с GOAT placeholder сохраняется с `images: []`, товар без offers — с `variants: []`. Нельзя выдумывать изображение, размер, остаток или цену. WordPress exporter отдельно блокирует оба случая до внешнего HTTP-вызова, пока соответствующие target-контракты не согласованы.

Worker использует отдельные lane-группы для discovery, collection, processing и export. Production сейчас настроен на три collection lane и четыре processing lane. Collection lane сначала резервирует healthy enabled proxy session и только затем забирает job; без свободного прокси job остаётся pending. Product и offers одного collect attempt закреплены за одним proxy/client/cookie jar. GOAT image downloader использует тот же пул, общий лимит и раздельные cookie jars. Несколько полных worker-процессов не запускать.

Управляемый GOAT proxy pool хранится в PostgreSQL с AES-256-GCM шифрованием credentials. Runtime использует только repository/pool при `GOAT_PROXY_POOL_ENABLED=true`; старые env proxy оставлены только для явного rollback. Админка `/proxies` позволяет создавать, проверять, включать и выключать прокси. Public API не возвращает credentials или ciphertext.

HTML-описание магазина намеренно не является универсальной операцией: его нужно формировать при сборке WordPress payload.

Публичные URL изображений пока оставлены, чтобы WordPress мог скачать WebP. В `src/bootstrap.ts` есть `TODO`: когда exporter будет готов, подтвердить способ передачи файлов. Если WordPress принимает upload напрямую, удалить `publish-images` и зависимость от `PARSER_PUBLIC_BASE_URL`, а exporter должен использовать `webpLocalPath`.

### Классификатор

Реализованы:

- точные source mappings с контекстом;
- внутренние справочные значения;
- target mappings;
- правила `equals`, `contains`, `all_words`, `regex`;
- preview правил и обнаружение конфликтов;
- состояния `unresolved`, `ambiguous`, `resolved`, `ignored`;
- точечная постановка затронутых товаров на повторную обработку;
- аудит решений и создания WordPress-терминов;
- минималистичный интерфейс очереди.

Проблема старого классификатора состояла в склейке одинакового сырого слова без товарного контекста. Например, `Pegasus` встречался в разных Nike-моделях, а `Surge` — в Under Armour Surge Golf и Surge 4. Решение — контекстные правила по бренду, семейству, полному названию и другим evidence, а не глобальный mapping по одному слову.

GOAT сейчас выдаёт в классификатор только реальные target-кандидаты:

- бренд;
- название без конечной GOAT-расцветки как кандидат модели, с брендом и семейством в контексте;
- категория;
- цвет;
- материал;
- технологии из `technologies`/`midsole` как метки;
- source tags, если они присутствуют;
- назначение только из явного `activitiesList`/`activities`.

Для модели нельзя использовать голое `silhouette`: `Pegasus` и `Surge` слишком широки. Нельзя использовать и полный title вместе с расцветкой: тогда `YZY SL-01 'Black'` и `YZY SL-01 'White'` становятся разными моделями. GOAT processor удаляет только подтверждённый конечный colorway по полю `color`; полный title и `silhouette` остаются в evidence. Так расцветки одной модели группируются, а Surge Golf и Surge 4 остаются разными значениями.

`categoryRaw` нельзя автоматически превращать в `activity` или `tag`: `Lifestyle` и особенно `Sandal` не являются доказанным видом спорта. Один source-факт не нужно без подтверждённого требования дублировать сразу в несколько target-смыслов.

Следующие данные являются обычными фактами DTO или evidence и не должны засорять очередь:

- размер и система размеров;
- наличие и цены;
- состояние товара и коробки;
- пол/аудитория;
- `silhouette`/семейство;
- дата релиза;
- GOAT `season`, если там фактически год коллекции.

Пол нужен как evidence при выборе категории. Семейство нужно как evidence модели. Размеры преобразуются отдельной логикой, а не классифицируются вручную. `season: 2023` у GOAT — год коллекции, не `зима/лето`; не сопоставлять его с `pa_season`.

Добавлять `shoe_height` или настоящий сезон в очередь можно только после появления воспроизводимого правила извлечения из данных источника. `activity` допускается только из явного source-поля назначения. Сам механизм и WordPress-справочники для них уже готовы.

### HTTP API и интерфейс

- Fastify API слушает только `127.0.0.1:3000`, наружу его публикует Nginx;
- административная сессия, bearer-доступ, CSRF и отдельное разрешение `wordpress:create`;
- интерфейс классификатора доступен по `/classifier`;
- общее меню связывает классификатор, товары, операции и WordPress snapshots;
- `/products` — общий реестр с поиском, пагинацией и фильтрами по source, стадии, классификации и target status;
- `/operations` — runtime-реестр всех зарегистрированных `ProductOperation`;
- `/wordpress-snapshots` — реестр сохранённых снимков WordPress;
- типы фильтра берутся из реальных наблюдений и имён PostgreSQL, а не из JavaScript-константы;
- список WordPress-возможностей приходит от target provider;
- примеры товаров в классификаторе ведут на `/products/:sourceProductId`;
- карточка показывает identity, raw/parsed parts, DTO процессора, выход каждой операции, итоговый classified DTO, WordPress snapshot, target attempts, donor URL и WordPress edit URL;
- строки классификации в карточке показывают активные основные и дополнительные назначения WordPress; нерешённое значение открывается в точной группе очереди по `context_key`, а принятое решение и его projections — в соответствующей записи настроек;
- processing attempt, DTO процессора и выходы операций записываются транзакционно; старые обработки до миграции `013` не реконструируются;
- WordPress preview использует общий `buildWordPressUpsertPayload` и реальный read-only preflight, записывающие endpoints для preview не вызываются;
- API карточки не отдаёт локальные пути изображений.

Наблюдаемость реализована в parser commit `2116833` и исправлена commit `343fe13`. Проверены `/classifier`, `/products`, `/operations`, `/wordpress-snapshots` и `/products/:id`.

Preview сравнивает `title`, `slug`, `sku`, taxonomies, вариации, `description_html`, `short_description_html` и identity/URL изображений. Длинное описание показывается безопасно отрендеренным до/после merge. Краткое описание не входит в managed fields нового parser и отображается как сохраняемое без изменений. WordPress snapshot отдаёт description fields, attachment `import_name` и `source_url`. Перед write всё равно нужно просматривать полный diff.

Точечную ручную обработку на production нельзя запускать от `root`: каталог media тогда получает владельца `root`, и Nginx отвечает `403`, хотя файл существует. Разовые processing-команды должны работать от пользователя `slds-parser`, как штатный worker.

## WordPress/WooCommerce target

Подтверждённые соответствия сайта:

| Универсальный смысл | WordPress |
|---|---|
| Бренд | `pa_brand` |
| Модель | `pa_model` |
| Категории | `product_cat` |
| Метки | `product_tag` |
| Цвет | `pa_tsvet` |
| Материал | `pa_material` |
| Вид спорта / назначение | `pa_vid` |
| Высота обуви | `pa_shoe_height` |
| Сезон | `pa_season` |
| Размер | в основном `pa_razmer`, endpoint также видит `pa_size` |

Дата релиза на сайте не является сезоном: она участвует в описании и `filter_data_v2` как release date/year.

WordPress dictionary endpoint умеет читать `brands`, `models`, `tags`, `sizes`, `shoe_heights`, `product_categories`, `colors`, `materials`, `seasons`, `activities`.

Создание из интерфейса разрешено только для брендов, моделей, тегов и категорий. Цвета и некоторые другие термины имеют дополнительные метаданные; не создавать неполные записи общей кнопкой.

Target `slamdunk` на parser production создан и остаётся выключенным. Это намеренно: exporter и новый WordPress-контракт уже развёрнуты, `sizeMappings` работают, а `requiredReferenceTypes` настроены как `brand`, `model`, `category`. Target нельзя включать до устранения известных бизнес-расхождений и серии ограниченных create/update smoke.

Новый `product-upsert.v1` обходит подтверждённые ограничения legacy importer отдельным строгим путём:

- primary identity хранится в `_slds_source_code`, `_slds_source_external_id`, `_slds_external_key`; `goat_id` только читается для совместимости со старыми товарами;
- новый товар создаётся variable draft, получает identity и публикуется после синхронизации;
- terms приходят только числовыми ID и не создаются в upsert;
- множественные значения каждой taxonomy применяются одним набором;
- availability без точного quantity меняет stock status без выдуманного остатка;
- публичные WebP импортируются по URL;
- общий queue обеспечивает hash/idempotency и повтор собственного error job без дубля строки.

Target-specific readiness реализована в WordPress exporter. Она опирается на универсальные `typeCode`, явно настроенный target-список `requiredReferenceTypes`, проверяет `target_value_mappings` и точные `sizeMappings`. Нельзя возвращать обязательность модели по GOAT-полю `attributes.family` или считать внутреннее resolved-решение достаточным для любого target.

Для обувных категорий production target настроен добавлять префикс `Кроссовки` по `product_cat` term IDs `74`, `75`, `865`. Старый parser подтвердил такое формирование title; это target-правило, а не универсальная операция.

WordPress `product_tag` нельзя собирать только из GOAT technologies/source tags. Старый parser добавлял связанные теги бренда и модели из `tag_id`, а категория могла дополнительно проецироваться в метку. В новой архитектуре это реализуется штатными `target_classification_projections`, а не дублированием кандидатов в `SourceProcessor`. На production активно 38 projections: четыре ранее подтверждённых YZY и 34 добавленных по проверенному WordPress cohort для брендов, моделей, модельных правил и категорий. Без projections режим `replace` удалил бы существующие брендовые и модельные product tags.

## Подтверждённый production smoke 5 августа 2026

Для проверки update-пути выбраны 15 опубликованных WordPress-товаров с подтверждёнными `goat_id`, GOAT slug и URL из старого parser. В новом parser это `source_products.id` `24`–`38`.

- все 15 карточек и offers были собраны без export;
- 13 товаров успешно обработаны и классифицированы;
- два товара (`sourceProductId=25`, Rick Owens; `sourceProductId=30`, Brooks Adrenaline) получили корректный ответ GOAT `offers: []`, но processing завершился ошибкой `Processed product variants are required`;
- для cohort принято 37 точных решений и создано 12 контекстных model rules по `context.brand + context.family`;
- после обработки 62 активных наблюдения cohort были resolved, ambiguous не было;
- добавлены 34 подтверждённые target projections для связанных тегов брендов, моделей и категорий;
- массовые `export_product` jobs не создавались.

Реально экспортирован ровно один существующий товар:

- parser `sourceProductId=26`, `internalProductId=68`;
- GOAT external ID `1760164`;
- WordPress product ID `3196872`, variation ID `3196874`;
- товар: `Wmns Air Jordan 5 Retro 'Wings' Sample`;
- до записи title, slug, SKU, taxonomies и размер совпали с WordPress snapshot;
- единственная вариация была однозначно найдена, цена обновилась с `94325` до `57050` по свежему GOAT `$326 × 175`;
- повторный export без `force` вернул `skipped`;
- повторный WordPress snapshot показал пустой diff, один товар и одну вариацию, дублей нет;
- публичная карточка вернула HTTP 200 и показала новый title, цену и описание.

Цена рассчитывается WordPress-контрактом из целых USD minor units с текущим `kurs_USD`; формула `USD × 175` подтверждена старым parser config и production preflight. Не переносить float-расчёт в parser.

WordPress legacy-вариации выявили отдельную проблему: `WC_Product_Variation::get_attributes()` мог вернуть пустой массив при наличии валидного `attribute_pa_razmer` в post meta. Из-за этого parser preview считал существующие размеры отсутствующими, хотя preflight находил вариации по meta. Исправление читает сохранённые `attribute_pa_*` meta в snapshot, покрыто PHP-тестом, WordPress commit `6978677`. Не удалять этот legacy compatibility path.

## Подтверждённые незакрытые случаи

1. **Товары без offers.** Внутренний DTO уже сохраняет `variants: []` без выдуманного варианта или цены. WordPress exporter намеренно блокирует такой payload. Нужно явно решить sold-out write: можно ли для существующего товара передать пустой active variation set и деактивировать все прежние вариации, и что создавать для нового товара без offers.
2. **Несколько брендов.** У коллабораций `Vans x Valentino` (`sourceProductId=27`, `28`) WordPress хранит два `pa_brand`, а GOAT даёт основной бренд Vans. Текущий payload заменил бы два бренда одним. Эти товары не экспортировать, пока не определено воспроизводимое извлечение и cardinality бренда.
3. **Переводы.** Ошибка `Sail -> Плыть` устранена словарём sneaker color terms (`Sail -> Парусный`). При расширении словаря добавлять подтверждённые термины, а не разовые fallback по товару.
4. **Материалы как обогащение.** Для ряда существующих товаров GOAT даёт `Mesh`/`Textile`, а WordPress пока не имеет `pa_material`. Preview предлагает добавить корректно сопоставленный термин, но массово применять такое обогащение можно только после бизнес-подтверждения.
5. **Дополнительные бренды/модельные теги.** Projections исправляют удаление существующих tags и могут добавлять отсутствующий подтверждённый model tag, например New Balance P400. Это ожидаемое target-обогащение, но его нужно видеть в полном diff.
6. **Товары без реальных изображений.** Внутренняя обработка сохраняет `images: []`, WordPress exporter возвращает `422` до внешнего запроса. Политику создания товара без изображения пока не менять.

## Доступ и серверы

- новый parser production: MCP `ssh_slamdunk_parser`, `/srv/slds-parser/app`;
- WordPress production: MCP `ssh_slamdunk_prod`, `/var/www/u0347517/data/www/slamdunk.shop`;
- старый parser: MCP `ssh_parser`, только read-only источник данных и поведения;
- локальный parser: `C:\Users\gt99\Desktop\SLDS_PARSER`;
- локальный WordPress source: `C:\Users\gt99\Downloads\slds\Git\slamdunk`.

На рабочей Windows-машине настроены постоянные host routes к SSH-адресам parser/WordPress через обычный Ethernet в обход VPN. Если MCP SSH снова получает handshake timeout, сначала проверить выбранный маршрут и VPN, не менять proxy parser и не считать недоступность сайта следствием тестов без проверки. Default route, DNS и остальной VPN-трафик трогать не нужно.

## Текущее production-состояние на 2026-08-06

### Legacy classification import 6 августа 2026

Проверены старые данные read-only:

- `ssh_parser` снова доступен, host `srv42-h-st`;
- parser v1 база `j61064897_parser` доступна через конфиг старого parser;
- фактические таблицы v1: `target_classifier_mapping`, `target_classifier_suggestion`, `target_dictionary_entry`, `wait_for_classifier`;
- `target_classifier_mapping`: `10164` строк;
- ручные v1 decisions: brand `9`, model `290`, tag `10`; ignored model `131`;
- auto/legacy goat tags не переносились: `legacy_goat_tags_exact_*`, `legacy_goat_tags_partial_unique`, `dictionary_suggested` отклонены как небезопасные;
- тестовый brand probe `__brand_probe__` исключен;
- суперстарая `j61064897_import` под v1 DB user недоступна: `SELECT command denied` для `j61064897_import.goat`; отдельные credentials не найдены безопасным коротким поиском.

Применение выполнено на production через service layer `ClassifierAdminService.saveDecision`, target `slamdunk` все время был `enabled=false`, WordPress writes/export не выполнялись.

Import preview:

- candidates `47`;
- accepted `17`;
- rejected `12`;
- conflicts `0`;
- already_exists `18`.

Применено `17` безопасных mappings:

- colors: `130` Pink -> Розовый, `131` Blue -> Синий, `132` Orange -> Оранжевый, `133` Yellow -> Желтый, `134` Purple -> Фиолетовый, `135` Gold -> Золотой, `136` Cream -> Кремовый;
- materials: `137` Leather -> Кожа, `138` Suede -> Замша, `139` Synthetic -> Синтетика, `140` Canvas -> Холст, `141` Nubuck -> Нубук, `142` Nylon -> Нейлон, `143` Rubber -> Резина, `144` Polyester -> Полиэстер, `145` Neoprene -> Неопрен, `146` Cotton -> Хлопок.

Не создавались rules/projections: безопасных context model rules и technology tag mappings с текущими доказательствами не было. V1 manual brand mappings уже существовали в новом parser как mappings `1`-`8`. Generic technology tags `Air`, `Boost`, `React`, `Flyknit`, `Primeknit`, `Zoom Air`, `Air Max`, `Fresh Foam`, `Gel` отклонены: актуальных самостоятельных `product_tag` terms нет, найденные совпадения в target dictionary являются моделями/персонами/командами.

После apply service layer поставил `1021` `process_product` jobs. Collection/export jobs не создавались. Worker дошел до `active_jobs=0`, `export_jobs=0`. Общие failed process jobs `20` остались из известных причин обработки: пустые изображения, no offers, translation verification; новых export failures нет.

Classification before/after по всем active observations:

- color: resolved `1836 -> 2520`, unresolved `754 -> 70`;
- material: resolved `308 -> 762`, unresolved `539 -> 85`;
- brand: `2014/576` без изменения;
- model: `49/2541` без изменения;
- tag: `284/346` без изменения;
- category и merchandising_category изменились из-за штатной переобработки текущим processor/rules: category resolved `366 -> 310`, unresolved `2224 -> 2280`; merchandising_category resolved `131 -> 587`, unresolved `52 -> 173`.

Idempotency preview после apply:

- candidates `47`;
- accepted `0`;
- rejected `12`;
- conflicts `0`;
- already_exists `35`.

WordPress previews read-only:

- `sourceProductId=316480`: built, taxonomy diff `[]`, regression нет;
- Pink: `90394`, `146924` snapshot saved, blocked только по отсутствующим required `model/category`, taxonomy diff `[]`;
- Leather `235980`: blocked по required `model/category`, taxonomy diff `[]`;
- Suede `270188`: blocked по required `model/category`, taxonomy diff `[]`;
- Mesh `24`: built, ожидаемый material enrichment diff `pa_material [25882]` vs `[]`;
- multi-brand `27`: blocked по required category, multi-brand не исправлялся;
- no-offers `25`: blocked `WordPress export requires product variants until the sold-out contract is configured`.

Audit reports сохранены на production:

`/srv/slds-parser/state/audits/2026-08-06-legacy-classification-import/`

- `candidates.jsonl` SHA-256 `a244a4d05604c0b234b82a3e32fe7e3fc6836549952d4494d1c48b063717fef6`;
- `accepted.jsonl` `199a766215e92e56dca47373d38023523178150288718261dbf757deeeae23b8`;
- `rejected.jsonl` `453fb256696c89fe7bafc721ccf500b820e3a9c28aabb8f914bd721b87d0dd67`;
- `conflicts.jsonl` `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`;
- `apply-result.json` `98840ea4c6b9bf840f0bc5f16d6d3805d48b33157638afe584efe1069753506b`;
- `summary.md` `a0ba1670d121cf3de929dba8f602eb02781d5a825cc38320c904376755caa654`.

Код importer добавлен локально и запушен коммитом `1f4f9a4` (`Добавить импорт старой классификации`). Production deploy этого коммита заблокирован: `/srv/slds-parser/app` remote использует `git@github-slds-parser:the-gt99/slds_parser.git`, алиас `github-slds-parser` не резолвится, в `/root/.ssh` нет private key, `git@github.com` возвращает `Permission denied (publickey)`, HTTPS требует GitHub credentials. Origin/deploy keys не менять без отдельного решения.

Следующий отдельный блок после завершения deployment blocker: переводчик. Не начинать его в рамках legacy classification import.

Parser:

- GitHub: `git@github.com:the-gt99/slds_parser.git`;
- production runtime commit на момент снимка: `0c8301a` (`Исправить проверку прокси из интерфейса`); основной proxy pool реализован в `339d915`;
- сервер: MCP `ssh_slamdunk_parser`;
- каталог: `/srv/slds-parser/app`;
- состояние и изображения: `/srv/slds-parser/state`;
- домен: `https://9a9f7857687f.vps.myjino.ru`;
- службы: `slds-parser-api.service`, `slds-parser-worker.service`;
- PostgreSQL: Docker-контейнер `slds-parser-postgres`, наружу не открыт;
- миграции `001`–`014` применены;
- production deployment прошёл `typecheck`, `190` тестов, build и migrations;
- API и worker активны, внутренний и внешний health возвращают 200;
- production worktree чистый;
- `WORKER_PROCESS_CONCURRENCY=4`; четыре lane подтверждены полным forced processing smoke;
- на время полного sneakers collection `WORKER_COLLECTION_CONCURRENCY=15`, `GOAT_PROXY_CONCURRENCY_PER_PROXY=5`, `GOAT_PROXY_POOL_ENABLED=true`;
- три прокси healthy/enabled; credentials у всех трёх зашифрованы, API secret fields не отдаёт;
- target `slamdunk` ID `1` выключен;
- `requiredReferenceTypes`: `brand`, `model`, `category`;
- title prefixes настроены для category term IDs `74`, `75`, `865`;
- актуальные WordPress справочники и size mappings заполнены;
- 38 target classification projections активны;
- один target product (`internalProductId=68`) имеет статус `synced` после подтверждённого update smoke.

### Завершённый полный discovery-only

Commit `fd21170` добавил флаг job payload `enqueueCollection: false` и команду `npm run goat:enqueue-discovery`. Старое поведение остаётся default: без флага discovery продолжает ставить `collect_product`.

5 августа запущены job `196` и `source_collection_run` `7` с `runType=full`, `coverage=catalog`, `enqueueCollection=false`. Источник настроен без `maxProductsPerRun`, `discoveryBatchSize=500`, `requestDelayMs=1000`.

6 августа проверено production БД:

- job `196`: `discover_source`, `completed`, attempts `1`, `finished_at=2026-08-05 12:18:52.559335+00`, ошибок нет;
- run `7`: `completed`, `completeness=complete`, `processed_count=591828`, `discovered_count=591828`, checkpoint `{"emitted":591828,"itemIndex":0,"childIndex":948}`;
- в `source_products` `591828` строк и `591828` уникальных `source_key`;
- распределение `discovery_metadata.route`: `sneakers=342177`, `apparel=249651`;
- дубликатов `source_key` нет, пустых `slug` и `url` нет;
- downstream jobs после `196`: `0`; карточки, offers, переводы и изображения не скачиваются;
- после smoke и rep500 у `590` товаров есть `external_id` и по две сохранённые части; sitemap discovery сам по себе сохраняет только slug/URL/metadata, GOAT ID появляется после collection;
- PostgreSQL `629 MB`, media около `183 MB`, свободно около `72 GB`;
- target `slamdunk` ID `1` выключен.

Не перезапускать полный discovery без отдельной причины: каталог уже сохранён discovery-only без downstream задач.

WordPress:

- GitHub: `git@github.com:Stasvelin/slamdunk.git`;
- production commit на момент снимка: `661cc03` (`Расширить снимок товара`);
- production MCP: `ssh_slamdunk_prod`;
- production path: `/var/www/u0347517/data/www/slamdunk.shop`;
- `product-upsert.v1`, preflight, snapshots и idempotent queue развёрнуты;
- все пять PHP-тестов target-import проходят;
- production worktree был чистым после deployment;
- production может иметь посторонние незакоммиченные изменения — никогда не затирать их pull/reset/checkout;
- старый parser и MCP `ssh_parser` использовать только как источник поведения и данных, не как место дальнейшей разработки.

Снимок быстро устаревает. Перед отчётом всегда проверять реальные commits, services, jobs и БД.

## Что осталось сделать

Порядок работ важен.

### 1. Нерешённые бизнес-блокеры WordPress write

- sold-out export/write пока не считать решённым: внутренний DTO поддерживает `variants: []`, но WordPress exporter и product-upsert намеренно требуют непустой `variations.items`; нужно согласовать бизнес-правило до write smoke;
- несколько брендов у коллабораций не исправлены эвристикой: реальные GOAT payload для Valentino Garavani x Vans содержат `brandName: Vans`, а второй бренд подтверждён только WordPress snapshot. Нужно определить воспроизводимое source-правило и cardinality `brand` end-to-end;
- решить, считать ли заполнение отсутствующего `pa_material` допустимым автоматическим обогащением;
- target `slamdunk` не включать до решений выше и новой серии ограниченных create/update smoke.

### 2. Репрезентативная классификационная выборка

Rep500 и cohort 2000 завершены. Не обрабатывать весь каталог сразу.

1. Следующая партия — `5000` discovery-товаров, поровну `sneakers`/`apparel`, через dry-run и затем `GOAT_COHORT_APPLY=true`.
2. Target оставить выключенным. Пока идёт полный sneakers collection, не ставить новые processing jobs и не менять подтверждённые `15` collection lane / `5` session slots на прокси.
3. Не повышать collection concurrency внутри смешанной рабочей партии. Изолированный collection-only smoke на 12 lane уже пройден успешно, но он не доказывает отсутствие конкуренции с image leases при одновременном processing.
4. Новые уровни processing/image concurrency проверять отдельным forced smoke, не смешивая с репрезентативной выборкой.
5. Разбирать очередь по частоте, формируя точные mappings и контекстные rules; после cohort 5000 переходить к партиям 10000–20000 только при стабильных proxy/retry/error метриках.

Массовые правила модели строить по evidence `brand + family` и проверять preview конфликтов. Отдельно вернуться к Pegasus/Surge и другим семействам, где голое название неоднозначно. Движок классификатора не переписывать под GOAT.

### 3. Smoke и выборка 6 августа 2026

После parser commits `0b89abb`, `1ed174b` и WordPress commit `661cc03` изменения развёрнуты на production. Target `slamdunk` оставался выключенным, export jobs не создавались.

Проверки deployment:

- parser production обновлён fast-forward до `0c8301a`, proxy pool deployment прошёл `npm ci`, `npm run typecheck`, `npm test` (`190` tests), `npm run build`, `npm run db:migrate`;
- перезапущены `slds-parser-api.service` и `slds-parser-worker.service`, оба active, internal health `200`;
- WordPress production обновлён fast-forward до `661cc03`, `php -l product-snapshots.php` и все пять target-import PHP-тестов прошли;
- target `slamdunk` ID `1` проверен как `enabled=false`, `export_product` jobs после discovery `0`.

Smoke 50:

- поставлено 48 новых `collect_product` jobs и 2 forced `process_product` jobs для старых no-offers товаров `25` и `30`;
- результат: 48 collection completed, 49 processing completed, 1 failed;
- failed товар `sourceProductId=5329` (`air-afterburner-flight-bg-146033-101`) имел только GOAT placeholder `missing.png`; это исторический результат до commit `1ed174b`;
- 19 из 49 обработанных товаров получили `variants: []`, то есть `offers: []` теперь проходит processing без выдуманных размеров и цен;
- media около `59 MB`, PostgreSQL около `601 MB`, свободно около `73 GB`.

Rep500:

- поставлено ровно 500 новых `collect_product` jobs: 250 sneakers и 250 apparel; фактический диапазон jobs `295`–`1294`;
- collection: 500 completed;
- processing: 487 completed, 13 failed;
- все 13 historical failed — `Product images are empty`; каждый товар имел только GOAT `placeholders/product_templates/.../missing.png`;
- обработанные товары по route: apparel `248`, sneakers `239`;
- no-offers среди обработанных: `182/487` (`37.4%`), из них apparel `125`, sneakers `57`;
- media после выборки около `183 MB`, PostgreSQL около `620 MB`, свободно около `72 GB`;
- классификатор по rep500: `brand resolved=200/unresolved=287`, `category resolved=58/unresolved=429`, `color resolved=343/unresolved=144`, `material resolved=61/unresolved=103`, `model resolved=2/unresolved=485`, `tag resolved=32/unresolved=89`;
- частые unresolved не сопоставлялись автоматически: `clothing`, `Running`, `Lifestyle`, `Blue`, `Leather`, `Basketball`, `Puma`, `Kith`, `Off-White`, `EVA`, `Zoom Air` и другие требуют проверки;
- Pegasus/Surge проверены в выборке и остались unresolved с контекстом: `Nike Air Zoom Pegasus 36 'Tokyo Running Pack'` (`brand=Nike`, `family=Air Zoom Pegasus 36`) и `Under Armour Wmns Surge 4 'Sky Blue White'` (`brand=Under Armour`, `family=Surge`). Не создавать глобальные model mappings по голым `Pegasus` или `Surge`.

После commit `1ed174b` повторно обработаны 16 исторически упавших товаров: 14 placeholder-only и два no-offers. Все 16 jobs завершены; в latest classified DTO у 14 товаров `images: []`, у 10 `variants: []`. Preview placeholder-only и no-offers товаров вернул `422` с явной причиной до WordPress HTTP-вызова. Export jobs не создавались.

Новая команда `npm run goat:enqueue-cohort` по умолчанию работает как dry-run, требует явный лимит до `20000`, делит выборку по routes и ставит jobs только с `GOAT_COHORT_APPLY=true`. Production dry-run на 20 товарах вернул ровно `10 sneakers / 10 apparel` без записи jobs.

Команда `npm run classifier:exact-matches` применена только для `brand,model,color,tag`: сохранено 69 однозначных решений — 63 brand, 5 model и 1 tag. Материалы и категории автоматически не применялись. Решения поставили 232 уникальных товара на повторную обработку; все 232 jobs завершены двумя processing lanes без ошибок. Повторный dry-run exact matches вернул `0`.

Четыре processing lane проверены на 100 уже собранных товарах с `force=true`, по 50 sneakers/apparel. Все шесть операций выполнялись заново: `100/100 completed`, retry/failures и export jobs отсутствуют. Полный wall time `190.327 с`, скорость `31.52 товара/мин`, среднее время attempt `7.485 с`, p95 `21.923 с`, максимум `23.243 с`. Выборка содержала 230 реальных изображений, четыре товара с `images: []` и 32 с `variants: []`. Во время нагрузки worker использовал около 280 MB RAM и 44% одного CPU.

Proxy pool проверен на production с тремя реальными healthy/enabled прокси и тремя collection lane. В отдельном cohort из 12 товаров collection завершился `12/12`, processing `12/12`, attempts по одному, retry/failures и export jobs отсутствуют. Товары распределились между proxy IDs ровно `4/4/4`; у каждого товара parts `product` и `offers` содержат один и тот же `_transport.proxy.id`. После smoke активных jobs нет, target `slamdunk=false`, API/worker active, internal/external health `200`.

### Collection-only concurrency smoke 6 августа 2026

Parser commit `05742b6` (`Настроить параллельные сессии прокси`) добавил `GOAT_PROXY_CONCURRENCY_PER_PROXY` от 1 до 16. Каждый proxy/session slot использует отдельный cookie jar `.proxy-ID.session-N`; product и offers одной попытки остаются на одном slot. Для cohort CLI и `collect_product` payload добавлен явный `enqueueProcessing`; default остаётся `true`, а `GOAT_COHORT_ENQUEUE_PROCESSING=false` позволяет измерять только collection без downstream processing.

Production smoke выполнен на трёх healthy proxy с `GOAT_PROXY_CONCURRENCY_PER_PROXY=4`, `WORKER_COLLECTION_CONCURRENCY=12`, выборкой `1000` ещё не собранных товаров (`500 sneakers`, `500 apparel`, seed `20260810`). Перед запуском старая processing-очередь была полностью завершена.

- jobs `9078`–`10077`: `1000/1000 completed`, attempts ровно `1`, retry/failed и `last_error` отсутствуют;
- wall time от создания первой job до завершения последней `380.835 с` (`6.35 мин`), средняя пропускная способность `157.55 товара/мин`;
- старый показатель `25.49 товара/мин` нельзя считать строго сопоставимым: cohort 2000 выполнял collection одновременно с processing и image leases;
- сохранено ровно `2000` parts: `1000 product` и `1000 offers`, пропущенных `_transport.proxy.id` нет;
- у всех `1000/1000` товаров product и offers собраны через один proxy, расхождений `0`;
- распределение collection по proxy IDs: `1 — 328`, `2 — 336`, `3 — 336`;
- proxy failure counters не выросли: остались `2/1/3`; job-level retries не было;
- `process_product` и `export_product` jobs для smoke не создавались;
- после проверки production возвращён на `WORKER_COLLECTION_CONCURRENCY=3` и `GOAT_PROXY_CONCURRENCY_PER_PROXY=1`; active jobs `0`, target `slamdunk=false`, API/worker active, health `200`.

### 4. Cohort 2000 от 6 августа 2026

Production cohort 2000 запущен с `GOAT_COHORT_PRODUCT_LIMIT=2000`, `GOAT_COHORT_ROUTES=sneakers,apparel`, `GOAT_COHORT_SEED=20260808`. Dry-run вернул ровно `2000` товаров: `1000 sneakers` и `1000 apparel`; без `GOAT_COHORT_APPLY=true` jobs не создавались. Target `slamdunk` оставался `enabled=false`, export jobs не создавались, WordPress endpoints не вызывались.

Настройки во время прохода: production commit на старте `b406347`, `WORKER_COLLECTION_CONCURRENCY=3`, `WORKER_PROCESS_CONCURRENCY=4`, `GOAT_PROXY_POOL_ENABLED=true`, три proxy healthy/enabled. Concurrency во время партии не менялась.

Результат первого прохода:

- collection: `2000 completed`, `0 failed`, `0 pending/running/retry`;
- processing: `1996 completed`, `4 failed`, `0 pending/running/retry`;
- все 4 failed имели одну причину: `Translation verification failed for upperMaterial`;
- конкретные значения `upperMaterial`: `Flymesh`, `Flyweave`, `NDure`, `IntelliKnit`;
- причина подтверждена кодом `TranslateContentOperation`: верификация требовала кириллицу для любого `upperMaterial`, хотя это валидные фирменные material terms.

Исправление сделано в parser commit `c3c32e2` (`Добавить переводы материалов`): добавлены только подтверждённые переводы `Flymesh -> Флаймеш`, `Flyweave -> Флайвив`, `NDure -> Эн-Дьюр`, `IntelliKnit -> ИнтеллиКнит` и unit-тест. Локально и на production прошли `npm run typecheck`, `npm test` (`191` tests), `npm run build`, `node --check public/app.js`, `node --check public/product.js`. Production обновлён fast-forward до `c3c32e2`, API/worker перезапущены.

После исправления точечно поставлены только 4 forced `process_product` jobs (`5688`–`5691`) для source products `47926`, `87288`, `194461`, `319324`. Все 4 завершились `completed` с первой попытки. Latest status по cohort: `2000/2000` товаров обработаны, failed нет. Исторические failed jobs первого прохода оставлены в истории и не скрываются.

Скорость и нагрузка:

- collection wall time `4707.73 с` (`78.46 мин`), средняя скорость `25.49 товара/мин`;
- original processing wall time `7078.95 с` (`117.98 мин`), средняя скорость `16.93 товара/мин`;
- latest processing attempt duration: avg `13.653 с`, p50 `8.084 с`, p95 `38.969 с`, p99 `101.460 с`, max `295.148 с`;
- максимальный reconstructed pending processing queue первого прохода: `973`;
- во время мониторинга worker доходил примерно до `305 MB RSS` и около `18.8% CPU` по `ps`; после завершения около `171 MB RSS`.

Проверки данных cohort:

- route: `1000 sneakers`, `1000 apparel`;
- у `2000/2000` товаров есть обе parts: `product` и `offers`;
- `product` и `offers` одного товара всегда собраны через один `_transport.proxy.id`;
- collection distribution без image leases: proxy `1` — `546`, proxy `2` — `728`, proxy `3` — `726`;
- дубликаты source products: `0`; дубликаты source parts: `0`;
- `offers: []`: `801`;
- latest `variants: []`: `831`;
- latest `images: []`: `35`.

Классификация cohort после точечной переобработки: `classification complete=4`, `pending=1996`, ambiguous отсутствуют. Наблюдения по типам: brand `resolved=1523/unresolved=473`, category `271/1725`, color `1413/583`, material `229/412`, model `24/1972`, tag `167/311`. Частые unresolved: brand `Fear of God Essentials`, `Aimé Leon Dore`, `Anti Social Social Club`; category `clothing`, `Running`, `Lifestyle`; color `Blue`, `Pink`, `Cream`; material `Leather`, `Suede`, `Synthetic`; tag `EVA`, `Boost`, `Zoom Air`. Mappings/rules по результатам cohort автоматически не создавались.

Ресурсы после cohort и фикса:

- PostgreSQL `697 MB`;
- `/srv/slds-parser/state` `828 MB`;
- свободно около `72 GB`;
- всего `source_products=591828`, с `external_id=2590`;
- `source_product_parts`: `2590` товаров, `5180` rows;
- `internal_products`: `classification_pending=2572`, `classified=18`;
- proxy counters относительно раннего baseline выросли с failures только у proxy `1` на `+2`; финально все три proxy `enabled=true`, `health_status=healthy`;
- active jobs `0`, export jobs после baseline `0`, target `slamdunk=false`;
- API и worker active, internal/external health `200`;
- production worktree чистый.

Следующий безопасный шаг — разбор частот unresolved по cohort 2000 и создание подтверждённых mappings/rules через preview, затем cohort 5000 на тех же `collection=3` и `processing=4`. До согласования sold-out write contract и multi-brand cardinality WordPress export не запускать.

### 5. WordPress/GOAT cohort 100 от 6 августа 2026

Первый этап WordPress cohort выполнен без анализа mappings/rules/projections и без изменений WordPress. Метод выбора: точное пересечение `source_products.external_id` нового parser с опубликованными variable WordPress-товарами по `goat_id`; legacy slug matching не понадобился. Из 737 однозначных exact intersections выбран стабильный cohort из 100 товаров seed `20260806`: обязательный контрольный товар `goat_id=855174`, `WordPress product ID=2585427`, `sourceProductId=316480` включён; выборка содержит 57 уникальных WordPress-брендов и 10 товаров с несколькими `pa_brand`.

Manifest сохранён на production parser: `/srv/slds-parser/state/audits/2026-08-06-cohort-100-wordpress-goat.jsonl`, SHA-256 `c09ac7ed169cb2a89fb93c4d64f1c6725fb0bc7b25f43a27e8e6d3ed4bef43ff`. Bootstrap report: `/srv/slds-parser/state/audits/2026-08-06-cohort-100-wordpress-bootstrap-report.json`, SHA-256 `32d4b7bae0d037ddd3905249a221c62d4f6fa74b949b69f75f3272df4bc36683`.

Baseline перед enqueue: production HEAD `6332f5f`, max job `5691`, `source_products.external_id=2590`, `internal_products=2590`, snapshots `18`, PostgreSQL `697 MB`, state `828 MB`, свободно `72 GB`, target `slamdunk=false`, export jobs `0`, active jobs `0`, proxy `1/2/3` healthy/enabled. Штатный `goat:enqueue-cohort` dry-run для exact cohort вернул `0`, потому что CLI фильтрует только never-collected товары; после отдельного dry-run точного списка jobs поставлены через `JobRepository.enqueue`.

Job ranges: collect `5692`-`5791`, process `5792`-`5891`. Результат: collection `100 completed / 0 failed / 0 retry`, processing `100 completed / 0 failed / 0 retry`, snapshots `100 saved / 0 not_found`. Для всех 100 есть parts `product` и `offers`; свежий GOAT `product.id` совпал с WordPress `goat_id`; `source_products.external_id` совпал; product/offers одного collect attempt использовали один proxy. Collection distribution: proxy `1=40`, `2=20`, `3=40`. Пустые данные: `offers: []` у 14, `variants: []` у 14, `images: []` у 0.

Инвентаризация cohort: WordPress product categories — `Мужские кроссовки=48`, `Кроссовки женские=17`, `Кроссовки детские {SEO_FILTER}=14`, `Мужские ботинки=9`, `Женские сандалии=4`, `Мужские сандалии=3`, `Женские ботинки=2`, `Мужские тапочки=2`, `Мужские кеды=1`. GOAT route `sneakers=100`, `productCategory shoes=100`, `productType sneakers=98 / cleats=1 / boots=1`; GOAT category includes `Lifestyle=47`, `Running=18`, `Basketball=5`. Непустые GOAT поля: `category=100`, `activity=8`, `midsole=44`, `upperMaterial=76`, `composition=0`, `ageGroups=1`, `taxonomyLevel1=100`, `taxonomyLevel2=100`, `taxonomyLevel3=20`, `taxonomyLevel4=9`.

Классификация после processing: `classified=2`, `classification_pending=98`; observations: brand `resolved=89/unresolved=11`, category `32/68`, color `75/25`, material `20/56`, model `6/94`, tag `8/36`, ambiguous нет. Финально active jobs `0`, target `slamdunk=false`, export jobs `0`, API/worker active, internal/external health `200`, production parser worktree чистый, WordPress production worktree чистый на `661cc03`. Mappings/rules/projections не создавались и не редактировались; следующий этап — только анализ соответствий по сохранённым данным.

### 6. Анализ WordPress/GOAT cohort 100 от 6 августа 2026

Второй этап выполнен как read-only анализ сохранённого cohort 100. Отчёты сохранены на parser production в `/srv/slds-parser/state/audits/2026-08-06-cohort-100-analysis/`: `product-layer-report.jsonl` SHA-256 `f2de0d0dc0e1009a5cb18ff1b6ab6740fc7286d76fc933ae263f058589aea3a2`, `association-matrices.json` SHA-256 `9a1a558be1e25e65fa94c5865306ef249b2c0b6823a6651e98a3635d0850c2b6`, `summary.json` SHA-256 `8bf0ec291040bd92e5fb99d7a0c15ae2ecb8eee9ba8c45b0c9ac73441fed808a`, `summary.md` SHA-256 `859676bb72ea54f7f38c53e83f57a928fccbaa72133903975391328bde50169d`, audit script `audit-analysis.mjs` SHA-256 `bc7fca37eb7464e3235cfa2bcf3e9580b5efb3dac27c30b1aa4c97f4d7dcf8d5`.

Проверено 100 товаров, 1570 назначенных WordPress terms учтены ровно один раз. Coverage по статусам: `direct_mapping=170`, `projection=65`, `unresolved_candidate=320`, `source_field_unhandled=53`, `target_only=804`, `conflict=158`. По taxonomy: `pa_brand direct=89/conflict=10/unresolved=11`, `pa_model direct=5/unresolved=94/conflict=1`, `pa_tsvet direct=47/unresolved=22`, `product_cat direct=29/unresolved=68/conflict=3`, `product_tag projection=65/conflict=144/unresolved=125`, `pa_vid source_field_unhandled=53`, `pa_razmer target_only=702`, `pa_shoe_height target_only=102`.

Главные подтверждённые co-occurrences для ручного следующего этапа: `brandName -> pa_brand` для крупных брендов без counterexamples в cohort; `category=Running -> pa_vid:Бег` `18/18`, `category=Basketball -> pa_vid:Баскетбол` `5/5`, `category=Lifestyle -> product_tag:На каждый день (лайфстайл)` `47/47`, `category=Running -> product_tag:Кроссовки для бега` `18/18`, `midsole=EVA -> product_tag:Технология EVA` `10/10`. Это статистика, а не применённые правила.

Главные конфликты: multi-brand WordPress `pa_brand` содержит дополнительные бренды, которых нет в структурированном GOAT `brandName`; существующие WordPress `product_tag` часто объясняются связанными тегами бренда/модели/категории, но текущие projections покрывают только 65 тегов из cohort; `pa_vid` сейчас систематически назначен в WordPress по GOAT `category`, но processor не создаёт `activity` candidate из `category`, поэтому эти связи помечены как `source_field_unhandled`, а не direct/projection.

Необрабатываемые GOAT поля по коду `GoatSourceProcessor`: `composition` не сохраняется в DTO и не создаёт candidate/evidence; `ageGroups` не создаёт candidate и не попадает в evidence; `taxonomyLevel1-4` попадают только в `evidence.taxonomy`, но не создают candidates; `season` сохраняется как attribute, но не candidate/evidence; `shoe_height` не извлекается. `activity` candidate создаётся только из `activitiesList/activities`, а не из `category`.

Контрольный товар `goat_id=855174`, `sourceProductId=316480`, WordPress `2585427`: `productType=sneakers`, audience `men`, category `Running`, midsole `HOVR`, brand `Under Armour`, family `HOVR Phantom 2`. Уже объяснены direct mappings `pa_brand=Under Armour` и `pa_tsvet=Серый`; `pa_model`, `product_cat` и `product_tag` требуют mappings/projections; `pa_vid=Бег` требует решения по модели activity/category; `pa_shoe_height=Средние` пока target-only.

Следующий этап: исправление модели candidates и интерфейса projections/review-flow, затем ручное применение подтверждённых mappings/rules/projections через preview. Во втором этапе mappings, rules, projections, reference values, jobs, target/proxy config, runtime code и WordPress не изменялись.

### 7. Исправление candidates и projections для cohort 100 от 6 августа 2026

Третий этап выполнен 6 августа 2026. Parser production обновлён до `989380b`; перед deployment локально и на production прошли `typecheck`, `npm test` (`199` тестов), `build`, миграции без pending, API/worker active, health `200`. Target `slamdunk` остался выключенным, active `export_product` jobs `0`, WordPress write не выполнялся.

Кодовые изменения:

- `GoatSourceProcessor` version `2.9.0`: `category` теперь структурная (`productType || productCategory || route`), GOAT marketing category вынесена в отдельный candidate `merchandising_category` scope `product.merchandising_category`; `activity` читается только из явных `activity`/`activities`/`activitiesList`; `composition`, `ageGroups` и taxonomy сохраняются в attributes/evidence; `evidence.merchandisingCategory` добавлен к структурной категории для узких правил.
- Добавлен reference type `merchandising_category` миграцией `015`.
- Добавлен backend/UI для `target_classification_projections`: list/preview/create/deactivate, audit history, validation target scope и dictionary entity type, CSRF для mutations.
- Исправлен SQL preview projections для `mapping` и `rule`; regression tests покрывают `observation.rule_id = $2` и типизацию `$1::BIGINT`.

Cohort 100 дважды принудительно переобработан через штатный `JobRepository.enqueue` с `process_product force=true`: первый раз после новой модели candidates, второй раз после добавления `evidence.merchandisingCategory`. После применения решений все affected jobs завершились, active `process_product` jobs `0`.

Финальная active classification cohort 100:

- `activity`: resolved `4`, unresolved `4`; resolved только явные GOAT `Running` (`3`) и `Basketball` (`1`), `Lifestyle` оставлен unresolved и не превращён в `pa_vid`;
- `category`: resolved `23`, unresolved `77`; resolved только `sneakers` по узким правилам `sourceValue + productCategory + productType + audience + evidence.merchandisingCategory`;
- `merchandising_category`: resolved `70`, unresolved `30`; полностью resolved `Running=18`, `Lifestyle=47`, `Basketball=5`; `Boot/Cleat/Other/Sandal/Skateboarding` оставлены unresolved;
- `tag`: resolved `19`, unresolved `25`; добавлены `EVA` и `HOVR` как technology tags;
- `brand/model/color/material` остались в ожидаемом частичном состоянии: brand `89/11`, model `7/93`, color `75/25`, material `20/56`; ambiguous нет.

Применено через `ClassifierAdminService`, не прямым SQL:

- mappings: `merchandising_category` Running/Lifestyle/Basketball seed mappings `122`/`123`/`124`; explicit activity Running/Basketball `125`/`126`; technology tag EVA/HOVR `127`/`128`; exact model mapping Under Armour HOVR Phantom 2 `129`;
- category rules `13`-`18`: Running men->`75`, women->`74`, youth/infant->`865`; Basketball men->`75`, youth->`865`;
- merchandising rules `19`-`21`: Running, Lifestyle, Basketball для product tag projections;
- target projections `39`-`46`: Under Armour brand tag `1086`, Running tag `904`, Lifestyle tag `892`, Basketball tag `895`, Under Armour HOVR Phantom 2 model tag `8138`.

Важно: broad `sneakers + audience` category rule не создан. Production preview показал counterexamples: `sneakers men/women/youth` включает boots/sandals/slippers/keds. Нельзя откатываться к такому правилу. `Lifestyle -> pa_vid` также не создан.

Read-only WordPress preview контрольного `sourceProductId=316480`, GOAT `855174`, WordPress `2585427` успешен: matched by `target_id+legacy_goat_id`; payload taxonomies `pa_brand=[3128]`, `pa_model=[19402]`, `product_cat=[75]`, `pa_tsvet=[1613]`, `product_tag=[4780,1086,904,8138]`; taxonomy diff пустой. Field/image/variation diffs остаются предметом полного ручного preview перед write. Другие sample previews ожидаемо блокируются readiness: отсутствующий required model/category/brand или `variants: []`; это подтверждает, что WordPress write всё ещё не произойдёт случайно.

### 8. Следующие WordPress smoke

Target оставить выключенным. Выполнить контролируемо:

- update ещё нескольких существующих товаров, включая изменение набора активных размеров;
- create нового товара сначала как draft и ручную проверку всех полей;
- повтор того же export и проверку `skipped`/idempotency;
- update ранее созданного новым parser товара;
- отдельный тест unavailable/sold-out после согласования контракта;
- проверку отсутствия дублей, taxonomies, projections, prices, stock, images, descriptions и публичной карточки.

Только после серии из 5–50 проверенных товаров обсуждать включение target. Сам факт одного успешного update не разрешает массовый export.

### 9. Эксплуатация полного каталога

После успешной классификационной выборки и exporter smoke:

- планировать полный collection/processing партиями, а не одной очередью на весь каталог;
- отдельно настроить частое обновление offers;
- добавить ETag/304 там, где источник поддерживает;
- подтвердить политику исчезнувших товаров;
- масштабировать collection и processing только соответствующими lane settings; не запускать несколько полных workers;
- перед повышением collection concurrency добавлять и проверять реальные proxy records через `/proxies`; отключённые или unhealthy прокси не получают новые leases;
- настроить мониторинг jobs, ошибок, зависших locks, диска, PostgreSQL и media;
- настроить резервное копирование PostgreSQL и `/srv/slds-parser/state`.

## Доработка админки классификатора 6 августа 2026

Production parser обновлён до `55a8b83`, применена миграция `018_classifier_admin_consistency.sql`. Локально и на production прошли `typecheck`, `npm test` (`212` тестов) и `build`. API/worker active, internal/external health `200`. Target `slamdunk` остался выключенным, `export_product` jobs не создавались, WordPress writes не выполнялись.

- `/classifier-config` разделён на четыре самостоятельных представления: исходные значения, контекстные правила, основные поля WordPress и дополнительные назначения. Строки больше не перемешивают разные уровни конфигурации.
- Детали и редактирование открываются в центральных широких dialog, нижние действия sticky. Сырые `reference value ID`, DSL условий и технический термин `projection` убраны из основного пользовательского сценария.
- Для точных mappings, rules, target mappings и дополнительных назначений доступны просмотр, история, preview, редактирование и включение/отключение через audited service/repository path. Редактирование rules не позволяет менять source/type и учитывает как прежние, так и новые affected products.
- Основной `/classifier` сначала сохраняет внутренний смысл, затем позволяет добавить несколько дополнительных WordPress-категорий, меток или атрибутов. Сохранение требует preview; для single-cardinality target scopes проверяются конфликты по всем активным outputs товара.
- Очередь, rule candidates и статистика конфигурации показывают observations только для текущей версии source processor. Поэтому старое `category=Running` от GOAT processor 2.7/2.8 больше не попадает в UI; актуальный processor `2.9.0` хранит это как `merchandising_category`, а структурную категорию отдельно.
- Добавлена dry-run-first команда `npm run classifier:enqueue-stale`; применение разрешается только при `STALE_PROCESSING_APPLY=true`.
- `/api/products` сначала выбирает IDs страницы и только затем читает parts/jobs/snapshots. Production timings после индексов: конфигурация примерно `63–187 ms`, classification stage примерно `59–135 ms` после прогрева, target `not_exported` примерно `193–277 ms`; прежние запросы занимали примерно `1.7–3.1 s`.

После dry-run на production поставлено `1498` штатных `process_product` jobs для internal products со старой версией processor: job IDs выше baseline `7579` (`7580–9077`). Очередь намеренно оставлена worker в фоне по просьбе владельца. При следующей проверке дождаться terminal status всех этих jobs, сгруппировать failures по `last_error`, проверить остаток `internal_products.processor_version <> '2.9.0'`, active observations `category=Running`, target `slamdunk=false` и отсутствие export jobs. Не ставить этот batch повторно, пока существуют active jobs с этими IDs.

## Полный collection sneakers 6 августа 2026

Владелец явно разрешил собрать весь сохранённый каталог `sneakers`, но пока не запускать processing/export. Parser commit `8db807a` (`Добавить массовый сбор раздела`) добавил dry-run-first команду `npm run goat:enqueue-route-collection`. Она одним атомарным PostgreSQL-запросом выбирает весь ещё не собранный route и создаёт jobs с явным `enqueueProcessing=false`.

- production dry-run нашёл ровно `340372` ещё не собранных sneakers;
- одним apply поставлены все `340372/340372` `collect_product` jobs, диапазон IDs `10078–350449`;
- старт очереди: `2026-08-06 22:58 MSK`;
- конфигурация оставлена активной: `WORKER_COLLECTION_CONCURRENCY=15`, `GOAT_PROXY_CONCURRENCY_PER_PROXY=5`, три healthy/enabled proxy;
- baseline proxy counters: proxy `1` — `4145/2`, proxy `2` — `3944/1`, proxy `3` — `4519/3` (`success/failure`);
- все `340372` payload проверены: `enqueueProcessing=false`; новых process/export jobs после baseline нет;
- начальный production snapshot через `213.684 с`: completed `551`, pending `339806`, running `15`, retry `0`, failed `0`, средняя скорость от commit очереди `154.71 товара/мин`;
- при таком начальном темпе полный проход займёт около `36.7 ч`; это прогноз, а не подтверждённое время завершения;
- failure counters на стартовом интервале не выросли, API/worker active, health `200`, свободно около `71 GB`.

Не ставить этот route повторно. При следующей проверке использовать jobs `10078–350449`, контролировать completed/pending/running/retry/failed, прирост proxy failure counters, свободный диск и отсутствие process/export jobs. После полного завершения отдельно проверить `1000 product + offers` на одной proxy-сессии по выборке и итоговую полноту parts для всех успешно завершённых товаров.

## Локальная доработка админки без deployment 7 августа 2026

Код локально доведён до нового административного слоя, но production deployment намеренно не выполнялся: полный collection `sneakers` всё ещё активен, а выкладка требует миграцию `019_product_admin_batch_actions.sql` и restart API. Worker/systemd не перезапускались, processing/export jobs не создавались, WordPress writes не выполнялись.

Реализовано локально:

- `/jobs` и `/api/jobs`: PostgreSQL dashboard очереди с фильтрами по type/status/search, pagination, duration, worker/lane, очищенным payload, группами ошибок, скоростью completion и ETA.
- Безопасный retry terminal failed jobs через service/repository path; export retry заблокирован.
- Массовые действия на `/products`: checkbox выбор, выбор текущей страницы, server-side batch по текущим фильтрам с limit, dry-run-first, active-job deduplication, оценка media/disk, аудит в `product_admin_batch_actions`. Export action показан отключённым и API-сервисно заблокирован.
- WordPress preview карточки товара стал визуальным read-only представлением «Так будет отправлено / Сейчас в WordPress / Что изменится» поверх существующего `WordPressPreviewService` и общего `buildWordPressUpsertPayload`; технический JSON оставлен в collapsible blocks.
- Общая навигация дополнена разделами `Парсер` и `Очередь и ошибки` на административных страницах.

Проверки локально:

- `npm run typecheck` — успешно;
- `npm test` — `223` теста успешно;
- `npm run build` — успешно;
- `node --check public/admin-list.js public/product.js public/app.js public/proxies.js` — успешно;
- `git diff --check` — успешно, только штатные CRLF warnings.

Production read-only timings без deployment:

- `/api/jobs`-аналог `process_product failed` page: около `174.6 ms`;
- jobs summary: около `298.3 ms`;
- error groups: около `145.7 ms`;
- batch candidates limit `100` после исправления lookup по `unique_key`: около `94.3 ms`;
- полный count по фильтру `goat` занял около `964 ms`, поэтому batch dry-run считает ограниченную server-side пачку, а не весь каталог.

Production snapshot после проверки:

- collection batch `10078–350449`: completed `44067`, pending `296214`, retry `76`, running `15`;
- `payload_bad=0`;
- process/export jobs после старта batch: `0/0`;
- active process/export: `0/0`;
- target `slamdunk.enabled=false`;
- API и worker active;
- свободно около `71 GB`.

## Пауза collection и визуальный WordPress merge preview 7 августа 2026

По явной просьбе владельца полный collection `sneakers` штатно приостановлен graceful stop сервиса `slds-parser-worker.service`. Сервис остаётся `inactive`; API активен. После остановки активных `running` jobs не осталось, в PostgreSQL сохранено `263818 pending` и `80 retry` `collect_product`. Повторно ставить route нельзя: обычный запуск того же systemd worker продолжит существующую очередь. Target `slamdunk` остаётся `enabled=false`, активных и новых `export_product` jobs нет.

Для сквозной проверки выбран ровно один опубликованный WordPress-товар, который уже имел обе GOAT parts, но ещё не имел `internal_product`:

- parser `sourceProductId=76399`, GOAT `external_id=1241656`, slug `wmns-dunk-low-cyber-fz3781-060`;
- WordPress `product ID=772888`, «Кроссовки Nike Wmns Dunk Low 'Cyber'»;
- свежий WordPress snapshot сохранён read-only bootstrap-командой; WordPress не изменялся;
- отдельно, без запуска общего worker, выполнен один `process_product` job `350450`; он завершён с первой попытки, создал `internalProductId=6023`, 8 изображений и 22 вариации;
- классификация `partial`: brand/model/color/material/merchandising category resolved, обязательная structural category `sneakers` unresolved;
- exporter readiness корректно блокирует товар: отсутствует обязательная WordPress-категория. По уже определённой части merge добавил бы `pa_material=Синтетика`; финальный variation preflight намеренно не выполняется до устранения блокера.

Parser commit `b0ca7c7` (`Добавить наглядное сравнение товара с WordPress`) развёрнут на production. `/products/:id` показывает две административные карточки «Сейчас в WordPress / После merge», readiness и конкретные блокеры, а также изменения полей, категорий, меток, атрибутов, изображений и вариаций со статусами «добавится / снимется / останется / изменится». Для неполной классификации возвращается честный черновик на общем WordPress payload path; записывающий endpoint не вызывается. Финальный preflight выполняется только для полностью собранного payload.

Проверки локально и на production: `typecheck`, `225` тестов, `build`, миграции без pending, внутренний health `200`. Live API preview для `76399` вернул `200`, WordPress snapshot `772888`, target disabled и blocker `Категория`. Production HEAD `b0ca7c7`, API active, worker inactive. WordPress writes не выполнялись.

## Исправления WordPress merge preview 7 августа 2026

Устранены три ложных сигнала неполного preview. До WordPress preflight интерфейс больше не подменяет 22 исходные вариации пустым массивом: показывает их количество и прямо сообщает, что итоговые цены в рублях появятся после preflight. Для заголовка черновика применяется та же target-политика префикса, но к эффективной категории после merge, поэтому сохранённая `product_cat=75` даёт обязательный префикс `Кроссовки` даже пока новый category candidate остаётся unresolved. Длинное описание показывается отрендерированным до/после.

Краткое описание исключено из `managed_fields` WordPress exporter и не передаётся пустой строкой. WordPress product-upsert сохраняет возможность явно управлять этим полем для других клиентов, но больше не требует его для создания полного parser snapshot. Parser commit `5772809` и WordPress commit `c422e93` развёрнуты. На production прошли `typecheck`, `227` тестов, `build`, миграции без pending и PHP contract test. Live preview `76399` подтвердил: title с префиксом, `22/22` вариации, `short_description managed=false/changed=false`. Target `slamdunk=false`, API active, worker inactive, WordPress writes не выполнялись.

## Старые материалы

Использовать их как источник проверенного поведения и бизнес-правил, но не переносить код «ради готового кода»:

- старые версии: `C:\Users\gt99\Downloads\slds\Parser` и `C:\Users\gt99\Downloads\slds\Parser\v1`;
- старое ТЗ: `C:\Users\gt99\Downloads\slds\Parser\ТЗ Парсинг конвейер.pdf`;
- исходники WordPress: `C:\Users\gt99\Downloads\slds\Git\slamdunk`;
- основной новый проект: `C:\Users\gt99\Desktop\SLDS_PARSER`.

На сервере `ssh_parser` есть как минимум данные самого старого скриптового parser и более позднего v1. Они уже использовались для поиска старых classification mappings, связи WordPress `goat_id` с GOAT slug и проверки `TargetPayloadBuilder`. Не переносить таблицы целиком: старые global mappings могут терять контекст. Импортировать только подтверждённые target IDs, `tag_id`, формулы и правила после сверки с актуальным WordPress snapshot.

Если старый код расходится с новой архитектурой, брать только подтверждённую формулу, endpoint, mapping или бизнес-смысл и адаптировать под текущие контракты.

## Правила дальнейшей разработки

- Не заявлять, что блок готов, если отсутствует реальный адаптер/exporter или сквозной тест.
- Не называть разбор source payload «операцией обработки»: это обязанность `SourceProcessor`.
- Не классифицировать обычные факты только потому, что они присутствуют в payload.
- Не подменять неизвестное значение пустой строкой, нулём, случайным термином или guessed mapping.
- Не добавлять fallback «на всякий случай». Исправлять основной путь.
- Не хардкодить GOAT в универсальных сервисах и WordPress в классификаторе.
- Не включать target до регистрации и проверки exporter.
- Не запускать полный GOAT каталог для smoke; всегда задавать явный малый лимит.
- Не путать full discovery-only с full collection: `enqueueCollection: false` сохраняет только sitemap-реестр; отсутствие флага по-прежнему запускает каскад collection.
- Не ставить collection/process на весь discovery-каталог до измеренной выборки и подтверждённого лимита партии.
- Не экспортировать товары с пустыми offers или несколькими ожидаемыми брендами, пока их контракты не согласованы.
- Перед write export проверять полный preview diff, включая descriptions, taxonomies, вариации и identity/URL изображений.
- Не выводить `.env`, proxy, cookies, bearer-токены и WordPress import token в команды, логи и ответы.
- Production WordPress сначала исследовать read-only. Любые изменения — только в явно разрешённом объёме после проверки branch, worktree и diff.
- На production с грязным worktree не использовать destructive Git-команды. Перед pull проверять, что входящий diff не пересекается с локальными изменениями.
- Коммиты писать по-русски, кратко, без лишних символов и упоминаний ИИ.

## Проверки перед коммитом

Минимум:

```text
npm run typecheck
npm test
npm run build
node --check public/app.js
node --check public/product.js
git diff --check
```

При изменениях схемы дополнительно применять миграции на локальной PostgreSQL и проверять реальный repository/service query. При изменениях WordPress выполнять `php -l` для каждого изменённого PHP-файла.

Перед production deployment:

1. проверить чистоту нужных файлов и текущий commit;
2. убедиться, что обновление fast-forward;
3. выполнить `npm ci`, typecheck, tests, build;
4. применить миграции;
5. перезапустить API/worker;
6. проверить локальный и внешний health;
7. выполнить ограниченный функциональный smoke;
8. проверить jobs, журналы и отсутствие секретов.

## Как принимать решения

Если данных недостаточно, сначала исследовать код, PostgreSQL или read-only production и честно зафиксировать неизвестное. Не выдумывать поля DTO, WordPress endpoints, обязательность классификации и формулы старого parser.

При выборе между красивой абстракцией и простым расширяемым контрактом предпочитать явный контракт. Добавление нового источника, операции или target должно быть локальным изменением, но не ценой скрытой автозагрузки, неявных fallback и потери проверяемости.
