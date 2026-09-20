import { createPostgresPool } from "../infrastructure/db/index.js";
import { RulesV2Runtime } from "../infrastructure/db/rules-v2-runtime.js";
import { buildDirectTargetRulePlans } from "../services/rules-v2-direct-plan.js";

const pool = createPostgresPool();
const client = await pool.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const snapshot = await new RulesV2Runtime(client, () => 0).snapshot();
  const plans = buildDirectTargetRulePlans(snapshot.records);
  const sourceRules = snapshot.records.filter((rule) => rule.status === "shadow"
    && (rule.originKind === "exact_mapping" || rule.originKind === "classification_rule")
    && rule.actions.some((action) => action.kind === "resolve_reference"
      && action.resolutionStatus === "confirmed" && action.referenceValueId !== null));
  const bySourceRule = new Set(plans.map((plan) => plan.sourceRuleId));
  const bindings = new Map<string, number>();
  for (const plan of plans) for (const action of plan.actions) {
    bindings.set(action.originKind, (bindings.get(action.originKind) ?? 0) + 1);
  }
  const report = { revision: snapshot.revision, writes: false, sourceRules: sourceRules.length,
    directPlans: plans.length, withTargetBinding: bySourceRule.size,
    withoutTargetBinding: sourceRules.length - bySourceRule.size,
    actionsByOrigin: Object.fromEntries(bindings) };
  await client.query("COMMIT");
  console.info(JSON.stringify(report, null, 2));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
