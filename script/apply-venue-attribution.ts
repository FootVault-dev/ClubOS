// Apply the venue booking attribution migration. ADDITIVE ONLY.
// Dry-run (rolled back):  npx tsx --env-file=.env script/apply-venue-attribution.ts
// Apply (committed):      npx tsx --env-file=.env script/apply-venue-attribution.ts --apply
// (Prod has schema drift — never `db:push --force`. Run BEFORE fly deploy.)
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const apply = process.argv.includes("--apply");
const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "..", "migrations", "2026-07-22_venue_attribution.sql"), "utf8");
// The file wraps itself in BEGIN/COMMIT; strip those so this script owns the
// transaction (so a dry-run can ROLLBACK).
const body = raw
  .split("\n")
  .filter((l) => !/^\s*(BEGIN|COMMIT)\s*;\s*$/i.test(l))
  .join("\n");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  await pool.query("BEGIN");
  await pool.query(body);
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'facility_bookings' AND column_name = 'attribution_source'`,
  );
  const ok = r.rows.length > 0;
  console.log(`${ok ? "  ok " : " MISS"}  column facility_bookings.attribution_source`);
  if (!ok) { await pool.query("ROLLBACK"); console.error("\ncolumn missing after ALTER — DO NOT DEPLOY."); process.exit(1); }
  if (apply) { await pool.query("COMMIT"); console.log("\nCOMMITTED. Safe to deploy."); }
  else { await pool.query("ROLLBACK"); console.log("\nDRY-RUN ok (rolled back). Re-run with --apply to commit."); }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}
