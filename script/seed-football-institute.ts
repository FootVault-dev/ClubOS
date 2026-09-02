/**
 * Football Institute → an Academy programme.
 *
 *   npx tsx --env-file=.env script/seed-football-institute.ts            # dry run
 *   npx tsx --env-file=.env script/seed-football-institute.ts --commit
 *
 * WHY
 * ---
 * The Institute had its own top-level tab holding a single application. Daniel
 * asked for it to become one more programme in the Academy so it sits with
 * everything else and gets the ordinary programme view.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * 🔴 It does NOT move the application out of `football_institute_applications`.
 * That row carries year level, playing position, current school, current club,
 * student email, video URL and intake year — none of which the waitlist has
 * columns for. Deleting it to "migrate" would throw away most of what a coach
 * would want to read. The application table stays the record; the waitlist row
 * is how that person shows up ON the programme.
 *
 * 🔴 It invents nothing. No price, no age band, no capacity — the Institute is
 * a secondary-school partnership organised by year level, and a made-up U13–U17
 * would be a claim nobody made. With no `program_options` row and
 * registration_open false, the programme cannot be bought.
 *
 * Idempotent: re-running adopts the existing programme and skips any applicant
 * already mirrored, so it is safe to run after each new application.
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const ORG_ID = 1; // christchurch-united
const SLUG = "football-institute";

type App = {
  id: number;
  applicant_name: string;
  year_level: string | null;
  position: string | null;
  current_school: string | null;
  current_club: string | null;
  parent_name: string | null;
  email: string;
  phone: string | null;
  student_email: string | null;
  video_url: string | null;
  intake_year: number | null;
  status: string;
  created_at: string | Date;
};

/** `db.execute(sql.raw(...))` returns a timestamp as a STRING, not a Date, so
 *  normalise before formatting — reading it as a Date threw on the first run. */
function isoOf(v: string | Date): string {
  return (v instanceof Date ? v.toISOString() : String(v).replace(" ", "T"));
}

/** Everything the waitlist has no column for, kept verbatim in `notes`. */
function noteFor(a: App): string {
  const bits = [
    a.year_level && `Year level: ${a.year_level}`,
    a.position && `Position: ${a.position}`,
    a.current_school && `School: ${a.current_school}`,
    a.current_club && `Club: ${a.current_club}`,
    a.student_email && `Student email: ${a.student_email}`,
    a.video_url && `Video: ${a.video_url}`,
    a.intake_year && `Intake year: ${a.intake_year}`,
  ].filter(Boolean);
  return [
    `Football Institute application #${a.id} (${a.status}), submitted ${isoOf(a.created_at).slice(0, 10)}.`,
    ...bits,
    "Full application: Academy → Football Institute, or the football_institute_applications record.",
  ].join("\n");
}

/** A person's name arrives as one string; split on the LAST space so a
 *  multi-word first name ("Sean Jovens") stays intact. */
function splitName(full: string): { first: string; last: string } {
  const t = (full ?? "").trim().replace(/\s+/g, " ");
  if (!t) return { first: "Unknown", last: "Applicant" };
  const i = t.lastIndexOf(" ");
  return i === -1 ? { first: t, last: "—" } : { first: t.slice(0, i), last: t.slice(i + 1) };
}

