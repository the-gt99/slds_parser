import type { RuleV2Record } from "../repositories/index.js";

/** Necessary conditions only. The evaluator still checks the complete rule. */
export function indexedRulePredicate(rule: Pick<RuleV2Record, "conditionGroups">, parameters: unknown[]): string | null {
  const groups: string[] = [];
  for (const group of rule.conditionGroups) {
    const tokens: string[] = [];
    let supported = group.conditions.length > 0;
    for (const condition of group.conditions) {
      const candidate = /^candidate\.(brand|model|category)\.sourceValue$/u.exec(condition.field);
      const common = /^common\.characteristics\.(brand|model|category)$/u.exec(condition.field);
      const type = candidate?.[1] ?? common?.[1];
      const normalized = condition.values.map((value) => value.trim().normalize("NFKC").toLocaleLowerCase("en-US"));
      if (type === undefined || !["equals", "one_of"].includes(condition.operator) || normalized.length === 0
        || normalized.some((value) => /[^\x00-\x7f]/u.test(value))) {
        supported = false;
        break;
      }
      // Non-ASCII case conversion can depend on the database locale; leave it to the evaluator.
      tokens.push(...normalized.map((value) => `candidate.${type}.sourceValue=${value}`));
    }
    // Groups are AND, conditions within a group are OR. Never narrow a mixed OR group.
    if (supported) {
      parameters.push(tokens);
      groups.push(`product_reference_tokens(internal.data) && $${parameters.length}::TEXT[]`);
    }
  }
  return groups.length === 0 ? null : `(${groups.join(" AND ")})`;
}

/** Query canonical source candidates, including products absent from the target workbench. */
export function indexedCandidatePageSql(predicate: string, cursor: string | null, limit: number,
  direction: "ASC" | "DESC", targetParameter: string): string {
  const productCursor = cursor === null ? "" : `AND product.id ${direction === "ASC" ? ">" : "<"} ${cursor}`;
  return `WITH candidate_ids AS MATERIALIZED (
      SELECT product.id FROM source_products product
      JOIN internal_products internal ON internal.source_product_id = product.id
      JOIN targets target ON target.id = ${targetParameter}
      WHERE product.source_id = $1 AND internal.data ? 'referenceCandidates' ${productCursor} AND (${predicate})
      ORDER BY product.id ${direction} LIMIT ${limit}
  )
  SELECT product.id::TEXT, product.source_id::TEXT, product.source_key, product.external_id, source.code,
    CASE WHEN internal.data ? 'referenceCandidates' THEN internal.data ELSE NULL END AS data,
    internal.updated_at::TEXT
  FROM candidate_ids selected JOIN source_products product ON product.id = selected.id
  JOIN sources source ON source.id = product.source_id
  JOIN internal_products internal ON internal.source_product_id = product.id
  WHERE product.source_id = $1 ORDER BY product.id ${direction}`;
}
