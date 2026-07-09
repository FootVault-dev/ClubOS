// Seed CUFC's academy programmes as DRAFTS. Idempotent (keyed on slug).
//
//   npx tsx --env-file=.env script/seed-cufc-academy.ts            # dry run, prints the plan
//   npx tsx --env-file=.env script/seed-cufc-academy.ts --commit   # writes
//
// Run AFTER migrations/2026-07-09_academy_registrations.sql.
//
// ─── PRICES: WHERE EACH NUMBER COMES FROM ───────────────────────────────────
// Daniel authorised launching with the club's published fees (2026-07-09). Every
// price below is quoted from a source, never inferred. `null` = no trustworthy
// source, so that programme ships CLOSED with a waitlist rather than a guess.
//
//   FUNiño U4–U8          $160/term   LIVE Friendly Manager form 6 ("U4–U8 Fun
//                                     Football 2026") + old site + new site copy
//                                     + context/business-info.md. Four sources.
//   Technification U9–U12 $150/term   LIVE Friendly Manager form 9
//                                     ("Technification U9–U12 2026, Term 3").
//   Pre-Academy U9–U10    $405/term   old site /u9-u12-academy-program:
//                                     "U9-U10: $1620 per year or $405 per term"
//   Pre-Academy U11–U12   $540/term   same page: "$2160 per year or $540 per term"
//   Academy U13–U15       $805/term   old site /u13-u20-academy-program, under a
//                                     "U13-U15" heading: "$3220/yr or $805/term"
//   Academy U17           $882/term   same page, under an "U17" heading:
//                                     "$3528 per year or $882 per term"
//                                     (there is no U16 — the club runs 2×U13,
//                                      U14, U15, U17)
//   Morning U13–U20       $125/term   old site /morning-programme
//
//   Goalkeeper            NO PRICE.   The "$125 (10 Sessions)" line on
//                                     /goalkeeper-programs sits under a heading
//                                     reading "Technification Program – Term 1",
//                                     and the live FM form prices Technification
//                                     at $150. That $125 is not a goalkeeper fee.
//   High Performance      NO PRICE.   /u17u20-high-performance-academy says
//                                     "$600 per term"; /u13-u20-academy-program
//                                     says U17 is "$882 per term". Two club pages
//                                     contradict each other.
//
// ⚠ NOT COLLECTED AT CHECKOUT, and not invented here: the Affiliation Fee
//   ($58.08–$64.16 depending on grade), MF levies, and the compulsory uniform
//   (~$260 for High Performance). The old site lists these as separate line
//   items marked "TBC" on the academy pages. If the club expects them with the
//   term fee, the checkout currently UNDER-COLLECTS. Raise with Ryan before the
//   first Academy/Pre-Academy registration.
//
// The 5% full-year discount is a 2026 policy addition — the old site's yearly
// figures are exactly 4× the term fee with no discount ($405×4 = $1,620). Our
// year price is 4× term − 5%, per the current published policy.
//
// A programme still only sells when: is_active AND registration_open AND it has
// an active option with full_price_cents > 0. Re-run this script any time; it is
// idempotent on slug and never touches a programme that already exists.

import { Pool } from "pg";

const COMMIT = process.argv.includes("--commit");
const ORG_SLUG = "christchurch-united";
const SEASON = 2026;

