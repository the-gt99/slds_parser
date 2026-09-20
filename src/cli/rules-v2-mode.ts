import { readFile } from "node:fs/promises";
import { createPostgresPool } from "../infrastructure/db/index.js";
import { RulesV2Runtime } from "../infrastructure/db/rules-v2-runtime.js";

const action = process.argv[2];
if (!["status", "freeze", "activate", "rollback"].includes(action ?? "")) {
  throw new Error("Usage: npm run rules-v2:mode -- status|freeze|activate|rollback");
}
const pool = createPostgresPool();
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const control = (await client.query<{ mode: "v1" | "v2"; revision: string; legacy_revision: string; data_revision: string; freeze_legacy: boolean }>(
    `SELECT mode, revision::TEXT, legacy_revision::TEXT,
      (revision - (SELECT COUNT(*) FROM rules_execution_history))::TEXT AS data_revision, freeze_legacy
     FROM rules_execution_control WHERE singleton FOR UPDATE`)).rows[0];
  if (control === undefined) throw new Error("Rules execution control is missing");
  if (action === "status") {
    await client.query("COMMIT");
    console.info(JSON.stringify(control));
  } else {
    const actor = process.env.RULES_EXECUTION_ACTOR?.trim();
    const reason = process.env.RULES_EXECUTION_REASON?.trim();
    if (!actor || !reason) throw new Error("RULES_EXECUTION_ACTOR and RULES_EXECUTION_REASON are required");
    if (action === "freeze") {
      if (control.mode !== "v1" || control.freeze_legacy) throw new Error("Legacy rules can only be frozen once while v1 is active");
      await client.query("UPDATE rules_execution_control SET freeze_legacy = TRUE, updated_at = NOW() WHERE singleton");
    } else {
      if (!control.freeze_legacy) throw new Error("Legacy rules must be frozen before a mode change");
      const enabled = await client.query("SELECT id FROM targets WHERE enabled = TRUE LIMIT 1");
      if (enabled.rowCount) throw new Error("Disable target exports before changing the rules engine");
      const writes = await client.query(`SELECT id FROM jobs WHERE status IN ('pending', 'running', 'retry')
        AND job_type IN ('export_product', 'submit_wordpress_variation_patches', 'poll_wordpress_variation_patches') LIMIT 1`);
      if (writes.rowCount) throw new Error("Active WordPress write jobs must be drained before changing the rules engine");
      if (action === "activate") {
        if (control.mode !== "v1") throw new Error("v2 is already active");
        const path = process.env.RULES_V2_AUDIT_REPORT;
        if (!path) throw new Error("RULES_V2_AUDIT_REPORT is required");
        const report = JSON.parse(await readFile(path, "utf8")) as {
          revision?: string; legacyRevision?: string; dataRevision?: string; checked?: number; total?: number;
          complete?: boolean; mismatches?: number; writes?: boolean;
        };
        if (!report.complete || report.checked !== report.total || !report.total || report.mismatches !== 0 || report.writes !== false) {
          throw new Error("A complete zero-difference read-only catalogue audit is required");
        }
        const snapshot = await new RulesV2Runtime(client, () => 0).snapshot();
        if (!snapshot.revision || report.dataRevision !== control.data_revision || report.legacyRevision !== control.legacy_revision) {
          throw new Error("Rules changed since the catalogue audit; rerun it");
        }
      } else if (control.mode !== "v2") throw new Error("v1 is already active");
      await client.query("UPDATE rules_execution_control SET mode = $1, revision = revision + 1, updated_at = NOW() WHERE singleton",
        [action === "activate" ? "v2" : "v1"]);
      await client.query("UPDATE target_export_revisions SET revision = revision + 1, updated_at = NOW()");
      await client.query(`INSERT INTO rules_execution_history (previous_mode, mode, revision, actor, reason)
        SELECT $1, mode, revision, $2, $3 FROM rules_execution_control WHERE singleton`, [control.mode, actor, reason]);
    }
    await client.query("COMMIT");
    console.info(JSON.stringify({ action, previousMode: control.mode, actor, reason }));
  }
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
