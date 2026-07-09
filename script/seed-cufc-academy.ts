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
  /** Slugs this programme may already exist under in production. Adopted, not duplicated. */
  legacySlugs?: string[];
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
    // Already exists in prod as `u4-u8` (id 4), carrying term_price_cents=16000 —
    // a fifth independent confirmation of the $160 fee. Adopted, not duplicated.
    slug: "u4-u8",
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
    // Already exists in prod as `technification` (id 5), unpriced and unbound.
    slug: "technification",
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

function nzTodayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

async function main() {
  const org = await pool.query("SELECT id, name FROM organizations WHERE slug = $1", [ORG_SLUG]);
  if (org.rows.length === 0) throw new Error(`No organisation with slug '${ORG_SLUG}'`);
  const orgId: number = org.rows[0].id;
  console.log(`Organisation: ${org.rows[0].name} (id ${orgId})`);

  // Bind to the term that is CURRENT or NEXT — never a term that has already
  // finished. `u4-u8` was bound to Term 2, which ended on 3 July; a programme
  // bound to a dead term is unsellable (the API refuses, correctly).
  // Read the dates as text: a `date` column read through node-postgres comes
  // back as a Date at 12:00Z and renders a day early via toISOString().
  const today = nzTodayIso();
  const t = await pool.query(
    `SELECT id, term_number, start_date::text AS start_date, end_date::text AS end_date
       FROM terms WHERE organization_id = $1 AND year = $2 AND end_date::text >= $3
       ORDER BY term_number LIMIT 1`,
    [orgId, SEASON, today],
  );
  if (t.rows.length === 0) throw new Error(`No ${SEASON} term ends on or after ${today} — add terms in /admin/terms`);
  const term = t.rows[0];
  const termId: number = term.id;
  console.log(`Today (NZ): ${today}`);
  console.log(`Binding to: Term ${term.term_number} ${SEASON}  ${term.start_date} → ${term.end_date}`);
  console.log(
    today < term.start_date
      ? `            term hasn't started — everyone pays the full term fee\n`
      : `            term is under way — joins are pro-rated to the sessions left\n`,
  );

  if (!COMMIT) console.log("DRY RUN — nothing will be written. Re-run with --commit.\n");

  for (const p of PROGRAMMES) {
    // Belt and braces: a programme can never open without a real price on every
    // option, whatever the table above says. The public API enforces this too.
    const priced = p.options.every((o) => typeof o.termPriceCents === "number" && o.termPriceCents > 0);
    const willOpen = p.open && priced;
    if (p.open && !priced) console.log(`! ${p.slug} marked open but an option has no price — forcing CLOSED`);

    const candidates = [p.slug, ...(p.legacySlugs ?? [])];
    const found = await pool.query(
      "SELECT id, slug, name, is_active FROM programs WHERE organization_id = $1 AND slug = ANY($2)",
      [orgId, candidates],
    );

    const state = willOpen ? "OPEN" : "CLOSED (waitlist)";
    const verb = found.rows.length ? "adopt" : "create";
    console.log(`${verb === "adopt" ? "~" : "+"} ${p.slug.padEnd(26)} ${p.name.padEnd(26)} [${p.section}] U${p.ageMin}–U${p.ageMax}  → ${state}`);

    let programId: number;

    if (found.rows.length > 0) {
      programId = found.rows[0].id;
      console.log(`    adopting existing programme id ${programId} (slug '${found.rows[0].slug}')`);
      if (!COMMIT) { await reportOptions(programId, p); continue; }
      await pool.query(
        `UPDATE programs SET
           name = $2, academy_section = $3, season_year = $4, description_short = $5,
           age_min = $6, age_max = $7, schedule_type = 'term', term_id = $8,
           session_count = COALESCE(session_count, 10),
           pricing_model = 'term_prorated',
           is_active = true, registration_open = $9
         WHERE id = $1`,
        [programId, p.name, p.section, SEASON, p.descriptionShort, p.ageMin, p.ageMax, termId, willOpen],
      );
    } else {
      if (!COMMIT) { for (const o of p.options) printOption(o); continue; }
      const ins = await pool.query(
        `INSERT INTO programs
           (organization_id, name, slug, type, academy_section, season_year,
            description_short, age_min, age_max, schedule_type, term_id,
            session_count, pricing_model, is_active, registration_open)
         VALUES ($1,$2,$3,'academy',$4,$5,$6,$7,$8,'term',$9,10,'term_prorated',true,$10)
         RETURNING id`,
        [orgId, p.name, p.slug, p.section, SEASON, p.descriptionShort, p.ageMin, p.ageMax, termId, willOpen],
      );
      programId = ins.rows[0].id;
    }

    // Options: never add a second priced band next to one that already sells.
    const existingOpts = await pool.query(
      "SELECT id, name, full_price_cents, is_active FROM program_options WHERE program_id = $1",
      [programId],
    );
    const alreadySelling = existingOpts.rows.filter((o) => o.is_active && o.full_price_cents > 0);

    if (alreadySelling.length > 0) {
      console.log(`    keeping ${alreadySelling.length} existing priced option(s) — not duplicating:`);
      for (const o of alreadySelling) console.log(`      · ${o.name} — $${(o.full_price_cents / 100).toFixed(2)}/term`);
      continue;
    }

    let order = 0;
    for (const o of p.options) {
      printOption(o);
      if (!COMMIT) continue;
      // An unpriced option is stored inactive at $0 so the admin has a row to fill in;
      // the API's `full_price_cents > 0` gate keeps it unsellable meanwhile.
      await pool.query(
        `INSERT INTO program_options
           (program_id, name, schedule_text, full_price_cents, pricing_model,
            session_count, allow_pay_weekly, display_order, is_active)
         VALUES ($1,$2,$3,$4,'term_prorated',10,false,$5,$6)`,
        [programId, o.name, o.scheduleText, o.termPriceCents ?? 0, order++, o.termPriceCents !== null],
      );
    }
  }

  console.log("\n" + "─".repeat(74));
  if (COMMIT) {
    console.log("Done.");
    console.log("  OPEN:   FUNiño $160 · Pre-Academy $405/$540 · Academy $805/$882 ·");
    console.log("          Technification $150 · Morning $125   (per term; pro-rated once the");
    console.log("          term is under way)");
    console.log("  CLOSED: Goalkeeper, High Performance — no trustworthy fee exists. Both take");
    console.log("          waitlist signups. Price them in /admin/academy, activate the option,");
    console.log("          then tick 'Registrations open'.");
    console.log("");
    console.log("  ⚠ Affiliation fees, MF levies and uniform are NOT collected at checkout.");
    console.log("    If the club expects them with the term fee, we are under-collecting.");
  } else {
    console.log("Dry run complete. Re-run with --commit to write.");
  }
}

function printOption(o: OptionSeed) {
  const price = o.termPriceCents === null ? "NO PRICE — needs Ryan" : `$${(o.termPriceCents / 100).toFixed(2)}/term`;
  console.log(`      · ${o.name.padEnd(12)} ${price}${o.scheduleText ? `  (${o.scheduleText})` : ""}`);
}

async function reportOptions(programId: number, p: ProgrammeSeed) {
  const r = await pool.query("SELECT name, full_price_cents, is_active FROM program_options WHERE program_id = $1", [programId]);
  if (r.rows.length === 0) { for (const o of p.options) printOption(o); return; }
  for (const o of r.rows) {
    console.log(`      · existing: ${o.name} — $${(o.full_price_cents / 100).toFixed(2)}/term ${o.is_active ? "(active)" : "(inactive)"}`);
  }
}

try {
  await main();
} finally {
  await pool.end();
}
