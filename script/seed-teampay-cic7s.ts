// Seed Team Pay for the CIC Summer 7's (January 2027).
//
//   npx tsx --env-file=.env script/seed-teampay-cic7s.ts            (dry run)
//   npx tsx --env-file=.env script/seed-teampay-cic7s.ts --commit
//
// Sibling of seed-teampay-ethnic-cup.ts. Idempotent: re-running refreshes the
// fee, squad size and blurb, and NEVER touches the three switches once set.
// Open or close entries with script/open-cic7s-entries.ts.
//
// 🔴 EVERY FACT HERE IS ONE THE LIVE SITE ALREADY STATES (cic7s.com, verbatim
// from the 2026 edition): $990 a team, up to 14 players, 6 games guaranteed,
// $1,000 cash prize, Mens / Masters / Social, United Sports Centre.
// NOT confirmed and therefore NOT here: the 2027 dates. cic7s.com shows
// "January 30th-31st 2027" as a labelled PLACEHOLDER; the tournament row keeps
// start/end NULL rather than assert a weekend nobody has confirmed.
import pg from "pg";

const COMMIT = process.argv.includes("--commit");

const ORG_SLUG = "christchurch-international-cup";   // CIC 7's runs under CIC (org 5)
const TOURNAMENT_NAME = "CIC Summer 7's 2027";
export const CIC7S_SLUG = "cic-summer-7s-2027";
const FEE_CENTS = 99000;          // $990 per team, as the site has said since the 2026 edition
const DEFAULT_SQUAD_SIZE = 14;    // "Up to 14 players per team" — a pre-fill, editable until the first payment

const BLURB =
  "A 7-a-side tournament at United Sports Centre, Christchurch, in January 2027 — " +
  "Mens, Masters and Social. Up to 14 players a team, 6 games guaranteed, $1,000 cash prize " +
  "for the winners. Pay the $990 team fee yourself, or split it across your squad so every " +
  "player pays their own share on their own card — you choose, and you can change your mind " +
  "until it is paid.";

async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  console.log(`\n  CIC Summer 7's — Team Pay seed — ${COMMIT ? "COMMIT" : "DRY RUN (rolled back)"}\n`);
  await c.query("BEGIN");
  try {
    const org = (await c.query(`select id from organizations where slug = $1`, [ORG_SLUG])).rows[0];
    if (!org) throw new Error(`organisation ${ORG_SLUG} not found`);

    let tour = (await c.query(
      `select id from tournaments where organization_id = $1 and name = $2`, [org.id, TOURNAMENT_NAME])).rows[0];
    if (!tour) {
      tour = (await c.query(
        `insert into tournaments (organization_id, name, location, status, active, registration_fee_cents)
         values ($1, $2, 'United Sports Centre, Christchurch', 'draft', true, $3) returning id`,
        [org.id, TOURNAMENT_NAME, FEE_CENTS])).rows[0];
      console.log(`  created tournament #${tour.id} — ${TOURNAMENT_NAME} (dates left NULL: not confirmed)`);
    } else {
      await c.query(`update tournaments set registration_fee_cents = $2 where id = $1`, [tour.id, FEE_CENTS]);
      console.log(`  tournament #${tour.id} already existed — fee refreshed`);
    }

    const existing = (await c.query(
      `select id, entries_open, payments_enabled, fillins_open from teampay_competitions where slug = $1`, [CIC7S_SLUG])).rows[0];
    if (!existing) {
      const row = (await c.query(
        `insert into teampay_competitions
           (organization_id, kind, tournament_id, slug, name, brand, fee_cents, default_squad_size, blurb,
            entries_open, payments_enabled, fillins_open)
         values ($1,'tournament',$2,$3,$4,'cic7s',$5,$6,$7, false, false, false) returning id`,
        [org.id, tour.id, CIC7S_SLUG, "CIC Summer 7's", FEE_CENTS, DEFAULT_SQUAD_SIZE, BLURB])).rows[0];
      console.log(`  created teampay_competitions #${row.id} — all three switches OFF`);
    } else {
      await c.query(
        `update teampay_competitions set fee_cents = $2, default_squad_size = $3, blurb = $4, tournament_id = $5, updated_at = now() where id = $1`,
        [existing.id, FEE_CENTS, DEFAULT_SQUAD_SIZE, BLURB, tour.id]);
      console.log(`  teampay_competitions #${existing.id} refreshed — switches untouched ` +
        `(entries ${existing.entries_open ? "OPEN" : "off"}, payments ${existing.payments_enabled ? "ON" : "off"}, fill-ins ${existing.fillins_open ? "OPEN" : "off"})`);
    }

    const comp = (await c.query(`select * from teampay_competitions where slug = $1`, [CIC7S_SLUG])).rows[0];
    const share = Math.ceil(comp.fee_cents / comp.default_squad_size);
    console.log(`
  ${comp.name}  (brand ${comp.brand})
    $${(comp.fee_cents / 100).toFixed(2)} per team · ${comp.default_squad_size} players by default · $${(share / 100).toFixed(2)} each
    dates: NOT confirmed — deliberately not seeded

  Links (they work the moment the switches are on):
    enter a team    https://app.usg.co.nz/enter/${CIC7S_SLUG}
    staff board     https://app.usg.co.nz/admin/team-entries  (CIC workspace → 7's)
`);

    if (COMMIT) { await c.query("COMMIT"); console.log("  COMMITTED\n"); }
    else { await c.query("ROLLBACK"); console.log("  rolled back — re-run with --commit to apply.\n"); }
  } catch (e: any) {
    await c.query("ROLLBACK");
    console.error(`\n  failed: ${e.message}\n`);
    await c.end();
    process.exit(1);
  }
  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
