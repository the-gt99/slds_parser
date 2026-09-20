# SLDS Parser: обязательные инструкции

Этот файл содержит только правила, которые должны применяться в каждой задаче. Исторические deployment-снимки, метрики cohort, номера старых jobs и подробный журнал решений перенесены в `docs/project-history-2026-08.md`. Архив использовать для расследования происхождения решений, но не считать его оперативным состоянием без сверки с кодом, `README.md`, `git status`, последними миграциями и read-only production.

## Рабочие правила

- Пиши коммиты на русском: кратко, без лишних символов и признаков ИИ. Не упоминай ИИ-агента в названиях файлов и коммитах.
- Сначала устанавливай причину проблемы. Не предлагай решения наобум и не добавляй fallback «на всякий случай».
- Исправляй основной путь так, чтобы логика оставалась единой, явной и проверяемой.
- Не соглашайся автоматически. Если предложенное решение создаёт архитектурный риск, прямо объясни его и предложи лучший вариант.
- Если данных недостаточно, исследуй код, PostgreSQL или read-only production. Не выдумывай поля DTO, endpoints, mappings, обязательность классификации или формулы старого parser.
- Перед изменениями проверяй `git status`. Существующие изменения принадлежат пользователю; не перезаписывай и не откатывай их.
- Для сложных межмодульных задач, если Graphify MCP доступен и его граф актуален, сначала запрашивай узкий подграф. Перед правкой подтверждай найденные связи по исходному коду. Для простых локальных изменений Graphify не нужен.

## Цель и архитектурная граница

Проект — универсальный конвейер товарных данных с первой рабочей вертикалью `GOAT → SLDS Parser → WordPress/WooCommerce slamdunk.shop`:

1. обнаружить и полностью собрать товары источника;
2. преобразовать parts в единый внутренний DTO и выполнить независимые операции;
3. классифицировать значения относительно внутренних и target-справочников;
4. идемпотентно создать или обновить товар на target.

Основной поток:

`SourceAdapter → сохранённые parts → SourceProcessor → UniversalProductDTO → ProductOperation[] → ProductClassifier → TargetExporter`

Переходы между крупными этапами выполняются через PostgreSQL jobs, а не прямыми вызовами.

- `SourceAdapter` знает только протокол источника, discovery и получение parts.
- `SourceProcessor` знает форму source payload и переводит сохранённые parts в универсальный DTO. Он не читает mappings и target.
- `ProductOperation` получает универсальный DTO и контекст. Универсальная операция не импортирует GOAT или WordPress.
- `ProductClassifier` работает с `referenceCandidates`, mappings и rules. Он не знает поля GOAT и таксономии WordPress.
- `TargetDictionaryProvider` описывает справочники и возможности target.
- `TargetExporter` отвечает за target payload, readiness, внешний вызов и идемпотентность.

Новый source должен требовать адаптер, processor, регистрацию и при необходимости source-specific rules, но не изменение классификатора. Новый target подключается provider/exporter-адаптерами. Не переносить target-логику в processing, не возвращать mappings в `SourceProcessor` и не добавлять source-specific поля в ядро ради одного сайта.

## Технологический и runtime-контекст

- Node.js 22, TypeScript, ESM, PostgreSQL.
- Основные jobs: `discover_source`, `collect_product`, `process_product`, `reclassify_product`, `retranslate_product`, `export_product` и специализированные административные jobs.
- Компоненты регистрируются явно в `src/bootstrap.ts`; наличие файла ничего не включает.
- Retry применяется только к явно повторяемым ошибкам. Транзакции должны быть короткими, locks — восстанавливаемыми.
- Версии и fingerprints компонентов обязаны отражать изменения поведения.
- `SourceProcessor.version` инвалидирует полный processing, а `classificationVersion` — только смысл и набор classification candidates.
- Изменения mappings/rules должны использовать `reclassify_product`, а не повторять SourceProcessor, перевод и media operations.
- Смена или массовое повторение перевода должна идти через `retranslate_product`; автоматического fallback между translation providers нет.

## GOAT и обработка

