const byId = (id) => document.getElementById(id);
const state = { session: null, schema: null, targets: [], overview: null, selected: null, ruleProductId: null, searchTimer: null, workbenchOffset: 0, workbench: null, workbenchLoading: false, focusProductId: new URLSearchParams(location.search).get("productId"), indexPoll: null, termCreation: null, termLandingError: null };
state.search = new URLSearchParams(location.search).get("search") || "";
const dictionaryTypes = { "product.category": "product_categories", "product.tag": "tags", "product.brand": "brands", "product.model": "models", "product.color": "colors", "product.material": "materials", "product.activity": "activities", "product.shoe_height": "shoe_heights", "product.season": "seasons" };
const scopeLabels = { "product.brand": "Бренд", "product.model": "Модель", "product.category": "Категория", "product.tag": "Метка", "product.color": "Цвет", "product.material": "Материал", "product.activity": "Вид спорта", "product.shoe_height": "Высота обуви", "product.season": "Сезон" };
async function api(url, options = {}) { const headers = { Accept: "application/json" }; if (options.body !== undefined) headers["Content-Type"] = "application/json"; if (options.method && options.method !== "GET" && state.session?.csrfToken) headers["X-CSRF-Token"] = state.session.csrfToken; const response = await fetch(url, { credentials: "same-origin", headers, ...options, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`); return data; }
function node(tag, className = "", value = "") { const item = document.createElement(tag); item.className = className; item.textContent = value; return item; }
function toast(value) { byId("toast").textContent = value; byId("toast").hidden = false; setTimeout(() => { byId("toast").hidden = true; }, 2600); }
function error(value) { byId("page-error").textContent = value; byId("page-error").hidden = false; }
function number(value) { return Number(value || 0).toLocaleString("ru-RU"); }
function slugify(value) { const replacements = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" }; return value.toLowerCase().split("").map((letter) => replacements[letter] ?? letter).join("").normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, ""); }
function activeTarget() { return state.targets[0] ?? null; }
function termRelation(entityType) { return activeTarget()?.dictionary?.termRelationCapabilities?.find((item) => item.sourceEntityType === entityType && item.relationCode === "landing") ?? null; }
function canCreateTerm(entityType) { return activeTarget()?.dictionary?.creatableEntityTypes?.includes(entityType) === true; }
function renderSummary() { const catalog = state.overview.summary.catalog; const counts = state.overview.summary.native; const cards = catalog ? [["Всего записей", catalog.total], ["Точное условие", catalog.exact], ["Составные / другие условия", catalog.conditional]] : [["Всего записей", counts.shadow + counts.draft + counts.disabled]]; byId("rules-summary").replaceChildren(...cards.map(([label, value]) => { const card = node("article", "rule-summary-card"); card.append(node("strong", "", number(value)), node("span", "", label)); return card; })); }
function workbenchStatus(value) { return value === "ready" ? "Готов" : value === "conflict" ? "Конфликт" : "Не завершён"; }
function scopeFromBlocker(code) { return code === "required_brand_missing" ? "product.brand" : code === "required_model_missing" ? "product.model" : code === "required_category_missing" ? "product.category" : null; }
function resultField(scope, values) { const box = node("div", `workbench-field ${values.length ? "complete" : "missing"}`); box.append(node("span", "", scopeLabels[scope] || scope), node("strong", "", values.length ? values.map((item) => item.label).join(" · ") : "Не заполнено")); return box; }
function suggestedConditions(item, scope) {
  const type = scope.split(".").at(-1); const candidate = item.candidates?.[scope]?.[0];
  if (!candidate?.sourceValue) return [{ conditions: [{ field: "common.source.productId", operator: "equals", values: [item.sourceProductId] }] }];
  const groups = [{ conditions: [{ field: `candidate.${type}.sourceValue`, operator: "equals", values: [candidate.sourceValue] }] }];
  if (scope === "product.model") {
    for (const key of ["brand", "family"]) {
      const value = candidate.context?.[key];
      if (typeof value === "string" && value.trim()) groups.push({ conditions: [{ field: `candidate.model.context.${key}`, operator: "equals", values: [value.trim()] }] });
    }
  }
  return groups;
}
function prefillFromProduct(item, scope) {
  reset();
  state.ruleProductId = item.sourceProductId;
  const short = scope.split(".").at(-1);
  byId("editor-title").textContent = `Правило для товара #${item.sourceProductId}`;
  byId("rule-name").value = `Товар #${item.sourceProductId}: ${scopeLabels[scope]}`;
  byId("rule-group").value = `${short}_product_${item.sourceProductId}`;
  byId("rule-source").value = byId("workbench-source").value;
  byId("rule-status").value = "draft";
  renderConditions(suggestedConditions(item, scope));
  renderActions([{ targetScope: scope, mode: "add", searchValue: item.candidates?.[scope]?.[0]?.sourceValue || "" }]);
  document.querySelector(".rule-editor-card").scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderWorkbench() {
  const data = state.workbench;
  const items = data?.items || [];
  const counts = data?.counts || {};
  byId("workbench-summary").replaceChildren(
    node("span", "workbench-count ready", `Готово: ${number(counts.ready)}`),
    node("span", "workbench-count incomplete", `Не завершено: ${number(counts.incomplete)}`),
    node("span", "workbench-count conflict", `Конфликтов: ${number(counts.conflict)}`),
    node("small", "muted", `Найдено: ${number(data?.filteredCount ?? items.length)}`),
    node("small", data?.index?.complete ? "muted" : "workbench-indexing", data?.index?.complete
      ? `Индекс актуален: ${number(data.index.indexed)} товаров`
      : `Индекс обновляется: ${number(data?.index?.indexed)} из ${number(data?.index?.total)}. Пока результаты неполные.`),
    ...(data?.index?.error ? [node("small", "workbench-indexing", `Ошибка индекса: ${data.index.error}`)] : []),
  );
  byId("workbench-empty").hidden = items.length > 0;
  byId("workbench-items").replaceChildren(...items.map((item) => {
    const card = node("article", `workbench-product status-${item.status}`);
    const heading = node("div", "workbench-product-heading");
    const title = node("div"); const link = node("a", "", item.title || `Товар #${item.sourceProductId}`); link.href = `/products/${encodeURIComponent(item.sourceProductId)}`;
    title.append(link, node("small", "muted", `#${item.sourceProductId}${item.sourceExternalId ? ` · donor ${item.sourceExternalId}` : ""}${item.sku ? ` · ${item.sku}` : ""}`));
    heading.append(title, node("span", `workbench-status ${item.status}`, workbenchStatus(item.status)));
    const summary = node("div", "workbench-product-summary");
    const missing = (item.blockers || []).filter((issue) => issue.code?.startsWith("required_")).map((issue) =>
      scopeLabels[scopeFromBlocker(issue.code)] || issue.code);
    summary.append(node("span", "", missing.length ? "Нет правила для:" : "Обязательные назначения есть"));
    for (const label of missing) summary.append(node("span", "missing", label));
    if (item.conflicts?.length) summary.append(node("span", "missing", `Конфликтов: ${item.conflicts.length}`));
    const structural = (item.blockers || []).filter((issue) => !issue.code?.startsWith("required_")).length;
    if (structural) summary.append(node("span", "missing", `Проблем данных: ${structural}`));
    const expand = uiButton("Подробности", () => { detailsBox.hidden = !detailsBox.hidden; expand.textContent = detailsBox.hidden ? "Подробности" : "Свернуть"; });
    const main = node("div", "workbench-product-main"); main.append(summary);
    const firstRuleIssue = (item.blockers || []).find((issue) => scopeFromBlocker(issue.code));
    if (firstRuleIssue) main.append(uiButton("Создать правило", () => prefillFromProduct(item, scopeFromBlocker(firstRuleIssue.code))));
    main.append(expand);
    const detailsBox = node("div", "workbench-product-details"); detailsBox.hidden = true;
    const fields = node("div", "workbench-fields");
    for (const scope of ["product.brand", "product.model", "product.category"]) fields.append(resultField(scope, item.result?.fields?.[scope] || []));
    const optionalFields = Object.entries(item.result?.fields || {}).filter(([scope]) => !["product.brand", "product.model", "product.category"].includes(scope));
    const optional = node("details", "workbench-trace"); optional.append(node("summary", "", "Необязательные назначения"));
    optionalFields.forEach(([scope, values]) => optional.append(node("p", "", `${scopeLabels[scope] || scope}: ${values.map((value) => value.label).join(", ")}`)));
    if (!optionalFields.length) optional.append(node("p", "muted", "Не назначены. Готовность товара от них не зависит."));
    const facts = node("div", "workbench-facts");
    facts.append(node("span", item.result?.descriptionPresent ? "ok" : "missing", item.result?.descriptionPresent ? "Описание есть" : "Нет описания"), node("span", item.result?.imageCount ? "ok" : "missing", `Изображений: ${number(item.result?.imageCount)}`), node("span", item.result?.variantCount ? "ok" : "missing", `Вариаций: ${number(item.result?.variantCount)}`));
    const issues = node("div", "workbench-issues");
    for (const issue of [...(item.conflicts || []), ...(item.blockers || [])]) {
      const row = node("div", issue.code?.includes("conflict") ? "workbench-issue conflict" : "workbench-issue");
      row.append(node("span", "", issue.message));
      const scope = scopeFromBlocker(issue.code);
      if (scope) row.append(uiButton(`Создать правило: ${scopeLabels[scope]}`, () => prefillFromProduct(item, scope)));
      issues.append(row);
    }
    const details = node("details", "workbench-trace"); details.append(node("summary", "", `Как собран результат · правил в трассировке: ${number(item.trace?.length)}`));
    if (item.trace?.length) item.trace.forEach((entry) => details.append(node("p", "", `${entry.name}${entry.groupCode ? ` [${entry.groupCode}]` : ""}: ${entry.changes.join("; ")}`)));
    else details.append(node("p", "muted", "Подходящие правила не внесли изменений."));
    const candidates = node("details", "workbench-trace"); candidates.append(node("summary", "", "Данные донора для правил"), node("pre", "", JSON.stringify(item.candidates || {}, null, 2)));
    detailsBox.append(fields, facts, issues, optional, details, candidates);
    card.append(heading, main, detailsBox);
    return card;
  }));
  byId("workbench-page").textContent = `Страница ${Math.floor((data?.page?.offset || 0) / (data?.page?.limit || 40)) + 1}`;
  byId("workbench-prev").disabled = !data?.page?.offset;
  byId("workbench-next").disabled = !data?.page?.hasMore;
}
async function loadWorkbench(quiet = false) {
  if (state.workbenchLoading) return;
  state.workbenchLoading = true;
  if (!quiet) { byId("workbench-loading").hidden = false; byId("workbench-items").replaceChildren(); byId("workbench-empty").hidden = true; }
  try {
    const query = new URLSearchParams({ sourceId: byId("workbench-source").value, targetId: state.targets[0].id,
      status: byId("workbench-status").value, variants: byId("workbench-variants").value,
      search: byId("workbench-search").value.trim(), limit: "40", offset: String(state.workbenchOffset) });
    if (byId("workbench-missing").value) query.set("missingField", byId("workbench-missing").value);
    query.set("sort", byId("workbench-sort").value);
    if (state.focusProductId) query.set("productId", state.focusProductId);
    state.workbench = await api(`/api/rules-v2/workbench?${query}`); renderWorkbench();
    clearTimeout(state.indexPoll);
    if (!state.focusProductId && state.workbench.index?.complete === false && !state.workbench.index?.error) state.indexPoll = setTimeout(() => loadWorkbench(true), 10000);
  } catch (cause) { error(cause.message); }
  finally { state.workbenchLoading = false; byId("workbench-loading").hidden = true; }
}
function statusLabel(status) { return status === "shadow" ? (state.overview?.authoritative ? "Работает" : "В тени") : status === "disabled" ? "Выключено" : "Черновик"; }
const originLabels = { native: "Создано в v2", exact_mapping: "Точное сопоставление", classification_rule: "Правило классификатора", target_mapping: "Связь с WordPress", classification_projection: "Проекция классификации", reference_projection: "Проекция справочника", target_assignment_rule: "Назначение WordPress" };
function actionLabel(action) { if (action.kind === "resolve_reference") return action.resolutionStatus === "ignored" ? "Игнорировать" : `${action.referenceType}: ${action.referenceValueName || action.referenceValueCode || action.referenceValueId}`; return `${action.targetScope}: ${action.externalLabel}`; }
function renderList() { const items = state.overview.items || []; if (!items.length) { byId("rules-list").replaceChildren(node("p", "muted rules-empty", "Правил v2 пока нет. Создайте первое и проверьте охват товаров.")); return; } byId("rules-list").replaceChildren(...items.map((rule) => { const button = node("button", `rule-list-item${state.selected?.id === rule.id ? " active" : ""}`); button.type = "button"; const heading = node("span", "rule-list-heading"); heading.append(node("strong", "", rule.name), node("small", `rule-status ${rule.status}`, statusLabel(rule.status))); const condition = rule.conditionGroups[0]?.conditions[0]; heading.append(node("span", "muted", `${condition?.field || "—"} ${condition?.operator || ""} ${(condition?.values || []).join(", ")} → ${(rule.actions || []).map(actionLabel).join(", ")}`)); button.append(heading, node("b", "rule-priority", String(rule.priority))); button.addEventListener("click", () => selectRule(rule)); return button; })); }
function editable(rule) { return rule.originKind === "native" && rule.sourceId !== null && rule.targetId !== null && rule.actions.every((action) => action.kind !== "resolve_reference"); }
function showForm(visible) { document.querySelectorAll(".rule-editor-card > .rule-editor-grid, .rule-editor-card > .rule-block, .rule-editor-card > .rule-editor-actions").forEach((item) => { item.hidden = !visible; }); byId("rule-details").hidden = visible; }
function reset() { state.fixedDependency = false; state.selected = null; state.ruleProductId = null; state.previewSignature = null; showForm(true); byId("editor-title").textContent = "Новое правило"; byId("editor-revision").textContent = "Черновик"; byId("rule-name").value = ""; byId("rule-group").value = "category"; byId("rule-priority").value = "100"; byId("rule-status").value = "draft"; byId("preview-rule").disabled = false; byId("rule-source").disabled = false; byId("rule-group").disabled = false; byId("rule-priority").disabled = false; byId("condition-operator").value = "equals"; byId("condition-value").disabled = false; byId("condition-value").value = ""; byId("dictionary-search").value = ""; byId("dictionary-value").replaceChildren(); byId("preview-result").hidden = true; if (byId("multi-conditions")) { renderConditions(); renderActions(); } renderList(); }
function detailRow(label, value) { const row = node("div", "rule-detail-row"); row.append(node("span", "muted", label), node("strong", "", String(value ?? "—"))); return row; }
function inspect(rule) { state.selected = rule; showForm(false); byId("editor-title").textContent = rule.name; byId("editor-revision").textContent = `${statusLabel(rule.status)} · v${rule.revision}`; const details = byId("rule-details"); const meta = node("div", "rule-detail-meta"); meta.append(detailRow("Происхождение", `${originLabels[rule.originKind] || rule.originKind}${rule.originId ? ` #${rule.originId}` : ""}`), detailRow("Источник", rule.sourceCode || "Любой"), detailRow("Target", rule.targetCode || "Любой"), detailRow("Группа конфликта", rule.groupCode), detailRow("Приоритет", rule.priority)); const groups = node("div", "rule-detail-section"); groups.append(node("h4", "", "Условия · группы соединяются И")); rule.conditionGroups.forEach((group, index) => { const block = node("div", "rule-detail-group"); block.append(node("strong", "", `Группа ${index + 1} · условия соединяются ИЛИ`)); group.conditions.forEach((condition) => block.append(node("p", "", `${condition.field} · ${condition.operator} · ${condition.values?.join(", ") || "без значения"}`))); groups.append(block); }); const actions = node("div", "rule-detail-section"); actions.append(node("h4", "", "Действия")); rule.actions.forEach((action) => { const label = action.kind === "resolve_reference" ? `${action.resolutionStatus === "ignored" ? "Игнорировать" : "Сопоставить"}: ${action.referenceType} → ${action.referenceValueName || action.referenceValueCode || action.referenceValueId || "—"}` : `${action.mode === "replace" ? "Заменить" : "Добавить"}: ${action.targetScope} → ${action.externalLabel || action.externalValue || action.dictionaryValueId}`; actions.append(node("p", "rule-detail-action", label)); }); const technical = node("details", "rule-detail-raw"); technical.append(node("summary", "", "Технические данные и исходная запись"), node("pre", "", JSON.stringify({ conditionGroups: rule.conditionGroups, actions: rule.actions, originPayload: rule.originPayload }, null, 2))); details.replaceChildren(node("p", "rule-detail-notice", rule.originPayload.manualOverride ? "Копия v2 изменена вручную и защищена от повторного импорта." : "Копия старого контура. Можно изменить её отдельно в v2; исходный контур не изменится."), meta, groups, actions, technical, uiButton("Редактировать копию v2", () => editImported(rule))); byId("preview-result").hidden = true; renderList(); }
function edit(rule) { reset(); state.selected = rule; byId("editor-title").textContent = rule.name; byId("editor-revision").textContent = "Версия " + rule.revision; byId("rule-name").value = rule.name; byId("rule-group").value = rule.groupCode; byId("rule-priority").value = rule.priority; byId("rule-status").value = rule.status; byId("rule-source").value = rule.sourceId; renderConditions(rule.conditionGroups); renderActions(rule.actions); renderList(); }
function selectRule(rule) { if (editable(rule)) edit(rule); else inspect(rule); }
function ensureFieldOption(path) { if ([...byId("condition-field").options].some((option) => option.value === path)) return; const option = node("option", "", path); option.value = path; byId("condition-field").append(option); }
function values() { return byId("condition-operator").value === "absent" ? [] : byId("condition-value").value.split(/\n|,/u).map((value) => value.trim()).filter(Boolean); }
function body() { return { sourceId: byId("rule-source").value, targetId: state.targets[0].id, name: byId("rule-name").value.trim(), groupCode: byId("rule-group").value.trim(), priority: Number(byId("rule-priority").value), status: byId("rule-status").value, conditionGroups: state.fixedDependency ? state.selected.conditionGroups : [...byId("multi-conditions").children].map((group) => ({ conditions: [...group.querySelector(".condition-rows").children].map((row) => { const operator = row.querySelector(".condition-op").value; return { field: row.querySelector(".condition-path").value, operator, values: operator === "absent" ? [] : row.querySelector("textarea").value.split("\n").map((value) => value.trim()).filter(Boolean) }; }) })), actions: [...byId("multi-actions").children].map((row) => { if (row.dataset.referenceType) return { kind: "resolve_reference", referenceType: row.dataset.referenceType, referenceValueId: row.querySelector(".reference-value").value || null, resolutionStatus: row.querySelector(".reference-status").value }; const dictionaryValueId = row.querySelector(".action-value").value; if (!dictionaryValueId) throw new Error("Выберите значение WordPress для каждого действия"); return { targetScope: row.querySelector(".action-scope").value, mode: row.querySelector(".action-mode").value, dictionaryValueId, ...(row.querySelector(".action-primary-brand")?.checked ? { primarySourceBrand: true } : {}) }; }), ...(state.selected ? { revision: state.selected.revision, previewRuleId: state.selected.id } : {}) }; }
async function loadRules() { state.overview = await api("/api/rules-v2?targetId=" + encodeURIComponent(state.targets[0].id) + "&search=" + encodeURIComponent(state.search || "") + "&offset=" + (state.offset || 0)); const active = state.overview.authoritative === true; byId("rules-mode-badge").textContent = active ? "Основной режим" : "Теневой режим"; byId("rules-mode-description").textContent = active ? "Правила v2 применяются к товарам при обработке и перед экспортом." : "Правила v2 проверяются отдельно. Сейчас товары обрабатываются по старым правилам."; renderSummary(); renderList(); byId("rules-page").textContent = "Страница " + (Math.floor((state.offset || 0) / 100) + 1); byId("rules-prev").disabled = !state.offset; byId("rules-next").disabled = !state.overview.page?.hasMore; }
async function searchDictionary() { const query = byId("dictionary-search").value.trim(); const scope = byId("action-scope").value; const entityType = dictionaryTypes[scope]; const data = await api(`/api/targets/${encodeURIComponent(state.targets[0].id)}/dictionary?entityType=${encodeURIComponent(entityType)}&search=${encodeURIComponent(query)}&limit=30&offset=0`); const items = data.items || []; byId("dictionary-value").replaceChildren(...items.map((item) => { const option = node("option", "", `${item.name} · ${item.externalId}`); option.value = item.id; return option; })); }
async function preview() {
  try {
    const payload = body(); const signature = JSON.stringify(payload); state.previewSignature = null;
    const { id } = await api("/api/rules-v2/preview-full", { method: "POST", body: payload });
    const box = byId("preview-result"); box.hidden = false;
    byId("preview-rule").disabled = true;
    while (true) {
      const result = await api(`/api/rules-v2/preview-full/${encodeURIComponent(id)}`);
      box.replaceChildren(node("strong", "", `Проверено ${number(result.checked)} из ${number(result.total)} товаров · совпало: ${number(result.matched)}`));
      if (result.status === "failed") throw new Error(result.error || "Проверка прервалась");
      if (result.status === "complete") {
        box.append(node("p", "", `Полностью готовы после правила: ${number(result.newlyReady)} · уже имели значения: ${number(result.existing)} · существующие значения изменятся: ${number(result.changedExisting)}`));
        for (const [scope, count] of Object.entries(result.filled || {})) box.append(node("p", "", `Заполнено «${scopeLabels[scope] || scope}»: ${number(count)}`));
        if (result.conflicts?.length) {
          const list = node("ul", "preview-blockers");
          result.conflicts.forEach((item) => { const row = node("li"); const link = node("a", "", `Товар #${item.sourceProductId}`);
            link.href = `/products/${encodeURIComponent(item.sourceProductId)}`; row.append(link, document.createTextNode(`: ${item.message}`)); list.append(row); });
          box.append(node("h4", "", `Конфликты: ${number(result.conflictCount)} (первые 20):`), list);
        }
        if (result.examples?.length) {
          const examples = node("details", "workbench-trace"); examples.append(node("summary", "", "Примеры товаров до и после"));
          result.examples.forEach((item) => { const row = node("p"); const link = node("a", "", item.title || `Товар #${item.sourceProductId}`);
            link.href = `/products/${encodeURIComponent(item.sourceProductId)}`; row.append(link, document.createTextNode(` · ${workbenchStatus(item.before)} → ${workbenchStatus(item.after)} · ${JSON.stringify(item.beforeFields)} → ${JSON.stringify(item.afterFields)}`)); examples.append(row); });
          box.append(examples);
        }
        state.previewSignature = result.conflictCount ? null : signature;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } catch (cause) { error(cause.message); } finally { byId("preview-rule").disabled = false; }
}
function matchesWorkbenchFilters(item) {
  const status = byId("workbench-status").value;
  if (status === "incomplete" && !["incomplete", "conflict"].includes(item.status)) return false;
  if (!["all", "incomplete"].includes(status) && item.status !== status) return false;
  const missing = byId("workbench-missing").value;
  if (missing && !(item.blockers || []).some((issue) => issue.code === `required_${missing}_missing`)) return false;
  const variants = byId("workbench-variants").value;
  const hasVariants = !(item.blockers || []).some((issue) => issue.code === "variants_missing");
  return variants === "all" || (variants === "with" && hasVariants) || (variants === "without" && !hasVariants);
}
async function refreshSavedProduct(productId) {
  const query = new URLSearchParams({ sourceId: byId("workbench-source").value, targetId: state.targets[0].id, productId });
  const result = await api(`/api/rules-v2/workbench?${query}`);
  const item = result.items?.[0];
  if (!item || !state.workbench) return { removed: false, blockers: [] };
  const index = (state.workbench.items || []).findIndex((candidate) => candidate.sourceProductId === productId);
  const visible = matchesWorkbenchFilters(item);
  if (index >= 0 && visible) state.workbench.items[index] = item;
  if (index >= 0 && !visible) { state.workbench.items.splice(index, 1); state.workbench.filteredCount = Math.max(0, (state.workbench.filteredCount || 1) - 1); }
  renderWorkbench();
  clearTimeout(state.indexPoll);
  state.indexPoll = setTimeout(() => loadWorkbench(true), 10000);
  return { removed: !visible, blockers: [...(item.conflicts || []), ...(item.blockers || [])] };
}
async function save() { try { const payload = body(); const productId = state.ruleProductId; if ((!state.selected || state.selected.originKind === "native") && state.previewSignature !== JSON.stringify(payload)) throw new Error("Сначала завершите полную проверку влияния этого правила без конфликтов."); const url = state.selected ? `/api/rules-v2/${state.selected.id}${state.selected.originKind === "native" ? "" : "/imported"}` : "/api/rules-v2"; await api(url, { method: state.selected ? "PUT" : "POST", body: payload }); await loadRules(); reset(); if (payload.status !== "shadow") { await loadWorkbench(); toast("Черновик сохранён. Он не применяется к товарам и не меняет очередь."); return; } if (productId) { const outcome = await refreshSavedProduct(productId); toast(outcome.removed ? "Рабочее правило сохранено. Товар убран из текущей выборки." : `Рабочее правило сохранено. Товар остаётся в очереди: нерешённых проблем ${outcome.blockers.length}.`); } else { await loadWorkbench(); toast("Рабочее правило сохранено. Очередь пересчитывается."); } } catch (cause) { error(cause.message); } }
function fieldOptions() { const types = ["brand", "designer", "model", "category", "merchandising_category", "color", "material", "tag", "activity", "shoe_height", "season"]; const fields = (state.schema.v2RuleFields || state.schema.ruleFields).flatMap((field) => field.path.includes("{type}") ? types.map((type) => ({ ...field, path: field.path.replace("{type}", type), name: `${field.name}: ${type}` })) : [field]); byId("condition-field").replaceChildren(...fields.map((field) => { const option = node("option", "", `${field.name} · ${field.path}`); option.value = field.path; option.title = field.description; return option; })); }

function uiButton(text, callback) { const button = node("button", "button secondary", text); button.type = "button"; button.addEventListener("click", callback); return button; }
function copySelect(id, className, value) { const select = byId(id).cloneNode(true); select.removeAttribute("id"); select.className = className; if (value !== undefined) { if (![...select.options].some((o) => o.value === value)) { const o = node("option", "", value); o.value = value; select.append(o); } select.value = value; } return select; }
function addCondition(rows, condition = { field: "common.title", operator: "equals", values: [] }) {
  const row = node("div", "rule-condition-grid");
  const field = copySelect("condition-field", "condition-path", condition.field); field.setAttribute("aria-label", "Поле");
  const operator = copySelect("condition-operator", "condition-op", condition.operator); operator.setAttribute("aria-label", "Условие");
  const values = node("textarea"); values.rows = 2; values.value = condition.values.join("\n"); values.placeholder = "Каждое значение с новой строки; запятые сохраняются"; values.setAttribute("aria-label", "Значения");
  values.disabled = operator.value === "absent"; operator.addEventListener("change", () => { values.disabled = operator.value === "absent"; });
  row.append(field, operator, values, uiButton("Удалить условие", () => row.remove())); rows.append(row);
}
function addConditionGroup(group = { conditions: [{ field: "product.title", operator: "equals", values: [] }] }) {
  const block = node("div", "rule-block"); const rows = node("div", "condition-rows");
  block.append(node("strong", "", "И · хотя бы одно условие в группе (ИЛИ)"), rows, uiButton("+ ИЛИ", () => addCondition(rows)), uiButton("Удалить группу", () => block.remove()));
  group.conditions.forEach((condition) => addCondition(rows, condition)); byId("multi-conditions").append(block);
}
function renderConditions(groups) { byId("multi-conditions").parentElement.querySelectorAll(":scope > button").forEach((item) => { item.disabled = false; }); byId("multi-conditions").replaceChildren(); (groups || [{ conditions: [{ field: "product.title", operator: "equals", values: [] }] }]).forEach(addConditionGroup); }
function addTargetAction(action) {
  if (action?.kind === "resolve_reference") { addReferenceAction(action); return; }
  const row = node("div", "rule-block");
  const scope = copySelect("action-scope", "action-scope", action?.targetScope || "product.category");
  const mode = copySelect("action-mode", "action-mode", action?.mode || "add");
  const search = node("input"); search.type = "search"; search.placeholder = "Найти значение WordPress"; search.value = action?.searchValue || "";
  const values = node("select", "action-value"); values.size = 4;
  if (action?.dictionaryValueId) { const o = node("option", "", action.externalLabel || action.dictionaryValueId); o.value = action.dictionaryValueId; values.append(o); values.value = action.dictionaryValueId; }
  let timer; let generation = 0;
  async function find() { const request = ++generation; try { const data = await api("/api/targets/" + state.targets[0].id + "/dictionary?entityType=" + encodeURIComponent(dictionaryTypes[scope.value]) + "&search=" + encodeURIComponent(search.value.trim()) + "&limit=30&offset=0"); if (request !== generation || !row.isConnected) return; const empty = node("option", "", "Выберите значение"); empty.value = ""; values.replaceChildren(empty, ...(data.items || []).map((item) => { const o = node("option", "", item.name + " · " + item.externalId); o.value = item.id; return o; })); } catch (cause) { if (request === generation) error(cause.message); } }
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(find, 300); });
  scope.addEventListener("change", () => { generation++; values.replaceChildren(); void find(); });
  const grid = node("div", "rule-condition-grid"); const choice = node("div"); choice.append(search, values);
  const create = uiButton("+ Создать в WordPress", () => openTermCreation(row, scope, search, values)); create.classList.add("wide");
  const syncCreate = () => { create.hidden = !canCreateTerm(dictionaryTypes[scope.value]); }; scope.addEventListener("change", syncCreate); syncCreate(); choice.append(create); grid.append(scope, mode, choice);
  const primaryLabel = node("label", "rule-primary-brand"); const primary = node("input", "action-primary-brand"); primary.type = "checkbox"; primary.checked = action?.primarySourceBrand === true; primaryLabel.append(primary, node("span", "", "Основной бренд товара для размерной сетки")); const syncPrimary = () => { primaryLabel.hidden = scope.value !== "product.brand"; if (primaryLabel.hidden) primary.checked = false; }; scope.addEventListener("change", syncPrimary); syncPrimary();
  row.append(grid, primaryLabel, uiButton("Удалить действие", () => { generation++; clearTimeout(timer); row.remove(); })); byId("multi-actions").append(row);
}
function renderActions(actions) { byId("multi-actions").parentElement.querySelectorAll(":scope > button").forEach((item) => { item.disabled = false; }); byId("multi-actions").replaceChildren(); (actions || [undefined]).forEach(addTargetAction); }

async function loadTermParents(targetId, search = "") {
  const select = byId("v2-term-parent"); select.replaceChildren(new Option("Без родителя", ""));
  const params = new URLSearchParams({ entityType: "product_categories", search, limit: "50", offset: "0" });
  const data = await api(`/api/targets/${encodeURIComponent(targetId)}/dictionary?${params}`);
  for (const item of data.items || []) select.append(new Option(`${item.name} · ${item.externalId}`, item.externalId));
}

async function loadTermLanding(targetId, relation, name) {
  const select = byId("v2-term-landing-mode"); select.replaceChildren(new Option("Создать новую метку", "create"));
  state.termLandingError = null;
  try {
    const params = new URLSearchParams({ entityType: relation.relatedEntityType, search: name, limit: "30", offset: "0" });
    const data = await api(`/api/targets/${encodeURIComponent(targetId)}/dictionary?${params}`);
    const expected = slugify(name);
    const exact = (data.items || []).filter((item) => item.slug === expected || slugify(item.name) === expected);
    for (const item of exact) select.append(new Option(`Связать существующую: ${item.name} · ${item.externalId}`, `existing:${item.externalId}`));
    if (exact[0]) select.value = `existing:${exact[0].externalId}`;
    byId("v2-term-landing-status").textContent = exact.length
      ? "Найдена одноимённая метка. Новая метка создаваться не будет."
      : "Одноимённой метки нет: WordPress создаст новую посадочную метку.";
  } catch (cause) {
    state.termLandingError = cause.message;
    byId("v2-term-landing-status").textContent = `Не удалось проверить существующие метки: ${cause.message}`;
  }
}

async function openTermCreation(row, scope, search, values) {
  const target = activeTarget(); const entityType = dictionaryTypes[scope.value]; const name = search.value.trim();
  if (!target || !canCreateTerm(entityType)) return;
  if (!name) { error("Сначала введите точное название нового термина WordPress."); return; }
  state.termCreation = { row, scope, values, entityType };
  byId("v2-term-name").value = name; byId("v2-term-slug").value = slugify(name);
  byId("v2-term-type").textContent = `${scopeLabels[scope.value] || scope.value} · ${entityType}`;
  byId("v2-term-confirm").checked = false; byId("v2-term-error").hidden = true;
  const parent = byId("v2-term-parent-field"); parent.hidden = entityType !== "product_categories";
  if (!parent.hidden) { byId("v2-term-parent-search").value = ""; await loadTermParents(target.id); }
  const relation = termRelation(entityType); const landing = byId("v2-term-landing-field"); landing.hidden = !relation;
  byId("v2-term-landing").checked = Boolean(relation); byId("v2-term-landing-mode-field").hidden = !relation;
  if (relation) await loadTermLanding(target.id, relation, name);
  byId("v2-term-dialog").showModal();
}

async function createTermForRule(event) {
  event.preventDefault();
  const creation = state.termCreation; const target = activeTarget();
  if (!creation || !creation.row.isConnected || !target) return;
  const submit = byId("v2-term-submit"); const failure = byId("v2-term-error"); failure.hidden = true; submit.disabled = true;
  try {
    const body = { sourceId: byId("rule-source").value, entityType: creation.entityType, name: byId("v2-term-name").value.trim() };
    const slug = byId("v2-term-slug").value.trim(); if (slug) body.slug = slug;
    const parent = byId("v2-term-parent").value; if (creation.entityType === "product_categories" && parent) body.parentExternalId = parent;
    const relation = termRelation(creation.entityType);
    if (relation) {
      if (byId("v2-term-landing").checked) {
        if (state.termLandingError) throw new Error(`Нельзя безопасно подключить посадочную: ${state.termLandingError}`);
        const [mode, externalId] = byId("v2-term-landing-mode").value.split(":");
        body.relatedTerm = { relationCode: relation.relationCode, entityType: relation.relatedEntityType, mode, ...(externalId ? { externalId } : {}) };
      } else body.relatedTerm = { relationCode: relation.relationCode, entityType: relation.relatedEntityType, mode: "none" };
    }
    const response = await api(`/api/targets/${encodeURIComponent(target.id)}/dictionary/terms/rules-v2`, { method: "POST", body });
    const value = response.result.dictionaryValue; const option = new Option(`${value.name} · ${value.externalId}`, value.id);
    creation.values.replaceChildren(option); creation.values.value = value.id;
    const related = response.result.relatedDictionaryValues?.[0];
    if (related && ![...document.querySelectorAll(".action-value")].some((select) => select.value === related.id)) {
      addTargetAction({ targetScope: relation.targetScope, mode: "add", dictionaryValueId: related.id, externalLabel: related.name });
    }
    state.previewSignature = null; byId("v2-term-dialog").close(); state.termCreation = null;
    toast(`Термин «${value.name}» создан и выбран. Теперь выполните полную проверку правила.`);
  } catch (cause) {
    failure.textContent = cause.message; failure.hidden = false;
  } finally { submit.disabled = false; }
}

function editImported(rule) {
  edit(rule);
  byId("rule-source").disabled = true; byId("rule-group").disabled = true;
  byId("preview-rule").disabled = true; byId("preview-rule").title = "Перенесённые зависимости проверяются общей сверкой v1/v2.";
  state.fixedDependency = !["classification_rule", "target_assignment_rule"].includes(rule.originKind);
  if (state.fixedDependency) { byId("multi-conditions").querySelectorAll("input, textarea, select, button").forEach((item) => { item.disabled = true; }); byId("rule-priority").disabled = true; }
  const parent = byId("multi-conditions").parentElement; parent.querySelectorAll(":scope > button").forEach((item) => { item.disabled = state.fixedDependency; });
  if (rule.originKind !== "target_assignment_rule") {
    byId("multi-actions").querySelectorAll(".action-scope, .action-mode, .action-primary-brand, button").forEach((item) => { item.disabled = true; });
    byId("multi-actions").parentElement.querySelectorAll(":scope > button").forEach((item) => { item.disabled = true; });
  }
}
function addReferenceAction(action) {
  const row = node("div", "rule-block"); row.dataset.referenceType = action.referenceType;
  row.append(node("p", "muted", "Результат совместимости: " + action.referenceType + ". Связанные назначения сайта используют это решение."));
  const status = node("select", "reference-status");
  for (const [value, text] of [["confirmed", "Сопоставить"], ...(state.selected?.originKind === "exact_mapping" ? [["ignored", "Игнорировать"]] : [])]) { const o = node("option", "", text); o.value = value; status.append(o); }
  status.value = action.resolutionStatus;
  const search = node("input"); search.type = "search"; search.placeholder = "Найти сопоставляемое значение";
  const values = node("select", "reference-value"); values.size = 4;
  if (action.referenceValueId) { const o = node("option", "", action.referenceValueName || action.referenceValueId); o.value = action.referenceValueId; values.append(o); values.value = action.referenceValueId; }
  let timer; let generation = 0;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(async () => { const request = ++generation; try {
    const data = await api("/api/classifier/reference-values?typeCode=" + encodeURIComponent(action.referenceType) + "&search=" + encodeURIComponent(search.value.trim()) + "&limit=30");
    if (request !== generation || !row.isConnected) return;
    const empty = node("option", "", "Выберите значение"); empty.value = ""; values.replaceChildren(empty, ...(data.items || []).map((item) => { const o = node("option", "", item.name); o.value = item.id; return o; }));
  } catch (cause) { error(cause.message); } }, 300); });
  const sync = () => { search.disabled = values.disabled = status.value === "ignored"; }; status.addEventListener("change", sync); sync();
  row.append(status, search, values); byId("multi-actions").append(row);
}

function initializeMultiEditor() {
  const blocks = document.querySelectorAll(".rule-editor-card > .rule-block");
  blocks[0].querySelector(".rule-condition-grid").hidden = true;
  blocks[1].querySelector(".rule-condition-grid").hidden = true;
  const groups = node("div"); groups.id = "multi-conditions"; blocks[0].append(groups, uiButton("+ Группа И", () => addConditionGroup()));
  const actions = node("div"); actions.id = "multi-actions"; blocks[1].append(actions, uiButton("+ Действие", () => addTargetAction()));
  renderConditions(); renderActions();
  const form = node("form", "rule-editor-actions"); const search = node("input"); search.type = "search"; search.placeholder = "Название, ID, условие или действие"; search.value = state.search; const submit = node("button", "button secondary", "Найти"); form.append(search, submit); byId("rules-list").before(form);
  let loading = false;
  async function load() { if (loading) return; loading = true; try { await loadRules(); } catch (cause) { error(cause.message); } finally { loading = false; } }
  form.addEventListener("submit", (event) => { event.preventDefault(); if (loading) return; state.search = search.value.trim(); state.offset = 0; void load(); });
  const pages = node("div", "rule-editor-actions"); const prev = uiButton("Назад", () => { if (!loading) { state.offset = Math.max(0, (state.offset || 0) - 100); void load(); } }); prev.id = "rules-prev";
  const next = uiButton("Далее", () => { if (!loading) { state.offset = (state.offset || 0) + 100; void load(); } }); next.id = "rules-next"; const current = node("span"); current.id = "rules-page"; pages.append(prev, current, next); byId("rules-list").after(pages);
}

async function initialize() { const [schema, targets] = await Promise.all([api("/api/data-schema"), api("/api/targets")]); state.schema = schema; state.targets = (targets.items || []).filter((target) => target.code === "slamdunk" || target.exporterCode === "wordpress"); if (!state.targets.length) state.targets = targets.items || []; if (!state.targets.length) throw new Error("Target не настроен"); const details = node("div", "rule-details"); details.id = "rule-details"; details.hidden = true; document.querySelector(".rule-editor-card > .rule-editor-grid").before(details); const sourceOptions = () => schema.donors.map((source) => { const option = node("option", "", source.name); option.value = source.id; return option; }); byId("rule-source").replaceChildren(...sourceOptions()); byId("workbench-source").replaceChildren(...sourceOptions()); fieldOptions(); initializeMultiEditor(); await Promise.all([loadRules(), loadWorkbench()]); byId("page-loading").hidden = true; byId("rules-workspace").hidden = false; }
async function session() { const data = await api("/api/auth/session"); if (!data.authenticated) { byId("login-view").hidden = false; return; } state.session = data; byId("operator-name").textContent = data.operator; byId("app-view").hidden = false; try { await initialize(); } catch (cause) { byId("page-loading").hidden = true; error(cause.message); } }
byId("login-form").addEventListener("submit", async (event) => { event.preventDefault(); try { await api("/api/auth/login", { method: "POST", body: { username: byId("login-username").value, password: byId("login-password").value } }); location.reload(); } catch { byId("login-error").textContent = "Неверные данные входа."; byId("login-error").hidden = false; } });
byId("v2-term-form").addEventListener("submit", createTermForRule);
for (const id of ["v2-term-close", "v2-term-cancel"]) byId(id).addEventListener("click", () => { byId("v2-term-dialog").close(); state.termCreation = null; });
byId("v2-term-landing").addEventListener("change", () => { byId("v2-term-landing-mode-field").hidden = !byId("v2-term-landing").checked; });
byId("v2-term-name").addEventListener("input", () => { byId("v2-term-slug").value = slugify(byId("v2-term-name").value); });
let parentSearchTimer;
byId("v2-term-parent-search").addEventListener("input", () => { clearTimeout(parentSearchTimer); parentSearchTimer = setTimeout(() => { const target = activeTarget(); if (target) loadTermParents(target.id, byId("v2-term-parent-search").value.trim()).catch((cause) => error(cause.message)); }, 250); });
byId("logout-button").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST", body: {} }); location.reload(); }); byId("new-rule").addEventListener("click", reset); byId("preview-rule").addEventListener("click", preview); byId("save-rule").addEventListener("click", save); byId("condition-operator").addEventListener("change", () => { byId("condition-value").disabled = byId("condition-operator").value === "absent"; }); byId("dictionary-search").addEventListener("input", () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(() => searchDictionary().catch((cause) => error(cause.message)), 250); }); byId("action-scope").addEventListener("change", () => searchDictionary().catch((cause) => error(cause.message))); byId("workbench-filters").addEventListener("submit", (event) => { event.preventDefault(); state.focusProductId = null; history.replaceState(null, "", "/rules-v2"); state.workbenchOffset = 0; void loadWorkbench(); }); byId("refresh-workbench").addEventListener("click", () => loadWorkbench()); byId("workbench-prev").addEventListener("click", () => { state.workbenchOffset = Math.max(0, state.workbenchOffset - 40); void loadWorkbench(); }); byId("workbench-next").addEventListener("click", () => { state.workbenchOffset += 40; void loadWorkbench(); }); await session();