type OptionSeed = { name: string; scheduleText: string | null; termPriceCents: number | null };
type ProgrammeSeed = {
  slug: string;
  name: string;
  section: "core" | "additional";
  ageMin: number;
  ageMax: number;
  descriptionShort: string;
  /** Priced bands. A null price means no trustworthy source exists. */
  options: OptionSeed[];
  allowFullYear: boolean; // informational; the API derives this from `section` + term
  /** false = ships CLOSED with a waitlist because no fee could be sourced.
   *  Forced false anyway if any option lacks a price. */
  open: boolean;
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
    options: [{ name: "U4–U8", scheduleText: "Weekdays + Saturday · unlimited sessions", termPriceCents: 16_000 }],
    allowFullYear: true,
    open: true,
  },
  {
    slug: "pre-academy-u9-u12",
    name: "Pre-Academy",
    section: "core",
    ageMin: 9,
    ageMax: 12,
    descriptionShort: "Three trainings a week plus a Saturday game. 7-a-side at U9–U10, 9-a-side at U11–U12.",
    options: [
      { name: "U9–U10", scheduleText: "Tue + Thu 5:45–6:45pm · Saturday game", termPriceCents: 40_500 },
      { name: "U11–U12", scheduleText: "Tue + Thu 5:45–7:00pm · Saturday game", termPriceCents: 54_000 },
    ],
    allowFullYear: true,
    open: true,
  },
  {
    slug: "academy-u13-u17",
    name: "Academy",
    section: "core",
    ageMin: 13,
    ageMax: 17,
    descriptionShort: "Four trainings a week, 11-a-side, competitive league football.",
    // The club runs 2×U13, U14, U15 and U17 teams — there is no U16 grade, which
    // is why the fee table splits U13–U15 from U17 with nothing in between.
    options: [
      { name: "U13–U15", scheduleText: "Mon, Tue, Thu 4:00–5:30pm", termPriceCents: 80_500 },
      { name: "U17", scheduleText: "Mon, Tue, Thu 4:00–5:30pm", termPriceCents: 88_200 },
    ],
    allowFullYear: true,
    open: true,
  },
  {
    slug: "high-performance-u17-u20",
    name: "High Performance Academy",
    section: "core",
    ageMin: 17,
    ageMax: 20,
    descriptionShort: "Five trainings a week. The last step before the first team.",
    // ⚑ CLOSED. /u17u20-high-performance-academy says $600/term; the Academy page
    //   prices U17 at $882/term. Two club pages contradict each other, and this
    //   programme also carries a $260 uniform fee we do not collect. Ryan decides.
    options: [{ name: "U17–U20", scheduleText: "5 trainings/week · 90 min · 11-a-side", termPriceCents: null }],
    allowFullYear: true,
    open: false,
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
      { name: "U9–U10", scheduleText: "Mondays", termPriceCents: 15_000 },
      { name: "U11–U12", scheduleText: "Mondays", termPriceCents: 15_000 },
    ],
    allowFullYear: false,
    open: true,
  },
  {
    slug: "gk-programme",
    name: "Goalkeeper Programme",
    section: "additional",
    ageMin: 9,
    ageMax: 20,
    descriptionShort: "Specialist goalkeeping coaching, split by age.",
    // ⚑ CLOSED. The only figure anywhere ("$125, 10 Sessions") sits under a
    //   "Technification Program – Term 1" heading on the goalkeeper page, and the
    //   live FM form prices Technification at $150. It is not a goalkeeper fee.
    options: [
      { name: "U9–U12", scheduleText: "Mondays 5:45–6:30pm", termPriceCents: null },
      { name: "U13–U20", scheduleText: "Tuesdays 5:45–6:30pm", termPriceCents: null },
    ],
    allowFullYear: false,
    open: false,
  },
  {
    slug: "morning-programme-u13-u20",
    name: "Morning Programme",
    section: "additional",
    ageMin: 13,
    ageMax: 20,
    descriptionShort: "Extra morning sessions for academy players.",
    options: [{ name: "U13–U20", scheduleText: "Mornings", termPriceCents: 12_500 }],
    allowFullYear: false,
    open: true,
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

    // Belt and braces: a programme can never be opened without a real price, no
    // matter what the table above says. The API enforces the same rule.
    const priced = p.options.every((o) => typeof o.termPriceCents === "number" && o.termPriceCents > 0);
    const willOpen = p.open && priced;
    if (p.open && !priced) {
      console.log(`! ${p.slug.padEnd(28)} marked open but an option has no price — forcing CLOSED`);
    }

    const state = willOpen ? "OPEN, live" : "CLOSED, waitlist";
    console.log(`+ ${p.slug.padEnd(28)} ${p.name}  [${p.section}]  U${p.ageMin}–U${p.ageMax}  → ${state}`);
    for (const o of p.options) {
      const price = o.termPriceCents === null ? "no price — needs Ryan" : `$${(o.termPriceCents / 100).toFixed(2)}/term`;
      console.log(`    · ${o.name.padEnd(12)} ${price}${o.scheduleText ? `  (${o.scheduleText})` : ""}`);
    }

    if (!COMMIT) continue;

    const prog = await pool.query(
      `INSERT INTO programs
         (organization_id, name, slug, type, academy_section, season_year,
          description_short, age_min, age_max, schedule_type, term_id,
          session_count, pricing_model, is_active, registration_open)
       VALUES ($1,$2,$3,'academy',$4,$5,$6,$7,$8,'term',$9,10,'term_prorated',true,$10)
       RETURNING id`,
      [orgId, p.name, p.slug, p.section, SEASON, p.descriptionShort, p.ageMin, p.ageMax, termId, willOpen],
    );
    const programId: number = prog.rows[0].id;

    let order = 0;
    for (const o of p.options) {
      // An unpriced option is stored inactive at $0 so the admin has a row to
      // fill in, and the public API's `full_price_cents > 0` gate keeps it unsellable.
      await pool.query(
        `INSERT INTO program_options
           (program_id, name, schedule_text, full_price_cents, pricing_model,
            session_count, allow_pay_weekly, display_order, is_active)
         VALUES ($1,$2,$3,$4,'term_prorated',10,false,$5,$6)`,
        [programId, o.name, o.scheduleText, o.termPriceCents ?? 0, order++, o.termPriceCents !== null],
      );
    }
  }

  console.log("\n" + "─".repeat(72));
  if (COMMIT) {
    console.log("Seeded.");
    console.log("  OPEN now:   FUNiño $160 · Pre-Academy $405/$540 · Academy $805/$882 ·");
    console.log("              Technification $150 · Morning $125   (all per term, pro-rated");
    console.log("              if the term has already started)");
    console.log("  CLOSED:     Goalkeeper, High Performance — no trustworthy fee exists.");
    console.log("              Both take waitlist signups. Add a price in /admin/academy,");
    console.log("              activate the option, tick 'Registrations open'.");
    console.log("");
    console.log("  ⚠ Affiliation fees, MF levies and uniform are NOT collected at checkout.");
    console.log("    If the club expects them with the term fee, we are under-collecting.");
  } else {
    console.log("Dry run complete. Re-run with --commit to write.");
  }
}

try {
  await main();
} finally {
  await pool.end();
}
