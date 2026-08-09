import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/contracts/index.js";
import {
  renderWordPressContentTemplate,
  validateWordPressContentTemplate,
} from "../../src/integrations/index.js";

const context: JsonObject = {
  product: { effective_title: "Кроссовки Nike Dunk", source_title: "Nike Dunk", sku: "DD1503 101" },
  content: { story: "Первый абзац.\n\nВторой абзац.", description: "", color: "", details: "", upper_material: "" },
  attributes: { midsole: "", category: "Lifestyle", release_date: "" },
  classification: { brands: ["Nike"], models: ["Dunk"], categories: [], tags: [], colors: [], materials: [] },
  variants: { available_sizes: ["10", "5.5", "5", "10"], all_sizes: ["5", "5.5", "10"], audience: "women", size_system: "us-numeric", available_count: 4, count: 4 },
};

describe("WordPress content templates", () => {
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
});
