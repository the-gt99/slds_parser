# SLDS Parser

ESM-проект на Node.js и TypeScript для конвейера сбора, обработки и экспорта данных о товарах.

## Реализовано

- универсальные DTO и контракты адаптера, процессора, операции и экспортера;
- PostgreSQL-схема и последовательный migration runner с транзакциями и advisory lock;
- PostgreSQL repositories и `PostgresUnitOfWork` для атомарных операций;
- универсальный `ProductClassifier`: точные source mappings, контекстные правила, явные неизвестные и игнорируемые значения;
- отдельный `TargetReferenceMappingService`, не смешивающий внутреннюю классификацию с идентификаторами target;
- типизированные прикладные ошибки, реестры компонентов и стабильное SHA-256-хэширование;
- первый вертикальный срез GOAT: sitemap, карточка, offers и `UniversalProductDTO`;
- цепочка обработки товара: нормализация, перевод, скачивание изображений, проверка и конвертация в WebP, публикация ссылок и финальная проверка;
- unit-тесты на Vitest, не требующие запущенного PostgreSQL или сети;
- отдельный Fastify API с классификатором и защищённой карточкой товара;
- история выполнения каждой операции обработки товара.
- read-only наблюдаемость: реестр товаров и операций, снимки WordPress, сохранённые стадии processing attempts и WordPress preflight без создания export job;
- WordPress exporter с source-neutral identity, строгим `product-upsert.v1`, target readiness и ожиданием результата внешнего job.

## Конвейер

Ядро состоит из трёх независимых циклов:

1. `CollectionRunner` обнаруживает товары постранично и собирает их произвольные части.
2. `ProcessingRunner` преобразует сохранённые части в базовый `UniversalProductDTO`, применяет зарегистрированные операции и отдельно запускает универсальный классификатор.
3. `ExportRunner` синхронизирует внутренний товар с каждой включённой целью.

Между этапами нет прямых вызовов: переходы выполняются через PostgreSQL jobs. Поддерживаются четыре типа задач:

- `discover_source` — discovery включённого источника с checkpoint; флаг `enqueueCollection: false` сохраняет только реестр товаров;
- `collect_product` — сбор всех или явно запрошенных частей товара;
- `process_product` — построение внутреннего товара;
- `reclassify_product` — применение новых mappings/rules к уже обработанному DTO без повторного процессора, перевода и изображений;
- `export_product` — экспорт внутреннего товара в одну цель.

Один `Worker` использует отдельные lane-группы для discovery, collection, processing, WordPress preflight и export. Processing lanes задаются `WORKER_PROCESS_CONCURRENCY` от 1 до 16, collection lanes — `WORKER_COLLECTION_CONCURRENCY` от 1 до 16, preflight lanes — `WORKER_PREFLIGHT_CONCURRENCY` от 1 до 8. Эти env-значения создают первоначальную runtime-конфигурацию; затем collection, processing и preflight concurrency управляются на странице `/runtime`, сохраняются в PostgreSQL с ревизией и применяются при следующем запуске worker. Discovery и записывающий export остаются последовательными. При включённом GOAT proxy pool collection lane сначала резервирует свободный session slot и только потом claim-ит `collect_product`; если свободных слотов на проверенных proxy нет, job остаётся `pending` без увеличения attempts. `JobRepository.claimNext` фильтрует типы и использует `FOR UPDATE SKIP LOCKED`. Просроченные `running` locks снова доступны после `WORKER_LOCK_TIMEOUT_MS`; число попыток увеличивается атомарно при claim.

Повторяются только `RetryableError`, пока число попыток меньше `MAX_JOB_ATTEMPTS`. Задержка растёт экспоненциально от `JOB_RETRY_BASE_MS` и ограничивается `JOB_RETRY_MAX_MS`. `PermanentError` и неизвестные программные ошибки сразу завершают задачу как `failed`. Terminal failure discovery дополнительно помечает активный `source_collection_run` как `failed`.

## Транзакционные границы

Вызовы `SourceAdapter`, `SourceProcessor`, `ProductOperation` и `TargetExporter` выполняются вне транзакций. В одной короткой `UnitOfWork`-транзакции атомарно сохраняются:

- discovery-страница, её checkpoint и задачи `collect_product`;
- собранные parts и задача `process_product`;
- внутренний товар, наблюдения классификатора и все допустимые задачи `export_product`.

Внешний экспорт нельзя атомарно объединить с PostgreSQL. Поэтому `TargetExporter` обязан быть идемпотентным: внешний запрос мог завершиться успешно до сбоя сохранения результата. Export fingerprint учитывает content hash товара, версию exporter, конфигурацию target и revision mappings.

## GOAT

GOAT discovery читает `https://www.goat.com/sitemap`, отбирает только дочерние sitemap для sneakers и apparel и сохраняет slug, URL, маршрут, `lastmod`, заголовок и изображения. HTML карточек не разбирается. Сбор товара сохраняет две части:

Полный реестр без постановки товаров на сбор запускается командой `npm run goat:enqueue-discovery`. Размер одной сохраняемой страницы задаётся `GOAT_DISCOVERY_BATCH_SIZE`, по умолчанию `500`.

