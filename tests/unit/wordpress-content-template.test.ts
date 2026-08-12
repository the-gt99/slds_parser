import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/contracts/index.js";
import {
  contentTemplateContextWithExistingStoryPlaceholder,
  renderWordPressContentTemplate,
  selectWordPressContentTemplate,
  validateWordPressContentTemplate,
  validateWordPressContentTemplateProfiles,
} from "../../src/integrations/index.js";
import type { WordPressContentTemplateDefinition } from "../../src/integrations/index.js";

const context: JsonObject = {
  product: { effective_title: "Кроссовки Nike Dunk", source_title: "Nike Dunk", sku: "DD1503 101" },
  content: { story: "Первый абзац.\n\nВторой абзац.", description: "", color: "", details: "", upper_material: "" },
  attributes: { midsole: "", category: "Lifestyle", release_date: "" },
  classification: { brands: ["Nike"], models: ["Dunk"], categories: [], tags: [], colors: [], materials: [] },
  links: { model_tag_name: "Nike Dunk", model_tag_url: "/tags/nike-dunk/" },
  variants: { available_sizes: ["10", "5.5", "5", "10"], all_sizes: ["5", "5.5", "10"], audience: "women", size_system: "us-numeric", available_count: 4, count: 4 },
};

describe("WordPress content templates", () => {
  const profile = (overrides: Partial<WordPressContentTemplateDefinition> = {}): WordPressContentTemplateDefinition => ({
    id: "1", field: "description", revision: 1, templateSource: "<p>{{ content.story }}</p>", profileKey: "default",
    profileName: "Основной профиль", managementMode: "manage", categoryTermIds: [], requiredContextPaths: [], ...overrides,
  });
  it("renders conditions and a numeric size range", () => {
    const result = renderWordPressContentTemplate(
      "{% if variants.available_sizes %}<p>Размеры: {{ variants.available_sizes | unique | numeric_sort | range:\" — \" }} {{ variants.audience | upper }} {{ variants.size_system | size_system_label }}</p>{% else %}<p>Нет размеров</p>{% endif %}",
      context,
    );

    expect(result).toBe("<p>Размеры: 5 — 10 WOMEN US</p>");
  });

  it("escapes variables and sanitizes template HTML", () => {
    const unsafe: JsonObject = {
      ...context,
      product: { effective_title: "<img src=x onerror=alert(1)>", source_title: "", sku: "SKU" },
    };

    const result = renderWordPressContentTemplate(
      "<script>alert(1)</script><h2>{{ product.effective_title }}</h2><a href=\"javascript:alert(2)\">Ссылка</a>",
      unsafe,
    );

    expect(result).not.toContain("script");
    expect(result).not.toContain("javascript:");
    expect(result).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("turns translated text into escaped paragraphs", () => {
    expect(renderWordPressContentTemplate("{{ content.story | paragraphs }}", context)).toBe("<p>Первый абзац.</p>\n<p>Второй абзац.</p>");
  });

  it("rejects unknown variables and unclosed blocks", () => {
    expect(() => validateWordPressContentTemplate("{{ process.env.SECRET }}")).toThrow("Unknown content template variable");
    expect(() => validateWordPressContentTemplate("{% if product.sku %}SKU")).toThrow("unclosed if block");
  });

  it("fails explicitly when a required value is empty", () => {
    expect(() => renderWordPressContentTemplate("{{ content.color | required }}", context)).toThrow("Required content template value is empty");
  });

  it("renders a managed model tag link from the target context", () => {
    expect(renderWordPressContentTemplate(
      "{% if links.model_tag_url %}<p><span class=\"slds-managed-model-tag-link\"><a href=\"{{ links.model_tag_url }}\">Заказать другие расцветки {{ links.model_tag_name }}</a></span></p>{% endif %}",
      context,
    )).toBe('<p><span class="slds-managed-model-tag-link"><a href="/tags/nike-dunk/" rel="noopener noreferrer">Заказать другие расцветки Nike Dunk</a></span></p>');
  });

  it("selects a category profile before the fallback profile", () => {
    const selected = selectWordPressContentTemplate("description", [
      profile(),
      profile({ id: "2", profileKey: "sneakers", profileName: "Кроссовки", categoryTermIds: [74, 75] }),
    ], context, [75]);

    expect(selected).toMatchObject({ managed: true, profileKey: "sneakers", reason: "matched" });
  });

  it("preserves the field when a required source value is absent", () => {
    const missingStory = { ...context, content: { ...(context.content as JsonObject), story: "" } };
    const selected = selectWordPressContentTemplate("description", [
      profile({ requiredContextPaths: ["content.story"] }),
    ], missingStory, [75]);

    expect(selected).toMatchObject({ managed: false, reason: "requirements_missing", missingContextPaths: ["content.story"] });
  });

  it("keeps a managed description when an existing WordPress story may satisfy the requirement", () => {
    const missingStory = { ...context, content: { ...(context.content as JsonObject), story: "" } };
    const selected = selectWordPressContentTemplate("description", [
      profile({ requiredContextPaths: ["content.story"], preserveExistingStory: true }),
    ], missingStory, [75]);

    expect(selected).toMatchObject({ managed: true, preserveExistingStory: true, requireStoryAfterFallback: true });
    expect(renderWordPressContentTemplate(
      "<h2>Товар</h2>{% if content.story %}{{ content.story | paragraphs }}{% endif %}<ul><li>Артикул: SKU</li></ul>",
      contentTemplateContextWithExistingStoryPlaceholder(missingStory),
    )).toContain("slds-existing-story-placeholder");
  });

  it("rejects overlapping category profiles", () => {
    expect(() => validateWordPressContentTemplateProfiles([
      profile({ profileKey: "first", profileName: "Первый", categoryTermIds: [74] }),
      profile({ id: "2", profileKey: "second", profileName: "Второй", categoryTermIds: [74, 75] }),
    ])).toThrow("overlap");
  });
});
