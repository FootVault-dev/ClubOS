// Ballers Youth League — Term 4 2026 (Mini Football Leagues, org 3).
//
// MFL's FIRST individual-signup product. Every other MFL league sells a TEAM to
// a captain (`league_competitions` / `league_divisions` / `league_teams`); this
// sells one child a place for a term. That is the academy engine's unit of
// sale, not the league engine's, so these are `programs` rows — one per age
// group, because CAPACITY LIVES ON THE PROGRAM and the cap is per age group.
//
// Source of truth: the MFL meeting of 2026-08-03 (Fireflies
// 01KZ2JHS6X690NEJ437WZVNZHN) + Isaac Living's written note photographed the
// same day. Nothing here is inferred beyond the ten Wednesday dates, which are
// arithmetic on the term start.
//
//   Wednesdays, 10 weeks, first night Wed 14 Oct 2026, last Wed 16 Dec 2026.
//   U9 + U10  16:00–17:00   ·  U11 + U12  17:15–18:15
//   5-a-side on Pitch S2, United Sports Centre. $100 per player per term.
//   Capacity 40 per age group (80 per time slot — 8 games at a time).
//
// Idempotent: matches the term on (org, year, term_number) and each programme
// on its slug, so re-running UPDATES rather than duplicating. It never deletes
// a programme and never touches a registration.
//
// Dry run (default):  npx tsx script/seed-mfl-ballers.ts
// Apply:              npx tsx script/seed-mfl-ballers.ts --apply

import "dotenv/config";
import { Pool } from "pg";

const APPLY = process.argv.includes("--apply");

const ORG_ID = 3; // Mini Football Leagues

// The term row exists ONLY for these programmes — MFL had no `terms` rows at
// all before this, and the adult leagues carry their dates on
// `league_competitions` instead. So it is set to the youth league's actual run
// (first and last playing Wednesday) rather than the adult competition window
// of 12 Oct – 18 Dec, which makes the pro-rata arithmetic exact: a child who
// joins in week 6 is quoted 5/10 of $100, not 5-and-a-bit tenths.
const TERM = {
  year: 2026,
  termNumber: 4,
  name: "Term 4 2026 — Youth Leagues",
  startDate: "2026-10-14",
  endDate: "2026-12-16",
  notes:
    "Ballers Youth League only. Ten Wednesdays, 14 Oct – 16 Dec 2026. The adult " +
    "MFL Term 4 competition runs Mon 12 Oct – Fri 18 Dec and keeps its dates on " +
    "league_competitions, not here.",
};

const SESSIONS = 10;
const PRICE_CENTS = 10000; // $100 per player per term — Isaac's note, verbatim.
const CAPACITY = 40;       // per age group. Daniel 2026-08-03: "that's our capacity".
const VENUE = "United Sports Centre — Pitch S2";

// U9/U10 play first, U11/U12 second. Age grade is seasonYear − birthYear (NZF
// classifies by year of birth), so U9 in 2026 = born 2017.
const GROUPS = [
  { age: 9,  slug: "ballers-u9",  start: "4:00pm", end: "5:00pm",  sort: 1 },
  { age: 10, slug: "ballers-u10", start: "4:00pm", end: "5:00pm",  sort: 2 },
  { age: 11, slug: "ballers-u11", start: "5:15pm", end: "6:15pm",  sort: 3 },
  { age: 12, slug: "ballers-u12", start: "5:15pm", end: "6:15pm",  sort: 4 },
];

const DESCRIPTION_SHORT =
  "Sign up on your own — no team needed. You're drawn into a different team every " +
  "week, and the points follow you, not the team.";

const DESCRIPTION_LONG =
  "Ballers Youth League is a 5-a-side league you join as an individual. There's no " +
  "team to organise and nobody to round up. Every week you're drawn into a new team " +
  "and play alongside different people.\n\n" +
  "Points go to the player, not the team: 3 for a win, 1 for a draw, 0 for a loss. " +
  "They build up over the term into one leaderboard, and the top three at the end " +
  "win a prize. There's also a player-of-the-day spot prize in every game.\n\n" +
  "Ten weeks, Wednesdays, on Pitch S2 at United Sports Centre.";