- `product` — полный JSON карточки и проверенное представление полей товара;
- `offers` — полный JSON buy bar и проверенный массив предложений с рынком.

Процессор сохраняет размеры строками, состояния товара и коробки, наличие, основную, Instant Ship и last sold цены. Для каталога остаются только офферы `new_no_defects`; если на размер пришло несколько офферов, выбирается вариант с лучшим наличием, затем с меньшей основной ценой и стабильным ключом. Отсутствующая сумма остаётся `null`, cents преобразуются в decimal-строку без float. В классификатор он передаёт только значения, которым действительно требуется соответствие со справочником target: бренд, модель, категорию, цвет, материал и теги. Пол, `silhouette`, система размеров, размеры вариантов, состояния товара и коробки остаются данными и контекстом товара, но не засоряют очередь классификатора. Кандидат модели использует полное название и контекст бренда/семейства.

После процессора применяются операции обработки. Нормализация очищает только известные поля DTO и старые spreadsheet-маркеры ошибок, удаляет дубли URL и GOAT-заглушки изображений. Исходный текст сохраняется, перевод записывается отдельно в `translatedContent`. Изображения скачиваются через GOAT-транспорт, проверяются декодированием, сохраняются локально, конвертируются в WebP с качеством 85 и получают публичные URL. Частичная потеря изображений допустима. Товар только с GOAT-заглушкой сохраняется как внутренний DTO с `images: []`, а товар без offers — с `variants: []`; данные и цены не выдумываются. Финальная универсальная проверка требует название, SKU и исходный бренд. WordPress exporter запрещает запись без реального изображения. Пустой список вариантов для существующего товара означает sold-out и снимает с продажи все его вариации; новый товар без вариантов не создаётся.

Операция формирования HTML-описания намеренно отсутствует: WordPress exporter собирает безопасный HTML после классификации из переведённого текста и универсальных свойств товара.

Транспорт требует curl-impersonate и не подменяет его системным curl. На Linux укажите путь к `curl_chrome116`. На Windows можно указать исполняемый файл или `.ps1` wrapper, который запускает curl-impersonate. Старый `.cmd` поддерживается через соседний `goat-curl.ps1`, чтобы URL с несколькими query-параметрами не разбирался командной оболочкой. Пример настройки:

```dotenv
GOAT_CLI_CURL_BIN=C:\path\to\goat-curl.cmd
GOAT_COOKIE_JAR_PATH=/mnt/c/path/to/goat-cookie-jar.txt
GOAT_PROXY_HTTP=
GOAT_PROXY_SOCKS5=
GOAT_PROXY_POOL_ENABLED=false
GOAT_PROXY_CONCURRENCY_PER_PROXY=1
GOAT_PROXY_TEST_URL=https://www.goat.com/
PARSER_PROXY_ENCRYPTION_KEY=
GOAT_CF_CLEARANCE=
GOAT_HTTP_TIMEOUT_MS=25000
GOAT_MAX_RESPONSE_BYTES=10485760
GOAT_SESSION_TTL_MS=600000
GOAT_SMOKE_PRODUCT_LIMIT=1
GOAT_COHORT_PRODUCT_LIMIT=500
GOAT_COHORT_ROUTES=sneakers,apparel
GOAT_COHORT_SEED=1
GOAT_COHORT_APPLY=false
GOAT_COHORT_ENQUEUE_PROCESSING=true
GOAT_IMAGE_DOWNLOAD_CONCURRENCY=8
PARSER_IMAGE_BASE_DIR=/srv/slds-parser/state/images
PARSER_PUBLIC_BASE_URL=https://static.example.com
PARSER_PUBLIC_PATH_PREFIX=products
PARSER_TRANSLATION_SOURCE=en
PARSER_TRANSLATION_TARGET=ru
PARSER_TRANSLATION_TIMEOUT_MS=8000
PARSER_TRANSLATION_ATTEMPTS=2
PARSER_TRANSLATION_RETRY_DELAY_MS=400
SHOE_HEIGHT_API_URL=
SHOE_HEIGHT_API_TIMEOUT_MS=20000
SHOE_HEIGHT_API_ATTEMPTS=2
SHOE_HEIGHT_API_RETRY_DELAY_MS=400
SHOE_HEIGHT_SOURCE_IMAGE_POSITION=0
```

HTTP и SOCKS5 proxy взаимоисключающие в старом env-режиме. Для управляемого пула задайте `PARSER_PROXY_ENCRYPTION_KEY` как 32-byte base64/hex secret, импортируйте текущий env proxy командой `npm run proxy:import-env`, проверьте `npm run proxy:test -- <id>`, включите `npm run proxy:enable -- <id>` и только затем выставляйте `GOAT_PROXY_POOL_ENABLED=true`. `GOAT_PROXY_CONCURRENCY_PER_PROXY` задаёт от 1 до 16 одновременных независимых сессий на каждый healthy enabled proxy; итоговый collection parallelism дополнительно ограничен `WORKER_COLLECTION_CONCURRENCY`. После включения pool GOAT runtime использует repository/pool; старые `GOAT_PROXY_HTTP`/`GOAT_PROXY_SOCKS5` можно оставить для rollback, но они не являются скрытым fallback. Клиент делает session warm-up, один раз обновляет сессию после 403, соблюдает timeout и лимит ответа. Transport errors, повторный 403, 408, 425, 429 и 5xx повторяются Worker; 404 карточки и остальные 4xx завершаются постоянно. HTML challenge считается временной ошибкой, неверная JSON/XML-структура — ошибкой интеграционного контракта.

