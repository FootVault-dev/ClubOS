// Apply (or rehearse) the Stripe payout → Xero migration.
//
//   npx tsx --env-file=.env script/apply-xero-payout.ts            # rehearse, rolls back
//   npx tsx --env-file=.env script/apply-xero-payout.ts --commit
//
// 🔴 The migration file carries NO BEGIN/COMMIT of its own. One that does ends
// this transaction early and the ROLLBACK below then runs in autocommit — the
// dry run reports success having actually written. (14 migrations in this repo
// still have that hole; this is not one of them.)

import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const COMMIT = process.argv.includes("--commit");
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? " — " + detail : ""}`); }
};
/** An insert that MUST be refused. Proves the constraint, not the intention. */
const refused = async (c: Client, label: string, sql: string, params: any[] = []) => {
  try { await c.query("SAVEPOINT s"); await c.query(sql, params); await c.query("RELEASE SAVEPOINT s"); ok(label, false, "the database ACCEPTED it"); }
  catch { await c.query("ROLLBACK TO SAVEPOINT s"); ok(label, true); }
};

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("BEGIN");
  try {
    const file = path.resolve(process.cwd(), "migrations/2026-09-09_xero_payout_posting.sql");
    const sqlText = fs.readFileSync(file, "utf8");
    if (/^\s*(BEGIN|COMMIT)\b/im.test(sqlText)) throw new Error("migration carries its own BEGIN/COMMIT — it would defeat --dry-run");
    await c.query(sqlText);
    console.log(`\napplied ${path.basename(file)}\n`);

    for (const t of ["xero_account_map", "xero_payout_rules", "xero_payout_posts"]) {
      const r = await c.query(`SELECT to_regclass($1) IS NOT NULL AS x`, [t]);
      ok(`table ${t} exists`, r.rows[0].x);
      const rls = await c.query(`SELECT relrowsecurity FROM pg_class WHERE relname = $1`, [t]);
      ok(`  RLS on for ${t}`, rls.rows[0]?.relrowsecurity === true);
    }

    const org = (await c.query(`SELECT id FROM organizations ORDER BY id LIMIT 1`)).rows[0].id;

    // --- the money invariants, each proven by a refusal -------------------
    await c.query(`INSERT INTO xero_payout_posts (organization_id, stripe_payout_id, arrival_date, currency, payout_cents, split_json)
                   VALUES ($1,'po_test_1','2026-09-09','NZD',12345,'{}'::jsonb)`, [org]);
    ok("a pending post can be recorded", true);

    await refused(c, "the SAME payout cannot be posted twice",
      `INSERT INTO xero_payout_posts (organization_id, stripe_payout_id, arrival_date, currency, payout_cents, split_json)
       VALUES ($1,'po_test_1','2026-09-09','NZD',12345,'{}'::jsonb)`, [org]);

    await refused(c, "'posted' without a Xero document is refused",
      `UPDATE xero_payout_posts SET status='posted' WHERE stripe_payout_id='po_test_1'`);

    await c.query(`UPDATE xero_payout_posts SET status='posted', xero_bank_txn_id='bt-1', posted_at=now() WHERE stripe_payout_id='po_test_1'`);
    ok("'posted' WITH a Xero document is accepted", true);

    await refused(c, "a zero-amount payout is refused",
      `INSERT INTO xero_payout_posts (organization_id, stripe_payout_id, arrival_date, currency, payout_cents, split_json)
       VALUES ($1,'po_test_zero','2026-09-09','NZD',0,'{}'::jsonb)`, [org]);

    await refused(c, "an unknown status is refused",
      `INSERT INTO xero_payout_posts (organization_id, stripe_payout_id, arrival_date, currency, payout_cents, split_json, status)
       VALUES ($1,'po_test_2','2026-09-09','NZD',100,'{}'::jsonb,'donezo')`, [org]);

    // A different Stripe account may pay out the same id space independently.
    await c.query(`INSERT INTO xero_payout_posts (organization_id, stripe_payout_id, stripe_account, arrival_date, currency, payout_cents, split_json)
                   VALUES ($1,'po_test_1','cugc','2026-09-09','NZD',555,'{}'::jsonb)`, [org]);
    ok("the same payout id on a DIFFERENT Stripe account is allowed", true);

    // --- mapping + rules --------------------------------------------------
    await c.query(`INSERT INTO xero_account_map (organization_id, category) VALUES ($1,'academy_term')`, [org]);
    ok("a category can exist with NO account code (nobody has said yet)", true);
    await refused(c, "the same category cannot be mapped twice",
      `INSERT INTO xero_account_map (organization_id, category) VALUES ($1,'academy_term')`, [org]);

    await c.query(`INSERT INTO xero_payout_rules (organization_id, match_value, category) VALUES ($1,'CIC Content Marketplace','shop')`, [org]);
    ok("an external-source rule can be added", true);
    await refused(c, "a too-short rule (would match everything) is refused",
      `INSERT INTO xero_payout_rules (organization_id, match_value, category) VALUES ($1,'CIC','shop')`, [org]);
    await refused(c, "an unknown match kind is refused",
      `INSERT INTO xero_payout_rules (organization_id, match_kind, match_value, category) VALUES ($1,'vibes','something','shop')`, [org]);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { await c.query("ROLLBACK"); console.error("\n❌ rolled back — fix the migration"); process.exit(1); }

    if (COMMIT) { await c.query("COMMIT"); console.log("\n🟢 COMMITTED"); }
    else { await c.query("ROLLBACK"); console.log("\n↩️  rolled back (rehearsal). Re-run with --commit to apply."); }
  } catch (e: any) {
    await c.query("ROLLBACK"); console.error("\nFATAL", e?.message ?? e); process.exit(1);
  } finally { await c.end(); }
  process.exit(0);
})();
