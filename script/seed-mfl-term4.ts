// Go-live seed for Mini Football Leagues — Term 4 2026 (org 3).
//
// Creates the Term 4 competition + its seven nights (divisions), creates the
// public `league_team` registration program (slug `term-4`), opens Term 4
// registration and CLOSES Term 3 registration — all in one transaction.
//
// Structure is Isaac Living's Term 4 plan (27 Jul 2026). Cage = 5-a-side.
// Term dates: Mon 12 Oct 2026 → Fri 18 Dec 2026 (10 playing weeks).
//
// Idempotent: re-running updates the same competition / divisions / program
// rather than duplicating. Divisions are matched on (competition, name).
//
// Dry run (default):  npx tsx script/seed-mfl-term4.ts
// Apply:              npx tsx script/seed-mfl-term4.ts --apply
// (writes to the DATABASE_URL in .env — the live Supabase Sydney prod DB)

import "dotenv/config";
import { Pool } from "pg";

const APPLY = process.argv.includes("--apply");

const ORG_ID = 3;              // Mini Football Leagues
const TERM3_COMP_ID = 3;       // "Mini Football Leagues — Term 3" (being closed)
const TERM3_PROGRAM_ID = 13;   // its public league_team program

const COMP_NAME = "Mini Football Leagues — Term 4";
const SLUG = "term-4";

// Mon 12 Oct 2026 → Fri 18 Dec 2026. The weekly billing anchors to START_DATE,
// so a team registering today pays the deposit now and its first weekly on
// 12 Oct (createLeagueWeeklySubscription: trialEnd = max(start, now + 2d)).
const START_DATE = "2026-10-12";
const END_DATE = "2026-12-18";

// ── Prices ───────────────────────────────────────────────────────────────────
// Carried verbatim from Term 3 (5's $500 / 7's $600) — NOT invented. Isaac's
// note flagged Tuesday as "(Discount)" and Youth as "cheaper"; Daniel ruled on
// both on 27 Jul 2026 — Tuesday stays at the standard $600 (NO discount,
// overriding Isaac's note), Youth is $300. Every price is editable in the MFL
// workspace with no deploy (League → Term 4 → Divisions).
const PRICE_5S = 50000;              // $500 — Term 3 "Monday 5's" verbatim
const PRICE_7S = 60000;              // $600 — Term 3 7's verbatim
const PRICE_7S_TUESDAY = 60000;      // $600 — Daniel 27 Jul: no discount on Tuesday
const PRICE_YOUTH = 30000;           // $300 — Daniel 27 Jul: new youth rate, no prior baseline

// Isaac's kick-off times. `league_divisions` has no time column — times drive
// fixture generation (League → Term 4 → Schedule → Generate), so they are
// recorded here as the source of truth for that step.
const DIVISIONS = [
  { name: "Monday 5's",    day: "Monday",    maxTeams: 12, costCents: PRICE_5S,         ageGroup: null,   times: "18:00, 19:00, 20:00 (confirm with teams)" },
  { name: "Monday 7's",    day: "Monday",    maxTeams: 16, costCents: PRICE_7S,         ageGroup: null,   times: "18:30, 19:30" },
  { name: "Tuesday 7's",   day: "Tuesday",   maxTeams: 16, costCents: PRICE_7S_TUESDAY, ageGroup: null,   times: "18:55, 19:55" },
  { name: "Wednesday 7's", day: "Wednesday", maxTeams: 16, costCents: PRICE_7S,         ageGroup: null,   times: "18:30, 19:30" },
  { name: "Thursday 7's",  day: "Thursday",  maxTeams: 16, costCents: PRICE_7S,         ageGroup: null,   times: "18:55, 19:55" },
  { name: "Thursday 5's",  day: "Thursday",  maxTeams: 12, costCents: PRICE_5S,         ageGroup: null,   times: "confirm with teams" },
  // Day deliberately NULL — Isaac: "Wednesday/Friday, ask parents". Set it in
  // the workspace once the parents have answered; never guess a night families
  // have to turn up to.
  { name: "Youth League",  day: null,        maxTeams: 12, costCents: PRICE_YOUTH,      ageGroup: "Youth", times: "Wednesday or Friday — TBC with parents" },
];

