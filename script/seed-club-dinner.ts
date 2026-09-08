/**
 * Seed the CUFC Club Dinner (Fri 13 Nov 2026) as the first Club Event.
 *
 *   npx tsx --env-file=.env script/seed-club-dinner.ts            # dry run
 *   npx tsx --env-file=.env script/seed-club-dinner.ts --commit
 *
 * Idempotent: upserts the event by slug and each ticket type by name, and
 * NEVER overwrites a field a human has since edited in ClubOS on a re-run —
 * it only creates what is missing. Every fact here traces to Malcolm's 4 Sep
 * email or the 4 Sep meeting (memory project_cufc_club_dinner). The event
 * NAME is a working title (the real one was still being workshopped) and no
 * speaker is named, on Les's instruction. Capacity is deliberately NULL: the
 * room's limit was not stated by anyone. Set it in the tab.
 */
import pg from "pg";
import { nzLocalToUtc } from "../shared/club-events";

const COMMIT = process.argv.includes("--commit");

const EVENT = {
  slug: "club-dinner-2026",
  short_code: "DIN26",
  name: "Club Dinner 2026",
  tagline: "Player pathways, and bringing the club together. A sit-down dinner, a guest speaker panel and a live auction, on Show Weekend.",
  description: [
    "Christchurch United has been producing players since 1970. This night is about the pathway: what the club gives a player, whether they go on to the professional game or take what football taught them somewhere else entirely. Our guest speakers have walked it, and will talk about it in a panel format.",
    "It is also about the club itself. Every team and every age group, in one room, for one night. Book a table with your team, your family or the parents you stand beside every Saturday.",
  ].join("\n\n"),
  includes: [
    "Sit-down buffet dinner, tables of 10",
    "Guest speaker panel",
    "Live auction",
    "Quiz and raffle prizes",
    "A starter round of beer and wine on each table, then a cash bar",
  ],
  brand: "cufc",
  venue_name: "Commodore Hotel",
  venue_address: "449 Memorial Avenue, Christchurch",
  starts_at: nzLocalToUtc("2026-11-13", "17:30"),
  ends_at: nzLocalToUtc("2026-11-13", "23:00"),
  capacity: null as number | null,
  table_size: 10,
  max_per_order: 10,
  age_restriction: "18+",
  status: "open",
  stripe_account: "club",
  currency: "NZD",
  contact_email: "daniel@cufc.co.nz",
  payment_note: null as string | null,
};

const TYPES = [
  { name: "Early bird", price_cents: 15000, sales_start: null, sales_end: nzLocalToUtc("2026-10-01", "00:00"), sort: 0 },
  { name: "Standard",   price_cents: 16500, sales_start: nzLocalToUtc("2026-10-01", "00:00"), sales_end: null, sort: 1 },
];

async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  console.log(`\n  Club Dinner seed — ${COMMIT ? "COMMIT" : "DRY RUN"}\n`);
  await c.query("BEGIN");
  try {
    const org = (await c.query(`select id from organizations where slug = 'christchurch-united'`)).rows[0];
    if (!org) throw new Error("CUFC org not found");

    let ev = (await c.query(`select * from club_events where slug = $1`, [EVENT.slug])).rows[0];
    if (ev) {
      console.log(`  event exists: #${ev.id} "${ev.name}" (${ev.status}) — left untouched`);
    } else {
      ev = (await c.query(
        `insert into club_events (organization_id, slug, short_code, name, tagline, description, includes, brand,
           venue_name, venue_address, starts_at, ends_at, capacity, table_size, max_per_order, age_restriction,
           status, stripe_account, currency, contact_email, payment_note)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning *`,
        [org.id, EVENT.slug, EVENT.short_code, EVENT.name, EVENT.tagline, EVENT.description, JSON.stringify(EVENT.includes), EVENT.brand,
         EVENT.venue_name, EVENT.venue_address, EVENT.starts_at, EVENT.ends_at, EVENT.capacity, EVENT.table_size, EVENT.max_per_order, EVENT.age_restriction,
         EVENT.status, EVENT.stripe_account, EVENT.currency, EVENT.contact_email, EVENT.payment_note])).rows[0];
      console.log(`  created event #${ev.id} "${ev.name}" — ${ev.status}, starts ${new Date(ev.starts_at).toISOString()}`);
    }

    for (const t of TYPES) {
      const have = (await c.query(`select id, price_cents from club_event_ticket_types where event_id = $1 and name = $2`, [ev.id, t.name])).rows[0];
      if (have) { console.log(`  type exists: ${t.name} $${have.price_cents / 100} — left untouched`); continue; }
      await c.query(
        `insert into club_event_ticket_types (event_id, name, price_cents, sales_start, sales_end, sort, is_active) values ($1,$2,$3,$4,$5,$6,true)`,
        [ev.id, t.name, t.price_cents, t.sales_start, t.sales_end, t.sort]);
      console.log(`  created type: ${t.name} $${t.price_cents / 100}${t.sales_end ? ` until ${t.sales_end.toISOString()}` : ""}${t.sales_start ? ` from ${t.sales_start.toISOString()}` : ""}`);
    }

    // Read back the window in NZ terms so a human can eyeball it.
    const types = (await c.query(
      `select name, price_cents,
              to_char(sales_start at time zone 'Pacific/Auckland', 'DD Mon YYYY HH24:MI') as nz_start,
              to_char(sales_end   at time zone 'Pacific/Auckland', 'DD Mon YYYY HH24:MI') as nz_end
       from club_event_ticket_types where event_id = $1 order by sort`, [ev.id])).rows;
    for (const t of types) console.log(`    ${t.name.padEnd(12)} $${(t.price_cents / 100).toString().padEnd(6)} ${t.nz_start ? "from " + t.nz_start : ""} ${t.nz_end ? "until " + t.nz_end : ""} (NZ)`);
    const when = (await c.query(`select to_char(starts_at at time zone 'Pacific/Auckland', 'Dy DD Mon YYYY HH24:MI') s, to_char(ends_at at time zone 'Pacific/Auckland', 'HH24:MI') e from club_events where id = $1`, [ev.id])).rows[0];
    console.log(`    event: ${when.s} to ${when.e} NZ · public page /events/${ev.slug}`);

    if (COMMIT) { await c.query("COMMIT"); console.log("\n  COMMITTED\n"); }
    else { await c.query("ROLLBACK"); console.log("\n  dry run — rolled back (add --commit)\n"); }
  } catch (e: any) {
    await c.query("ROLLBACK");
    console.error("  ✗", e.message);
    process.exitCode = 1;
  }
  await c.end();
}
main();
