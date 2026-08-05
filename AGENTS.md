# SLDS Parser: рабочий контекст проекта

Этот файл — основная память проекта для следующих сессий. Перед изменениями сверяй его с кодом, `README.md`, актуальным `git status`, production jobs и последними миграциями. Снимки состояния и номера коммитов ниже относятся к 5 августа 2026 года и со временем могут устареть.

## Цель

Нужен универсальный конвейер товарных данных, к которому можно подключать разные источники и targets без переписывания ядра:

1. обнаружить и полностью собрать товары источника;
2. преобразовать данные в единый внутренний DTO и выполнить независимые операции обработки;
3. классифицировать значения относительно внутренних и target-справочников;
4. идемпотентно создать или обновить товар на target.

Первая рабочая вертикаль: `GOAT → SLDS Parser → WordPress/WooCommerce slamdunk.shop`.

Проект ещё не закончен. Сбор, обработка, классификатор, административная наблюдаемость, WordPress exporter и `slds.wordpress.product-upsert.v1` уже развёрнуты. Реальный update существующего WooCommerce-товара прошёл успешно и подтвердил идемпотентность повторного экспорта. Главный незакрытый блок теперь не deployment, а доведение бизнес-правил и безопасное масштабирование: товары без offers, коллаборации с несколькими брендами, качество перевода, полнота preview и формирование правил классификатора на репрезентативной выборке.

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
- миграции `001`–`013`;
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
- processing attempt, DTO процессора и выходы операций записываются транзакционно; старые обработки до миграции `013` не реконструируются;
- WordPress preview использует общий `buildWordPressUpsertPayload` и реальный read-only preflight, записывающие endpoints для preview не вызываются;
- API карточки не отдаёт локальные пути изображений.

Наблюдаемость реализована в parser commit `2116833` и исправлена commit `343fe13`. Проверены `/classifier`, `/products`, `/operations`, `/wordpress-snapshots` и `/products/:id`.

Оставшийся недостаток preview: автоматический diff сравнивает только `title`, `slug`, `sku`, наборы taxonomies, количество изображений и состояния вариаций. Он не сравнивает HTML описания и реальные URL/содержимое изображений. Перед массовым export это нужно исправить: ожидаемый payload и snapshot уже доступны, но оператор не должен искать такие расхождения вручную.

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

1. **Товары без offers.** Сейчас `UniversalProductDTO` и WordPress contract требуют непустой список вариаций. Нельзя выдумывать вариант или цену. Нужно явно решить контракт sold-out товара: сохранить товар без активных offers и безопасно деактивировать прежние вариации либо выбрать другую подтверждённую политику.
2. **Несколько брендов.** У коллабораций `Vans x Valentino` (`sourceProductId=27`, `28`) WordPress хранит два `pa_brand`, а GOAT даёт основной бренд Vans. Текущий payload заменил бы два бренда одним. Эти товары не экспортировать, пока не определено воспроизводимое извлечение и cardinality бренда.
3. **Переводы.** На `sourceProductId=32` машинный перевод colorway перевёл `Sail` как `Плыть`. Этот товар не экспортировался. Нужна проверяемая терминология/словарь, а не ручной fallback для одного текста.
4. **Материалы как обогащение.** Для ряда существующих товаров GOAT даёт `Mesh`/`Textile`, а WordPress пока не имеет `pa_material`. Preview предлагает добавить корректно сопоставленный термин, но массово применять такое обогащение можно только после бизнес-подтверждения.
5. **Дополнительные бренды/модельные теги.** Projections исправляют удаление существующих tags и могут добавлять отсутствующий подтверждённый model tag, например New Balance P400. Это ожидаемое target-обогащение, но его нужно видеть в полном diff.
6. **Preview descriptions/images.** Перед следующим write smoke добавить сравнение описания и image identity/URL, а не только количества изображений.

## Доступ и серверы

- новый parser production: MCP `ssh_slamdunk_parser`, `/srv/slds-parser/app`;
- WordPress production: MCP `ssh_slamdunk_prod`, `/var/www/u0347517/data/www/slamdunk.shop`;
- старый parser: MCP `ssh_parser`, только read-only источник данных и поведения;
- локальный parser: `C:\Users\gt99\Desktop\SLDS_PARSER`;
- локальный WordPress source: `C:\Users\gt99\Downloads\slds\Git\slamdunk`.

На рабочей Windows-машине настроены постоянные host routes к SSH-адресам parser/WordPress через обычный Ethernet в обход VPN. Если MCP SSH снова получает handshake timeout, сначала проверить выбранный маршрут и VPN, не менять proxy parser и не считать недоступность сайта следствием тестов без проверки. Default route, DNS и остальной VPN-трафик трогать не нужно.

## Текущее production-состояние на 2026-08-05

Parser:

- GitHub: `git@github.com:the-gt99/slds_parser.git`;
- production runtime commit на момент снимка: `fd21170` (`Добавить discovery без сбора товаров`); локальный и `origin/main` могут быть новее из-за обновления этого файла;
- сервер: MCP `ssh_slamdunk_parser`;
- каталог: `/srv/slds-parser/app`;
- состояние и изображения: `/srv/slds-parser/state`;
- домен: `https://9a9f7857687f.vps.myjino.ru`;
- службы: `slds-parser-api.service`, `slds-parser-worker.service`;
- PostgreSQL: Docker-контейнер `slds-parser-postgres`, наружу не открыт;
- миграции `001`–`013` применены;
- production deployment прошёл `typecheck`, `169` тестов и build;
- API и worker активны, внутренний и внешний health возвращают 200;
- production worktree чистый;
- target `slamdunk` ID `1` выключен;
- `requiredReferenceTypes`: `brand`, `model`, `category`;
- title prefixes настроены для category term IDs `74`, `75`, `865`;
- актуальные WordPress справочники и size mappings заполнены;
- 38 target classification projections активны;
- один target product (`internalProductId=68`) имеет статус `synced` после подтверждённого update smoke.

