import { suggestRuleConditions } from "/assets/classifier-rule-suggestions.js";

const byId = (id) => document.getElementById(id);

const state = {
  session: null,
  csrfToken: null,
  queue: [],
  queueTotal: 0,
  queueOffset: 0,
  queueHasMore: false,
  queueLoading: false,
  queueLoadError: null,
  queueRequestId: 0,
  selected: null,
  targets: [],
  mappingMode: "wordpress",
  mappingResults: [],
  selectedMapping: null,
  decisionPreview: null,
  currentReferenceId: null,
  currentResolution: null,
  resolved: false,
  rulePreview: null,
  projectionResults: [],
  selectedProjectionTerm: null,
  projectionPreview: null,
  typeNames: new Map(),
  queueSourceId: null,
  queueContextKey: null,
  pendingQueueSelection: null,
  selectedExamplesRequest: 0,
  classificationView: "queue",
  configMeta: { sources: [], types: [] },
  references: [],
  referenceTotal: 0,
  referenceOffset: 0,
  selectedReference: null,
  rules: [],
  ruleTotal: 0,
  ruleOffset: 0,
  editingRule: null,
  ruleEditorContext: null,
  ruleEditorFields: ["sourceValue", "scope", "subjectKind"],
  wordpressValues: [],
  wordpressOffset: 0,
  assignmentReference: null,
  assignmentTerm: null,
  assignmentPreview: null,
  assignmentMode: "additional",
  assignmentOutput: null,
  pendingReferenceId: null,
  pendingRuleId: null,
  pendingReferenceAction: null,
  reviewProductsItem: null,
  reviewProducts: [],
  reviewProductsOffset: 0,
  reviewProductsTotal: 0,
  reviewProductsRequestId: 0,
  ruleFieldsRequestId: 0,
};

function applyQueueDeepLink() {
  const params = new URLSearchParams(location.search);
  if ((params.get("view") && params.get("view") !== "queue") || location.pathname.includes("classifier-config")) return;
  const typeCode = params.get("typeCode") || "";
  const status = params.get("status") || "";
  const search = params.get("search") || "";
  const contextKey = params.get("contextKey") || "";
  const sourceId = params.get("sourceId") || "";
  if (!typeCode && !search && !contextKey) return;
  byId("queue-search").value = search;
  if (typeCode) {
    const select = byId("type-filter");
    if (![...select.options].some((option) => option.value === typeCode)) select.append(new Option(typeCode, typeCode));
    select.value = typeCode;
  }
  if (["unresolved", "ambiguous", "waiting_apply"].includes(status)) byId("status-filter").value = status;
  state.queueSourceId = sourceId || null;
  state.queueContextKey = contextKey || null;
  state.pendingQueueSelection = { typeCode, status, search, contextKey };
}

function clearQueueDeepLink() {
  state.queueSourceId = null;
  state.queueContextKey = null;
  state.pendingQueueSelection = null;
}

function typeName(itemOrCode) {
  if (typeof itemOrCode === "object" && itemOrCode !== null) {
    return itemOrCode.typeName || state.typeNames.get(itemOrCode.typeCode) || itemOrCode.typeCode;
  }
  return state.typeNames.get(itemOrCode) || itemOrCode;
}

let toastTimer;
let queueSearchTimer;
let mappingSearchTimer;
let projectionSearchTimer;
let catalogSearchTimer;
let reviewProductsSearchTimer;
const queuePageSize = 200;
const reviewProductsPageSize = 50;

function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function clearError(element) {
  element.textContent = "";
  element.hidden = true;
}

async function api(url, options = {}) {
  const method = options.method ?? "GET";
  const headers = { Accept: "application/json", ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && method !== "HEAD" && state.csrfToken) headers["X-CSRF-Token"] = state.csrfToken;
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !url.endsWith("/api/auth/login")) {
    state.session = null;
    state.csrfToken = null;
    showLogin();
  }
  if (!response.ok) {
    const error = new Error(data.message || humanError(data.error) || `Ошибка HTTP ${response.status}`);
    error.code = data.error;
    error.status = response.status;
    throw error;
  }
  return data;
}

function humanError(code) {
  const messages = {
    invalid_credentials: "Неверный пользователь или пароль.",
    invalid_wordpress_create_credentials: "Неверный пароль на создание записей WordPress.",
    wordpress_create_permission_required: "Нужно отдельное разрешение на создание записей WordPress.",
    csrf_failed: "Сессия устарела. Обновите страницу и повторите действие.",
    internal_error: "Внутренняя ошибка. Подробности сохранены в журнале сервера.",
  };
  return messages[code] ?? code;
}

function showLogin() {
  byId("app-view").hidden = true;
  byId("login-view").hidden = false;
  byId("login-password").value = "";
  byId("login-username").focus();
}

function showApp() {
  byId("login-view").hidden = true;
  byId("app-view").hidden = false;
  byId("operator-name").textContent = state.session.operator;
}

async function restoreSession() {
  const session = await api("/api/auth/session");
  if (!session.authenticated) {
    showLogin();
    return;
  }
  state.session = session;
  state.csrfToken = session.csrfToken;
  showApp();
  await loadDashboard();
}

async function login(event) {
  event.preventDefault();
  const error = byId("login-error");
  clearError(error);
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const session = await api("/api/auth/login", {
      method: "POST",
      body: {
        username: byId("login-username").value,
        password: byId("login-password").value,
      },
    });
    state.session = { ...session, wordpressCreateAllowed: false };
    state.csrfToken = session.csrfToken;
    showApp();
    await loadDashboard();
  } catch (requestError) {
    showError(error, requestError.message);
  } finally {
    submit.disabled = false;
  }
}

async function logout() {
  try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch { /* Cookie still gets cleared on a valid session. */ }
  state.session = null;
  state.csrfToken = null;
  showLogin();
}

async function loadDashboard() {
  byId("queue-list").replaceChildren(loading("Загружаем очередь…"));
  const [targets] = await Promise.all([loadTargets(), loadQueue(), loadClassificationMetadata()]);
  populateCatalogFilters();
  if (state.pendingQueueSelection) {
    const requested = state.pendingQueueSelection;
    const item = state.queue.find((entry) =>
      (!requested.typeCode || entry.typeCode === requested.typeCode)
      && (!requested.status || entry.status === requested.status)
      && (!requested.contextKey || entry.contextKey === requested.contextKey));
    state.pendingQueueSelection = null;
    if (item) selectQueueItem(item);
  }
  const routeParams = new URLSearchParams(location.search);
  state.pendingReferenceId = routeParams.get("referenceId");
  state.pendingRuleId = routeParams.get("ruleId") || (location.pathname.includes("classifier-config") && routeParams.get("kind") === "rule" ? routeParams.get("configId") : null);
  state.pendingReferenceAction = routeParams.get("action");
  if (routeParams.get("search") && (routeParams.get("view") === "references" || location.pathname.includes("classifier-config"))) byId("reference-search").value = routeParams.get("search");
  const requestedView = location.pathname.includes("classifier-config")
    ? (new URLSearchParams(location.search).get("kind") === "rule" ? "rules" : "references")
    : new URLSearchParams(location.search).get("view") || "queue";
  await switchClassificationView(["queue", "references", "rules", "wordpress"].includes(requestedView) ? requestedView : "queue", false);
  return targets;
}

async function loadClassificationMetadata() {
  const response = await api("/api/classifier/configuration?kind=rule&usage=none&limit=1&offset=0");
  state.configMeta = { sources: response.sources ?? [], types: response.types ?? [] };
  for (const type of state.configMeta.types) state.typeNames.set(type.code, type.name);
  populateCatalogFilters();
}

async function loadTargets() {
  const response = await api("/api/targets");
  state.targets = response.items ?? [];
  const configured = state.targets.some((target) => target.dictionary?.configured);
  byId("sync-button").hidden = !configured;
  return state.targets;
}

function queueUrl(offset = 0) {
  const parameters = new URLSearchParams({ limit: String(queuePageSize), offset: String(offset) });
  const search = byId("queue-search").value.trim();
  const type = byId("type-filter").value;
  const status = byId("status-filter").value;
  if (search) parameters.set("search", search);
  if (type) parameters.set("typeCode", type);
  if (status) parameters.set("status", status);
  if (state.queueSourceId) parameters.set("sourceId", state.queueSourceId);
  if (state.queueContextKey) parameters.set("contextKey", state.queueContextKey);
  return `/api/classifier/queue?${parameters}`;
}

async function loadQueue({ preserveSelection = false } = {}) {
  const requestId = ++state.queueRequestId;
  const list = byId("queue-list");
  state.queueLoading = true;
  state.queueLoadError = null;
  state.queueHasMore = false;
  state.queueOffset = 0;
  list.replaceChildren(loading("Загружаем очередь…"));
  try {
    const response = await api(queueUrl(0));
    if (requestId !== state.queueRequestId) return;
    state.queue = response.items ?? [];
    state.queueTotal = Number(response.total);
    state.queueOffset = state.queue.length;
    state.queueHasMore = state.queueOffset < state.queueTotal;
    state.queueLoading = false;
    for (const item of state.queue) state.typeNames.set(item.typeCode, item.typeName || item.typeCode);
    populateTypeFilter();
    if (preserveSelection && state.selected) {
      state.selected = state.queue.find((item) => decisionKey(item) === decisionKey(state.selected)) ?? null;
    }
    renderQueue();
    if (state.selected) {
      state.selectedExamplesRequest += 1;
      renderDetail();
      void loadReviewExamples(state.selected);
    }
  } catch (error) {
    if (requestId !== state.queueRequestId) return;
    state.queueLoading = false;
    list.replaceChildren(emptyText(error.message));
  }
}

