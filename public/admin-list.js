const byId = (id) => document.getElementById(id);
const mode = location.pathname.includes("operations")
  ? "operations"
  : location.pathname.includes("wordpress-snapshots")
    ? "snapshots"
    : location.pathname.includes("runtime")
      ? "runtime"
      : location.pathname.includes("jobs")
        ? "jobs"
        : location.pathname.includes("classifier-config")
          ? "classifierConfig"
          : "products";
const initialParams = new URLSearchParams(location.search);
const initialConfigKind = ["mapping", "rule", "target_mapping", "projection"].includes(initialParams.get("kind"))
  ? initialParams.get("kind")
  : "mapping";

const state = {
  session: null,
  offset: 0,
  limit: 50,
  total: 0,
  configItems: [],
  configKind: initialConfigKind,
  configDeepLink: mode === "classifierConfig" && initialParams.get("configId")
    ? {
        id: initialParams.get("configId"),
        action: initialParams.get("action") || "details",
        targetScope: initialParams.get("targetScope") || "",
        search: initialParams.get("search") || "",
        opened: false,
      }
    : null,
  targets: [],
  pageProductIds: [],
  selectedProductIds: new Set(),
};

const bulkActions = {
  collect: {
    label: "Заново собрать — без обработки",
    description: "Повторно запрашивает данные товара и offers у источника и обновляет сохранённые части. Обработку не запускает.",
  },
  collect_and_process: {
    label: "Заново собрать → затем обработать",
    description: "Повторно запрашивает товар у источника. После успешного сбора ставит обычную обработку; если данные и версии не изменились, она может завершиться без полного пересчёта.",
  },
  process: {
    label: "Обработать сохранённые данные",
    description: "Не обращается к источнику. Обрабатывает уже сохранённые части товара; неизменившийся результат может быть пропущен.",
  },
  reprocess: {
    label: "Принудительно переобработать сохранённые данные",
    description: "Не обращается к источнику. Заново запускает процессор и все операции по сохранённым частям, даже если входные данные не изменились.",
  },
  retry_failed_processing: {
    label: "Создать новую обработку после ошибки",
    description: "Выбирает только товары с завершившейся ошибкой обработки и создаёт для них новую принудительную обработку. Повторный сбор не выполняется.",
  },
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
  state.pageProductIds = items.map((item) => item.sourceProductId);
  headings(["", "Источник / ID", "External ID", "Название", "Стадия", "Классификация", "Сбор", "Обработка", "WordPress"]);
  const body = byId("table-body");
  body.replaceChildren();
  for (const item of items) {
    const tr = document.createElement("tr");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedProductIds.has(item.sourceProductId);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedProductIds.add(item.sourceProductId);
      else state.selectedProductIds.delete(item.sourceProductId);
      updateBulkState();
    });
    cell(tr, checkbox);
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
  updateBulkState();
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

function elapsedText(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "-";
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} сек.`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes} мин. ${rest} сек.`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ч. ${minutes % 60} мин.`;
}

function elapsedNode(milliseconds, liveSince = null) {
  const value = document.createElement("span");
  value.className = "job-elapsed";
  if (liveSince) value.dataset.liveSince = liveSince;
  value.textContent = liveSince ? elapsedText(Date.now() - new Date(liveSince).valueOf()) : elapsedText(milliseconds);
  return value;
}

function refreshLiveElapsed() {
  for (const value of document.querySelectorAll("[data-live-since]")) {
    const started = new Date(value.dataset.liveSince).valueOf();
    value.textContent = Number.isFinite(started) ? elapsedText(Date.now() - started) : "-";
  }
}

function renderJobs(data) {
  const summary = data.summary || {};
  headings(["Job", "Статус", "Товар", "Создан", "Ожидание", "Выполнение", "Попытки", "Worker/lane", "Ошибка", "Действие"]);
  const body = byId("table-body");
  body.replaceChildren();
  for (const item of data.items || []) {
    const tr = document.createElement("tr");
    cell(tr, `#${item.id} · ${queueLabel(item.jobType)}`);
    cell(tr, status(item.status));
    cell(tr, item.sourceProductId ? link(`#${item.sourceProductId}`, `/products/${item.sourceProductId}`) : "-");
    cell(tr, date(item.createdAt));
    const waitingSince = item.status === "pending" ? item.createdAt : item.status === "retry" ? item.updatedAt : null;
    cell(tr, elapsedNode(item.queueWaitMs, waitingSince), "job-time-cell");
    const executionSince = item.status === "running" ? (item.startedAt || item.lockedAt) : null;
    cell(tr, elapsedNode(item.durationMs, executionSince), "job-time-cell");
    cell(tr, item.attempts);
    cell(tr, item.lockedBy ? link(item.lockedBy, "/runtime") : "-");
    const error = document.createElement("span");
    error.textContent = item.lastError || "-";
    if (item.payload) error.append(jsonMini("payload", item.payload));
    cell(tr, error, "admin-title-cell");
    const actions = document.createElement("span");
    actions.className = "compact-links";
    if (item.jobType === "process_product" && ["pending", "retry"].includes(item.status)) {
      const run = button("Выполнить сейчас", "button secondary compact");
      run.addEventListener("click", () => runProcessJob(item, run));
      actions.append(run);
    } else {
      actions.textContent = "-";
    }
    cell(tr, actions);
    body.append(tr);
  }
  let dashboard = byId("jobs-dashboard");
  if (!dashboard) {
    dashboard = document.createElement("section");
    dashboard.id = "jobs-dashboard";
    dashboard.className = "section runtime-card runtime-wide";
    byId("filters").after(dashboard);
  }
  dashboard.innerHTML = `
    <div class="section-title"><div><p class="eyebrow">Очередь и ошибки</p><h2>Сводка jobs</h2></div></div>
    <div id="jobs-type-metrics" class="runtime-list"></div>
    <details class="data-details"><summary>Группы ошибок</summary><pre id="jobs-error-groups"></pre></details>
    <div class="runtime-actions">
      <button id="show-running-jobs" class="button secondary" type="button">Показать выполняющиеся</button>
      <button id="retry-process-failed" class="button secondary" type="button">Вернуть ошибочные обработки в очередь</button>
    </div>
    <p class="muted runtime-note">Скорость считается отдельно для каждого типа job. ETA использует p75 длительности завершённых jobs и применённое число потоков; при отсутствии длительностей — фактическую скорость.</p>
  `;
  const selectedJobType = byId("source").value;
  const metrics = (summary.byJobType || []).filter((item) => !selectedJobType || item.jobType === selectedJobType);
  const metricsRoot = byId("jobs-type-metrics");
  if (metrics.length === 0) metricsRoot.textContent = "Нет свежих данных по выбранному типу jobs.";
  for (const metric of metrics) {
    const counts = Object.fromEntries((summary.byTypeStatus || [])
      .filter((item) => item.jobType === metric.jobType)
      .map((item) => [item.status, item.count]));
    const row = document.createElement("div");
    row.className = "runtime-row job-metric-row";
    const queue = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = queueLabel(metric.jobType);
    queue.append(label, document.createTextNode(` · в очереди ${counts.pending || 0} · выполняется ${counts.running || 0} · повтор ${counts.retry || 0} · ошибок ${counts.failed || 0}`));
    const speed = document.createElement("strong");
    const etaDetails = metric.etaBasis === "duration" && metric.estimatedDurationMs !== null
      ? ` · p75 ${elapsedText(metric.estimatedDurationMs)} · потоков ${metric.concurrency}`
      : "";
    speed.textContent = `15 мин / час / сутки: ${metric.completion.last15m} / ${metric.completion.last1h} / ${metric.completion.last24h} · ETA ${metric.etaMinutes === null ? "—" : `≈ ${metric.etaMinutes} мин.`}${etaDetails}`;
    row.append(queue, speed);
    metricsRoot.append(row);
  }
  const visibleErrors = (summary.errorGroups || []).filter((item) => !selectedJobType || item.jobType === selectedJobType);
  byId("jobs-error-groups").textContent = JSON.stringify(visibleErrors, null, 2);
  byId("show-running-jobs").addEventListener("click", () => {
    byId("stage").value = "running";
    state.offset = 0;
    load();
  });
  byId("retry-process-failed").addEventListener("click", retryFailedProcessing);
  refreshLiveElapsed();
}

