/**
 * Apply migrations/2026-07-21_usc_maintenance.sql to the ClubOS database.
 *
 *   npx tsx script/apply-usc-maintenance.ts            # dry run — rolled back, nothing written
 *   npx tsx script/apply-usc-maintenance.ts --apply     # actually writes
 *
 * Additive only. Never `drizzle-kit push` against this DB — prod has schema
 * drift and push DROPS the drifted columns (see reference_clubos_prod_db_drift).
 *
 * The whole migration + every verification query runs INSIDE one transaction.
 * By default that transaction is ROLLED BACK — so a dry run proves the SQL
 * parses, the `organizations` foreign keys resolve, and every table/index/
 * constraint really does get created, while changing nothing. There is no
 * local Postgres to rehearse against, and a typo discovered during the real
 * run is a typo discovered with the deploy already half-done. `--apply` is the
 * only thing that flips the ending from ROLLBACK to COMMIT.
 *
 * The migration file itself has no preamble (no extension, no enum value to
 * add outside a transaction — maintenance needs neither), so unlike
 * apply-usc-housing.ts there is nothing that must run pre-transaction. The
 * comment-stripping splitter is kept anyway, copying housing's script
 * verbatim: a prose comment containing a semicolon-like fragment must never
 * be handed to Postgres as part of a statement.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const SQL_PATH = resolve(import.meta.dirname, "../migrations/2026-07-21_usc_maintenance.sql");

const TABLES = ["maint_supplies", "maint_stock_movements", "maint_assets", "maint_service_records"];

const CHECKS = [
  "maint_supplies_qty_ck",
  "maint_supplies_reorder_ck",
  "maint_supplies_cost_ck",
  "maint_stock_movements_delta_ck",
  "maint_assets_purchase_cost_ck",
  "maint_service_records_cost_ck",
];

const INDEXES = [
  "maint_supplies_org_idx",
  "maint_stock_movements_supply_idx",
  "maint_stock_movements_org_idx",
  "maint_assets_org_idx",
  "maint_service_records_asset_idx",
  "maint_service_records_org_idx",
];

/** Strip `--`-prefixed comment lines BEFORE splitting on `;`. A prose comment
 *  in this file could otherwise have a stray sentence cut mid-way by the
 *  splitter and hand Postgres a fragment. Mirrors apply-usc-housing.ts. */
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

    // Verification runs INSIDE the transaction, so a dry run checks the
    // objects it just built before throwing them all away.
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
    for (const c of CHECKS) {
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
      console.log("\n✅ Applied. 4 tables, their indexes and constraints. Safe to deploy.\n");
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
