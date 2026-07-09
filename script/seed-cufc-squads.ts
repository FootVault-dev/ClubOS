// Seed Christchurch United's squads for a season. Idempotent on (org, season, name).
//
//   npx tsx --env-file=.env script/seed-cufc-squads.ts            # dry run
//   npx tsx --env-file=.env script/seed-cufc-squads.ts --commit   # writes
//
// Run AFTER migrations/2026-07-10_club_squads.sql.
//
// The eleven teams below are the club's OWN published list, verbatim from
// apps/cufc-website/src/site.ts → TEAMS_PAGE. Nothing is invented.
//
// ⚠ `context/business-info.md` says the U13–U17 group is "2× U13, 1× U14, 1× U15,
//   1× U17" — i.e. the club fields TWO U13 sides, but only one is named publicly.
//   Rather than guess the second one's name ("U13 Blue"? "U13B"?), it is left out.
//   Add it in /admin/squads, which takes ten seconds and gets the name right.
//
// Rosters are NOT seeded. Who plays for which team is the coaches' knowledge,
// not something to be inferred from a registration list.

import { Pool } from "pg";

const COMMIT = process.argv.includes("--commit");
const ORG_SLUG = "christchurch-united";
const SEASON = 2026;

type SquadSeed = {
  name: string;
  ageGrade: number | null;   // NZF grade; null = senior, no age limit
  band: "senior" | "academy" | "youth";
  competition: string;
};

// Ordered exactly as the club lists them: First Team at the top, U9s at the foot.
const SQUADS: SquadSeed[] = [
  { name: "First Team",       ageGrade: null, band: "senior",  competition: "Southern League" },
  { name: "NXT (U20)",        ageGrade: 20,   band: "senior",  competition: "Development" },
  { name: "Third XI",         ageGrade: null, band: "senior",  competition: "Senior football" },
  { name: "U17 Academy",      ageGrade: 17,   band: "academy", competition: "Academy" },
  { name: "U15 Academy",      ageGrade: 15,   band: "academy", competition: "Academy" },
  { name: "U14 Academy",      ageGrade: 14,   band: "academy", competition: "Academy" },
  { name: "U13 Academy",      ageGrade: 13,   band: "academy", competition: "Academy" },
  { name: "U12 Pre-Academy",  ageGrade: 12,   band: "youth",   competition: "Pre-Academy" },
  { name: "U11 Pre-Academy",  ageGrade: 11,   band: "youth",   competition: "Pre-Academy" },
  { name: "U10 Pre-Academy",  ageGrade: 10,   band: "youth",   competition: "Pre-Academy" },
  { name: "U9s",              ageGrade: 9,    band: "youth",   competition: "Pre-Academy entry" },
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

try {
  const org = await pool.query("SELECT id, name FROM organizations WHERE slug = $1", [ORG_SLUG]);
  if (org.rows.length === 0) throw new Error(`No organisation with slug '${ORG_SLUG}'`);
  const orgId: number = org.rows[0].id;
  console.log(`${org.rows[0].name} (org ${orgId}) — season ${SEASON}\n`);
  if (!COMMIT) console.log("DRY RUN — nothing will be written. Re-run with --commit.\n");

  let order = 1;
  for (const s of SQUADS) {
    const existing = await pool.query(
      "SELECT id FROM club_squads WHERE organization_id = $1 AND season_year = $2 AND lower(name) = lower($3)",
      [orgId, SEASON, s.name],
    );
    const grade = s.ageGrade === null ? "senior" : `U${s.ageGrade}`;
    if (existing.rows.length) {
      console.log(`= ${s.name.padEnd(18)} exists (id ${existing.rows[0].id})`);
      order++;
      continue;
    }
    console.log(`+ ${s.name.padEnd(18)} ${grade.padEnd(7)} [${s.band}]  ${s.competition}`);
    if (!COMMIT) { order++; continue; }
    await pool.query(
      `INSERT INTO club_squads (organization_id, name, age_grade, season_year, competition, band, display_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [orgId, s.name, s.ageGrade, SEASON, s.competition, s.band, order++],
    );
  }

  console.log("\n" + "─".repeat(70));
  console.log(
    COMMIT
      ? "Seeded. Rosters are empty — coaches add players in /admin/squads.\n" +
        "⚠ business-info.md says there are TWO U13 sides; only one is named publicly.\n" +
        "  Add the second in the UI so the name is right."
      : "Dry run complete. Re-run with --commit.",
  );
} finally {
  await pool.end();
}
