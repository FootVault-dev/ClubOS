// Rehearse or apply the programme-level mapping columns.
//   npx tsx --env-file=.env script/apply-xero-map-by-program.ts [--commit]
import fs from "node:fs"; import path from "node:path"; import { Client } from "pg";
const COMMIT = process.argv.includes("--commit");
let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✅ ${l}`)) : (fail++, console.log(`  ❌ ${l}${d ? " — " + d : ""}`)); };
const refused = async (c: Client, l: string, sql: string, p: any[] = []) => {
  try { await c.query("SAVEPOINT s"); await c.query(sql, p); await c.query("RELEASE SAVEPOINT s"); ok(l, false, "ACCEPTED"); }
  catch { await c.query("ROLLBACK TO SAVEPOINT s"); ok(l, true); } };
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect(); await c.query("BEGIN");
  try {
    const f = path.resolve(process.cwd(), "migrations/2026-09-09_xero_map_by_program.sql");
    const sqlText = fs.readFileSync(f, "utf8");
    if (/^\s*(BEGIN|COMMIT)\b/im.test(sqlText)) throw new Error("migration carries its own BEGIN/COMMIT");
    await c.query(sqlText);
    console.log("\napplied 2026-09-09_xero_map_by_program.sql\n");

    const org = (await c.query(`SELECT id FROM organizations ORDER BY id LIMIT 1`)).rows[0].id;
    const prog = (await c.query(`SELECT id FROM programs ORDER BY id LIMIT 2`)).rows;

    await c.query(`DELETE FROM xero_account_map WHERE organization_id=$1 AND category='academy_term'`, [org]);
    await c.query(`INSERT INTO xero_account_map (organization_id, category, xero_account_code) VALUES ($1,'academy_term','200')`, [org]);
    ok("a category-only fallback row is allowed", true);
    await refused(c, "  and only ONE fallback per category",
      `INSERT INTO xero_account_map (organization_id, category, xero_account_code) VALUES ($1,'academy_term','200/07')`, [org]);

    await c.query(`INSERT INTO xero_account_map (organization_id, category, program_id, xero_account_code) VALUES ($1,'academy_term',$2,'200/05')`, [org, prog[0].id]);
    ok("a programme row can override the fallback", true);
    await refused(c, "  and only ONE row per programme",
      `INSERT INTO xero_account_map (organization_id, category, program_id, xero_account_code) VALUES ($1,'academy_term',$2,'200/07')`, [org, prog[0].id]);

    await c.query(`INSERT INTO xero_account_map (organization_id, category, program_id, xero_account_code) VALUES ($1,'academy_term',$2,'200/07')`, [org, prog[1].id]);
    ok("a DIFFERENT programme in the same category is allowed", true);
    await refused(c, "a programme that does not exist is refused",
      `INSERT INTO xero_account_map (organization_id, category, program_id, xero_account_code) VALUES ($1,'academy_term',999999,'200')`, [org]);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { await c.query("ROLLBACK"); process.exit(1); }
    if (COMMIT) { await c.query("COMMIT"); console.log("\n🟢 COMMITTED"); }
    else { await c.query("ROLLBACK"); console.log("\n↩️  rolled back (rehearsal)."); }
  } catch (e: any) { await c.query("ROLLBACK"); console.error("FATAL", e?.message); process.exit(1); }
  finally { await c.end(); }
  process.exit(0);
})();