async function loadNextQueuePage() {
  if (state.queueLoading || !state.queueHasMore || state.queueLoadError) return;
  const requestId = state.queueRequestId;
  state.queueLoading = true;
  renderQueueLoadState();
  try {
    const response = await api(queueUrl(state.queueOffset));
    if (requestId !== state.queueRequestId) return;
    const received = response.items ?? [];
    const known = new Set(state.queue.map((item) => item.reviewGroupId));
    const added = received.filter((item) => !known.has(item.reviewGroupId));
    state.queue.push(...added);
    state.queueOffset += received.length;
    state.queueTotal = Number(response.total);
    state.queueHasMore = received.length > 0 && state.queueOffset < state.queueTotal;
    for (const item of added) state.typeNames.set(item.typeCode, item.typeName || item.typeCode);
    populateTypeFilter();
    appendQueueItems(added);
  } catch (error) {
    if (requestId !== state.queueRequestId) return;
    state.queueLoadError = error.message;
  } finally {
    if (requestId === state.queueRequestId) {
      state.queueLoading = false;
      renderQueueLoadState();
    }
  }
}

function maybeLoadNextQueuePage() {
  const list = byId("queue-list");
  if (list.scrollHeight - list.scrollTop - list.clientHeight < 320) void loadNextQueuePage();
}

function populateTypeFilter() {
  const select = byId("type-filter");
  const current = select.value;
  const known = new Set([...select.options].slice(1).map((option) => option.value));
  for (const typeCode of [...new Set(state.queue.map((item) => item.typeCode))].sort()) {
    if (known.has(typeCode)) continue;
    const option = document.createElement("option");
    option.value = typeCode;
    option.textContent = typeName(typeCode);
    select.append(option);
  }
  select.value = current;
}

function decisionKey(item) {
  return JSON.stringify([item.sourceId, item.typeCode, item.scope, item.normalizedSourceValue, item.contextKey, item.status]);
}

function renderQueue() {
  const list = byId("queue-list");
  list.replaceChildren();
  byId("queue-eyebrow").textContent = byId("status-filter").value === "waiting_apply"
    ? "Ждут обработки"
    : "Ожидают решения";
  byId("queue-count").textContent = state.queueTotal.toLocaleString("ru-RU");
  byId("queue-nav-count").textContent = state.queueTotal.toLocaleString("ru-RU");
  if (state.queue.length === 0) {
    list.append(emptyText("В этой выборке ничего не ожидает решения."));
    state.selected = null;
    state.selectedExamplesRequest += 1;
    showEmptyDetail();
    return;
  }
  appendQueueItems(state.queue);
}

function queueItemButton(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `queue-item${state.selected && decisionKey(state.selected) === decisionKey(item) ? " active" : ""}`;
  button.dataset.reviewGroupId = item.reviewGroupId;
  const title = document.createElement("span");
  title.className = "queue-item-title";
  title.textContent = item.sourceValue;
  const meta = document.createElement("span");
  meta.className = "queue-item-meta";
  const kind = document.createElement("span");
  kind.textContent = `${typeName(item)} · ${item.sourceCode}`;
  const count = document.createElement("span");
  count.textContent = `${item.productCount} тов.`;
  meta.append(kind, count);
  button.append(title, meta);
  button.addEventListener("click", () => selectQueueItem(item));
  return button;
}

function appendQueueItems(items) {
  const list = byId("queue-list");
  list.querySelector(".queue-load-state")?.remove();
  const fragment = document.createDocumentFragment();
  for (const item of items) fragment.append(queueItemButton(item));
  list.append(fragment);
  renderQueueLoadState();
}

function renderQueueLoadState() {
  const list = byId("queue-list");
  list.querySelector(".queue-load-state")?.remove();
  if (!state.queueLoading && !state.queueLoadError) return;
  const tail = document.createElement("div");
  tail.className = "queue-load-state";
  if (state.queueLoadError) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button quiet";
    retry.textContent = "Повторить загрузку";
    retry.title = state.queueLoadError;
    retry.addEventListener("click", () => {
      state.queueLoadError = null;
      void loadNextQueuePage();
    });
    tail.append(retry);
  } else {
    tail.append(loading("Загружаем ещё…"));
  }
  list.append(tail);
}

function updateQueueSelection() {
  for (const button of byId("queue-list").querySelectorAll(".queue-item")) {
    button.classList.toggle("active", button.dataset.reviewGroupId === state.selected?.reviewGroupId);
  }
}

function selectQueueItem(item) {
  state.selectedExamplesRequest += 1;
  state.selected = item;
  state.selectedMapping = null;
  state.decisionPreview = null;
  state.currentReferenceId = null;
  state.currentResolution = null;
  state.selectedProjectionTerm = null;
  state.projectionPreview = null;
  state.resolved = false;
  updateQueueSelection();
  renderDetail();
  void loadReviewExamples(item);
  if (item.status !== "waiting_apply") {
    byId("mapping-search").value = item.sourceValue;
    void loadMappingResults();
  }
}

async function loadReviewExamples(item) {
  const requestId = state.selectedExamplesRequest;
  byId("examples-list").replaceChildren(loading("Загружаем примеры…"));
  try {
    const response = await api(`/api/classifier/queue/${encodeURIComponent(item.reviewGroupId)}/examples`);
    if (requestId !== state.selectedExamplesRequest || state.selected?.reviewGroupId !== item.reviewGroupId) return;
    item.examples = response.items ?? [];
    renderExamples(item, item.examples);
  } catch (error) {
    if (requestId !== state.selectedExamplesRequest || state.selected?.reviewGroupId !== item.reviewGroupId) return;
    byId("examples-list").replaceChildren(emptyText(error.message));
  }
}

function showEmptyDetail() {
  byId("empty-state").hidden = false;
  byId("detail-content").hidden = true;
}

function renderDetail() {
  const item = state.selected;
  if (!item) return showEmptyDetail();
  byId("empty-state").hidden = true;
  byId("detail-content").hidden = false;
  byId("detail-value").textContent = item.sourceValue;
  byId("detail-context").textContent = contextSummary(item.context);
  byId("product-count").textContent = `${Number(item.productCount).toLocaleString("ru-RU")} ${productWord(item.productCount)}`;
  const waiting = item.status === "waiting_apply";
  const badges = byId("detail-badges");
  badges.replaceChildren(
    badge(typeName(item)),
    badge(item.sourceCode),
    badge(waiting ? "Ждёт пересчёта" : item.status === "ambiguous" ? "Конфликт правил" : "Не сопоставлено", item.status === "ambiguous"),
  );
  renderExamples(item, item.examples ?? []);
  byId("ignore-button").hidden = waiting;
  byId("waiting-panel").hidden = !waiting;
  byId("mapping-section").hidden = waiting;
  byId("decision-actions").hidden = state.resolved || waiting;
  byId("decision-success").hidden = !state.resolved;
  byId("ignore-button").disabled = state.resolved || waiting;
  if (!state.resolved && !state.decisionPreview) {
    byId("decision-preview").hidden = true;
    byId("confirm-button").textContent = "Проверить точное сопоставление";
  }
  updateMappingModeAvailability();
  renderProjectionSection();
}

function contextSummary(context) {
  const values = Object.entries(context ?? {})
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value) && String(value).trim())
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${value}`);
  return values.length ? values.join(" · ") : "Без дополнительного контекста";
}

function snapshotTermNames(item, example) {
  const primaryTaxonomy = {
    brand: "pa_brand",
    model: "pa_model",
    category: "product_cat",
    merchandising_category: "product_tag",
    tag: "product_tag",
    color: "pa_tsvet",
    material: "pa_material",
    activity: "pa_vid",
    shoe_height: "pa_shoe_height",
    season: "pa_season",
  }[item.typeCode];
  const taxonomies = primaryTaxonomy ? [primaryTaxonomy] : [];
  if (["brand", "model", "category"].includes(item.typeCode)) taxonomies.push("product_tag");
  const names = [];
  for (const target of example.targetSnapshots ?? []) {
    const assigned = target.snapshot?.product?.taxonomies ?? {};
    for (const taxonomy of taxonomies) {
      for (const term of assigned[taxonomy] ?? []) {
        if (typeof term?.name === "string" && term.name.trim()) names.push(term.name.trim());
      }
    }
  }
  return [...new Set(names)].slice(0, 6);
}

function renderExamples(item, examples) {
  const list = byId("examples-list");
  list.replaceChildren();
  for (const example of examples) {
    const card = document.createElement("a");
    card.className = "example-card";
    card.href = `/products/${encodeURIComponent(example.sourceProductId)}`;
    card.setAttribute("aria-label", `Открыть карточку товара ${example.title || example.sourceKey}`);
    const title = document.createElement("strong");
    title.textContent = example.title || example.sourceKey;
    const meta = document.createElement("span");
    meta.textContent = [example.sku, `ID ${example.sourceProductId}`].filter(Boolean).join(" · ");
    card.append(title, meta);
    const targetTerms = snapshotTermNames(item, example);
    if (targetTerms.length > 0) {
      const current = document.createElement("span");
      current.className = "example-target-terms";
      current.textContent = `На сайте: ${targetTerms.join(" · ")}`;
      card.append(current);
    }
    list.append(card);
  }
}

function badge(text, warning = false) {
  const element = document.createElement("span");
  element.className = `badge${warning ? " warning" : ""}`;
  element.textContent = text;
  return element;
}

function activeTarget() {
  return state.targets.find((target) => target.dictionary?.configured) ?? state.targets[0] ?? null;
}

function activeCapability(item = state.selected) {
  return activeTarget()?.dictionary?.classificationCapabilities
    ?.find((capability) => capability.typeCode === item?.typeCode) ?? null;
}

function allCapabilities() {
  return activeTarget()?.dictionary?.classificationCapabilities ?? [];
}

function capabilitiesByTargetScope() {
  return [...new Map(allCapabilities().map((capability) => [capability.targetScope, capability])).values()];
}

function dictionaryEntity(item = state.selected) {
  return activeCapability(item)?.entityType ?? null;
}

function targetScope(item = state.selected) {
  return activeCapability(item)?.targetScope ?? item?.scope;
}

function updateMappingModeAvailability() {
  const wordpressTab = byId("mapping-tabs").querySelector('[data-mode="wordpress"]');
  wordpressTab.textContent = state.selected?.typeCode === "merchandising_category"
    ? "Метка WordPress"
    : "Основное поле WordPress";
  const available = Boolean(activeTarget()?.dictionary?.configured && dictionaryEntity());
  wordpressTab.disabled = !available;
  if (!available && state.mappingMode === "wordpress") state.mappingMode = "internal";
  for (const tab of byId("mapping-tabs").querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.mode === state.mappingMode);
  }
  const createAllowed = state.mappingMode === "wordpress" && activeCapability()?.creatable === true;
  byId("create-term-row").hidden = !createAllowed;
}

async function loadMappingResults() {
  const item = state.selected;
  if (!item) return;
  state.selectedMapping = null;
  resetDecisionPreview();
  byId("confirm-button").disabled = true;
  const results = byId("mapping-results");
  const message = byId("mapping-message");
  message.hidden = true;
  results.replaceChildren(loading("Ищем варианты…"));
  const search = byId("mapping-search").value.trim();
  try {
    let response;
    if (state.mappingMode === "internal") {
      const params = new URLSearchParams({ typeCode: item.typeCode, search, limit: "100" });
      response = await api(`/api/classifier/reference-values?${params}`);
    } else {
      const target = activeTarget();
      const entityType = dictionaryEntity();
      if (!target || !target.dictionary?.configured || !entityType) {
        results.replaceChildren();
        message.textContent = "Для этого типа не настроен справочник WordPress. Можно использовать внутренний справочник.";
        message.hidden = false;
        return;
      }
      const params = new URLSearchParams({ entityType, search, limit: "100" });
      response = await api(`/api/targets/${target.id}/dictionary?${params}`);
    }
    state.mappingResults = response.items ?? [];
    renderMappingResults();
  } catch (error) {
    results.replaceChildren(emptyText(error.message));
  }
}

function renderMappingResults() {
  const container = byId("mapping-results");
  container.replaceChildren();
  if (state.mappingResults.length === 0) {
    container.append(emptyText("Совпадений не найдено."));
    return;
  }
  for (const result of state.mappingResults) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mapping-result${state.selectedMapping?.id === result.id ? " selected" : ""}`;
    const content = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = result.name;
    const details = document.createElement("small");
    details.textContent = state.mappingMode === "wordpress"
      ? [result.taxonomy, result.slug].filter(Boolean).join(" · ")
      : result.code;
    content.append(name, details);
    const id = document.createElement("span");
    id.className = "result-id";
    id.textContent = state.mappingMode === "wordpress" ? `term #${result.externalId}` : `#${result.id}`;
    button.append(content, id);
    button.addEventListener("click", () => {
      state.selectedMapping = result;
      resetDecisionPreview();
      state.currentReferenceId = state.mappingMode === "internal" ? result.id : null;
      byId("confirm-button").disabled = false;
      renderMappingResults();
    });
    container.append(button);
  }
}

