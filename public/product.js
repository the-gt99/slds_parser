const byId = (id) => document.getElementById(id);

const state = { session: null, product: null };
const productId = location.pathname.match(/^\/products\/(\d+)\/?$/u)?.[1] ?? null;

const statusNames = {
  discovered: "Обнаружен",
  active: "Активен у источника",
  classified: "Классифицирован",
  processed: "Обработан",
  classification_pending: "Ожидает классификации",
  pending: "В очереди",
  running: "Выполняется",
  retry: "Повтор",
  completed: "Выполнено",
  failed: "Ошибка",
  resolved: "Сопоставлено",
  ignored: "Игнорируется",
  unresolved: "Не сопоставлено",
  ambiguous: "Конфликт правил",
  synced: "Загружен",
  not_exported: "Не выгружен",
  available: "В наличии",
  unavailable: "Нет в наличии",
  preorder: "Предзаказ",
  unknown: "Неизвестно",
};

const jobNames = {
  collect_product: "Сбор данных",
  process_product: "Обработка товара",
  export_product: "Выгрузка на target",
  discover_source: "Получение каталога",
};

const attributeNames = {
  brand: "Бренд",
  family: "Семейство источника",
  gender: "Пол / аудитория",
  color: "Цвет источника",
  upperMaterial: "Материал верха",
  midsole: "Промежуточная подошва",
  categoryRaw: "Категория источника",
  productCategory: "Тип категории",
  productType: "Тип товара",
  season: "Сезон источника",
  releaseDate: "Дата релиза",
  status: "Статус источника",
};

function humanStatus(status) {
  return statusNames[status] ?? status ?? "Неизвестно";
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? String(value)
    : new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.map(formatValue).join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  return String(value);
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
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (method !== "GET" && method !== "HEAD" && state.session?.csrfToken) {
    headers["X-CSRF-Token"] = state.session.csrfToken;
  }
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || (response.status === 401 ? "Требуется вход." : `Ошибка HTTP ${response.status}`));
    error.status = response.status;
    throw error;
  }
  return data;
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
  if (!session.authenticated) return showLogin();
  state.session = session;
  showApp();
  await loadProduct();
}

async function login(event) {
  event.preventDefault();
  const error = byId("login-error");
  clearError(error);
  const submit = event.submitter;
  submit.disabled = true;
  try {
    state.session = await api("/api/auth/login", {
      method: "POST",
      body: { username: byId("login-username").value, password: byId("login-password").value },
    });
    showApp();
    await loadProduct();
  } catch (requestError) {
    showError(error, requestError.message);
  } finally {
    submit.disabled = false;
  }
}

async function logout() {
  try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch { /* Session may already be gone. */ }
  state.session = null;
  showLogin();
}

function badge(text, status = "") {
  const value = document.createElement("span");
  value.className = `badge status-${status}`;
  value.textContent = text;
  return value;
}

function externalLink(label, url) {
  const link = document.createElement("a");
  link.className = "button secondary";
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  return link;
}

function addDefinition(list, name, value) {
  const term = document.createElement("dt");
  term.textContent = name;
  const description = document.createElement("dd");
  description.textContent = formatValue(value);
  list.append(term, description);
}

function renderHero(item) {
  const product = item.product;
  const sourceProduct = item.sourceProduct;
  const title = product?.title || sourceProduct.slug || sourceProduct.sourceKey;
  document.title = `SLDS · ${title}`;
  byId("product-title").textContent = title;
  byId("product-subtitle").textContent = [product?.sku, `${item.source.name} · ID ${sourceProduct.id}`].filter(Boolean).join(" · ");
  byId("product-badges").replaceChildren(
    badge(item.source.code),
    badge(humanStatus(product?.status ?? sourceProduct.status), product?.status ?? sourceProduct.status),
  );

  const links = byId("product-links");
  links.replaceChildren();
  if (sourceProduct.donorUrl) links.append(externalLink("Открыть у источника ↗", sourceProduct.donorUrl));

  const image = product?.images?.[0];
  const imageWrap = byId("product-image-wrap");
  imageWrap.hidden = !image;
  if (image) {
    const element = byId("product-image");
    element.src = image.url;
    element.alt = image.alt || title;
    element.onerror = () => { imageWrap.hidden = true; };
  }

  const summary = byId("product-summary");
  summary.replaceChildren();
  addDefinition(summary, "ID источника", sourceProduct.externalId);
  addDefinition(summary, "Впервые найден", formatDate(sourceProduct.firstSeenAt));
  addDefinition(summary, "Последнее обновление", formatDate(sourceProduct.updatedAt));
  addDefinition(summary, "Обработан", formatDate(product?.processedAt));
  addDefinition(summary, "Изображения", product?.images?.length ?? 0);
  addDefinition(summary, "Варианты", product?.variants?.length ?? 0);
}

