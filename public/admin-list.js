const byId = (id) => document.getElementById(id);
const mode = location.pathname.includes("operations")
  ? "operations"
  : location.pathname.includes("wordpress-snapshots")
    ? "snapshots"
    : location.pathname.includes("classifier-config")
      ? "classifierConfig"
      : "products";

const state = {
  session: null,
  offset: 0,
  limit: 50,
  total: 0,
  configItems: [],
  selectedConfig: null,
  targets: [],
};

function date(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? String(value)
    : new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(parsed);
}

function cell(row, value, className = "") {
  const td = document.createElement("td");
  td.className = className;
  if (value instanceof Node) td.append(value);
  else td.textContent = value ?? "-";
  row.append(td);
}

function button(label, className = "button quiet small-button") {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  return element;
}

function link(label, href, external = false) {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = label;
  if (external) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  return a;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.method && state.session?.csrfToken ? { "X-CSRF-Token": state.session.csrfToken } : {}),
    },
    ...options,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `Ошибка HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showLogin() {
  byId("app-view").hidden = true;
  byId("login-view").hidden = false;
}

function headings(values) {
  const tr = document.createElement("tr");
  for (const value of values) {
    const th = document.createElement("th");
    th.textContent = value;
    tr.append(th);
  }
  byId("table-head").replaceChildren(tr);
}

function status(value, context = "general") {
  return ({
    discovered: "Обнаружен",
    collected: "Собран",
    classification_pending: "Ожидает классификации",
    classified: "Классифицирован",
    complete: "Завершена",
    pending: context === "classification" ? "Не завершена" : "В очереди",
    running: "Выполняется",
    retry: "Ожидает повтора",
    not_processed: "Не запускалась",
    observed: "Найден в WordPress",
    synced: "Синхронизирован",
    failed: "Ошибка",
    not_exported: "Не выгружен",
  })[value] || value;
}

function renderProducts(items) {
  headings(["Источник / ID", "External ID", "Название", "Стадия", "Классификация", "Сбор", "Обработка", "WordPress"]);
  const body = byId("table-body");
  body.replaceChildren();
  for (const item of items) {
    const tr = document.createElement("tr");
    cell(tr, link(`${item.sourceCode} · ${item.sourceProductId}`, `/products/${item.sourceProductId}`));
    cell(tr, item.externalId);
    cell(tr, item.title || item.sourceKey, "admin-title-cell");
    cell(tr, status(item.stage));
    cell(tr, status(item.classificationStatus, "classification"));
    cell(tr, date(item.collectedAt));
    cell(tr, date(item.processedAt));
    const activeJob = item.targetStatus === "pending" && item.targetJobStatus ? ` · ${status(item.targetJobStatus)}` : "";
    cell(tr, `${status(item.targetStatus)}${activeJob}${item.targetExternalId ? ` · ${item.targetExternalId}` : ""}${item.hasTargetSnapshot ? " · снимок" : ""}`);
    body.append(tr);
  }
}

function renderOperations(items) {
  headings(["Код", "Название", "Версия", "Зависимости", "Источники"]);
  const body = byId("table-body");
  body.replaceChildren();
  for (const item of items) {
    const tr = document.createElement("tr");
    cell(tr, item.code);
    cell(tr, item.name);
    cell(tr, item.version);
    cell(tr, item.dependsOn.length ? item.dependsOn.join(", ") : "-");
    cell(tr, item.sourceCodes?.join(", ") || "Все");
    body.append(tr);
  }
}

function renderSnapshots(items) {
  headings(["WordPress ID", "GOAT ID", "Название", "Товар parser", "Получен", "Ссылки"]);
  const body = byId("table-body");
  body.replaceChildren();
  for (const item of items) {
    const tr = document.createElement("tr");
    cell(tr, item.externalId);
    cell(tr, item.sourceExternalId);
    cell(tr, item.title, "admin-title-cell");
    cell(tr, link(`#${item.sourceProductId}`, `/products/${item.sourceProductId}`));
    cell(tr, date(item.fetchedAt));
    const links = document.createElement("span");
    links.className = "compact-links";
    if (item.editUrl) links.append(link("Правка", item.editUrl, true));
    if (item.publicUrl) links.append(link("Сайт", item.publicUrl, true));
    cell(tr, links);
    body.append(tr);
  }
}

