# SLDS Parser

ESM-проект на Node.js и TypeScript для конвейера сбора, обработки и экспорта данных о товарах.

## Реализовано

- универсальные DTO и контракты адаптера, процессора и экспортера;
- PostgreSQL-схема и последовательный migration runner с транзакциями и advisory lock;
- repository-контракты и `UnitOfWork` для будущих атомарных операций;
- `ReferenceMappingService` со строгим разрешением заранее подтверждённых mappings;
- типизированные прикладные ошибки, реестры компонентов и стабильное SHA-256-хэширование;
- unit-тесты на Vitest, не требующие запущенного PostgreSQL.

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

Конфигурация подключения читается при создании пула. Поэтому импорт модулей не требует `DATABASE_URL`, а попытка создать подключение без этой переменной завершится понятной ошибкой. Миграции применяются в порядке имён файлов, каждая в отдельной транзакции. PostgreSQL advisory lock исключает параллельный запуск двух migration runners.

## Контракты хранения

Определены небольшие интерфейсы `SourceRepository`, `SourceRunRepository`, `SourceProductRepository`, `InternalProductRepository`, `ReferenceRepository`, `TargetRepository`, `JobRepository` и `UnitOfWork`. Реализаций SQL у repositories пока нет. Следующий этап — реальные PostgreSQL repositories и PostgreSQL-реализация `UnitOfWork`.

Все PostgreSQL `BIGINT` представлены в TypeScript строками, чтобы не терять точность.

## Команды

- `npm run dev` — запуск точки входа через `tsx` в watch-режиме;
- `npm run db:migrate` — применить PostgreSQL-миграции;
- `npm run typecheck` — проверить типы;
- `npm test` — однократно запустить unit-тесты;
- `npm run test:watch` — запустить тесты в watch-режиме;
- `npm run build` — собрать проект в `dist`.
