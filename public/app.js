const byId = (id) => document.getElementById(id);

const state = {
  session: null,
  csrfToken: null,
  queue: [],
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
};

function applyQueueDeepLink() {
  const params = new URLSearchParams(location.search);
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
  if (status === "unresolved" || status === "ambiguous") byId("status-filter").value = status;
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
  const [targets] = await Promise.all([loadTargets(), loadQueue()]);
  if (state.pendingQueueSelection) {
    const requested = state.pendingQueueSelection;
    const item = state.queue.find((entry) =>
      (!requested.typeCode || entry.typeCode === requested.typeCode)
      && (!requested.status || entry.status === requested.status)
      && (!requested.contextKey || entry.contextKey === requested.contextKey));
    state.pendingQueueSelection = null;
    if (item) selectQueueItem(item);
  }
  return targets;
}

async function loadTargets() {
  const response = await api("/api/targets");
  state.targets = response.items ?? [];
  const configured = state.targets.some((target) => target.dictionary?.configured);
  byId("sync-button").hidden = !configured;
  return state.targets;
}

function queueUrl() {
  const parameters = new URLSearchParams({ limit: "200" });
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
  const list = byId("queue-list");
  list.replaceChildren(loading("Загружаем очередь…"));
  try {
    const response = await api(queueUrl());
    state.queue = response.items ?? [];
    for (const item of state.queue) state.typeNames.set(item.typeCode, item.typeName || item.typeCode);
    populateTypeFilter();
    if (preserveSelection && state.selected) {
      state.selected = state.queue.find((item) => decisionKey(item) === decisionKey(state.selected)) ?? null;
    }
    renderQueue();
    if (state.selected) renderDetail();
  } catch (error) {
    list.replaceChildren(emptyText(error.message));
  }
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
  byId("queue-count").textContent = String(state.queue.length);
  if (state.queue.length === 0) {
    list.append(emptyText("В этой выборке ничего не ожидает решения."));
    state.selected = null;
    showEmptyDetail();
    return;
  }
  for (const item of state.queue) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `queue-item${state.selected && decisionKey(state.selected) === decisionKey(item) ? " active" : ""}`;
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
    list.append(button);
  }
}

