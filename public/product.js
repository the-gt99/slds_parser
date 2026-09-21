const byId = (id) => document.getElementById(id);

const state = { session: null, product: null };
const productId = location.pathname.match(/^\/products\/(\d+)\/?$/u)?.[1] ?? null;
if (productId !== null) byId("edit-content-template").href = `/content-templates?productId=${encodeURIComponent(productId)}`;

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
  observed: "Найден в WordPress",
  not_exported: "Не выгружен",
  available: "В наличии",
  unavailable: "Нет в наличии",
  preorder: "Предзаказ",
  unknown: "Неизвестно",
};

const jobNames = {
  collect_product: "Сбор данных",
  sync_target_classifications: "Связи WordPress",
  apply_target_classification_suggestion: "Применение связей WordPress",
  process_product: "Обработка товара",
  reclassify_product: "Переклассификация товара",
  export_product: "Выгрузка на target",
  preflight_product: "Проверка WordPress без записи",
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

function jsonDetails(title, value, open = false) {
  const details = document.createElement("details");
  details.className = "data-details";
  details.open = open;
  const summary = document.createElement("summary"); summary.textContent = title;
  const pre = document.createElement("pre"); pre.textContent = JSON.stringify(value, null, 2);
  details.append(summary, pre); return details;
}

function stageRow(title, detail) {
  const row = document.createElement("div");
  row.className = "stage-row";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const description = document.createElement("span");
  description.textContent = detail;
  row.append(heading, description);
  return row;
}

function renderStages(item) {
  const list = byId("stages-list"); list.replaceChildren();
  const identity = stageRow("1. Discovery / identity", `${item.source.code} · ${item.sourceProduct.sourceKey} · external ID ${item.sourceProduct.externalId || "—"}`);
  identity.append(jsonDetails("Discovery metadata", item.sourceProduct.discoveryMetadata)); list.append(identity);
  const parts = stageRow("2. Текущие parts", `${item.collection.parts.length} частей; это вход процессора, не DTO.`);
  for (const part of item.collection.parts) { const group = document.createElement("div"); group.className = "part-payloads"; group.append(jsonDetails(`${part.partKey}: raw`, part.rawPayload), jsonDetails(`${part.partKey}: parsed`, part.parsedPayload)); parts.append(group); } list.append(parts);
  const attempts = item.processing.attempts || [];
  const attempt = attempts[0];
  const processor = stageRow("3. DTO после SourceProcessor", attempt ? `Историческая попытка ${attempt.attemptId} · v${attempt.processorVersion}` : "Для прошлых обработок это состояние не сохранялось."); if (attempt) processor.append(jsonDetails("Исторический DTO процессора", attempt.processorOutput)); list.append(processor);
  const operations = stageRow("4. ProductOperation по порядку", attempt ? "Исторические выходы операций выбранной попытки" : "Исторические выходы отсутствуют.");
  const currentOperations = attempt ? (item.processing.operations || []).filter((operation) => operation.attemptId === attempt.attemptId).sort((a, b) => a.sequence - b.sequence) : [];
  for (const operation of currentOperations) operations.append(jsonDetails(`${operation.sequence + 1}. ${operation.operationName} · v${operation.operationVersion}`, operation.outputData ?? { status: operation.status, error: operation.error, note: "Выход не сохранялся" })); list.append(operations);
  const currentOutput = item.processing.currentOutput;
  const final = stageRow("5. Текущий итоговый DTO", currentOutput ? "Актуальные данные из internal_products" : "Ещё не сформирован");
  if (currentOutput) final.append(jsonDetails("Текущий итоговый DTO", currentOutput, true));
  if (attempt?.classifiedOutput) final.append(jsonDetails(`Исторический classified DTO попытки ${attempt.attemptId}`, attempt.classifiedOutput));
  list.append(final);
  const latestSnapshot = item.wordpressSnapshots?.[0];
  const snapshot = stageRow("6. Текущий WordPress snapshot", latestSnapshot ? `WP ${latestSnapshot.externalId} · ${formatDate(latestSnapshot.fetchedAt)}` : "Снимка нет");
  if (latestSnapshot) snapshot.append(jsonDetails("Снимок WordPress", latestSnapshot.payload)); list.append(snapshot);
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
  const imageError = byId("product-image-error");
  imageWrap.hidden = !image;
  imageError.hidden = true;
  if (image) {
    const element = byId("product-image");
    element.hidden = false;
    element.src = image.url;
    element.alt = image.alt || title;
    element.onload = () => {
      element.hidden = false;
      imageError.hidden = true;
    };
    element.onerror = () => {
      element.hidden = true;
      imageError.hidden = false;
    };
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
    const pending = value.pendingResolution;
    result.append(badge(pending ? "Ожидает переобработки" : humanStatus(value.status), pending ? "pending" : value.status));
    if (pending) {
      const note = document.createElement("span");
      note.textContent = pending.status === "resolved"
        ? "Решение уже сохранено и будет применено после запуска обработки"
        : pending.status === "ignored"
          ? "Значение будет проигнорировано после запуска обработки"
          : "Текущее решение будет снято после запуска обработки";
      result.append(note);
    } else if (value.resolvedReferenceName) {
      const target = document.createElement("span");
      target.textContent = `→ ${value.resolvedReferenceName}`;
      result.append(target);
    }
    const outputs = document.createElement("div");
    outputs.className = "classification-outputs";
    const activeOutputs = [...new Map(
      (value.outputs ?? [])
        .filter((output) => output.status === "active")
        .map((output) => [[output.targetId, output.targetScope, output.targetExternalId].join(":"), output]),
    ).values()];
    if (activeOutputs.length > 0) {
      const label = document.createElement("span");
      label.className = "classification-outputs-label";
      label.textContent = "Будет назначено в WordPress";
      outputs.append(label);
      for (const output of activeOutputs) {
        const chip = document.createElement("a");
        chip.className = `classification-output ${output.kind}`;
        chip.href = `/classifier?${new URLSearchParams({ view: "references", referenceId: value.resolvedReferenceValueId || "", search: value.resolvedReferenceName || value.sourceValue })}`;
        chip.textContent = `${output.kind === "projection" ? "+ " : ""}${output.targetLabel} · ${output.targetTaxonomy || output.targetScope}`;
        outputs.append(chip);
      }
    }
    const actions = document.createElement("div");
    actions.className = "classification-actions";
    if (item.classification.mode === "v2") {
      const details = document.createElement("a");
      details.className = `button ${value.sourceRuleId ? "quiet" : "primary"} small-button`;
      details.href = `/rules-v2?${new URLSearchParams({ search: value.sourceRuleId || value.sourceValue })}`;
      details.textContent = value.sourceRuleId ? "Открыть правило v2" : "Найти правило v2";
      actions.append(details);
    } else if (pending?.resolutionKind && pending.resolutionId) {
      const details = document.createElement("a");
      details.className = "button quiet small-button";
      details.href = `/classifier?${new URLSearchParams(pending.resolutionKind === "rule"
        ? { view: "rules", ruleId: pending.resolutionId }
        : { view: "references", referenceId: value.resolvedReferenceValueId || "", search: value.resolvedReferenceName || value.sourceValue })}`;
      details.textContent = "Открыть сохранённое решение";
      actions.append(details);
    } else if (!pending && (value.status === "unresolved" || value.status === "ambiguous")) {
      const params = new URLSearchParams({
        sourceId: item.source.id,
        typeCode: value.typeCode,
        status: value.status,
        search: value.sourceValue,
        contextKey: value.contextKey,
      });
      const classify = document.createElement("a");
      classify.className = "button primary small-button";
      classify.href = `/classifier?${params}`;
      classify.textContent = value.status === "ambiguous" ? "Разобрать конфликт" : "Сопоставить";
      actions.append(classify);
    } else if (value.resolutionKind && value.resolutionId) {
      const details = document.createElement("a");
      details.className = "button quiet small-button";
      details.href = `/classifier?${new URLSearchParams(value.resolutionKind === "rule"
        ? { view: "rules", ruleId: value.resolutionId }
        : { view: "references", referenceId: value.resolvedReferenceValueId || "", search: value.resolvedReferenceName || value.sourceValue })}`;
      details.textContent = "Изменить решение";
      const projection = document.createElement("a");
      projection.className = "button quiet small-button";
      projection.href = `/classifier?${new URLSearchParams({
        view: "references",
        referenceId: value.resolvedReferenceValueId || "",
        action: "assignment",
        targetScope: "product.tag",
        search: value.resolvedReferenceName || value.sourceValue,
      })}`;
      projection.textContent = "+ Назначение WordPress";
      actions.append(details, projection);
    }
    row.append(content, result);
    row.append(outputs);
    row.append(actions);
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
    const statusText = target.status === "pending" && target.activeExportStatus
      ? `В очереди · ${humanStatus(target.activeExportStatus)}`
      : humanStatus(target.status);
    heading.append(name, badge(statusText, target.status));
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
    if (target.attempts?.length) card.append(jsonDetails(`История попыток (${target.attempts.length})`, target.attempts));
    list.append(card);
  }
}

function priceRange(variations) {
  const prices = variations
    .map((variation) => Number(variation.regular_price))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (!prices.length) return "—";
  const first = prices[0];
  const last = prices[prices.length - 1];
  const money = (value) => `${new Intl.NumberFormat("ru-RU").format(value)} ₽`;
  return first === last ? money(first) : `${money(first)} – ${money(last)}`;
}

const taxonomyLabels = {
  product_cat: "Категории",
  product_tag: "Метки",
  pa_brand: "Бренд",
  pa_model: "Модель",
  pa_tsvet: "Цвет",
  pa_material: "Материал",
  pa_vid: "Вид спорта",
  pa_shoe_height: "Высота обуви",
  pa_season: "Сезон",
  pa_razmer: "Размеры",
  pa_size: "Размеры",
};

const changeLabels = {
  add: "Добавится",
  change: "Изменится",
  remove: "Удалится",
  deactivate: "Отключится",
  unchanged: "Без изменений",
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function currentTerms(product, taxonomy) {
  const values = product?.taxonomies?.[taxonomy];
  if (!Array.isArray(values)) return [];
  return values.map((term) => ({
    termId: Number(term.term_id),
    name: term.name || term.term_slug || `Термин #${term.term_id}`,
    slug: term.slug || term.term_slug || null,
  }));
}

function proposedTerms(item, taxonomy) {
  return item.proposed?.taxonomies?.find((row) => row.taxonomy === taxonomy)?.terms ?? [];
}

function termChips(terms, tone = "unchanged") {
  const box = element("div", "preview-term-list");
  if (!terms?.length) {
    box.append(element("span", "preview-empty", "Нет"));
    return box;
  }
  for (const term of terms) {
    const chip = element("span", `preview-term ${tone}`, term.name || `Термин #${term.termId}`);
    const originLabels = (term.origins || []).map((origin) => {
      const source = origin.sourceTypeCode === "brand"
        ? "бренда"
        : origin.sourceTypeCode === "model" ? "модели" : origin.sourceTypeCode;
      return origin.relationCode === "landing"
        ? `посадочная из ${source} «${origin.sourceLabel}»`
        : `${origin.relationCode} из ${source} «${origin.sourceLabel}»`;
    });
    for (const label of originLabels) chip.append(element("small", "preview-term-origin", label));
    chip.title = [`${term.slug || "без slug"} · term #${term.termId}`, ...originLabels].join(" · ");
    box.append(chip);
  }
  return box;
}

function previewProductCard(title, product, options = {}) {
  const card = element("article", `preview-product-card ${options.muted ? "muted-card" : ""}`);
  const heading = element("div", "preview-card-heading");
  heading.append(element("p", "eyebrow", title));
  if (options.badge) heading.append(element("span", `preview-state-badge ${options.badgeTone || "neutral"}`, options.badge));
  card.append(heading);
  if (!product) {
    card.append(element("p", "preview-card-empty", "Карточка появится после устранения блокеров."));
    return card;
  }
  const visual = element("div", "preview-card-visual");
  const imageUrl = product.images?.[0]?.url || product.images?.[0]?.source_url || "";
  if (imageUrl) {
    const image = element("img", "preview-card-image");
    image.src = imageUrl;
    image.alt = product.title || title;
    visual.append(image);
  } else {
    visual.append(element("div", "preview-image-empty", "Нет изображения"));
  }
  const info = element("div", "preview-card-info");
  info.append(element("h4", "", product.title || "Без названия"));
  info.append(element("p", "preview-sku", `SKU ${product.sku || "—"}`));
  info.append(element(
    "p",
    `preview-price${options.pricePending ? " pending" : ""}`,
    options.pricePending ? "Цена в ₽ появится после preflight" : priceRange(product.variations || []),
  ));
  const facts = element("div", "preview-card-facts");
  facts.append(
    element("span", "", `${product.images?.length || 0} фото`),
    element("span", "", `${product.variations?.length ?? product.sourceVariationCount ?? 0} вариаций`),
  );
  info.append(facts);
  visual.append(info);
  card.append(visual);
  const taxonomyBox = element("div", "preview-card-taxonomies");
  for (const taxonomy of ["product_cat", "pa_brand", "pa_model", "pa_tsvet", "pa_material", "pa_vid", "pa_shoe_height", "pa_season", "product_tag"]) {
    const terms = product.termGetter?.(taxonomy) ?? [];
    if (!terms.length) continue;
    const row = element("div", "preview-card-taxonomy");
    row.append(element("span", "", taxonomyLabels[taxonomy] || taxonomy), termChips(terms));
    taxonomyBox.append(row);
  }
  if (taxonomyBox.childElementCount) card.append(taxonomyBox);
  return card;
}

function renderReadiness(item) {
  const ready = item.readiness?.ready === true;
  const box = element("section", `preview-readiness ${ready ? "ready" : "blocked"}`);
  const icon = element("span", "preview-readiness-icon", ready ? "✓" : "!");
  const body = element("div", "");
  body.append(element("h3", "", ready ? "Payload готов к контролируемому экспорту" : "Экспорт этого товара пока заблокирован"));
  body.append(element("p", "", ready
    ? "WordPress preflight прошёл без записи. Ниже показан полный результат merge."
    : "Карточка WordPress сохранена. Ниже показано всё, что уже можно определить, и конкретные причины блокировки."));
  if (!ready && item.readiness?.blockers?.length) {
    const list = element("ul", "preview-blockers");
    for (const blocker of item.readiness.blockers) list.append(element("li", "", blocker.message));
    body.append(list);
  }
  if (item.readiness?.notices?.length) {
    const list = element("ul", "preview-notices");
    for (const notice of item.readiness.notices) list.append(element("li", "", notice.message));
    body.append(list);
  }
  box.append(icon, body);
  return box;
}

function renderChangeSummary(item) {
  const comparison = item.comparison;
  if (!comparison) return null;
  const changedFields = comparison.fields?.filter((row) => row.changed).length || 0;
  const changedTaxonomies = comparison.taxonomies?.filter((row) => row.changed).length || 0;
  const changedImages = comparison.images?.differences?.length || 0;
  const changedVariations = comparison.variations?.differences?.length || 0;
  const section = element("section", "preview-change-summary");
  section.append(
    element("div", changedFields ? "changed" : "unchanged", `${changedFields} полей изменится`),
    element("div", changedTaxonomies ? "changed" : "unchanged", `${changedTaxonomies} групп терминов изменится`),
    element("div", changedImages ? "changed" : "unchanged", `${changedImages} позиций фото изменится`),
    element("div", changedVariations ? "changed" : "unchanged", comparison.variations.available ? `${changedVariations} вариаций изменится` : "Вариации ждут preflight"),
  );
  return section;
}

function renderFieldChanges(rows) {
  const section = element("section", "preview-diff-section");
  section.append(element("h3", "", "Основные поля"));
  const list = element("div", "preview-field-list");
  const labels = { title: "Название", slug: "Slug", sku: "SKU", description_html: "Описание", short_description_html: "Короткое описание" };
  for (const row of rows || []) {
    const item = element("div", `preview-field-row ${row.changed ? "changed" : "unchanged"}`);
    item.append(element("strong", "", labels[row.field] || row.field));
    if (row.field.includes("description")) {
      const values = element("div", "preview-description-comparison");
      for (const [label, html] of [["Сейчас", row.actual], ["После merge", row.expected]]) {
        const side = element("div", "preview-description-side");
        side.append(element("span", "preview-group-label", label), safeDescriptionPreview(html));
        values.append(side);
      }
      item.append(values);
    } else {
      const values = element("div", "preview-before-after");
      values.append(element("span", "before", row.actual ?? "—"), element("span", "arrow", "→"), element("span", "after", row.expected ?? "—"));
      item.append(values);
    }
    item.append(element(
      "span",
      `preview-state-badge ${row.changed ? "change" : "unchanged"}`,
      row.managed === false ? "Парсер не меняет" : row.changed ? "Изменится" : "Без изменений",
    ));
    list.append(item);
  }
  section.append(list);
  return section;
}

function safeDescriptionPreview(value) {
  const preview = element("div", "preview-description-content");
  const html = typeof value === "string" ? value.trim() : "";
  if (!html) {
    preview.append(element("span", "preview-empty", "Пусто"));
    return preview;
  }
  // The preview never preserves HTML attributes. Remove inline styles before
  // parsing as well, otherwise the browser reports CSP violations even though
  // those attributes are discarded before anything is added to the page.
  const htmlWithoutInlineStyles = html.replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  const documentValue = new DOMParser().parseFromString(htmlWithoutInlineStyles, "text/html");
  const allowed = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "P", "UL", "OL", "LI", "STRONG", "EM", "B", "I", "BR", "BLOCKQUOTE"]);
  const dropped = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH"]);
  const appendSafe = (source, target) => {
    if (source.nodeType === Node.TEXT_NODE) {
      target.append(document.createTextNode(source.textContent || ""));
      return;
    }
    if (source.nodeType !== Node.ELEMENT_NODE || dropped.has(source.nodeName)) return;
    const destination = allowed.has(source.nodeName) ? document.createElement(source.nodeName.toLowerCase()) : target;
    for (const child of source.childNodes) appendSafe(child, destination);
    if (destination !== target) target.append(destination);
  };
  for (const child of documentValue.body.childNodes) appendSafe(child, preview);
  if (!preview.childNodes.length) preview.append(element("span", "preview-empty", "Пусто"));
  return preview;
}