function renderData(item) {
  const product = item.product;
  const description = byId("product-description");
  description.textContent = product?.description || "Описание ещё не сформировано.";
  description.classList.toggle("muted", !product?.description);
  const attributes = byId("product-attributes");
  attributes.replaceChildren();
  if (!product) {
    addDefinition(attributes, "Состояние", "Товар ещё не обработан");
    return;
  }
  for (const [key, value] of Object.entries(product.attributes ?? {})) {
    if (value === null || value === undefined || value === "") continue;
    const name = key === "season" && item.source.code === "goat"
      ? "Год коллекции GOAT"
      : attributeNames[key] ?? key;
    addDefinition(attributes, name, value);
  }
  addDefinition(attributes, "Версия процессора", product.processorVersion);
  addDefinition(attributes, "Внутренний ID", product.internalProductId);
  if (product.lastError) addDefinition(attributes, "Ошибка обработки", product.lastError);
}

function renderVariants(item) {
  const variants = item.product?.variants ?? [];
  byId("variants-count").textContent = `${variants.length} шт.`;
  byId("variants-empty").hidden = variants.length !== 0;
  const body = byId("variants-body");
  body.replaceChildren();
  for (const variant of variants) {
    const row = document.createElement("tr");
    for (const value of [
      variant.size?.displayValue || variant.size?.sourceValue,
      variant.sku,
      variant.price ? `${variant.price.amount} ${variant.price.currency}` : "—",
      humanStatus(variant.inventory?.availability),
    ]) {
      const cell = document.createElement("td");
      cell.textContent = formatValue(value);
      row.append(cell);
    }
    body.append(row);
  }
}

function renderClassifications(item) {
  const values = item.classification.observations ?? [];
  byId("classification-count").textContent = `${values.length} знач.`;
  const list = byId("classification-list");
  list.replaceChildren();
  if (values.length === 0) {
    const empty = document.createElement("div");
    empty.className = "inline-message";
    empty.textContent = "Классификация ещё не запускалась или у товара нет значений для сопоставления.";
    list.append(empty);
    return;
  }
  for (const value of values) {
    const row = document.createElement("div");
    row.className = "classification-row";
    const content = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = value.typeName;
    const source = document.createElement("span");
    source.textContent = value.sourceValue;
    content.append(name, source);
    const result = document.createElement("div");
    result.className = "classification-result";
    result.append(badge(humanStatus(value.status), value.status));
    if (value.resolvedReferenceName) {
      const target = document.createElement("span");
      target.textContent = `→ ${value.resolvedReferenceName}`;
      result.append(target);
    }
    row.append(content, result);
    list.append(row);
  }
}

function eventTime(value) {
  return new Date(value).valueOf();
}

function renderPipelineEvents(container, events) {
  for (const event of events) {
    const row = document.createElement("div");
    row.className = `pipeline-row status-${event.status}`;
    const marker = document.createElement("span");
    marker.className = "pipeline-marker";
    const content = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = event.name;
    const detail = document.createElement("span");
    detail.textContent = event.detail;
    const time = document.createElement("time");
    time.dateTime = event.time;
    time.textContent = formatDate(event.time);
    content.append(name, detail, time);
    if (event.error) {
      const error = document.createElement("span");
      error.className = "pipeline-error";
      error.textContent = event.error;
      content.append(error);
    }
    row.append(marker, content);
    container.append(row);
  }
}

function pipelineSection(title) {
  const section = document.createElement("div");
  section.className = "pipeline-block";
  const heading = document.createElement("h4");
  heading.textContent = title;
  section.append(heading);
  return section;
}

function runCard({ title, status, time, detail, error, events = [] }, open) {
  const card = document.createElement("details");
  card.className = "pipeline-run";
  card.open = open;
  const summary = document.createElement("summary");
  const heading = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = title;
  const timestamp = document.createElement("time");
  timestamp.dateTime = time;
  timestamp.textContent = formatDate(time);
  heading.append(name, timestamp);
  summary.append(heading, badge(humanStatus(status), status));

  const body = document.createElement("div");
  body.className = "pipeline-run-body";
  if (detail) {
    const meta = document.createElement("span");
    meta.className = "pipeline-run-detail";
    meta.textContent = detail;
    body.append(meta);
  }
  if (error) {
    const message = document.createElement("span");
    message.className = "pipeline-error";
    message.textContent = error;
    body.append(message);
  }
  renderPipelineEvents(body, events);
  card.append(summary, body);
  return card;
}

function appendRunHistory(section, runs, emptyText) {
  if (runs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "inline-message";
    empty.textContent = emptyText;
    section.append(empty);
    return;
  }
  section.append(runCard(runs[0], true));
  if (runs.length === 1) return;

  const history = document.createElement("details");
  history.className = "pipeline-history";
  const summary = document.createElement("summary");
  summary.textContent = `Предыдущие запуски: ${runs.length - 1}`;
  history.append(summary);
  const content = document.createElement("div");
  content.className = "pipeline-history-list";
  for (const run of runs.slice(1)) content.append(runCard(run, false));
  history.append(content);
  section.append(history);
}