async function runProcessJob(item, control) {
  if (!confirm(`Выполнить сейчас только process_product job #${item.id} для товара #${item.sourceProductId || "-"}? Остальная очередь не будет запущена.`)) return;
  control.disabled = true;
  control.textContent = "Выполняется…";
  try {
    const response = await api(`/api/jobs/${item.id}/run`, { method: "POST", body: {} });
    const result = response.result;
    const suffix = result.error ? `\n${result.error}` : "";
    alert(`Job #${result.jobId}: ${status(result.status)}${suffix}`);
    await load();
  } catch (error) {
    alert(error.message);
    control.disabled = false;
    control.textContent = "Выполнить сейчас";
  }
}

function jsonMini(title, value) {
  const details = document.createElement("details");
  details.className = "data-details compact-json";
  const summary = document.createElement("summary");
  summary.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(value, null, 2);
  details.append(summary, pre);
  return details;
}

function productFilters() {
  return {
    search: byId("search").value.trim(),
    source: byId("source").value,
    stage: byId("stage").value,
    classification: byId("classification").value,
    targetStatus: byId("target-status").value,
  };
}

function updateBulkState() {
  const panel = byId("bulk-panel");
  if (!panel) return;
  panel.hidden = mode !== "products";
  byId("bulk-count").textContent = String(state.selectedProductIds.size);
}

function updateBulkActionHelp() {
  const action = bulkActions[byId("bulk-action")?.value];
  const help = byId("bulk-action-help");
  if (help) help.textContent = action?.description || "";
}

function paginationItems(currentPage, totalPages) {
  const visiblePages = new Set([1, totalPages]);
  for (let page = currentPage - 2; page <= currentPage + 2; page += 1) {
    if (page > 1 && page < totalPages) visiblePages.add(page);
  }
  const items = [];
  let previousPage = 0;
  for (const page of [...visiblePages].sort((left, right) => left - right)) {
    if (previousPage && page - previousPage > 1) items.push(null);
    items.push(page);
    previousPage = page;
  }
  return items;
}

function goToPage(page) {
  const totalPages = Math.max(1, Math.ceil(state.total / state.limit));
  const normalizedPage = Math.min(totalPages, Math.max(1, Math.trunc(Number(page))));
  if (!Number.isFinite(normalizedPage)) return;
  const nextOffset = (normalizedPage - 1) * state.limit;
  if (nextOffset === state.offset) return;
  state.offset = nextOffset;
  load();
}

function renderPagination(itemsLength) {
  const currentPage = Math.floor(state.offset / state.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(state.total / state.limit));
  byId("page-info").textContent = state.total
    ? `${state.offset + 1}-${Math.min(state.offset + itemsLength, state.total)} из ${state.total}`
    : "0";
  byId("prev").disabled = currentPage === 1;
  byId("next").disabled = currentPage === totalPages;
  const pages = byId("page-numbers");
  pages.replaceChildren();
  for (const item of paginationItems(currentPage, totalPages)) {
    if (item === null) {
      const ellipsis = document.createElement("span");
      ellipsis.className = "pagination-ellipsis";
      ellipsis.textContent = "…";
      ellipsis.setAttribute("aria-hidden", "true");
      pages.append(ellipsis);
      continue;
    }
    const pageButton = button(String(item), `button quiet${item === currentPage ? " active" : ""}`);
    pageButton.setAttribute("aria-label", `Страница ${item}`);
    if (item === currentPage) pageButton.setAttribute("aria-current", "page");
    else pageButton.addEventListener("click", () => goToPage(item));
    pages.append(pageButton);
  }
  byId("page-number").value = String(currentPage);
  byId("page-number").max = String(totalPages);
  byId("page-total").textContent = `из ${totalPages}`;
}

async function previewBulk() {
  const action = byId("bulk-action").value;
  if (action === "export") return;
  const actionInfo = bulkActions[action];
  const selectedIds = [...state.selectedProductIds];
  const body = {
    action,
    filter: productFilters(),
    selectedIds: selectedIds.length ? selectedIds : undefined,
    limit: byId("bulk-limit").value,
    force: action === "reprocess",
  };
  const response = await api("/api/products/batch/preview", { method: "POST", body });
  const preview = response.preview;
  const skipReasons = (preview.skipReasons || []).map((item) => `${item.reason}: ${item.count}`).join("; ") || "нет";
  const message = [
    `Действие: ${actionInfo?.label || action}`,
    actionInfo?.description || "",
    `Выбрано: ${preview.selectedCount}`,
    `Будет поставлено задач: ${preview.jobsToCreate}`,
    `Пропущено: ${preview.skippedCount}`,
    `Причины пропуска: ${skipReasons}`,
    `Изображений для обработки примерно: ${preview.estimatedImages}`,
    preview.disk?.warning || "",
  ].filter(Boolean).join("\n");
  byId("bulk-result").hidden = false;
  byId("bulk-result").textContent = message;
  if (!confirm(`${message}\n\nПоставить задачи в очередь?`)) return;
  const apply = await api("/api/products/batch/apply", { method: "POST", body });
  byId("bulk-result").textContent = `Готово. Поставлено задач: ${apply.result.createdJobIds.length}. Запись аудита: #${apply.result.auditId}.`;
  await load();
}

async function retryFailedProcessing() {
  const limit = prompt("Сколько существующих обработок со статусом «Ошибка» вернуть в очередь? Максимум 5000.", "100");
  if (!limit) return;
  const preview = await api("/api/jobs/failed/preview-retry", { method: "POST", body: { jobType: "process_product", limit } });
  const text = `Ошибочных обработок: ${preview.preview.failedCount}\nБудет возвращено в очередь: ${preview.preview.retryCount}\nУже есть активная обработка: ${preview.preview.activeDuplicateCount}`;
  if (!confirm(`${text}\n\nСбор товаров запускаться не будет. Продолжить?`)) return;
  await api("/api/jobs/failed/retry", { method: "POST", body: { jobType: "process_product", limit } });
  await load();
}

function runtimeStatusLabel(value) {
  return value ? "Запущен" : "Остановлен";
}

function queueLabel(jobType) {
  return ({
    discover_source: "Discovery",
    collect_product: "Сбор товаров",
    sync_target_classifications: "Связи WordPress",
    apply_target_classification_suggestion: "Применение связей WordPress",
    process_product: "Обработка",
    reclassify_product: "Переклассификация",
    export_product: "Экспорт",
    preflight_product: "Preflight WordPress",
  })[jobType] || jobType;
}

function renderRuntimeQueue(items) {
  const queue = byId("runtime-queue");
  queue.replaceChildren();
  if (!items.length) {
    queue.textContent = "В очереди нет активных или ошибочных задач.";
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "runtime-row";
    row.append(textBlock(queueLabel(item.jobType), status(item.status)));
    const count = document.createElement("strong");
    count.textContent = item.count;
    row.append(count);
    queue.append(row);
  }
}

function renderRuntimeLogs(items) {
  const logs = byId("runtime-logs");
  logs.replaceChildren();
  if (!items.length) {
    logs.textContent = "Событий пока нет.";
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = `runtime-log ${item.level}`;
    const time = document.createElement("time");
    time.textContent = date(item.at);
    const message = document.createElement("span");
    message.textContent = item.message;
    row.append(time, message);
    logs.append(row);
  }
}

function runtimeSettingsInput() {
  return {
    collectionConcurrency: byId("runtime-collection-concurrency").value,
    processConcurrency: byId("runtime-process-concurrency").value,
    preflightConcurrency: byId("runtime-preflight-concurrency").value,
    refreshSourceBeforeExport: byId("runtime-refresh-source-before-export").checked,
  };
}

async function saveRuntimeSettings(restart) {
  const action = restart ? "сохранить настройки и перезапустить production worker" : "сохранить настройки без перезапуска";
  if (!confirm(`Действительно ${action}?`)) return;
  const buttons = [byId("runtime-settings-save"), byId("runtime-settings-apply")];
  for (const control of buttons) control.disabled = true;
  try {
    await api("/api/runtime/settings", { method: "POST", body: { ...runtimeSettingsInput(), restart } });
    await load();
  } catch (error) {
    alert(error.message);
    for (const control of buttons) control.disabled = false;
  }
}

