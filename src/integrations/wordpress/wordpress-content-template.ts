import sanitizeHtml from "sanitize-html";

import type { JsonObject, JsonValue } from "../../contracts/index.js";
import { IntegrationContractError } from "../../core/errors/index.js";

export type WordPressContentTemplateField = "description" | "short_description";

export interface WordPressContentTemplateDefinition {
  readonly id: string;
  readonly field: WordPressContentTemplateField;
  readonly revision: number;
  readonly templateSource: string;
  readonly profileKey: string;
  readonly profileName: string;
  readonly managementMode: "manage" | "preserve";
  readonly categoryTermIds: readonly number[];
  readonly requiredContextPaths: readonly string[];
}

export interface WordPressContentTemplateSelection {
  readonly field: WordPressContentTemplateField;
  readonly managed: boolean;
  readonly source: "profile" | "system" | "preserved";
  readonly profileKey: string | null;
  readonly profileName: string | null;
  readonly reason: "matched" | "system_default" | "management_disabled" | "requirements_missing" | "no_matching_profile";
  readonly missingContextPaths: readonly string[];
  readonly templateSource?: string;
}

export interface WordPressContentTemplateVariable {
  readonly path: string;
  readonly label: string;
  readonly group: string;
  readonly valueType: "string" | "number" | "string_array";
  readonly example: string;
}

export interface WordPressContentTemplateHelper {
  readonly code: string;
  readonly label: string;
  readonly accepts: readonly WordPressContentTemplateVariable["valueType"][];
  readonly example: string;
}

const variables: readonly WordPressContentTemplateVariable[] = [
  { path: "product.effective_title", label: "Итоговое название", group: "Товар", valueType: "string", example: "Кроссовки Nike Dunk Low" },
  { path: "product.source_title", label: "Исходное название", group: "Товар", valueType: "string", example: "Nike Dunk Low" },
  { path: "product.sku", label: "Артикул", group: "Товар", valueType: "string", example: "FZ3781 060" },
  { path: "content.story", label: "Переведённая история", group: "Контент", valueType: "string", example: "Описание модели…" },
  { path: "content.description", label: "Переведённое описание", group: "Контент", valueType: "string", example: "Описание товара…" },
  { path: "content.color", label: "Переведённый цвет", group: "Контент", valueType: "string", example: "Серый" },
  { path: "content.details", label: "Переведённая расцветка", group: "Контент", valueType: "string", example: "Антрацит / Синий / Чёрный" },
  { path: "content.upper_material", label: "Переведённый материал верха", group: "Контент", valueType: "string", example: "Синтетика" },
  { path: "attributes.midsole", label: "Технология подошвы", group: "Характеристики", valueType: "string", example: "Air" },
  { path: "attributes.category", label: "Категория источника", group: "Характеристики", valueType: "string", example: "Lifestyle" },
  { path: "attributes.release_date", label: "Дата релиза", group: "Характеристики", valueType: "string", example: "02 января 2026г." },
  { path: "classification.brands", label: "Бренды", group: "Классификация", valueType: "string_array", example: "Nike" },
  { path: "classification.models", label: "Модели", group: "Классификация", valueType: "string_array", example: "Nike Dunk" },
  { path: "classification.categories", label: "Категории", group: "Классификация", valueType: "string_array", example: "Кроссовки женские" },
  { path: "classification.tags", label: "Метки", group: "Классификация", valueType: "string_array", example: "На каждый день" },
  { path: "classification.colors", label: "Цвета", group: "Классификация", valueType: "string_array", example: "Серый" },
  { path: "classification.materials", label: "Материалы", group: "Классификация", valueType: "string_array", example: "Синтетика" },
  { path: "variants.available_sizes", label: "Доступные размеры", group: "Вариации", valueType: "string_array", example: "5, 5.5, 6, 16.5" },
  { path: "variants.all_sizes", label: "Все размеры", group: "Вариации", valueType: "string_array", example: "5, 5.5, 6, 16.5" },
  { path: "variants.audience", label: "Пол / аудитория", group: "Вариации", valueType: "string", example: "women" },
  { path: "variants.size_system", label: "Размерная система", group: "Вариации", valueType: "string", example: "us-numeric" },
  { path: "variants.available_count", label: "Доступных вариаций", group: "Вариации", valueType: "number", example: "22" },
  { path: "variants.count", label: "Всего вариаций", group: "Вариации", valueType: "number", example: "22" },
] as const;