function renderTaxonomyChanges(rows) {
  const section = element("section", "preview-diff-section");
  section.append(element("h3", "", "Категории, метки и атрибуты"));
  const list = element("div", "preview-taxonomy-list");
  for (const row of (rows || []).filter((entry) => entry.taxonomy !== "pa_razmer" && entry.taxonomy !== "pa_size")) {
    const item = element("article", `preview-taxonomy-row ${row.changed ? "changed" : "unchanged"}`);
    const heading = element("div", "preview-taxonomy-heading");
    heading.append(element("strong", "", taxonomyLabels[row.taxonomy] || row.taxonomy));
    heading.append(element("span", `preview-state-badge ${row.changed ? "change" : "unchanged"}`, row.managed ? (row.changed ? "Изменится" : "Без изменений") : "Парсер не меняет"));
    item.append(heading);
    const groups = element("div", "preview-term-groups");
    if (row.added?.length) {
      const group = element("div", ""); group.append(element("span", "preview-group-label", "Добавятся"), termChips(row.added, "added")); groups.append(group);
    }
    if (row.removed?.length) {
      const group = element("div", ""); group.append(element("span", "preview-group-label", "Снимутся"), termChips(row.removed, "removed")); groups.append(group);
    }
    if (row.unchanged?.length) {
      const group = element("div", ""); group.append(element("span", "preview-group-label", "Останутся"), termChips(row.unchanged, "unchanged")); groups.append(group);
    }
    if (!groups.childElementCount) groups.append(element("span", "preview-empty", "Значений нет"));
    item.append(groups);
    list.append(item);
  }
  section.append(list);
  return section;
}

