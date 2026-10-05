import type { ProductSizeDTO } from "../../contracts/index.js";

/** Normalize explicit source evidence; unknown values never imply a size group. */
export function normalizeSizeAudience(value: unknown): ProductSizeDTO["audience"] {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLocaleLowerCase("en-US")) {
    case "men":
    case "male": return "men";
    case "women":
    case "female": return "women";
    case "youth":
    case "kids":
    case "gs": return "youth";
    case "infant":
    case "td":
    case "ps": return "infant";
    case "unisex": return "unisex";
    default: return undefined;
  }
}