async function confirmDecision(action = "confirm") {
  const item = state.selected;
  if (!item) return;
  const button = action === "ignore" ? byId("ignore-button") : byId("confirm-button");
  if (action === "confirm" && !state.selectedMapping) return;
  const originalText = button.textContent;
  const isPreview = action === "confirm" && !state.decisionPreview;
  button.disabled = true;
  button.textContent = isPreview ? "Проверяем…" : "Сохраняем…";
  button.setAttribute("aria-busy", "true");
  try {
    const body = { ...decisionBodyFor(item), action };
    if (action === "confirm" && state.mappingMode === "internal") body.referenceValueId = state.selectedMapping.id;
    if (action === "confirm" && state.mappingMode === "wordpress") {
      const target = activeTarget();
      body.targetLink = {
        targetId: target.id,
        targetScope: targetScope(item),
        dictionaryValueId: state.selectedMapping.id,
      };
    }
    if (action === "confirm" && !state.decisionPreview) {
      const response = await api("/api/classifier/decisions/preview", { method: "POST", body });
      state.decisionPreview = response.preview;
      const preview = byId("decision-preview");
      preview.textContent = response.preview.unchanged
        ? `Эта связь уже настроена. Затронуто товаров: ${response.preview.productCount}.`
        : decisionPreviewText(item, state.selectedMapping, response.preview.productCount);
      preview.hidden = false;
      button.textContent = "Сохранить точное сопоставление";
      button.removeAttribute("aria-busy");
      button.disabled = false;
      return;
    }
    const response = await api("/api/classifier/decisions", { method: "POST", body });
    state.currentReferenceId = response.decision.referenceValueId;
    state.currentResolution = { kind: "mapping", id: response.decision.mappingId };
    state.resolved = true;
    renderDetail();
    await loadProjections();
    if (action === "confirm" && !byId("projection-section").hidden) {
      byId("projection-section").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    button.removeAttribute("aria-busy");
    showToast(action === "ignore" ? "Значение будет игнорироваться." : "Основная связь сохранена. Ниже можно добавить категории, метки или другие назначения WordPress.");
  } catch (error) {
    showToast(error.message);
    button.textContent = originalText;
    button.removeAttribute("aria-busy");
    button.disabled = false;
  }
}

function resetDecisionPreview() {
  state.decisionPreview = null;
  byId("decision-preview").hidden = true;
  byId("confirm-button").textContent = "Проверить точное сопоставление";
}

function decisionBodyFor(item) {
  return {
    sourceId: item.sourceId,
    typeCode: item.typeCode,
    scope: item.scope,
    normalizedSourceValue: item.normalizedSourceValue,
    contextKey: item.contextKey,
  };
}

async function nextItem() {
  state.selected = null;
  state.resolved = false;
  showEmptyDetail();
  await loadQueue();
  if (state.queue[0]) selectQueueItem(state.queue[0]);
}

async function syncWordPress(triggerButton = null, selectedTarget = null) {
  const target = selectedTarget ?? activeTarget();
  if (!target?.dictionary?.configured) return;
  const button = triggerButton instanceof HTMLButtonElement ? triggerButton : byId("sync-button");
  button.disabled = true;
  button.textContent = "Обновляем…";
  try {
    await api(`/api/targets/${target.id}/dictionary/sync`, { method: "POST", body: {} });
    showToast("Справочники WordPress обновлены.");
    if (state.selected) await loadMappingResults();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Обновить WordPress";
  }
}

async function openCreateTerm() {
  const item = state.selected;
  const target = activeTarget();
  const entityType = dictionaryEntity();
  if (!item || !target || !entityType) return;
  byId("term-name").value = item.sourceValue;
  byId("term-slug").value = slugify(item.sourceValue);
  byId("term-type").textContent = `${typeName(item)} · ${entityType}`;
  byId("term-confirm").checked = false;
  byId("wp-password").value = "";
  byId("wp-password-field").hidden = Boolean(state.session?.wordpressCreateAllowed);
  clearError(byId("term-error"));
  const parentField = byId("parent-field");
  parentField.hidden = entityType !== "product_categories";
  if (!parentField.hidden) await loadCategoryParents(target.id);
  byId("create-term-dialog").showModal();
}

async function loadCategoryParents(targetId) {
  const select = byId("term-parent");
  select.replaceChildren(new Option("Без родителя", ""));
  try {
    const params = new URLSearchParams({ entityType: "product_categories", limit: "200" });
    const response = await api(`/api/targets/${targetId}/dictionary?${params}`);
    for (const category of response.items ?? []) select.append(new Option(category.name, category.externalId));
  } catch (error) {
    showError(byId("term-error"), `Не удалось получить категории: ${error.message}`);
  }
}

async function createTerm(event) {
  event.preventDefault();
  const item = state.selected;
  const target = activeTarget();
  const entityType = dictionaryEntity();
  if (!item || !target || !entityType) return;
  const errorElement = byId("term-error");
  clearError(errorElement);
  const submit = byId("create-term-submit");
  submit.disabled = true;
  submit.textContent = "Создаём…";
  try {
    if (!state.session?.wordpressCreateAllowed) {
      const grant = await api("/api/auth/wordpress-create", {
        method: "POST",
        body: { password: byId("wp-password").value },
      });
      state.session.wordpressCreateAllowed = grant.allowed;
    }
    const body = {
      ...decisionBodyFor(item),
      targetScope: targetScope(item),
      entityType,
      name: byId("term-name").value.trim(),
    };
    const slug = byId("term-slug").value.trim();
    const parentExternalId = byId("term-parent").value;
    if (slug) body.slug = slug;
    if (entityType === "product_categories" && parentExternalId) body.parentExternalId = parentExternalId;
    const response = await api(`/api/targets/${target.id}/dictionary/terms`, { method: "POST", body });
    state.currentReferenceId = response.result.decision.referenceValueId;
    state.resolved = true;
    byId("create-term-dialog").close();
    renderDetail();
    showToast(`Запись «${response.result.dictionaryValue.name}» создана и связана.`);
  } catch (requestError) {
    if (requestError.code === "wordpress_create_permission_required") {
      state.session.wordpressCreateAllowed = false;
      byId("wp-password-field").hidden = false;
    }
    showError(errorElement, requestError.message);
  } finally {
    submit.disabled = false;
    submit.textContent = "Создать и связать";
  }
}

function slugify(value) {
  const replacements = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
  return value.toLowerCase().split("").map((letter) => replacements[letter] ?? letter).join("")
    .normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

function openRuleDialog(options = {}) {
  const item = state.selected;
  const editing = options.rule ?? null;
  const reference = options.reference ?? null;
  if (!item && !editing && !reference) return;
  const queueItem = editing || reference ? null : item;
  const selectedTargetScope = queueItem ? targetScope(queueItem) : null;
  const canUseSelectedTarget = Boolean(queueItem && state.mappingMode === "wordpress" && state.selectedMapping !== null && activeTarget() !== null && selectedTargetScope);
  const referenceValueId = editing?.referenceValueId ?? reference?.id ?? state.currentReferenceId;
  if (!referenceValueId && !canUseSelectedTarget) {
    showToast("Сначала выберите результат правила во внутреннем справочнике или WordPress.");
    return;
  }
  const sourceId = editing?.sourceId ?? options.sourceId ?? queueItem?.sourceId ?? state.configMeta.sources[0]?.id;
  const typeCode = editing?.typeCode ?? reference?.typeCode ?? queueItem?.typeCode;
  if (!sourceId || !typeCode) {
    showToast("Для правила нужно выбрать источник и тип значения.");
    return;
  }
  state.editingRule = editing;
  state.ruleEditorContext = { sourceId, typeCode, referenceValueId, targetLink: canUseSelectedTarget ? {
    targetId: activeTarget().id, targetScope: selectedTargetScope, dictionaryValueId: state.selectedMapping.id,
  } : null };
  state.rulePreview = null;
  byId("rule-dialog-title").textContent = editing ? "Изменить правило" : "Новое правило распознавания";
  byId("rule-name").value = editing?.ruleName ?? `${typeName(typeCode)}: ${queueItem?.sourceValue ?? reference?.name ?? "новое правило"}`;
  byId("rule-priority").value = String(editing?.priority ?? 100);
  byId("rule-preview").hidden = true;
  byId("create-rule").disabled = true;
  clearError(byId("rule-error"));
  const result = byId("rule-result");
  const selectedName = editing?.referenceName ?? reference?.name ?? (queueItem ? state.selectedMapping?.name : null);
  result.textContent = canUseSelectedTarget
    ? `Результат: ${selectedName} · ${selectedTargetScope}. Система создаст внутреннее значение и основную связь автоматически.`
    : `Результат: ${selectedName ?? `внутреннее значение #${referenceValueId}`}.`;
  const origin = byId("rule-origin-fields");
  origin.hidden = Boolean(queueItem);
  const sourceSelect = byId("rule-source");
  sourceSelect.replaceChildren(...state.configMeta.sources.map((source) => new Option(source.name, source.id, false, source.id === sourceId)));
  sourceSelect.disabled = Boolean(editing);
  const referenceSelect = byId("rule-reference");
  referenceSelect.replaceChildren(new Option(selectedName ?? `#${referenceValueId}`, referenceValueId ?? ""));
  referenceSelect.disabled = true;
  const conditions = editing?.conditions ?? (queueItem ? suggestRuleConditions(queueItem) : []);
  state.ruleEditorFields = [
    "sourceValue",
    "scope",
    "subjectKind",
    ...conditions.map((condition) => condition.field),
    ...ruleScalarFields(queueItem?.context, "context"),
    ...ruleScalarFields(queueItem?.examples?.[0]?.evidence, "evidence"),
  ];
  state.ruleEditorFields = [...new Set(state.ruleEditorFields)];
  renderConditions(conditions.length ? conditions : [{ field: "sourceValue", operator: "equals", value: queueItem?.sourceValue ?? "" }]);
  byId("rule-dialog").showModal();
  byId("rule-fields-loading").hidden = true;
  if (!queueItem) void loadRuleEditorFields(sourceId, typeCode);
}

function ruleScalarFields(values, prefix) {
  return Object.entries(values ?? {}).flatMap(([key, value]) =>
    ["string", "number", "boolean"].includes(typeof value) ? [`${prefix}.${key}`] : []);
}

function productWord(count) {
  const value = Math.abs(Number(count));
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return "товаров";
  const last = value % 10;
  if (last === 1) return "товар";
  if (last >= 2 && last <= 4) return "товара";
  return "товаров";
}

function decisionGroupDescription(context) {
  const labels = {
    brand: "брендом",
    family: "семейством модели",
    audience: "аудиторией",
    productType: "типом товара",
    productCategory: "категорией товара",
    route: "разделом источника",
  };
  const values = Object.entries(context ?? {})
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value) && String(value).trim())
    .map(([key, value]) => `${labels[key] ?? key} «${value}»`);
  if (values.length === 0) return "с таким исходным значением";
  if (values.length === 1) return `с ${values[0]}`;
  return `с ${values.slice(0, -1).join(", ")} и ${values.at(-1)}`;
}

