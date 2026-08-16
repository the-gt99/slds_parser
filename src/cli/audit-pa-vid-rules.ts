import { pathToFileURL } from "node:url";

import type { UniversalProductDTO } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import {
  createPostgresPool,
  PostgresTargetAssignmentRuleRepository,
  PostgresTargetDictionaryRepository,
} from "../infrastructure/db/index.js";
import { resolveTargetAssignments } from "../services/index.js";

interface AuditRow {
  readonly source_product_id: string;
  readonly title: string;
  readonly description: string;
  readonly resolved: UniversalProductDTO["classification"] extends { readonly resolved: infer Resolved } ? Resolved : never;
  readonly actual_terms: readonly { readonly term_id?: string | number; readonly name?: string }[];
}

function sorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

export function sameTerms(left: readonly string[], right: readonly string[]): boolean {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function main(): Promise<void> {
  const pool = createPostgresPool();
  try {
    const dictionaries = new PostgresTargetDictionaryRepository(pool);
    const target = (await dictionaries.listTargets()).find((item) => item.code === (process.env.PA_VID_AUDIT_TARGET ?? "slamdunk"));
    if (target === undefined) throw new IntegrationContractError("Target was not found");
    const rules = (await new PostgresTargetAssignmentRuleRepository(pool).list(target.id))
      .filter((rule) => rule.groupCode === "legacy_pa_vid")
      .map((rule) => ({ ...rule, enabled: true }));
    if (rules.length === 0) throw new IntegrationContractError("Imported pa_vid rules were not found");
    const importedExternalIds = new Set(rules.flatMap((rule) => rule.actions.map((action) => action.externalValue)));

    const client = await pool.connect();
    let rows: readonly AuditRow[];
    try {
      rows = (await client.query<AuditRow>(`
        SELECT internal.source_product_id::TEXT,
               COALESCE(internal.data->>'title', '') AS title,
               COALESCE(internal.data->>'description', '') AS description,
               COALESCE(internal.data#>'{classification,resolved}', '[]'::JSONB) AS resolved,
               CASE
                 WHEN JSONB_TYPEOF(snapshot.payload#>'{product,taxonomies,pa_vid}') = 'array'
                   THEN snapshot.payload#>'{product,taxonomies,pa_vid}'
                 ELSE '[]'::JSONB
               END AS actual_terms
        FROM target_product_snapshots snapshot
        JOIN internal_products internal ON internal.source_product_id = snapshot.source_product_id
        WHERE snapshot.target_id = $1 AND internal.status = 'classified'
        ORDER BY internal.source_product_id
      `, [target.id])).rows;
    } finally {
      client.release();
    }

    let predictedCount = 0;
    let actualCount = 0;
    let exactCount = 0;
    let predictedOnlyCount = 0;
    let actualOnlyCount = 0;
    let differentCount = 0;
    const predictedByTerm = new Map<string, number>();
    const examples = [];
    for (const row of rows) {
      const product = {
        title: row.title,
        description: row.description,
        classification: { resolved: row.resolved },
        referenceCandidates: [],
        attributes: {},
        metadata: {},
      } as unknown as UniversalProductDTO;
      const predicted = sorted(resolveTargetAssignments(product, rules)
        .filter((assignment) => assignment.targetScope === "product.activity")
        .map((assignment) => assignment.externalValue));
      const actual = sorted(row.actual_terms.flatMap((term) => term.term_id === undefined || !importedExternalIds.has(String(term.term_id))
        ? [] : [String(term.term_id)]));
      if (predicted.length > 0) predictedCount++;
      if (actual.length > 0) actualCount++;
      if (sameTerms(predicted, actual)) exactCount++;
      else if (predicted.length > 0 && actual.length === 0) predictedOnlyCount++;
      else if (predicted.length === 0 && actual.length > 0) actualOnlyCount++;
      else differentCount++;
      for (const term of predicted) predictedByTerm.set(term, (predictedByTerm.get(term) ?? 0) + 1);
      if (!sameTerms(predicted, actual) && examples.length < 30) {
        examples.push({ sourceProductId: row.source_product_id, title: row.title, predicted, actual });
      }
    }

    const labels = new Map(rules.flatMap((rule) => rule.actions.map((action) => [action.externalValue, action.externalLabel] as const)));
    console.log(JSON.stringify({
      target: { id: target.id, code: target.code, enabled: target.enabled },
      importedRules: rules.length,
      products: rows.length,
      predictedCount,
      actualCount,
      exactCount,
      predictedOnlyCount,
      actualOnlyCount,
      differentCount,
      predictedByTerm: [...predictedByTerm].map(([externalId, count]) => ({ externalId, label: labels.get(externalId) ?? null, count }))
        .sort((left, right) => right.count - left.count),
      examples,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