Страница `/proxies` и API `/api/proxies` требуют admin authentication; browser mutations дополнительно требуют CSRF. API не возвращает username, password, ciphertext, IV/auth tag или полный proxy URL. Новый proxy создаётся выключенным, включение разрешено только после успешной проверки через тот же curl-impersonate transport. Password в форме редактирования не предзаполняется; пустое поле не стирает сохранённый secret. Проверочный URL задаётся сервером через `GOAT_PROXY_TEST_URL` и не принимается от клиента.

Путь `GOAT_COOKIE_JAR_PATH` должен быть понятен самому curl-процессу: для Windows wrapper, запускающего бинарник через WSL, используйте путь `/mnt/c/...`; для нативного Windows-бинарника — обычный Windows path. В pool-режиме collection jar получает suffix `.proxy-ID.session-N`, а загрузчик изображений создаёт отдельные jars `.images-N.proxy-ID.session-N`, поэтому параллельные сессии и processing lanes не пишут в один cookie-файл. Product и offers одного `collect_product` attempt идут через один закреплённый proxy/session/client/cookie jar; следующий retry может получить другой proxy или свободный session slot по deterministic round-robin.

Для безопасной живой проверки задайте `GOAT_SMOKE_PRODUCT_LIMIT` от 1 до 100, затем выполните:

```text
npm run db:migrate
npm run goat:enqueue-smoke
npm run worker
```

CLI создаёт или обновляет source `goat`, записывает лимит в его config и ставит одну discovery-задачу. Не запускайте smoke-команду без лимита; обычный адаптер без `maxProductsPerRun` рассчитан на полный каталог.

Для уже сохранённого discovery-каталога используйте `npm run goat:enqueue-cohort`. Команда ничего не записывает без `GOAT_COHORT_APPLY=true`, выбирает только ещё не собранные товары и требует явный лимит от 1 до 20000. `GOAT_COHORT_ROUTES` делит квоту поровну между маршрутами, а `GOAT_COHORT_SEED` делает выборку воспроизводимой. Вместо лимита можно передать точный список `GOAT_COHORT_PRODUCT_IDS`; смешивать два режима нельзя. Если выбран полный объём не набран, jobs не создаются. По умолчанию успешный collection ставит downstream processing; для изолированного замера сбора задайте `GOAT_COHORT_ENQUEUE_PROCESSING=false`, и это значение будет явно сохранено в payload каждой collection job.

Для постановки всего ещё не собранного source route используйте `npm run goat:enqueue-route-collection` с явным `GOAT_ROUTE_COLLECTION_ROUTE`. Команда по умолчанию выполняет только подсчёт. `GOAT_ROUTE_COLLECTION_APPLY=true` одним атомарным PostgreSQL-запросом создаёт collection jobs для всего текущего остатка route; payload всегда содержит `enqueueProcessing=false`, поэтому processing и export не запускаются.

Вкладка «Точные совпадения» в `/classifier` показывает unresolved-значения, чьё нормализованное имя полностью совпадает с актуальным термином target. К применению допускается только единственный термин без конфликта уже существующих решений; дубликаты target и конфликты вынесены в отдельные списки. Категории исключены из-за иерархии. Массовая запись доступна только при выключенном target, идёт пакетами по 50 через штатный сервис решений с аудитом и точечной постановкой переобработки. `npm run classifier:exact-matches` использует тот же серверный путь для диагностики и управляемого запуска через `CLASSIFIER_EXACT_MATCH_APPLY=true`.

`PARSER_IMAGE_BASE_DIR` должен быть доступен HTTP-серверу по адресу, образованному из `PARSER_PUBLIC_BASE_URL`, `PARSER_PUBLIC_PATH_PREFIX` и относительного пути файла. Без реального публичного URL worker не запускается: выдуманный адрес сделал бы сохранённые ссылки нерабочими. Переводчик перенесён из старого проекта через отдельный provider и использует его неофициальный Google Translate endpoint; поэтому его можно заменить, не меняя операцию и DTO. При заданном `SHOE_HEIGHT_API_URL` первая скачанная фотография обуви отправляется отдельному классификатору высоты, а результат `low`/`mid`/`high` добавляется в обычную очередь классификации как `shoe_height`; одежда этой операцией не обрабатывается.

WordPress importer скачивает готовые WebP по публичным URL, поэтому `publish-images` и `PARSER_PUBLIC_BASE_URL` остаются частью текущего рабочего контракта.

Пока не реализованы ETag/304, подтверждение удаления исчезнувших товаров и отдельное частое расписание обновления offers. Неизвестные reference-кандидаты сохраняются как штатный `classification_pending`, а не ошибка worker; export job создаётся только после полной классификации. WordPress exporter дополнительно требует перечисленные target-ом reference-типы, их `target_value_mappings` и точное сопоставление каждого размера.

