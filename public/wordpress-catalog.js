import { buildCatalogQuery, catalogPagination, priceIsNewerThanSnapshot } from "/assets/wordpress-catalog-model.js";

const byId = (id) => document.getElementById(id);
const pageSize = 40;
const state = { session: null, targets: [], targetId: null, run: null, page: 1, total: 0, timer: null, request: null };

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.method && state.session?.csrfToken ? { "X-CSRF-Token": state.session.csrfToken } : {}) },
    ...options,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Ошибка HTTP ${response.status}`);
  return data;
}

const count = (value) => new Intl.NumberFormat("ru-RU").format(Number(value || 0));
const date = (value) => value ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";
function node(tag, className = "", value) { const result = document.createElement(tag); if (className) result.className = className; if (value !== undefined) result.textContent = value; return result; }
function message(value, kind = "") { byId("message").textContent = value; byId("message").className = `inline-message ${kind}`; byId("message").hidden = false; }
function badge(value, kind = "") { return node("span", `export-badge ${kind}`, value); }
function asObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }

const auditLabels = { pending: "Ожидает", running: "Выполняется", ready: "Аудит готов", blocked: "Заблокирован", error: "Ошибка", skipped: "Не применим" };
const riskLabels = { none: "Без изменений", review: "Нужен просмотр", danger: "Опасные изменения", blocked: "Заблокировано" };
const variationLabels = { pending: "В очереди", refreshing: "Получает GOAT offers", ready: "Готов к WordPress", submitted: "В WordPress", completed: "Обновлено", skipped: "Пропущено", failed: "Ошибка" };
const taxonomyLabels = { pa_brand: "Бренды", pa_model: "Модели", product_cat: "Категории", product_tag: "Метки", pa_tsvet: "Цвет", pa_material: "Материал", pa_vid: "Назначение", pa_shoe_height: "Высота", pa_season: "Сезон" };
const fieldLabels = { title: "Название", slug: "Slug", sku: "SKU", description_html: "Описание", short_description_html: "Краткое описание" };

function renderRun() {
  const run = state.run;
  byId("run").hidden = !run;
  if (!run) return;
  byId("total").textContent = count(run.totalCount);
  byId("matched").textContent = count(run.matchedCount);
  byId("unmatched").textContent = count(run.unmatchedCount);
  byId("ambiguous").textContent = count(run.ambiguousCount);

  const snapshotLabels = { running: "Скачивается", completed: "Завершён", paused: "На паузе", failed: "Ошибка" };
  byId("snapshot-status").textContent = snapshotLabels[run.status] || run.status;
  byId("snapshot-meta").textContent = `${count(run.totalCount)} товаров · обновлён ${date(run.completedAt || run.updatedAt)}`;

  const auditActive = Number(run.auditPendingCount || 0);
  byId("audit-status").textContent = run.auditErrorCount > 0 ? "Есть ошибки" : auditActive > 0 ? "Выполняется" : "Завершён";
  byId("audit-ready").textContent = count(run.auditReadyCount);
  byId("audit-blocked").textContent = count(run.auditBlockedCount);
  byId("audit-meta").textContent = `ожидает ${count(auditActive)} · ошибок ${count(run.auditErrorCount)}`;

  byId("variation-completed").textContent = count(run.variationCompletedCount);
  byId("variation-skipped").textContent = count(run.variationSkippedCount);
  byId("variation-failed").textContent = `ошибок: ${count(run.variationFailedCount)}`;
  const active = Number(run.variationPendingCount || 0) + Number(run.variationSubmittedCount || 0);
  const autoLabels = { inactive: "Не запущен", running: "Выполняется", paused: "Приостановлен", completed: "Завершён" };
  byId("variation-auto-status").textContent = autoLabels[run.variationAutoStatus] || run.variationAutoStatus;
  byId("variation-auto-progress").textContent = `в работе ${count(active)} · осталось ${count(run.variationNotStartedCount)} · окно ${count(run.variationAutoWindow)}`;
  byId("variation-error").hidden = !run.variationAutoError;
  byId("variation-error").textContent = run.variationAutoError || "";

  byId("start").disabled = run.status === "running";
  byId("start").textContent = run.status === "running" ? "Снимок скачивается" : "Скачать новый снимок";
  const autoActive = run.variationAutoStatus === "running" || run.variationAutoStatus === "paused";
  byId("batch-sync").disabled = run.variationCompletedCount < 1 || run.variationFailedCount > 0 || autoActive;
  byId("auto-sync").disabled = !run.catalogComplete || run.variationCompletedCount < 1 || run.variationFailedCount > 0 || autoActive || run.variationNotStartedCount < 1;
  byId("auto-pause").hidden = run.variationAutoStatus !== "running";
  byId("auto-resume").hidden = run.variationAutoStatus !== "paused";
}

function taxonomyName(taxonomy) { return taxonomyLabels[taxonomy] || taxonomy; }
function termName(row, id, labels = {}) {
  const current = asArray(row.before_terms).find((item) => Number(item.term_id) === Number(id));
  return current?.name || labels[String(id)] || `#${id}`;
}