function processingRuns(operations) {
  const attempts = new Map();
  for (const operation of operations) {
    const attempt = attempts.get(operation.attemptId) ?? [];
    attempt.push(operation);
    attempts.set(operation.attemptId, attempt);
  }
  return [...attempts.values()].map((attempt) => {
    const ordered = attempt.sort((left, right) => left.sequence - right.sequence);
    const failed = ordered.find((operation) => operation.status === "failed");
    const running = ordered.find((operation) => operation.status === "running");
    return {
      title: "Обработка товара",
      status: failed ? "failed" : running ? "running" : "completed",
      time: ordered[0].startedAt,
      detail: `${ordered.length} операций`,
      error: failed?.error,
      events: ordered.map((operation) => ({
        name: operation.operationName,
        detail: `${operation.operationCode} · v${operation.operationVersion}`,
        status: operation.status,
        time: operation.startedAt,
        error: operation.error,
      })),
    };
  }).sort((left, right) => eventTime(right.time) - eventTime(left.time));
}

function renderPipeline(item) {
  const list = byId("pipeline-list");
  list.replaceChildren();

  const parts = pipelineSection("Текущие сохранённые данные");
  const partEvents = (item.collection.parts ?? []).map((part) => ({
    name: part.partKey,
    detail: `Адаптер ${part.adapterVersion}`,
    status: "completed",
    time: part.fetchedAt,
  })).sort((left, right) => eventTime(left.time) - eventTime(right.time));
  if (partEvents.length === 0) {
    const empty = document.createElement("div");
    empty.className = "inline-message";
    empty.textContent = "Части товара ещё не сохранены.";
    parts.append(empty);
  } else {
    const current = document.createElement("div");
    current.className = "pipeline-current";
    renderPipelineEvents(current, partEvents);
    parts.append(current);
  }

  const jobs = pipelineSection("Запуски задач");
  const jobRuns = (item.jobs ?? []).map((job) => ({
    title: jobNames[job.type] ?? job.type,
    status: job.status,
    time: job.createdAt,
    detail: `Попыток выполнения: ${job.attempts}`,
    error: job.lastError,
  })).sort((left, right) => eventTime(right.time) - eventTime(left.time));
  appendRunHistory(jobs, jobRuns, "Задачи для товара ещё не запускались.");

  const processing = pipelineSection("Попытки обработки");
  appendRunHistory(
    processing,
    processingRuns(item.processing.operations ?? []),
    "Детальная история операций начнёт заполняться после следующей обработки товара.",
  );

  list.append(parts, jobs, processing);
}

function renderTargets(item) {
  const list = byId("targets-list");
  list.replaceChildren();
  if (!item.targets?.length) {
    const empty = document.createElement("div");
    empty.className = "inline-message";
    empty.textContent = "Активные targets пока не настроены.";
    list.append(empty);
    return;
  }
  for (const target of item.targets) {
    const card = document.createElement("div");
    card.className = "target-card";
    const heading = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = target.name;
    heading.append(name, badge(humanStatus(target.status), target.status));
    const meta = document.createElement("span");
    meta.textContent = target.externalId ? `ID ${target.externalId} · ${formatDate(target.syncedAt)}` : "На target ещё не создан";
    card.append(heading, meta);
    if (target.lastError) {
      const error = document.createElement("span");
      error.className = "pipeline-error";
      error.textContent = target.lastError;
      card.append(error);
    }
    if (target.editUrl) card.append(externalLink("Редактировать на target ↗", target.editUrl));
    list.append(card);
  }
}

function renderProduct(item) {
  renderHero(item);
  renderData(item);
  renderVariants(item);
  renderClassifications(item);
  renderPipeline(item);
  renderTargets(item);
  byId("product-content").hidden = false;
}

async function loadProduct() {
  const loading = byId("product-loading");
  const error = byId("product-error");
  byId("product-content").hidden = true;
  loading.hidden = false;
  error.hidden = true;
  if (productId === null) {
    loading.hidden = true;
    return showError(error, "Некорректный идентификатор товара.");
  }
  try {
    const response = await api(`/api/products/${productId}`);
    state.product = response.item;
    renderProduct(state.product);
  } catch (requestError) {
    if (requestError.status === 401) return showLogin();
    showError(error, requestError.message);
  } finally {
    loading.hidden = true;
  }
}

byId("login-form").addEventListener("submit", login);
byId("logout-button").addEventListener("click", logout);
byId("refresh-product").addEventListener("click", loadProduct);

restoreSession().catch((error) => {
  byId("product-loading").hidden = true;
  showError(byId("product-error"), error.message);
});