function renderRuntimeSettings(settings, worker) {
  const controls = [
    ["runtime-collection-concurrency", "collectionConcurrency"],
    ["runtime-process-concurrency", "processConcurrency"],
    ["runtime-preflight-concurrency", "preflightConcurrency"],
  ];
  const available = settings !== null && settings !== undefined;
  for (const [id, field] of controls) {
    const control = byId(id);
    control.disabled = !available;
    if (available && document.activeElement !== control) control.value = settings[field];
  }
  const refreshControl = byId("runtime-refresh-source-before-export");
  refreshControl.disabled = !available;
  if (available && document.activeElement !== refreshControl) refreshControl.checked = settings.refreshSourceBeforeExport;
  byId("runtime-settings-save").disabled = !available;
  byId("runtime-settings-apply").disabled = !available || !worker?.active;
  if (!available) {
    byId("runtime-settings-status").textContent = "Недоступно";
    byId("runtime-settings-status").className = "badge status-failed";
    byId("runtime-settings-saved").textContent = "Runtime-настройки не подключены.";
    byId("runtime-settings-applied").textContent = "-";
    return;
  }

  const matchesApplied = settings.applied?.revision === settings.revision;
  byId("runtime-settings-status").textContent = matchesApplied ? "Применено" : "Нужен перезапуск";
  byId("runtime-settings-status").className = `badge ${matchesApplied ? "status-completed" : "status-retry"}`;
  byId("runtime-settings-saved").textContent = `Сохранено: ревизия ${settings.revision} · ${settings.updatedBy} · ${date(settings.updatedAt)}`;
  byId("runtime-settings-applied").textContent = settings.applied
    ? `Последний запуск: ревизия ${settings.applied.revision} · обновление перед экспортом ${settings.applied.refreshSourceBeforeExport ? "включено" : "выключено"} · ${settings.applied.workerId} · ${date(settings.applied.appliedAt)}`
    : "Worker ещё не запускался с настройками из интерфейса.";
}

function renderRuntime(data) {
  const worker = data.worker;
  byId("runtime-status").textContent = worker === null
    ? "Не найден"
    : `${runtimeStatusLabel(worker.active)}${worker.mainPid ? ` · PID ${worker.mainPid}` : ""}`;
  byId("runtime-status").className = `badge ${worker?.active ? "status-running" : "status-failed"}`;
  byId("runtime-worker-service").textContent = worker?.serviceName || "-";
  byId("runtime-worker-state").textContent = worker ? `${worker.state || "-"} / ${worker.subState || "-"}` : "-";
  byId("runtime-start").disabled = worker === null || worker.active;
  byId("runtime-stop").disabled = worker === null || !worker.active;
  renderRuntimeSettings(data.settings, worker);
  renderRuntimeQueue(data.queue || []);
  renderRuntimeLogs(data.logs || []);
}