async function main() {
  console.log(`\nFootball Institute → Academy programme  [${COMMIT ? "COMMIT" : "DRY RUN"}]\n`);

  const apps = ((await db.execute(
    sql.raw(`SELECT * FROM football_institute_applications WHERE organization_id = ${ORG_ID} ORDER BY id`),
  )) as any).rows as App[];
  console.log(`  ${apps.length} application(s) on file.`);

  await db.execute(sql.raw("BEGIN"));
  try {
    // ── the programme ────────────────────────────────────────────────────────
    const existing = ((await db.execute(
      sql.raw(`SELECT id, name FROM programs WHERE slug = '${SLUG}' AND organization_id = ${ORG_ID}`),
    )) as any).rows;

    let programId: number;
    if (existing.length) {
      programId = existing[0].id;
      console.log(`  · programme already exists (id ${programId}) — adopting it`);
    } else {
      const ins = ((await db.execute(
        sql.raw(`
          INSERT INTO programs (name, slug, type, organization_id, is_active, registration_open,
                                academy_section, description, contact_email)
          VALUES ('Football Institute', '${SLUG}', 'academy', ${ORG_ID}, true, false,
                  'additional',
                  'Christchurch United × Ao Tawhiti Unlimited Discovery. Secondary-school football programme; entry is by application, organised by year level rather than age grade.',
                  'academy@cufc.co.nz')
          RETURNING id
        `),
      )) as any).rows;
      programId = ins[0].id;
      console.log(`  + programme created (id ${programId})`);
      console.log(`      registration_open = false, no program_options → cannot be bought`);
      console.log(`      age band + capacity left NULL on purpose (year-level programme)`);
    }

    // ── one waitlist row per application, so the applicant shows on it ───────
    let added = 0;
    let skipped = 0;
    for (const a of apps) {
      const dup = ((await db.execute(
        sql.raw(`SELECT id FROM academy_waitlist
                 WHERE program_id = ${programId} AND lower(email) = lower('${a.email.replace(/'/g, "''")}')`),
      )) as any).rows;
      if (dup.length) {
        skipped++;
        console.log(`  · ${a.applicant_name} — already on the programme, left alone`);
        continue;
      }
      const { first, last } = splitName(a.applicant_name);
      const esc = (v: string | null) => (v == null ? "NULL" : `'${v.replace(/'/g, "''")}'`);
      await db.execute(
        sql.raw(`
          INSERT INTO academy_waitlist
            (organization_id, program_id, season_year, child_first_name, child_last_name,
             guardian_name, email, phone, notes, status, created_at)
          VALUES (${ORG_ID}, ${programId}, ${a.intake_year ?? "NULL"},
                  ${esc(first)}, ${esc(last)},
                  ${esc(a.parent_name ?? a.applicant_name)}, ${esc(a.email)},
                  ${esc(a.phone ?? "")}, ${esc(noteFor(a))}, 'waiting',
                  '${isoOf(a.created_at)}')
        `),
      );
      added++;
      console.log(`  + ${a.applicant_name} → programme waitlist (submitted ${isoOf(a.created_at).slice(0, 10)})`);
    }

    // ── prove it before committing ──────────────────────────────────────────
    const check = ((await db.execute(
      sql.raw(`
        SELECT p.id, p.name, p.is_active, p.registration_open,
               (SELECT count(*) FROM academy_waitlist w WHERE w.program_id = p.id)::int AS waitlist,
               (SELECT count(*) FROM program_options o WHERE o.program_id = p.id AND o.is_active)::int AS buyable
        FROM programs p WHERE p.id = ${programId}
      `),
    )) as any).rows[0];

    const problems: string[] = [];
    if (!check.is_active) problems.push("programme is not active — it will not appear in Academy");
    if (check.registration_open) problems.push("registration_open is TRUE — it would be publicly sellable");
    if (check.buyable > 0) problems.push(`${check.buyable} active program_options — it would have a price`);
    if (check.waitlist !== apps.length) problems.push(`${check.waitlist} on the programme vs ${apps.length} applications`);

    console.log(`\n  programme ${check.id} "${check.name}" · active=${check.is_active} · registration_open=${check.registration_open} · on programme=${check.waitlist} · buyable options=${check.buyable}`);
    console.log(`  ${added} added, ${skipped} already there`);

    if (problems.length) {
      console.log("\n  ✗ refusing to commit:");
      for (const p of problems) console.log(`      • ${p}`);
      await db.execute(sql.raw("ROLLBACK"));
      process.exit(1);
    }

    if (COMMIT) {
      await db.execute(sql.raw("COMMIT"));
      console.log("\n  ✓ committed\n");
    } else {
      await db.execute(sql.raw("ROLLBACK"));
      console.log("\n  ✓ dry run rolled back — re-run with --commit to apply\n");
    }
  } catch (e) {
    await db.execute(sql.raw("ROLLBACK"));
    throw e;
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
