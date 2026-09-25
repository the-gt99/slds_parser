import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { DataSchemaService } from "../../src/services/data-schema-service.js";
import type { SourceRepository } from "../../src/repositories/index.js";

const schema = await new DataSchemaService({ listEnabled: async () => [{ id: "1", code: "goat", name: "GOAT" }] } as unknown as SourceRepository).catalog();
let rule = { id: "1", sourceId: "1", sourceCode: "goat", targetId: "2", targetCode: "slamdunk", name: "Проверка нескольких условий",
  groupCode: "category", priority: 100, status: "shadow", originKind: "native", revision: "1",
  conditionGroups: [{ conditions: [{ field: "product.title", operator: "regex", values: ["adidas.{1,3}Samba"] },
    { field: "product.title", operator: "equals", values: ["Samba"] }] },
  { conditions: [{ field: "product.attribute.gender", operator: "equals", values: ["men"] }] }],
  actions: [{ targetScope: "product.category", dictionaryValueId: "9", externalValue: "99", externalLabel: "Кроссовки", mode: "replace" },
    { targetScope: "product.tag", dictionaryValueId: "10", externalValue: "100", externalLabel: "adidas", mode: "add" }] };
let imported = { ...rule, id: "46", name: "Проекция для проверки", originKind: "classification_projection", originId: "40",
  originPayload: { sourceOrigin: { mappingId: "7", ruleId: null }, manualOverride: false },
  conditionGroups: [{ conditions: [{ field: "candidate.model.sourceValue", operator: "equals", values: ["Samba"] }] }],
  actions: [rule.actions[0]!] };
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/")) {
    const name = url.pathname === "/rules-v2" ? "rules-v2.html" : url.pathname.replace("/assets/", "");
    if (!["rules-v2.html", "rules-v2.js", "admin-shell.js", "app.css"].includes(name)) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
    response.end(await readFile(`public/${name}`)); return;
  }
  response.setHeader("Content-Type", "application/json");
  const reply = (value: unknown) => response.end(JSON.stringify(value));
  if (url.pathname === "/api/auth/session") { reply({ authenticated: true, operator: "test", csrfToken: "test-only" }); return; }
  if (url.pathname === "/api/data-schema") { reply(schema); return; }
  if (url.pathname === "/api/targets") { reply({ items: [{ id: "2", code: "slamdunk", exporterCode: "wordpress", dictionary: {
    configured: true, creatableEntityTypes: ["brands", "models", "tags", "product_categories"],
    termRelationCapabilities: [{ relationCode: "landing", sourceEntityType: "models", relatedEntityType: "tags", targetScope: "product.tag", canCreateRelated: true }],
  } }] }); return; }
  if (url.pathname === "/api/rules-v2/workbench") { reply({ mode: "resulting_target_dto", counts: { ready: 0, incomplete: 1, conflict: 0 },
    filteredCount: 1, index: { complete: true, indexed: 1, total: 1 }, page: { offset: 0, limit: 40, hasMore: false }, items: [{
      sourceProductId: "1193637", sourceExternalId: "1807985", title: "Simone Rocha Peeling Waist Wide Leg Trousers 'Grey'", sku: "4213 1349 GREY",
      status: "incomplete", blockers: [{ code: "required_category_missing", message: "Не заполнено обязательное поле «Категория»." }], conflicts: [],
      result: { title: "Simone Rocha Peeling Waist Wide Leg Trousers 'Grey'", descriptionPresent: false, imageCount: 1, variantCount: 2,
        fields: { "product.brand": [{ id: "50", label: "Simone Rocha" }], "product.model": [], "product.category": [] } },
      candidates: { "product.brand": [{ key: "product:brand", sourceValue: "Simone Rocha", context: {} }],
        "product.model": [{ key: "product:model", sourceValue: "Peeling Waist Wide Leg Trousers", context: { brand: "Simone Rocha", family: "Peeling Waist" } }],
        "product.category": [{ key: "product:category", sourceValue: "trousers", context: { productCategory: "apparel", productType: "bottoms" } }] }, trace: [],
    }] }); return; }
  if (request.method === "PUT" || request.method === "POST") {
    let raw = ""; for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw);
    if (url.pathname.endsWith("/preview")) { reply({ preview: { productCount: 1, conflicts: [] } }); return; }
    if (url.pathname === "/api/targets/2/dictionary/terms/rules-v2") { reply({ result: {
      dictionaryValue: { id: "77", externalId: "177", name: body.name },
      relatedDictionaryValues: body.relatedTerm?.mode === "create"
        ? [{ id: "78", externalId: "178", name: body.name }]
        : [],
    } }); return; }
    if (url.pathname === "/api/rules-v2/46/imported") {
      imported = { ...imported, ...body, originPayload: { ...imported.originPayload, manualOverride: true }, revision: String(Number(imported.revision) + 1) };
      reply({ rule: imported }); return;
    }
    rule = { ...rule, ...body, revision: String(Number(rule.revision) + 1) };
    console.info(JSON.stringify({ saved: true, groups: rule.conditionGroups, actions: rule.actions }));
    reply({ rule }); return;
  }
  if (url.pathname === "/api/rules-v2") { reply({ mode: "shadow", authoritative: false,
    summary: { native: { shadow: 1, draft: 0, disabled: 0 }, catalog: { total: 1, exact: 0, conditional: 1 } },
    items: [rule, imported], page: { offset: Number(url.searchParams.get("offset") ?? "0"), limit: 100, hasMore: false } }); return; }
  reply({ items: [{ id: "9", externalId: "99", name: "Кроссовки" }, { id: "10", externalId: "100", name: "adidas" }] });
});
const port = Number(process.env.RULES_V2_FIXTURE_PORT ?? "4317");
server.listen(port, "127.0.0.1", () => console.info(`Rules v2 browser fixture: http://127.0.0.1:${port}/rules-v2`));
