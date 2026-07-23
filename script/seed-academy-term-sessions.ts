// Generate the weekly training sessions for a term-bound academy programme.
//
//   Rehearse:  npx tsx --env-file=.env script/seed-academy-term-sessions.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/seed-academy-term-sessions.ts
//   Other:     ... --program 16
//
// Idempotent on the natural key (camp_id, date, start_time): re-running adds
// only what is genuinely missing, so it is safe to run again after Daniel edits
// a slot. It NEVER deletes a session — a session with attendance already
// recorded against it is a record of who turned up, not a draft.
//
// Capacity is deliberately left NULL. Nobody has told us how many children fit
// in a FUNiño session, and a made-up 20 would drive a real "FULL" badge on the
// Sessions tab and could turn a family away. Daniel sets it per slot when he
// knows it.
import { Pool } from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const argIdx = process.argv.indexOf("--program");
const PROGRAM_ID = argIdx > -1 ? parseInt(process.argv[argIdx + 1]) : 4;

// Daniel's schedule, in his words:
//   "Monday-Friday everyday 4:30pm-5:15pm
//    Saturday U4-U6 9:30am-10:15am & U7-U8 10:30am-11:15am"
// Sun=0 … Sat=6.
const SLOTS: { daysOfWeek: number[]; startTime: string; endTime: string; name: string | null }[] = [
  { daysOfWeek: [1, 2, 3, 4, 5], startTime: "16:30", endTime: "17:15", name: null },
  { daysOfWeek: [6], startTime: "09:30", endTime: "10:15", name: "U4–U6" },
  { daysOfWeek: [6], startTime: "10:30", endTime: "11:15", name: "U7–U8" },
];

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Dates are walked and emitted as plain calendar parts. Never round-trip an ISO
// date through toISOString() — in NZ (UTC+12) that reads a day early.
const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const db = await pool.connect();

try {
  // ::text on every date — node-postgres hydrates a `date` column into a JS
  // Date at local midnight, and every later read of it is one timezone slip
  // away from being a day out. Dates stay strings end to end.
  const { rows: [program] } = await db.query(
    `SELECT p.id, p.name, p.slug, p.schedule_type, p.term_id, t.name AS term_name, t.year,
            t.term_number, t.start_date::text AS start_date, t.end_date::text AS end_date
       FROM programs p LEFT JOIN terms t ON t.id = p.term_id
      WHERE p.id = $1`, [PROGRAM_ID]);

  if (!program) throw new Error(`No programme with id ${PROGRAM_ID}`);
  if (program.schedule_type !== "term") throw new Error(`${program.name} is not a term programme`);
  if (!program.term_id) throw new Error(`${program.name} is not linked to a term — set one in the Overview tab first`);

  console.log(`\n${program.name}  (/${program.slug})`);
  console.log(`${program.term_name} ${program.year}: ${program.start_date} → ${program.end_date}\n`);

  // Build the full set of (date, slot) pairs the pattern implies.
  const wanted: { date: string; dow: number; slot: typeof SLOTS[number] }[] = [];
  const end = parse(program.end_date);
  const cursor = parse(program.start_date);
  while (cursor <= end) {
    const dow = cursor.getDay();
    for (const slot of SLOTS) {
      if (slot.daysOfWeek.includes(dow)) wanted.push({ date: iso(cursor), dow, slot });
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  const { rows: existing } = await db.query(
    `SELECT date::text AS date, start_time FROM camp_dates WHERE camp_id = $1`, [PROGRAM_ID]);
  const seen = new Set(existing.map(r => `${r.date}|${(r.start_time ?? "").slice(0, 5)}`));

  const toCreate = wanted.filter(w => !seen.has(`${w.date}|${w.slot.startTime}`));

  // Summarise by weekday so the shape is eyeballable before it is written.
  const byDay = new Map<string, number>();
  for (const w of wanted) {
    const key = `${DOW[w.dow]} ${w.slot.startTime}–${w.slot.endTime}${w.slot.name ? `  ${w.slot.name}` : ""}`;
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  for (const [k, n] of byDay) console.log(`  ${k.padEnd(34)} × ${n}`);

  const weeks = new Set(wanted.map(w => {
    const d = parse(w.date);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // back to Monday
    return iso(d);
  }));

  console.log(`\n  ${wanted.length} sessions across ${weeks.size} weeks`);
  console.log(`  ${existing.length} already on file · ${toCreate.length} to create\n`);

  if (toCreate.length === 0) {
    console.log("Nothing to do — every session in the pattern already exists.\n");
  } else if (DRY_RUN) {
    console.log("DRY RUN — nothing written. First 5 and last 3:");
    for (const w of [...toCreate.slice(0, 5), null, ...toCreate.slice(-3)]) {
      if (!w) { console.log("    …"); continue; }
      console.log(`    ${w.date} ${DOW[w.dow]}  ${w.slot.startTime}–${w.slot.endTime}  ${w.slot.name ?? ""}`);
    }
    console.log("\nRe-run without --dry-run to write them.\n");
  } else {
    await db.query("BEGIN");
    for (const w of toCreate) {
      await db.query(
        `INSERT INTO camp_dates (camp_id, date, start_time, end_time, name,
                                 capacity_full_day, capacity_morning, capacity_afternoon)
         VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL)`,
        [PROGRAM_ID, w.date, w.slot.startTime, w.slot.endTime, w.slot.name],
      );
    }
    // Remember the pattern so the Schedule tab opens on it next term.
    await db.query(`UPDATE programs SET weekly_pattern_json = $1 WHERE id = $2`,
      [JSON.stringify(SLOTS.map(s => ({ ...s, capacity: null }))), PROGRAM_ID]);
    await db.query("COMMIT");

    const { rows: [after] } = await db.query(
      `SELECT count(*)::int AS n FROM camp_dates WHERE camp_id = $1`, [PROGRAM_ID]);
    console.log(`Created ${toCreate.length}. Programme now has ${after.n} sessions.\n`);
  }
} catch (e) {
  await db.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  db.release();
  await pool.end();
}