function configKind(value) {
  return ({
    mapping: "Точное",
    rule: "Правило",
    target_mapping: "Target",
    projection: "Projection",
  })[value] || value;
}

function configStatus(value) {
  return value === "active" ? "Активна" : value === "ignored" ? "Игнор" : "Отключена";
}

function textBlock(title, subtitle) {
  const box = document.createElement("div");
  box.className = "admin-title-cell";
  const strong = document.createElement("strong");
  strong.textContent = title || "-";
  box.append(strong);
  if (subtitle) {
    const small = document.createElement("small");
    small.textContent = subtitle;
    box.append(small);
  }
  return box;
}

function conditionText(conditions) {
  return (conditions || []).map((condition) => `${condition.field} ${condition.operator} ${condition.value}`).join("; ");
}

function renderConfig(items) {
  headings(["Тип", "Источник", "Что сопоставляет", "Результат", "Статус", "Товаров", "Обновлено"]);
  state.configItems = items;
  const body = byId("table-body");
  body.replaceChildren();
  for (const item of items) {
    const tr = document.createElement("tr");
    tr.className = `clickable-row${state.selectedConfig?.kind === item.kind && state.selectedConfig?.id === item.id ? " selected-row" : ""}`;
    tr.addEventListener("click", () => selectConfig(item));
    cell(tr, configKind(item.kind));
    cell(tr, [item.sourceCode, item.targetCode].filter(Boolean).join(" / ") || "-");
    const title = item.kind === "rule"
      ? item.ruleName
      : item.kind === "target_mapping"
        ? `${item.referenceName || "Reference"} -> ${item.targetScope || "target"}`
        : item.sourceValue || item.normalizedSourceValue || `#${item.id}`;
    const meta = item.kind === "rule"
      ? conditionText(item.conditions)
      : [item.typeName || item.typeCode, item.scope, item.normalizedSourceValue && item.normalizedSourceValue !== item.sourceValue ? `norm: ${item.normalizedSourceValue}` : ""].filter(Boolean).join(" · ");
    cell(tr, textBlock(title, meta));
    const target = [item.referenceName, item.targetLabel ? `${item.targetLabel} #${item.targetExternalId}` : "", item.targetTaxonomy].filter(Boolean).join(" · ");
    cell(tr, target || "-");
    const pill = document.createElement("span");
    pill.className = `config-pill ${item.status}`;
    pill.textContent = configStatus(item.status);
    cell(tr, pill);
    cell(tr, String(item.affectedProductCount ?? 0));
    cell(tr, date(item.updatedAt));
    body.append(tr);
  }
  if (state.selectedConfig) {
    const fresh = items.find((item) => item.kind === state.selectedConfig.kind && item.id === state.selectedConfig.id);
    if (fresh) state.selectedConfig = fresh;
  }
  renderConfigDetail();
}

function selectConfig(item) {
  state.selectedConfig = item;
  renderConfig(state.configItems);
}

function detailRow(parent, label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value ?? "-";
  parent.append(dt, dd);
}

