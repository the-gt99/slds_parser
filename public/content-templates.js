const state = {
  session: null,
  targets: [],
  targetId: "",
  field: "description",
  catalog: null,
  versions: [],
  selectedVersion: null,
  autoPreview: false,
  previewTimer: null,
  previewRequest: 0,
};

const byId = (id) => document.getElementById(id);
const fieldLabels = { description: "Описание", short_description: "Краткое описание" };

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

function templateBody() {
  return {
    targetId: state.targetId,
    sourceProductId: byId("preview-product-id").value.trim(),
    field: state.field,
    name: byId("template-name").value.trim(),
    templateSource: byId("template-source").value,
  };
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
      const label = element("span", "", variable.label);
      const code = element("code", "", `{{ ${variable.path} }}`);
      button.append(label, code);
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
}

function editorStatus() {
  const selected = state.selectedVersion;
  const unchanged = selected !== null && selected.templateSource === byId("template-source").value && selected.name === byId("template-name").value.trim();
  const badge = byId("editor-state");
  if (unchanged) {
    badge.textContent = selected.status === "active" ? `Активна · rev ${selected.revision}` : `Черновик · rev ${selected.revision}`;
    badge.className = `badge ${selected.status === "active" ? "status-completed" : "status-pending"}`;
  } else {
    badge.textContent = "Есть несохранённые изменения";
    badge.className = "badge warning";
  }
  byId("validation-state").textContent = "Изменения ещё не проверены";
}

function loadVersion(version) {
  state.selectedVersion = version;
  byId("template-name").value = version.name;
  byId("template-source").value = version.templateSource;
  editorStatus();
  renderVersions();
  schedulePreview();
}