## Расширение

Новый источник подключается реализациями `SourceAdapter` и `SourceProcessor`, после чего обе явно регистрируются в `registerPipelineComponents` в `src/bootstrap.ts`. Новый target подключается реализацией `TargetExporter` и явной регистрацией там же.

`SourceProcessor` не имеет доступа к mappings. Он выдаёт source-neutral `referenceCandidates`: тип, область применения, субъект `product`/`variant`, исходное значение, контекст точного mapping и дополнительные evidence для правил. Классификатор не импортирует интеграции источников. Новый справочный параметр добавляется регистрацией `reference_type` и кандидатом от процессора либо enrichment-операции; сам движок менять не требуется.

Правила поддерживают `equals`, `contains`, `all_words` и продвинутый `regex`. Они могут читать `sourceValue`, `scope`, `subjectKind`, а также верхнеуровневые `context.*` и `evidence.*`. Побеждает наивысший priority, затем source-specific правило и число условий. Два одинаково сильных правила с разными результатами дают `rule_ambiguous`, а не случайный выбор. Изменение mapping или правила позволяет повторно классифицировать сохранённый DTO без повторного скачивания карточки, перевода и изображений.

Обработка готового `UniversalProductDTO` расширяется реализациями `ProductOperation`. Операции выполняются в порядке регистрации. Обязательные предыдущие операции перечисляются в `dependsOn`; отсутствующая, отключённая для источника или зарегистрированная позже зависимость считается ошибкой конфигурации. Если `sourceCodes` не задан, операция применяется ко всем источникам; иначе только к перечисленным. Операция не должна менять `sourceProductId` и должна возвращать новый DTO. Добавление состоит из файла с реализацией и одной явной регистрации в `registerPipelineComponents` — наличие файла само по себе не активирует логику.

Версия и `configurationFingerprint` каждой применимой операции входят в input hash внутреннего товара вместе с конфигурацией источника, идентичностью товара, discovery metadata и хешами source parts. Поэтому изменение кода операции сопровождается увеличением её версии, а изменение влияющих на результат настроек — обновлением fingerprint. После каждого успешного сбора создаётся hash-checked задача обработки: она запускает новые версии операций даже при неизменившихся source parts, а полностью неизменившийся input быстро пропускается.

## PostgreSQL-схема

Первая миграция создаёт базовые предметные таблицы:

- `sources` — источники и конфигурация адаптеров;
- `source_collection_runs` — запуски discovery каталога, их checkpoint, полнота и статистика. Таблица не отражает завершение всех `collect_product`;
- `source_products` — обнаруженные во внешних источниках товары и их идентичность;
- `source_product_parts` — только актуальное состояние собранных частей товара;
- `reference_types` — типы справочников;
- `reference_values` — внутренние нормализованные значения справочников;
- `source_value_mappings` — исходная таблица source mappings, оставленная для миграции ранних данных;
- `internal_products` — универсальные обработанные товары и контрольные хэши;
- `targets` — цели экспорта и конфигурация exporters;
- `target_value_mappings` — представление справочных значений в конкретной цели;
- `target_products` — состояние синхронизации внутреннего товара с целью;
- `jobs` — очередь discovery, collection, processing и export задач.
- `product_operation_executions` — попытки и результаты отдельных операций обработки товара.
- `product_processing_attempts` — честные снимки DTO после процессора, после операций и после классификации для новых попыток обработки.

Служебная таблица `schema_migrations` хранит имена уже применённых SQL-файлов. Отдельная seed-миграция идемпотентно добавляет начальные типы справочников.

Миграция универсального классификатора добавляет:

- `source_reference_mappings` — точные подтверждённые либо игнорируемые решения с контекстом, revision и аудитом;
- `source_reference_rules` — общие или source-specific контекстные правила;
- `classification_candidates` — уникальные source-значения классификации с типом, scope и контекстом решения;
- `source_product_classification_links` — компактные связи товаров с кандидатами, индивидуальным статусом и использованным решением;
- `source_product_classification_evidence` — наборы evidence, хранящиеся один раз на товар вместо копии в каждом кандидате;
- `source_product_classification_states` — версия процессора, классификатора и fingerprint один раз на товар;
- `classification_observation_read_model` — явное read-only представление для PostgreSQL-функций обслуживания очереди; application repositories собирают нужные данные напрямую из нормализованных таблиц;
- `source_reference_decision_history` — история будущих действий интерфейса над mappings и правилами.
- `classification_review_rule_coverage` — ещё не применённые к товарам совпадения активных правил;
- `classification_review_groups` — быстрая проекция очереди классификатора со счётчиками состояний «требует решения» и «ждёт обработки».

Проекция не заменяет наблюдения как источник истины. Обработка товара обновляет её дельтой только по этому товару, а изменение точного сопоставления или правила пересчитывает затронутые группы в той же транзакции и ставит `reclassify_product`. Лёгкая переклассификация сохраняет прежние `inputHash`, `processorVersion` и время полной обработки, поэтому не маскирует реально устаревший DTO. Во время массового применения сохранённых назначений такие jobs удерживаются до создания всех правил и дедуплицируются по товару. Для проверки или восстановления после ручных изменений БД используется `npm run classifier:rebuild-review`; команда блокирует записи классификатора на время полного пересчёта и не предназначена для частого расписания.