function renderConfigDetail() {
  const shell = byId("config-shell");
  const panel = byId("config-detail");
  if (mode !== "classifierConfig") {
    shell.classList.remove("with-detail");
    panel.hidden = true;
    return;
  }
  const item = state.selectedConfig;
  if (!item) {
    shell.classList.remove("with-detail");
    panel.hidden = true;
    return;
  }
  shell.classList.add("with-detail");
  panel.hidden = false;
  const header = document.createElement("div");
  header.className = "config-detail-header";
  const titleWrap = document.createElement("div");
  const kind = document.createElement("span");
  kind.className = `config-pill ${item.status}`;
  kind.textContent = `${configKind(item.kind)} · ${configStatus(item.status)}`;
  const title = document.createElement("h3");
  title.textContent = item.ruleName || item.sourceValue || item.referenceName || `#${item.id}`;
  titleWrap.append(kind, title);
  const close = button("Закрыть");
  close.addEventListener("click", () => {
    state.selectedConfig = null;
    renderConfig(state.configItems);
  });
  header.append(titleWrap, close);

  const meta = document.createElement("dl");
  meta.className = "config-meta-grid";
  detailRow(meta, "ID", `#${item.id}, rev ${item.revision}`);
  detailRow(meta, "Источник", item.sourceCode);
  detailRow(meta, "Target", item.targetCode);
  detailRow(meta, "Тип", item.typeName || item.typeCode);
  detailRow(meta, "Scope", item.scope || item.targetScope);
  detailRow(meta, "Source value", item.sourceValue);
  detailRow(meta, "Normalized", item.normalizedSourceValue);
  detailRow(meta, "Reference", item.referenceName ? `${item.referenceName} #${item.referenceValueId}` : item.referenceValueId);
  detailRow(meta, "Target term", item.targetLabel ? `${item.targetLabel} #${item.targetExternalId}` : item.targetExternalId);
  detailRow(meta, "Taxonomy", item.targetTaxonomy);
  detailRow(meta, "Priority", item.priority === null ? null : String(item.priority));
  detailRow(meta, "Затронуто", `${item.affectedProductCount ?? 0} товаров`);
  detailRow(meta, "Автор", item.actor);
  detailRow(meta, "Обновлено", date(item.updatedAt));

  const actions = document.createElement("div");
  actions.className = "config-actions";
  if (item.kind === "mapping") {
    const edit = button("Редактировать сопоставление", "button primary small-button");
    edit.addEventListener("click", () => openMappingDialog(item));
    actions.append(edit);
  }
  if (item.kind === "rule") {
    const edit = button("Редактировать правило", "button primary small-button");
    edit.addEventListener("click", () => openRuleDialog(item));
    const toggle = button(item.status === "active" ? "Отключить" : "Включить");
    toggle.addEventListener("click", () => setRuleStatus(item));
    actions.append(edit, toggle);
  }
  if (item.kind === "mapping" || item.kind === "rule") {
    const projection = button("Добавить projection");
    projection.addEventListener("click", () => openProjectionDialog(item));
    actions.append(projection);
  }
  if (item.kind === "projection" && item.status === "active" && item.targetId) {
    const deactivate = button("Отключить projection", "button danger-quiet small-button");
    deactivate.addEventListener("click", () => deactivateProjection(item));
    actions.append(deactivate);
  }

  panel.replaceChildren(header, meta, actions);
  if (item.conditions?.length) panel.append(pre("Условия правила", item.conditions));
  if (Object.keys(item.context || {}).length) panel.append(pre("Контекст", item.context));
  if (item.reason) panel.append(pre("Причина", item.reason));
}

function pre(title, value) {
  const details = document.createElement("details");
  details.className = "data-details";
  details.open = true;
  const summary = document.createElement("summary");
  summary.textContent = title;
  const code = document.createElement("pre");
  code.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  details.append(summary, code);
  return details;
}

async function loadTargets() {
  if (state.targets.length) return state.targets;
  const response = await api("/api/targets");
  state.targets = response.items || [];
  return state.targets;
}

function activeTarget() {
  return state.targets.find((target) => target.dictionary?.configured) || state.targets[0] || null;
}

function capabilityFor(typeCode, target = activeTarget()) {
  return target?.dictionary?.classificationCapabilities?.find((capability) => capability.typeCode === typeCode) || null;
}

