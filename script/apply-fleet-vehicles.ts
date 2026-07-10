// Apply the fleet (company vehicles) migration. ADDITIVE ONLY.
//
//   Rehearse:  npx tsx --env-file=.env script/apply-fleet-vehicles.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-fleet-vehicles.ts
//
// `--dry-run` runs the whole migration and every verification inside a
// transaction it then ROLLS BACK. Postgres DDL is transactional, so this proves
// the SQL parses, the `organizations` and `users` foreign keys resolve, and the
// partial indexes build — while changing nothing. There is no local Postgres to
// rehearse against, and a typo discovered during the real run is a typo
// discovered with the deploy already half-done.
//
// (Prod has schema drift — never `db:push --force`. Run BEFORE fly deploy.)
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-10_fleet_vehicles.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  console.log(DRY_RUN ? "\nDRY RUN — everything below is rolled back.\n" : "\nAPPLYING to the database.\n");
  await pool.query("BEGIN");
  await pool.query(sql);
  // Verification runs INSIDE the transaction, so a dry run checks the objects
  // it just built before throwing them away.

  let missing = 0;
  for (const t of [
    "fleet_vehicles",
    "fleet_assignments",
    "fleet_insurance_policies",
    "fleet_service_records",
    "fleet_costs",
  ]) {
    const r = await pool.query("SELECT to_regclass($1) AS t", [t]);
    const ok = r.rows[0].t !== null;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  table ${t}`);
  }
  for (const idx of [
    "fleet_vehicles_org_plate_live_unq",
    "fleet_assignments_one_open_unq",
    "fleet_insurance_vehicle_expiry_idx",
    "fleet_service_vehicle_idx",
    "fleet_costs_vehicle_idx",
  ]) {
    const r = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [idx]);
    const ok = r.rows.length > 0;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  index ${idx}`);
  }

  // The two partial unique indexes are the load-bearing ones — they are what
  // stops a duplicate live plate and a double-booked van. Prove they are
  // actually partial, not plain: a plain unique index here would reject the
  // *second* assignment a vehicle ever has, which would look like a bug in the
  // app rather than a bug in this migration.
  const partials = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN ('fleet_vehicles_org_plate_live_unq', 'fleet_assignments_one_open_unq')`,
  );
  for (const row of partials.rows) {
    const ok = / WHERE /i.test(row.indexdef);
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  ${row.indexname} is partial`);
  }

  if (missing) {
    await pool.query("ROLLBACK");
    console.error(`\n${missing} object(s) missing — DO NOT DEPLOY.`);
    process.exit(1);
  }

  if (DRY_RUN) {
    await pool.query("ROLLBACK");
    console.log("\n✓ Migration is valid. Rolled back — the database is unchanged.");
    console.log("  Re-run without --dry-run to apply it for real.\n");
  } else {
    await pool.query("COMMIT");
    console.log("\nAll fleet objects present. Safe to deploy.\n");
  }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}
