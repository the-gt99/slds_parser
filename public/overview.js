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
const time = (value) => value ? new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)) : "—";

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

function inventoryQueue(queue, types) {
  return {
    waiting: queueCount(queue, types, ["pending", "retry"]),
    running: queueCount(queue, types, ["running"]),
  };
}

function inventoryRate(pipeline) {
  const rate = Number(pipeline?.processed5m || 0) / 5;
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(rate);
}

function inventoryOutcome(value) {
  return ({
    resolved: "найден",
    not_found: "не найден",
    article_mismatch: "артикул не совпал",
    completed: "обновлён",
    skipped: "без изменений",
    failed: "ошибка",
  })[value] || value;
}

function inventoryWorkerState(run, pipeline, queue) {
  if (pipeline?.status !== "running") return { label: "На паузе", kind: "status-retry" };
  const lastCheckedAt = pipeline?.lastCheckedAt ? new Date(pipeline.lastCheckedAt).getTime() : 0;
  if (queue.running > 0 || Date.now() - lastCheckedAt < 5 * 60_000) return { label: "Работает", kind: "status-completed" };
  if (queue.waiting > 0) return { label: "Ожидает воркер", kind: "status-retry" };
  return { label: "Нет активности", kind: "status-failed" };
}

function inventoryLink(label, href) {
  const link = document.createElement("a");
  link.href = href;
  link.textContent = label;
  if (href.startsWith("http")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  return link;
}

function inventoryPipelineCard({ name, description, pipeline, queue, run, sessions, jobType }) {
  const card = document.createElement("article");
  card.className = "inventory-pipeline-card";

  const heading = document.createElement("div");
  heading.className = "inventory-pipeline-heading";
  const title = document.createElement("div");
  const eyebrow = document.createElement("span");
  eyebrow.textContent = description;
  const h3 = document.createElement("h3");
  h3.textContent = name;
  title.append(eyebrow, h3);
  const workerState = inventoryWorkerState(run, pipeline, queue);
  const status = document.createElement("span");
  status.className = `badge ${workerState.kind}`;
  status.textContent = workerState.label;
  heading.append(title, status);

  const speed = document.createElement("div");
  speed.className = "inventory-speed";
  const speedValue = document.createElement("strong");
  speedValue.textContent = inventoryRate(pipeline);
  const speedLabel = document.createElement("span");
  speedLabel.textContent = "товаров / мин";
  speed.append(speedValue, speedLabel);

  const facts = document.createElement("div");
  facts.className = "inventory-pipeline-facts";
  const factValues = [
    ["за 1 мин", pipeline?.processed1m],
    ["за 15 мин", pipeline?.processed15m],
    ["всего", pipeline?.processedTotal],
  ];
  if (sessions) factValues.push(["сессии", `${count(sessions.leased)} занято / ${count(sessions.ready)} готово`]);
  for (const [label, value] of factValues) {
    const fact = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = typeof value === "string" ? value : count(value);
    const span = document.createElement("span");
    span.textContent = label;
    fact.append(strong, span);
    facts.append(fact);
  }

  const queueLink = inventoryLink(`Очередь: ${count(queue.waiting)} · в работе: ${count(queue.running)}`, `/jobs?jobType=${encodeURIComponent(jobType)}`);
  queueLink.className = "inventory-queue-link";

  const latest = document.createElement("div");
  latest.className = "inventory-latest";
  const latestLabel = document.createElement("span");
  latestLabel.textContent = "Последний обработанный товар";
  latest.append(latestLabel);
  const product = pipeline?.lastProduct;
  if (product) {
    const productLink = inventoryLink(product.title || `WordPress #${product.wordpressProductId}`, `/wordpress-catalog?search=${encodeURIComponent(product.wordpressProductId)}`);
    productLink.className = "inventory-product-title";
    latest.append(productLink);
    const details = document.createElement("small");
    details.textContent = `${product.sku || product.sourceExternalId || "без артикула"} · ${time(product.checkedAt)} · ${inventoryOutcome(product.outcome)}`;
    latest.append(details);
    const links = document.createElement("div");
    links.className = "inventory-product-links";
    links.append(inventoryLink("В каталоге", `/wordpress-catalog?search=${encodeURIComponent(product.wordpressProductId)}`));
    if (product.sourceUrl) links.append(inventoryLink("У источника", product.sourceUrl));
    if (product.wordpressSlug) links.append(inventoryLink("На сайте", `https://slamdunk.shop/product/${encodeURIComponent(product.wordpressSlug)}/`));
    links.append(inventoryLink("В WordPress", `https://slamdunk.shop/wp-admin/post.php?post=${encodeURIComponent(product.wordpressProductId)}&action=edit`));
    latest.append(links);
  } else {
    const empty = document.createElement("strong");
    empty.textContent = "Пока нет данных";
    latest.append(empty);
  }

  card.append(heading, speed, facts, queueLink, latest);
  return card;
}

function renderInventory(health, runtime) {
  const runs = Array.isArray(health.runs) ? health.runs : [];
  const products = runs.reduce((sum, item) => sum + Number(item.products || 0), 0);
  const failed = runs.reduce((sum, item) => sum + Number(item.failed || 0), 0);
  const lastChecked = runs.map((item) => item.lastCheckedAt).filter(Boolean).sort().at(-1) || null;
  const run = runs[0];
  const queue = runtime?.queue || [];
  const goatQueue = inventoryQueue(queue, ["collect_wordpress_goat_inventory"]);
  const shihuoQueue = inventoryQueue(queue, ["collect_wordpress_shihuo_inventory"]);
  const wordpressQueue = inventoryQueue(queue, ["combine_wordpress_inventory", "prepare_wordpress_variation_patch", "refresh_wordpress_variation_patch", "submit_wordpress_variation_patches", "poll_wordpress_variation_patches"]);
  byId("inventory-products").textContent = count(products);
  byId("inventory-metrics").replaceChildren(
    metric("проверено GOAT", run?.goat?.processedTotal),
    metric("проверено Shihuo", run?.shihuo?.processedTotal),
    metric("обработано WordPress", run?.wordpress?.processedTotal, failed ? "danger-text" : ""),
  );
  byId("inventory-note").textContent = runs.length
    ? `Контур #${run.runId}. Последнее обновление сайта: ${date(lastChecked)}. Ошибок товаров: ${count(failed)}.`
    : "Активный контур обновления не найден.";
  byId("inventory-pipelines").replaceChildren(
    inventoryPipelineCard({ name: "GOAT", description: "Донор цен и остатков", pipeline: run?.goat, queue: goatQueue, run, jobType: "collect_wordpress_goat_inventory" }),
    inventoryPipelineCard({ name: "Shihuo", description: "Донор цен и остатков", pipeline: run?.shihuo, queue: shihuoQueue, run, sessions: run?.shihuo?.sessions, jobType: "collect_wordpress_shihuo_inventory" }),
    inventoryPipelineCard({ name: "WordPress", description: "Применение на сайте", pipeline: run?.wordpress, queue: wordpressQueue, run, jobType: "prepare_wordpress_variation_patch" }),
  );
  badge("inventory-status", health.status === "ok" ? "Работает" : "Требует внимания", health.status === "ok" ? "status-completed" : "status-failed");
}

function renderExportState(target) {
  badge("export-status", target.enabled ? "Автоэкспорт включён" : "Выгрузка выключена", target.enabled ? "status-running" : "status-retry");
  byId("export-note").textContent = target.enabled
    ? "Перед записью всё равно требуется проверка выбранной партии."
    : "Запуск и продолжение массовых кампаний заблокированы. Доступны только просмотр и preflight.";
}

function renderExport(target, result) {
  const summary = result.summary || {};
  byId("export-ready").textContent = count(summary.readyCount);
  byId("export-metrics").replaceChildren(
    metric("без активного экспорта", summary.exportableCount),
    metric("перепроверить", summary.staleCount),
    metric("заблокировано", Number(summary.blockedCount || 0) + Number(summary.errorCount || 0), Number(summary.blockedCount || 0) + Number(summary.errorCount || 0) ? "danger-text" : ""),
  );
  renderExportState(target);
}

async function load() {
  byId("overview-error").hidden = true;
  let runtime;
  let inventory;
  let target;
  const tasks = [
    api("/api/runtime").then((value) => { runtime = value; renderRuntime(value); }),
    api("/api/inventory-health", { allowErrorBody: true }).then((value) => { inventory = value; }),
    api("/api/rules-v2?offset=0").then((value) => {
      const total = value.summary?.catalog?.total || 0;
      byId("classification-total").textContent = count(total);
      badge("classification-status", value.authoritative ? "Основной режим" : "Теневой режим", value.authoritative ? "status-completed" : "status-retry");
    }),
    api("/api/targets").then(async (targets) => {
      target = targets.items.find((item) => item.code === "slamdunk") || targets.items[0];
      if (!target) throw new Error("Target не настроен");
      renderExportState(target);
      const exportControl = await api(`/api/export-control?targetId=${encodeURIComponent(target.id)}&limit=1`);
      renderExport(target, exportControl);
    }),
  ];
  const results = await Promise.allSettled(tasks);
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (inventory) renderInventory(inventory, runtime);
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
