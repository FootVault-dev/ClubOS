// Seed CUFC's academy programmes as DRAFTS. Idempotent (keyed on slug).
//
//   npx tsx --env-file=.env script/seed-cufc-academy.ts            # dry run, prints the plan
//   npx tsx --env-file=.env script/seed-cufc-academy.ts --commit   # writes
//
// Run AFTER migrations/2026-07-09_academy_registrations.sql.
//
// ─── WHY EVERY PROGRAMME LANDS SWITCHED OFF ─────────────────────────────────
// The club's Membership & Payment Policy 2026 says: "Fees published in the
// official printed fee schedule held at the CUFC office shall prevail over all
// other communications." That schedule is NOT in this repo, and the three
// sources that do exist disagree with each other:
//
//     Programme        old cufc.co.nz    new site copy   internal model
//     FUNiño U4–U8     $160/term         $160/term       $160/term
//     Pre-Ac U9–U10    $405/term         "from $400"     ~$400
//     Pre-Ac U11–U12   $540/term         "from $400"     $450–500
//     Academy U13–U17  $805/term         "from $700"     $700–800
//     Technification   $150/term         $150/term       —
//     Goalkeeper       $125/10 sessions  not listed      —
//
// So this script writes ZERO prices. Each programme is created with
// `isActive = false`, `registrationOpen = false`, and its options priced at 0
// and marked inactive. The public API refuses to sell a programme unless it is
// active AND registration_open AND has an active option with a positive price —
// so no parent can be charged a number nobody confirmed.
//
// To go live: /admin/academy → open a programme → enter the real fee on each
// option, activate the options, then tick the programme active + registrations
// open. Only the GM (Ryan Edwards) may approve fees per the policy.
//
// Structure comes from evidenced sources, not invention:
//   • programme names + age bands → apps/cufc-website/src/site.ts (NAV, PROGRAMMES)
//   • the core/additional split   → server/seed.ts's existing classifier
//     (technification% / gk-% / %goalkeeper% / %technification% ⇒ 'additional')
//   • the price BANDS inside each programme (why options exist at all) →
//     outputs/cufc-tilda-archive/pages/*.md, which price U9–U10 apart from
//     U11–U12, and show two Academy tiers.
//   • Goalkeeper day/times → news-archive.json (U9–U12 Mon 5:45–6:30pm,
//     U13–U20 Tue 5:45–6:30pm)

import { Pool } from "pg";

const COMMIT = process.argv.includes("--commit");
const ORG_SLUG = "christchurch-united";
const SEASON = 2026;

type OptionSeed = { name: string; scheduleText: string | null };
type ProgrammeSeed = {
  slug: string;
  name: string;
  section: "core" | "additional";
  ageMin: number;
  ageMax: number;
  descriptionShort: string;
  /** Priced bands. Real fees are entered by a human in /admin/academy. */
  options: OptionSeed[];
  allowFullYear: boolean; // informational; the API derives this from `section`
};