### Активный полный discovery-only

Commit `fd21170` добавил флаг job payload `enqueueCollection: false` и команду `npm run goat:enqueue-discovery`. Старое поведение остаётся default: без флага discovery продолжает ставить `collect_product`.

5 августа запущены job `196` и `source_collection_run` `7` с `runType=full`, `coverage=catalog`, `enqueueCollection=false`. Источник настроен без `maxProductsPerRun`, `discoveryBatchSize=500`, `requestDelayMs=1000`.

На момент обновления этого файла:

- job/run активны, attempts `1`, ошибок нет;
- checkpoint: `484000` записей, `childIndex=425` из `948` дочерних sneakers/apparel sitemap;
- в `source_products` около `484000` строк;
- downstream jobs после `196`: `0`; карточки, offers, переводы и изображения не скачиваются;
- только 20 ранее собранных товаров имеют `external_id`; sitemap discovery сохраняет slug/URL/metadata, GOAT ID появляется после collection;
- PostgreSQL около `490 MB`, на сервере свободно около `73 GB`;
- итоговый размер каталога заранее не считать равным 300 тысячам: актуальные sitemap уже дали больше 400 тысяч.

Discovery работает в фоне и сохраняет checkpoint каждые 500 товаров. Перед любыми действиями с очередью сначала проверить job `196`, run `7`, фактический checkpoint и отсутствие downstream jobs. Не перезапускать полный discovery вторым job, пока этот run активен.

WordPress:

- GitHub: `git@github.com:Stasvelin/slamdunk.git`;
- локальный и production commit на момент снимка: `6978677` (`Исправить снимки старых вариаций`);
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

### 1. Дождаться и проверить discovery-only

- проверить завершение job `196` и run `7` со status `completed` и completeness `complete`;
- записать фактическое число уникальных товаров, child sitemap, длительность и итоговый размер PostgreSQL;
- убедиться, что после job `196` не появились `collect_product`, `process_product` или `export_product`;
- проверить дубликаты `sourceKey`, пустые slug/URL и распределение `metadata.route` по sneakers/apparel;
- не запускать второй full discovery поверх активного run.

### 2. Исправить блокеры до большой обработки

- спроектировать явное состояние товара без offers и согласовать, как оно деактивирует старые вариации WordPress без выдуманной цены/размера;
- определить контракт нескольких брендов для коллабораций и проверить cardinality `brand` end-to-end;
- расширить WordPress preview сравнением description HTML и image URLs/identity;
- проверить и исправить системную терминологию перевода colorway, начиная с `Sail`, без точечного fallback;
- решить, считать ли заполнение отсутствующего `pa_material` допустимым автоматическим обогащением;
- добавить безопасный cohort enqueue: выбирать discovery-товары явным списком/лимитом и не создавать массовую очередь случайно.

### 3. Репрезентативная классификационная выборка

После исправления блокеров не обрабатывать весь каталог сразу.

1. Выбрать 500–1000 разнообразных товаров по `route`, брендам/названиям, аудитории и датам sitemap.
2. Собрать `product` и `offers`, выполнить операции, но оставить target выключенным.
3. Оценить долю no-offers, failed operations, объём media и скорость worker.
4. Разобрать очередь классификатора, формируя точные mappings и контекстные rules; не сопоставлять только ради уменьшения очереди.
5. После первой проверки расширить cohort до 2000–5000, а затем партиями по 10000–20000.

Массовые правила модели строить по evidence `brand + family` и проверять preview конфликтов. Отдельно вернуться к Pegasus/Surge и другим семействам, где голое название неоднозначно. Движок классификатора не переписывать под GOAT.

### 4. Следующие WordPress smoke

Target оставить выключенным. Выполнить контролируемо:

- update ещё нескольких существующих товаров, включая изменение набора активных размеров;
- create нового товара сначала как draft и ручную проверку всех полей;
- повтор того же export и проверку `skipped`/idempotency;
- update ранее созданного новым parser товара;
- отдельный тест unavailable/sold-out после согласования контракта;
- проверку отсутствия дублей, taxonomies, projections, prices, stock, images, descriptions и публичной карточки.

Только после серии из 5–50 проверенных товаров обсуждать включение target. Сам факт одного успешного update не разрешает массовый export.

### 5. Эксплуатация полного каталога

После успешной классификационной выборки и exporter smoke:

- планировать полный collection/processing партиями, а не одной очередью на весь каталог;
- отдельно настроить частое обновление offers;
- добавить ETag/304 там, где источник поддерживает;
- подтвердить политику исчезнувших товаров;
- измерить безопасную concurrency до запуска нескольких workers;
- настроить мониторинг jobs, ошибок, зависших locks, диска, PostgreSQL и media;
- настроить резервное копирование PostgreSQL и `/srv/slds-parser/state`.

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
- Перед write export проверять не только автоматический diff, но и descriptions и реальные изображения, пока preview не расширен.
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