const PROGRAM = {
  name: COMP_NAME,
  slug: SLUG,
  depositCents: 12000,          // $120 deposit — Term 3 verbatim
  paymentPlan: "deposit_weekly",
  numWeeklyPayments: 8,         // Term 3 verbatim; last charge 30 Nov, term ends 18 Dec
  heroHeadline: "Register your team — Term 4",
  heroSubheadline: "Christchurch's social football league. Grab your mates and play every week.",
  splitEnabled: true,           // Player Pay — Term 3 verbatim
};

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Safety: Term 3 must be where we think it is before we close it ───────
    const t3 = await client.query(
      `SELECT c.id, c.name, c.organization_id, p.id AS program_id, p.slug
         FROM league_competitions c
         LEFT JOIN programs p ON p.id = $2
        WHERE c.id = $1`,
      [TERM3_COMP_ID, TERM3_PROGRAM_ID],
    );
    if (t3.rowCount === 0) throw new Error(`Term 3 competition ${TERM3_COMP_ID} not found`);
    if (t3.rows[0].organization_id !== ORG_ID) {
      throw new Error(`Competition ${TERM3_COMP_ID} is org ${t3.rows[0].organization_id}, expected ${ORG_ID} — aborting`);
    }
    if (t3.rows[0].slug !== "term-3") {
      throw new Error(`Program ${TERM3_PROGRAM_ID} has slug "${t3.rows[0].slug}", expected "term-3" — aborting`);
    }
    console.log(`Closing:  #${TERM3_COMP_ID} "${t3.rows[0].name}" (program #${TERM3_PROGRAM_ID})`);

    // ── 1) The Term 4 competition ────────────────────────────────────────────
    const found = await client.query(
      `SELECT id FROM league_competitions WHERE organization_id = $1 AND name = $2 LIMIT 1`,
      [ORG_ID, COMP_NAME],
    );
    let compId: number;
    if (found.rowCount && found.rowCount > 0) {
      compId = found.rows[0].id;
      await client.query(
        `UPDATE league_competitions
            SET start_date=$1, end_date=$2, active=true, archived=false
          WHERE id=$3`,
        [START_DATE, END_DATE, compId],
      );
      console.log(`✓ Updated competition #${compId}`);
    } else {
      const ins = await client.query(
        `INSERT INTO league_competitions
           (organization_id, name, sport, start_date, end_date, registration_status,
            youth_league, playoff_competition, enable_registration, is_private, archived,
            active, half_length_minutes, break_minutes)
         VALUES ($1,$2,'Soccer',$3,$4,'none',false,false,false,false,false,true,20,5)
         RETURNING id`,
        [ORG_ID, COMP_NAME, START_DATE, END_DATE],
      );
      compId = ins.rows[0].id;
      console.log(`✓ Created competition #${compId}`);
    }
    console.log(`  ${START_DATE} → ${END_DATE}`);

    // ── 2) The seven nights ──────────────────────────────────────────────────
    let capacity = 0;
    for (const [i, d] of DIVISIONS.entries()) {
      capacity += d.maxTeams;
      const ex = await client.query(
        `SELECT id FROM league_divisions WHERE competition_id=$1 AND name=$2 LIMIT 1`,
        [compId, d.name],
      );
      if (ex.rowCount && ex.rowCount > 0) {
        await client.query(
          `UPDATE league_divisions
              SET day_of_week=$1, max_teams=$2, team_cost_cents=$3, player_cost_cents=0,
                  age_group=$4, sort_order=$5
            WHERE id=$6`,
          [d.day, d.maxTeams, d.costCents, d.ageGroup, i + 1, ex.rows[0].id],
        );
        console.log(`  ✓ ${d.name.padEnd(15)} ${String(d.maxTeams).padStart(2)} teams  ${money(d.costCents).padStart(8)}  (updated #${ex.rows[0].id})`);
      } else {
        const ins = await client.query(
          `INSERT INTO league_divisions
             (competition_id, name, day_of_week, max_teams, team_cost_cents, player_cost_cents, age_group, sort_order)
           VALUES ($1,$2,$3,$4,$5,0,$6,$7) RETURNING id`,
          [compId, d.name, d.day, d.maxTeams, d.costCents, d.ageGroup, i + 1],
        );
        console.log(`  ✓ ${d.name.padEnd(15)} ${String(d.maxTeams).padStart(2)} teams  ${money(d.costCents).padStart(8)}  (created #${ins.rows[0].id})`);
      }
    }
    console.log(`  Total capacity: ${capacity} teams`);

    // ── 3) The public registration program ───────────────────────────────────
    const exProg = await client.query(
      `SELECT id FROM programs WHERE league_competition_id=$1 AND type='league_team' LIMIT 1`,
      [compId],
    );
    let programId: number;
    if (exProg.rowCount && exProg.rowCount > 0) {
      programId = exProg.rows[0].id;
      await client.query(
        `UPDATE programs SET name=$1, slug=$2, deposit_cents=$3, payment_plan=$4,
            num_weekly_payments=$5, early_bird_deadline=NULL, late_fee_cents=0,
            upsells_json='[]'::jsonb, hero_headline=$6, hero_subheadline=$7, split_enabled=$8
          WHERE id=$9`,
        [PROGRAM.name, PROGRAM.slug, PROGRAM.depositCents, PROGRAM.paymentPlan,
          PROGRAM.numWeeklyPayments, PROGRAM.heroHeadline, PROGRAM.heroSubheadline,
          PROGRAM.splitEnabled, programId],
      );
      console.log(`✓ Updated league_team program #${programId} (slug "${SLUG}")`);
    } else {
      const ins = await client.query(
        `INSERT INTO programs
           (organization_id, name, slug, type, league_competition_id, is_active,
            deposit_cents, payment_plan, num_weekly_payments, late_fee_cents, upsells_json,
            hero_headline, hero_subheadline, split_enabled)
         VALUES ($1,$2,$3,'league_team',$4,false,$5,$6,$7,0,'[]'::jsonb,$8,$9,$10)
         RETURNING id`,
        [ORG_ID, PROGRAM.name, PROGRAM.slug, compId, PROGRAM.depositCents,
          PROGRAM.paymentPlan, PROGRAM.numWeeklyPayments, PROGRAM.heroHeadline,
          PROGRAM.heroSubheadline, PROGRAM.splitEnabled],
      );
      programId = ins.rows[0].id;
      console.log(`✓ Created league_team program #${programId} (slug "${SLUG}")`);
    }

    // ── 4) CLOSE Term 3 ──────────────────────────────────────────────────────
    // `programs.is_active` is the gate getMflRegistrationProgram() checks, so
    // flipping it 404s the Term 3 register page and drops it from the public
    // offerings list. The competition, its 41 teams, their weekly Stripe
    // subscriptions, fixtures and standings are all untouched.
    await client.query(`UPDATE programs SET is_active=false WHERE id=$1`, [TERM3_PROGRAM_ID]);
    await client.query(
      `UPDATE league_competitions SET enable_registration=false, registration_status='closed' WHERE id=$1`,
      [TERM3_COMP_ID],
    );
    console.log(`✓ Term 3 registration CLOSED (teams, fixtures + weekly billing untouched)`);

    // ── 5) OPEN Term 4 (flipped last — page is fully built above) ────────────
    await client.query(`UPDATE programs SET is_active=true WHERE id=$1`, [programId]);
    await client.query(
      `UPDATE league_competitions SET enable_registration=true, registration_status='open' WHERE id=$1`,
      [compId],
    );
    console.log(`✓ Term 4 registration OPEN`);

    if (APPLY) {
      await client.query("COMMIT");
      console.log(`\n🎉 Live: https://join.minifootball.co.nz/league/${SLUG}`);
    } else {
      await client.query("ROLLBACK");
      console.log(`\n🔍 DRY RUN — rolled back, nothing written. Re-run with --apply to commit.`);
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error("Seed failed:", e.message || e); process.exit(1); });
