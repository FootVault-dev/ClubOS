// Seed Team Pay for the CIC Summer 7's (23–24 January 2027) — TWO competitions.
//
//   npx tsx --env-file=.env script/seed-teampay-cic7s.ts            (dry run)
//   npx tsx --env-file=.env script/seed-teampay-cic7s.ts --commit
//
// Sibling of seed-teampay-ethnic-cup.ts. Idempotent: re-running refreshes fee,
// squad size, blurb and dates, and NEVER touches the three switches once set.
// Open or close entries with script/open-cic7s-entries.ts.
//
// 🔴 EVERY FACT HERE IS FROM ISAAC LIVING'S GRAPHIC of 2026-09-03 (WhatsApp,
// "v3-hero-trophies.png"), which Daniel approved the same day ("Let's get this
// out in the chats"): 23–24 January 2027 · OPEN $700 per team · SOCIAL $500 per
// team · United Sports Centre. Two grades, priced differently — and Team Pay
// carries ONE fee per competition — so the 7's is two competitions sharing one
// tournament row. The form's category decides which one a team enters.
//
// The morning of 2026-09-08 seeded a single `cic-summer-7s-2027` at the 2026
// site's $990 before Isaac's prices surfaced; that row is RENAMED to the Open
// slug here (no entries had been created on it).
import pg from "pg";

const COMMIT = process.argv.includes("--commit");

const ORG_SLUG = "christchurch-international-cup";   // CIC 7's runs under CIC (org 5)
const TOURNAMENT_NAME = "CIC Summer 7's 2027";
const START_DATE = "2027-01-23";
const END_DATE = "2027-01-24";
const LOCATION = "United Sports Centre, Christchurch";
const LEGACY_SLUG = "cic-summer-7s-2027";
const DEFAULT_SQUAD_SIZE = 14;    // "Up to 14 players per team" — a pre-fill, editable until the first payment

export const CIC7S_COMPETITIONS = [
  { slug: "cic-summer-7s-2027-open",   category: "Open",   name: "CIC Summer 7's — Open",   feeCents: 70000 },
  { slug: "cic-summer-7s-2027-social", category: "Social", name: "CIC Summer 7's — Social", feeCents: 50000 },
] as const;

const blurb = (category: string, feeCents: number) =>
  `The ${category} grade of the CIC Summer 7's — 7-a-side at United Sports Centre, Christchurch, ` +
  `23–24 January 2027. Up to 14 players a team, 6 games guaranteed, $1,000 cash prize for the winners. ` +
  `Pay the $${feeCents / 100} team fee yourself, or split it across your squad so every player pays ` +
  `their own share on their own card — you choose, and you can change your mind until it is paid.`;

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
        `insert into tournaments (organization_id, name, start_date, end_date, location, status, active, registration_fee_cents)
         values ($1, $2, $3, $4, $5, 'draft', true, $6) returning id`,
        [org.id, TOURNAMENT_NAME, START_DATE, END_DATE, LOCATION, CIC7S_COMPETITIONS[0].feeCents])).rows[0];
      console.log(`  created tournament #${tour.id} — ${TOURNAMENT_NAME}`);
    } else {
      await c.query(
        `update tournaments set start_date = $2, end_date = $3, location = $4, registration_fee_cents = $5 where id = $1`,
        [tour.id, START_DATE, END_DATE, LOCATION, CIC7S_COMPETITIONS[0].feeCents]);
      console.log(`  tournament #${tour.id} already existed — dates, venue and fee refreshed`);
    }

    // The single $990 row from earlier in the day becomes the Open competition.
    const legacy = (await c.query(`select id from teampay_competitions where slug = $1`, [LEGACY_SLUG])).rows[0];
    const openExists = (await c.query(`select id from teampay_competitions where slug = $1`, [CIC7S_COMPETITIONS[0].slug])).rows[0];
    if (legacy && !openExists) {
      const n = (await c.query(`select count(*)::int as n from teampay_entries where competition_id = $1`, [legacy.id])).rows[0].n;
      await c.query(`update teampay_competitions set slug = $2, updated_at = now() where id = $1`, [legacy.id, CIC7S_COMPETITIONS[0].slug]);
      console.log(`  renamed legacy '${LEGACY_SLUG}' (#${legacy.id}, ${n} entries) → '${CIC7S_COMPETITIONS[0].slug}'`);
    }

    for (const comp of CIC7S_COMPETITIONS) {
      const existing = (await c.query(
        `select id, entries_open, payments_enabled, fillins_open from teampay_competitions where slug = $1`, [comp.slug])).rows[0];
      if (!existing) {
        const row = (await c.query(
          `insert into teampay_competitions
             (organization_id, kind, tournament_id, slug, name, brand, fee_cents, default_squad_size, blurb,
              entries_open, payments_enabled, fillins_open)
           values ($1,'tournament',$2,$3,$4,'cic7s',$5,$6,$7, false, false, false) returning id`,
          [org.id, tour.id, comp.slug, comp.name, comp.feeCents, DEFAULT_SQUAD_SIZE, blurb(comp.category, comp.feeCents)])).rows[0];
        console.log(`  created teampay_competitions #${row.id} — ${comp.slug} — all three switches OFF`);
      } else {
        // 🔴 The three switches are NOT in this update.
        await c.query(
          `update teampay_competitions set name = $2, fee_cents = $3, default_squad_size = $4, blurb = $5, tournament_id = $6, brand = 'cic7s', updated_at = now() where id = $1`,
          [existing.id, comp.name, comp.feeCents, DEFAULT_SQUAD_SIZE, blurb(comp.category, comp.feeCents), tour.id]);
        console.log(`  teampay_competitions #${existing.id} — ${comp.slug} refreshed — switches untouched ` +
          `(entries ${existing.entries_open ? "OPEN" : "off"}, payments ${existing.payments_enabled ? "ON" : "off"}, fill-ins ${existing.fillins_open ? "OPEN" : "off"})`);
      }
    }

    console.log(`\n  ${TOURNAMENT_NAME} · ${START_DATE} → ${END_DATE} · ${LOCATION}`);
    for (const comp of CIC7S_COMPETITIONS) {
      const share = Math.ceil(comp.feeCents / DEFAULT_SQUAD_SIZE);
      console.log(`    ${comp.category.padEnd(6)} $${(comp.feeCents / 100).toFixed(2)} per team · ${DEFAULT_SQUAD_SIZE} players by default · $${(share / 100).toFixed(2)} each` +
        `\n           enter a team  https://app.usg.co.nz/enter/${comp.slug}`);
    }
    console.log(`    staff board  https://app.usg.co.nz/admin/team-entries  (CIC workspace → 7's)\n`);

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