function selectQueueItem(item) {
  state.selected = item;
  state.selectedMapping = null;
  state.decisionPreview = null;
  state.currentReferenceId = null;
  state.currentResolution = null;
  state.selectedProjectionTerm = null;
  state.projectionPreview = null;
  state.resolved = false;
  renderQueue();
  renderDetail();
  byId("mapping-search").value = item.sourceValue;
  void loadMappingResults();
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
  byId("product-count").textContent = `${item.productCount} товаров`;
  const badges = byId("detail-badges");
  badges.replaceChildren(
    badge(typeName(item)),
    badge(item.sourceCode),
    badge(item.status === "ambiguous" ? "Конфликт правил" : "Не сопоставлено", item.status === "ambiguous"),
  );
  renderExamples(item, item.examples ?? []);
  byId("decision-actions").hidden = state.resolved;
  byId("decision-success").hidden = !state.resolved;
  byId("ignore-button").disabled = state.resolved;
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

function dictionaryEntity(item = state.selected) {
  return activeCapability(item)?.entityType ?? null;
}

function targetScope(item = state.selected) {
  return activeCapability(item)?.targetScope ?? item?.scope;
}

function updateMappingModeAvailability() {
  const wordpressTab = byId("mapping-tabs").querySelector('[data-mode="wordpress"]');
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
  button.disabled = true;
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
        : `Будет сохранено сопоставление только для текущего контекста (${contextSummary(item.context)}). На обработку будет поставлено товаров: ${response.preview.productCount}. WordPress сейчас не изменяется.`;
      preview.hidden = false;
      button.textContent = "Сохранить точное сопоставление";
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
    showToast(action === "ignore" ? "Значение будет игнорироваться." : "Основная связь сохранена. Ниже можно добавить категории, метки или другие назначения WordPress.");
  } catch (error) {
    showToast(error.message);
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

async function syncWordPress() {
  const target = activeTarget();
  if (!target?.dictionary?.configured) return;
  const button = byId("sync-button");
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

function openRuleDialog() {
  const item = state.selected;
  if (!item) return;
  const selectedTargetScope = targetScope(item);
  const canUseSelectedTarget = Boolean(state.mappingMode === "wordpress" && state.selectedMapping !== null && activeTarget() !== null && selectedTargetScope);
  if (!state.currentReferenceId && !canUseSelectedTarget) {
    showToast("Сначала выберите результат правила во внутреннем справочнике или WordPress.");
    return;
  }
  state.rulePreview = null;
  byId("rule-name").value = `${typeName(item)}: ${item.sourceValue}`;
  byId("rule-preview").hidden = true;
  byId("create-rule").disabled = true;
  clearError(byId("rule-error"));
  const result = byId("rule-result");
  const selectedName = state.selectedMapping?.name;
  result.textContent = canUseSelectedTarget
    ? `Результат правила: ${selectedName} · ${selectedTargetScope}. Точное сопоставление «${item.sourceValue}» создано не будет.`
    : `Результат правила: ${selectedName ?? `внутреннее значение #${state.currentReferenceId}`}.`;
  const conditions = suggestedConditions(item);
  renderConditions(conditions.length ? conditions : [{ field: "sourceValue", operator: "equals", value: item.sourceValue }]);
  byId("rule-dialog").showModal();
}

function suggestedConditions(item) {
  const conditions = [];
  if (item.typeCode === "category") {
    conditions.push({ field: "sourceValue", operator: "equals", value: item.sourceValue });
    for (const key of ["productType", "productCategory", "audience"]) {
      if (typeof item.context?.[key] === "string" && item.context[key]) {
        conditions.push({ field: `context.${key}`, operator: "equals", value: item.context[key] });
      }
    }
    return conditions;
  }
  if (typeof item.context?.brand === "string" && item.context.brand) {
    conditions.push({ field: "context.brand", operator: "equals", value: item.context.brand });
  }
  const title = item.examples?.[0]?.evidence?.title;
  if (typeof title === "string" && title) {
    conditions.push({ field: "evidence.title", operator: "contains", value: item.sourceValue });
  }
  return conditions;
}

function availableRuleFields() {
  const item = state.selected;
  const fields = ["sourceValue", "scope", "subjectKind"];
  for (const key of Object.keys(item?.context ?? {})) fields.push(`context.${key}`);
  for (const key of Object.keys(item?.examples?.[0]?.evidence ?? {})) fields.push(`evidence.${key}`);
  return [...new Set(fields)];
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
  for (const value of availableRuleFields()) field.append(new Option(value, value, false, value === condition.field));
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
  const item = state.selected;
  const conditions = [...byId("conditions-list").querySelectorAll(".condition-row")].map((row) => ({
    field: row.querySelector(".condition-field").value,
    operator: row.querySelector(".condition-operator").value,
    value: row.querySelector(".condition-value").value,
  }));
  const result = {
    sourceId: item.sourceId,
    typeCode: item.typeCode,
    name: byId("rule-name").value.trim(),
    priority: 100,
    conditions,
  };
  if (state.currentReferenceId) result.referenceValueId = state.currentReferenceId;
  else {
    const target = activeTarget();
    result.targetLink = {
      targetId: target.id,
      targetScope: targetScope(item),
      dictionaryValueId: state.selectedMapping.id,
    };
  }
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
    const response = await api("/api/classifier/rules", { method: "POST", body: ruleDraft() });
    state.currentReferenceId = response.rule.referenceValueId;
    state.currentResolution = { kind: "rule", id: response.rule.ruleId };
    byId("rule-dialog").close();
    renderProjectionSection();
    await loadProjections();
    showToast(`Правило создано без точного сопоставления. На обработку поставлено товаров: ${response.rule.affectedProductCount}. Счётчик «применено» обновится после обработки очереди.`);
  } catch (error) {
    showError(byId("rule-error"), error.message);
    button.disabled = false;
  }
}

function renderProjectionSection() {
  const section = byId("projection-section");
  const target = activeTarget();
  const resolution = state.currentResolution;
  section.hidden = !target?.dictionary?.configured || !resolution;
  if (section.hidden) return;
  byId("projection-origin").textContent = `${resolution.kind} #${resolution.id}`;
  const select = byId("projection-scope");
  const current = select.value;
  select.replaceChildren();
  for (const capability of allCapabilities()) {
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
  return allCapabilities().find((capability) => capability.targetScope === scope)?.entityType ?? null;
}

async function loadProjections() {
  const target = activeTarget();
  const resolution = state.currentResolution;
  const list = byId("projection-list");
  if (!target || !resolution) return;
  list.replaceChildren(loading("Загружаем дополнительные назначения…"));
  try {
    const params = new URLSearchParams({ targetId: target.id, resolutionKind: resolution.kind, resolutionId: resolution.id });
    const response = await api(`/api/classifier/projections?${params}`);
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
  const resolution = state.currentResolution;
  return {
    targetId: target.id,
    resolutionKind: resolution.kind,
    resolutionId: resolution.id,
    targetScope: byId("projection-scope").value,
    dictionaryValueId: state.selectedProjectionTerm.id,
  };
}

async function previewProjection() {
  if (!state.selectedProjectionTerm || !state.currentResolution) return;
  const button = byId("preview-projection");
  button.disabled = true;
  clearError(byId("projection-error"));
  try {
    const response = await api("/api/classifier/projections/preview", { method: "POST", body: projectionBody() });
    state.projectionPreview = response.preview;
    renderProjectionPreview(response.preview);
    byId("create-projection").disabled = Boolean(response.preview.duplicate) || (response.preview.cardinalityConflicts?.length || 0) > 0;
  } catch (error) {
    showError(byId("projection-error"), error.message);
  } finally {
    button.disabled = false;
  }
}

function renderProjectionPreview(preview) {
  const box = byId("projection-preview");
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
    const response = await api("/api/classifier/projections", { method: "POST", body: projectionBody() });
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
    const response = await api(`/api/targets/${target.id}/classification-projections/${projectionId}/deactivate`, { method: "POST", body: {} });
    showToast(`Дополнительное назначение отключено. На обработку поставлено товаров: ${response.projection.affectedProductCount}.`);
    await loadProjections();
  } catch (error) {
    showToast(error.message);
  }
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
byId("sync-button").addEventListener("click", syncWordPress);
byId("queue-search").addEventListener("input", () => {
  clearQueueDeepLink();
  clearTimeout(queueSearchTimer);
  queueSearchTimer = setTimeout(() => loadQueue(), 280);
});
byId("type-filter").addEventListener("change", () => { clearQueueDeepLink(); loadQueue(); });
byId("status-filter").addEventListener("change", () => { clearQueueDeepLink(); loadQueue(); });
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
closeDialog(".close-dialog");
closeDialog(".close-rule");

applyQueueDeepLink();

restoreSession().catch((error) => {
  showLogin();
  showError(byId("login-error"), error.message);
});
