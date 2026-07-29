// Applies migrations/2026-07-29_warehouse_location_name.sql — a location gets
// a human name (D28). Dry-run by default; --apply commits.
//
//   npx tsx --env-file=.env script/apply-warehouse-location-name.ts
//   npx tsx --env-file=.env script/apply-warehouse-location-name.ts --apply
//
// The assertions that matter: the column exists and is NULLABLE with no
// default (a default would invent a name for a bin nobody has named), it is
// NOT unique (two sites can each have a "Main Shed"), and nothing existing
// changed — this runs against a live warehouse with 4,726 mapped items.

import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const APPLY = process.argv.includes("--apply");
const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-29_warehouse_location_name.sql"), "utf8");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const one = async (q: string, p: any[] = []) => (await pool.query(q, p)).rows[0];

try {
  await pool.query("BEGIN");
  const before = await one(`SELECT
    (SELECT count(*)::int FROM wh_locations) locations,
    (SELECT count(*)::int FROM wh_items) items,
    (SELECT count(*)::int FROM wh_movements) movements`);
  console.log("live before:", JSON.stringify(before), "\n");

  await pool.query(sql);
  let bad = 0;
  const check = (ok: boolean, label: string) => { if (!ok) bad++; console.log(`${ok ? "  ok " : " MISS"}  ${label}`); };

  const col = await one(`SELECT is_nullable, column_default, data_type
    FROM information_schema.columns
    WHERE table_name='wh_locations' AND column_name='name'`);
  check(!!col, "column wh_locations.name exists");
  check(col?.is_nullable === "YES", "nullable — a location with no name still shows its code");
  check(col?.column_default === null, "no default — never invents a name");
  check(col?.data_type === "text", "text");

  const uniq = await one(`SELECT count(*)::int n FROM pg_indexes
    WHERE tablename='wh_locations' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(name)%'`);
  check(Number(uniq.n) === 0, "not unique — two sites may both have a 'Main Shed'");

  // `code` must still carry the identity: unique, and every row still has one.
  const codeUniq = await one(`SELECT count(*)::int n FROM pg_indexes
    WHERE tablename='wh_locations' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(code)%'`);
  check(Number(codeUniq.n) >= 1, "code is still the unique identity");

  const named = await one(`SELECT count(*)::int n FROM wh_locations WHERE name IS NOT NULL`);
  check(Number(named.n) === 0, "no names written by the migration (seeding is a separate step)");

  const after = await one(`SELECT
    (SELECT count(*)::int FROM wh_locations) locations,
    (SELECT count(*)::int FROM wh_items) items,
    (SELECT count(*)::int FROM wh_movements) movements`);
  check(JSON.stringify(before) === JSON.stringify(after), `additive — ${JSON.stringify(after)}`);

  if (bad > 0) { console.error(`\n${bad} check(s) failed — DO NOT DEPLOY.`); await pool.query("ROLLBACK"); process.exit(1); }

  if (APPLY) { await pool.query("COMMIT"); console.log("\n✅ --apply passed — migration COMMITTED."); }
  else { await pool.query("ROLLBACK"); console.log("\n✅ Dry run passed — rolled back, nothing written."); }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}