function decisionPreviewText(item, selectedMapping, productCount) {
  const count = Number(productCount);
  const source = `«${item.sourceValue}»`;
  const target = selectedMapping?.name ? ` с «${selectedMapping.name}»` : "";
  return `${source} будет связано${target}. Это решение затронет ${count.toLocaleString("ru-RU")} ${productWord(count)} ${decisionGroupDescription(item.context)}. Другие исходные значения и товары с другими признаками не изменятся. После сохранения товары будут пересчитаны. WordPress сейчас не изменяется.`;
}

function reviewProductsUrl(item, offset) {
  const params = new URLSearchParams({
    limit: String(reviewProductsPageSize),
    offset: String(offset),
  });
  const search = byId("review-products-search").value.trim();
  if (search) params.set("search", search);
  return `/api/classifier/queue/${encodeURIComponent(item.reviewGroupId)}/examples?${params}`;
}

function openReviewProductsDialog() {
  const item = state.selected;
  if (!item) return;
  state.reviewProductsItem = item;
  state.reviewProducts = [];
  state.reviewProductsOffset = 0;
  state.reviewProductsTotal = item.productCount;
  state.reviewProductsRequestId += 1;
  byId("review-products-title").textContent = `Товары: ${item.sourceValue}`;
  byId("review-products-context").textContent = `${typeName(item)} · ${contextSummary(item.context)}`;
  byId("review-products-search").value = "";
  byId("review-products-summary").textContent = "";
  byId("review-products-list").replaceChildren(loading("Загружаем товары…"));
  byId("review-products-more").hidden = true;
  byId("review-products-dialog").showModal();
  void loadReviewProducts(true);
}

async function loadReviewProducts(reset = false) {
  const item = state.reviewProductsItem;
  if (!item) return;
  if (reset) {
    state.reviewProducts = [];
    state.reviewProductsOffset = 0;
    byId("review-products-list").replaceChildren(loading("Загружаем товары…"));
  }
  const requestId = ++state.reviewProductsRequestId;
  const more = byId("review-products-more");
  more.disabled = true;
  try {
    const response = await api(reviewProductsUrl(item, state.reviewProductsOffset));
    if (requestId !== state.reviewProductsRequestId || state.reviewProductsItem?.reviewGroupId !== item.reviewGroupId) return;
    state.reviewProducts.push(...(response.items ?? []));
    state.reviewProductsOffset = state.reviewProducts.length;
    state.reviewProductsTotal = Number(response.total ?? 0);
    renderReviewProducts();
  } catch (error) {
    if (requestId !== state.reviewProductsRequestId) return;
    if (reset) byId("review-products-list").replaceChildren(emptyText(error.message));
    else showToast(error.message);
  } finally {
    if (requestId === state.reviewProductsRequestId) more.disabled = false;
  }
}

function renderReviewProducts() {
  const item = state.reviewProductsItem;
  const list = byId("review-products-list");
  list.replaceChildren();
  for (const product of state.reviewProducts) {
    const row = document.createElement("a");
    row.className = "review-product-row";
    row.href = `/products/${encodeURIComponent(product.sourceProductId)}`;
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = product.title || product.sourceKey;
    const meta = document.createElement("span");
    meta.textContent = [product.sku, product.sourceKey].filter(Boolean).join(" · ");
    copy.append(title, meta);
    if (item) {
      const targetTerms = snapshotTermNames(item, product);
      if (targetTerms.length > 0) {
        const current = document.createElement("span");
        current.textContent = `На сайте: ${targetTerms.join(" · ")}`;
        copy.append(current);
      }
    }
    const id = document.createElement("span");
    id.className = "review-product-id";
    id.textContent = `ID ${product.sourceProductId}`;
    row.append(copy, id);
    list.append(row);
  }
  if (state.reviewProducts.length === 0) list.append(emptyText("Товары не найдены."));
  const shown = Math.min(state.reviewProducts.length, state.reviewProductsTotal);
  byId("review-products-summary").textContent = `Показано ${shown.toLocaleString("ru-RU")} из ${state.reviewProductsTotal.toLocaleString("ru-RU")}`;
  byId("review-products-more").hidden = shown >= state.reviewProductsTotal;
}

function availableRuleFields() {
  return [...new Set(state.ruleEditorFields)];
}

async function loadRuleEditorFields(sourceId, typeCode) {
  const requestId = ++state.ruleFieldsRequestId;
  const loadingState = byId("rule-fields-loading");
  loadingState.textContent = "Загружаем дополнительные поля…";
  loadingState.title = "";
  loadingState.hidden = false;
  try {
    const response = await api(`/api/classifier/rule-fields?${new URLSearchParams({ sourceId, typeCode })}`);
    if (requestId !== state.ruleFieldsRequestId || !byId("rule-dialog").open) return;
    const additions = (response.items ?? []).map((field) => field.field);
    state.ruleEditorFields = [...new Set([...state.ruleEditorFields, ...additions])];
    for (const select of byId("conditions-list").querySelectorAll(".condition-field")) {
      const known = new Set([...select.options].map((option) => option.value));
      for (const field of state.ruleEditorFields) {
        if (!known.has(field)) select.append(new Option(conditionFieldLabel(field), field));
      }
    }
    loadingState.hidden = true;
  } catch (error) {
    if (requestId !== state.ruleFieldsRequestId || !byId("rule-dialog").open) return;
    loadingState.textContent = "Дополнительные поля не загрузились";
    loadingState.title = error.message;
  }
}

function renderConditions(conditions) {
  const list = byId("conditions-list");
  list.replaceChildren();
  for (const condition of conditions) list.append(conditionRow(condition));
}

function conditionRow(condition = { field: "sourceValue", operator: "contains", value: "" }) {
  const row = document.createElement("div");
  row.className = "condition-row";
  const field = document.createElement("select");
  field.className = "condition-field";
  for (const value of availableRuleFields()) {
    const option = new Option(conditionFieldLabel(value), value, false, value === condition.field);
    option.title = value;
    field.append(option);
  }
  const operator = document.createElement("select");
  operator.className = "condition-operator";
  for (const [value, label] of [["equals", "равно"], ["contains", "содержит"], ["all_words", "все слова"], ["regex", "regex"]]) {
    operator.append(new Option(label, value, false, value === condition.operator));
  }
  const input = document.createElement("input");
  input.className = "condition-value";
  input.value = condition.value;
  input.placeholder = "Значение";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "condition-remove";
  remove.textContent = "×";
  remove.ariaLabel = "Удалить условие";
  remove.addEventListener("click", () => row.remove());
  for (const control of [field, operator, input]) control.addEventListener("change", resetRulePreview);
  row.append(field, operator, input, remove);
  return row;
}