function sizeLabels(product) {
  return new Map([...(currentTerms(product, "pa_razmer")), ...(currentTerms(product, "pa_size"))].map((term) => [term.termId, term.name]));
}

function variationStateText(value) {
  if (!value) return "Нет";
  const stock = value.stockStatus === "instock" ? "в наличии" : value.stockStatus === "outofstock" ? "нет в наличии" : value.stockStatus || "—";
  const price = value.regularPrice ? `${new Intl.NumberFormat("ru-RU").format(Number(value.regularPrice))} ₽` : "без цены";
  const quantity = value.stockQuantity === null || Number.isNaN(value.stockQuantity) ? "" : ` · остаток ${value.stockQuantity}`;
  return `${price} · ${stock}${quantity}`;
}

function renderVariationChanges(comparison, currentProduct) {
  const section = element("section", "preview-diff-section");
  const heading = element("div", "preview-diff-heading");
  const ignoredCount = comparison?.ignored?.length || 0;
  heading.append(element("h3", "", "Вариации и размеры"), element(
    "span",
    "count-pill",
    `${comparison?.expectedCount || 0} после merge / ${comparison?.actualCount || 0} сейчас${ignoredCount ? ` / ${ignoredCount} пропущено` : ""}`,
  ));
  section.append(heading);
  if (ignoredCount) {
    const notice = element("div", "inline-message ignored-size-variants");
    notice.append(element("strong", "", "Временно не передаются в WordPress:"));
    const list = document.createElement("ul");
    for (const variant of comparison.ignored) {
      const context = [variant.system, variant.audience].filter(Boolean).join(" / ");
      const price = variant.price?.amount ? ` · ${variant.price.amount} ${variant.price.currency || ""}` : "";
      list.append(element("li", "", `${variant.displayValue || variant.sourceValue}${context ? ` (${context})` : ""}${price} — нет точного size mapping`));
    }
    notice.append(list);
    section.append(notice);
  }
  if (!comparison?.available) {
    section.append(element("p", "inline-message", "Финальные цены, остатки и отключаемые размеры появятся после устранения блокеров и успешного WordPress preflight."));
    return section;
  }
  const labels = sizeLabels(currentProduct);
  const tableWrap = element("div", "table-wrap");
  const table = element("table", "variants-table preview-variation-table");
  table.innerHTML = "<thead><tr><th>Размер</th><th>Сейчас</th><th>После merge</th><th>Результат</th></tr></thead>";
  const body = document.createElement("tbody");
  for (const row of comparison.rows || []) {
    const termId = Number(String(row.size).split(":").at(-1));
    const tr = document.createElement("tr");
    tr.append(element("td", "", labels.get(termId) || row.size), element("td", "", variationStateText(row.actual)), element("td", "", variationStateText(row.expected)));
    const status = element("span", `preview-state-badge ${row.status}`, row.alreadyDeactivated ? "Уже отключена" : changeLabels[row.status] || row.status);
    const statusCell = document.createElement("td"); statusCell.append(status); tr.append(statusCell); body.append(tr);
  }
  table.append(body); tableWrap.append(table); section.append(tableWrap);
  return section;
}

