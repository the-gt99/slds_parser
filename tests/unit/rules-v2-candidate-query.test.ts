import { describe, expect, it } from "vitest";
import type { RuleV2Record } from "../../src/repositories/index.js";
import { indexedCandidatePageSql, indexedRulePredicate } from "../../src/services/rules-v2-candidate-query.js";

const rule = (conditionGroups: RuleV2Record["conditionGroups"]) => ({ conditionGroups }) as RuleV2Record;
describe("indexed rule candidates", () => {
  it("keeps OR alternatives within each AND group and normalizes source values", () => {
    const parameters: unknown[] = ["1", "2"];
    const predicate = indexedRulePredicate(rule([
      { conditions: [{ field: "candidate.brand.sourceValue", operator: "equals", values: [" Ｎｉｋｅ "] }] },
      { conditions: [{ field: "candidate.category.sourceValue", operator: "one_of", values: ["tops", "hats"] }] },
    ]), parameters);
    expect(predicate).toContain("$3::TEXT[] AND product_reference_tokens(internal.data) && $4::TEXT[]");
    expect(parameters).toEqual(["1", "2", ["candidate.brand.sourceValue=nike"],
      ["candidate.category.sourceValue=tops", "candidate.category.sourceValue=hats"]]);
  });
  it("does not narrow a mixed OR group or locale-dependent Unicode comparisons", () => {
    expect(indexedRulePredicate(rule([{ conditions: [
      { field: "candidate.brand.sourceValue", operator: "equals", values: ["Nike"] },
      { field: "product.title", operator: "contains_phrase", values: ["running"] },
    ] }]), [])).toBeNull();
    expect(indexedRulePredicate(rule([{ conditions: [
      { field: "candidate.brand.sourceValue", operator: "equals", values: ["ΟΣ"] },
    ] }]), [])).toBeNull();
  });
  it("uses supported groups without treating other AND conditions as optional matches", () => {
    const parameters: unknown[] = [];
    expect(indexedRulePredicate(rule([
      { conditions: [{ field: "candidate.brand.sourceValue", operator: "equals", values: ["Nike"] }] },
      { conditions: [{ field: "candidate.category.context.audience", operator: "equals", values: ["men"] }] },
    ]), parameters)).not.toBeNull();
    expect(parameters).toEqual([["candidate.brand.sourceValue=nike"]]);
  });
  it("fetches DTOs after bounded ID selection, including dirty and missing index rows", () => {
    const sql = indexedCandidatePageSql("predicate", "$4", 500, "DESC", "$2");
    expect(sql).not.toContain("rules_v2_workbench_items");
    expect(sql).toContain("internal.data ? 'referenceCandidates'");
    expect(sql).toContain("ORDER BY product.id DESC LIMIT 500");
    expect(sql.indexOf("LIMIT 500")).toBeLessThan(sql.indexOf("THEN internal.data"));
    expect(sql).toContain("product.id < $4");
    expect(indexedCandidatePageSql("predicate", "$2", 2000, "ASC", "$3")).toContain("product.id > $2");
  });
});
