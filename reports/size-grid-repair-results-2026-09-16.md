# Результаты исправления размерных блокировок

Дата: 16 сентября 2026 года. Итоговая очередь завершена. Основа подсчёта: 1269 товаров из исходного списка размерных блокировок target slamdunk. Вне этой группы дополнительно перепроверены товары Loewe/The Row; они не прибавлены к итоговым числам.

- У 360 товаров снята зарегистрированная размерная блокировка.
- 242 товара имеют статус ready после реального preflight WordPress.
- 118 товаров теперь заблокированы другой причиной: 117 без обязательной модели, 1 из-за существующей карточки простого, а не вариативного товара.
- 909 товаров всё ещё имеют размерную блокировку. Исправление всего блока не завершено.
- Новые задания export_product не создавались, товары на сайт не выгружались.

Снятие блокировки не означает, что все исходные варианты попали в payload: действующая политика допускает исключение отдельных размеров без точного соответствия, с указанием в preview. Публикация требует проверки полного diff.

## Изменённые и перепроверенные бренды

| Бренд | Исходных товаров | Размерная блокировка снята | Готовы | Другие блокировки | Остались размерные |
|---|---:|---:|---:|---:|---:|
| Birkenstock | 193 | 188 | 151 | 37 | 5 |
| Prada | 76 | 73 | 72 | 1 | 3 |
| Acne Studios | 23 | 22 | 15 | 7 | 1 |
| ASICS | 4 | 2 | 2 | 0 | 2 |
| Yeezy | 32 | 20 | 2 | 18 | 12 |
| Loewe | 20 | 20 | 0 | 20 | 0 |
| The Row | 34 | 34 | 0 | 34 | 0 |

## Что исправлено

