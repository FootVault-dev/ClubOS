/**
 * Apply the Task Tracker pages migration (the navigable hierarchy).
 *   npx tsx script/apply-task-tracker-pages.ts          # rehearse, roll back
 *   npx tsx script/apply-task-tracker-pages.ts --apply  # commit
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const FILE = join(process.cwd(), "migrations", "2026-08-04_task_tracker_pages.sql");

async function main() {
  const sql = readFileSync(FILE, "utf8")
    .replace(/^\s*BEGIN;\s*$/gm, "").replace(/^\s*COMMIT;\s*$/gm, "");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query(sql);
    const { rows } = await c.query(
      `SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND c.relname='tt_pages'`);
    if (rows.length !== 1) throw new Error("tt_pages was not created");
    if (!rows[0].relrowsecurity) throw new Error("RLS is OFF on tt_pages");
    console.log("tt_pages created · RLS ON");
    if (APPLY) { await c.query("COMMIT"); console.log("✅ COMMITTED."); }
    else { await c.query("ROLLBACK"); console.log("↩️  Rehearsal rolled back."); }
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    console.error("❌", (e as Error).message); process.exitCode = 1;
  } finally { await c.end(); }
}
main();
