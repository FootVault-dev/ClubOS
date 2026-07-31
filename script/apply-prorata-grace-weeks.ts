// Pro-rata grace weeks — U4–U8 charges the full $160 for weeks 1–5.
//
//   Rehearse (default, rolls everything back):
//     npx tsx --env-file=.env script/apply-prorata-grace-weeks.ts
//   Apply for real:
//     npx tsx --env-file=.env script/apply-prorata-grace-weeks.ts --apply
//
// DRY RUN IS THE DEFAULT because this changes what a parent is charged.
//
// The rehearsal proves four things inside the transaction, against the real
// pricing function the checkout uses — not against a restatement of it:
//   1. the column exists and U4–U8 carries 5
//   2. NOTHING else moved off 0 (Technification especially)
//   3. weeks 1–5 quote $160, week 6 quotes $80
//   4. the numbers are computed from the term dates actually in the database
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { termProgress, prorateTermPriceCents } from "../shared/academy";

const APPLY = process.argv.includes("--apply");
const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-08-01_prorata_grace_weeks.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const db = await pool.connect();

let missing = 0;
const check = (okFlag: boolean, label: string) => {
  if (!okFlag) missing++;
  console.log(`${okFlag ? "  ok " : " MISS"}  ${label}`);
};
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
/** Term start + n days, as YYYY-MM-DD. */
const plusDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

try {
  console.log(APPLY ? "\nAPPLYING to the database.\n" : "\nDRY RUN — everything below is rolled back. Pass --apply to commit.\n");

  await db.query("BEGIN");
  await db.query(sql);

  // 1. The column, and the one row that opts in.
  const target = await db.query(`
    SELECT p.id, p.slug, p.name, p.prorata_grace_weeks AS grace, p.session_count, p.pricing_model,
           -- ::text, never the raw column. node-postgres hands a date back as a
           -- JS Date, and String()-ing that yields "Mon Jul 20 2026 ...", which
           -- is not an ISO day and silently breaks every calculation below.
           t.start_date::text AS start_date, t.end_date::text AS end_date,
           t.term_number, t.year,
           (SELECT min(full_price_cents) FROM program_options o
             WHERE o.program_id = p.id AND o.is_active) AS price_cents
      FROM programs p
      LEFT JOIN terms t ON t.id = p.term_id
     WHERE p.slug = 'u4-u8'
       AND p.organization_id = (SELECT id FROM organizations WHERE slug = 'christchurch-united')`);
  check(target.rows.length === 1, "exactly one CUFC u4-u8 programme");
  const u = target.rows[0];
  check(u?.grace === 5, `u4-u8 grace weeks = 5 (got ${u?.grace})`);

  // 2. Nobody else moved. This is the guard against a wildcard UPDATE.
  const others = await db.query(
    `SELECT id, slug, prorata_grace_weeks AS grace FROM programs
      WHERE prorata_grace_weeks <> 0 AND NOT (slug = 'u4-u8'
        AND organization_id = (SELECT id FROM organizations WHERE slug = 'christchurch-united'))`);
  check(others.rows.length === 0,
    `no other programme has a grace period (found ${others.rows.length}${others.rows.length ? ": " + others.rows.map((r: any) => r.slug).join(", ") : ""})`);

  const tech = await db.query(
    `SELECT prorata_grace_weeks AS grace FROM programs WHERE slug = 'technification'`);
  check(tech.rows.every((r: any) => r.grace === 0), "Technification still pro-rates from day one (grace 0)");

  // 3. What a parent is actually quoted, from the real term row + real price.
  if (u?.start_date && u?.end_date && u?.price_cents) {
    const startIso = String(u.start_date).slice(0, 10);
    const endIso = String(u.end_date).slice(0, 10);
    const sessions = u.session_count ?? 10;
    const price = Number(u.price_cents);
    console.log(`\n  Term ${u.year} T${u.term_number}: ${startIso} → ${endIso}, ${sessions} sessions, ${money(price)}\n`);
    console.log("   week  date        before      after");

    let weekOneToFiveAllFull = true;
    let weekSixProrated = false;
    for (let week = 1; week <= 8; week++) {
      const day = plusDays(startIso, (week - 1) * 7);
      const before = termProgress(day, startIso, endIso, sessions, 0);
      const after = termProgress(day, startIso, endIso, sessions, u.grace);
      if (!before || !after) continue;
      const bC = prorateTermPriceCents(price, before.chargeableSessions, before.totalSessions);
      const aC = prorateTermPriceCents(price, after.chargeableSessions, after.totalSessions);
      console.log(`   ${String(week).padStart(4)}  ${day}  ${money(bC).padStart(8)}  ${money(aC).padStart(9)}${week === 6 ? "   ← pro-rata starts" : ""}`);
      if (week <= 5 && aC !== price) weekOneToFiveAllFull = false;
      if (week === 6 && aC === Math.round(price / 2)) weekSixProrated = true;
    }
    console.log("");
    check(weekOneToFiveAllFull, `weeks 1–5 all quote the full ${money(price)}`);
    check(weekSixProrated, `week 6 quotes half (${money(Math.round(price / 2))})`);
  } else {
    check(false, "u4-u8 has a bound term and an active priced option");
  }

  if (missing > 0) {
    console.error(`\n✗ ${missing} check(s) failed — rolling back.\n`);
    await db.query("ROLLBACK");
    process.exitCode = 1;
  } else if (APPLY) {
    await db.query("COMMIT");
    console.log("\n✓ Applied.\n");
  } else {
    await db.query("ROLLBACK");
    console.log("\n✓ Rehearsal passed — rolled back. Re-run with --apply to commit.\n");
  }
} catch (e) {
  await db.query("ROLLBACK").catch(() => {});
  console.error(e);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