function renderImageChanges(comparison) {
  const section = element("section", "preview-diff-section");
  section.append(element("h3", "", "Изображения"));
  const grid = element("div", "preview-image-grid");
  for (const row of comparison?.rows || []) {
    const card = element("article", `preview-image-change ${row.status}`);
    card.append(element("span", `preview-state-badge ${row.status}`, `${row.position + 1}. ${changeLabels[row.status] || row.status}`));
    const pair = element("div", "preview-image-pair");
    for (const [label, image] of [["Сейчас", row.actual], ["После", row.expected]]) {
      const side = element("div", "");
      side.append(element("span", "preview-group-label", label));
      const url = image?.url || image?.source_url || "";
      if (url) { const img = element("img", ""); img.src = url; img.alt = `${label} ${row.position + 1}`; side.append(img); }
      else side.append(element("div", "preview-image-empty", "Нет"));
      pair.append(side);
    }
    card.append(pair); grid.append(card);
  }
  section.append(grid);
  return section;
}

function renderVisualPreview(item) {
  const wrapper = document.createElement("div");
  wrapper.className = "wordpress-visual-preview";
  wrapper.append(renderReadiness(item));
  wrapper.append(element("p", "muted preview-note", "Это административное read-only представление реального payload и WordPress snapshot, а не копия темы сайта."));
  const cards = element("div", "preview-product-grid");
  const currentProduct = item.current?.product || {};
  cards.append(
    previewProductCard("Сейчас в WordPress", {
      ...currentProduct,
      termGetter: (taxonomy) => currentTerms(currentProduct, taxonomy),
    }, { badge: item.current?.snapshotFetchedAt ? `Снимок ${formatDate(item.current.snapshotFetchedAt)}` : "Снимка нет", badgeTone: "neutral" }),
    previewProductCard(item.readiness?.ready ? "После merge" : "Черновик после merge", item.proposed ? {
      ...item.proposed.fields,
      images: item.proposed.images,
      variations: item.proposed.variations,
      sourceVariationCount: item.proposed.sourceVariationCount,
      termGetter: (taxonomy) => proposedTerms(item, taxonomy),
    } : null, {
      badge: item.readiness?.ready ? "Полный payload" : "Неполный",
      badgeTone: item.readiness?.ready ? "ready" : "blocked",
      muted: !item.readiness?.ready,
      pricePending: item.proposed?.variationPricesReady === false,
    }),
  );
  wrapper.append(cards);
  const summary = renderChangeSummary(item); if (summary) wrapper.append(summary);
  if (item.comparison) {
    wrapper.append(
      renderTaxonomyChanges(item.comparison.taxonomies),
      renderFieldChanges(item.comparison.fields),
      renderVariationChanges(item.comparison.variations, currentProduct),
      renderImageChanges(item.comparison.images),
    );
  }
  return wrapper;
}