function configKind(value) {
  return ({
    mapping: "Точное сопоставление",
    rule: "Контекстное правило",
    target_mapping: "Основное поле WordPress",
    projection: "Дополнительное назначение",
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
  const operators = {
    equals: "равно",
    contains: "содержит фразу",
    all_words: "содержит все слова",
    regex: "соответствует шаблону",
  };
  return (conditions || []).map((condition) => `${ruleFieldLabel(condition.field)} ${operators[condition.operator] || condition.operator} «${condition.value}»`).join("; ");
}

function renderConfig(items, usageIncluded) {
  const headers = {
    mapping: ["Исходное значение", "Внутреннее значение", "WordPress назначения", "Статус", "Применено", "Обновлено"],
    rule: ["Правило", "Внутреннее значение", "Условия", "WordPress назначения", "Статус", "Применено", "Обновлено"],
    target_mapping: ["Внутреннее значение", "Основное поле WordPress", "Статус", "Применено", "Обновлено"],
    projection: ["Решение классификатора", "Дополнительное поле WordPress", "Статус", "Применено", "Обновлено"],
  };
  headings(headers[state.configKind]);
  state.configItems = items.map((item) => ({
    ...item,
    usageLoaded: usageIncluded ?? item.usageLoaded ?? true,
  }));
  const body = byId("table-body");
  body.replaceChildren();
  for (const item of state.configItems) {
    const tr = document.createElement("tr");
    tr.className = "clickable-row";
    tr.addEventListener("click", () => selectConfig(item));
    if (item.kind === "mapping") {
      cell(tr, textBlock(item.sourceValue || item.normalizedSourceValue, `${item.sourceCode} · ${item.typeName || item.typeCode}${item.scope ? ` · ${item.scope}` : ""}`));
      cell(tr, item.status === "ignored" ? "Не классифицировать" : item.referenceName || "-");
      cell(tr, configOutputs(item.outputs));
    } else if (item.kind === "rule") {
      cell(tr, textBlock(item.ruleName, `${item.sourceCode} · ${item.typeName || item.typeCode}`));
      cell(tr, item.referenceName || "-");
      cell(tr, conditionText(item.conditions) || "-");
      cell(tr, configOutputs(item.outputs));
    } else if (item.kind === "target_mapping") {
      cell(tr, textBlock(item.referenceName, item.typeName || item.typeCode));
      cell(tr, textBlock(item.targetLabel, [item.targetTaxonomy, item.targetExternalId ? `ID термина ${item.targetExternalId}` : ""].filter(Boolean).join(" · ")));
    } else {
      cell(tr, textBlock(item.ruleName || item.sourceValue || `Решение #${item.id}`, item.typeName || item.typeCode));
      cell(tr, textBlock(item.targetLabel, [item.targetTaxonomy, item.targetExternalId ? `term #${item.targetExternalId}` : ""].filter(Boolean).join(" · ")));
    }
    const pill = document.createElement("span");
    pill.className = `config-pill ${item.status}`;
    pill.textContent = configStatus(item.status);
    cell(tr, pill);
    cell(tr, item.usageLoaded ? String(item.affectedProductCount ?? 0) : "…");
    cell(tr, date(item.updatedAt));
    body.append(tr);
  }
}

async function selectConfig(item) {
  if (item.usageLoaded) {
    openConfigDetails(item);
    return;
  }
  try {
    const params = new URLSearchParams({ kind: item.kind, configId: item.id, limit: "1", offset: "0" });
    const response = await api(`/api/classifier/configuration?${params}`);
    const detailed = response.items?.[0];
    if (detailed) {
      detailed.usageLoaded = true;
      const index = state.configItems.findIndex((current) => current.kind === detailed.kind && current.id === detailed.id);
      if (index >= 0) state.configItems[index] = detailed;
      openConfigDetails(detailed);
      return;
    }
    showToast("Настройка больше не найдена");
  } catch (error) {
    showToast(`Не удалось загрузить статистику настройки: ${error.message}`);
  }
}

async function hydrateConfigUsage(params, expectedItems) {
  try {
    const response = await api(`/api/classifier/configuration?${params}`);
    const expectedKeys = expectedItems.map((item) => `${item.kind}:${item.id}`).join(",");
    const currentKeys = state.configItems.map((item) => `${item.kind}:${item.id}`).join(",");
    if (currentKeys !== expectedKeys) return;
    const usage = new Map((response.items || []).map((item) => [`${item.kind}:${item.id}`, item]));
    renderConfig(state.configItems.map((item) => {
      const loaded = usage.get(`${item.kind}:${item.id}`);
      return loaded ? { ...item, affectedProductCount: loaded.affectedProductCount, examples: loaded.examples, usageLoaded: true } : item;
    }));
  } catch {
    // Список уже доступен; статистику можно повторно запросить открытием записи.
  }
}

function configOutputs(outputs) {
  const wrapper = document.createElement("div");
  wrapper.className = "config-output-list";
  for (const output of outputs || []) {
    const chip = document.createElement("span");
    chip.className = `config-output ${output.status}`;
    chip.textContent = `${output.kind === "projection" ? "+ " : ""}${output.targetLabel} · ${output.targetTaxonomy || output.targetScope}`;
    wrapper.append(chip);
  }
  if (!wrapper.childElementCount) wrapper.textContent = "Не настроено";
  return wrapper;
}

function detailRow(parent, label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value ?? "-";
  parent.append(dt, dd);
}

async function openConfigDetails(item) {
  const { dialog, form } = dialogShell(configKind(item.kind));
  dialog.classList.add("dialog-wide");
  const summary = document.createElement("div");
  summary.className = "config-summary";
  const title = document.createElement("h3");
  title.textContent = item.ruleName || item.sourceValue || item.referenceName || `Запись #${item.id}`;
  const subtitle = document.createElement("p");
  subtitle.className = "muted";
  subtitle.textContent = item.kind === "mapping"
    ? `${item.sourceCode}: исходное значение → внутренний справочник`
    : item.kind === "rule"
      ? `${item.sourceCode}: контекстное правило → внутренний справочник`
      : item.kind === "target_mapping"
        ? "Внутреннее значение → основное поле WordPress"
        : "Решение классификатора → дополнительное поле WordPress";
  summary.append(title, subtitle);
  const meta = document.createElement("dl");
  meta.className = "config-meta-grid config-meta-readable";
  detailRow(meta, "Статус", configStatus(item.status));
  detailRow(meta, "Тип данных", item.typeName || item.typeCode);
  if (item.sourceValue) detailRow(meta, "Исходное значение", item.sourceValue);
  if (item.referenceName) detailRow(meta, "Внутреннее значение", item.referenceName);
  if (item.targetLabel) detailRow(meta, "WordPress", `${item.targetLabel}${item.targetTaxonomy ? ` · ${item.targetTaxonomy}` : ""}`);
  if (item.outputs?.length) detailRow(meta, "Назначения WordPress", item.outputs.map((output) => `${output.kind === "projection" ? "+ " : ""}${output.targetLabel} · ${output.targetTaxonomy || output.targetScope}${output.status === "inactive" ? " (отключено)" : ""}`).join("; "));
  if (item.conditions?.length) detailRow(meta, "Условия", conditionText(item.conditions));
  detailRow(meta, "Уже применено", `${item.affectedProductCount || 0} товаров`);
  detailRow(meta, "Обновлено", date(item.updatedAt));

  const examples = document.createElement("div");
  examples.className = "config-examples";
  const examplesTitle = document.createElement("h3");
  examplesTitle.textContent = "Примеры товаров";
  examples.append(examplesTitle);
  for (const example of item.examples || []) {
    examples.append(link(example.title || example.sourceKey, `/products/${example.sourceProductId}`));
  }
  if (!(item.examples || []).length) examples.append(document.createTextNode("Пока не применено ни к одному пересчитанному товару. После выполнения переклассификации счётчик и примеры обновятся."));

  const history = document.createElement("div");
  history.className = "config-history";
  history.textContent = "Загружаем историю…";
  const actions = document.createElement("div");
  actions.className = "dialog-actions split sticky-dialog-actions";
  const editActions = document.createElement("div");
  if (item.kind === "mapping") {
    const edit = button("Изменить сопоставление", "button primary");
    edit.addEventListener("click", () => { dialog.close(); openMappingDialog(item); });
    const projection = button("Добавить назначение WordPress");
    projection.addEventListener("click", () => { dialog.close(); openProjectionDialog(item); });
    editActions.append(edit, projection);
  } else if (item.kind === "rule") {
    const edit = button("Изменить правило", "button primary");
    edit.addEventListener("click", () => { dialog.close(); openRuleDialog(item); });
    const projection = button("Добавить назначение WordPress");
    projection.addEventListener("click", () => { dialog.close(); openProjectionDialog(item); });
    const toggle = button(item.status === "active" ? "Отключить" : "Включить");
    toggle.addEventListener("click", async () => { dialog.close(); await setRuleStatus(item); });
    const remove = button("Удалить", "button danger-quiet");
    remove.addEventListener("click", async () => { dialog.close(); await deleteRule(item); });
    editActions.append(edit, projection, toggle, remove);
  } else if (item.kind === "target_mapping") {
    const edit = button("Изменить поле WordPress", "button primary");
    edit.addEventListener("click", () => { dialog.close(); openTargetMappingDialog(item); });
    const toggle = button(item.status === "active" ? "Отключить" : "Включить");
    toggle.addEventListener("click", async () => { dialog.close(); await setTargetMappingStatus(item); });
    editActions.append(edit, toggle);
  } else if (item.kind === "projection") {
    const edit = button("Изменить назначение", "button primary");
    edit.addEventListener("click", () => { dialog.close(); openProjectionDialog(item, true); });
    const toggle = button(item.status === "active" ? "Отключить" : "Включить");
    toggle.addEventListener("click", async () => { dialog.close(); await setProjectionStatus(item); });
    editActions.append(edit, toggle);
  }
  const close = button("Закрыть");
  close.addEventListener("click", () => dialog.close());
  actions.append(editActions, close);
  form.append(summary, meta, examples, history, actions);
  dialog.showModal();

  try {
    const response = await api(`/api/classifier/configuration/${item.kind}/${item.id}/history`);
    history.replaceChildren();
    const historyTitle = document.createElement("h3");
    historyTitle.textContent = "История изменений";
    history.append(historyTitle);
    for (const record of response.items || []) {
      const row = document.createElement("div");
      row.className = "history-row";
      row.append(textBlock(historyAction(record.action), `${date(record.createdAt)} · ${record.actor || "система"}${record.reason ? ` · ${record.reason}` : ""}`));
      history.append(row);
    }
    if (!(response.items || []).length) history.append(document.createTextNode("История пока отсутствует."));
  } catch (error) {
    history.textContent = `Не удалось загрузить историю: ${error.message}`;
  }
}

function historyAction(action) {
  return ({ create: "Создано", update: "Изменено", reactivate: "Включено", deactivate: "Отключено", confirm: "Подтверждено", ignore: "Игнорируется" })[action] || action;
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

async function openMappingDialog(item) {
  await loadTargets();
  const { dialog, form } = dialogShell("Редактировать точное сопоставление");
  dialog.classList.add("dialog-wide");
  const intro = document.createElement("p");
  intro.className = "dialog-intro";
  intro.textContent = `Вы меняете, как классификатор понимает «${item.sourceValue}». Сначала выберите внутреннее значение, затем проверьте список затронутых товаров.`;
  const current = document.createElement("div");
  current.className = "mapping-current";
  current.append(
    textBlock("Исходное значение", `${item.sourceValue} · ${item.typeName || item.typeCode}`),
    textBlock("Сейчас", item.status === "ignored" ? "Не классифицировать" : item.referenceName || "Не настроено"),
  );
  const modeSelect = document.createElement("select");
  modeSelect.append(new Option("Выбрать внутреннее значение", "internal"));
  if (capabilityFor(item.typeCode)) modeSelect.append(new Option("Связать сразу с основным полем WordPress", "wordpress"));
  modeSelect.append(new Option("Не классифицировать это значение", "ignore"));
  const search = input(item.referenceName || item.sourceValue || "");
  const results = document.createElement("div");
  results.className = "mapping-results";
  const previewBox = document.createElement("div");
  previewBox.className = "rule-preview";
  previewBox.hidden = true;
  let selected = null;
  let preview = null;

  function resetPreview() {
    preview = null;
    previewBox.hidden = true;
    save.disabled = true;
  }

  function decision() {
    const body = {
      sourceId: item.sourceId,
      typeCode: item.typeCode,
      scope: item.scope,
      normalizedSourceValue: item.normalizedSourceValue,
      contextKey: item.contextKey,
      action: modeSelect.value === "ignore" ? "ignore" : "confirm",
    };
    if (modeSelect.value === "internal") body.referenceValueId = selected?.id;
    if (modeSelect.value === "wordpress") {
      const target = activeTarget();
      const capability = capabilityFor(item.typeCode, target);
      body.targetLink = { targetId: target.id, targetScope: capability.targetScope, dictionaryValueId: selected?.id };
    }
    return body;
  }

  async function runSearch() {
    selected = null;
    resetPreview();
    results.replaceChildren(document.createTextNode("Ищем..."));
    try {
      if (modeSelect.value === "ignore") {
        results.replaceChildren(document.createTextNode("Это значение исчезнет из очереди, но останется в истории. Товары будут переобработаны."));
        return;
      }
      let response;
      if (modeSelect.value === "internal") {
        response = await api(`/api/classifier/reference-values?${new URLSearchParams({ typeCode: item.typeCode, search: search.value.trim(), limit: "50" })}`);
      } else {
        const target = activeTarget();
        const capability = capabilityFor(item.typeCode, target);
        if (!target || !capability) throw new Error("Для этого типа нет основного поля WordPress. Используйте дополнительное назначение.");
        response = await api(`/api/targets/${target.id}/dictionary?${new URLSearchParams({ entityType: capability.entityType, search: search.value.trim(), limit: "50" })}`);
      }
      results.replaceChildren();
      for (const option of response.items || []) {
        const row = button("", "mapping-result");
        row.append(textBlock(option.name, modeSelect.value === "wordpress" ? [option.taxonomy, option.slug, `term #${option.externalId}`].filter(Boolean).join(" · ") : option.code));
        row.addEventListener("click", () => {
          selected = option;
          resetPreview();
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
  actions.className = "dialog-actions sticky-dialog-actions";
  const searchButton = button("Найти", "button secondary");
  searchButton.addEventListener("click", runSearch);
  const previewButton = button("Проверить изменения", "button secondary");
  previewButton.addEventListener("click", async () => {
    if (modeSelect.value !== "ignore" && !selected) return alert("Сначала выберите значение из списка.");
    try {
      const response = await api("/api/classifier/decisions/preview", { method: "POST", body: decision() });
      preview = response.preview;
      previewBox.hidden = false;
      previewBox.textContent = preview.unchanged
        ? `Изменений не будет. Сейчас уже настроено это решение (${preview.productCount} товаров).`
        : `Будет переобработано товаров: ${preview.productCount}. Наблюдений: ${preview.observationCount}. WordPress не изменяется.`;
      save.disabled = false;
    } catch (error) {
      preview = null;
      previewBox.hidden = false;
      previewBox.textContent = error.message;
      save.disabled = true;
    }
  });
  const save = button("Сохранить", "button primary");
  save.disabled = true;
  save.addEventListener("click", async () => {
    if (!preview) return alert("Сначала проверьте изменения.");
    await api("/api/classifier/decisions", { method: "POST", body: decision() });
    dialog.close();
    await load();
  });
  actions.append(searchButton, previewButton, save);
  form.append(intro, current, field("Что сделать", modeSelect), field("Найти внутреннее значение", search), results, previewBox, actions);
  modeSelect.addEventListener("change", runSearch);
  search.addEventListener("input", resetPreview);
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch();
    }
  });
  dialog.showModal();
  await runSearch();
}

async function openRuleDialog(item) {
  const [fieldsResponse, referencesResponse] = await Promise.all([
    api(`/api/classifier/rule-fields?${new URLSearchParams({ sourceId: item.sourceId, typeCode: item.typeCode })}`),
    api(`/api/classifier/reference-values?${new URLSearchParams({ typeCode: item.typeCode, search: item.referenceName || "", limit: "50" })}`),
  ]);
  const { dialog, form } = dialogShell("Редактировать правило");
  dialog.classList.add("dialog-wide");
  const intro = document.createElement("p");
  intro.className = "dialog-intro";
  intro.textContent = "Правило применяется только когда совпали все условия. Поля и примеры взяты из актуальных товаров этого источника.";
  const name = input(item.ruleName || "");
  const referenceSearch = input(item.referenceName || "");
  const referenceResults = document.createElement("div");
  referenceResults.className = "mapping-results compact-results";
  let selectedReference = { id: item.referenceValueId, name: item.referenceName };
  const priority = input(String(item.priority ?? 100), "number");
  const conditionsList = document.createElement("div");
  conditionsList.className = "conditions-list";
  const fieldOptions = [...(fieldsResponse.items || [])];
  for (const condition of item.conditions || []) {
    if (!fieldOptions.some((option) => option.field === condition.field)) fieldOptions.push({ field: condition.field, exampleValues: [] });
  }
  const previewBox = document.createElement("div");
  previewBox.className = "rule-preview";
  previewBox.hidden = true;
  let preview = null;

  function resetPreview() {
    preview = null;
    previewBox.hidden = true;
    save.disabled = true;
  }

  function renderReferenceResults(items) {
    referenceResults.replaceChildren();
    for (const option of items || []) {
      const row = button("", "mapping-result");
      row.append(textBlock(option.name, option.code));
      if (option.id === selectedReference?.id) row.classList.add("selected");
      row.addEventListener("click", () => {
        selectedReference = option;
        referenceSearch.value = option.name;
        resetPreview();
        renderReferenceResults(items);
      });
      referenceResults.append(row);
    }
    if (!referenceResults.childElementCount) referenceResults.textContent = "Ничего не найдено.";
  }

  async function searchReferences() {
    const response = await api(`/api/classifier/reference-values?${new URLSearchParams({ typeCode: item.typeCode, search: referenceSearch.value.trim(), limit: "50" })}`);
    renderReferenceResults(response.items || []);
  }

  function addCondition(condition = { field: fieldOptions[0]?.field || "sourceValue", operator: "equals", value: "" }) {
    const row = document.createElement("div");
    row.className = "condition-row";
    const fieldSelect = document.createElement("select");
    for (const option of fieldOptions) {
      const examples = option.exampleValues?.length ? ` — напр. ${option.exampleValues.slice(0, 2).join(", ")}` : "";
      fieldSelect.append(new Option(`${ruleFieldLabel(option.field)}${examples}`, option.field));
    }
    fieldSelect.value = condition.field;
    const operator = document.createElement("select");
    operator.append(
      new Option("равно", "equals"),
      new Option("содержит фразу", "contains"),
      new Option("содержит все слова", "all_words"),
      new Option("регулярное выражение", "regex"),
    );
    operator.value = condition.operator;
    const value = input(condition.value);
    value.placeholder = "Значение условия";
    const remove = button("×", "condition-remove");
    remove.title = "Удалить условие";
    remove.addEventListener("click", () => { row.remove(); resetPreview(); });
    for (const control of [fieldSelect, operator, value]) control.addEventListener("input", resetPreview);
    row.append(fieldSelect, operator, value, remove);
    conditionsList.append(row);
  }

  function draft() {
    if (!selectedReference?.id) throw new Error("Выберите внутреннее значение результата.");
    const conditions = [...conditionsList.querySelectorAll(".condition-row")].map((row) => ({
      field: row.children[0].value,
      operator: row.children[1].value,
      value: row.children[2].value.trim(),
    }));
    return {
      sourceId: item.sourceId,
      typeCode: item.typeCode,
      name: name.value.trim(),
      priority: Number(priority.value),
      referenceValueId: selectedReference.id,
      conditions,
    };
  }

  const conditionsHeading = document.createElement("div");
  conditionsHeading.className = "conditions-heading";
  const conditionsTitle = document.createElement("h3");
  conditionsTitle.textContent = "Когда применять";
  const addConditionButton = button("+ Добавить условие");
  addConditionButton.addEventListener("click", () => { addCondition(); resetPreview(); });
  conditionsHeading.append(conditionsTitle, addConditionButton);
  for (const condition of item.conditions || []) addCondition(condition);

  const advanced = document.createElement("details");
  advanced.className = "advanced-details";
  const advancedTitle = document.createElement("summary");
  advancedTitle.textContent = "Дополнительные настройки";
  advanced.append(advancedTitle, field("Приоритет правила", priority));
  priority.addEventListener("input", resetPreview);
  name.addEventListener("input", resetPreview);
  referenceSearch.addEventListener("input", resetPreview);

  const actions = document.createElement("div");
  actions.className = "dialog-actions sticky-dialog-actions";
  const searchButton = button("Найти результат", "button secondary");
  searchButton.addEventListener("click", searchReferences);
  const previewButton = button("Проверить правило", "button secondary");
  previewButton.addEventListener("click", async () => {
    try {
      const response = await api("/api/classifier/rules/preview", { method: "POST", body: draft() });
      preview = response.preview;
      previewBox.hidden = false;
      previewBox.textContent = `Совпало товаров: ${preview.matchedProducts}. Будет переобработано: ${preview.affectedProducts}. Конфликтов: ${preview.ambiguousObservations}. Точных сопоставлений с приоритетом выше: ${preview.shadowedObservations}.`;
      save.disabled = false;
    } catch (error) {
      preview = null;
      previewBox.hidden = false;
      previewBox.textContent = error.message;
      save.disabled = true;
    }
  });
  const save = button("Сохранить", "button primary");
  save.disabled = true;
  save.addEventListener("click", async () => {
    if (!preview) {
      alert("Сначала выполните preview.");
      return;
    }
    await api(`/api/classifier/rules/${item.id}`, { method: "PATCH", body: draft() });
    dialog.close();
    await load();
  });
  actions.append(searchButton, previewButton, save);
  form.append(
    intro,
    field("Название", name),
    field("Результат правила", referenceSearch),
    referenceResults,
    conditionsHeading,
    conditionsList,
    advanced,
    previewBox,
    actions,
  );
  dialog.showModal();
  renderReferenceResults(referencesResponse.items || []);
}

function ruleFieldLabel(value) {
  return ({
    sourceValue: "Исходное значение",
    "context.brand": "Бренд",
    "context.family": "Семейство модели",
    "context.audience": "Аудитория",
    "context.productType": "Тип товара",
    "context.productCategory": "Структурная категория",
    "evidence.merchandisingCategory": "Категория GOAT",
    "evidence.title": "Полное название",
    "evidence.route": "Раздел GOAT",
  })[value] || value;
}

async function openProjectionDialog(item, editing = false, defaults = {}) {
  await loadTargets();
  const target = editing ? state.targets.find((entry) => entry.id === item.targetId) : activeTarget();
  if (!target) {
    alert("Целевой сайт не настроен.");
    return;
  }
  const { dialog, form } = dialogShell(editing ? "Изменить дополнительное назначение" : "Добавить назначение WordPress");
  dialog.classList.add("dialog-wide");
  const intro = document.createElement("p");
  intro.className = "dialog-intro";
  intro.textContent = "Дополнительное назначение не меняет смысл исходного значения. Оно добавляет ещё одну категорию, метку или атрибут WordPress к товарам, которые получили это решение классификатора.";
  const source = document.createElement("div");
  source.className = "mapping-current";
  source.append(
    textBlock("Решение классификатора", item.ruleName || item.sourceValue || item.referenceName || `#${item.id}`),
    textBlock("Внутреннее значение", item.referenceName || "-"),
  );
  const scope = document.createElement("select");
  for (const capability of target.dictionary?.classificationCapabilities || []) {
    scope.append(new Option(`${targetScopeLabel(capability.targetScope)} · ${capability.targetScope}`, capability.targetScope));
  }
  if (editing && item.targetScope) scope.value = item.targetScope;
  else if (defaults.targetScope && [...scope.options].some((option) => option.value === defaults.targetScope)) scope.value = defaults.targetScope;
  const search = input(defaults.search || (editing ? item.targetLabel || "" : item.referenceName || item.sourceValue || ""));
  const results = document.createElement("div");
  results.className = "mapping-results";
  const previewBox = document.createElement("div");
  previewBox.className = "rule-preview";
  previewBox.hidden = true;
  let selected = editing && item.targetDictionaryValueId
    ? { id: item.targetDictionaryValueId, name: item.targetLabel, externalId: item.targetExternalId, taxonomy: item.targetTaxonomy }
    : null;
  let preview = null;

  function resetPreview() {
    preview = null;
    previewBox.hidden = true;
    save.disabled = true;
  }

  function entityType() {
    return (target.dictionary?.classificationCapabilities || []).find((capability) => capability.targetScope === scope.value)?.entityType;
  }
  function projectionBody() {
    return editing ? {
      targetScope: scope.value,
      dictionaryValueId: selected.id,
    } : {
      targetId: target.id,
      resolutionKind: item.kind === "rule" ? "rule" : "mapping",
      resolutionId: item.id,
      targetScope: scope.value,
      dictionaryValueId: selected.id,
    };
  }
  async function runSearch() {
    selected = null;
    resetPreview();
    const response = await api(`/api/targets/${target.id}/dictionary?${new URLSearchParams({ entityType: entityType(), search: search.value.trim(), limit: "50" })}`);
    results.replaceChildren();
    for (const option of response.items || []) {
      const row = button("", "mapping-result");
      row.append(textBlock(option.name, [option.taxonomy, option.slug, `term #${option.externalId}`].filter(Boolean).join(" · ")));
      row.addEventListener("click", () => {
        selected = option;
        resetPreview();
        for (const node of results.querySelectorAll(".mapping-result")) node.classList.remove("selected");
        row.classList.add("selected");
      });
      results.append(row);
    }
  }
  const actions = document.createElement("div");
  actions.className = "dialog-actions sticky-dialog-actions";
  const searchButton = button("Искать", "button secondary");
  searchButton.addEventListener("click", runSearch);
  const previewButton = button("Проверить изменения", "button secondary");
  previewButton.addEventListener("click", async () => {
    if (!selected) {
      alert("Сначала выберите term.");
      return;
    }
    const previewUrl = editing
      ? `/api/targets/${target.id}/classification-projections/${item.id}/preview-update`
      : "/api/classifier/projections/preview";
    const response = await api(previewUrl, { method: "POST", body: projectionBody() });
    preview = response.preview;
    previewBox.hidden = false;
    previewBox.textContent = `Будет переобработано товаров: ${preview.productCount}. Наблюдений: ${preview.observationCount}. Уже существует: ${preview.duplicate ? "да" : "нет"}. Конфликтов одиночного поля: ${preview.cardinalityConflicts?.length || 0}. WordPress сейчас не изменяется.`;
    save.disabled = Boolean(preview.duplicate) || (preview.cardinalityConflicts?.length || 0) > 0;
  });
  const save = button("Сохранить", "button primary");
  save.disabled = true;
  save.addEventListener("click", async () => {
    if (!preview) {
      alert("Сначала выполните preview.");
      return;
    }
    await api(editing ? `/api/targets/${target.id}/classification-projections/${item.id}` : "/api/classifier/projections", {
      method: editing ? "PATCH" : "POST",
      body: projectionBody(),
    });
    dialog.close();
    await load();
  });
  actions.append(searchButton, previewButton, save);
  form.append(intro, source, field("Куда добавить в WordPress", scope), field("Найти значение WordPress", search), results, previewBox, actions);
  scope.addEventListener("change", runSearch);
  search.addEventListener("input", resetPreview);
  dialog.showModal();
  await runSearch();
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

async function openTargetMappingDialog(item) {
  await loadTargets();
  const target = state.targets.find((entry) => entry.id === item.targetId);
  const capability = capabilityFor(item.typeCode, target);
  if (!target || !capability) return alert("Для этой связи больше не настроен справочник WordPress.");
  const { dialog, form } = dialogShell("Изменить основное поле WordPress");
  dialog.classList.add("dialog-wide");
  const intro = document.createElement("p");
  intro.className = "dialog-intro";
  intro.textContent = `Внутреннее значение «${item.referenceName}» используется как ${targetScopeLabel(item.targetScope)}. Выберите другой термин WordPress и проверьте затронутые товары.`;
  const current = document.createElement("div");
  current.className = "mapping-current";
  current.append(textBlock("Внутреннее значение", item.referenceName), textBlock("Сейчас в WordPress", `${item.targetLabel} · ${item.targetTaxonomy || item.targetScope}`));
  const search = input(item.targetLabel || item.referenceName || "");
  const results = document.createElement("div");
  results.className = "mapping-results";
  const previewBox = document.createElement("div");
  previewBox.className = "rule-preview";
  previewBox.hidden = true;
  let selected = item.targetDictionaryValueId ? { id: item.targetDictionaryValueId } : null;
  let preview = null;

  function resetPreview() {
    preview = null;
    previewBox.hidden = true;
    save.disabled = true;
  }
  async function runSearch() {
    selected = null;
    resetPreview();
    const response = await api(`/api/targets/${target.id}/dictionary?${new URLSearchParams({ entityType: capability.entityType, search: search.value.trim(), limit: "50" })}`);
    results.replaceChildren();
    for (const option of response.items || []) {
      const row = button("", "mapping-result");
      row.append(textBlock(option.name, [option.taxonomy, option.slug, `term #${option.externalId}`].filter(Boolean).join(" · ")));
      row.addEventListener("click", () => {
        selected = option;
        resetPreview();
        for (const node of results.querySelectorAll(".mapping-result")) node.classList.remove("selected");
        row.classList.add("selected");
      });
      results.append(row);
    }
    if (!results.childElementCount) results.textContent = "Ничего не найдено.";
  }
  const actions = document.createElement("div");
  actions.className = "dialog-actions sticky-dialog-actions";
  const searchButton = button("Найти", "button secondary");
  searchButton.addEventListener("click", runSearch);
  const previewButton = button("Проверить изменения", "button secondary");
  previewButton.addEventListener("click", async () => {
    if (!selected) return alert("Сначала выберите термин WordPress.");
    const response = await api(`/api/classifier/target-mappings/${item.id}/preview`, { method: "POST", body: { dictionaryValueId: selected.id } });
    preview = response.preview;
    previewBox.hidden = false;
    previewBox.textContent = `Будет переобработано товаров: ${preview.productCount}. Наблюдений: ${preview.observationCount}. WordPress сейчас не изменяется.`;
    save.disabled = false;
  });
  const save = button("Сохранить", "button primary");
  save.disabled = true;
  save.addEventListener("click", async () => {
    if (!preview || !selected) return alert("Сначала проверьте изменения.");
    await api(`/api/classifier/target-mappings/${item.id}`, { method: "PATCH", body: { dictionaryValueId: selected.id } });
    dialog.close();
    await load();
  });
  actions.append(searchButton, previewButton, save);
  form.append(intro, current, field("Найти термин WordPress", search), results, previewBox, actions);
  search.addEventListener("input", resetPreview);
  dialog.showModal();
  await runSearch();
}

async function setRuleStatus(item) {
  const action = item.status === "active" ? "deactivate" : "reactivate";
  const result = await api(`/api/classifier/rules/${item.id}/${action}`, { method: "POST", body: {} });
  alert(`Готово. На обработку поставлено товаров: ${result.rule.affectedProductCount}`);
  await load();
}

async function deleteRule(item) {
  if (!confirm(`Удалить правило «${item.ruleName}»? Оно исчезнет из настроек, связанные назначения отключатся, а товары будут поставлены на переобработку. WordPress сейчас не изменится.`)) return;
  const result = await api(`/api/classifier/rules/${item.id}`, { method: "DELETE", body: {} });
  alert(`Правило удалено. На обработку поставлено товаров: ${result.rule.affectedProductCount}`);
  await load();
}

async function setTargetMappingStatus(item) {
  const action = item.status === "active" ? "deactivate" : "reactivate";
  if (!confirm(`${item.status === "active" ? "Отключить" : "Включить"} основную связь «${item.referenceName} → ${item.targetLabel}»? Товары будут переобработаны, WordPress сейчас не изменится.`)) return;
  const result = await api(`/api/classifier/target-mappings/${item.id}/${action}`, { method: "POST", body: {} });
  alert(`Готово. На обработку поставлено товаров: ${result.mapping.affectedProductCount}`);
  await load();
}

async function setProjectionStatus(item) {
  if (item.status === "active") {
    if (!confirm(`Отключить дополнительное назначение «${item.targetLabel}»? Товары будут переобработаны, WordPress сейчас не изменится.`)) return;
    const result = await api(`/api/targets/${item.targetId}/classification-projections/${item.id}/deactivate`, { method: "POST", body: {} });
    alert(`Готово. На обработку поставлено товаров: ${result.projection.affectedProductCount}`);
  } else {
    const body = { targetScope: item.targetScope, dictionaryValueId: item.targetDictionaryValueId };
    const checked = await api(`/api/targets/${item.targetId}/classification-projections/${item.id}/preview-update`, { method: "POST", body });
    if (!confirm(`Включить назначение для ${checked.preview.productCount} товаров? WordPress сейчас не изменится.`)) return;
    const result = await api(`/api/targets/${item.targetId}/classification-projections/${item.id}`, { method: "PATCH", body });
    alert(`Готово. На обработку поставлено товаров: ${result.projection.affectedProductCount}`);
  }
  await load();
}

function configure() {
  const titles = {
    products: "Товары",
    operations: "Реестр операций",
    runtime: "Парсер",
    jobs: "Очередь и ошибки",
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
  if (mode === "operations" || mode === "runtime") byId("filters").hidden = true;
  if (mode === "jobs") {
    byId("source-filter").querySelector("span").textContent = "Job type";
    byId("source").replaceChildren(new Option("Все", ""), new Option("Discovery", "discover_source"), new Option("Сбор", "collect_product"), new Option("Обработка", "process_product"), new Option("Переклассификация", "reclassify_product"), new Option("Связи WordPress", "sync_target_classifications"), new Option("Применение связей WordPress", "apply_target_classification_suggestion"), new Option("Preflight WordPress", "preflight_product"), new Option("Экспорт", "export_product"));
    byId("stage-filter").querySelector("span").textContent = "Статус";
    byId("stage").replaceChildren(new Option("Все", ""), new Option("В очереди", "pending"), new Option("Выполняется", "running"), new Option("Повтор", "retry"), new Option("Ошибка", "failed"), new Option("Выполнено", "completed"));
    byId("classification-filter").hidden = true;
    byId("target-filter").hidden = true;
    byId("search").placeholder = "Job ID, sourceProductId или текст ошибки";
    window.setInterval(refreshLiveElapsed, 1_000);
  }
  if (mode === "runtime") {
    const runtime = document.createElement("section");
    runtime.id = "runtime-panel";
    runtime.className = "runtime-grid";
    runtime.innerHTML = `
      <section class="section runtime-card">
        <div class="section-title"><div><p class="eyebrow">Production</p><h2>Worker парсера</h2></div><span id="runtime-status" class="badge">-</span></div>
        <dl class="config-meta-grid">
          <dt>Service</dt><dd id="runtime-worker-service">-</dd>
          <dt>State</dt><dd id="runtime-worker-state">-</dd>
        </dl>
        <div class="runtime-actions">
          <button id="runtime-start" class="button primary" type="button">Запустить worker</button>
          <button id="runtime-stop" class="button danger-quiet" type="button">Остановить</button>
          <button id="runtime-refresh" class="button quiet" type="button">Обновить</button>
        </div>
        <p class="muted runtime-note">Это единственный production worker. Он выполняет discovery, сбор, обработку и экспорт по настроенным на сервере потокам.</p>
      </section>
      <section class="section runtime-card">
        <div class="section-title"><div><p class="eyebrow">Runtime</p><h2>Worker и экспорт</h2></div><span id="runtime-settings-status" class="badge">-</span></div>
        <div class="runtime-lane-settings">
          <label><span>Сбор товаров</span><input id="runtime-collection-concurrency" type="number" min="1" max="16" step="1"></label>
          <label><span>Обработка</span><input id="runtime-process-concurrency" type="number" min="1" max="16" step="1"></label>
          <label><span>Preflight WordPress</span><input id="runtime-preflight-concurrency" type="number" min="1" max="8" step="1"></label>
          <div><span>Discovery</span><strong>1</strong></div>
          <div><span>Экспорт</span><strong>1</strong></div>
        </div>
        <label class="confirm-check"><input id="runtime-refresh-source-before-export" type="checkbox"><span>Перед записью получать у источника актуальные цену, наличие и размеры</span></label>
        <p class="muted runtime-note">Запрос выполняется один раз внутри той же export-задачи. Товар не возвращается в конец очереди и не проходит повторную обработку.</p>
        <p id="runtime-settings-saved" class="muted runtime-note">-</p>
        <p id="runtime-settings-applied" class="muted runtime-note">-</p>
        <div class="runtime-actions">
          <button id="runtime-settings-save" class="button secondary" type="button">Сохранить</button>
          <button id="runtime-settings-apply" class="button primary" type="button">Сохранить и перезапустить</button>
        </div>
        <p class="muted runtime-note">Сбор и включённое обновление перед экспортом ограничиваются доступными proxy sessions. Discovery и записывающий export намеренно выполняются последовательно.</p>
      </section>
      <section class="section runtime-card">
        <div class="section-title"><div><p class="eyebrow">GOAT</p><h2>Discovery</h2></div></div>
        <label class="field"><span>Размер страницы</span><input id="discovery-batch-size" type="number" min="1" value="500"></label>
        <label class="field"><span>Задержка запросов, мс</span><input id="discovery-delay" type="number" min="1" value="1000"></label>
        <label class="confirm-check"><input id="discovery-enqueue-collection" type="checkbox"><span>После discovery сразу ставить товары на сбор. Для полного каталога включать только осознанно.</span></label>
        <button id="runtime-discovery" class="button secondary" type="button">Поставить discovery</button>
      </section>
      <section class="section runtime-card runtime-wide">
        <div class="section-title"><div><p class="eyebrow">Очередь</p><h2>Jobs</h2></div></div>
        <div id="runtime-queue" class="runtime-list"></div>
      </section>
      <section class="section runtime-card runtime-wide">
        <div class="section-title"><div><p class="eyebrow">Логи</p><h2>События управления</h2></div></div>
        <div id="runtime-logs" class="runtime-logs"></div>
      </section>
    `;
    byId("filters").after(runtime);
    byId("runtime-start").addEventListener("click", async () => {
      if (!confirm("Запустить production worker? Он начнёт выполнять всю доступную очередь jobs.")) return;
      await api("/api/runtime/start", { method: "POST", body: {} });
      await load();
    });
    byId("runtime-stop").addEventListener("click", async () => {
      if (!confirm("Остановить production worker после завершения текущей операции? Задачи в очереди сохранятся.")) return;
      await api("/api/runtime/stop", { method: "POST", body: {} });
      await load();
    });
    byId("runtime-refresh").addEventListener("click", load);
    byId("runtime-settings-save").addEventListener("click", () => saveRuntimeSettings(false));
    byId("runtime-settings-apply").addEventListener("click", () => saveRuntimeSettings(true));
    byId("runtime-discovery").addEventListener("click", async () => {
      const enqueueCollection = byId("discovery-enqueue-collection").checked;
      if (enqueueCollection && !confirm("Discovery полного каталога с автоматическим сбором может поставить много collect_product jobs. Продолжить?")) return;
      const result = await api("/api/runtime/goat/discovery", { method: "POST", body: {
        discoveryBatchSize: byId("discovery-batch-size").value,
        requestDelayMs: byId("discovery-delay").value,
        enqueueCollection,
      } });
      alert(`Discovery job создан: ${result.item.job.id}`);
      await load();
    });
  }
  if (mode === "snapshots") for (const id of ["source-filter", "stage-filter", "classification-filter", "target-filter"]) byId(id).hidden = true;
  if (mode === "classifierConfig") {
    byId("search").placeholder = "Исходное, внутреннее или WordPress-значение";
    byId("source-filter").querySelector("span").textContent = "Источник";
    byId("stage-filter").hidden = true;
    byId("classification-filter").querySelector("span").textContent = "Тип";
    byId("classification").replaceChildren(new Option("Все", ""));
    byId("target-filter").querySelector("span").textContent = "Статус";
    byId("target-status").replaceChildren(new Option("Все", ""), new Option("Активна", "active"), new Option("Отключена", "inactive"), new Option("Игнор", "ignored"));
    const intro = document.createElement("section");
    intro.className = "config-intro";
    const copy = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = "Настройки классификации";
    const description = document.createElement("p");
    description.id = "config-description";
    description.className = "muted";
    copy.append(title, description);
    const tabs = document.createElement("div");
    tabs.className = "config-tabs";
    const labels = {
      mapping: "1. Исходные значения",
      rule: "2. Контекстные правила",
      target_mapping: "3. Основные поля WordPress",
      projection: "4. Дополнительные назначения",
    };
    for (const [kind, label] of Object.entries(labels)) {
      const tab = button(label, `config-tab${kind === state.configKind ? " active" : ""}`);
      tab.addEventListener("click", () => {
        state.configDeepLink = null;
        state.configKind = kind;
        state.offset = 0;
        if (kind === "target_mapping") byId("source").value = "";
        for (const node of tabs.querySelectorAll(".config-tab")) node.classList.toggle("active", node === tab);
        updateConfigDescription();
        updateConfigFilters();
        load();
      });
      tabs.append(tab);
    }
    const counterNote = document.createElement("p");
    counterNote.className = "config-counter-note";
    counterNote.textContent = "«Применено» — это уже пересчитанные товары, а не прогноз правила. Новая запись показывает 0, пока её переклассификация стоит в очереди.";
    intro.append(copy, tabs, counterNote);
    byId("filters").before(intro);
    updateConfigDescription();
    updateConfigFilters();
  }
  if (mode === "products") {
    byId("bulk-panel").hidden = false;
    byId("bulk-action").addEventListener("change", updateBulkActionHelp);
    updateBulkActionHelp();
    byId("bulk-page").addEventListener("click", () => {
      for (const id of state.pageProductIds) state.selectedProductIds.add(id);
      renderProducts((state.lastItems || []));
    });
    byId("bulk-clear").addEventListener("click", () => {
      state.selectedProductIds.clear();
      renderProducts((state.lastItems || []));
    });
    byId("bulk-preview").addEventListener("click", () => {
      previewBulk().catch((error) => {
        byId("bulk-result").hidden = false;
        byId("bulk-result").textContent = error.message;
      });
    });
  }
}

function updateConfigDescription() {
  const description = byId("config-description");
  if (!description) return;
  description.textContent = ({
    mapping: "Как конкретное значение источника переводится во внутренний справочник. Например: Pink → Розовый.",
    rule: "Как значение определяется по нескольким признакам товара. Здесь настраиваются модели и категории с контекстом.",
    target_mapping: "Куда внутреннее значение попадает в своё основное поле WordPress. Например: Розовый → pa_tsvet.",
    projection: "Какие дополнительные категории, метки или атрибуты WordPress нужно добавить к уже принятому решению.",
  })[state.configKind];
}

function updateConfigFilters() {
  if (mode !== "classifierConfig") return;
  byId("source-filter").hidden = state.configKind === "target_mapping";
  const status = byId("target-status");
  const ignored = [...status.options].find((option) => option.value === "ignored");
  if (ignored) ignored.hidden = state.configKind !== "mapping";
  if (state.configKind !== "mapping" && status.value === "ignored") status.value = "";
}

async function load() {
  byId("loading").hidden = false;
  byId("error").hidden = true;
  byId("empty").hidden = true;
  byId("table-section").hidden = true;
  try {
    let data;
    let configUsageParams = null;
    if (mode === "operations") {
      data = await api("/api/operations");
    } else if (mode === "runtime") {
      data = await api("/api/runtime");
    } else if (mode === "jobs") {
      const params = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
      const search = byId("search").value.trim();
      if (search) params.set("search", search);
      if (byId("source").value) params.set("jobType", byId("source").value);
      if (byId("stage").value) params.set("status", byId("stage").value);
      data = await api(`/api/jobs?${params}`);
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
        state.lastItems = data.items || [];
        if (byId("source").options.length === 1) for (const source of data.sources) byId("source").append(new Option(source.name, source.code));
      } else if (mode === "classifierConfig") {
        params.set("kind", state.configKind);
        if (state.configDeepLink && !state.configDeepLink.opened) params.set("configId", state.configDeepLink.id);
        for (const [id, key] of [["source", "sourceId"], ["classification", "typeCode"], ["target-status", "status"]]) {
          const value = byId(id).value;
          if (value) params.set(key, value);
        }
        if (!(state.configDeepLink && !state.configDeepLink.opened)) {
          params.set("usage", "none");
          configUsageParams = new URLSearchParams(params);
          configUsageParams.delete("usage");
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
    if (state.total > 0 && state.offset >= state.total) {
      state.offset = (Math.ceil(state.total / state.limit) - 1) * state.limit;
      return load();
    }
    if (mode === "runtime") {
      renderRuntime(data);
      byId("empty").hidden = true;
      byId("table-section").hidden = true;
      byId("page-info").textContent = "";
      byId("prev").disabled = true;
      byId("next").disabled = true;
      return;
    }
    if (mode === "products") renderProducts(items);
    else if (mode === "operations") renderOperations(items);
    else if (mode === "jobs") renderJobs(data);
    else if (mode === "classifierConfig") {
      renderConfig(items, data.usageIncluded);
      if (configUsageParams) void hydrateConfigUsage(configUsageParams, items);
      if (state.configDeepLink && !state.configDeepLink.opened) {
        const linked = items.find((item) => item.kind === state.configKind && item.id === state.configDeepLink.id);
        if (linked) {
          state.configDeepLink.opened = true;
          if (state.configDeepLink.action === "projection") {
            void openProjectionDialog(linked, false, {
              targetScope: state.configDeepLink.targetScope,
              search: state.configDeepLink.search,
            });
          } else {
            void openConfigDetails(linked);
          }
        }
      }
    }
    else renderSnapshots(items);
    byId("empty").hidden = items.length !== 0;
    byId("table-section").hidden = items.length === 0;
    renderPagination(items.length);
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
  state.configDeepLink = null;
  state.offset = 0;
  load();
});
byId("prev").addEventListener("click", () => {
  goToPage(Math.floor(state.offset / state.limit));
});
byId("next").addEventListener("click", () => {
  goToPage(Math.floor(state.offset / state.limit) + 2);
});
byId("page-jump").addEventListener("submit", (event) => {
  event.preventDefault();
  goToPage(byId("page-number").value);
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
