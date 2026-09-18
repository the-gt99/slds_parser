const byId = (id) => document.getElementById(id);

const state = { session: null };

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.method && state.session?.csrfToken ? { "X-CSRF-Token": state.session.csrfToken } : {}) },
    ...options,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && !options.allowErrorBody) {
    const error = new Error(data.message || `Ошибка HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const count = (value) => new Intl.NumberFormat("ru-RU").format(Number(value || 0));
const date = (value) => value ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";

function showLogin() {
  byId("app-view").hidden = true;
  byId("login-view").hidden = false;
}

function badge(id, text, kind) {
  const node = byId(id);
  node.textContent = text;
  node.className = `badge ${kind}`;
}

function metric(label, value, kind = "") {
  const item = document.createElement("div");
  if (kind) item.className = kind;
  const strong = document.createElement("strong");
  strong.textContent = count(value);
  const span = document.createElement("span");
  span.textContent = label;
  item.append(strong, span);
  return item;
}

function queueCount(queue, types, statuses) {
  return queue.filter((item) => types.includes(item.jobType) && statuses.includes(item.status))
    .reduce((sum, item) => sum + Number(item.count || 0), 0);
}

function stageRow(label, queue, types) {
  const waiting = queueCount(queue, types, ["pending", "retry"]);
  const running = queueCount(queue, types, ["running"]);
  const failed = queueCount(queue, types, ["failed"]);
  const row = document.createElement("a");
  row.className = "process-stage-row";
  row.href = `/jobs?jobType=${encodeURIComponent(types[0])}`;
  row.innerHTML = `<span>${label}</span><strong>${count(waiting)}</strong><small>в очереди</small><strong>${count(running)}</strong><small>в работе</small><strong class="${failed ? "danger-text" : ""}">${count(failed)}</strong><small>ошибок</small>`;
  return row;
}

function renderRuntime(runtime) {
  badge("worker-status", runtime.worker?.active ? "Работает" : "Остановлен", runtime.worker?.active ? "status-completed" : "status-failed");
  const stages = byId("parsing-stages");
  stages.replaceChildren(
    stageRow("Discovery", runtime.queue || [], ["discover_source"]),
    stageRow("Сбор товаров", runtime.queue || [], ["collect_product"]),
    stageRow("Обработка", runtime.queue || [], ["process_product", "retranslate_product"]),
  );
  const reclassWaiting = queueCount(runtime.queue || [], ["reclassify_product", "apply_target_classification_suggestion"], ["pending", "retry"]);
  const reclassRunning = queueCount(runtime.queue || [], ["reclassify_product", "apply_target_classification_suggestion"], ["running"]);
  const reclassFailed = queueCount(runtime.queue || [], ["reclassify_product", "apply_target_classification_suggestion"], ["failed"]);
  byId("classification-metrics").replaceChildren(metric("в очереди", reclassWaiting), metric("в работе", reclassRunning), metric("ошибок", reclassFailed, reclassFailed ? "danger-text" : ""));
}

function renderInventory(health) {
  const runs = Array.isArray(health.runs) ? health.runs : [];
  const products = runs.reduce((sum, item) => sum + Number(item.products || 0), 0);
  const overdue = runs.reduce((sum, item) => sum + Number(item.overdue || 0), 0);
  const failed = runs.reduce((sum, item) => sum + Number(item.failed || 0), 0);
  const lastChecked = runs.map((item) => item.lastCheckedAt).filter(Boolean).sort().at(-1) || null;
  byId("inventory-products").textContent = count(products);
  byId("inventory-metrics").replaceChildren(metric("просрочено", overdue, overdue ? "danger-text" : ""), metric("ошибок", failed, failed ? "danger-text" : ""));
  byId("inventory-note").textContent = runs.length ? `Последняя проверка: ${date(lastChecked)}.` : "Активный контур обновления не найден.";
  badge("inventory-status", health.status === "ok" ? "Работает" : "Требует внимания", health.status === "ok" ? "status-completed" : "status-failed");
}

function renderExport(target, result) {
  const summary = result.summary || {};
  byId("export-ready").textContent = count(summary.readyCount);
  byId("export-metrics").replaceChildren(
    metric("без активного экспорта", summary.exportableCount),
    metric("перепроверить", summary.staleCount),
    metric("заблокировано", Number(summary.blockedCount || 0) + Number(summary.errorCount || 0), Number(summary.blockedCount || 0) + Number(summary.errorCount || 0) ? "danger-text" : ""),
  );
  badge("export-status", target.enabled ? "Автоэкспорт включён" : "Выгрузка выключена", target.enabled ? "status-running" : "status-retry");
  byId("export-note").textContent = target.enabled
    ? "Перед записью всё равно требуется проверка выбранной партии."
    : "Запуск и продолжение массовых кампаний заблокированы. Доступны только просмотр и preflight.";
}

async function load() {
  byId("overview-error").hidden = true;
  let runtime;
  let inventory;
  let target;
  const tasks = [
    api("/api/runtime").then((value) => { runtime = value; renderRuntime(value); }),
    api("/api/inventory-health", { allowErrorBody: true }).then((value) => { inventory = value; renderInventory(value); }),
    api("/api/classifier/queue?limit=1").then((value) => {
      byId("classification-total").textContent = count(value.total);
      badge("classification-status", Number(value.total || 0) > 0 ? "Есть блокеры" : "Готово", Number(value.total || 0) > 0 ? "status-retry" : "status-completed");
    }),
    api("/api/targets").then(async (targets) => {
      target = targets.items.find((item) => item.code === "slamdunk") || targets.items[0];
      if (!target) throw new Error("Target не настроен");
      const exportControl = await api(`/api/export-control?targetId=${encodeURIComponent(target.id)}&limit=1`);
      renderExport(target, exportControl);
    }),
  ];
  const results = await Promise.allSettled(tasks);
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.some((error) => error.status === 401)) return showLogin();
  if (errors.length) {
    byId("overview-error").textContent = `Не удалось обновить часть сводки: ${errors.map((error) => error.message).join("; ")}`;
    byId("overview-error").hidden = false;
  }
  const healthy = errors.length === 0 && runtime?.worker?.active && inventory?.status === "ok" && target?.enabled === false;
  byId("overview-health").textContent = healthy ? "Процессы работают · выгрузка безопасно выключена" : "Есть процессы, требующие внимания";
  byId("overview-health").className = `overview-health ${healthy ? "ok" : "warning"}`;
}

byId("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    state.session = await api("/api/auth/login", { method: "POST", body: { username: byId("login-username").value, password: byId("login-password").value } });
    byId("login-view").hidden = true;
    byId("app-view").hidden = false;
    byId("operator-name").textContent = state.session.operator;
    await load();
  } catch (error) { byId("login-error").textContent = error.message; byId("login-error").hidden = false; }
});
byId("logout-button").addEventListener("click", async () => { try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch {} state.session = null; showLogin(); });
byId("refresh").addEventListener("click", load);

api("/api/auth/session").then(async (session) => {
  if (!session.authenticated) return showLogin();
  state.session = session;
  byId("app-view").hidden = false;
  byId("operator-name").textContent = session.operator;
  await load();
}).catch((error) => { byId("overview-error").textContent = error.message; byId("overview-error").hidden = false; });