У `reference_types` задаются разрешённые субъекты (`product`/`variant`) и кратность (`single`/`multiple`). Бренд, модель и цвет остаются одиночными значениями товара; категории, материалы, назначения и теги могут быть множественными, а размер относится к конкретному варианту.

## Миграции

1. Скопируйте `.env.example` в `.env` и укажите строку подключения либо задайте `DATABASE_URL` в окружении.
2. Запустите `npm run db:migrate`.

Для worker также задайте `WORKER_ID`, `WORKER_POLL_INTERVAL_MS`, `WORKER_LOCK_TIMEOUT_MS`, `WORKER_PROCESS_CONCURRENCY`, `WORKER_COLLECTION_CONCURRENCY`, `WORKER_PREFLIGHT_CONCURRENCY`, `MAX_JOB_ATTEMPTS`, `JOB_RETRY_BASE_MS` и `JOB_RETRY_MAX_MS`. Collection и processing concurrency допускаются от 1 до 16, preflight concurrency — от 1 до 8, остальные числовые значения должны быть положительными целыми, а базовая retry-задержка — не больше максимальной. После создания строки `runtime_worker_settings` значения из PostgreSQL являются основным runtime-источником, а env остаётся первоначальным значением.

Конфигурация подключения читается при создании пула. Поэтому импорт модулей не требует `DATABASE_URL`, а попытка создать подключение без этой переменной завершится понятной ошибкой. Миграции применяются в порядке имён файлов, каждая в отдельной транзакции. PostgreSQL advisory lock исключает параллельный запуск двух migration runners.

## Контракты хранения

Интерфейсы `SourceRepository`, `SourceRunRepository`, `SourceProductRepository`, `InternalProductRepository`, `ReferenceRepository`, `TargetRepository` и `JobRepository` реализованы для PostgreSQL. Фабрика `createPostgresRepositories` создаёт их для пула или отдельного клиента.

Атомарные изменения нескольких таблиц выполняются через `PostgresUnitOfWork`. Внешние HTTP-вызовы и другую долгую работу необходимо завершать до открытия транзакции. Конкурентные гарантии `JobRepository` заложены в SQL, но ещё должны быть проверены интеграционным тестом с настоящим PostgreSQL; unit-тесты используют только fake executor и не доказывают поведение реальной СУБД при конкуренции.

Все PostgreSQL `BIGINT` представлены в TypeScript строками, чтобы не терять точность.

## Команды

- `npm run api` — запустить собранный API на `PARSER_HTTP_HOST` и `PARSER_HTTP_PORT`;
- `npm run dev` — запуск точки входа через `tsx` в watch-режиме;
- `npm run db:migrate` — применить PostgreSQL-миграции;
- `npm run db:cleanup` — удалить истёкшие operational jobs, processing history и неактивные наблюдения небольшими пакетами;
- `npm run goat:enqueue-discovery` — сохранить полный sitemap-реестр без collection;
- `npm run goat:enqueue-cohort` — проверить либо поставить ограниченную выборку discovery-товаров на collection;
- `npm run goat:enqueue-route-collection` — посчитать либо атомарно поставить весь остаток route на collection без downstream processing;
- `npm run goat:enqueue-smoke` — создать ограниченный GOAT source и поставить discovery-задачу;
- `npm run proxy:import-env` — идемпотентно импортировать текущий `GOAT_PROXY_HTTP`/`GOAT_PROXY_SOCKS5` или legacy `GOAT_HTTP_PROXY`/`GOAT_SOCKS5_PROXY` в зашифрованную выключенную запись;
- `npm run proxy:test`, `npm run proxy:enable`, `npm run proxy:disable` — проверить и управлять proxy record по ID без печати секретов;
- `npm run classifier:exact-matches` — найти либо применить однозначные точные связи с target-справочником;
- `npm run classifier:rebuild-review` — полностью пересобрать проекцию очереди классификатора;
- `npm run worker` — запустить worker с отдельными discovery, collection, processing и export lanes; `SIGINT` и `SIGTERM` корректно останавливают цикл и закрывают Pool;
- `npm run typecheck` — проверить типы;
- `npm test` — однократно запустить unit-тесты;
- `npm run test:watch` — запустить тесты в watch-режиме;
- `npm run build` — собрать проект в `dist`.

## HTTP API

API запускается отдельным процессом после `npm run build` и по умолчанию слушает только `127.0.0.1:3000`. Адрес и порт задаются через `PARSER_HTTP_HOST` и `PARSER_HTTP_PORT`. `GET /api/health` выполняет `SELECT 1`: при доступной PostgreSQL возвращает `200` и `{"status":"ok"}`, при недоступной — `503` и `{"status":"unavailable"}`. Ответ не содержит версий, настроек и деталей ошибки подключения.