function resetRulePreview() {
  state.rulePreview = null;
  byId("rule-preview").hidden = true;
  byId("create-rule").disabled = true;
}

function ruleDraft() {
  const context = state.ruleEditorContext;
  const conditions = [...byId("conditions-list").querySelectorAll(".condition-row")].map((row) => ({
    field: row.querySelector(".condition-field").value,
    operator: row.querySelector(".condition-operator").value,
    value: row.querySelector(".condition-value").value,
  }));
  const result = {
    sourceId: context.sourceId,
    typeCode: context.typeCode,
    name: byId("rule-name").value.trim(),
    priority: Number(byId("rule-priority").value),
    conditions,
  };
  if (context.referenceValueId) result.referenceValueId = context.referenceValueId;
  else result.targetLink = context.targetLink;
  return result;
}

async function previewRule() {
  clearError(byId("rule-error"));
  const button = byId("preview-rule");
  button.disabled = true;
  try {
    const response = await api("/api/classifier/rules/preview", { method: "POST", body: ruleDraft() });
    state.rulePreview = response.preview;
    renderRulePreview(response.preview);
    byId("create-rule").disabled = false;
  } catch (error) {
    showError(byId("rule-error"), error.message);
  } finally {
    button.disabled = false;
  }
}

function renderRulePreview(preview) {
  const box = byId("rule-preview");
  box.replaceChildren();
  const stats = document.createElement("div");
  stats.className = "preview-stats";
  for (const [value, label] of [
    [preview.matchedProducts, "найдено товаров"],
    [preview.affectedProducts, "будет изменено"],
    [preview.ambiguousObservations, "конфликтов"],
    [preview.shadowedObservations, "перекрыто"],
  ]) {
    const stat = document.createElement("div");
    stat.className = "preview-stat";
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    const span = document.createElement("span");
    span.textContent = label;
    stat.append(strong, span);
    stats.append(stat);
  }
  box.append(stats);
  if (preview.examples?.length) {
    const examples = document.createElement("div");
    examples.className = "preview-examples";
    for (const item of preview.examples.slice(0, 5)) {
      const row = document.createElement("a");
      row.className = "preview-example";
      row.href = `/products/${encodeURIComponent(item.sourceProductId)}`;
      row.title = "Открыть карточку товара";
      const title = document.createElement("span");
      title.textContent = item.title || item.sourceKey;
      const outcome = document.createElement("span");
      outcome.textContent = item.reason || (item.outcome === "ambiguous" ? "Конфликт правил" : item.outcome === "shadowed" ? "Уже покрыто" : "Новое правило применится");
      row.append(title, outcome);
      examples.append(row);
    }
    box.append(examples);
  }
  box.hidden = false;
}

async function createRule(event) {
  event.preventDefault();
  if (!state.rulePreview) return;
  const button = byId("create-rule");
  button.disabled = true;
  try {
    const editing = state.editingRule;
    const response = await api(editing ? `/api/classifier/rules/${editing.id}` : "/api/classifier/rules", { method: editing ? "PATCH" : "POST", body: ruleDraft() });
    state.currentReferenceId = response.rule.referenceValueId ?? state.ruleEditorContext.referenceValueId;
    state.currentResolution = { kind: "rule", id: response.rule.ruleId ?? editing?.id };
    byId("rule-dialog").close();
    if (state.classificationView === "queue") {
      renderProjectionSection();
      await loadProjections();
    } else {
      await loadRules();
      if (state.selectedReference) await selectReference(state.selectedReference);
    }
    showToast(`${editing ? "Правило изменено" : "Правило создано"}. На пересчёт поставлено товаров: ${response.rule.affectedProductCount}.`);
  } catch (error) {
    showError(byId("rule-error"), error.message);
    button.disabled = false;
  }
}

function renderProjectionSection() {
  const section = byId("projection-section");
  const target = activeTarget();
  const referenceId = state.currentReferenceId;
  section.hidden = !target?.dictionary?.configured || !referenceId;
  if (section.hidden) return;
  byId("projection-origin").textContent = `внутреннее #${referenceId}`;
  const select = byId("projection-scope");
  const current = select.value;
  select.replaceChildren();
  for (const capability of capabilitiesByTargetScope()) {
    const label = `${targetScopeLabel(capability.targetScope)} · ${capability.targetScope}`;
    select.append(new Option(label, capability.targetScope));
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
  else select.value = targetScope();
  byId("projection-search").value ||= state.selected?.sourceValue ?? "";
  void loadProjectionResults();
}

function targetScopeLabel(scope) {
  return ({
    "product.brand": "Бренд",
    "product.model": "Модель",
    "product.category": "Категория товара",
    "product.tag": "Метка товара",
    "product.color": "Цвет",
    "product.material": "Материал",
    "product.activity": "Вид спорта / назначение",
    "product.shoe_height": "Высота обуви",
    "product.season": "Сезон",
  })[scope] || scope;
}

function projectionEntity() {
  const scope = byId("projection-scope").value;
  return capabilitiesByTargetScope().find((capability) => capability.targetScope === scope)?.entityType ?? null;
}

async function loadProjections() {
  const target = activeTarget();
  const referenceId = state.currentReferenceId;
  const list = byId("projection-list");
  if (!target || !referenceId) return;
  list.replaceChildren(loading("Загружаем дополнительные назначения…"));
  try {
    const params = new URLSearchParams({ targetId: target.id, referenceValueId: referenceId });
    const response = await api(`/api/classifier/reference-projections?${params}`);
    renderProjectionList(response.items ?? []);
  } catch (error) {
    list.replaceChildren(emptyText(error.message));
  }
}

function renderProjectionList(items) {
  const list = byId("projection-list");
  list.replaceChildren();
  if (items.length === 0) {
    list.append(emptyText("Дополнительных назначений пока нет."));
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "projection-row";
    const text = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = item.externalLabel;
    const small = document.createElement("span");
    small.textContent = `${targetScopeLabel(item.targetScope)} · ${item.targetScope} · term #${item.externalValue}`;
    text.append(strong, small);
    const button = document.createElement("button");
    button.className = "button danger-quiet small-button";
    button.type = "button";
    button.textContent = "Отключить";
    button.addEventListener("click", () => deactivateProjection(item.id));
    row.append(text, button);
    list.append(row);
  }
}

async function loadProjectionResults() {
  const target = activeTarget();
  const entityType = projectionEntity();
  const results = byId("projection-results");
  state.selectedProjectionTerm = null;
  state.projectionPreview = null;
  byId("preview-projection").disabled = true;
  byId("create-projection").disabled = true;
  byId("projection-preview").hidden = true;
  clearError(byId("projection-error"));
  if (!target || !entityType || byId("projection-section").hidden) return;
  results.replaceChildren(loading("Ищем термины…"));
  try {
    const params = new URLSearchParams({ entityType, search: byId("projection-search").value.trim(), limit: "100" });
    const response = await api(`/api/targets/${target.id}/dictionary?${params}`);
    state.projectionResults = response.items ?? [];
    renderProjectionResults();
  } catch (error) {
    results.replaceChildren(emptyText(error.message));
  }
}

function renderProjectionResults() {
  const container = byId("projection-results");
  container.replaceChildren();
  if (state.projectionResults.length === 0) {
    container.append(emptyText("Совпадений не найдено."));
    return;
  }
  for (const result of state.projectionResults) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mapping-result${state.selectedProjectionTerm?.id === result.id ? " selected" : ""}`;
    const content = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = result.name;
    const details = document.createElement("small");
    details.textContent = [result.entityType, result.taxonomy, result.slug].filter(Boolean).join(" · ");
    content.append(name, details);
    const id = document.createElement("span");
    id.className = "result-id";
    id.textContent = `term #${result.externalId}`;
    button.append(content, id);
    button.addEventListener("click", () => {
      state.selectedProjectionTerm = result;
      state.projectionPreview = null;
      byId("preview-projection").disabled = false;
      byId("create-projection").disabled = true;
      byId("projection-preview").hidden = true;
      renderProjectionResults();
    });
    container.append(button);
  }
}

function projectionBody() {
  const target = activeTarget();
  return {
    targetId: target.id,
    referenceValueId: state.currentReferenceId,
    targetScope: byId("projection-scope").value,
    dictionaryValueId: state.selectedProjectionTerm.id,
  };
}

async function previewProjection() {
  if (!state.selectedProjectionTerm || !state.currentReferenceId) return;
  const button = byId("preview-projection");
  button.disabled = true;
  clearError(byId("projection-error"));
  try {
    const response = await api("/api/classifier/reference-projections/preview", { method: "POST", body: projectionBody() });
    state.projectionPreview = response.preview;
    renderProjectionPreview(response.preview);
    byId("create-projection").disabled = Boolean(response.preview.duplicate) || (response.preview.cardinalityConflicts?.length || 0) > 0;
  } catch (error) {
    showError(byId("projection-error"), error.message);
  } finally {
    button.disabled = false;
  }
}

function renderProjectionPreview(preview, box = byId("projection-preview")) {
  box.replaceChildren();
  const stats = document.createElement("div");
  stats.className = "preview-stats";
  for (const [value, label] of [
    [preview.observationCount, "наблюдений"],
    [preview.productCount, "товаров"],
    [preview.duplicate ? 1 : 0, "дублей"],
    [preview.cardinalityConflicts?.length ?? 0, "конфликтов"],
  ]) {
    const stat = document.createElement("div");
    stat.className = "preview-stat";
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    const span = document.createElement("span");
    span.textContent = label;
    stat.append(strong, span);
    stats.append(stat);
  }
  box.append(stats);
  if (preview.duplicate || (preview.cardinalityConflicts?.length || 0) > 0) {
    const warning = document.createElement("p");
    warning.className = "inline-message";
    warning.textContent = preview.duplicate
      ? "Такое назначение уже активно. Создавать дубль не нужно."
      : "Это поле допускает одно значение, а для решения уже настроено другое назначение.";
    box.append(warning);
  }
  const examples = document.createElement("div");
  examples.className = "preview-examples";
  for (const item of preview.examples ?? []) {
    const row = document.createElement("div");
    row.className = "preview-example";
    const title = document.createElement("span");
    title.textContent = item.title || item.sourceKey;
    const terms = document.createElement("span");
    terms.textContent = item.currentTerms?.length ? item.currentTerms.join(" · ") : "нет в snapshot";
    row.append(title, terms);
    examples.append(row);
  }
  box.append(examples);
  box.hidden = false;
}

