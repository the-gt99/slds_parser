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
- unit-тесты на Vitest, не требующие запущенного PostgreSQL или сети.

## Конвейер

Ядро состоит из трёх независимых циклов:

1. `CollectionRunner` обнаруживает товары постранично и собирает их произвольные части.
2. `ProcessingRunner` преобразует сохранённые части в базовый `UniversalProductDTO`, применяет зарегистрированные операции и отдельно запускает универсальный классификатор.
3. `ExportRunner` синхронизирует внутренний товар с каждой включённой целью.

Между этапами нет прямых вызовов: переходы выполняются через PostgreSQL jobs. Поддерживаются четыре типа задач:

- `discover_source` — discovery включённого источника с checkpoint;
- `collect_product` — сбор всех или явно запрошенных частей товара;
- `process_product` — построение внутреннего товара;
- `export_product` — экспорт внутреннего товара в одну цель.

Один `Worker` последовательно обрабатывает все типы. Масштабирование достигается запуском нескольких процессов: `JobRepository.claimNext` использует `FOR UPDATE SKIP LOCKED`. Просроченные `running` locks снова доступны после `WORKER_LOCK_TIMEOUT_MS`; число попыток увеличивается атомарно при claim.

Повторяются только `RetryableError`, пока число попыток меньше `MAX_JOB_ATTEMPTS`. Задержка растёт экспоненциально от `JOB_RETRY_BASE_MS` и ограничивается `JOB_RETRY_MAX_MS`. `PermanentError` и неизвестные программные ошибки сразу завершают задачу как `failed`. Terminal failure discovery дополнительно помечает активный `source_collection_run` как `failed`.

## Транзакционные границы

Вызовы `SourceAdapter`, `SourceProcessor`, `ProductOperation` и `TargetExporter` выполняются вне транзакций. В одной короткой `UnitOfWork`-транзакции атомарно сохраняются:

- discovery-страница, её checkpoint и задачи `collect_product`;
- собранные parts и задача `process_product`;
- внутренний товар, наблюдения классификатора и все допустимые задачи `export_product`.

Внешний экспорт нельзя атомарно объединить с PostgreSQL. Поэтому `TargetExporter` обязан быть идемпотентным: внешний запрос мог завершиться успешно до сбоя сохранения результата. Export fingerprint учитывает content hash товара, версию exporter, конфигурацию target и revision mappings.

## GOAT

GOAT discovery читает `https://www.goat.com/sitemap`, отбирает только дочерние sitemap для sneakers и apparel и сохраняет slug, URL, маршрут, `lastmod`, заголовок и изображения. HTML карточек не разбирается. Сбор товара сохраняет две части:

- `product` — полный JSON карточки и проверенное представление полей товара;
- `offers` — полный JSON buy bar и проверенный массив предложений с рынком.

Процессор сохраняет размеры строками, состояния товара и коробки, наличие, основную, Instant Ship и last sold цены. Отсутствующая сумма остаётся `null`, cents преобразуются в decimal-строку без float. Из GOAT-полей он также строит универсальные reference-кандидаты. GOAT `silhouette` становится `product_family`, но не выдаётся за точную модель; кандидат модели использует полное название и контекст бренда/семейства.

После процессора применяются операции обработки. Нормализация очищает только известные поля DTO и старые spreadsheet-маркеры ошибок, удаляет дубли URL и GOAT-заглушки изображений. Исходный текст сохраняется, перевод записывается отдельно в `translatedContent`. Изображения скачиваются через GOAT-транспорт, проверяются декодированием, сохраняются локально, конвертируются в WebP с качеством 85 и получают публичные URL. Частичная потеря изображений допустима, но товар без единого рабочего изображения завершается ошибкой. Финальная проверка требует только подтверждённые старым конвейером поля: название, SKU, исходный бренд, изображения и варианты.

Операция формирования HTML-описания намеренно отсутствует: в старом проекте текст с упоминанием магазина создавался при сборке WordPress payload после классификации. Эта логика должна появиться вместе с конкретным exporter, а не в универсальной обработке.

Транспорт требует curl-impersonate и не подменяет его системным curl. На Linux укажите путь к `curl_chrome116`. На Windows можно указать исполняемый файл или `.ps1` wrapper, который запускает curl-impersonate. Старый `.cmd` поддерживается через соседний `goat-curl.ps1`, чтобы URL с несколькими query-параметрами не разбирался командной оболочкой. Пример настройки:

```dotenv
GOAT_CLI_CURL_BIN=C:\path\to\goat-curl.cmd
GOAT_COOKIE_JAR_PATH=/mnt/c/path/to/goat-cookie-jar.txt
GOAT_PROXY_HTTP=
GOAT_PROXY_SOCKS5=
GOAT_CF_CLEARANCE=
GOAT_HTTP_TIMEOUT_MS=25000
GOAT_MAX_RESPONSE_BYTES=10485760
GOAT_SESSION_TTL_MS=600000
GOAT_SMOKE_PRODUCT_LIMIT=1
GOAT_IMAGE_DOWNLOAD_CONCURRENCY=2
PARSER_IMAGE_BASE_DIR=/srv/slds-parser/state/images
PARSER_PUBLIC_BASE_URL=https://static.example.com
PARSER_PUBLIC_PATH_PREFIX=products
PARSER_TRANSLATION_SOURCE=en
PARSER_TRANSLATION_TARGET=ru
PARSER_TRANSLATION_TIMEOUT_MS=8000
PARSER_TRANSLATION_ATTEMPTS=2
PARSER_TRANSLATION_RETRY_DELAY_MS=400
```