- Discovery выполняется через sitemap для sneakers и apparel. DOM страниц не является основным источником.
- Товар собирается parts `product` и `offers`; raw payload и проверенное parsed-представление сохраняются.
- Product и offers одного collect attempt используют один proxy/client/cookie jar.
- Транспорт использует `curl-impersonate` и управляемый PostgreSQL proxy pool с зашифрованными credentials.
- При `GOAT_PROXY_POOL_ENABLED=true` runtime использует repository/pool. Старые env proxy допустимы только для явного rollback.
- Cents преобразуются в decimal-строки без float. Размеры остаются строками. Нельзя выдумывать цену, остаток, размер или изображение.
- Пустые offers и media допустимы во внутреннем DTO: `variants: []` и `images: []` являются честными данными.
- GOAT `story` и `description` — разные поля. `SourceProcessor` не подменяет одно другим. Для нового WordPress-описания exporter выбирает `translated story → translated description`; при update любое непустое существующее WordPress-описание сохраняется целиком.
- Исходный размер сохраняется в DTO. Конвертация для WordPress выполняется только exporter-ом по реальной брендовой таблице и всё равно требует точного `sizeMappings`.
- Не возвращать эвристику «размер больше 22 значит EU», не выбирать ближайший размер и не перезаписывать исходные варианты при processing.
- Точечные production processing-команды запускать от пользователя `slds-parser`, не от `root`, иначе владельцем media станет `root` и Nginx может вернуть `403`.

Операции processing сейчас образуют последовательность: нормализация, перевод, скачивание изображений, проверка/конвертация WebP, публикация URL и финальная проверка DTO. HTML-описания WordPress не являются универсальной операцией: они формируются в target payload после классификации и size conversion.

## Классификатор

Классификатор поддерживает exact mappings с контекстом, внутренние значения, target mappings, rules `equals`/`contains`/`all_words`/`regex`, preview конфликтов, состояния `unresolved`/`ambiguous`/`resolved`/`ignored`, аудит и точечную повторную классификацию.

Обязательные правила:

- Не склеивать одинаковое raw value без контекста товара. `Pegasus` и `Surge` требуют brand/family/title evidence.
- Кандидат модели — title без подтверждённого конечного colorway, с brand и family в context. Не использовать голый `silhouette` и не включать расцветку в идентичность модели.
- `categoryRaw` нельзя автоматически дублировать в `activity` или `tag`. `Lifestyle` и `Sandal` не доказывают вид спорта.
- В очередь попадают только реальные target-кандидаты: brand, model, category, color, material, technologies/tags и activity только из явного source-поля назначения.
- Размер, цена, наличие, состояние, audience, family, release date и GOAT year-like `season` являются DTO facts/evidence, а не ручными classification candidates.
- `shoe_height` и настоящий сезон добавлять только при воспроизводимом извлечении из source data.
- Правила принадлежат конкретному source. Объединение источников происходит через общее внутреннее значение, не через глобальное source-less rule.
- Internal `resolved` недостаточно для любого target: readiness проверяет `target_value_mappings`, `requiredReferenceTypes` и точные `sizeMappings`.
- Дополнительные WordPress terms назначаются projections или target assignment rules. Не дублировать candidates в `SourceProcessor` ради target enrichment.

## WordPress/WooCommerce target

Подтверждённые соответствия:

| Универсальный смысл | WordPress |
|---|---|
| Бренд | `pa_brand` |
| Модель | `pa_model` |
| Категория | `product_cat` |
| Метка | `product_tag` |
| Цвет | `pa_tsvet` |
| Материал | `pa_material` |
| Вид спорта | `pa_vid` |
| Высота обуви | `pa_shoe_height` |
| Сезон | `pa_season` |
| Размер | преимущественно `pa_razmer`, также встречается `pa_size` |

- Дата релиза не является сезоном; она используется в описании и `filter_data_v2`.
- Terms в `product-upsert.v1` передаются только числовыми ID и не создаются внутри upsert.
- Primary identity: `_slds_source_code`, `_slds_source_external_id`, `_slds_external_key`; `goat_id` читается только для legacy compatibility.
- Новый товар создаётся variable draft, получает identity, синхронизируется и только затем публикуется.
- Availability без точного quantity меняет stock status без выдуманного остатка.
- Несколько `pa_brand` и `pa_model` поддерживаются, но дополнительные значения требуют точных воспроизводимых условий и полного taxonomy diff.
- Основной source-brand единолично определяет size conversion; дополнительный бренд не должен менять размерную сетку.
- `product_tag` включает не только GOAT technologies/source tags: связанные брендовые, модельные и категорийные tags задаются target projections.
- Legacy WordPress variation attributes могут находиться только в `attribute_pa_*` post meta; не удалять compatibility path при пустом `WC_Product_Variation::get_attributes()`.
- Title prefix `Кроссовки` — target-правило по WordPress category IDs, не универсальная операция.
- Content templates являются частью target payload. Изменение active revision не требует полного processing или повторного скачивания media.
- WordPress preview обязан использовать общий `buildWordPressUpsertPayload` и реальный read-only preflight. Перед write проверять полный diff: identity, title, slug, SKU, descriptions, taxonomies, variations и images.