async function createProjection() {
  if (!state.projectionPreview || !state.selectedProjectionTerm) return;
  const button = byId("create-projection");
  button.disabled = true;
  try {
    const response = await api("/api/classifier/reference-projections", { method: "POST", body: projectionBody() });
    showToast(`Дополнительное назначение сохранено. На обработку поставлено товаров: ${response.projection.affectedProductCount}.`);
    await loadProjections();
  } catch (error) {
    showError(byId("projection-error"), error.message);
  } finally {
    button.disabled = false;
  }
}

async function deactivateProjection(projectionId) {
  const target = activeTarget();
  if (!target) return;
  try {
    const response = await api(`/api/targets/${target.id}/reference-projections/${projectionId}/deactivate`, { method: "POST", body: {} });
    showToast(`Дополнительное назначение отключено. На обработку поставлено товаров: ${response.projection.affectedProductCount}.`);
    await loadProjections();
  } catch (error) {
    showToast(error.message);
  }
}

function populateCatalogFilters() {
  const typeSelects = [byId("reference-type"), byId("rule-list-type")];
  for (const select of typeSelects) {
    if (!select) continue;
    const current = select.value;
    const first = select.options[0]?.textContent ?? "Все типы";
    select.replaceChildren(new Option(first, ""), ...state.configMeta.types.map((type) => new Option(type.name, type.code)));
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  }
  const source = byId("rule-list-source");
  if (source) {
    source.replaceChildren(new Option("Все источники", ""), ...state.configMeta.sources.map((item) => new Option(item.name, item.id)));
    const singleSource = state.configMeta.sources.length === 1;
    source.hidden = singleSource;
    if (singleSource) source.value = state.configMeta.sources[0].id;
    byId("rule-list-filters")?.classList.toggle("single-source", singleSource);
  }
  const target = byId("wordpress-target");
  if (target) {
    target.replaceChildren(...state.targets.map((item) => new Option(item.name, item.id)));
    const singleTarget = state.targets.length === 1;
    target.hidden = singleTarget;
    byId("wordpress-filters")?.classList.toggle("single-target", singleTarget);
    populateWordPressEntities();
  }
}

async function switchClassificationView(view, updateUrl = true) {
  state.classificationView = view;
  byId("app-view").classList.toggle("document-scroll", view === "rules" || view === "wordpress");
  window.scrollTo(0, 0);
  for (const panel of document.querySelectorAll(".classification-view")) panel.hidden = panel.id !== `classification-view-${view}`;
  for (const button of document.querySelectorAll("[data-classification-view]")) button.classList.toggle("active", button.dataset.classificationView === view);
  byId("refresh-button").hidden = view !== "queue";
  byId("sync-button").hidden = true;
  if (updateUrl) history.replaceState(null, "", `/classifier${view === "queue" ? "" : `?view=${view}`}`);
  if (view === "references") await loadReferences(true);
  if (view === "rules") await loadRules(true);
  if (view === "wordpress") {
    populateCatalogFilters();
    await loadWordPressValues(true);
  }
}

async function loadReferences(reset = true) {
  if (reset) {
    state.referenceOffset = 0;
    state.references = [];
    byId("reference-list").replaceChildren(loading("Загружаем внутренние значения…"));
  }
  const params = new URLSearchParams({ limit: "50", offset: String(state.referenceOffset) });
  const search = byId("reference-search").value.trim();
  const typeCode = byId("reference-type").value;
  if (search) params.set("search", search);
  if (typeCode) params.set("typeCode", typeCode);
  try {
    const response = await api(`/api/classifier/reference-catalog?${params}`);
    state.referenceTotal = Number(response.total ?? 0);
    state.references.push(...(response.items ?? []));
    state.referenceOffset = state.references.length;
    renderReferences();
    if (state.pendingReferenceId) {
      const selected = state.references.find((item) => item.id === state.pendingReferenceId);
      if (selected) {
        const action = state.pendingReferenceAction;
        state.pendingReferenceId = null;
        state.pendingReferenceAction = null;
        await selectReference(selected);
        if (action === "assignment") openAssignmentDialog(selected);
      }
    }
  } catch (error) {
    byId("reference-list").replaceChildren(emptyText(error.message));
  }
}

function renderReferences() {
  const list = byId("reference-list");
  list.replaceChildren();
  byId("reference-count").textContent = String(state.referenceTotal);
  for (const item of state.references) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `catalog-item${state.selectedReference?.id === item.id ? " active" : ""}`;
    const title = document.createElement("strong");
    title.textContent = item.name;
    const meta = document.createElement("span");
    meta.textContent = `${item.typeName} · ${item.productCount} товаров`;
    const flow = document.createElement("span");
    flow.className = "catalog-item-flow";
    flow.textContent = `${item.mappingCount} точных · ${item.ruleCount} правил · ${item.outputs.length} назначений`;
    button.append(title, meta, flow);
    button.addEventListener("click", () => selectReference(item));
    list.append(button);
  }
  if (!state.references.length) list.append(emptyText("Внутренние значения не найдены."));
  byId("reference-more").hidden = state.referenceOffset >= state.referenceTotal;
}

function configUrl(kind, reference) {
  return `/api/classifier/configuration?${new URLSearchParams({ kind, referenceValueId: reference.id, usage: "none", limit: "200", offset: "0" })}`;
}

async function selectReference(reference) {
  state.selectedReference = reference;
  renderReferences();
  const detail = byId("reference-detail");
  detail.replaceChildren(loading("Собираем полную цепочку…"));
  try {
    const [mappings, rules, legacy] = await Promise.all([
      api(configUrl("mapping", reference)), api(configUrl("rule", reference)), api(configUrl("projection", reference)),
    ]);
    renderReferenceDetail(reference, {
      mappings: (mappings.items ?? []).filter((item) => item.referenceValueId === reference.id),
      rules: (rules.items ?? []).filter((item) => item.referenceValueId === reference.id),
      legacy: (legacy.items ?? []).filter((item) => item.referenceValueId === reference.id),
    });
  } catch (error) {
    detail.replaceChildren(emptyText(error.message));
  }
}

function referenceSection(titleText, hint) {
  const section = document.createElement("section");
  section.className = "section reference-block";
  const heading = document.createElement("div");
  heading.className = "section-title";
  const copy = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = titleText;
  copy.append(title);
  if (hint) {
    const text = document.createElement("p");
    text.className = "muted";
    text.textContent = hint;
    copy.append(text);
  }
  heading.append(copy);
  section.append(heading);
  return { section, heading };
}

function renderReferenceDetail(reference, relations) {
  const detail = byId("reference-detail");
  detail.replaceChildren();
  const header = document.createElement("header");
  header.className = "reference-detail-header";
  const copy = document.createElement("div");
  const badges = document.createElement("div");
  badges.className = "badges";
  badges.append(badge(reference.typeName), badge(`${reference.productCount} товаров`));
  const title = document.createElement("h2");
  title.textContent = reference.name;
  const code = document.createElement("p");
  code.className = "muted";
  code.textContent = `Внутренний код: ${reference.code}`;
  copy.append(badges, title, code);
  const addRule = document.createElement("button");
  addRule.type = "button";
  addRule.className = "button secondary";
  addRule.textContent = "+ Правило распознавания";
  addRule.addEventListener("click", () => openRuleDialog({ reference }));
  header.append(copy, addRule);
  detail.append(header);

  const recognition = referenceSection("Как распознаётся", "Точные значения источников и общие контекстные правила приводят к этому внутреннему смыслу.");
  const rows = document.createElement("div");
  rows.className = "relation-list";
  for (const item of relations.mappings) rows.append(relationRow(item.sourceValue, `${item.sourceCode} · точное значение`, item.status));
  for (const item of relations.rules) {
    const row = relationRow(item.ruleName, `${item.sourceCode?.toUpperCase() ?? "Источник"} · ${conditionSummary(item.conditions)}`, item.status, "Изменить");
    row.querySelector("button")?.addEventListener("click", () => openRuleDialog({ rule: item }));
    rows.append(row);
  }
  if (!rows.childElementCount) rows.append(emptyText("Способы распознавания пока не настроены."));
  recognition.section.append(rows);
  detail.append(recognition.section);

  const output = referenceSection("Куда отправляется", "Основное назначение соответствует типу значения. Дополнительные назначения добавляют связанные термины WordPress.");
  const addAssignment = document.createElement("button");
  addAssignment.type = "button";
  addAssignment.className = "button secondary small-button";
  addAssignment.textContent = "+ Дополнительное назначение";
  addAssignment.addEventListener("click", () => openAssignmentDialog(reference));
  output.heading.append(addAssignment);
  const outputRows = document.createElement("div");
  outputRows.className = "relation-list";
  for (const item of reference.outputs) {
    const row = relationRow(item.label, `${item.kind === "primary" ? "Основное" : "Дополнительно"} · ${item.taxonomy || item.targetScope} · term #${item.externalId}`, "active", item.kind === "additional" ? "Отключить" : "Изменить");
    if (item.kind === "additional") row.querySelector("button")?.addEventListener("click", () => deactivateReferenceAssignment(item));
    else row.querySelector("button")?.addEventListener("click", () => openAssignmentDialog(reference, { mode: "primary", output: item }));
    outputRows.append(row);
  }
  const expectedPrimary = allCapabilities().find((item) => item.typeCode === reference.typeCode);
  const hasPrimary = reference.outputs.some((item) => item.kind === "primary" && item.targetId === activeTarget()?.id && item.targetScope === expectedPrimary?.targetScope);
  if (expectedPrimary && !hasPrimary) {
    const configure = document.createElement("button");
    configure.type = "button";
    configure.className = "button secondary small-button";
    configure.textContent = "Настроить основное назначение";
    configure.addEventListener("click", () => openAssignmentDialog(reference, { mode: "primary" }));
    outputRows.append(configure);
  }
  if (!reference.outputs.length) outputRows.append(emptyText("WordPress-назначения не настроены."));
  output.section.append(outputRows);
  detail.append(output.section);

  if (relations.legacy.length) {
    const exceptions = referenceSection("Точечные исключения", "Старые назначения привязаны к конкретному решению. Они сохранены без автоматического обобщения.");
    const exceptionRows = document.createElement("div");
    exceptionRows.className = "relation-list";
    for (const item of relations.legacy) exceptionRows.append(relationRow(item.targetLabel, `${item.ruleName || item.sourceValue} · ${item.targetTaxonomy || item.targetScope}`, item.status));
    exceptions.section.append(exceptionRows);
    detail.append(exceptions.section);
  }
}