function changeSummary(item) {
  const result = node("div", "catalog-change-summary");
  const flags = new Set(asArray(item.changeFlags));
  for (const flag of flags) {
    if (flag.startsWith("field:")) result.append(badge(fieldLabels[flag.slice(6)] || flag.slice(6), "change"));
    else if (flag.startsWith("taxonomy_removed:")) result.append(badge(`${taxonomyName(flag.slice(17))}: удаление`, "danger"));
    else if (flag.startsWith("taxonomy_added:")) result.append(badge(`${taxonomyName(flag.slice(15))}: добавление`, "add"));
    else if (flag === "images") result.append(badge("Изображения", "change"));
    else if (flag === "variation:size") result.append(badge("Состав размеров", "danger"));
    else if (flag === "variation:price") result.append(badge("Цена пересчитается", "change"));
    else if (flag === "variation:stock") result.append(badge("Остаток синхронизируется", "change"));
  }
  if (!result.children.length && item.auditStatus === "ready") result.append(badge("Изменений нет", "safe"));
  return result;
}

function selectedTarget() { return state.targets.find((target) => String(target.id) === String(state.targetId)); }
function wordpressEditUrl(item) {
  const baseUrl = selectedTarget()?.config?.baseUrl;
  if (typeof baseUrl !== "string" || !baseUrl.startsWith("http")) return null;
  return `${baseUrl.replace(/\/$/u, "")}/wp-admin/post.php?post=${encodeURIComponent(item.wordpressProductId)}&action=edit`;
}

function renderItem(item) {
  const card = node("article", `export-card catalog-card risk-${item.auditRisk || "none"}`);
  const media = node("div", "export-card-media");
  if (item.imageUrl) { const image = document.createElement("img"); image.src = item.imageUrl; image.alt = ""; image.loading = "lazy"; media.append(image); }
  else media.append(node("span", "muted", "Нет фото"));

  const main = node("div", "export-card-main");
  const heading = node("div", "export-card-heading");
  const titleBox = node("div");
  const title = node("a", "export-card-title", item.title || "Без названия");
  title.href = item.sourceProductId ? `/products/${item.sourceProductId}` : "#";
  titleBox.append(title, node("p", "muted", `WordPress #${item.wordpressProductId} · parser ${item.sourceProductId || "—"} · internal ${item.internalProductId || "—"} · GOAT ${item.sourceExternalId || item.legacyGoatId || "—"} · SKU ${item.sku || "—"}`));
  const statuses = node("div", "export-card-statuses");
  statuses.append(badge(auditLabels[item.auditStatus] || item.auditStatus, item.auditStatus === "blocked" || item.auditStatus === "error" ? "danger" : item.auditStatus === "ready" ? "safe" : "review"));
  if (item.auditRisk) statuses.append(badge(riskLabels[item.auditRisk] || item.auditRisk, item.auditRisk === "danger" || item.auditRisk === "blocked" ? "danger" : item.auditRisk === "review" ? "review" : "safe"));
  statuses.append(badge(variationLabels[item.variationStatus] || item.variationStatus, item.variationStatus === "failed" ? "danger" : item.variationStatus === "completed" ? "safe" : ""));
  heading.append(titleBox, statuses);
  main.append(heading, changeSummary(item));
  if (item.auditError) main.append(node("p", "form-error", item.auditError));
  if (item.auditStatus === "blocked" && !item.auditError) main.append(node("p", "form-error", "Не выполнены требования экспорта. Точная причина показана в полном diff."));
  if (item.variationError) main.append(node("p", "form-error", item.variationError));

  const footer = node("div", "export-card-footer");
  const freshness = node("div", "catalog-freshness");
  freshness.append(node("span", "muted", `Снимок WordPress: ${date(item.snapshotFetchedAt)}`));
  freshness.append(node("span", "muted", `Последняя price-проверка: ${date(item.variationCheckedAt)}`));
  if (priceIsNewerThanSnapshot(item.snapshotFetchedAt, item.variationCheckedAt)) freshness.append(badge("Цена свежее снимка", "review"));
  const actions = node("div", "runtime-actions");
  if (item.sourceProductId) { const parser = node("a", "button quiet small-button", "Карточка parser"); parser.href = `/products/${item.sourceProductId}`; actions.append(parser); }
  const editUrl = wordpressEditUrl(item);
  if (editUrl) { const edit = node("a", "button quiet small-button", "Правка WordPress ↗"); edit.href = editUrl; edit.target = "_blank"; edit.rel = "noopener noreferrer"; actions.append(edit); }
  const diff = node("button", "button secondary small-button", "Полный diff"); diff.type = "button"; diff.addEventListener("click", () => openDiff(item)); actions.append(diff);
  if (item.matchStatus === "matched" && (item.variationStatus === "skipped" || item.variationStatus === "failed")) {
    const canary = node("button", "button quiet small-button", "Canary цены"); canary.type = "button";
    canary.addEventListener("click", () => enqueueCanary(item)); actions.append(canary);
  }
  footer.append(freshness, actions);
  card.append(media, main, footer);
  return card;
}