function renderProduct(item) {
  renderHero(item);
  renderData(item);
  renderVariants(item);
  renderClassifications(item);
  renderPipeline(item);
  renderTargets(item);
  renderStages(item);
  byId("product-content").hidden = false;
}

function showPreview(item, refreshed) {
  const box = byId("preview-state"); const content = byId("preview-content"); const button = byId("load-preview");
  const checkedAt = item.wordpressCheckedAt ? formatDate(item.wordpressCheckedAt) : "дата неизвестна";
  const sourceLabel = refreshed ? `Preflight обновлён с WordPress ${checkedAt}` : `Показан сохранённый preflight от ${checkedAt}`;
  box.textContent = item.readiness?.ready
    ? item.willCreate
      ? `${sourceLabel} · товар будет создан · target ${item.target.enabled ? "включён" : "выключен"}`
      : `${sourceLabel} · найден товар WP ${item.externalId} · target ${item.target.enabled ? "включён" : "выключен"}`
    : `${sourceLabel} · найден товар WP ${item.externalId || "—"} · экспорт заблокирован`;
  const blocks = [renderVisualPreview(item)];
  if (item.payload) {
    blocks.push(
      jsonDetails("Технический payload: основные поля", item.payload.fields),
      jsonDetails("Технический payload: таксономии", item.payload.taxonomies),
      jsonDetails(`Технический payload: изображения (${item.payload.images.length})`, item.payload.images),
      jsonDetails(`Технический payload: исходные вариации (${item.payload.activeVariations.length})`, item.payload.activeVariations),
    );
  }
  blocks.push(jsonDetails("Технический результат сравнения", { readiness: item.readiness, comparison: item.comparison, diff: item.diff }));
  content.replaceChildren(...blocks); content.hidden = false; button.disabled = false;
}

