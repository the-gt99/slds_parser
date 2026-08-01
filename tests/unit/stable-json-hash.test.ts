import { describe, expect, it } from "vitest";

import {
  hashStableJson,
  stableJsonStringify,
} from "../../src/core/utils/index.js";

describe("stable JSON hashing", () => {
  it("sorts object keys recursively", () => {
    const first = { z: 1, nested: { b: true, a: null }, a: "value" };
    const second = { a: "value", nested: { a: null, b: true }, z: 1 };

    expect(stableJsonStringify(first)).toBe(
      '{"a":"value","nested":{"a":null,"b":true},"z":1}',
    );
    expect(hashStableJson(first)).toBe(hashStableJson(second));
  });

  it("returns a SHA-256 hexadecimal digest", () => {
    expect(hashStableJson({ value: "test" })).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("preserves array order", () => {
    const ascending = hashStableJson({ values: [1, 2, 3] });
    const descending = hashStableJson({ values: [3, 2, 1] });

    expect(ascending).not.toBe(descending);
    expect(stableJsonStringify([3, 1, 2])).toBe("[3,1,2]");
  });
});