function currentFilters() {
  return {
    search: byId("search").value.trim(), audit: byId("audit-filter").value, risk: byId("risk-filter").value,
    operation: byId("operation-filter").value, change: byId("change-filter").value, variation: byId("variation-filter").value,
  };
}

function renderPagination() {
  const pagination = catalogPagination(state.total, state.page, pageSize);
  const pages = pagination.totalPages;
  state.page = pagination.page;
  byId("catalog-pagination").hidden = state.total === 0;
  byId("page-info").textContent = state.total ? `${count(pagination.first)}–${count(pagination.last)} из ${count(state.total)}` : "";
  byId("page-number").value = String(state.page);
  byId("page-number").max = String(pages);
  byId("page-total").textContent = `из ${count(pages)}`;
  byId("prev-page").disabled = state.page <= 1;
  byId("next-page").disabled = state.page >= pages;
}

async function loadItems() {
  if (!state.run) return;
  state.request?.abort();
  state.request = new AbortController();
  byId("loading").hidden = false; byId("error").hidden = true; byId("empty").hidden = true; byId("items").replaceChildren();
  try {
    const query = buildCatalogQuery(currentFilters(), state.page, pageSize);
    const data = await api(`/api/wordpress-catalog/runs/${state.run.id}/items?${query}`, { signal: state.request.signal });
    state.total = Number(data.total || 0);
    for (const item of data.items || []) byId("items").append(renderItem(item));
    byId("empty").hidden = state.total !== 0;
    if (state.total === 0 && byId("operation-filter").value === "new") byId("empty").textContent = "Новые parser-only товары не входят в снимок существующего WordPress-каталога. Их создание анализируется в разделе «Контроль экспорта».";
    else byId("empty").textContent = "По выбранным условиям товаров нет.";
    renderPagination();
  } catch (error) {
    if (error.name === "AbortError") return;
    byId("error").textContent = error.message; byId("error").hidden = false;
  } finally { byId("loading").hidden = true; }
}

function scheduleRunRefresh() {
  if (state.timer) window.clearTimeout(state.timer);
  const run = state.run;
  const active = Number(run?.variationPendingCount || 0) + Number(run?.variationSubmittedCount || 0);
  if (!document.hidden && (run?.status === "running" || run?.variationAutoStatus === "running" || active > 0)) state.timer = window.setTimeout(() => refresh(false), 5000);
}

async function refresh(reloadItems = true) {
  if (!state.targetId) return;
  byId("error").hidden = true;
  try {
    const runs = await api(`/api/wordpress-catalog/runs?targetId=${encodeURIComponent(state.targetId)}&limit=1`);
    state.run = runs.items[0] || null;
    renderRun();
    if (reloadItems) await loadItems();
    scheduleRunRefresh();
  } catch (error) { byId("loading").hidden = true; byId("error").textContent = error.message; byId("error").hidden = false; }
}