Интерфейс классификатора доступен по `/` и `/classifier`. Для входа используются `PARSER_ADMIN_USERNAME` и `PARSER_ADMIN_PASSWORD`; браузерная сессия подписывается `PARSER_SESSION_SECRET`, хранится в защищённой HttpOnly-cookie и действует 12 часов. Все изменения из браузера защищены CSRF-токеном. Для автоматизации API также принимает `Authorization: Bearer <PARSER_ADMIN_TOKEN>`. Токен и секрет сессии короче 32 символов, а пароль короче 12 символов не принимаются. Health endpoint остаётся публичным.

Создание записей WordPress доступно авторизованному администратору и защищено общей проверкой сессии и CSRF. Перед записью интерфейс требует явно подтвердить название и создание записи.

Маршруты классификатора:

- `GET /api/classifier/queue` — сгруппированные неизвестные и неоднозначные значения из быстрой проекции с точным `total`, серверным поиском и `limit`/`offset`; интерфейс подгружает следующие страницы при прокрутке;
- `GET /api/classifier/queue/:reviewGroupId/examples` — до трёх примеров товаров только для выбранной группы;
- `GET /api/classifier/reference-values` — поиск внутренних справочных значений;
- `POST /api/classifier/decisions` — подтвердить либо игнорировать точное source-сопоставление и поставить затронутые товары на повторную обработку;
- `POST /api/classifier/rules/preview` — проверить область действия правила и возможные конфликты без записи;
- `POST /api/classifier/rules` — сохранить проверенное правило и точечно переобработать затронутые товары;
- `POST /api/classifier/wordpress-assignments/apply` — поставить выбранные безопасные предложения сохранённого импорта WordPress в фоновую очередь;
- `POST /api/classifier/wordpress-assignments/apply-all` — одним коротким запросом поставить в очередь все безопасные предложения текущего фильтра; отдельная настраиваемая группа worker-потоков применяет их в фоне, поэтому закрытие страницы и HTTP timeout не прерывают работу;
- `GET /api/products/:productId` — безопасное представление товара, его частей, классификации, операций, jobs и состояния выгрузки;
- `GET /api/products` — поиск, фильтры и пагинация общего реестра товаров;
- `GET /api/operations` — фактический runtime registry операций;
- `GET /api/jobs` — очередь с фильтрами, статусами и ошибками;
- `POST /api/jobs/:jobId/run` — синхронно выполнить только выбранный pending/retry `process_product`, не запуская остальную очередь;
- `GET /api/runtime`, `POST /api/runtime/start`, `POST /api/runtime/stop` — состояние и управление единственным production worker `slds-parser-worker.service`;
- `POST /api/runtime/settings` — сохранить collection, processing, применение связей классификатора и WordPress preflight concurrency; `restart=true` применяет новую ревизию перезапуском активного worker;
- `GET /api/wordpress-snapshots` — поиск и пагинация сохранённых снимков WordPress;
- `GET /api/products/:productId/wordpress-preview?targetId=...` — локальная пересборка preview по последнему сохранённому WordPress preflight без внешнего запроса;
- `POST /api/products/:productId/wordpress-preflight` — явное read-only обновление сохранённого preflight с WordPress;
- `GET /api/export-control` — курсорный список сохранённых результатов preflight без live-запросов в WordPress и без полного подсчёта строк;
- `POST /api/export-control/preflights` — поставить выбранные либо следующие устаревшие товары в отдельную ограниченную очередь проверки;
- `POST /api/export-control/export/preview` и `POST /api/export-control/export` — проверить состав и атомарно поставить подтверждённую партию на ручной экспорт;
- `GET /api/export-control/batches` — последние партии и их текущие job-результаты;
- `POST /api/export-control/campaigns` запускает устойчивую скользящую выгрузку: ограниченное окно preflight, строго последовательный export только существующих товаров с `risk=none`, пауза после первой новой ошибки и необязательный общий лимит;
- `GET /api/export-control/campaigns` и `/api/export-control/campaigns/:id/items` показывают состояние потока и точный список записанных/ошибочных товаров; поток можно остановить и продолжить отдельными endpoints;
- `GET/POST /api/wordpress-catalog/runs` — история и запуск возобновляемой выгрузки полного компактного каталога WordPress в PostgreSQL;
- `GET /api/wordpress-catalog/runs/:id/items` — сохранённые снимки, строгие результаты сопоставления, локальный аудит и состояние отдельной очереди цен/остатков;
- `POST /api/wordpress-catalog/runs/:id/variation-canary` обновляет один выбранный товар, а `POST .../variation-sync` включает поток для уже сохранённых и следующих страниц только после успешного canary;
- `GET /api/targets` и `GET /api/targets/:targetId/dictionary` — targets и их локальные снимки справочников;
- `POST /api/targets/:targetId/dictionary/sync` — обновить снимок через зарегистрированный target-адаптер;
- `POST /api/targets/:targetId/dictionary/terms` — создать поддерживаемый target-термин и затем атомарно сохранить обе локальные связи.
- `/api/targets/:targetId/assignment-rules` — просмотр, preview, создание, редактирование, включение и история условных назначений target после классификации. Условия хранятся нормализованно: альтернативы внутри блока соединяются через `ИЛИ`, блоки — через `И`.
- `/api/targets/:targetId/assignment-match-sets` — переиспользуемые редактируемые наборы значений для больших списков моделей. Один набор может использоваться несколькими правилами; API отдельно показывает точные пересечения наборов.