async function loadPreview(refreshWordPress = true) {
  const box = byId("preview-state"); const content = byId("preview-content"); const button = byId("load-preview");
  const target = state.product?.targets?.find((item) => item.exporterCode === "wordpress");
  if (!target) { box.textContent = "WordPress target не настроен для preview."; return; }
  button.disabled = true;
  box.textContent = refreshWordPress ? "WordPress выполняет read-only preflight…" : "Загружаем сохранённый preflight…";
  box.classList.remove("error"); content.hidden = true;
  try {
    const response = refreshWordPress
      ? await api(`/api/products/${productId}/wordpress-preflight`, { method: "POST", body: { targetId: target.id } })
      : await api(`/api/products/${productId}/wordpress-preview?targetId=${encodeURIComponent(target.id)}`);
    showPreview(response.item, refreshWordPress);
  } catch (error) {
    if (!refreshWordPress && error.message.includes("Сохранённый preflight")) {
      box.textContent = "Сохранённого preflight пока нет. Нажмите «Обновить с WordPress», чтобы выполнить read-only проверку.";
      box.classList.remove("error");
    } else {
      box.textContent = `Preview заблокирован: ${error.message}`;
      box.classList.add("error");
    }
  }
  finally { button.disabled = false; }
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
    void loadPreview(false);
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
byId("load-preview").addEventListener("click", () => loadPreview(true));

restoreSession().catch((error) => {
  byId("product-loading").hidden = true;
  showError(byId("product-error"), error.message);
});