function dialogShell(titleText) {
  const dialog = document.createElement("dialog");
  dialog.className = "dialog";
  const form = document.createElement("form");
  form.method = "dialog";
  const header = document.createElement("div");
  header.className = "dialog-header";
  const title = document.createElement("h2");
  title.textContent = titleText;
  const close = button("Закрыть");
  close.addEventListener("click", () => dialog.close());
  header.append(title, close);
  form.append(header);
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  return { dialog, form };
}

function field(label, control) {
  const wrapper = document.createElement("label");
  wrapper.className = "field";
  const span = document.createElement("span");
  span.textContent = label;
  wrapper.append(span, control);
  return wrapper;
}

function input(value = "", type = "text") {
  const element = document.createElement("input");
  element.type = type;
  element.value = value ?? "";
  return element;
}

function textarea(value = "") {
  const element = document.createElement("textarea");
  element.value = value ?? "";
  element.rows = 8;
  element.style.width = "100%";
  element.style.border = "1px solid var(--line)";
  element.style.borderRadius = "11px";
  element.style.padding = "10px 12px";
  element.style.font = "12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace";
  return element;
}

async function openMappingDialog(item) {
  await loadTargets();
  const { dialog, form } = dialogShell("Редактировать точное сопоставление");
  const intro = document.createElement("p");
  intro.className = "dialog-intro";
  intro.textContent = `Перед сохранением будет изменено решение для ${item.affectedProductCount || 0} товаров. Изменение пойдёт через сервис решений и сохранит аудит.`;
  const modeSelect = document.createElement("select");
  modeSelect.append(new Option("Внутренний справочник", "internal"), new Option("WordPress term", "wordpress"), new Option("Игнорировать", "ignore"));
  const search = input(item.sourceValue || item.referenceName || "");
  const results = document.createElement("div");
  results.className = "mapping-results";
  let selected = null;
  let currentMode = "internal";

  async function runSearch() {
    selected = null;
    results.replaceChildren(document.createTextNode("Ищем..."));
    currentMode = modeSelect.value;
    try {
      if (currentMode === "ignore") {
        results.replaceChildren(document.createTextNode("Значение будет переведено в ignored. Target mapping не создаётся."));
        return;
      }
      let response;
      if (currentMode === "internal") {
        response = await api(`/api/classifier/reference-values?${new URLSearchParams({ typeCode: item.typeCode, search: search.value.trim(), limit: "50" })}`);
      } else {
        const target = activeTarget();
        const capability = capabilityFor(item.typeCode, target);
        if (!target || !capability) throw new Error("Для этого типа не настроен target dictionary");
        response = await api(`/api/targets/${target.id}/dictionary?${new URLSearchParams({ entityType: capability.entityType, search: search.value.trim(), limit: "50" })}`);
      }
      results.replaceChildren();
      for (const option of response.items || []) {
        const row = button("", "mapping-result");
        row.append(textBlock(option.name, currentMode === "wordpress" ? [option.taxonomy, option.slug, `term #${option.externalId}`].filter(Boolean).join(" · ") : option.code));
        row.addEventListener("click", () => {
          selected = option;
          for (const node of results.querySelectorAll(".mapping-result")) node.classList.remove("selected");
          row.classList.add("selected");
        });
        results.append(row);
      }
      if (!results.childElementCount) results.textContent = "Ничего не найдено.";
    } catch (error) {
      results.textContent = error.message;
    }
  }

  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const searchButton = button("Проверить", "button secondary");
  searchButton.addEventListener("click", runSearch);
  const save = button("Сохранить", "button primary");
  save.addEventListener("click", async () => {
    if (modeSelect.value !== "ignore" && !selected) {
      alert("Сначала выберите значение.");
      return;
    }
    const body = {
      sourceId: item.sourceId,
      typeCode: item.typeCode,
      scope: item.scope,
      normalizedSourceValue: item.normalizedSourceValue,
      contextKey: item.contextKey,
      action: modeSelect.value === "ignore" ? "ignore" : "confirm",
    };
    if (modeSelect.value === "internal") body.referenceValueId = selected.id;
    if (modeSelect.value === "wordpress") {
      const target = activeTarget();
      const capability = capabilityFor(item.typeCode, target);
      body.targetLink = { targetId: target.id, targetScope: capability.targetScope, dictionaryValueId: selected.id };
    }
    await api("/api/classifier/decisions", { method: "POST", body });
    dialog.close();
    await load();
  });
  actions.append(searchButton, save);
  form.append(intro, field("Режим", modeSelect), field("Поиск значения", search), results, actions);
  modeSelect.addEventListener("change", runSearch);
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch();
    }
  });
  dialog.showModal();
  await runSearch();
}

