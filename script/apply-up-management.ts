/**
 * Apply migrations/2026-07-22_up_management.sql to the ClubOS database.
 *
 *   npx tsx script/apply-up-management.ts            # dry run — rolled back, nothing written
 *   npx tsx script/apply-up-management.ts --apply    # actually writes
 *
 * Additive only. Never `drizzle-kit push` against this DB — prod has schema
 * drift and push DROPS the drifted columns (see reference_clubos_prod_db_drift).
 *
 * The whole migration + every verification query runs INSIDE one transaction.
 * By default that transaction is ROLLED BACK — so a dry run proves the SQL
 * parses, the foreign keys resolve, and every table/index/constraint really
 * does get created, while changing nothing. `--apply` is the only thing that
 * flips the ending from ROLLBACK to COMMIT. Mirrors apply-usc-maintenance.ts.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const SQL_PATH = resolve(import.meta.dirname, "../migrations/2026-07-22_up_management.sql");

const TABLES = [
  "plan_projects", "plan_statuses", "plan_tasks",
  "plan_task_deps", "plan_checklist_items", "plan_comments",
];

const CHECKS = [
  "plan_tasks_progress_ck",
  "plan_task_deps_no_self_ck",
];

const UNIQUES = [
  "plan_task_deps_edge_uq",
];

const INDEXES = [
  "plan_projects_org_idx",
  "plan_statuses_project_idx", "plan_statuses_org_idx",
  "plan_tasks_project_idx", "plan_tasks_org_idx", "plan_tasks_status_idx", "plan_tasks_assignee_idx",
  "plan_task_deps_succ_idx", "plan_task_deps_org_idx",
  "plan_checklist_task_idx", "plan_checklist_org_idx",
  "plan_comments_task_idx", "plan_comments_org_idx",
];

/** Strip `--`-prefixed comment lines BEFORE splitting on `;`. */
function splitStatements(sql: string): string[] {
  return sql
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(";").map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");

  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const sql = readFileSync(SQL_PATH, "utf8");
  const statements = splitStatements(sql);

  console.log(APPLY ? "\nAPPLYING to the database.\n" : "\nDRY RUN — everything below is rolled back.\n");

  try {
    await pool.query("BEGIN");

    for (const stmt of statements) {
      console.log(`→ ${stmt.replace(/\s+/g, " ").slice(0, 70)}…`);
      await pool.query(stmt);
    }

    let missing = 0;

    for (const t of TABLES) {
      const r = await pool.query("SELECT to_regclass($1) AS t", [`public.${t}`]);
      const ok = r.rows[0].t !== null;
      if (!ok) missing++;
      console.log(`${ok ? "  ok " : " MISS"}  table ${t}`);
    }
    for (const idx of INDEXES) {
      const r = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [idx]);
      const ok = r.rows.length > 0;
      if (!ok) missing++;
      console.log(`${ok ? "  ok " : " MISS"}  index ${idx}`);
    }
    for (const c of [...CHECKS, ...UNIQUES]) {
      const r = await pool.query("SELECT 1 FROM pg_constraint WHERE conname = $1", [c]);
      const ok = r.rows.length > 0;
      if (!ok) missing++;
      console.log(`${ok ? "  ok " : " MISS"}  constraint ${c}`);
    }

    if (missing) {
      await pool.query("ROLLBACK");
      console.error(`\n${missing} object(s) missing — DO NOT DEPLOY.`);
      process.exit(1);
    }

    if (APPLY) {
      await pool.query("COMMIT");
      console.log("\n✅ Applied. 6 tables, their indexes and constraints. Safe to deploy.\n");
    } else {
      await pool.query("ROLLBACK");
      console.log("\n✓ Migration is valid. Rolled back — the database is unchanged.");
      console.log("  Re-run with --apply to write it for real.\n");
    }
  } catch (e) {
    await pool.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error("\n❌", e.message); process.exit(1); });
