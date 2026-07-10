/**
 * Apply migrations/2026-07-10_usc_housing.sql to the ClubOS database.
 *
 *   npx tsx script/apply-usc-housing.ts            # dry run — prints the plan
 *   npx tsx script/apply-usc-housing.ts --apply    # actually writes
 *
 * Additive only. Never `drizzle-kit push` against this DB — prod has schema
 * drift and push DROPS the drifted columns (see reference_clubos_prod_db_drift).
 *
 * The `ALTER TYPE ... ADD VALUE` runs on its own connection outside the DDL
 * transaction: Postgres forbids using a new enum value in the transaction that
 * created it, and lumping them together is the easy way to trip that.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const SQL_PATH = resolve(import.meta.dirname, "../migrations/2026-07-10_usc_housing.sql");

const TABLES = [
  "housing_houses", "housing_rooms", "housing_tenancies",
  "housing_rent_charges", "housing_utility_accounts", "housing_utility_bills",
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");

  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const sql = readFileSync(SQL_PATH, "utf8");

  // Split off the pre-transaction statements (extension + enum value).
  const beginAt = sql.indexOf("\nBEGIN;");
  if (beginAt === -1) throw new Error("Expected a BEGIN; in the migration");
  const preamble = sql.slice(0, beginAt);
  const body = sql.slice(beginAt);

  const before = await inventory(pool);
  console.log("Before:", before);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.");
    console.log(`Would create ${TABLES.filter(t => !before.tables.includes(t)).length} table(s),`);
    console.log(`the btree_gist extension (installed: ${before.btreeGist}),`);
    console.log(`and contact_type value 'tenant' (present: ${before.tenantEnum}).`);
    await pool.end();
    return;
  }

  // 1. Extension + enum value, each autocommitted on its own.
  //
  // Strip the `--` comment lines BEFORE splitting on `;`. A prose comment in
  // this file contains "(and squad members); forking them…" — splitting first
  // cuts that sentence out of its comment and hands Postgres the fragment.
  const statements = preamble
    .split("\n").filter(l => !l.trim().startsWith("--")).join("\n")
    .split(";").map(x => x.trim()).filter(Boolean);

  for (const stmt of statements) {
    console.log(`\n→ ${stmt.replace(/\s+/g, " ").slice(0, 70)}…`);
    await pool.query(stmt);
  }

  // 2. The tables, indexes and constraints, as one transaction.
  console.log("\n→ CREATE TABLEs (transactional)…");
  await pool.query(body);

  const after = await inventory(pool);
  console.log("\nAfter:", after);

  const missing = TABLES.filter(t => !after.tables.includes(t));
  if (missing.length) throw new Error(`Missing after migrate: ${missing.join(", ")}`);
  if (!after.noOverlap) throw new Error("housing_tenancies_no_overlap constraint was not created");
  if (!after.tenantEnum) throw new Error("contact_type 'tenant' was not added");

  console.log("\n✅ Applied. 6 tables, the no-overlap exclusion constraint, and the tenant contact type.");
  await pool.end();
}

async function inventory(pool: pg.Pool) {
  const t = await pool.query(
    `select table_name from information_schema.tables
      where table_schema='public' and table_name = any($1)`, [TABLES]);
  const c = await pool.query(
    `select 1 from pg_constraint where conname='housing_tenancies_no_overlap'`);
  const e = await pool.query(
    `select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid
      where t.typname='contact_type' and e.enumlabel='tenant'`);
  const x = await pool.query(
    `select installed_version from pg_available_extensions where name='btree_gist'`);
  return {
    tables: t.rows.map(r => r.table_name).sort(),
    noOverlap: c.rowCount! > 0,
    tenantEnum: e.rowCount! > 0,
    btreeGist: x.rows[0]?.installed_version ?? null,
  };
}

main().catch(e => { console.error("\n❌", e.message); process.exit(1); });