function valueBlock(value) {
  const pre = node("pre", "catalog-diff-value");
  pre.textContent = value === null || value === undefined ? "—" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return pre;
}

function diffSection(title) { const section = node("section", "catalog-diff-section"); section.append(node("h3", "", title)); return section; }
function comparison(before, after) { const box = node("div", "catalog-diff-columns"); const left = node("article"); left.append(node("span", "catalog-diff-label", "Сейчас в WordPress"), valueBlock(before)); const right = node("article"); right.append(node("span", "catalog-diff-label", "После merge"), valueBlock(after)); box.append(left, right); return box; }

function visualTerms(values) {
  const list = node("div", "preview-term-list");
  for (const value of values) list.append(node("span", "preview-term", value));
  return list;
}

function currentCatalogTerms(product, taxonomy) {
  return asArray(asObject(product.taxonomies)[taxonomy]).map((term) => term.name || `#${term.term_id}`);
}

function proposedCatalogTerms(audit, taxonomy, labels) {
  const row = asArray(audit.taxonomies).find((entry) => entry.taxonomy === taxonomy);
  return row ? asArray(row.after).map((id) => termName(row, id, labels)) : [];
}

function catalogPriceRange(variations) {
  const prices = asArray(variations).map((item) => Number(item.regular_price)).filter((value) => Number.isFinite(value) && value > 0);
  if (!prices.length) return "Цена не указана";
  const format = (value) => `${new Intl.NumberFormat("ru-RU").format(value)} ₽`;
  return Math.min(...prices) === Math.max(...prices) ? format(prices[0]) : `${format(Math.min(...prices))} – ${format(Math.max(...prices))}`;
}

function catalogVisualCard(title, product, options) {
  const card = node("article", `preview-product-card${options.muted ? " muted-card" : ""}`);
  const heading = node("div", "preview-card-heading");
  heading.append(node("p", "eyebrow", title), node("span", `preview-state-badge ${options.badgeTone || ""}`, options.badge));
  card.append(heading);
  const visual = node("div", "preview-card-visual");
  const imageUrl = options.imageUrl;
  if (imageUrl) { const image = node("img", "preview-card-image"); image.src = imageUrl; image.alt = product.title || title; visual.append(image); }
  else visual.append(node("div", "preview-image-empty", "Нет изображения"));
  const info = node("div", "preview-card-info");
  info.append(node("h4", "", product.title || "Без названия"), node("p", "preview-sku", `SKU ${product.sku || "—"}`));
  info.append(node("p", `preview-price${options.pricePending ? " pending" : ""}`, options.pricePending ? "Цена в ₽ будет рассчитана WordPress при записи" : catalogPriceRange(product.variations)));
  const facts = node("div", "preview-card-facts");
  facts.append(node("span", "", `${options.imageCount} фото`), node("span", "", `${options.variationCount} вариаций`));
  info.append(facts); visual.append(info); card.append(visual);
  const taxonomyBox = node("div", "preview-card-taxonomies");
  for (const taxonomy of ["product_cat", "pa_brand", "pa_model", "pa_tsvet", "pa_material", "pa_vid", "pa_shoe_height", "pa_season", "product_tag"]) {
    const terms = options.termGetter(taxonomy);
    if (!terms.length) continue;
    const row = node("div", "preview-card-taxonomy"); row.append(node("span", "", taxonomyName(taxonomy)), visualTerms(terms)); taxonomyBox.append(row);
  }
  if (taxonomyBox.childElementCount) card.append(taxonomyBox);
  return card;
}