export const WORDPRESS_CONTENT_TEMPLATE_VARIABLES = variables;
const variablePaths = new Set(variables.map((item) => item.path));

export const WORDPRESS_CONTENT_TEMPLATE_REQUIREMENTS = [
  { path: "content.story", label: "Переведённая история товара" },
  { path: "content.description", label: "Переведённое описание источника" },
  { path: "variants.available_sizes", label: "Доступные размеры" },
] as const;

export const WORDPRESS_CONTENT_TEMPLATE_HELPERS: readonly WordPressContentTemplateHelper[] = [
  { code: "trim", label: "Убрать пробелы по краям", accepts: ["string"], example: "{{ content.story | trim }}" },
  { code: "upper", label: "Верхний регистр", accepts: ["string"], example: "{{ variants.audience | upper }}" },
  { code: "lower", label: "Нижний регистр", accepts: ["string"], example: "{{ product.effective_title | lower }}" },
  { code: "lower_first", label: "Первая буква строчная", accepts: ["string"], example: "{{ product.effective_title | lower_first }}" },
  { code: "unique", label: "Убрать повторы", accepts: ["string_array"], example: "{{ variants.available_sizes | unique }}" },
  { code: "numeric_sort", label: "Сортировать как числа", accepts: ["string_array"], example: "{{ variants.available_sizes | numeric_sort }}" },
  { code: "range", label: "Диапазон от минимума до максимума", accepts: ["string_array"], example: "{{ variants.available_sizes | numeric_sort | range:\" — \" }}" },
  { code: "join", label: "Перечислить значения", accepts: ["string_array"], example: "{{ classification.tags | join:\", \" }}" },
  { code: "first", label: "Первое значение", accepts: ["string_array"], example: "{{ classification.brands | first }}" },
  { code: "count", label: "Количество значений", accepts: ["string_array"], example: "{{ variants.available_sizes | count }}" },
  { code: "audience_label", label: "Название размерной сетки", accepts: ["string"], example: "{{ variants.audience | audience_label }}" },
  { code: "size_system_label", label: "Короткое название системы", accepts: ["string"], example: "{{ variants.size_system | size_system_label }}" },
  { code: "paragraphs", label: "Текст в HTML-абзацы", accepts: ["string"], example: "{{ content.story | paragraphs }}" },
  { code: "required", label: "Сделать значение обязательным", accepts: ["string", "number", "string_array"], example: "{{ product.sku | required }}" },
] as const;

const helperCodes = new Set(WORDPRESS_CONTENT_TEMPLATE_HELPERS.map((item) => item.code));

export const DEFAULT_WORDPRESS_DESCRIPTION_TEMPLATE = `<h2>{{ product.effective_title }}</h2>
{% if content.story %}{{ content.story | paragraphs }}{% endif %}
<ul>
  <li>Артикул: {{ product.sku | required }}</li>
  {% if content.color %}<li>Цвет: {{ content.color }}</li>{% endif %}
  {% if content.details %}<li>Расцветка: {{ content.details }}</li>{% endif %}
  {% if content.upper_material %}<li>Материал верха: {{ content.upper_material }}</li>{% endif %}
  {% if attributes.midsole %}<li>Технология: {{ attributes.midsole }}</li>{% endif %}
  {% if attributes.category %}<li>Категория: {{ attributes.category }}</li>{% endif %}
  {% if attributes.release_date %}<li>Дата релиза: {{ attributes.release_date }}</li>{% endif %}
</ul>`;

export const EXAMPLE_WORDPRESS_SHORT_DESCRIPTION_TEMPLATE = `<p>{{ product.effective_title }} поставляется сервисом при текущих условиях:</p>
<ul>
  <li>Бонусы с товаром: персональный промокод</li>
  <li>Наличие: под заказ</li>
  <li>Бесплатная доставка: от 14 раб. дней</li>
  {% if variants.available_sizes %}<li>Размеры: {{ variants.available_sizes | unique | numeric_sort | range:" — " }} {{ variants.audience | upper }} {{ variants.size_system | size_system_label }} ({{ variants.audience | audience_label }} размерная сетка бренда)</li>{% endif %}
</ul>`;

type Node = { readonly kind: "text"; readonly value: string }
  | { readonly kind: "output"; readonly expression: string }
  | { readonly kind: "if"; readonly condition: string; readonly truthy: readonly Node[]; readonly falsy: readonly Node[] };

interface SafeValue { readonly safeHtml: string }