- Acne Studios: существующая женская обувная таблица была ошибочно привязана к мужской категории. Исправлена привязка; конфликты мужских EU 40/41 исчезли.
- Prada: в женскую таблицу добавлены 16 проверенных UK-соответствий. Строка без подтверждённого соответствия оставлена пустой. [Источник](https://www.nordstrom.com/sizeguides/1481_sizeguide.pdf).
- ASICS: в мужскую таблицу добавлены 21 UK-соответствие. Неподтверждённая строка оставлена пустой. [Источник](https://www.asics.com/nz/en-nz/size-guide).
- Birkenstock: добавлен 21 точный составной US-размер для взрослых, например US 7–7,5M, и его mapping. Диапазон остаётся одним размером; исходное предложение не раздваивается и не округляется. [Источник](https://www.birkenstock.com/us/product-info-overlay-sizeName.html).
- Loewe: добавлены мужская и женская таблицы, 14 строк. [Источник](https://www.loewe.com/on/demandware.static/-/Library-Sites-LOW_SharedLibrary/default/dw5ed8398a/Size%20Guide/Size%20Guides%20Doc.pdf).
- The Row: добавлены мужская и женская таблицы, 32 строки. [Мужская](https://www.therow.com/products/suede-sneaker-black), [женская](https://www.therow.com/ja-jp/products/city-flip-flop-black).
- Парсер: кеш размерных таблиц теперь действует только внутри сборки одного payload. Каждая следующая сборка получает актуальные данные WordPress. Версия exporter 1.25.0.

## Yeezy и скриншот

На скриншоте обувная таблица действительно привязана к аксессуарам — такая привязка мешает найти её для обуви. Однако на момент прямой проверки сохранённые таблицы Yeezy 25586 уже были привязаны к Мужской обуви 25680, Женской обуви 25859 и Детской обуви 25868. API успешно возвращал их. В этой серии изменений данные Yeezy не менялись; выполнен новый preflight. Все 32 прежние ошибки отсутствующей таблицы исчезли. Причину расхождения скриншота и сохранённого состояния установить по этим данным нельзя.

## Оставшиеся причины

| Причина | Товаров |
|---|---:|
| Нет подходящей таблицы для бренда и категории | 413 |
| Нет ни одного варианта с точным mapping | 316 |
| Разные исходные размеры сведены к одному размеру WordPress | 77 |
| Нет преобразования EU → US | 55 |
| Нельзя однозначно выбрать категорию таблицы | 34 |
| В существующем товаре WordPress дубли вариаций одного размера | 14 |

EU → US: Dries Van Noten — 35, Veja — 15, Gucci — 5. Это не обязательно отсутствие всей таблицы. У Veja опубликованы таблицы по моделям; у Gucci требуется подтвердить смысл детской колонки «Размер». У Off-White действующие таблицы сводят несколько EU-размеров к одному US. Объединять эти варианты и выбирать ближайшие размеры нельзя.

В группе из 316 товаров есть детские размеры K/Y, одежда с числовыми размерами и отдельные отсутствующие строки брендовых таблиц. Добавление общей обувной таблицы не исправляет все эти случаи. В старом общем справочнике Lemaire и текущих карточках встречаются разные женские соответствия; универсальная таблица из противоречащих данных не добавлена.

## Полный список оставшихся размерных блокировок

| Бренд | Товаров | Причина |
|---|---:|---|
| Louis Vuitton | 121 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Off-White | 77 | More than one product variant resolves to the same WordPress size |
| adidas | 51 | WordPress export has no variants with mapped sizes |
| Nike | 48 | WordPress export has no variants with mapped sizes |
| Moon Boot | 46 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Rick Owens | 39 | WordPress export has no variants with mapped sizes |
| Dries Van Noten | 35 | WordPress size converter request failed: В размерной сетке нет однозначного преобразования EU → US |
| Lemaire | 25 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Valentino Garavani | 24 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Miu Miu | 23 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Alexander McQueen | 17 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Balenciaga | 16 | WordPress export has no variants with mapped sizes |
| Veja | 15 | WordPress size converter request failed: В размерной сетке нет однозначного преобразования EU → US |
| Air Jordan | 14 | WordPress export has no variants with mapped sizes |
| Alexander Wang | 14 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Ann Demeulemeester | 12 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Yeezy | 12 | WordPress export has no variants with mapped sizes |
| Alaïa | 11 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Alexander McQueen | 10 | WordPress export has no variants with mapped sizes |
| Chanel | 10 | WordPress export has no variants with mapped sizes |
| New Balance | 10 | WordPress export has no variants with mapped sizes |
| Puma | 10 | WordPress export has no variants with mapped sizes |
| Martine Rose | 9 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| ROA | 9 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Gucci | 7 | WordPress export has no variants with mapped sizes |
| Off-White | 7 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Vans | 7 | WordPress export has no variants with mapped sizes |
| Ferragamo | 6 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Gucci | 6 | WordPress size conversion requires exactly one configured product_cat term |
| Our Legacy | 6 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| PURPLE BRAND | 6 | WordPress export has no variants with mapped sizes |
| Raf Simons | 6 | WordPress export has no variants with mapped sizes |
| Birkenstock | 5 | WordPress export has no variants with mapped sizes |
| Casablanca | 5 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Golden Goose | 5 | WordPress export has no variants with mapped sizes |
| Gucci | 5 | WordPress size converter request failed: В размерной сетке нет однозначного преобразования EU → US |
| Isabel Marant | 5 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| PDF | 5 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Cecilie Bahnsen | 4 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Christopher Esber | 4 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Courrèges | 4 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Dior | 4 | WordPress export has no variants with mapped sizes |
| Enfants Riches Déprimés | 4 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Fear of God | 4 | WordPress size conversion requires exactly one configured product_cat term |
| Jacquemus | 4 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Kenzo | 4 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Kiko Kostadinov | 4 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Maison Mihara Yasuhiro | 4 | WordPress export has no variants with mapped sizes |
| Nike | 4 | WordPress exporter request failed: Target product contains duplicate variations for one size. |
| Off-White | 4 | WordPress export has no variants with mapped sizes |
| Supreme | 4 | WordPress export has no variants with mapped sizes |
| Amiri | 3 | WordPress export has no variants with mapped sizes |
| Auralee | 3 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Converse | 3 | WordPress export has no variants with mapped sizes |
| Coperni | 3 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Lanvin | 3 | WordPress export has no variants with mapped sizes |
| Magliano | 3 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| New Balance | 3 | WordPress exporter request failed: Target product contains duplicate variations for one size. |
| Paloma Wool | 3 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Prada | 3 | WordPress export has no variants with mapped sizes |
| BAPE | 2 | WordPress export has no variants with mapped sizes |
| Calvin Klein | 2 | WordPress export has no variants with mapped sizes |
| Converse | 2 | WordPress exporter request failed: Target product contains duplicate variations for one size. |
| Dolce & Gabbana | 2 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Givenchy | 2 | WordPress size conversion requires exactly one configured product_cat term |
| Heron Preston | 2 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Jil Sander | 2 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Khaite | 2 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Magda Butrym | 2 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Marni | 2 | WordPress export has no variants with mapped sizes |
| MM6 Maison Margiela | 2 | WordPress export has no variants with mapped sizes |
| Moncler | 2 | WordPress size conversion requires exactly one configured product_cat term |
| Moschino | 2 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Rick Owens | 2 | WordPress size conversion requires exactly one configured product_cat term |
| Saucony | 2 | WordPress export has no variants with mapped sizes |
| Timberland | 2 | WordPress export has no variants with mapped sizes |
| Under Armour | 2 | WordPress export has no variants with mapped sizes |
| Vetements | 2 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Acne Studios | 1 | WordPress size conversion requires exactly one configured product_cat term |
| adidas | 1 | WordPress exporter request failed: Target product contains duplicate variations for one size. |
| Air Jordan | 1 | WordPress exporter request failed: Target product contains duplicate variations for one size. |
| Alexander McQueen | 1 | WordPress size conversion requires exactly one configured product_cat term |
| Ambush | 1 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Amiri | 1 | WordPress size conversion requires exactly one configured product_cat term |
| Aries | 1 | WordPress export has no variants with mapped sizes |
| ASICS | 1 | WordPress exporter request failed: Target product contains duplicate variations for one size. |
| ASICS | 1 | WordPress export has no variants with mapped sizes |
| Balenciaga | 1 | WordPress size conversion requires exactly one configured product_cat term |
| Balmain | 1 | WordPress size conversion requires exactly one configured product_cat term |
| C.P. Company | 1 | WordPress size conversion requires exactly one configured product_cat term |
| Christian Louboutin | 1 | WordPress export has no variants with mapped sizes |
| Chrome Hearts | 1 | WordPress export has no variants with mapped sizes |
| Comme des Garçons | 1 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Common Projects | 1 | WordPress export has no variants with mapped sizes |
| Denim Tears | 1 | WordPress export has no variants with mapped sizes |
| Diesel | 1 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Dior | 1 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Fear of God Essentials | 1 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Fila | 1 | WordPress export has no variants with mapped sizes |
| Givenchy | 1 | WordPress export has no variants with mapped sizes |
| Heliot Emil | 1 | WordPress size conversion requires exactly one configured product_cat term |
| Jacquemus | 1 | WordPress size conversion requires exactly one configured product_cat term |
| JW Anderson | 1 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Kapital | 1 | WordPress size conversion requires exactly one configured product_cat term |
| Ksubi | 1 | WordPress export has no variants with mapped sizes |
| Levi's | 1 | WordPress export has no variants with mapped sizes |
| Louis Vuitton | 1 | WordPress size conversion requires exactly one configured product_cat term |
| Maison Margiela | 1 | WordPress export has no variants with mapped sizes |
| Melissa | 1 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Miu Miu | 1 | WordPress size conversion requires exactly one configured product_cat term |
| Moncler Genius | 1 | WordPress size conversion requires exactly one configured product_cat term |
| OAMC | 1 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Off-White | 1 | WordPress size conversion requires exactly one configured product_cat term |
| Paris Saint-Germain | 1 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Phoebe Philo | 1 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Pleasures | 1 | WordPress export has no variants with mapped sizes |
| Protocol Index | 1 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Puma | 1 | WordPress exporter request failed: Target product contains duplicate variations for one size. |
| Simone Rocha | 1 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Sp5der | 1 | WordPress export has no variants with mapped sizes |
| Studio Nicholson | 1 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Stussy | 1 | WordPress export has no variants with mapped sizes |
| Suicoke | 1 | WordPress export has no variants with mapped sizes |
| Thom Browne | 1 | WordPress size conversion requires exactly one configured product_cat term |
| Undercover | 1 | WordPress size converter request failed: Размерная сетка не найдена для указанных бренда и категории |
| Undercover | 1 | WordPress size conversion requires exactly one configured product_cat term |
| Valentino | 1 | WordPress export has no variants with mapped sizes |
| Vans | 1 | WordPress exporter request failed: Target product contains duplicate variations for one size. |
| Versace | 1 | WordPress size conversion requires exactly one configured product_cat term |
| Versace | 1 | WordPress export has no variants with mapped sizes |
| vowels | 1 | WordPress size conversion requires exactly one configured product_cat term |
| Who Decides War | 1 | WordPress export has no variants with mapped sizes |
| Y's | 1 | WordPress size conversion requires exactly one configured product_cat term |

## Проверка изменений

Локально: typecheck, 563 успешных теста (3 пропущены), build. На сервере: установка зависимостей, typecheck, полный набор из 551 успешного теста до добавления теста диапазонов (3 пропущены), затем 59 успешных contract-тестов exporter с новым тестом диапазона, build, отсутствие новых миграций, проверка сервисов и внутреннего/внешнего health. PHP-скрипты прошли php -l, preview, точечное применение и повторную проверку идемпотентности. Четыре новые брендовые таблицы проверены через реальный API. Новая очередь завершена, ошибок уровня сервиса в проверенном журнале нет.

Реализация и инструкции: [размерные сетки](../deploy/size-readiness.md). Production commit 33837f6. Локальные commits 7c3ab7b и 44c8a27.