function renderCatalogVisualDiff(item) {
  const audit = asObject(item.auditResult);
  const current = asObject(item.payload?.product);
  const labels = asObject(item.targetTermLabels);
  const fields = new Map(asArray(audit.fields).map((row) => [row.field, row.after]));
  const afterImages = asArray(audit.images?.after_items);
  const afterVariations = asArray(audit.variations?.after);
  const proposed = { ...current, ...Object.fromEntries(fields), images: afterImages, variations: afterVariations };
  const wrapper = node("div", "catalog-visual-diff");
  const blockers = asArray(audit.blockers);
  if (blockers.length) {
    const warning = node("div", "preview-readiness blocked");
    const body = node("div"); body.append(node("h3", "", "Экспорт заблокирован"));
    const list = node("ul", "preview-blockers"); blockers.forEach((row) => list.append(node("li", "", row.message || row.code || String(row)))); body.append(list);
    warning.append(node("span", "preview-readiness-icon", "!"), body); wrapper.append(warning);
  }
  const cards = node("div", "preview-product-grid");
  const currentImages = asArray(current.images);
  const currentVariations = asArray(current.variations);
  cards.append(
    catalogVisualCard("Сейчас в WordPress", current, {
      badge: `Снимок ${date(item.fetchedAt)}`, imageUrl: currentImages[0]?.url || "", imageCount: currentImages.length,
      variationCount: currentVariations.length, termGetter: (taxonomy) => currentCatalogTerms(current, taxonomy),
    }),
    catalogVisualCard("После merge", proposed, {
      badge: "Локальный payload", badgeTone: "ready", imageUrl: afterImages[0]?.url || "", imageCount: afterImages.length,
      variationCount: afterVariations.length, pricePending: true, termGetter: (taxonomy) => proposedCatalogTerms(audit, taxonomy, labels),
    }),
  );
  wrapper.append(cards);
  const summary = asObject(audit.summary);
  const summaryRow = node("section", "preview-change-summary");
  summaryRow.append(
    node("div", Number(summary.changed_field_count) ? "changed" : "unchanged", `${count(summary.changed_field_count)} полей изменится`),
    node("div", Number(summary.changed_taxonomy_count) ? "changed" : "unchanged", `${count(summary.changed_taxonomy_count)} групп терминов изменится`),
    node("div", summary.images_changed ? "changed" : "unchanged", summary.images_changed ? "Изображения изменятся" : "Фото без изменений"),
    node("div", Number(summary.variation_added_count) || Number(summary.variation_removed_count) ? "changed" : "unchanged", `+${count(summary.variation_added_count)} / −${count(summary.variation_removed_count)} размеров`),
  );
  wrapper.append(summaryRow);
  return wrapper;
}

function setDiffMode(mode) {
  const visual = mode === "visual";
  byId("diff-visual").hidden = !visual;
  byId("diff-content").hidden = visual;
  byId("diff-visual-tab").className = `button ${visual ? "secondary" : "quiet"}`;
  byId("diff-technical-tab").className = `button ${visual ? "quiet" : "secondary"}`;
  byId("diff-visual-tab").setAttribute("aria-selected", String(visual));
  byId("diff-technical-tab").setAttribute("aria-selected", String(!visual));
}