function parseConditions(value) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^([^ ]+)\s+(equals|contains|all_words|regex)\s+(.+)$/u.exec(line);
    if (!match) throw new Error(`Неверное условие: ${line}`);
    return { field: match[1], operator: match[2], value: match[3] };
  });
}

async function openRuleDialog(item) {
  const { dialog, form } = dialogShell("Редактировать правило");
  const name = input(item.ruleName || "");
  const priority = input(String(item.priority ?? 0), "number");
  const reference = input(item.referenceValueId || "");
  const conditions = textarea((item.conditions || []).map((condition) => `${condition.field} ${condition.operator} ${condition.value}`).join("\n"));
  const previewBox = document.createElement("div");
  previewBox.className = "rule-preview";
  previewBox.hidden = true;
  let preview = null;

  function draft() {
    return {
      sourceId: item.sourceId,
      typeCode: item.typeCode,
      name: name.value.trim(),
      priority: Number(priority.value),
      referenceValueId: reference.value.trim(),
      conditions: parseConditions(conditions.value),
    };
  }

  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const previewButton = button("Preview", "button secondary");
  previewButton.addEventListener("click", async () => {
    try {
      const response = await api("/api/classifier/rules/preview", { method: "POST", body: draft() });
      preview = response.preview;
      previewBox.hidden = false;
      previewBox.textContent = `Найдено товаров: ${preview.matchedProducts}. Будет изменено: ${preview.affectedProducts}. Конфликтов: ${preview.ambiguousObservations}. Перекрыто: ${preview.shadowedObservations}.`;
    } catch (error) {
      preview = null;
      previewBox.hidden = false;
      previewBox.textContent = error.message;
    }
  });
  const save = button("Сохранить", "button primary");
  save.addEventListener("click", async () => {
    if (!preview) {
      alert("Сначала выполните preview.");
      return;
    }
    await api(`/api/classifier/rules/${item.id}`, { method: "PATCH", body: draft() });
    dialog.close();
    await load();
  });
  actions.append(previewButton, save);
  form.append(
    field("Название", name),
    field("Priority", priority),
    field("Reference value ID", reference),
    field("Условия, по одному на строку: field operator value", conditions),
    previewBox,
    actions,
  );
  dialog.showModal();
}