HTTP и SOCKS5 proxy взаимоисключающие. Реальные proxy credentials и cookies должны находиться только в gitignored `.env`. Клиент делает session warm-up, один раз обновляет сессию после 403, соблюдает timeout и лимит ответа. Transport errors, повторный 403, 408, 425, 429 и 5xx повторяются Worker; 404 карточки и остальные 4xx завершаются постоянно. HTML challenge считается временной ошибкой, неверная JSON/XML-структура — ошибкой интеграционного контракта.

Путь `GOAT_COOKIE_JAR_PATH` должен быть понятен самому curl-процессу: для Windows wrapper, запускающего бинарник через WSL, используйте путь `/mnt/c/...`; для нативного Windows-бинарника — обычный Windows path.

Для безопасной живой проверки задайте `GOAT_SMOKE_PRODUCT_LIMIT` от 1 до 100, затем выполните:

```text
npm run db:migrate
npm run goat:enqueue-smoke
npm run worker
```

CLI создаёт или обновляет source `goat`, записывает лимит в его config и ставит одну discovery-задачу. Не запускайте smoke-команду без лимита; обычный адаптер без `maxProductsPerRun` рассчитан на полный каталог.

`PARSER_IMAGE_BASE_DIR` должен быть доступен HTTP-серверу по адресу, образованному из `PARSER_PUBLIC_BASE_URL`, `PARSER_PUBLIC_PATH_PREFIX` и относительного пути файла. Без реального публичного URL worker не запускается: выдуманный адрес сделал бы сохранённые ссылки нерабочими. Переводчик перенесён из старого проекта через отдельный provider и использует его неофициальный Google Translate endpoint; поэтому его можно заменить, не меняя операцию и DTO.

Способ передачи изображений в WordPress нужно подтвердить при реализации exporter. Пока `publish-images` оставляет публичные URL, чтобы WordPress мог импортировать готовые WebP самостоятельно. Если target API будет принимать файлы напрямую, операцию и `PARSER_PUBLIC_BASE_URL` нужно удалить, а exporter должен использовать `webpLocalPath`.

Пока не реализованы интерфейс управления mappings, синхронизация справочников WordPress, ETag/304, подтверждение удаления исчезнувших товаров и отдельное частое расписание обновления offers. WordPress и exporters отсутствуют. Неизвестные reference-кандидаты сохраняются как штатный `classification_pending`, а не ошибка worker; export job создаётся только после полной классификации. Target-specific readiness для обязательных и необязательных типов появится вместе с exporter.

## Расширение

Новый источник подключается реализациями `SourceAdapter` и `SourceProcessor`, после чего обе явно регистрируются в `registerPipelineComponents` в `src/bootstrap.ts`. Новый target подключается реализацией `TargetExporter` и регистрацией там же.

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

Служебная таблица `schema_migrations` хранит имена уже применённых SQL-файлов. Отдельная seed-миграция идемпотентно добавляет начальные типы справочников.

Миграция универсального классификатора добавляет:

- `source_reference_mappings` — точные подтверждённые либо игнорируемые решения с контекстом, revision и аудитом;
- `source_reference_rules` — общие или source-specific контекстные правила;
- `source_reference_observations` — актуальные кандидаты каждого товара, их состояние и использованное решение;
- `source_reference_decision_history` — история будущих действий интерфейса над mappings и правилами.

У `reference_types` задаются разрешённые субъекты (`product`/`variant`) и кратность (`single`/`multiple`). Поэтому, например, бренд остаётся одиночным значением товара, теги могут быть множественными, а размер относится к конкретному варианту.

## Миграции

1. Скопируйте `.env.example` в `.env` и укажите строку подключения либо задайте `DATABASE_URL` в окружении.
2. Запустите `npm run db:migrate`.

Для worker также задайте `WORKER_ID`, `WORKER_POLL_INTERVAL_MS`, `WORKER_LOCK_TIMEOUT_MS`, `MAX_JOB_ATTEMPTS`, `JOB_RETRY_BASE_MS` и `JOB_RETRY_MAX_MS`. Все числовые значения должны быть положительными целыми, а базовая retry-задержка — не больше максимальной.

Конфигурация подключения читается при создании пула. Поэтому импорт модулей не требует `DATABASE_URL`, а попытка создать подключение без этой переменной завершится понятной ошибкой. Миграции применяются в порядке имён файлов, каждая в отдельной транзакции. PostgreSQL advisory lock исключает параллельный запуск двух migration runners.

## Контракты хранения

Интерфейсы `SourceRepository`, `SourceRunRepository`, `SourceProductRepository`, `InternalProductRepository`, `ReferenceRepository`, `TargetRepository` и `JobRepository` реализованы для PostgreSQL. Фабрика `createPostgresRepositories` создаёт их для пула или отдельного клиента.

Атомарные изменения нескольких таблиц выполняются через `PostgresUnitOfWork`. Внешние HTTP-вызовы и другую долгую работу необходимо завершать до открытия транзакции. Конкурентные гарантии `JobRepository` заложены в SQL, но ещё должны быть проверены интеграционным тестом с настоящим PostgreSQL; unit-тесты используют только fake executor и не доказывают поведение реальной СУБД при конкуренции.

Все PostgreSQL `BIGINT` представлены в TypeScript строками, чтобы не терять точность.

## Команды

- `npm run dev` — запуск точки входа через `tsx` в watch-режиме;
- `npm run db:migrate` — применить PostgreSQL-миграции;
- `npm run goat:enqueue-smoke` — создать ограниченный GOAT source и поставить discovery-задачу;
- `npm run worker` — запустить единый worker; `SIGINT` и `SIGTERM` корректно останавливают цикл и закрывают Pool;
- `npm run typecheck` — проверить типы;
- `npm test` — однократно запустить unit-тесты;
- `npm run test:watch` — запустить тесты в watch-режиме;
- `npm run build` — собрать проект в `dist`.