function renderFullDiff(item) {
  const audit = asObject(item.auditResult);
  const content = byId("diff-content"); content.replaceChildren();
  byId("diff-visual").replaceChildren(renderCatalogVisualDiff(item));
  const notices = byId("diff-notices"); notices.replaceChildren();
  byId("diff-title").textContent = asObject(item.payload?.product).title || `WordPress #${item.wordpressProductId}`;
  byId("diff-meta").textContent = `WordPress #${item.wordpressProductId} · parser ${item.sourceProductId || "—"} · снимок ${date(item.fetchedAt)} · price job ${date(item.variationCheckedAt)}`;
  if (priceIsNewerThanSnapshot(item.fetchedAt, item.variationCheckedAt)) {
    const warning = node("p", "inline-message warning", "Сохранённый полный snapshot старше последнего price-only job. Поля и taxonomy diff актуальны для даты снимка; текущая цена в WordPress могла уже измениться."); warning.hidden = false; notices.append(warning);
  }
  if (item.auditError) content.append(node("p", "form-error", item.auditError));
  const blockers = asArray(audit.blockers);
  if (blockers.length) { const section = diffSection("Причины блокировки"); const list = node("ul", "export-blockers"); blockers.forEach((row) => list.append(node("li", "", row.message || row.code || String(row)))); section.append(list); content.append(section); }

  const fields = asArray(audit.fields);
  if (fields.length) { const section = diffSection("Поля товара"); fields.forEach((row) => { const details = node("details", "catalog-diff-row"); if (row.changed) details.open = true; details.append(node("summary", "", `${fieldLabels[row.field] || row.field} · ${row.changed ? "изменится" : "без изменений"}`), comparison(row.before, row.after)); section.append(details); }); content.append(section); }

  const taxonomies = asArray(audit.taxonomies);
  if (taxonomies.length) { const section = diffSection("Категории, метки и атрибуты"); for (const row of taxonomies) { const before = asArray(row.before).map((id) => termName(row, id, item.targetTermLabels)); const after = asArray(row.after).map((id) => termName(row, id, item.targetTermLabels)); const details = node("details", "catalog-diff-row"); if (row.changed) details.open = true; details.append(node("summary", "", `${taxonomyName(row.taxonomy)} · +${asArray(row.added).length} / −${asArray(row.removed).length}`), comparison(before, after)); section.append(details); } content.append(section); }

  if (audit.images) { const section = diffSection("Изображения"); const beforeImages = asArray(audit.images.before_items).length ? asArray(audit.images.before_items).map((row) => row.url || row.key) : asArray(audit.images.before); const afterImages = asArray(audit.images.after_items).length ? asArray(audit.images.after_items).map((row) => row.url || row.key) : asArray(audit.images.after); section.append(comparison(beforeImages, afterImages)); content.append(section); }

  const variations = asArray(audit.variations?.items);
  if (audit.variations) { const section = diffSection("Вариации, размеры, цены и остатки"); section.append(node("p", "muted", "В полном локальном аудите будущая цена хранится в исходной валюте. Итоговую цену в рублях WordPress рассчитывает при записи; price-only прогон перед этим получает свежие GOAT offers.")); if (!variations.length) section.append(comparison(asArray(audit.variations.before), asArray(audit.variations.after))); else { const table = node("div", "table-wrap"); const html = node("table", "admin-table catalog-variation-table"); const head = node("thead"); const headRow = node("tr"); ["Размер", "Сейчас", "После merge", "Изменение"].forEach((label) => headRow.append(node("th", "", label))); head.append(headRow); const body = node("tbody"); for (const row of variations) { const tr = node("tr"); tr.append(node("td", "", row.size), node("td", "", row.before ? `${row.before.regular_price || "—"} · ${row.before.stock_status || "—"}${row.before.stock_quantity === null ? "" : ` · ${row.before.stock_quantity}`}` : "нет"), node("td", "", row.after ? `${row.after.price?.source_minor_amount || "без цены"} ${row.after.price?.source_currency || ""} · ${row.after.inventory?.availability || "—"}${row.after.inventory?.quantity === undefined ? "" : ` · ${row.after.inventory.quantity}`}` : "будет отключён"), node("td", "", row.state === "added" ? "добавится" : row.state === "removed" ? "удалится" : row.stock_changed ? "остаток изменится" : row.price_managed ? "цена пересчитается" : "без изменений")); body.append(tr); } html.append(head, body); table.append(html); section.append(table); } content.append(section); }
}

async function openDiff(summary) {
  const dialog = byId("diff-dialog"); dialog.showModal(); byId("diff-loading").hidden = false; byId("diff-error").hidden = true; byId("diff-content").replaceChildren(); byId("diff-visual").replaceChildren(); byId("diff-notices").replaceChildren(); setDiffMode("visual");
  try { const data = await api(`/api/wordpress-catalog/runs/${state.run.id}/items/${summary.id}`); renderFullDiff(data.item); }
  catch (error) { byId("diff-error").textContent = error.message; byId("diff-error").hidden = false; }
  finally { byId("diff-loading").hidden = true; }
}

async function enqueueCanary(item) {
  if (!window.confirm(`Обновить только существующие цены и остатки WordPress #${item.wordpressProductId}?`)) return;
  try { await api(`/api/wordpress-catalog/runs/${state.run.id}/variation-canary`, { method: "POST", body: { itemId: item.id } }); message(`Canary WordPress #${item.wordpressProductId} поставлен в очередь.`, "success"); await refresh(true); }
  catch (error) { message(error.message, "error"); }
}

async function initialize() {
  const session = await api("/api/auth/session");
  if (!session.authenticated) { byId("login-view").hidden = false; return; }
  state.session = session; byId("operator-name").textContent = session.operator; byId("app-view").hidden = false;
  const targets = await api("/api/targets"); state.targets = targets.items || [];
  for (const target of state.targets) { const option = new Option(target.name, target.id); byId("target").append(option); }
  state.targetId = byId("target").value || null;
  await refresh(true);
}