## Текущее безопасное состояние и открытые решения

Снимок ниже служит ориентиром; перед operational task всегда проверять production заново.

- Target `slamdunk` намеренно выключен. Не включать его и не запускать массовый export без отдельного подтверждения.
- `product-upsert.v1` и реальный идемпотентный update существующего WooCommerce-товара подтверждены; это не разрешение на массовый write.
- Sold-out write не согласован: внутренний DTO поддерживает `variants: []`, но обычный WordPress exporter блокирует пустой variation set. Не деактивировать старые вариации и не создавать товар без offers до явного бизнес-правила.
- Товар без реальных изображений хранится с `images: []`, но exporter блокирует write до согласования target-политики.
- Автоматическое обогащение отсутствующего `pa_material` требует бизнес-подтверждения.
- Для коллабораций дополнительные brands/models назначать только по точным проверенным source/model conditions. Не сохранять широкое правило по одному слову или family.
- `ignoreUnmappedSizeVariants` может явно исключить отдельные варианты без точного mapping и обязан показать их в preview. Если mapped variants не осталось, export блокируется. Не подбирать ближайший термин.
- Price anomaly rule не согласован. Не вводить абсолютный cap или произвольное отсечение без формулы и проверки репрезентативной выборки.
- `refreshSourceBeforeExport` обновляет только offers внутри уже взятой export job. Он не запускает полный processing, media или classification.
- Существующие точные WordPress model terms при update защищаются только когда подтверждаются source-моделью; явный assignment `replace` имеет приоритет.
- Новый полный WordPress catalog run не запускать до оптимизации первого `savePage`: предыдущая попытка более шести минут читала диск и не сохранила строки.

## Production и безопасность

- Новый parser: MCP `ssh_slamdunk_parser`, `/srv/slds-parser/app`.
- WordPress production: MCP `ssh_slamdunk_prod`, `/var/www/u0347517/data/www/slamdunk.shop`.
- Старый parser: MCP `ssh_parser`, использовать только как read-only источник поведения и данных.
- Локальный WordPress source: `C:\Users\gt99\Downloads\slds\Git\slamdunk`.

Перед любым production-действием:

1. проверить нужный branch, commit и `git status`;
2. проверить актуальные jobs, services, target state, migrations и свободный диск;
3. сначала исследовать WordPress read-only;
4. ограничить smoke явным малым набором;
5. проверить diff и отсутствие неожиданных export jobs;
6. после действия проверить health, jobs и журналы.

Не запускать несколько полных worker-процессов. Worker использует отдельные lane-группы; актуальные concurrency и proxy limits читать из production runtime, а не из исторического документа. Collection lane сначала резервирует healthy proxy и только потом забирает job.

Не выводить `.env`, proxy credentials, cookies, bearer tokens, WordPress import token и ciphertext в команды, логи или ответы. На production с грязным worktree не использовать destructive Git-команды. Перед pull убедиться, что входящий diff не пересекается с локальными изменениями.

## Проверки

Минимум перед коммитом:

```text
npm run typecheck
npm test
npm run build
git diff --check
```

Для изменённых browser JavaScript-файлов дополнительно выполнять `node --check <файл>`. При изменениях схемы применять миграции на локальной PostgreSQL и проверять реальный repository/service query. При изменениях WordPress выполнять `php -l` для каждого изменённого PHP-файла и соответствующие contract tests.

Перед deployment выполнить `npm ci`, typecheck, tests, build, migrations, restart нужных services, внутренний и внешний health check, ограниченный functional smoke и проверку jobs/journals.

## Критерий решения

Не заявлять, что блок готов, если отсутствует реальный adapter/exporter или сквозной тест. Между красивой абстракцией и простым расширяемым контрактом выбирать явный контракт. Добавление source, operation или target должно быть локальным изменением, но не ценой скрытой автозагрузки, неявных fallback и потери проверяемости.