function safeValue(value: unknown): value is SafeValue {
  return typeof value === "object" && value !== null && "safeHtml" in value;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function splitTemplate(source: string): readonly string[] {
  return source.split(/(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\})/gu).filter((part) => part !== "");
}

function parseNodes(parts: readonly string[], start = 0, stop: ReadonlySet<string> = new Set()): { readonly nodes: readonly Node[]; readonly index: number; readonly stopTag?: string } {
  const nodes: Node[] = [];
  let index = start;
  while (index < parts.length) {
    const part = parts[index]!;
    if (part.startsWith("{{")) {
      nodes.push({ kind: "output", expression: part.slice(2, -2).trim() });
      index++;
      continue;
    }
    if (part.startsWith("{%")) {
      const tag = part.slice(2, -2).trim();
      if (stop.has(tag)) return { nodes, index: index + 1, stopTag: tag };
      if (tag.startsWith("if ")) {
        const condition = tag.slice(3).trim();
        const truthy = parseNodes(parts, index + 1, new Set(["else", "endif"]));
        let falsy: readonly Node[] = [];
        let nextIndex = truthy.index;
        if (truthy.stopTag === "else") {
          const alternative = parseNodes(parts, truthy.index, new Set(["endif"]));
          falsy = alternative.nodes;
          nextIndex = alternative.index;
        }
        if (truthy.stopTag === undefined || (truthy.stopTag === "else" && nextIndex === truthy.index)) {
          throw new IntegrationContractError("Content template has an unclosed if block");
        }
        nodes.push({ kind: "if", condition, truthy: truthy.nodes, falsy });
        index = nextIndex;
        continue;
      }
      throw new IntegrationContractError(`Unsupported content template tag: ${tag}`);
    }
    nodes.push({ kind: "text", value: part });
    index++;
  }
  if (stop.size > 0) throw new IntegrationContractError("Content template has an unclosed if block");
  return { nodes, index };
}

function expressionParts(expression: string): readonly string[] {
  const result: string[] = [];
  let quoted = false;
  let escaped = false;
  let current = "";
  for (const character of expression) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quoted) { current += character; escaped = true; continue; }
    if (character === '"') { current += character; quoted = !quoted; continue; }
    if (character === "|" && !quoted) { result.push(current.trim()); current = ""; continue; }
    current += character;
  }
  if (quoted) throw new IntegrationContractError("Content template contains an unclosed quote");
  result.push(current.trim());
  return result;
}

function helperPart(part: string): { readonly code: string; readonly argument?: string } {
  const separator = part.indexOf(":");
  const code = (separator < 0 ? part : part.slice(0, separator)).trim();
  if (!helperCodes.has(code)) throw new IntegrationContractError(`Unknown content template helper: ${code}`);
  if (separator < 0) return { code };
  const raw = part.slice(separator + 1).trim();
  let argument: unknown;
  try { argument = JSON.parse(raw); } catch { throw new IntegrationContractError(`Helper ${code} argument must be a JSON string`); }
  if (typeof argument !== "string") throw new IntegrationContractError(`Helper ${code} argument must be a string`);
  return { code, argument };
}

function validatePath(path: string): void {
  if (!variablePaths.has(path)) throw new IntegrationContractError(`Unknown content template variable: ${path}`);
}

function validateNodes(nodes: readonly Node[], depth = 0): void {
  if (depth > 10) throw new IntegrationContractError("Content template nesting cannot exceed 10 levels");
  for (const node of nodes) {
    if (node.kind === "output") {
      const parts = expressionParts(node.expression);
      validatePath(parts[0] ?? "");
      parts.slice(1).forEach(helperPart);
    } else if (node.kind === "if") {
      const condition = node.condition.startsWith("not ") ? node.condition.slice(4).trim() : node.condition;
      validatePath(condition);
      validateNodes(node.truthy, depth + 1);
      validateNodes(node.falsy, depth + 1);
    }
  }
}

function valueAt(context: JsonObject, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[key];
  }, context);
}

function present(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return value !== null && value !== undefined && value !== false;
}

export function contentTemplateContextValuePresent(context: JsonObject, path: string): boolean {
  validatePath(path);
  return present(valueAt(context, path));
}

