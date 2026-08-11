const byId = (id) => document.getElementById(id);

const state = {
  session: null,
  targetId: null,
  items: [],
  cursor: null,
  selected: new Set(),
  pendingExport: null,
};

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

function date(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? String(value) : new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(parsed);
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function badge(text, kind = "neutral") {
  return element("span", `export-badge ${kind}`, text);
}

function statusLabel(value) {
  return ({ checking: "Проверяется", ready: "Готов", blocked: "Заблокирован", error: "Ошибка", stale: "Нужно перепроверить" })[value] || value;
}

function jobLabel(value) {
  return ({ pending: "В очереди", retry: "Ждёт повтора", running: "Выполняется", completed: "Завершён", failed: "Ошибка" })[value] || value;
}

function currentFilter() {
  return {
    ...(byId("status").value ? { status: byId("status").value } : {}),
    ...(byId("operation").value ? { operation: byId("operation").value } : {}),
    ...(byId("risk").value ? { riskLevel: byId("risk").value } : {}),
    ...(byId("change").value ? { changeFlag: byId("change").value } : {}),
    ...(byId("search").value.trim() ? { search: byId("search").value.trim() } : {}),
  };
}

function showMessage(text, kind = "") {
  const box = byId("message");
  box.textContent = text;
  box.className = `inline-message ${kind}`.trim();
  box.hidden = false;
}

function updateSelection() {
  byId("selected-count").textContent = String(state.selected.size);
  byId("refresh-selected").disabled = state.selected.size === 0;
  for (const checkbox of document.querySelectorAll("[data-export-checkbox]")) {
    checkbox.checked = state.selected.has(checkbox.dataset.exportCheckbox);
  }
}

function changeChips(item) {
  const chips = [];
  if (item.willCreate) chips.push(badge("Новый товар", "review"));
  if (item.fieldChangeCount) chips.push(badge(`${item.fieldChangeCount} полей`, "change"));
  if (item.taxonomyAddedCount) chips.push(badge(`+${item.taxonomyAddedCount} терминов`, "add"));
  if (item.taxonomyRemovedCount) chips.push(badge(`−${item.taxonomyRemovedCount} терминов`, "danger"));
  if (item.imageChangeCount) chips.push(badge(`${item.imageChangeCount} фото`, "change"));
  if (item.variationChangeCount) chips.push(badge(`${item.variationChangeCount} вариаций`, item.deactivatedVariationCount ? "danger" : "change"));
  if (item.changeFlags.includes("no_changes")) chips.push(badge("Без изменений", "safe"));
  return chips;
}

const taxonomyLabels = {
  product_tag: "Метки",
  product_cat: "Категории",
  pa_brand: "Бренды",
  pa_model: "Модели",
  pa_tsvet: "Цвета",
  pa_material: "Материалы",
  pa_vid: "Виды спорта",
  pa_shoe_height: "Высота обуви",
  pa_season: "Сезоны",
};

function taxonomyDetails(summary) {
  const rows = Array.isArray(summary?.taxonomies) ? summary.taxonomies : [];
  const box = element("div", "export-change-details");
  for (const row of rows) {
    const added = Array.isArray(row.added) ? row.added.map((item) => item.name).filter(Boolean) : [];
    if (!added.length) continue;
    const line = element("p", "");
    line.append(element("strong", "", taxonomyLabels[row.taxonomy] || row.taxonomy));
    line.append(document.createTextNode(` · добавятся: ${added.join(", ")}`));
    box.append(line);
  }
  return box;
}

function deletionDetails(item) {
  const summary = item.changeSummary || {};
  const taxonomyRows = Array.isArray(summary.taxonomies) ? summary.taxonomies : [];
  const removedTaxonomies = taxonomyRows.flatMap((row) => {
    const terms = Array.isArray(row.removed) ? row.removed.map((term) => term.name).filter(Boolean) : [];
    return terms.length ? [{ label: taxonomyLabels[row.taxonomy] || row.taxonomy, values: terms }] : [];
  });
  const variations = summary.variations || {};
  const deactivatedItems = Array.isArray(variations.deactivatedItems) ? variations.deactivatedItems : [];
  const images = summary.images || {};
  const removedImages = Array.isArray(images.removedItems) ? images.removedItems : [];
  const hasDanger = removedTaxonomies.length || Number(variations.deactivated || 0) || Number(images.removed || 0);
  if (!hasDanger) return null;

  const box = element("section", "export-deletion-details");
  box.append(element("strong", "export-deletion-title", "Опасные изменения при экспорте"));
  for (const row of removedTaxonomies) {
    const line = element("p", "");
    line.append(element("strong", "", `Снимутся ${row.label.toLowerCase()}: `), document.createTextNode(row.values.join(", ")));
    box.append(line);
  }
  if (Number(variations.deactivated || 0) > 0) {
    const labels = deactivatedItems.map((variation) => variation.label || variation.size).filter(Boolean);
    const line = element("p", "");
    line.append(element("strong", "", "Отключатся размеры: "));
    line.append(document.createTextNode(labels.length ? labels.join(", ") : `${variations.deactivated} — перепроверьте товар для точного списка`));
    box.append(line);
  }
  if (Number(images.removed || 0) > 0) {
    const row = element("div", "export-deletion-images");
    row.append(element("strong", "", "Удалятся фото:"));
    if (removedImages.length) {
      for (const removed of removedImages) {
        const itemBox = element("span", "export-deletion-image");
        if (removed.url) {
          const image = document.createElement("img");
          image.src = removed.url;
          image.alt = `Удаляемое фото ${removed.position || ""}`.trim();
          image.loading = "lazy";
          itemBox.append(image);
        }
        itemBox.append(element("span", "", removed.position ? `Фото ${removed.position}` : "Фото"));
        row.append(itemBox);
      }
    } else {
      row.append(element("span", "", `${images.removed} — перепроверьте товар для точного списка`));
    }
    box.append(row);
  }
  return box;
}

function renderCard(item) {
  const card = element("article", `export-card risk-${item.riskLevel}`);
  const select = document.createElement("input");
  select.type = "checkbox";
  select.dataset.exportCheckbox = item.sourceProductId;
  select.checked = state.selected.has(item.sourceProductId);
  select.addEventListener("change", () => {
    if (select.checked) state.selected.add(item.sourceProductId);
    else state.selected.delete(item.sourceProductId);
    updateSelection();
  });
  const media = element("div", "export-card-media");
  if (item.imageUrl) {
    const image = document.createElement("img");
    image.src = item.imageUrl;
    image.alt = "";
    image.loading = "lazy";
    media.append(image);
  } else media.append(element("span", "muted", "Нет фото"));
  const main = element("div", "export-card-main");
  const heading = element("div", "export-card-heading");
  const titleBox = element("div", "");
  const title = document.createElement("a");
  title.href = `/products/${item.sourceProductId}`;
  title.className = "export-card-title";
  title.textContent = item.title;
  titleBox.append(title, element("p", "muted", `${item.sourceCode} · товар ${item.sourceProductId} · external ${item.sourceExternalId || "—"}`));
  const statuses = element("div", "export-card-statuses");
  statuses.append(badge(statusLabel(item.status), item.status === "ready" ? "safe" : item.status === "blocked" || item.status === "error" ? "danger" : "review"));
  if (item.riskLevel === "danger") statuses.append(badge("Опасные изменения", "danger"));
  else if (item.riskLevel === "review") statuses.append(badge("Нужен просмотр", "review"));
  heading.append(titleBox, statuses);
  const identity = element("div", "export-identity");
  if (item.willCreate === true) {
    identity.append(element("strong", "danger-text", "WordPress-товар не найден"), element("span", "muted", `Проверена identity источника ${item.sourceExternalId || "без external ID"}; перед записью поиск повторится.`));
  } else if (item.externalId) {
    identity.append(element("strong", "", `WordPress #${item.externalId}`), element("span", "muted", `Совпадение: ${item.matchedBy || "не указано"}`));
  } else identity.append(element("span", "muted", "WordPress identity ещё не проверена"));
  const chips = element("div", "export-change-chips");
  chips.append(...changeChips(item));
  main.append(heading, identity, chips, taxonomyDetails(item.changeSummary));
  const deletions = deletionDetails(item);
  if (deletions) main.append(deletions);
  if (item.blockers?.length) {
    const blockers = element("ul", "export-blockers");
    for (const blocker of item.blockers) blockers.append(element("li", "", blocker.message || blocker.code || String(blocker)));
    main.append(blockers);
  }
  if (item.error) main.append(element("p", "form-error", item.error));
  const footer = element("div", "export-card-footer");
  const meta = element("div", "muted", `Проверен ${date(item.checkedAt)}`);
  if (item.lastExportJob) meta.append(document.createTextNode(` · экспорт ${jobLabel(item.lastExportJob.status)}${item.lastExportJob.lastError ? `: ${item.lastExportJob.lastError}` : ""}`));
  const actions = element("div", "runtime-actions");
  const refresh = element("button", "button quiet small-button", "Перепроверить");
  refresh.type = "button";
  refresh.addEventListener("click", () => enqueuePreflight([item.sourceProductId]));
  const open = document.createElement("a");
  open.className = "button quiet small-button";
  open.href = `/products/${item.sourceProductId}`;
  open.textContent = "Полный diff";
  actions.append(refresh, open);
  if (item.status === "ready") {
    const exportButton = element("button", "button primary small-button", "Экспортировать");
    exportButton.type = "button";
    exportButton.addEventListener("click", () => previewExport([item.sourceProductId]));
    actions.append(exportButton);
  }
  footer.append(meta, actions);
  card.append(select, media, main, footer);
  return card;
}

function render(reset) {
  const cards = byId("cards");
  if (reset) cards.replaceChildren();
  for (const item of state.items) cards.append(renderCard(item));
  byId("empty").hidden = cards.children.length !== 0;
  byId("load-more").hidden = state.cursor === null;
  updateSelection();
}

async function load(reset = true) {
  if (!state.targetId) return;
  if (reset) {
    state.cursor = null;
    state.items = [];
    byId("cards").replaceChildren();
  }
  byId("loading").hidden = false;
  byId("error").hidden = true;
  try {
    const params = new URLSearchParams({ targetId: state.targetId, limit: "50" });
    const filter = currentFilter();
    for (const [key, value] of Object.entries(filter)) params.set(key === "riskLevel" ? "risk" : key === "changeFlag" ? "change" : key, value);
    if (state.cursor) {
      params.set("cursorAt", state.cursor.checkedAt);
      params.set("cursorId", state.cursor.id);
    }
    const result = await api(`/api/export-control?${params}`);
    const items = result.items || [];
    state.items = reset ? items : [...state.items, ...items];
    state.cursor = result.nextCursor;
    render(true);
  } catch (error) {
    if (error.status === 401) return showLogin();
    byId("error").textContent = error.message;
    byId("error").hidden = false;
  } finally {
    byId("loading").hidden = true;
  }
}

async function enqueuePreflight(sourceProductIds) {
  try {
    const result = await api("/api/export-control/preflights", { method: "POST", body: {
      targetId: state.targetId,
      ...(sourceProductIds?.length ? { sourceProductIds } : { limit: Number(byId("preflight-limit").value) }),
    } });
    showMessage(`Поставлено товаров на обновление цены, наличия и preflight: ${result.result.queuedCount}. Результаты будут появляться по мере обработки.`, "success");
    if (sourceProductIds?.length) state.selected.clear();
    await load(true);
    await loadBatches();
  } catch (error) { showMessage(error.message, "error"); }
}

async function previewExport(sourceProductIds) {
  try {
    const body = { targetId: state.targetId, ...(sourceProductIds?.length ? { sourceProductIds } : { filter: currentFilter() }) };
    const result = await api("/api/export-control/export/preview", { method: "POST", body });
    const preview = result.preview;
    const summary = byId("export-preview-summary");
    summary.replaceChildren(
      element("p", "", `Готово к постановке: ${preview.eligibleCount}`),
      element("p", "", `Создание: ${preview.creates} · обновление: ${preview.updates}`),
      element("p", preview.risks.danger ? "danger-text" : "muted", `С удалениями: ${preview.risks.danger} · требуют просмотра: ${preview.risks.review}`),
    );
    if (preview.truncated) summary.append(element("p", "form-error", `Выбрано больше ${preview.maximumBatchSize}; сузьте фильтр.`));
    byId("confirm-export").disabled = preview.eligibleCount === 0 || preview.truncated;
    state.pendingExport = body;
    byId("export-dialog").showModal();
  } catch (error) { showMessage(error.message, "error"); }
}

async function applyExport() {
  if (!state.pendingExport) return;
  const button = byId("confirm-export");
  button.disabled = true;
  try {
    const result = await api("/api/export-control/export", { method: "POST", body: {
      ...state.pendingExport,
      ...(byId("export-reason").value.trim() ? { reason: byId("export-reason").value.trim() } : {}),
    } });
    byId("export-dialog").close();
    showMessage(`Партия #${result.result.batchId}: поставлено экспортов ${result.result.queuedCount}.`, "success");
    state.selected.clear();
    await Promise.all([load(true), loadBatches()]);
  } catch (error) { showMessage(error.message, "error"); }
  finally { button.disabled = false; }
}

async function loadBatches() {
  if (!state.targetId) return;
  try {
    const result = await api(`/api/export-control/batches?targetId=${encodeURIComponent(state.targetId)}&limit=20`);
    const box = byId("batches");
    box.replaceChildren();
    for (const batch of result.items || []) {
      const row = element("div", "export-batch-row");
      row.append(
        element("strong", "", `Партия #${batch.id}`),
        element("span", "muted", `${date(batch.createdAt)} · ${batch.actor}`),
        element("span", "", `${batch.itemCount} товаров`),
        element("span", "", `очередь ${batch.pendingCount} · работа ${batch.runningCount} · готово ${batch.completedCount} · ошибки ${batch.failedCount}`),
      );
      box.append(row);
    }
    if (!box.children.length) box.append(element("p", "muted", "Партии ещё не запускались."));
  } catch (error) { byId("batches").replaceChildren(element("p", "form-error", error.message)); }
}

async function initialize() {
  const targets = await api("/api/targets");
  const target = targets.items.find((item) => item.code === "slamdunk") || targets.items[0];
  if (!target) throw new Error("Target не настроен");
  for (const item of targets.items) byId("target").append(new Option(`${item.name}${item.enabled ? "" : " · автоэкспорт выключен"}`, item.id));
  byId("target").value = target.id;
  state.targetId = target.id;
  await Promise.all([load(true), loadBatches()]);
}

byId("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    state.session = await api("/api/auth/login", { method: "POST", body: { username: byId("login-username").value, password: byId("login-password").value } });
    byId("login-view").hidden = true;
    byId("app-view").hidden = false;
    byId("operator-name").textContent = state.session.operator;
    await initialize();
  } catch (error) { byId("login-error").textContent = error.message; byId("login-error").hidden = false; }
});
byId("logout-button").addEventListener("click", async () => { try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch {} state.session = null; showLogin(); });
byId("filters").addEventListener("submit", (event) => { event.preventDefault(); load(true); });
byId("target").addEventListener("change", () => { state.targetId = byId("target").value; state.selected.clear(); Promise.all([load(true), loadBatches()]); });
byId("refresh").addEventListener("click", () => Promise.all([load(true), loadBatches()]));
byId("refresh-batches").addEventListener("click", loadBatches);
byId("check-next").addEventListener("click", () => enqueuePreflight());
byId("refresh-selected").addEventListener("click", () => enqueuePreflight([...state.selected]));
byId("select-page").addEventListener("click", () => { for (const item of state.items) state.selected.add(item.sourceProductId); updateSelection(); });
byId("clear-selection").addEventListener("click", () => { state.selected.clear(); updateSelection(); });
byId("preview-export").addEventListener("click", () => previewExport(state.selected.size ? [...state.selected] : undefined));
byId("confirm-export").addEventListener("click", applyExport);
byId("load-more").addEventListener("click", () => load(false));

api("/api/auth/session").then(async (session) => {
  if (!session.authenticated) return showLogin();
  state.session = session;
  byId("app-view").hidden = false;
  byId("operator-name").textContent = session.operator;
  await initialize();
}).catch((error) => { byId("error").textContent = error.message; byId("error").hidden = false; });