async function openProjectionDialog(item) {
  await loadTargets();
  const target = activeTarget();
  if (!target) {
    alert("Target не настроен.");
    return;
  }
  const { dialog, form } = dialogShell("Добавить projection");
  const scope = document.createElement("select");
  for (const capability of target.dictionary?.classificationCapabilities || []) {
    scope.append(new Option(`${capability.targetScope} · ${capability.entityType}`, capability.targetScope));
  }
  const search = input(item.sourceValue || item.referenceName || "");
  const results = document.createElement("div");
  results.className = "mapping-results";
  const previewBox = document.createElement("div");
  previewBox.className = "rule-preview";
  previewBox.hidden = true;
  let selected = null;
  let preview = null;

  function entityType() {
    return (target.dictionary?.classificationCapabilities || []).find((capability) => capability.targetScope === scope.value)?.entityType;
  }
  function projectionBody() {
    return {
      targetId: target.id,
      resolutionKind: item.kind === "rule" ? "rule" : "mapping",
      resolutionId: item.id,
      targetScope: scope.value,
      dictionaryValueId: selected.id,
    };
  }
  async function runSearch() {
    selected = null;
    preview = null;
    previewBox.hidden = true;
    const response = await api(`/api/targets/${target.id}/dictionary?${new URLSearchParams({ entityType: entityType(), search: search.value.trim(), limit: "50" })}`);
    results.replaceChildren();
    for (const option of response.items || []) {
      const row = button("", "mapping-result");
      row.append(textBlock(option.name, [option.taxonomy, option.slug, `term #${option.externalId}`].filter(Boolean).join(" · ")));
      row.addEventListener("click", () => {
        selected = option;
        for (const node of results.querySelectorAll(".mapping-result")) node.classList.remove("selected");
        row.classList.add("selected");
      });
      results.append(row);
    }
  }
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const searchButton = button("Искать", "button secondary");
  searchButton.addEventListener("click", runSearch);
  const previewButton = button("Preview", "button secondary");
  previewButton.addEventListener("click", async () => {
    if (!selected) {
      alert("Сначала выберите term.");
      return;
    }
    const response = await api("/api/classifier/projections/preview", { method: "POST", body: projectionBody() });
    preview = response.preview;
    previewBox.hidden = false;
    previewBox.textContent = `Товаров: ${preview.productCount}. Observations: ${preview.observationCount}. Дубль: ${preview.duplicate ? "да" : "нет"}. Конфликтов: ${preview.cardinalityConflicts?.length || 0}.`;
  });
  const save = button("Сохранить", "button primary");
  save.addEventListener("click", async () => {
    if (!preview) {
      alert("Сначала выполните preview.");
      return;
    }
    await api("/api/classifier/projections", { method: "POST", body: projectionBody() });
    dialog.close();
    await load();
  });
  actions.append(searchButton, previewButton, save);
  form.append(field("Target taxonomy", scope), field("Поиск term", search), results, previewBox, actions);
  scope.addEventListener("change", runSearch);
  dialog.showModal();
  await runSearch();
}

async function setRuleStatus(item) {
  const action = item.status === "active" ? "deactivate" : "reactivate";
  const result = await api(`/api/classifier/rules/${item.id}/${action}`, { method: "POST", body: {} });
  alert(`Готово. На обработку поставлено товаров: ${result.rule.affectedProductCount}`);
  await load();
}

async function deactivateProjection(item) {
  const result = await api(`/api/targets/${item.targetId}/classification-projections/${item.id}/deactivate`, { method: "POST", body: {} });
  alert(`Готово. На обработку поставлено товаров: ${result.projection.affectedProductCount}`);
  await load();
}

function configure() {
  const titles = {
    products: "Товары",
    operations: "Реестр операций",
    snapshots: "Снимки WordPress",
    classifierConfig: "Настройки классификации",
  };
  byId("page-title").textContent = titles[mode];
  document.title = `SLDS · ${titles[mode]}`;
  const activePath = mode === "snapshots" ? "/wordpress-snapshots" : mode === "classifierConfig" ? "/classifier-config" : `/${mode}`;
  for (const item of document.querySelectorAll(".admin-nav a")) {
    if (item.getAttribute("href") === activePath) {
      item.classList.add("active");
      item.setAttribute("aria-current", "page");
    }
  }
  if (mode === "operations") byId("filters").hidden = true;
  if (mode === "snapshots") for (const id of ["source-filter", "stage-filter", "classification-filter", "target-filter"]) byId(id).hidden = true;
  if (mode === "classifierConfig") {
    byId("search").placeholder = "source value, target term, context или правило";
    byId("source-filter").querySelector("span").textContent = "Источник";
    byId("stage-filter").querySelector("span").textContent = "Сущность";
    byId("stage").replaceChildren(
      new Option("Все", ""),
      new Option("Точные", "mapping"),
      new Option("Правила", "rule"),
      new Option("Target mappings", "target_mapping"),
      new Option("Projections", "projection"),
    );
    byId("classification-filter").querySelector("span").textContent = "Тип";
    byId("classification").replaceChildren(new Option("Все", ""));
    byId("target-filter").querySelector("span").textContent = "Статус";
    byId("target-status").replaceChildren(new Option("Все", ""), new Option("Активна", "active"), new Option("Отключена", "inactive"), new Option("Игнор", "ignored"));
  }
}

