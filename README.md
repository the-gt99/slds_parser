# SLDS Parser

ESM-проект на Node.js и TypeScript для конвейера сбора, обработки и экспорта данных о товарах.

## Реализовано

- универсальные DTO и контракты адаптера, процессора и экспортера;
- PostgreSQL-схема и последовательный migration runner с транзакциями и advisory lock;
- PostgreSQL repositories и `PostgresUnitOfWork` для атомарных операций;
- `ReferenceMappingService` со строгим разрешением заранее подтверждённых mappings;
- типизированные прикладные ошибки, реестры компонентов и стабильное SHA-256-хэширование;
- unit-тесты на Vitest, не требующие запущенного PostgreSQL.

## Конвейер

Ядро состоит из трёх независимых циклов:

1. `CollectionRunner` обнаруживает товары постранично и собирает их произвольные части.
2. `ProcessingRunner` преобразует сохранённые части в стабильный `UniversalProductDTO`.
3. `ExportRunner` синхронизирует внутренний товар с каждой включённой целью.

Между этапами нет прямых вызовов: переходы выполняются через PostgreSQL jobs. Поддерживаются четыре типа задач:

- `discover_source` — discovery включённого источника с checkpoint;
- `collect_product` — сбор всех или явно запрошенных частей товара;
- `process_product` — построение внутреннего товара;
- `export_product` — экспорт внутреннего товара в одну цель.

Один `Worker` последовательно обрабатывает все типы. Масштабирование достигается запуском нескольких процессов: `JobRepository.claimNext` использует `FOR UPDATE SKIP LOCKED`. Просроченные `running` locks снова доступны после `WORKER_LOCK_TIMEOUT_MS`; число попыток увеличивается атомарно при claim.

Повторяются только `RetryableError`, пока число попыток меньше `MAX_JOB_ATTEMPTS`. Задержка растёт экспоненциально от `JOB_RETRY_BASE_MS` и ограничивается `JOB_RETRY_MAX_MS`. `PermanentError` и неизвестные программные ошибки сразу завершают задачу как `failed`. Terminal failure discovery дополнительно помечает активный `source_collection_run` как `failed`.

## Транзакционные границы

Вызовы `SourceAdapter`, `SourceProcessor` и `TargetExporter` выполняются вне транзакций. В одной короткой `UnitOfWork`-транзакции атомарно сохраняются:

- discovery-страница, её checkpoint и задачи `collect_product`;
- собранные parts и задача `process_product`;
- внутренний товар и все задачи `export_product`.

Внешний экспорт нельзя атомарно объединить с PostgreSQL. Поэтому `TargetExporter` обязан быть идемпотентным: внешний запрос мог завершиться успешно до сбоя сохранения результата. Export fingerprint учитывает content hash товара, версию exporter, конфигурацию target и revision mappings.

## Расширение

Новый источник подключается реализациями `SourceAdapter` и `SourceProcessor`, после чего обе явно регистрируются в `registerPipelineComponents` в `src/bootstrap.ts`. Новый target подключается реализацией `TargetExporter` и регистрацией там же. Реестры пока намеренно пусты: GOAT и WordPress не реализованы.

## PostgreSQL-схема

Первая миграция создаёт 12 предметных таблиц:

- `sources` — источники и конфигурация адаптеров;
- `source_collection_runs` — запуски discovery каталога, их checkpoint, полнота и статистика. Таблица не отражает завершение всех `collect_product`;
- `source_products` — обнаруженные во внешних источниках товары и их идентичность;
- `source_product_parts` — только актуальное состояние собранных частей товара;
- `reference_types` — типы справочников;
- `reference_values` — внутренние нормализованные значения справочников;
- `source_value_mappings` — подтверждённые, предложенные и отклонённые соответствия значений источников;
- `internal_products` — универсальные обработанные товары и контрольные хэши;
- `targets` — цели экспорта и конфигурация exporters;
- `target_value_mappings` — представление справочных значений в конкретной цели;
- `target_products` — состояние синхронизации внутреннего товара с целью;
- `jobs` — очередь discovery, collection, processing и export задач.

Служебная таблица `schema_migrations` хранит имена уже применённых SQL-файлов. Отдельная seed-миграция идемпотентно добавляет начальные типы справочников.

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
- `npm run worker` — запустить единый worker; `SIGINT` и `SIGTERM` корректно останавливают цикл и закрывают Pool;
- `npm run typecheck` — проверить типы;
- `npm test` — однократно запустить unit-тесты;
- `npm run test:watch` — запустить тесты в watch-режиме;
- `npm run build` — собрать проект в `dist`.