function relationRow(titleText, metaText, statusText, actionText = null) {
  const row = document.createElement("div");
  row.className = "relation-row";
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = titleText || "—";
  const meta = document.createElement("span");
  meta.textContent = metaText || "";
  copy.append(title, meta);
  const side = document.createElement("div");
  side.className = "relation-actions";
  side.append(badge(statusText === "active" ? "Активно" : statusText === "ignored" ? "Игнор" : "Отключено"));
  if (actionText) {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "button quiet small-button";
    action.textContent = actionText;
    side.append(action);
  }
  row.append(copy, side);
  return row;
}

function conditionSummary(conditions) {
  return (conditions ?? []).map((item) => `${conditionFieldLabel(item.field)} ${conditionOperatorLabel(item.operator)} «${item.value}»`).join(" · ") || "Без условий";
}

const ruleFieldLabels = {
  sourceValue: "Исходное значение",
  scope: "Область",
  subjectKind: "Сущность",
  "context.brand": "Бренд",
  "context.family": "Семейство модели",
  "context.productType": "Тип товара",
  "context.productCategory": "Категория товара",
  "context.audience": "Аудитория",
  "evidence.title": "Название товара",
  "evidence.silhouette": "Силуэт",
};

const ruleOperatorLabels = {
  equals: "равно",
  contains: "содержит",
  all_words: "содержит все слова",
  regex: "соответствует выражению",
};

function conditionFieldLabel(field) {
  if (ruleFieldLabels[field]) return ruleFieldLabels[field];
  if (field.startsWith("context.")) return `Контекст: ${field.slice("context.".length)}`;
  if (field.startsWith("evidence.")) return `Данные товара: ${field.slice("evidence.".length)}`;
  return field;
}

function conditionOperatorLabel(operator) {
  return ruleOperatorLabels[operator] ?? operator;
}

async function loadRules(reset = true) {
  if (reset) {
    state.ruleOffset = 0;
    state.rules = [];
    byId("rule-list").replaceChildren(loading("Загружаем правила…"));
  }
  const params = new URLSearchParams({ kind: "rule", limit: "50", offset: String(state.ruleOffset) });
  if (state.pendingRuleId) params.set("configId", state.pendingRuleId);
  const values = {
    search: byId("rule-list-search").value.trim(), sourceId: byId("rule-list-source").value,
    typeCode: byId("rule-list-type").value, status: byId("rule-list-status").value,
  };
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  try {
    const response = await api(`/api/classifier/configuration?${params}`);
    state.ruleTotal = Number(response.total ?? 0);
    state.rules.push(...(response.items ?? []));
    state.ruleOffset = state.rules.length;
    renderRuleCatalog();
    if (state.pendingRuleId) {
      const selected = state.rules.find((item) => item.id === state.pendingRuleId);
      state.pendingRuleId = null;
      if (selected) await openRuleDialog({ rule: selected });
    }
  } catch (error) {
    byId("rule-list").replaceChildren(emptyText(error.message));
  }
}

function renderRuleCatalog() {
  const list = byId("rule-list");
  list.replaceChildren();
  for (const rule of state.rules) {
    const row = document.createElement("article");
    row.className = "rule-catalog-row";
    const main = document.createElement("button");
    main.type = "button";
    main.className = "rule-catalog-main";
    const title = document.createElement("strong");
    title.textContent = rule.ruleName;
    const conditions = document.createElement("span");
    conditions.textContent = `${typeName(rule.typeCode)} · ${conditionSummary(rule.conditions)}`;
    const result = document.createElement("span");
    result.className = "catalog-item-flow";
    result.textContent = `→ ${rule.referenceName} · ${rule.affectedProductCount} товаров`;
    main.append(title, conditions, result);
    main.addEventListener("click", () => openRuleDialog({ rule }));
    const status = document.createElement("button");
    status.type = "button";
    status.className = `config-pill ${rule.status}`;
    status.textContent = rule.status === "active" ? "Активно" : "Отключено";
    status.title = rule.status === "active" ? "Отключить правило" : "Включить правило";
    status.addEventListener("click", () => toggleRule(rule));
    row.append(main, status);
    list.append(row);
  }
  if (!state.rules.length) list.append(emptyText("Правила не найдены."));
  byId("rule-more").hidden = state.ruleOffset >= state.ruleTotal;
}

async function toggleRule(rule) {
  const action = rule.status === "active" ? "deactivate" : "reactivate";
  try {
    const response = await api(`/api/classifier/rules/${rule.id}/${action}`, { method: "POST", body: {} });
    showToast(`Правило ${action === "deactivate" ? "отключено" : "включено"}. На пересчёт поставлено товаров: ${response.rule.affectedProductCount}.`);
    await loadRules(true);
  } catch (error) { showToast(error.message); }
}

function populateWordPressEntities() {
  const target = state.targets.find((item) => item.id === byId("wordpress-target")?.value) ?? activeTarget();
  const entity = byId("wordpress-entity");
  if (!entity) return;
  const current = entity.value;
  entity.replaceChildren(...(target?.dictionary?.supportedEntityTypes ?? []).map((value) => new Option(targetEntityLabel(value), value)));
  if ([...entity.options].some((option) => option.value === current)) entity.value = current;
}

function targetEntityLabel(value) {
  return ({ brands: "Бренды", models: "Модели", tags: "Метки", sizes: "Размеры", shoe_heights: "Высота обуви", product_categories: "Категории", colors: "Цвета", materials: "Материалы", seasons: "Сезоны", activities: "Назначение" })[value] || value;
}

async function loadWordPressValues(reset = true) {
  const targetId = byId("wordpress-target").value;
  const entityType = byId("wordpress-entity").value;
  if (!targetId || !entityType) return;
  if (reset) {
    state.wordpressOffset = 0;
    state.wordpressValues = [];
    byId("wordpress-list").replaceChildren(loading("Загружаем справочник WordPress…"));
  }
  const params = new URLSearchParams({ entityType, limit: "100", offset: String(state.wordpressOffset) });
  const search = byId("wordpress-search").value.trim();
  if (search) params.set("search", search);
  try {
    const response = await api(`/api/targets/${targetId}/dictionary?${params}`);
    const items = response.items ?? [];
    state.wordpressValues.push(...items);
    state.wordpressOffset += items.length;
    renderWordPressValues(items.length === 100);
  } catch (error) { byId("wordpress-list").replaceChildren(emptyText(error.message)); }
}

function renderWordPressValues(hasMore) {
  const list = byId("wordpress-list");
  list.replaceChildren();
  for (const item of state.wordpressValues) {
    const row = document.createElement("div");
    row.className = "wordpress-catalog-row";
    const name = document.createElement("strong");
    name.textContent = item.name;
    const taxonomy = document.createElement("span");
    taxonomy.textContent = [item.taxonomy, item.slug].filter(Boolean).join(" · ") || "Без taxonomy";
    const id = document.createElement("code");
    id.textContent = `term #${item.externalId}`;
    row.append(name, taxonomy, id);
    list.append(row);
  }
  if (!state.wordpressValues.length) list.append(emptyText("Термины не найдены."));
  byId("wordpress-more").hidden = !hasMore;
}

function openAssignmentDialog(reference, options = {}) {
  const target = activeTarget();
  if (!target) return;
  state.assignmentReference = reference;
  state.assignmentTerm = null;
  state.assignmentPreview = null;
  state.assignmentMode = options.mode ?? "additional";
  state.assignmentOutput = options.output ?? null;
  byId("assignment-title").textContent = state.assignmentMode === "primary" ? "Основное назначение" : "Дополнительное назначение";
  byId("assignment-reference").textContent = state.assignmentMode === "primary"
    ? `Выберите основное значение WordPress для внутреннего значения «${reference.name}».`
    : `Внутреннее значение «${reference.name}» будет получать ещё один термин WordPress во всех случаях распознавания.`;
  const scope = byId("assignment-scope");
  const capabilities = state.assignmentMode === "primary"
    ? allCapabilities().filter((item) => item.typeCode === reference.typeCode)
    : capabilitiesByTargetScope();
  scope.replaceChildren(...capabilities.map((item) => new Option(`${targetScopeLabel(item.targetScope)} · ${item.targetScope}`, item.targetScope, false, item.targetScope === state.assignmentOutput?.targetScope)));
  scope.disabled = state.assignmentMode === "primary";
  byId("assignment-search").value = state.assignmentOutput?.label ?? reference.name;
  byId("assignment-preview").hidden = true;
  byId("assignment-save").disabled = true;
  clearError(byId("assignment-error"));
  byId("assignment-dialog").showModal();
  void loadAssignmentTerms();
}

