import { createHash } from "node:crypto";

import type { JsonValue } from "../../contracts/index.js";

export function stableJsonStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) => {
    if (left < right) {
      return -1;
    }

    if (left > right) {
      return 1;
    }

    return 0;
  });
  const properties = entries.map(
    ([key, entryValue]) =>
      `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`,
  );

  return `{${properties.join(",")}}`;
}

export function hashStableJson(value: JsonValue): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}