WordPress-адаптер включается только когда одновременно заданы `PARSER_WORDPRESS_BASE_URL` и `PARSER_WORDPRESS_AUTH_TOKEN`. Target выбирает его через `exporter_code = 'wordpress'` либо `config.dictionaryProviderCode = 'wordpress'`. В `target.config.dictionaryEntityMap` задаётся универсальное сопоставление типов классификатора с сущностями target, например `{"brand":"brands","model":"models","category":"product_categories","tag":"tags"}`. При необходимости `target.config.targetScopeMap` преобразует универсальные scope в scope конкретного target. Классификатор не содержит названий полей GOAT или WordPress.

Для экспорта target обязан явно задать `config.requiredReferenceTypes` и `config.sizeMappings`. Первый список определяет обязательные универсальные типы именно для этого target. Второй хранит подтверждённые соответствия размеров; наиболее точная строка может учитывать `sourceValue`, `displayValue`, `system` и `audience`, а также содержит `taxonomy` и числовой `termId`:

```json
{
  "requiredReferenceTypes": ["brand", "model", "category"],
  "sizeMappings": [
    {"sourceValue": "7", "system": "us-numeric", "audience": "men", "taxonomy": "pa_razmer", "termId": 183},
    {"sourceValue": "103", "displayValue": "S", "system": "standard-clothing", "audience": "unisex", "taxonomy": "pa_razmer", "termId": 1234}
  ]
}
```

Числа в примере являются форматом, а не готовой production-настройкой. Term ID необходимо брать из актуального target-справочника. Отсутствующее или неоднозначное соответствие останавливает export до HTTP-запроса. Exporter заменяет только те taxonomy-типы, которые реально присутствуют среди кандидатов товара; отсутствующий source-тип не очищает ручные значения WordPress. `pa_brand` и `pa_model` допускают несколько подтверждённых терминов, добавленных projections или target assignment rules. При нескольких брендах конвертация размера использует единственный основной бренд, разрешённый из source-кандидата, а не дополнительные target-назначения. GOAT availability передаётся без `quantity`, если источник не сообщил точный остаток. Недоступный вариант без цены передаёт явный `price=null` и очищает прежнюю стоимость; доступный вариант без цены не экспортируется. Если свежий запрос GOAT не вернул ни одного offer, существующий WordPress-товар получает пустой активный снимок: все его вариации становятся `outofstock`, но не удаляются. Создание нового товара без вариантов остаётся запрещённым.

Отдельный интерфейс `/export-control` показывает только сохранённый компактный read model: создание или обновление WordPress, поля и taxonomy с изменениями, добавление и снятие меток, изображения, вариации, блокировки и последний export job. Открытие страницы не собирает payload заново и не обращается к WordPress. Каждый preflight job проверяет один товар, а несколько независимых preflight lanes могут выполнять такие read-only проверки параллельно; список использует keyset pagination и индексы вместо `OFFSET` и `COUNT(*)`. Изменение обработанного товара или target-конфигурации делает результат устаревшим.

Для массовой выгрузки не требуется сначала проверять весь каталог. Кампания держит небольшое окно проверок и по мере появления безопасных результатов пишет товары по одному. Позиция обхода хранится в PostgreSQL как монотонный курсор `internal_products.id`, поэтому пополнение окна не сортирует и не сканирует заново уже пройденную часть каталога, а перезапуск worker продолжает тот же проход. В production target временно должен иметь `maxVariantPriceRatio: 5`: если свежие доступные offers содержат цену выше минимальной более чем в пять раз, весь товар блокируется до ручного разбора. Это намеренно не удаляет подозрительный размер и защищает как preview, так и повторно собранные offers непосредственно перед write.

Ручной экспорт принимает только готовые результаты. При подтверждении payload hash и ожидаемая WordPress identity замораживаются вместе с batch items и export jobs в одной транзакции. Если в `/runtime` включена настройка актуализации перед экспортом, уже взятая worker-ом `export_product` задача один раз запрашивает source parts, заданные адаптером. Для GOAT это только `offers`: актуальные цена, наличие и размеры подставляются в вариации и сразу отправляются в WordPress без `collect_product`, `process_product`, повторного preflight и возврата товара в конец очереди. Статические поля по-прежнему обязаны совпадать с подтверждённым payload, а свежий WordPress lookup проверяет identity непосредственно перед записью. После любой попытки экспорта сохранённый preflight помечается устаревшим, чтобы прежний diff нельзя было повторно принять за актуальный.

Размер источника не перезаписывается при processing. Если точного `sizeMappings` для него нет, WordPress exporter перед export или read-only preview получает преобразование в US из брендовой таблицы сайта по уже разрешённым `pa_brand`, `product_cat` и `audience`, после чего применяет точный US mapping. Поддерживаются таблицы EU, UK, JP, RU и CM; подтверждённые обувные обозначения IT и FR используют колонку EU. Для нескольких категорий обуви target может явно задать `sizeConversionCategoryTermIds`; без этого используются категории из `titlePrefixByCategoryTermId`. Отсутствующая строка таблицы, неоднозначная колонка, конфликт преобразований или совпадение двух source-вариантов в один target-размер блокируют payload. Ближайший размер не подбирается.