async function loadAssignmentTerms() {
  const target = activeTarget();
  const capability = capabilitiesByTargetScope().find((item) => item.targetScope === byId("assignment-scope").value);
  if (!target || !capability) return;
  state.assignmentTerm = null;
  state.assignmentPreview = null;
  byId("assignment-check").disabled = true;
  byId("assignment-save").disabled = true;
  const results = byId("assignment-results");
  results.replaceChildren(loading("Ищем термины…"));
  try {
    const params = new URLSearchParams({ entityType: capability.entityType, search: byId("assignment-search").value.trim(), limit: "100" });
    const response = await api(`/api/targets/${target.id}/dictionary?${params}`);
    results.replaceChildren();
    for (const item of response.items ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mapping-result";
      button.textContent = `${item.name} · term #${item.externalId}`;
      button.addEventListener("click", () => {
        state.assignmentTerm = item;
        for (const node of results.children) node.classList.toggle("selected", node === button);
        byId("assignment-check").disabled = false;
        byId("assignment-save").disabled = true;
      });
      results.append(button);
    }
    if (!results.childElementCount) results.append(emptyText("Термины не найдены."));
  } catch (error) { results.replaceChildren(emptyText(error.message)); }
}

function assignmentBody() {
  return {
    targetId: activeTarget().id, referenceValueId: state.assignmentReference.id,
    targetScope: byId("assignment-scope").value, dictionaryValueId: state.assignmentTerm.id,
  };
}

async function previewAssignment() {
  if (!state.assignmentTerm) return;
  try {
    const previewUrl = state.assignmentMode === "primary" && state.assignmentOutput
      ? `/api/classifier/target-mappings/${state.assignmentOutput.id}/preview`
      : "/api/classifier/reference-projections/preview";
    const previewBody = state.assignmentMode === "primary" && state.assignmentOutput
      ? { dictionaryValueId: state.assignmentTerm.id }
      : assignmentBody();
    const response = await api(previewUrl, { method: "POST", body: previewBody });
    state.assignmentPreview = response.preview;
    renderProjectionPreview(response.preview, byId("assignment-preview"));
    byId("assignment-save").disabled = (state.assignmentMode === "additional" && Boolean(response.preview.duplicate))
      || (response.preview.cardinalityConflicts?.length ?? 0) > 0;
  } catch (error) { showError(byId("assignment-error"), error.message); }
}

async function saveAssignment(event) {
  event.preventDefault();
  if (!state.assignmentPreview || !state.assignmentTerm) return;
  try {
    let url = "/api/classifier/reference-projections";
    let method = "POST";
    let body = assignmentBody();
    if (state.assignmentMode === "primary") {
      if (state.assignmentOutput) {
        url = `/api/classifier/target-mappings/${state.assignmentOutput.id}`;
        method = "PATCH";
        body = { dictionaryValueId: state.assignmentTerm.id };
      } else {
        url = "/api/classifier/target-mappings";
        body = { ...assignmentBody(), typeCode: state.assignmentReference.typeCode };
      }
    }
    const response = await api(url, { method, body });
    byId("assignment-dialog").close();
    const result = state.assignmentMode === "primary" ? response.mapping : response.projection;
    showToast(`Назначение сохранено. На пересчёт поставлено товаров: ${result.affectedProductCount}.`);
    await loadReferences(true);
    const refreshed = state.references.find((item) => item.id === state.assignmentReference.id);
    if (refreshed) await selectReference(refreshed);
  } catch (error) { showError(byId("assignment-error"), error.message); }
}

async function deactivateReferenceAssignment(item) {
  try {
    const referenceId = state.selectedReference?.id;
    const response = await api(`/api/targets/${item.targetId}/reference-projections/${item.id}/deactivate`, { method: "POST", body: {} });
    showToast(`Назначение отключено. На пересчёт поставлено товаров: ${response.projection.affectedProductCount}.`);
    await loadReferences(true);
    const refreshed = state.references.find((reference) => reference.id === referenceId);
    if (refreshed) await selectReference(refreshed);
  } catch (error) { showToast(error.message); }
}

function loading(text) {
  const element = document.createElement("div");
  element.className = "loading";
  element.textContent = text;
  return element;
}

function emptyText(text) {
  const element = document.createElement("div");
  element.className = "queue-empty";
  element.textContent = text;
  return element;
}

function closeDialog(selector) {
  for (const button of document.querySelectorAll(selector)) {
    button.addEventListener("click", () => button.closest("dialog").close());
  }
}

byId("login-form").addEventListener("submit", login);
byId("logout-button").addEventListener("click", logout);
byId("refresh-button").addEventListener("click", () => loadQueue({ preserveSelection: true }));
byId("sync-button").addEventListener("click", () => syncWordPress());
byId("queue-search").addEventListener("input", () => {
  clearQueueDeepLink();
  state.queueRequestId += 1;
  clearTimeout(queueSearchTimer);
  queueSearchTimer = setTimeout(() => loadQueue(), 280);
});
byId("type-filter").addEventListener("change", () => { clearQueueDeepLink(); loadQueue(); });
byId("status-filter").addEventListener("change", () => { clearQueueDeepLink(); loadQueue(); });
byId("queue-list").addEventListener("scroll", maybeLoadNextQueuePage, { passive: true });
byId("mapping-search").addEventListener("input", () => {
  resetDecisionPreview();
  clearTimeout(mappingSearchTimer);
  mappingSearchTimer = setTimeout(loadMappingResults, 250);
});
byId("projection-scope").addEventListener("change", loadProjectionResults);
byId("projection-search").addEventListener("input", () => {
  clearTimeout(projectionSearchTimer);
  projectionSearchTimer = setTimeout(loadProjectionResults, 250);
});
byId("preview-projection").addEventListener("click", previewProjection);
byId("create-projection").addEventListener("click", createProjection);
for (const tab of byId("mapping-tabs").querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    if (tab.disabled) return;
    state.mappingMode = tab.dataset.mode;
    state.selectedMapping = null;
    state.currentReferenceId = null;
    resetDecisionPreview();
    updateMappingModeAvailability();
    void loadMappingResults();
  });
}
byId("confirm-button").addEventListener("click", () => confirmDecision("confirm"));
byId("ignore-button").addEventListener("click", () => confirmDecision("ignore"));
byId("product-count").addEventListener("click", openReviewProductsDialog);
byId("review-products-search").addEventListener("input", () => {
  state.reviewProductsRequestId += 1;
  clearTimeout(reviewProductsSearchTimer);
  reviewProductsSearchTimer = setTimeout(() => loadReviewProducts(true), 280);
});
byId("review-products-more").addEventListener("click", () => loadReviewProducts(false));
byId("next-button").addEventListener("click", nextItem);
byId("open-create-term").addEventListener("click", openCreateTerm);
byId("create-term-form").addEventListener("submit", createTerm);
byId("advanced-rule-button").addEventListener("click", openRuleDialog);
byId("success-rule-button").addEventListener("click", openRuleDialog);
byId("add-condition").addEventListener("click", () => {
  byId("conditions-list").append(conditionRow());
  resetRulePreview();
});
byId("preview-rule").addEventListener("click", previewRule);
byId("rule-form").addEventListener("submit", createRule);
byId("rule-name").addEventListener("input", resetRulePreview);
byId("rule-priority").addEventListener("input", resetRulePreview);
byId("rule-source").addEventListener("change", () => {
  if (!state.ruleEditorContext) return;
  state.ruleEditorContext.sourceId = byId("rule-source").value;
  const current = [...byId("conditions-list").querySelectorAll(".condition-row")].map((row) => ({
    field: row.querySelector(".condition-field").value,
    operator: row.querySelector(".condition-operator").value,
    value: row.querySelector(".condition-value").value,
  }));
  state.ruleEditorFields = [...new Set(["sourceValue", "scope", "subjectKind", ...current.map((condition) => condition.field)])];
  renderConditions(current);
  resetRulePreview();
  void loadRuleEditorFields(state.ruleEditorContext.sourceId, state.ruleEditorContext.typeCode);
});
for (const button of document.querySelectorAll("[data-classification-view]")) {
  button.addEventListener("click", () => { void switchClassificationView(button.dataset.classificationView); });
}
byId("reference-search").addEventListener("input", () => {
  clearTimeout(catalogSearchTimer);
  catalogSearchTimer = setTimeout(() => loadReferences(true), 280);
});
byId("reference-type").addEventListener("change", () => loadReferences(true));
byId("reference-more").addEventListener("click", () => loadReferences(false));
byId("rule-list-filters").addEventListener("input", () => {
  clearTimeout(catalogSearchTimer);
  catalogSearchTimer = setTimeout(() => loadRules(true), 280);
});
byId("rule-more").addEventListener("click", () => loadRules(false));
byId("new-rule-button").addEventListener("click", async () => {
  await switchClassificationView("references");
  showToast("Выберите внутреннее значение и нажмите «+ Правило распознавания».");
});
byId("wordpress-target").addEventListener("change", () => { populateWordPressEntities(); void loadWordPressValues(true); });
byId("wordpress-entity").addEventListener("change", () => loadWordPressValues(true));
byId("wordpress-search").addEventListener("input", () => {
  clearTimeout(catalogSearchTimer);
  catalogSearchTimer = setTimeout(() => loadWordPressValues(true), 280);
});
byId("wordpress-more").addEventListener("click", () => loadWordPressValues(false));
byId("wordpress-sync-button").addEventListener("click", async () => {
  const target = state.targets.find((item) => item.id === byId("wordpress-target").value) ?? activeTarget();
  await syncWordPress(byId("wordpress-sync-button"), target);
  await loadWordPressValues(true);
});
byId("assignment-scope").addEventListener("change", loadAssignmentTerms);
byId("assignment-search").addEventListener("input", () => {
  clearTimeout(catalogSearchTimer);
  catalogSearchTimer = setTimeout(loadAssignmentTerms, 250);
});
byId("assignment-check").addEventListener("click", previewAssignment);
byId("assignment-form").addEventListener("submit", saveAssignment);
closeDialog(".close-dialog");
closeDialog(".close-rule");
closeDialog(".close-assignment");
closeDialog(".close-review-products");
byId("rule-dialog").addEventListener("close", () => {
  state.ruleFieldsRequestId += 1;
  byId("rule-fields-loading").hidden = true;
});
byId("review-products-dialog").addEventListener("close", () => {
  state.reviewProductsRequestId += 1;
  state.reviewProductsItem = null;
});

applyQueueDeepLink();

restoreSession().catch((error) => {
  showLogin();
  showError(byId("login-error"), error.message);
});