const FAQ = [
  {
    q: "Does my child need a team?",
    a: "No. That's the whole point. They sign up on their own and get put into a team on the night.",
  },
  {
    q: "Will they play with their friends?",
    a: "Teams are drawn fresh each week, so they'll play with different people most weeks — and against their friends some weeks.",
  },
  {
    q: "How do the points work?",
    a: "Points follow the player. 3 for a win, 1 for a draw, 0 for a loss, added up across the term into one leaderboard.",
  },
  {
    q: "What if we join partway through the term?",
    a: "You only pay for the weeks that are left.",
  },
  {
    q: "What should they bring?",
    a: "Boots or trainers, shin pads, and a drink bottle.",
  },
];

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const log: string[] = [];

  try {
    await client.query("BEGIN");

    // ── Safety: the org must be the one we think it is ──────────────────────
    const org = await client.query(`SELECT id, name, slug FROM organizations WHERE id = $1`, [ORG_ID]);
    if (org.rowCount === 0) throw new Error(`org ${ORG_ID} not found`);
    if (org.rows[0].slug !== "mini-football-leagues") {
      throw new Error(`org ${ORG_ID} is "${org.rows[0].slug}", expected mini-football-leagues`);
    }
    log.push(`org ${ORG_ID} = ${org.rows[0].name}`);

    // ── Term ────────────────────────────────────────────────────────────────
    const term = await client.query(
      `INSERT INTO terms (organization_id, year, term_number, name, start_date, end_date, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (organization_id, year, term_number)
       DO UPDATE SET name = EXCLUDED.name, start_date = EXCLUDED.start_date,
                     end_date = EXCLUDED.end_date, notes = EXCLUDED.notes
       RETURNING id, (xmax = 0) AS inserted`,
      [ORG_ID, TERM.year, TERM.termNumber, TERM.name, TERM.startDate, TERM.endDate, TERM.notes],
    );
    const termId = term.rows[0].id as number;
    log.push(`term ${termId} ${term.rows[0].inserted ? "CREATED" : "updated"} — ${TERM.startDate} → ${TERM.endDate}`);

    // ── Programmes, one per age group ───────────────────────────────────────
    for (const g of GROUPS) {
      const name = `Ballers Youth League — U${g.age}`;
      const schedule = `Wednesdays ${g.start}–${g.end}`;

      const prog = await client.query(
        `INSERT INTO programs (
             organization_id, name, slug, type, schedule_type, term_id, season_year,
             age_min, age_max, capacity, is_active, registration_open,
             pricing_model, prorata_grace_weeks, academy_section,
             location, start_date, end_date, session_count,
             hero_headline, hero_subheadline, description_short, description_long,
             what_to_bring, contact_email, primary_cta, faq_json
           ) VALUES (
             $1,$2,$3,'academy','term',$4,$5,
             $6,$6,$7,true,true,
             'term_prorated',0,'additional',
             $8,$9,$10,$11,
             $12,$13,$14,$15,
             $16,$17,$18,$19
           )
         ON CONFLICT (organization_id, slug) DO UPDATE SET
             name = EXCLUDED.name,
             term_id = EXCLUDED.term_id,
             season_year = EXCLUDED.season_year,
             age_min = EXCLUDED.age_min,
             age_max = EXCLUDED.age_max,
             capacity = EXCLUDED.capacity,
             is_active = EXCLUDED.is_active,
             registration_open = EXCLUDED.registration_open,
             pricing_model = EXCLUDED.pricing_model,
             prorata_grace_weeks = EXCLUDED.prorata_grace_weeks,
             location = EXCLUDED.location,
             start_date = EXCLUDED.start_date,
             end_date = EXCLUDED.end_date,
             session_count = EXCLUDED.session_count,
             hero_headline = EXCLUDED.hero_headline,
             hero_subheadline = EXCLUDED.hero_subheadline,
             description_short = EXCLUDED.description_short,
             description_long = EXCLUDED.description_long,
             what_to_bring = EXCLUDED.what_to_bring,
             contact_email = EXCLUDED.contact_email,
             faq_json = EXCLUDED.faq_json
         RETURNING id, (xmax = 0) AS inserted`,
        [
          ORG_ID, name, g.slug, termId, TERM.year,
          g.age, CAPACITY,
          VENUE, TERM.startDate, TERM.endDate, SESSIONS,
          `Ballers Youth League — U${g.age}`,
          `${schedule} · 5-a-side · ${money(PRICE_CENTS)} for the term`,
          DESCRIPTION_SHORT, DESCRIPTION_LONG,
          "Boots or trainers, shin pads, drink bottle.",
          "info@minifootball.co.nz",
          "Sign up",
          JSON.stringify(FAQ),
        ],
      );
      const programId = prog.rows[0].id as number;
      log.push(`  programme ${programId} ${prog.rows[0].inserted ? "CREATED" : "updated"} — ${g.slug} (${schedule}, cap ${CAPACITY})`);

      // ── The one priced option ─────────────────────────────────────────────
      // No natural unique key on program_options, so match on (program, name).
      const optName = `U${g.age} — ${schedule}`;
      const existing = await client.query(
        `SELECT id FROM program_options WHERE program_id = $1 AND name = $2`,
        [programId, optName],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        await client.query(
          `UPDATE program_options
              SET schedule_text = $2, full_price_cents = $3, pricing_model = 'term_prorated',
                  session_count = $4, allow_pay_weekly = false, is_active = true, display_order = $5
            WHERE id = $1`,
          [existing.rows[0].id, schedule, PRICE_CENTS, SESSIONS, g.sort],
        );
        log.push(`    option ${existing.rows[0].id} updated — ${money(PRICE_CENTS)}`);
      } else {
        const opt = await client.query(
          `INSERT INTO program_options
             (program_id, name, schedule_text, full_price_cents, pricing_model,
              session_count, allow_pay_weekly, display_order, is_active)
           VALUES ($1,$2,$3,$4,'term_prorated',$5,false,$6,true) RETURNING id`,
          [programId, optName, schedule, PRICE_CENTS, SESSIONS, g.sort],
        );
        log.push(`    option ${opt.rows[0].id} CREATED — ${money(PRICE_CENTS)}`);
      }

      // ── The ten Wednesday sessions (the roll) ─────────────────────────────
      // camp_dates is keyed by SLOT for term programmes: the partial unique
      // index is (camp_id, date, start_time) WHERE start_time IS NOT NULL.
      // Never reinstate a plain UNIQUE (camp_id, date) — it would make the
      // two age-group time slots on the same night impossible.
      let made = 0;
      for (let w = 0; w < SESSIONS; w++) {
        const d = new Date(Date.UTC(2026, 9, 14) + w * 7 * 86400000);
        const iso = d.toISOString().slice(0, 10);
        const r = await client.query(
          `INSERT INTO camp_dates (camp_id, date, start_time, end_time)
                VALUES ($1,$2,$3,$4)
           ON CONFLICT DO NOTHING RETURNING id`,
          [programId, iso, g.start, g.end],
        );
        if (r.rowCount) made++;
      }
      log.push(`    ${made} of ${SESSIONS} session dates created (rest already existed)`);
    }

    // ── Verify what we just wrote, inside the transaction ───────────────────
    const check = await client.query(
      `SELECT p.slug, p.capacity, p.registration_open, p.is_active, p.term_id,
              o.full_price_cents, o.session_count,
              (SELECT count(*) FROM camp_dates cd WHERE cd.camp_id = p.id) AS dates
         FROM programs p
         LEFT JOIN program_options o ON o.program_id = p.id
        WHERE p.slug LIKE 'ballers-u%'
        ORDER BY p.slug`,
    );
    console.log("\nResult:");
    console.table(check.rows);

    for (const r of check.rows as any[]) {
      if (r.full_price_cents !== PRICE_CENTS) throw new Error(`${r.slug}: price is ${r.full_price_cents}, expected ${PRICE_CENTS}`);
      if (r.capacity !== CAPACITY) throw new Error(`${r.slug}: capacity is ${r.capacity}, expected ${CAPACITY}`);
      if (Number(r.dates) !== SESSIONS) throw new Error(`${r.slug}: ${r.dates} session dates, expected ${SESSIONS}`);
      if (!r.registration_open || !r.is_active) throw new Error(`${r.slug}: not open`);
    }
    if (check.rowCount !== GROUPS.length) throw new Error(`${check.rowCount} rows, expected ${GROUPS.length}`);

    console.log("\n" + log.join("\n"));

    if (APPLY) {
      await client.query("COMMIT");
      console.log("\n✅ APPLIED.");
      console.log("Checkout URLs:");
      for (const g of GROUPS) console.log(`  https://join.minifootball.co.nz/${g.slug}/class-book`);
    } else {
      await client.query("ROLLBACK");
      console.log("\n🔎 DRY RUN — rolled back. Re-run with --apply to commit.");
    }
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("\n❌", e.message);
  process.exit(1);
});