Страница `/wordpress-catalog` хранит каждую загрузку каталога и её строки в PostgreSQL; перезапуск API или worker не теряет курсор и результаты. WordPress отдаёт текст, identity, term ID, вариации и метаданные изображений пакетами без скачивания бинарных фотографий. Сопоставление сначала требует непротиворечивой source identity, legacy `goat_id` используется как дополнительное доказательство, а SKU допускается только при полном отсутствии identity и только при единственном результате.

Опциональный режим цен и остатков перед каждой записью заново получает GOAT offers и отправляет отдельный `variation-patch.v1`. Он меняет только существующие вариации с точным `taxonomy + term_id`: новые размеры не создаются, неизвестные WordPress-размеры сохраняются, известный исчезнувший размер получает `outofstock`, а отсутствующий size mapping записывается как пропуск. Это временная политика до отдельного согласования расширения размерной сетки. Цена выше минимальной свежей доступной цены более чем в `maxVariantPriceRatio` раз пропускается только для подозрительной вариации и остаётся в WordPress без изменений; полный экспорт по-прежнему блокирует весь такой товар. Локальный аудит прочих полей строится из сохранённого снимка и payload exporter без WordPress preflight и не является разрешением на полный export.

Адаптер читает `brands`, `models`, `tags`, `sizes`, `shoe_heights`, `product_categories`, `colors`, `materials`, `seasons` и `activities`. Создание доступно только для брендов, моделей, тегов и категорий: у остальных справочников сайта есть дополнительные метаданные, поэтому создавать для них неполные термины общей кнопкой нельзя. Если у выбранного бренда или модели WordPress заполнен `tag_id`, классификатор автоматически синхронизирует эту посадочную `product_tag` как дополнительную проекцию внутреннего значения; это работает и для уже существующих сопоставлений. В предпросмотре товара такая метка помечается источником — брендом или моделью. При создании бренда или модели можно явно создать либо выбрать существующую посадочную метку. Снятая галочка передаётся явно и не запускает старое автоматическое создание модельной метки. При создании также можно передать slug, а для категории — родительский term ID. Повторная проверка имени и slug выполняется на стороне WordPress непосредственно перед `wp_insert_term`. Каждая попытка записывается в `target_term_creation_history` с оператором, результатом и ID созданного или найденного термина. Пароли и токены WordPress в таблицах не хранятся.

Условные target-назначения исполняются после полной классификации и могут проверять распознанные внутренние значения, source-кандидаты и факты DTO. Внутри одной группы побеждает совпавшее правило с наибольшим приоритетом; равный приоритет с пересекающейся выборкой блокируется preview и runtime. Действия `add` добавляют термин, `replace` сначала очищают соответствующую taxonomy и затем применяют все назначения. Сохранение правила не запускает массовый экспорт: фактическая запись остаётся под существующим пакетным preview/apply.

Типы в фильтре классификатора берутся из реально ожидающих решения наблюдений и их имён в PostgreSQL, а не из списка в браузерном коде. Возможность привязки к WordPress, соответствующая сущность и кратность объявляются самим target-адаптером. Карточка товара открывается по `/products/:productId`; старые товары покажут имеющиеся высокоуровневые jobs, а детальная история операций начнёт заполняться при следующей обработке.

Полный worker в процессе API не запускается: production использует только `slds-parser-worker.service`. Для управления службой из админки пользователь API должен получить polkit-разрешение только на start/stop этой службы; готовое правило находится в `deploy/polkit`. Страница `/runtime` хранит желаемую ревизию concurrency отдельно от последней применённой и не редактирует `.env`; применение к активному worker выполняется явной последовательностью stop/start. Точечная ручная обработка выполняется отдельным one-shot приложением и атомарно забирает конкретный job по ID. Для записи media из такого запуска API-службе требуется override из `deploy/systemd`.

Operational-данные ограничены политикой хранения. По умолчанию завершённые jobs хранятся 24 часа, failed jobs — 30 дней, история processing и неактивные наблюдения классификатора — 30 дней. Значения задаются через `PARSER_COMPLETED_JOB_RETENTION_HOURS`, `PARSER_FAILED_JOB_RETENTION_DAYS`, `PARSER_PROCESSING_HISTORY_RETENTION_DAYS`, `PARSER_INACTIVE_OBSERVATION_RETENTION_DAYS` и `PARSER_RETENTION_BATCH_SIZE`. Таймер `deploy/systemd/slds-parser-cleanup.timer` запускает очистку каждый час. Исходные части товаров, текущие товары, решения классификатора и audit history очистка не затрагивает.

Процесс корректно закрывает HTTP-сервер и PostgreSQL pool по `SIGINT` и `SIGTERM`. Для production API следует запускать как отдельную службу за reverse proxy, не открывая внутренний порт наружу.