const PROGRAMMES: ProgrammeSeed[] = [
  // ── Core pathway ──────────────────────────────────────────────────────────
  {
    slug: "funino-u4-u8",
    name: "FUNiño — First Kicks",
    section: "core",
    ageMin: 4,
    ageMax: 8,
    descriptionShort: "Where it starts. Small-sided games, lots of touches, every child on the ball.",
    options: [{ name: "U4–U8", scheduleText: null }],
    allowFullYear: true,
  },
  {
    slug: "pre-academy-u9-u12",
    name: "Pre-Academy",
    section: "core",
    ageMin: 9,
    ageMax: 12,
    descriptionShort: "Three trainings a week plus a Saturday game. 7-a-side at U9–U10, 9-a-side at U11–U12.",
    // Two bands because the old site priced them apart ($405 vs $540 per term).
    options: [
      { name: "U9–U10", scheduleText: "3 trainings/week · 60 min · 7-a-side" },
      { name: "U11–U12", scheduleText: "3 trainings/week · 75 min · 9-a-side" },
    ],
    allowFullYear: true,
  },
  {
    slug: "academy-u13-u17",
    name: "Academy",
    section: "core",
    ageMin: 13,
    ageMax: 17,
    descriptionShort: "Four trainings a week, 11-a-side, competitive league football.",
    // The old site showed two Academy fee tiers ($805 and $882 per term). Which
    // ages fall in which tier is NOT documented anywhere — confirm with the
    // office before pricing these.
    options: [
      { name: "Academy — tier 1 ⚑ confirm which ages", scheduleText: "4 trainings/week · 90 min · 11-a-side" },
      { name: "Academy — tier 2 ⚑ confirm which ages", scheduleText: "4 trainings/week · 90 min · 11-a-side" },
    ],
    allowFullYear: true,
  },
  {
    slug: "high-performance-u17-u20",
    name: "High Performance Academy",
    section: "core",
    ageMin: 17,
    ageMax: 20,
    descriptionShort: "Five trainings a week. The last step before the first team.",
    options: [{ name: "U17–U20", scheduleText: "5 trainings/week · 90 min · 11-a-side" }],
    allowFullYear: true,
  },

  // ── Additional programmes (no full-year discount — policy excludes them) ───
  {
    slug: "technification-u9-u12",
    name: "Technification",
    section: "additional",
    ageMin: 9,
    ageMax: 12,
    descriptionShort: "Monday technical training. An add-on to the pathway — all clubs welcome.",
    options: [
      { name: "U9–U10", scheduleText: "Mondays" },
      { name: "U11–U12", scheduleText: "Mondays" },
    ],
    allowFullYear: false,
  },
  {
    slug: "gk-programme",
    name: "Goalkeeper Programme",
    section: "additional",
    ageMin: 9,
    ageMax: 20,
    descriptionShort: "Specialist goalkeeping coaching, split by age.",
    options: [
      { name: "U9–U12", scheduleText: "Mondays 5:45–6:30pm" },
      { name: "U13–U20", scheduleText: "Tuesdays 5:45–6:30pm" },
    ],
    allowFullYear: false,
  },
  {
    slug: "morning-programme-u13-u20",
    name: "Morning Programme",
    section: "additional",
    ageMin: 13,
    ageMax: 20,
    descriptionShort: "Extra morning sessions for academy players.",
    options: [{ name: "U13–U20", scheduleText: null }],
    allowFullYear: false,
  },
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const org = await pool.query("SELECT id, name FROM organizations WHERE slug = $1", [ORG_SLUG]);
  if (org.rows.length === 0) throw new Error(`No organisation with slug '${ORG_SLUG}'`);
  const orgId: number = org.rows[0].id;
  console.log(`Organisation: ${org.rows[0].name} (id ${orgId})\n`);

  // Bind to the current term if the workspace has one. Not fatal if absent —
  // pro-rating simply won't kick in until a term is attached in /admin/terms.
  const term = await pool.query(
    "SELECT id, name, term_number, start_date, end_date FROM terms WHERE organization_id = $1 AND year = $2 ORDER BY term_number DESC LIMIT 1",
    [orgId, SEASON],
  );
  const termId: number | null = term.rows[0]?.id ?? null;
  if (termId) {
    const t = term.rows[0];
    console.log(`Binding to term: ${t.name ?? `Term ${t.term_number}`} ${SEASON} (${t.start_date} → ${t.end_date})\n`);
  } else {
    console.log(`⚠ No ${SEASON} term found for this org. Programmes will be created unbound —`);
    console.log(`  add terms in /admin/terms, then re-run to attach.\n`);
  }

  if (!COMMIT) {
    console.log("DRY RUN — nothing will be written. Re-run with --commit.\n");
  }

  for (const p of PROGRAMMES) {
    const existing = await pool.query("SELECT id, name FROM programs WHERE slug = $1", [p.slug]);

    if (existing.rows.length > 0) {
      console.log(`= ${p.slug.padEnd(28)} already exists (id ${existing.rows[0].id}) — left untouched`);
      continue;
    }

    console.log(`+ ${p.slug.padEnd(28)} ${p.name}  [${p.section}]  U${p.ageMin}–U${p.ageMax}`);
    for (const o of p.options) {
      console.log(`    · option: ${o.name}${o.scheduleText ? ` (${o.scheduleText})` : ""} — price $0.00, INACTIVE`);
    }

    if (!COMMIT) continue;

    const prog = await pool.query(
      `INSERT INTO programs
         (organization_id, name, slug, type, academy_section, season_year,
          description_short, age_min, age_max, schedule_type, term_id,
          session_count, pricing_model, is_active, registration_open)
       VALUES ($1,$2,$3,'academy',$4,$5,$6,$7,$8,'term',$9,10,'term_prorated',false,false)
       RETURNING id`,
      [orgId, p.name, p.slug, p.section, SEASON, p.descriptionShort, p.ageMin, p.ageMax, termId],
    );
    const programId: number = prog.rows[0].id;

    let order = 0;
    for (const o of p.options) {
      await pool.query(
        `INSERT INTO program_options
           (program_id, name, schedule_text, full_price_cents, pricing_model,
            session_count, allow_pay_weekly, display_order, is_active)
         VALUES ($1,$2,$3,0,'term_prorated',10,false,$4,false)`,
        [programId, o.name, o.scheduleText, order++],
      );
    }
  }

  console.log("\n" + "─".repeat(72));
  if (COMMIT) {
    console.log("Seeded. Every programme is INACTIVE with registrations CLOSED and $0 options.");
    console.log("Nothing can take a payment until a human enters the real fee schedule.");
    console.log("\nNext: /admin/academy → set each option's price → activate options →");
    console.log("      tick the programme active + registrations open.");
  } else {
    console.log("Dry run complete. Re-run with --commit to write.");
  }
}

try {
  await main();
} finally {
  await pool.end();
}
