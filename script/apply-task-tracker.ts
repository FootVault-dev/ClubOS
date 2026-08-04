/**
 * Apply the Task Tracker migration.
 *
 * There is no local Postgres on this Mac, so a migration is rehearsed by
 * running it against the real database inside a transaction that is then
 * ROLLED BACK. `--dry-run` (the default) does exactly that and reports what it
 * would have created; `--apply` commits.
 *
 *   npx tsx script/apply-task-tracker.ts            # rehearse, roll back
 *   npx tsx script/apply-task-tracker.ts --apply    # commit
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const FILE = join(process.cwd(), "migrations", "2026-08-03_task_tracker.sql");

const TABLES = [
  "tt_areas",
  "tt_project_statuses",
  "tt_task_statuses",
  "tt_projects",
  "tt_tasks",
  "tt_task_assignees",
  "tt_checklist_items",
  "tt_comments",
];

async function main() {
  const sql = readFileSync(FILE, "utf8");
  // The file carries its own BEGIN/COMMIT so it is safe to run by hand in a
  // SQL console. Strip them here — this script owns the transaction, because a
  // nested COMMIT would defeat the rehearsal and silently apply a dry run.
  const body = sql.replace(/^\s*BEGIN;\s*$/gm, "").replace(/^\s*COMMIT;\s*$/gm, "");

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(body);

    // Verify inside the transaction: the tables exist, the seed rows landed,
    // and — the bit that is easy to forget — RLS is ON for every new table.
    const { rows: present } = await client.query(
      `SELECT c.relname, c.relrowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)
        ORDER BY c.relname`,
      [TABLES],
    );

    const missing = TABLES.filter((t) => !present.find((p) => p.relname === t));
    const rlsOff = present.filter((p) => !p.relrowsecurity).map((p) => p.relname);

    const counts: Record<string, number> = {};
    for (const t of ["tt_areas", "tt_project_statuses", "tt_task_statuses"]) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
      counts[t] = rows[0].n;
    }

    console.log(`\nTables created: ${present.length}/${TABLES.length}`);
    for (const p of present) console.log(`  ${p.relname.padEnd(22)} RLS ${p.relrowsecurity ? "ON" : "🔴 OFF"}`);
    console.log(`\nSeeded: areas=${counts.tt_areas} projectStatuses=${counts.tt_project_statuses} taskStatuses=${counts.tt_task_statuses}`);

    if (missing.length) throw new Error(`Missing tables: ${missing.join(", ")}`);
    if (rlsOff.length) throw new Error(`RLS is OFF on: ${rlsOff.join(", ")}`);
    if (counts.tt_areas === 0 || counts.tt_task_statuses === 0) throw new Error("Seed rows did not land");

    if (APPLY) {
      await client.query("COMMIT");
      console.log("\n✅ COMMITTED to the database.");
    } else {
      await client.query("ROLLBACK");
      console.log("\n↩️  Rolled back — this was a rehearsal. Re-run with --apply to commit.");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\n❌ Failed, rolled back:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
