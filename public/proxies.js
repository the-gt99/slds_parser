const state = { session: null, items: [], editing: null };
const byId = (id) => document.getElementById(id);
async function api(url, options = {}) {
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (options.method && options.method !== "GET" && state.session?.csrfToken) headers["X-CSRF-Token"] = state.session.csrfToken;
  const response = await fetch(url, { credentials: "same-origin", headers, ...options, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.message || data.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return data;
}
function toast(message) { byId("toast").textContent = message; byId("toast").hidden = false; setTimeout(() => { byId("toast").hidden = true; }, 2600); }
function formatDate(value) { return value ? new Date(value).toLocaleString("ru-RU") : "—"; }
function statusBadge(value) { const label = { healthy: "healthy", unhealthy: "unhealthy", untested: "untested" }[value] || value; return `<span class="badge status-${value === "healthy" ? "completed" : value === "unhealthy" ? "failed" : "pending"}">${label}</span>`; }
function render() {
  const body = byId("table-body"); body.replaceChildren();
  for (const item of state.items) {
    const row = document.createElement("tr");
    row.innerHTML = `<td><strong>${escapeHtml(item.name)}</strong><br><span class="muted">ID ${item.id}</span></td><td>${item.protocol.toUpperCase()}<br><span class="muted">${escapeHtml(item.address)}</span>${item.hasCredentials ? '<br><span class="badge">auth</span>' : ""}</td><td>${item.enabled ? '<span class="badge status-completed">enabled</span>' : '<span class="badge status-pending">disabled</span>'}<br>${statusBadge(item.healthStatus)}</td><td>${item.lastTestLatencyMs == null ? "—" : `${item.lastTestLatencyMs} ms`}<br><span class="muted">${formatDate(item.lastTestedAt)}</span>${item.lastTestError ? `<br><span class="pipeline-error">${escapeHtml(item.lastTestError)}</span>` : ""}</td><td>${item.successCount} ok / ${item.failureCount} fail<br><span class="muted">${formatDate(item.lastUsedAt)}</span></td><td><div class="compact-links"><button class="button quiet small-button" data-action="edit" data-id="${item.id}">Править</button><button class="button secondary small-button" data-action="test" data-id="${item.id}">Проверить</button><button class="button ${item.enabled ? "danger-quiet" : "primary"} small-button" data-action="${item.enabled ? "disable" : "enable"}" data-id="${item.id}">${item.enabled ? "Выключить" : "Включить"}</button></div></td>`;
    body.append(row);
  }
  byId("empty").hidden = state.items.length !== 0;
  byId("table-section").hidden = state.items.length === 0;
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char])); }
async function load() {
  byId("loading").hidden = false; byId("error").hidden = true;
  try { const data = await api("/api/proxies"); state.items = data.items || []; render(); }
  catch (error) { byId("error").textContent = error.message; byId("error").hidden = false; }
  finally { byId("loading").hidden = true; }
}
function openDialog(item = null) {
  state.editing = item;
  byId("dialog-title").textContent = item ? "Редактировать прокси" : "Добавить прокси";
  byId("proxy-name").value = item?.name || "";
  byId("proxy-protocol").value = item?.protocol || "http";
  byId("proxy-host").value = item?.host || "";
  byId("proxy-port").value = item?.port || "";
  byId("proxy-username").value = "";
  byId("proxy-password").value = "";
  byId("form-error").hidden = true;
  byId("proxy-dialog").showModal();
}
async function save(event) {
  event.preventDefault();
  const body = { name: byId("proxy-name").value, protocol: byId("proxy-protocol").value, host: byId("proxy-host").value, port: byId("proxy-port").value };
  if (byId("proxy-username").value || byId("proxy-password").value) { body.username = byId("proxy-username").value; body.password = byId("proxy-password").value; }
  try {
    if (state.editing) await api(`/api/proxies/${state.editing.id}`, { method: "PATCH", body });
    else await api("/api/proxies", { method: "POST", body });
    byId("proxy-dialog").close(); await load(); toast("Сохранено");
  } catch (error) { byId("form-error").textContent = error.message; byId("form-error").hidden = false; }
}
async function action(event) {
  const button = event.target.closest("button[data-action]"); if (!button) return;
  const item = state.items.find((proxy) => proxy.id === button.dataset.id); if (!item) return;
  if (button.dataset.action === "edit") { openDialog(item); return; }
  button.disabled = true;
  try {
    await api(`/api/proxies/${item.id}/${button.dataset.action}`, { method: "POST" });
    await load(); toast("Готово");
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}
async function session() {
  const data = await api("/api/auth/session");
  if (!data.authenticated) { byId("login-view").hidden = false; byId("app-view").hidden = true; return; }
  state.session = data; byId("operator-name").textContent = data.operator; byId("login-view").hidden = true; byId("app-view").hidden = false; await load();
}
byId("login-form").addEventListener("submit", async (event) => { event.preventDefault(); try { state.session = await api("/api/auth/login", { method: "POST", body: { username: byId("login-username").value, password: byId("login-password").value } }); byId("login-error").hidden = true; await session(); } catch { byId("login-error").textContent = "Неверные данные входа."; byId("login-error").hidden = false; } });
byId("logout-button").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST", body: {} }); location.reload(); });
byId("create-button").addEventListener("click", () => openDialog());
byId("dialog-close").addEventListener("click", () => byId("proxy-dialog").close());
byId("cancel-button").addEventListener("click", () => byId("proxy-dialog").close());
byId("proxy-form").addEventListener("submit", save);
byId("table-body").addEventListener("click", action);
await session();
