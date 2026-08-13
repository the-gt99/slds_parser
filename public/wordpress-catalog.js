const byId = (id) => document.getElementById(id);
const state = { session: null, targetId: null, run: null, offset: 0, total: 0, timer: null };

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.method && state.session?.csrfToken ? { "X-CSRF-Token": state.session.csrfToken } : {}) }, ...options, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Ошибка HTTP ${response.status}`);
  return data;
}

const count = (value) => new Intl.NumberFormat("ru-RU").format(Number(value || 0));
const date = (value) => value ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) : "—";
function node(tag, className, value) { const result = document.createElement(tag); if (className) result.className = className; if (value !== undefined) result.textContent = value; return result; }
function message(value, kind = "") { byId("message").textContent = value; byId("message").className = `inline-message ${kind}`; byId("message").hidden = false; }

function renderRun() {
  const run = state.run;
  byId("run").hidden = !run;
  if (!run) return;
  byId("total").textContent = count(run.totalCount);
  byId("matched").textContent = count(run.matchedCount);
  byId("unmatched").textContent = count(run.unmatchedCount);
  byId("ambiguous").textContent = count(run.ambiguousCount);
  byId("variation-completed").textContent = count(run.variationCompletedCount);
  byId("variation-submitted").textContent = `в очереди WordPress: ${count(run.variationSubmittedCount)}`;
  byId("variation-skipped").textContent = count(run.variationSkippedCount);
  byId("variation-failed").textContent = `ошибок: ${count(run.variationFailedCount)}`;
  byId("audit-ready").textContent = count(run.auditReadyCount);
  byId("audit-pending").textContent = `ожидают: ${count(run.auditPendingCount)}`;
  byId("audit-blocked").textContent = count(run.auditBlockedCount);
  byId("audit-errors").textContent = `ошибок: ${count(run.auditErrorCount)}`;
  byId("cursor").textContent = `${run.status} · cursor ${count(run.catalogCursor)} · ${date(run.updatedAt)}`;
  byId("start").disabled = run.status === "running";
  byId("start").textContent = run.status === "running" ? "Каталог скачивается" : "Скачать новый каталог";
  byId("batch-sync").disabled = run.variationCompletedCount < 1 || run.variationFailedCount > 0;
}

function renderItem(item) {
  const product = item.payload?.product || {};
  const card = node("article", "section");
  const title = node("div", "section-title");
  const main = node("div");
  main.append(node("p", "eyebrow", `WordPress #${item.wordpressProductId}`), node("h3", "", product.title || "Без названия"));
  const badge = node("span", `export-badge ${item.matchStatus === "matched" ? "success" : item.matchStatus === "ambiguous" ? "danger" : "warning"}`, item.matchStatus);
  title.append(main, badge);
  const identity = node("p", "muted", `GOAT: ${item.sourceExternalId || item.legacyGoatId || "—"} · SKU: ${item.sku || "—"} · способ: ${item.matchMethod || "—"}`);
  const details = node("p", "muted", `Вариаций: ${(product.variations || []).length} · фото: ${(product.images || []).length} · parser product: ${item.sourceProductId || "—"}`);
  const audit = node("p", "muted", `Аудит: ${item.auditStatus}${item.auditResult?.risk ? ` · риск ${item.auditResult.risk}` : ""}${item.auditError ? ` · ${item.auditError}` : ""}`);
  const patchResult = item.variationResult?.result;
  const skippedPrices = Number(patchResult?.price_skipped_count || 0);
  const variation = node("p", "muted", `Цены/остатки: ${item.variationStatus}${item.wordpressJobId ? ` · WP job #${item.wordpressJobId}` : ""}${skippedPrices > 0 ? ` · цен пропущено: ${count(skippedPrices)}` : ""}${item.variationError ? ` · ${item.variationError}` : ""}`);
  card.append(title, identity, details, audit, variation);
  if ((item.variationNotices || []).length > 0 || item.variationResult) {
    const trace = node("details");
    trace.append(node("summary", "", "Причины и технический результат"));
    trace.append(node("pre", "technical-result", JSON.stringify({ notices: item.variationNotices || [], wordpress: item.variationResult }, null, 2)));
    card.append(trace);
  }
  if (item.matchStatus === "matched" && (item.variationStatus === "skipped" || item.variationStatus === "failed")) {
    const canary = node("button", "button quiet", "Canary цен/остатков"); canary.type = "button";
    canary.addEventListener("click", async () => { if (!window.confirm(`Обновить только существующие цены и остатки WordPress #${item.wordpressProductId}?`)) return; try { await api(`/api/wordpress-catalog/runs/${state.run.id}/variation-canary`, { method: "POST", body: { itemId: item.id } }); message(`Canary WordPress #${item.wordpressProductId} поставлен в очередь.`, "success"); await refresh(); } catch (error) { message(error.message, "error"); } });
    card.append(canary);
  }
  return card;
}

