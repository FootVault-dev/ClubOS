// Seed Team Pay for the Christchurch Ethnic Cup.
//
//   npx tsx --env-file=.env script/seed-teampay-ethnic-cup.ts            (dry run)
//   npx tsx --env-file=.env script/seed-teampay-ethnic-cup.ts --commit
//
// Idempotent: re-running updates the tournament's dates and the fee, and NEVER
// touches the three switches once they have been set in the tab. Those are
// Isaac's and Daniel's to flip, and a re-seed must not reopen entries or — far
// worse — switch payments back on.
//
// 🔴 EVERY FACT HERE IS ONE DANIEL HAS CONFIRMED. The Ethnic Cup site's
// governing rule is that it states nothing nobody confirmed, and this seeds the
// same tournament. Confirmed: the name, the dates, $800 a team, adult
// 11-a-side. NOT confirmed and therefore NOT here: the venue, the number of
// teams, and whether there are men's and women's grades.
import pg from "pg";

const COMMIT = process.argv.includes("--commit");

const ORG_SLUG = "christchurch-international-cup";   // the Cup runs under CIC (org 5)
const TOURNAMENT_NAME = "Christchurch Ethnic Cup 2026";
const SLUG = "ethnic-cup-2026";

// Confirmed by Daniel 2026-08-20 and live on ethniccup.com.
const START_DATE = "2026-11-14";
const END_DATE = "2026-11-15";
const FEE_CENTS = 80000;   // $800 per team, displayed with no GST claim (NZ prices are inclusive)

// 🔴 A pre-fill on the entry form, NOT a rule about the tournament. Eleven a
// side plus five subs. Every manager can change it, and it is locked only once
// one of their players has paid.
const DEFAULT_SQUAD_SIZE = 16;

const BLURB =
  "An eleven-a-side tournament for teams representing Christchurch's communities. " +
  "The team fee is split across your squad — everyone pays their own share.";

async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  console.log(`\n  Ethnic Cup — Team Pay seed — ${COMMIT ? "COMMIT" : "DRY RUN (rolled back)"}\n`);
  await c.query("BEGIN");

  try {
    const org = (await c.query(`select id from organizations where slug = $1`, [ORG_SLUG])).rows[0];
    if (!org) throw new Error(`organisation ${ORG_SLUG} not found`);

    // ── the tournament row ─────────────────────────────────────────────────
    // The Cup is a tournaments row, not a new module — the existing bracket and
    // results engine already runs on it when the draw comes.
    let tour = (await c.query(
      `select id from tournaments where organization_id = $1 and name = $2`,
      [org.id, TOURNAMENT_NAME])).rows[0];

    if (!tour) {
      tour = (await c.query(
        `insert into tournaments (organization_id, name, start_date, end_date, status, active, registration_fee_cents)
         values ($1, $2, $3, $4, 'draft', true, $5) returning id`,
        [org.id, TOURNAMENT_NAME, START_DATE, END_DATE, FEE_CENTS])).rows[0];
      console.log(`  created tournament #${tour.id} — ${TOURNAMENT_NAME}`);
    } else {
      await c.query(
        `update tournaments set start_date = $2, end_date = $3, registration_fee_cents = $4 where id = $1`,
        [tour.id, START_DATE, END_DATE, FEE_CENTS]);
      console.log(`  tournament #${tour.id} already existed — dates and fee refreshed`);
    }
    // location is deliberately left NULL. The venue is not confirmed.

    // ── the Team Pay competition ───────────────────────────────────────────
    const existing = (await c.query(
      `select id, entries_open, payments_enabled, fillins_open from teampay_competitions where slug = $1`,
      [SLUG])).rows[0];

    if (!existing) {
      const row = (await c.query(
        `insert into teampay_competitions
           (organization_id, kind, tournament_id, slug, name, brand,
            fee_cents, default_squad_size, blurb,
            entries_open, payments_enabled, fillins_open)
         values ($1,'tournament',$2,$3,$4,'ethniccup',$5,$6,$7, false, false, false)
         returning id`,
        [org.id, tour.id, SLUG, "Christchurch Ethnic Cup", FEE_CENTS, DEFAULT_SQUAD_SIZE, BLURB])).rows[0];
      console.log(`  created teampay_competitions #${row.id} — all three switches OFF`);
    } else {
      // 🔴 The three switches are NOT in this update. A re-seed that flipped
      // payments_enabled back on would start charging people.
      await c.query(
        `update teampay_competitions
            set fee_cents = $2, default_squad_size = $3, blurb = $4, tournament_id = $5, updated_at = now()
          where id = $1`,
        [existing.id, FEE_CENTS, DEFAULT_SQUAD_SIZE, BLURB, tour.id]);
      console.log(`  teampay_competitions #${existing.id} refreshed — switches untouched ` +
        `(entries ${existing.entries_open ? "OPEN" : "off"}, payments ${existing.payments_enabled ? "ON" : "off"}, fill-ins ${existing.fillins_open ? "OPEN" : "off"})`);
    }

    const comp = (await c.query(`select * from teampay_competitions where slug = $1`, [SLUG])).rows[0];
    const share = Math.ceil(comp.fee_cents / comp.default_squad_size);

    console.log(`
  ${comp.name}
    ${START_DATE} → ${END_DATE}
    $${(comp.fee_cents / 100).toFixed(2)} per team · ${comp.default_squad_size} players by default · $${(share / 100).toFixed(2)} each
    venue: not confirmed — deliberately not seeded

  Links (they work the moment the switches are on):
    enter a team    https://app.usg.co.nz/enter/${SLUG}
    fill-in signup  https://app.usg.co.nz/fill-in/${SLUG}
    staff board     https://app.usg.co.nz/admin/team-entries  (CIC workspace → Ethnic)
`);

    if (COMMIT) {
      await c.query("COMMIT");
      console.log("  COMMITTED\n");
    } else {
      await c.query("ROLLBACK");
      console.log("  rolled back — re-run with --commit to apply.\n");
    }
  } catch (e: any) {
    await c.query("ROLLBACK");
    console.error(`\n  failed: ${e.message}\n`);
    await c.end();
    process.exit(1);
  }
  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
