const fieldLabels = { description: "Описание", short_description: "Краткое описание" };

const state = {
  session: null,
  targets: [],
  targetId: "",
  field: "description",
  catalog: null,
  categories: [],
  previewController: null,
  previewRequest: 0,
  fields: {
    description: { versions: [], profileKey: "default", selectedVersion: null, transient: null, baseline: null, preview: null },
    short_description: { versions: [], profileKey: "default", selectedVersion: null, transient: null, baseline: null, preview: null },
  },
};

const byId = (id) => document.getElementById(id);
const currentState = () => state.fields[state.field];

async function api(url, options = {}) {
  const headers = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.method && options.method !== "GET" && state.session?.csrfToken) headers["X-CSRF-Token"] = state.session.csrfToken;
  const response = await fetch(url, {
    credentials: "same-origin",
    headers,
    ...options,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function toast(message) {
  byId("toast").textContent = message;
  byId("toast").hidden = false;
  setTimeout(() => { byId("toast").hidden = true; }, 2800);
}

function showError(message) {
  byId("page-error").textContent = message;
  byId("page-error").hidden = false;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString("ru-RU") : "—";
}

function implicitProfile(field) {
  const managed = field === "description";
  return {
    id: null,
    field,
    profileKey: "default",
    profileName: "Основной профиль",
    managementMode: managed ? "manage" : "preserve",
    categoryTermIds: [],
    requiredContextPaths: [],
    name: managed ? "Системный шаблон описания" : "Пример краткого описания",
    templateSource: state.catalog?.defaults?.[field] || "",
    status: "system",
    revision: 0,
  };
}

function latestProfiles(fieldState = currentState()) {
  const profiles = new Map();
  for (const version of fieldState.versions) {
    if (!profiles.has(version.profileKey)) profiles.set(version.profileKey, version);
  }
  if (!profiles.has("default")) profiles.set("default", implicitProfile(state.field));
  if (fieldState.transient) profiles.set(fieldState.transient.profileKey, fieldState.transient);
  return [...profiles.values()];
}

function versionsForProfile(profileKey = currentState().profileKey) {
  return currentState().versions.filter((version) => version.profileKey === profileKey);
}

function selectedCategoryIds() {
  return [...byId("profile-categories").selectedOptions].map((option) => Number(option.value));
}

function selectedRequirements() {
  return [...document.querySelectorAll("[data-requirement-path]")]
    .filter((input) => input.checked)
    .map((input) => input.dataset.requirementPath);
}

function editorSnapshot() {
  return {
    profileKey: currentState().profileKey,
    profileName: byId("profile-name").value.trim(),
    managementMode: byId("management-enabled").checked ? "manage" : "preserve",
    categoryTermIds: selectedCategoryIds().sort((left, right) => left - right),
    requiredContextPaths: selectedRequirements().sort(),
    name: byId("template-name").value.trim(),
    templateSource: byId("template-source").value,
  };
}

function sameSnapshot(left, right) {
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

function isDirty(fieldState = currentState()) {
  return !sameSnapshot(fieldState.baseline, editorSnapshot());
}

function templateBody() {
  return {
    targetId: state.targetId,
    sourceProductId: byId("preview-product-id").value.trim(),
    field: state.field,
    ...editorSnapshot(),
  };
}

function previewKey(body = templateBody()) {
  return JSON.stringify(body);
}

function updateProductLink() {
  const productId = byId("preview-product-id").value.trim();
  byId("open-product-link").href = productId ? `/products/${encodeURIComponent(productId)}` : "/products";
  localStorage.setItem("content-template-product-id", productId);
}

function insertAtCursor(text) {
  const editor = byId("template-source");
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  editor.setRangeText(text, start, end, "end");
  editor.focus();
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function renderReference() {
  const container = byId("variable-groups");
  container.replaceChildren();
  const grouped = new Map();
  for (const variable of state.catalog.variables || []) {
    if (!grouped.has(variable.group)) grouped.set(variable.group, []);
    grouped.get(variable.group).push(variable);
  }
  for (const [groupName, variables] of grouped) {
    const group = element("section", "template-variable-group");
    group.append(element("h4", "", groupName));
    for (const variable of variables) {
      const button = element("button", "template-variable-button");
      button.type = "button";
      button.title = `Пример: ${variable.example}`;
      button.append(element("span", "", variable.label), element("code", "", `{{ ${variable.path} }}`));
      button.addEventListener("click", () => insertAtCursor(`{{ ${variable.path} }}`));
      group.append(button);
    }
    container.append(group);
  }

  const helpers = byId("helper-list");
  helpers.replaceChildren();
  for (const helper of state.catalog.helpers || []) {
    const button = element("button", "template-code-example");
    button.type = "button";
    button.append(element("code", "", helper.example), element("span", "", helper.label));
    button.addEventListener("click", () => insertAtCursor(helper.example));
    helpers.append(button);
  }

  const requirements = byId("profile-requirements");
  requirements.replaceChildren();
  for (const requirement of state.catalog.requirements || []) {
    const label = element("label", "template-requirement");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.requirementPath = requirement.path;
    input.addEventListener("change", editorChanged);
    label.append(input, element("span", "", requirement.label));
    requirements.append(label);
  }
}

function renderCategoryOptions(selected = []) {
  const select = byId("profile-categories");
  const selectedSet = new Set(selected.map(Number));
  const values = new Map(state.categories.map((category) => [Number(category.externalId), category]));
  for (const termId of selectedSet) {
    if (!values.has(termId)) values.set(termId, { externalId: String(termId), name: `Категория #${termId}` });
  }
  const options = [...values.values()]
    .sort((left, right) => String(left.name).localeCompare(String(right.name), "ru"))
    .map((category) => {
      const option = element("option", "", `${category.name} · #${category.externalId}`);
      option.value = String(category.externalId);
      option.selected = selectedSet.has(Number(category.externalId));
      return option;
    });
  select.replaceChildren(...options);
}

function renderProfileSelect() {
  const select = byId("profile-select");
  const options = latestProfiles().map((profile) => {
    const option = element("option", "", profile.profileName);
    option.value = profile.profileKey;
    return option;
  });
  select.replaceChildren(...options);
  select.value = currentState().profileKey;
}

function applyRequirementSelection(paths) {
  const selected = new Set(paths || []);
  for (const input of document.querySelectorAll("[data-requirement-path]")) input.checked = selected.has(input.dataset.requirementPath);
}

function editorStatus() {
  const selected = currentState().selectedVersion;
  const dirty = isDirty();
  const badge = byId("editor-state");
  if (dirty) {
    badge.textContent = "Есть несохранённые изменения";
    badge.className = "badge warning";
  } else if (selected?.status === "active") {
    badge.textContent = `Активна · rev ${selected.revision}`;
    badge.className = "badge status-completed";
  } else if (selected?.status === "draft") {
    badge.textContent = `Черновик · rev ${selected.revision}`;
    badge.className = "badge status-pending";
  } else if (state.field === "description") {
    badge.textContent = "Системный шаблон";
    badge.className = "badge status-completed";
  } else {
    badge.textContent = "Системный пример · не активен";
    badge.className = "badge";
  }
  const mode = byId("management-enabled").checked;
  const categories = selectedCategoryIds();
  byId("policy-state").textContent = `${mode ? "Поле управляется" : "Поле сохраняется без изменений"}. ${categories.length ? `Профиль применяется к выбранным категориям: ${categories.map((id) => `#${id}`).join(", ")}.` : "Это профиль по умолчанию для категорий без отдельного правила."}`;
}

function invalidatePreview(message = "Настройки изменились. Запустите проверку заново.") {
  state.previewController?.abort();
  state.previewController = null;
  state.previewRequest++;
  byId("preview-comparison").hidden = true;
  byId("preview-context-details").hidden = true;
  byId("preview-policy").hidden = true;
  byId("preview-badge").textContent = "Не проверено";
  byId("preview-badge").className = "badge";
  byId("preview-message").textContent = message;
  byId("validation-state").textContent = "Изменения ещё не проверены";
}

function editorChanged() {
  editorStatus();
  invalidatePreview();
}

function applyEditor(value, selectedVersion = null) {
  const fieldState = currentState();
  fieldState.profileKey = value.profileKey;
  fieldState.selectedVersion = selectedVersion;
  byId("profile-name").value = value.profileName;
  byId("management-enabled").checked = value.managementMode === "manage";
  renderCategoryOptions(value.categoryTermIds);
  applyRequirementSelection(value.requiredContextPaths);
  byId("template-name").value = value.name;
  byId("template-source").value = value.templateSource;
  fieldState.baseline = editorSnapshot();
  renderProfileSelect();
  renderVersions();
  editorStatus();
  restorePreview();
}

function selectProfile(profileKey) {
  const fieldState = currentState();
  const versions = fieldState.versions.filter((version) => version.profileKey === profileKey);
  const selected = versions.find((version) => version.status === "active") || versions[0] || null;
  const profile = selected || (fieldState.transient?.profileKey === profileKey ? fieldState.transient : implicitProfile(state.field));
  applyEditor(profile, selected);
}

function loadVersion(version) {
  if (isDirty() && !confirm("Заменить несохранённые изменения выбранной версией?")) return;
  currentState().transient = null;
  applyEditor(version, version);
}

function renderVersions() {
  const list = byId("versions-list");
  list.replaceChildren();
  const versions = versionsForProfile();
  byId("versions-count").textContent = String(versions.length);
  if (!versions.length) {
    const message = state.field === "description"
      ? "Сохранённых версий профиля пока нет. Используется системный шаблон."
      : "Сохранённых версий профиля пока нет. Краткое описание сохраняется без изменений.";
    list.append(element("p", "muted", message));
    return;
  }
  for (const version of versions) {
    const row = element("article", `template-version-row${currentState().selectedVersion?.id === version.id ? " selected" : ""}`);
    const main = element("button", "template-version-main");
    main.type = "button";
    main.append(element("strong", "", version.name), element("span", "", `rev ${version.revision} · ${formatDate(version.createdAt)} · ${version.actor}`));
    main.addEventListener("click", () => loadVersion(version));
    const status = element("span", `badge ${version.status === "active" ? "status-completed" : version.status === "draft" ? "status-pending" : ""}`, version.status === "active" ? "Активна" : version.status === "draft" ? "Черновик" : "Архив");
    row.append(main, status);
    if (version.status !== "active") {
      const activate = element("button", "button secondary small-button", "Активировать");
      activate.type = "button";
      activate.addEventListener("click", () => activateVersion(version, activate));
      row.append(activate);
    }
    list.append(row);
  }
}

async function loadVersions(field) {
  const parameters = new URLSearchParams({ targetId: state.targetId, field });
  const response = await api(`/api/content-templates?${parameters}`);
  state.fields[field].versions = response.items || [];
  state.fields[field].transient = null;
}

async function loadCategories() {
  const parameters = new URLSearchParams({ entityType: "product_categories", limit: "200" });
  const response = await api(`/api/targets/${encodeURIComponent(state.targetId)}/dictionary?${parameters}`);
  state.categories = response.items || [];
}

function iframeDocument(html) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>body{margin:0;padding:18px;font:14px/1.55 system-ui,sans-serif;color:#20242d}h2,h3{line-height:1.25;margin:0 0 12px}p{margin:0 0 12px}ul,ol{padding-left:22px}li{margin:5px 0}a{color:#176b52}</style></head><body>${html || '<span style="color:#78818e">Поле пустое</span>'}</body></html>`;
}

function selectionMessage(selection) {
  if (!selection) return "Правило применения не определено.";
  if (selection.reason === "matched") return `Профиль «${selection.profileName}» управляет этим полем.`;
  if (selection.reason === "system_default") return "Используется системный шаблон длинного описания.";
  if (selection.reason === "management_disabled") return `Профиль «${selection.profileName}» сохраняет поле WordPress без изменений.`;
  if (selection.reason === "requirements_missing") {
    const labels = new Map((state.catalog.requirements || []).map((item) => [item.path, item.label]));
    return `Поле сохраняется: отсутствуют обязательные данные — ${selection.missingContextPaths.map((path) => labels.get(path) || path).join(", ")}.`;
  }
  return "Подходящий профиль не найден: поле WordPress сохраняется без изменений.";
}

function renderPreview(item, field, key) {
  if (field !== state.field || key !== previewKey()) return;
  const fieldKey = field === "description" ? "description_html" : "short_description_html";
  const before = item.current?.product?.[fieldKey] || "";
  const after = item.proposed?.fields?.[fieldKey] || "";
  byId("preview-before").srcdoc = iframeDocument(before);
  byId("preview-after").srcdoc = iframeDocument(after);
  byId("preview-comparison").hidden = false;
  const blockers = item.readiness?.blockers || [];
  byId("preview-badge").textContent = item.readiness?.ready ? "Payload готов" : `Блокеров: ${blockers.length}`;
  byId("preview-badge").className = `badge ${item.readiness?.ready ? "status-completed" : "status-pending"}`;
  byId("preview-message").textContent = blockers.length
    ? `Шаблон проверен. Экспорт товара пока блокируют: ${blockers.map((blocker) => blocker.message).join("; ")}`
    : "Шаблон отрендерен полными данными реального WordPress payload. Запись в WordPress не выполнялась.";
  const selection = item.proposed?.contentTemplateSelections?.[field];
  byId("preview-policy").textContent = selectionMessage(selection);
  byId("preview-policy").hidden = false;
  const context = item.proposed?.contentContext;
  byId("preview-context-details").hidden = !context;
  byId("preview-context").textContent = context ? JSON.stringify(context, null, 2) : "";
  byId("validation-state").textContent = "Шаблон и правило применения проверены на товаре";
  currentState().preview = { item, key };
}

function restorePreview() {
  const saved = currentState().preview;
  if (saved && saved.key === previewKey()) renderPreview(saved.item, state.field, saved.key);
  else invalidatePreview("Укажите товар и нажмите «Проверить на товаре».");
}

async function preview() {
  const body = templateBody();
  if (!body.sourceProductId) { toast("Укажите sourceProductId товара для проверки"); return; }
  if (!body.name) { toast("Укажите название версии"); return; }
  if (!body.profileName) { toast("Укажите название профиля"); return; }
  state.previewController?.abort();
  const controller = new AbortController();
  state.previewController = controller;
  const requestId = ++state.previewRequest;
  const field = body.field;
  const key = previewKey(body);
  byId("preview-button").disabled = true;
  byId("preview-comparison").hidden = true;
  byId("preview-badge").textContent = "Проверяем…";
  byId("preview-message").textContent = "Собираем реальный payload и выполняем read-only WordPress preflight…";
  try {
    const response = await api("/api/content-templates/preview", { method: "POST", body, signal: controller.signal });
    if (requestId !== state.previewRequest || controller.signal.aborted) return;
    renderPreview(response.item, field, key);
  } catch (error) {
    if (controller.signal.aborted || requestId !== state.previewRequest) return;
    byId("preview-badge").textContent = "Ошибка";
    byId("preview-badge").className = "badge status-failed";
    byId("preview-message").textContent = error.message;
    byId("validation-state").textContent = `Ошибка: ${error.message}`;
  } finally {
    if (requestId === state.previewRequest) {
      state.previewController = null;
      byId("preview-button").disabled = false;
    }
  }
}

async function saveDraft() {
  const body = templateBody();
  delete body.sourceProductId;
  byId("save-button").disabled = true;
  try {
    const response = await api("/api/content-templates/drafts", { method: "POST", body });
    await loadVersions(state.field);
    const saved = currentState().versions.find((version) => version.id === response.item.id);
    if (saved) applyEditor(saved, saved);
    toast("Черновик сохранён. Активная версия не изменилась.");
  } catch (error) {
    toast(error.message);
  } finally {
    byId("save-button").disabled = false;
  }
}

async function activateVersion(version, button) {
  if (isDirty() && !confirm("Есть несохранённые изменения. Активировать выбранную сохранённую версию и отбросить их?")) return;
  const action = version.managementMode === "manage" ? "управлять полем" : "сохранять поле без изменений";
  if (!confirm(`Активировать «${version.name}» rev ${version.revision} в профиле «${version.profileName}»? Профиль будет ${action}.`)) return;
  button.disabled = true;
  try {
    await api(`/api/targets/${encodeURIComponent(state.targetId)}/content-templates/${encodeURIComponent(version.id)}/activate`, { method: "POST", body: {} });
    await loadVersions(state.field);
    selectProfile(version.profileKey);
    toast("Версия активирована. Товары не поставлены на полную переобработку.");
    if (byId("preview-product-id").value.trim()) await preview();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

function newProfile() {
  const profile = {
    ...implicitProfile(state.field),
    profileKey: `profile-${crypto.randomUUID()}`,
    profileName: "Новый профиль",
    managementMode: "manage",
    name: `Шаблон: ${fieldLabels[state.field]}`,
    status: "new",
  };
  currentState().transient = profile;
  applyEditor(profile, null);
  currentState().baseline = null;
  editorStatus();
  invalidatePreview();
  byId("profile-name").focus();
  byId("profile-name").select();
}

function changeField(field) {
  if (field === state.field) return;
  if (isDirty() && !confirm("Переключить поле и отбросить несохранённые изменения?")) return;
  state.previewController?.abort();
  state.previewController = null;
  state.previewRequest++;
  state.field = field;
  for (const tab of document.querySelectorAll(".template-field-tab")) tab.classList.toggle("active", tab.dataset.field === field);
  const profiles = latestProfiles(state.fields[field]);
  const profileKey = profiles.some((profile) => profile.profileKey === state.fields[field].profileKey) ? state.fields[field].profileKey : "default";
  selectProfile(profileKey);
}

async function changeTarget(targetId) {
  if ((isDirty() || Object.values(state.fields).some((fieldState) => fieldState.transient !== null))
    && !confirm("Сменить target и отбросить несохранённые профили?")) {
    byId("target-select").value = state.targetId;
    return;
  }
  state.previewController?.abort();
  state.previewRequest++;
  state.targetId = targetId;
  state.fields.description = { versions: [], profileKey: "default", selectedVersion: null, transient: null, baseline: null, preview: null };
  state.fields.short_description = { versions: [], profileKey: "default", selectedVersion: null, transient: null, baseline: null, preview: null };
  await Promise.all([loadCategories(), loadVersions("description"), loadVersions("short_description")]);
  selectProfile("default");
}

async function initialize() {
  const [targetsResponse, catalog] = await Promise.all([api("/api/targets"), api("/api/content-templates/catalog")]);
  state.targets = (targetsResponse.items || []).filter((target) => target.code === "slamdunk" || target.exporterCode === "wordpress");
  if (!state.targets.length) state.targets = targetsResponse.items || [];
  if (!state.targets.length) throw new Error("WordPress target не настроен");
  state.catalog = catalog;
  const select = byId("target-select");
  select.replaceChildren(...state.targets.map((target) => {
    const option = element("option", "", target.code || target.id);
    option.value = target.id;
    return option;
  }));
  state.targetId = select.value;
  renderReference();
  const queryProductId = new URLSearchParams(location.search).get("productId");
  byId("preview-product-id").value = queryProductId || localStorage.getItem("content-template-product-id") || "";
  updateProductLink();
  await Promise.all([loadCategories(), loadVersions("description"), loadVersions("short_description")]);
  selectProfile("default");
  byId("page-loading").hidden = true;
  byId("template-workspace").hidden = false;
}

async function session() {
  const data = await api("/api/auth/session");
  if (!data.authenticated) {
    byId("login-view").hidden = false;
    byId("app-view").hidden = true;
    return;
  }
  state.session = data;
  byId("operator-name").textContent = data.operator;
  byId("login-view").hidden = true;
  byId("app-view").hidden = false;
  try { await initialize(); } catch (error) { byId("page-loading").hidden = true; showError(error.message); }
}

byId("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    state.session = await api("/api/auth/login", { method: "POST", body: { username: byId("login-username").value, password: byId("login-password").value } });
    byId("login-error").hidden = true;
    await session();
  } catch {
    byId("login-error").textContent = "Неверные данные входа.";
    byId("login-error").hidden = false;
  }
});
byId("logout-button").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST", body: {} }); location.reload(); });
byId("target-select").addEventListener("change", (event) => changeTarget(event.target.value));
byId("profile-select").addEventListener("change", (event) => {
  if (isDirty() && !confirm("Заменить несохранённые изменения другим профилем?")) { event.target.value = currentState().profileKey; return; }
  selectProfile(event.target.value);
});
byId("new-profile-button").addEventListener("click", newProfile);
document.querySelectorAll(".template-field-tab").forEach((tab) => tab.addEventListener("click", () => changeField(tab.dataset.field)));
document.querySelectorAll("[data-insert]").forEach((button) => button.addEventListener("click", () => insertAtCursor(button.dataset.insert)));
for (const id of ["template-source", "template-name", "profile-name"]) byId(id).addEventListener("input", editorChanged);
byId("management-enabled").addEventListener("change", editorChanged);
byId("profile-categories").addEventListener("change", editorChanged);
byId("preview-product-id").addEventListener("input", () => { updateProductLink(); invalidatePreview(); });
byId("system-template-button").addEventListener("click", () => {
  byId("template-source").value = state.catalog.defaults?.[state.field] || "";
  editorChanged();
});
byId("preview-button").addEventListener("click", preview);
byId("save-button").addEventListener("click", saveDraft);
window.addEventListener("beforeunload", (event) => {
  if (!isDirty()) return;
  event.preventDefault();
});

await session();