export function validateWordPressContentTemplateDefinition(template: WordPressContentTemplateDefinition): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(template.profileKey)) {
    throw new IntegrationContractError("Content template profile key is invalid");
  }
  if (template.profileName.trim() === "") throw new IntegrationContractError("Content template profile name is required");
  if (template.managementMode !== "manage" && template.managementMode !== "preserve") {
    throw new IntegrationContractError("Content template management mode is invalid");
  }
  if (template.categoryTermIds.some((termId) => !Number.isSafeInteger(termId) || termId <= 0)) {
    throw new IntegrationContractError("Content template category term IDs must be positive integers");
  }
  if (new Set(template.categoryTermIds).size !== template.categoryTermIds.length) {
    throw new IntegrationContractError("Content template category term IDs must be unique");
  }
  if (new Set(template.requiredContextPaths).size !== template.requiredContextPaths.length) {
    throw new IntegrationContractError("Content template required values must be unique");
  }
  template.requiredContextPaths.forEach(validatePath);
  validateWordPressContentTemplate(template.templateSource);
}

export function validateWordPressContentTemplateProfiles(templates: readonly WordPressContentTemplateDefinition[]): void {
  templates.forEach(validateWordPressContentTemplateDefinition);
  for (const field of ["description", "short_description"] as const) {
    const active = templates.filter((template) => template.field === field);
    const profileKeys = new Set<string>();
    let fallback: WordPressContentTemplateDefinition | null = null;
    const categoryOwners = new Map<number, WordPressContentTemplateDefinition>();
    for (const template of active) {
      if (profileKeys.has(template.profileKey)) throw new IntegrationContractError(`More than one active revision exists for content profile ${template.profileName}`);
      profileKeys.add(template.profileKey);
      if (template.categoryTermIds.length === 0) {
        if (fallback !== null) throw new IntegrationContractError(`Content profiles ${fallback.profileName} and ${template.profileName} are both fallbacks for ${field}`);
        fallback = template;
        continue;
      }
      for (const termId of template.categoryTermIds) {
        const owner = categoryOwners.get(termId);
        if (owner !== undefined) throw new IntegrationContractError(`Content profiles ${owner.profileName} and ${template.profileName} overlap on product category ${termId}`);
        categoryOwners.set(termId, template);
      }
    }
  }
}

export function selectWordPressContentTemplate(
  field: WordPressContentTemplateField,
  templates: readonly WordPressContentTemplateDefinition[],
  context: JsonObject,
  productCategoryTermIds: readonly number[],
): WordPressContentTemplateSelection {
  validateWordPressContentTemplateProfiles(templates);
  const fieldTemplates = templates.filter((template) => template.field === field);
  if (fieldTemplates.length === 0) {
    return field === "description"
      ? { field, managed: true, source: "system", profileKey: null, profileName: "Системный шаблон", reason: "system_default", missingContextPaths: [], templateSource: DEFAULT_WORDPRESS_DESCRIPTION_TEMPLATE }
      : { field, managed: false, source: "preserved", profileKey: null, profileName: null, reason: "no_matching_profile", missingContextPaths: [] };
  }
  const categories = new Set(productCategoryTermIds);
  const scoped = fieldTemplates.filter((template) => template.categoryTermIds.length > 0
    && template.categoryTermIds.some((termId) => categories.has(termId)));
  const selected = scoped[0] ?? fieldTemplates.find((template) => template.categoryTermIds.length === 0) ?? null;
  if (selected === null) {
    return { field, managed: false, source: "preserved", profileKey: null, profileName: null, reason: "no_matching_profile", missingContextPaths: [] };
  }
  if (selected.managementMode === "preserve") {
    return { field, managed: false, source: "profile", profileKey: selected.profileKey, profileName: selected.profileName, reason: "management_disabled", missingContextPaths: [] };
  }
  const missingContextPaths = selected.requiredContextPaths.filter((path) => !contentTemplateContextValuePresent(context, path));
  if (missingContextPaths.length > 0) {
    return { field, managed: false, source: "profile", profileKey: selected.profileKey, profileName: selected.profileName, reason: "requirements_missing", missingContextPaths };
  }
  return { field, managed: true, source: "profile", profileKey: selected.profileKey, profileName: selected.profileName, reason: "matched", missingContextPaths: [], templateSource: selected.templateSource };
}

function strings(value: unknown, helper: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new IntegrationContractError(`Helper ${helper} requires a string array`);
  }
  return [...value];
}

function numeric(value: string): number {
  const parsed = Number(value.replace(",", "."));
  if (!Number.isFinite(parsed)) throw new IntegrationContractError(`Size value is not numeric: ${value}`);
  return parsed;
}