byId("login-form").addEventListener("submit", async (event) => { event.preventDefault(); try { await api("/api/auth/login", { method: "POST", body: { username: byId("login-username").value, password: byId("login-password").value } }); location.reload(); } catch (error) { byId("login-error").textContent = error.message; byId("login-error").hidden = false; } });
byId("logout-button").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST" }); location.reload(); });
byId("target").addEventListener("change", async () => { state.targetId = byId("target").value; state.page = 1; await refresh(true); });
byId("refresh").addEventListener("click", () => refresh(true));
byId("filters").addEventListener("submit", async (event) => { event.preventDefault(); state.page = 1; await loadItems(); });
byId("prev-page").addEventListener("click", async () => { if (state.page > 1) { state.page -= 1; await loadItems(); scrollTo({ top: byId("filters").offsetTop - 20, behavior: "smooth" }); } });
byId("next-page").addEventListener("click", async () => { if (state.page * pageSize < state.total) { state.page += 1; await loadItems(); scrollTo({ top: byId("filters").offsetTop - 20, behavior: "smooth" }); } });
byId("page-jump").addEventListener("submit", async (event) => { event.preventDefault(); const pages = Math.max(1, Math.ceil(state.total / pageSize)); state.page = Math.max(1, Math.min(pages, Number(byId("page-number").value) || 1)); await loadItems(); });
byId("close-diff").addEventListener("click", () => byId("diff-dialog").close());
byId("diff-visual-tab").addEventListener("click", () => setDiffMode("visual"));
byId("diff-technical-tab").addEventListener("click", () => setDiffMode("technical"));
byId("start").addEventListener("click", async () => { try { const data = await api("/api/wordpress-catalog/runs", { method: "POST", body: { targetId: state.targetId, sourceCode: "goat", auditRequested: true, variationSyncRequested: false, reason: "Полный снимок каталога WordPress" } }); state.run = data.item; renderRun(); message("Скачивание каталога поставлено в очередь. WordPress не изменяется.", "success"); scheduleRunRefresh(); } catch (error) { message(error.message, "error"); } });
byId("batch-sync").addEventListener("click", async () => { const limit = Number(byId("batch-limit").value); if (!state.run || !window.confirm(`Поставить в очередь ${count(limit)} товаров? Изменятся только цены и остатки существующих вариаций.`)) return; try { const data = await api(`/api/wordpress-catalog/runs/${state.run.id}/variation-batch`, { method: "POST", body: { limit } }); message(`Поставлено задач: ${count(data.result.queuedCount)}.`, "success"); await refresh(true); } catch (error) { message(error.message, "error"); } });
byId("auto-sync").addEventListener("click", async () => { const windowSize = Number(byId("batch-limit").value); if (!state.run || !window.confirm(`Запустить price-only автопрогон для ${count(state.run.variationNotStartedCount)} товаров с окном ${count(windowSize)}?`)) return; try { await api(`/api/wordpress-catalog/runs/${state.run.id}/variation-sync`, { method: "POST", body: { window: windowSize } }); message("Автопрогон запущен.", "success"); await refresh(true); } catch (error) { message(error.message, "error"); } });
byId("auto-pause").addEventListener("click", async () => { if (!state.run || !window.confirm("Остановить пополнение? Уже поставленные задачи завершатся.")) return; try { await api(`/api/wordpress-catalog/runs/${state.run.id}/variation-sync/pause`, { method: "POST" }); message("Пополнение очереди остановлено.", "success"); await refresh(true); } catch (error) { message(error.message, "error"); } });
byId("auto-resume").addEventListener("click", async () => { if (!state.run || !window.confirm("Возобновить автопрогон после проверки журнала?")) return; try { await api(`/api/wordpress-catalog/runs/${state.run.id}/variation-sync/resume`, { method: "POST" }); message("Автопрогон возобновлён.", "success"); await refresh(true); } catch (error) { message(error.message, "error"); } });
document.addEventListener("visibilitychange", () => { if (document.hidden && state.timer) window.clearTimeout(state.timer); else scheduleRunRefresh(); });
void initialize().catch((error) => { byId("loading").hidden = true; byId("error").textContent = error.message; byId("error").hidden = false; });