async function loadItems(append = false) {
  if (!state.run) return;
  if (!append) { state.offset = 0; byId("items").replaceChildren(); }
  const query = new URLSearchParams({ limit: "50", offset: String(state.offset), ...(byId("match").value ? { match: byId("match").value } : {}), ...(byId("variation-filter").value ? { variation: byId("variation-filter").value } : {}) });
  const data = await api(`/api/wordpress-catalog/runs/${state.run.id}/items?${query}`);
  data.items.forEach((item) => byId("items").append(renderItem(item)));
  state.offset += data.items.length;
  state.total = data.total;
  byId("empty").hidden = state.total !== 0;
  byId("more").hidden = state.offset >= state.total;
}

async function refresh() {
  if (!state.targetId) return;
  byId("loading").hidden = false; byId("error").hidden = true;
  try {
    const runs = await api(`/api/wordpress-catalog/runs?targetId=${encodeURIComponent(state.targetId)}&limit=1`);
    state.run = runs.items[0] || null;
    renderRun();
    await loadItems();
    if (state.timer) window.clearTimeout(state.timer);
    if (state.run?.status === "running") state.timer = window.setTimeout(refresh, 5000);
  } catch (error) { byId("error").textContent = error.message; byId("error").hidden = false; }
  finally { byId("loading").hidden = true; }
}

async function initialize() {
  const session = await api("/api/auth/session");
  if (!session.authenticated) { byId("login-view").hidden = false; return; }
  state.session = session; byId("operator-name").textContent = session.operator; byId("app-view").hidden = false;
  const targets = await api("/api/targets");
  for (const target of targets.items) { const option = node("option", "", target.name); option.value = target.id; byId("target").append(option); }
  state.targetId = byId("target").value || null;
  await refresh();
}

byId("login-form").addEventListener("submit", async (event) => { event.preventDefault(); try { await api("/api/auth/login", { method: "POST", body: { username: byId("login-username").value, password: byId("login-password").value } }); location.reload(); } catch (error) { byId("login-error").textContent = error.message; byId("login-error").hidden = false; } });
byId("logout-button").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST" }); location.reload(); });
byId("target").addEventListener("change", async () => { state.targetId = byId("target").value; await refresh(); });
byId("refresh").addEventListener("click", refresh);
byId("filters").addEventListener("submit", async (event) => { event.preventDefault(); await loadItems(); });
byId("more").addEventListener("click", () => loadItems(true));
byId("start").addEventListener("click", async () => { try { const data = await api("/api/wordpress-catalog/runs", { method: "POST", body: { targetId: state.targetId, sourceCode: "goat", auditRequested: true, variationSyncRequested: false, reason: "Полный снимок каталога WordPress" } }); state.run = data.item; renderRun(); message("Скачивание каталога поставлено в очередь. WordPress не изменяется.", "success"); await loadItems(); state.timer = window.setTimeout(refresh, 3000); } catch (error) { message(error.message, "error"); } });
byId("batch-sync").addEventListener("click", async () => { const limit = Number(byId("batch-limit").value); if (!state.run || !window.confirm(`Поставить в очередь ${count(limit)} сопоставленных товаров? Изменятся только цены и остатки существующих вариаций.`)) return; try { const data = await api(`/api/wordpress-catalog/runs/${state.run.id}/variation-batch`, { method: "POST", body: { limit } }); message(`Поставлено задач: ${count(data.result.queuedCount)}.`, "success"); await refresh(); } catch (error) { message(error.message, "error"); } });
void initialize().catch((error) => { byId("error").textContent = error.message; byId("error").hidden = false; });