function applyHelper(value: unknown, helper: ReturnType<typeof helperPart>): unknown {
  switch (helper.code) {
    case "trim": return String(value ?? "").trim();
    case "upper": return String(value ?? "").toLocaleUpperCase("ru-RU");
    case "lower": return String(value ?? "").toLocaleLowerCase("ru-RU");
    case "lower_first": { const text = String(value ?? ""); return text === "" ? "" : text[0]!.toLocaleLowerCase("ru-RU") + text.slice(1); }
    case "unique": return [...new Set(strings(value, helper.code))];
    case "numeric_sort": return strings(value, helper.code).sort((left, right) => numeric(left) - numeric(right));
    case "range": { const items = strings(value, helper.code); return items.length === 0 ? "" : `${items[0]}${helper.argument ?? " — "}${items.at(-1)}`; }
    case "join": return strings(value, helper.code).join(helper.argument ?? ", ");
    case "first": return strings(value, helper.code)[0] ?? "";
    case "count": return strings(value, helper.code).length;
    case "audience_label": return ({ men: "Мужская", women: "Женская", youth: "Детская", infant: "Детская", unisex: "Унисекс" } as Record<string, string>)[String(value)] ?? String(value ?? "");
    case "size_system_label": return ({ "us-numeric": "US", "eu-numeric": "EU", "uk-numeric": "UK", "jp-numeric": "JP", "cm-numeric": "CM" } as Record<string, string>)[String(value)] ?? String(value ?? "").replace(/-numeric$/u, "").toLocaleUpperCase("en-US");
    case "paragraphs": {
      const paragraphs = String(value ?? "").split(/\n\s*\n/gu).map((item) => item.trim()).filter(Boolean);
      return { safeHtml: paragraphs.map((item) => `<p>${escapeHtml(item).replaceAll("\n", "<br>")}</p>`).join("\n") } satisfies SafeValue;
    }
    case "required": if (!present(value)) throw new IntegrationContractError("Required content template value is empty"); return value;
    default: throw new IntegrationContractError(`Unknown content template helper: ${helper.code}`);
  }
}

function renderValue(expression: string, context: JsonObject): string {
  const parts = expressionParts(expression);
  let value = valueAt(context, parts[0]!);
  for (const part of parts.slice(1)) value = applyHelper(value, helperPart(part));
  if (safeValue(value)) return value.safeHtml;
  if (Array.isArray(value)) return escapeHtml(value.map(String).join(", "));
  return escapeHtml(value === null || value === undefined ? "" : String(value));
}

function renderNodes(nodes: readonly Node[], context: JsonObject): string {
  return nodes.map((node) => {
    if (node.kind === "text") return node.value;
    if (node.kind === "output") return renderValue(node.expression, context);
    const negative = node.condition.startsWith("not ");
    const path = negative ? node.condition.slice(4).trim() : node.condition;
    const truthy = present(valueAt(context, path));
    return renderNodes((negative ? !truthy : truthy) ? node.truthy : node.falsy, context);
  }).join("");
}

export function validateWordPressContentTemplate(source: string): void {
  if (source.trim() === "") throw new IntegrationContractError("Content template cannot be empty");
  if (source.length > 50_000) throw new IntegrationContractError("Content template cannot exceed 50000 characters");
  const parsed = parseNodes(splitTemplate(source));
  validateNodes(parsed.nodes);
}

export function renderWordPressContentTemplate(source: string, context: JsonObject): string {
  validateWordPressContentTemplate(source);
  const parsed = parseNodes(splitTemplate(source));
  return sanitizeHtml(renderNodes(parsed.nodes, context), {
    allowedTags: ["h2", "h3", "p", "ul", "ol", "li", "strong", "em", "br", "span", "a"],
    allowedAttributes: { a: ["href", "title", "target", "rel"], span: ["class"] },
    allowedSchemes: ["http", "https"],
    transformTags: { a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }, true) },
  }).trim();
}

export function contentTemplateCatalog(): JsonObject {
  return {
    variables: WORDPRESS_CONTENT_TEMPLATE_VARIABLES as unknown as readonly JsonValue[],
    helpers: WORDPRESS_CONTENT_TEMPLATE_HELPERS as unknown as readonly JsonValue[],
    requirements: WORDPRESS_CONTENT_TEMPLATE_REQUIREMENTS as unknown as readonly JsonValue[],
    defaults: {
      description: DEFAULT_WORDPRESS_DESCRIPTION_TEMPLATE,
      short_description: EXAMPLE_WORDPRESS_SHORT_DESCRIPTION_TEMPLATE,
    },
  };
}