async function load() {
  byId("loading").hidden = false;
  byId("error").hidden = true;
  byId("empty").hidden = true;
  byId("table-section").hidden = true;
  try {
    let data;
    if (mode === "operations") {
      data = await api("/api/operations");
    } else {
      const params = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
      const search = byId("search").value.trim();
      if (search) params.set("search", search);
      if (mode === "products") {
        for (const [id, key] of [["source", "source"], ["stage", "stage"], ["classification", "classification"], ["target-status", "targetStatus"]]) {
          const value = byId(id).value;
          if (value) params.set(key, value);
        }
        data = await api(`/api/products?${params}`);
        if (byId("source").options.length === 1) for (const source of data.sources) byId("source").append(new Option(source.name, source.code));
      } else if (mode === "classifierConfig") {
        for (const [id, key] of [["source", "sourceId"], ["stage", "kind"], ["classification", "typeCode"], ["target-status", "status"]]) {
          const value = byId(id).value;
          if (value) params.set(key, value);
        }
        data = await api(`/api/classifier/configuration?${params}`);
        if (byId("source").options.length === 1) for (const source of data.sources || []) byId("source").append(new Option(`${source.name} · ${source.code}`, source.id));
        if (byId("classification").options.length === 1) for (const type of data.types || []) byId("classification").append(new Option(type.name, type.code));
      } else {
        data = await api(`/api/wordpress-snapshots?${params}`);
      }
    }
    const items = data.items || [];
    state.total = data.total ?? items.length;
    if (mode === "products") renderProducts(items);
    else if (mode === "operations") renderOperations(items);
    else if (mode === "classifierConfig") renderConfig(items);
    else renderSnapshots(items);
    byId("empty").hidden = items.length !== 0;
    byId("table-section").hidden = items.length === 0;
    byId("page-info").textContent = state.total ? `${state.offset + 1}-${Math.min(state.offset + items.length, state.total)} из ${state.total}` : "0";
    byId("prev").disabled = state.offset === 0;
    byId("next").disabled = state.offset + items.length >= state.total;
  } catch (error) {
    if (error.status === 401) return showLogin();
    byId("error").textContent = error.message;
    byId("error").hidden = false;
  } finally {
    byId("loading").hidden = true;
  }
}

byId("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    state.session = await api("/api/auth/login", { method: "POST", body: { username: byId("login-username").value, password: byId("login-password").value } });
    byId("login-view").hidden = true;
    byId("app-view").hidden = false;
    byId("operator-name").textContent = state.session.operator;
    await load();
  } catch (error) {
    byId("login-error").textContent = error.message;
    byId("login-error").hidden = false;
  }
});
byId("logout-button").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch {}
  state.session = null;
  showLogin();
});
byId("filters").addEventListener("submit", (event) => {
  event.preventDefault();
  state.offset = 0;
  state.selectedConfig = null;
  load();
});
byId("prev").addEventListener("click", () => {
  state.offset = Math.max(0, state.offset - state.limit);
  load();
});
byId("next").addEventListener("click", () => {
  state.offset += state.limit;
  load();
});

configure();
api("/api/auth/session").then((session) => {
  if (!session.authenticated) return showLogin();
  state.session = session;
  byId("app-view").hidden = false;
  byId("operator-name").textContent = session.operator;
  load();
}).catch((error) => {
  byId("error").textContent = error.message;
  byId("error").hidden = false;
});