function renderVersions() {
  const list = byId("versions-list");
  list.replaceChildren();
  byId("versions-count").textContent = String(state.versions.length);
  if (!state.versions.length) {
    list.append(element("p", "muted", "Сохранённых версий пока нет. Сейчас открыт системный пример."));
    return;
  }
  for (const version of state.versions) {
    const row = element("article", `template-version-row${state.selectedVersion?.id === version.id ? " selected" : ""}`);
    const main = element("button", "template-version-main");
    main.type = "button";
    const title = element("strong", "", version.name);
    const meta = element("span", "", `rev ${version.revision} · ${formatDate(version.createdAt)} · ${version.actor}`);
    main.append(title, meta);
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

function resetEditor() {
  const active = state.versions.find((version) => version.status === "active") || state.versions[0] || null;
  if (active) {
    loadVersion(active);
    return;
  }
  state.selectedVersion = null;
  byId("template-name").value = `Шаблон: ${fieldLabels[state.field]}`;
  byId("template-source").value = state.catalog.defaults?.[state.field] || "";
  editorStatus();
  renderVersions();
}

async function loadVersions() {
  const parameters = new URLSearchParams({ targetId: state.targetId, field: state.field });
  const response = await api(`/api/content-templates?${parameters}`);
  state.versions = response.items || [];
  resetEditor();
}

function iframeDocument(html) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>body{margin:0;padding:18px;font:14px/1.55 system-ui,sans-serif;color:#20242d}h2,h3{line-height:1.25;margin:0 0 12px}p{margin:0 0 12px}ul,ol{padding-left:22px}li{margin:5px 0}a{color:#176b52}</style></head><body>${html || '<span style="color:#78818e">Поле пустое</span>'}</body></html>`;
}

function renderPreview(item) {
  const fieldKey = state.field === "description" ? "description_html" : "short_description_html";
  const before = item.current?.product?.[fieldKey] || "";
  const after = item.proposed?.fields?.[fieldKey] || "";
  byId("preview-before").srcdoc = iframeDocument(before);
  byId("preview-after").srcdoc = iframeDocument(after);
  byId("preview-comparison").hidden = false;
  const blockers = item.readiness?.blockers || [];
  byId("preview-badge").textContent = item.readiness?.ready ? "Payload готов" : `Блокеров: ${blockers.length}`;
  byId("preview-badge").className = `badge ${item.readiness?.ready ? "status-completed" : "status-pending"}`;
  byId("preview-message").textContent = blockers.length
    ? `Шаблон отрендерен. Экспорт товара пока блокируют: ${blockers.map((blocker) => blocker.message).join("; ")}`
    : "Шаблон отрендерен полными данными реального WordPress payload. Запись в WordPress не выполнялась.";
  const context = item.proposed?.contentContext;
  byId("preview-context-details").hidden = !context;
  byId("preview-context").textContent = context ? JSON.stringify(context, null, 2) : "";
}

async function preview({ automatic = false } = {}) {
  const body = templateBody();
  if (!body.sourceProductId) {
    if (!automatic) toast("Укажите sourceProductId товара для проверки");
    return;
  }
  if (!body.name) {
    if (!automatic) toast("Укажите название версии");
    return;
  }
  const requestId = ++state.previewRequest;
  byId("preview-button").disabled = true;
  byId("preview-badge").textContent = "Проверяем…";
  byId("preview-message").textContent = "Собираем реальный payload и выполняем read-only WordPress preflight…";
  try {
    const response = await api("/api/content-templates/preview", { method: "POST", body });
    if (requestId !== state.previewRequest) return;
    renderPreview(response.item);
    state.autoPreview = true;
    byId("validation-state").textContent = "Шаблон корректен и проверен на товаре";
  } catch (error) {
    if (requestId !== state.previewRequest) return;
    byId("preview-badge").textContent = "Ошибка";
    byId("preview-badge").className = "badge status-failed";
    byId("preview-message").textContent = error.message;
    byId("validation-state").textContent = `Ошибка: ${error.message}`;
  } finally {
    if (requestId === state.previewRequest) byId("preview-button").disabled = false;
  }
}

function schedulePreview() {
  clearTimeout(state.previewTimer);
  if (!state.autoPreview) return;
  state.previewTimer = setTimeout(() => preview({ automatic: true }), 900);
}

async function saveDraft() {
  const body = templateBody();
  delete body.sourceProductId;
  byId("save-button").disabled = true;
  try {
    const response = await api("/api/content-templates/drafts", { method: "POST", body });
    await loadVersions();
    const saved = state.versions.find((version) => version.id === response.item.id);
    if (saved) loadVersion(saved);
    toast("Черновик сохранён. Активная версия не изменилась.");
  } catch (error) {
    toast(error.message);
  } finally {
    byId("save-button").disabled = false;
  }
}

async function activateVersion(version, button) {
  if (!confirm(`Активировать «${version.name}» rev ${version.revision} для поля «${fieldLabels[state.field]}»? Новые preview и export будут использовать эту версию.`)) return;
  button.disabled = true;
  try {
    await api(`/api/targets/${encodeURIComponent(state.targetId)}/content-templates/${encodeURIComponent(version.id)}/activate`, { method: "POST", body: {} });
    await loadVersions();
    toast("Версия активирована. Товары не поставлены на полную переобработку.");
    if (byId("preview-product-id").value.trim()) await preview({ automatic: true });
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function changeField(field) {
  state.field = field;
  state.autoPreview = false;
  for (const tab of document.querySelectorAll(".template-field-tab")) tab.classList.toggle("active", tab.dataset.field === field);
  byId("preview-comparison").hidden = true;
  byId("preview-context-details").hidden = true;
  byId("preview-badge").textContent = "Не проверено";
  byId("preview-badge").className = "badge";
  byId("preview-message").textContent = "Укажите товар и нажмите «Проверить на товаре».";
  await loadVersions();
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
  await loadVersions();
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
byId("target-select").addEventListener("change", async (event) => { state.targetId = event.target.value; await loadVersions(); });
document.querySelectorAll(".template-field-tab").forEach((tab) => tab.addEventListener("click", () => changeField(tab.dataset.field)));
document.querySelectorAll("[data-insert]").forEach((button) => button.addEventListener("click", () => insertAtCursor(button.dataset.insert)));
byId("template-source").addEventListener("input", () => { editorStatus(); schedulePreview(); });
byId("template-name").addEventListener("input", editorStatus);
byId("preview-product-id").addEventListener("input", () => { updateProductLink(); schedulePreview(); });
byId("preview-button").addEventListener("click", () => preview());
byId("save-button").addEventListener("click", saveDraft);

await session();
