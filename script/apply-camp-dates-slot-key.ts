// Re-key camp_dates from one-row-per-day to one-row-per-slot.
//
//   Rehearse:  npx tsx --env-file=.env script/apply-camp-dates-slot-key.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-camp-dates-slot-key.ts
//
// Both invariants are PROVEN inside the rolled-back transaction: the holiday
// camp rule must still bite, and the term-slot rule must allow a second slot on
// the same day while refusing a duplicate of the same slot.
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");
const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-23_camp_dates_slot_key.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const db = await pool.connect();

const refuses = async (label: string, stmts: string[]) => {
  let refused = false;
  await db.query("SAVEPOINT p");
  try { for (const s of stmts) await db.query(s); } catch { refused = true; }
  await db.query("ROLLBACK TO SAVEPOINT p");
  return refused;
};
const allows = async (stmts: string[]) => !(await refuses("", stmts));

try {
  console.log(DRY_RUN ? "\nDRY RUN — everything below is rolled back.\n" : "\nAPPLYING to the database.\n");

  const before = await db.query("SELECT count(*)::int AS n FROM camp_dates");
  console.log(`  existing camp_dates rows: ${before.rows[0].n}\n`);

  await db.query("BEGIN");
  await db.query(sql);

  let missing = 0;
  const check = (ok: boolean, label: string) => {
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  ${label}`);
  };

  {
    const r = await db.query(
      "SELECT 1 FROM pg_constraint WHERE conrelid='camp_dates'::regclass AND conname='camp_dates_camp_id_date_key'");
    check(r.rows.length === 0, "old UNIQUE (camp_id, date) is gone");
  }
  for (const idx of ["camp_dates_day_uniq", "camp_dates_slot_uniq"]) {
    const r = await db.query("SELECT 1 FROM pg_indexes WHERE indexname=$1", [idx]);
    check(r.rows.length > 0, `index ${idx}`);
  }

  // Behavioural proof, on a scratch programme so no real row is touched.
  const P = 4;
  const D = "2099-01-03";  // a Saturday far outside any real term
  const mk = (t: string | null) =>
    `INSERT INTO camp_dates (camp_id, date, start_time, end_time) VALUES (${P}, '${D}', ${t ? `'${t}'` : "NULL"}, '23:59')`;

  check(await refuses("", [mk(null), mk(null)]), "two NULL-time rows on one day are refused (holiday camps)");
  check(await allows([mk("09:30"), mk("10:30")]), "two DIFFERENT time slots on one day are allowed (term)");
  check(await refuses("", [mk("09:30"), mk("09:30")]), "the SAME time slot twice is refused");

  const after = await db.query("SELECT count(*)::int AS n FROM camp_dates");
  check(after.rows[0].n === before.rows[0].n, `no camp_dates rows added or lost (${after.rows[0].n})`);

  if (missing) {
    await db.query("ROLLBACK");
    console.error(`\n${missing} check(s) failed — DO NOT DEPLOY.`);
    process.exit(1);
  }

  if (DRY_RUN) {
    await db.query("ROLLBACK");
    console.log("\n✓ Migration is valid. Rolled back — the database is unchanged.\n");
  } else {
    await db.query("COMMIT");
    console.log("\ncamp_dates is now keyed by slot. Term timetables can run twice a day.\n");
  }
} catch (e) {
  await db.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  db.release();
  await pool.end();
}
