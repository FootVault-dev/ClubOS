// Apply the Academy registrations migration to the live DB. ADDITIVE ONLY.
// Run: npx tsx --env-file=.env script/apply-academy-registrations.ts
// (Prod has schema drift — never `db:push --force`. Run BEFORE fly deploy.)
//
// Verifies every column/table the new academy signup flow depends on, so a
// half-applied migration is loud rather than silent. A missing NZF column would
// not break a payment — it would quietly drop the data Mainland Football audit.
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-09_academy_registrations.sql"), "utf8");

const EXPECTED: Array<[string, string]> = [
  ["contacts", "country_of_birth"],
  ["contacts", "place_of_birth"],
  ["contacts", "ethnicity"],
  ["contacts", "sub_ethnicity"],
  ["contacts", "ethnicity2"],
  ["contacts", "sub_ethnicity2"],
  ["contacts", "friendly_manager_id"],
  ["programs", "academy_section"],
  ["programs", "season_year"],
  ["programs", "registration_open"],
  ["registrations", "policy_accepted_at"],
  ["registrations", "policy_version"],
  ["registrations", "nzf_consent_at"],
  ["registrations", "academy_payment_plan"],
  ["registrations", "season_year"],
  ["registrations", "legacy_source"],
  ["registrations", "legacy_external_id"],
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  await pool.query("BEGIN");
  await pool.query(sql);
  await pool.query("COMMIT");

  let missing = 0;
  for (const [table, column] of EXPECTED) {
    const r = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2",
      [table, column],
    );
    const ok = r.rows.length > 0;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  ${table}.${column}`);
  }

  const t = await pool.query("SELECT to_regclass('academy_waitlist') AS t");
  const waitlistOk = t.rows[0].t !== null;
  console.log(`${waitlistOk ? "  ok " : " MISS"}  table academy_waitlist`);
  if (!waitlistOk) missing++;

  if (missing > 0) {
    console.error(`\n${missing} object(s) missing after migration — DO NOT DEPLOY.`);
    process.exit(1);
  }
  console.log("\nAll academy objects present. Safe to deploy.");
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}
