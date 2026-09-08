/**
 * Club Events — apply the migration and PROVE its rules.
 *
 *   npx tsx --env-file=.env script/apply-club-events.ts            # dry run, rolled back
 *   npx tsx --env-file=.env script/apply-club-events.ts --commit   # for real
 *
 * Runs migrations/2026-09-08_club_events.sql inside ONE transaction, then
 * asserts every invariant by trying to break it (mustReject) and every
 * legitimate write by doing it (mustAccept), all against throwaway fixtures
 * discarded before COMMIT. This is the rehearsal: there is no local Postgres.
 *
 * Proven here:
 *   1. money: total must equal qty × unit; paid_at and paid_cents travel
 *      together; refund never exceeds paid; "paid" always carries money
 *   2. capacity: the last seat cannot be sold twice — the trigger refuses the
 *      order that would overfill the room, and an expired pending hold frees it
 *   3. the ticket reference is minted by the database (DIN26-0001 …)
 *   4. one Stripe payment settles one order; tokens and slugs are unique
 *   5. windows: sales_start < sales_end; ends_at > starts_at
 *   6. deleting an event with orders is refused; deleting a staff account who
 *      served a sale is refused; RLS is on; the migration is idempotent
 */
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const MIGRATION = "2026-09-08_club_events.sql";

type Client = pg.Client;
const problems: string[] = [];
let checks = 0;
function ok(label: string) { checks++; console.log(`  ✓ ${label}`); }
function bad(label: string) { checks++; problems.push(label); console.log(`  ✗ ${label}`); }

async function mustReject(c: Client, label: string, sql: string, params: any[] = []) {
  await c.query("SAVEPOINT s");
  try {
    await c.query(sql, params);
    await c.query("ROLLBACK TO SAVEPOINT s");
    bad(`${label} — was ACCEPTED, the database is not enforcing this`);
  } catch {
    await c.query("ROLLBACK TO SAVEPOINT s");
    ok(label);
  }
}
async function mustAccept(c: Client, label: string, sql: string, params: any[] = []) {
  await c.query("SAVEPOINT s");
  let r: any;
  try { r = await c.query(sql, params); }
  catch (e: any) { await c.query("ROLLBACK TO SAVEPOINT s"); bad(`${label} — was REFUSED: ${e.message}`); return null; }
  await c.query("RELEASE SAVEPOINT s");
  ok(label);
  return Array.isArray(r) ? undefined : r?.rows?.[0];
}

async function main() {
  const sql = readFileSync(join(process.cwd(), "migrations", MIGRATION), "utf8");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(`\n  Club Events — ${COMMIT ? "COMMIT" : "DRY RUN (rolled back)"}\n`);
  await client.query("BEGIN");
  try {
    await client.query(sql);
    console.log("  migration ran\n");

    for (const t of ["club_events", "club_event_ticket_types", "club_event_orders", "club_event_guests", "club_event_log"]) {
      const r = await client.query(`select relrowsecurity from pg_class where relname = $1`, [t]);
      r.rowCount ? ok(`${t} exists`) : bad(`${t} was not created`);
      r.rows[0]?.relrowsecurity ? ok(`${t} has RLS on`) : bad(`${t} has RLS OFF`);
    }
    for (const [t, col] of [["club_event_ticket_types", "price_cents"], ["club_event_orders", "total_cents"], ["club_event_orders", "paid_cents"]]) {
      const r = await client.query(`select data_type from information_schema.columns where table_name = $1 and column_name = $2`, [t, col]);
      r.rows[0]?.data_type === "integer" ? ok(`${t}.${col} is integer cents`) : bad(`${t}.${col} is ${r.rows[0]?.data_type}`);
    }

    // ── fixtures (discarded) ─────────────────────────────────────────────
    await client.query("SAVEPOINT fixtures");
    const org = (await client.query(`select id from organizations where slug = 'christchurch-united'`)).rows[0];
    if (!org) throw new Error("no CUFC org");
    const staff = (await client.query(
      `insert into users (email, first_name, last_name, password, role, active)
       values ('__club_events_fixture__@example.com','Fixture','Staff','x','admin',true) returning id`)).rows[0];

    const ev = await mustAccept(client, "an event can be created",
      `insert into club_events (organization_id, slug, short_code, name, starts_at, ends_at, capacity, status)
       values ($1, '__fixture-dinner__', 'FIX', 'Fixture Dinner', now() + interval '30 days', now() + interval '30 days 5 hours', 3, 'open') returning id`, [org.id]);
    await mustReject(client, "the same slug twice is refused",
      `insert into club_events (organization_id, slug, short_code, name, starts_at) values ($1, '__fixture-dinner__', 'FIX', 'Dup', now())`, [org.id]);
    await mustReject(client, "an event ending before it starts is refused",
      `insert into club_events (organization_id, slug, short_code, name, starts_at, ends_at) values ($1, '__fixture-bad__', 'FIX', 'Bad', now() + interval '2 days', now() + interval '1 day')`, [org.id]);
    await mustReject(client, "a capacity of zero is refused",
      `insert into club_events (organization_id, slug, short_code, name, starts_at, capacity) values ($1, '__fixture-bad__', 'FIX', 'Bad', now(), 0)`, [org.id]);

    const early = await mustAccept(client, "a ticket type with a sales window can be created",
      `insert into club_event_ticket_types (event_id, name, price_cents, sales_end, sort) values ($1, 'Early bird', 15000, now() + interval '10 days', 0) returning id`, [ev.id]);
    await mustAccept(client, "a second type opening when the first closes",
      `insert into club_event_ticket_types (event_id, name, price_cents, sales_start, sort) values ($1, 'Standard', 16500, now() + interval '10 days', 1) returning id`, [ev.id]);
    await mustReject(client, "a window that ends before it starts is refused",
      `insert into club_event_ticket_types (event_id, name, price_cents, sales_start, sales_end) values ($1, 'Bad', 100, now() + interval '2 days', now() + interval '1 day')`, [ev.id]);
    await mustReject(client, "a negative price is refused",
      `insert into club_event_ticket_types (event_id, name, price_cents) values ($1, 'Bad', -1)`, [ev.id]);

    // ── money ────────────────────────────────────────────────────────────
    const o1 = await mustAccept(client, "an order is accepted and the DATABASE mints its reference",
      `insert into club_event_orders (event_id, ticket_type_id, ref, token, buyer_name, buyer_email, quantity, unit_price_cents, total_cents)
       values ($1, $2, '', 'tok-1', 'Ana', 'ana@example.com', 2, 15000, 30000) returning id, ref`, [ev.id, early.id]);
    /^FIX-\d{4}$/.test(o1?.ref ?? "") ? ok(`reference reads ${o1.ref}`) : bad(`reference is ${o1?.ref}`);
    await mustReject(client, "a total that is not qty × unit is refused",
      `insert into club_event_orders (event_id, ticket_type_id, ref, token, buyer_name, buyer_email, quantity, unit_price_cents, total_cents)
       values ($1, $2, '', 'tok-bad', 'Bad', 'bad@example.com', 2, 15000, 15000)`, [ev.id, early.id]);
    await mustReject(client, "paid_at without paid_cents is refused",
      `update club_event_orders set paid_at = now() where id = $1`, [o1.id]);
    await mustReject(client, "status 'paid' without a payment is refused",
      `update club_event_orders set status = 'paid' where id = $1`, [o1.id]);
    await mustAccept(client, "a real payment flips the order to paid",
      `update club_event_orders set status = 'paid', paid_at = now(), paid_cents = 30000, payment_method = 'online_card', stripe_payment_intent_id = 'pi_fixture_1' where id = $1`, [o1.id]);
    await mustReject(client, "the same Stripe payment cannot settle a second order",
      `insert into club_event_orders (event_id, ticket_type_id, ref, token, buyer_name, buyer_email, quantity, unit_price_cents, total_cents, stripe_payment_intent_id)
       values ($1, $2, '', 'tok-2', 'Bo', 'bo@example.com', 1, 15000, 15000, 'pi_fixture_1')`, [ev.id, early.id]);
    await mustReject(client, "a refund larger than the payment is refused",
      `update club_event_orders set refunded_cents = 30001 where id = $1`, [o1.id]);
    await mustAccept(client, "a partial refund within the payment is accepted",
      `update club_event_orders set refunded_cents = 5000 where id = $1`, [o1.id]);
    await mustReject(client, "a quantity of zero is refused",
      `insert into club_event_orders (event_id, ticket_type_id, ref, token, buyer_name, buyer_email, quantity, unit_price_cents, total_cents)
       values ($1, $2, '', 'tok-3', 'Cy', 'cy@example.com', 0, 15000, 0)`, [ev.id, early.id]);

    // ── capacity: 3 seats, 2 sold ────────────────────────────────────────
    await mustAccept(client, "seat 3 of 3 can still be sold",
      `insert into club_event_orders (event_id, ticket_type_id, ref, token, buyer_name, buyer_email, quantity, unit_price_cents, total_cents)
       values ($1, $2, '', 'tok-4', 'Di', 'di@example.com', 1, 15000, 15000)`, [ev.id, early.id]);
    await mustReject(client, "seat 4 of 3 is refused — the room is full",
      `insert into club_event_orders (event_id, ticket_type_id, ref, token, buyer_name, buyer_email, quantity, unit_price_cents, total_cents)
       values ($1, $2, '', 'tok-5', 'Ed', 'ed@example.com', 1, 15000, 15000)`, [ev.id, early.id]);
    // The pending hold on seat 3 expires after 30 minutes and frees the seat.
    await client.query(`update club_event_orders set created_at = now() - interval '31 minutes' where token = 'tok-4'`);
    await mustAccept(client, "an expired pending hold frees its seat",
      `insert into club_event_orders (event_id, ticket_type_id, ref, token, buyer_name, buyer_email, quantity, unit_price_cents, total_cents)
       values ($1, $2, '', 'tok-6', 'Fi', 'fi@example.com', 1, 15000, 15000)`, [ev.id, early.id]);
    await mustReject(client, "the expired hold cannot be paid into a full room",
      `update club_event_orders set status = 'paid', paid_at = now(), paid_cents = 15000, payment_method = 'eftpos' where token = 'tok-4'`);
    await mustAccept(client, "a cancelled order releases its seats",
      `update club_event_orders set status = 'cancelled' where token = 'tok-6'`);
    await mustAccept(client, "and the freed seat can be sold again",
      `insert into club_event_orders (event_id, ticket_type_id, ref, token, buyer_name, buyer_email, quantity, unit_price_cents, total_cents)
       values ($1, $2, '', 'tok-7', 'Gi', 'gi@example.com', 1, 15000, 15000)`, [ev.id, early.id]);

    // ── guests + people ──────────────────────────────────────────────────
    await mustAccept(client, "a guest row per seat",
      `insert into club_event_guests (order_id, seat_no) values ($1, 1), ($1, 2)`, [o1.id]);
    await mustReject(client, "two guests on the same seat are refused",
      `insert into club_event_guests (order_id, seat_no) values ($1, 1)`, [o1.id]);
    await mustAccept(client, "an office sale records who served it",
      `update club_event_orders set served_by_user_id = $2, payment_method = 'eftpos' where id = $1`, [o1.id, staff.id]);
    await mustReject(client, "deleting a staff member who took cash is refused",
      `delete from users where id = $1`, [staff.id]);
    await mustReject(client, "deleting an event that has taken money is refused",
      `delete from club_events where id = $1`, [ev.id]);
    await mustReject(client, "deleting a ticket type that has sold is refused",
      `delete from club_event_ticket_types where id = $1`, [early.id]);

    await mustAccept(client, "the whole migration re-runs cleanly (idempotent)", sql);

    await client.query("ROLLBACK TO SAVEPOINT fixtures");
    const left = (await client.query(
      `select (select count(*) from club_events where slug like '__fixture%')::int e,
              (select count(*) from club_event_orders where token like 'tok-%')::int o,
              (select count(*) from users where email = '__club_events_fixture__@example.com')::int u`)).rows[0];
    left.e === 0 && left.o === 0 && left.u === 0 ? ok("no fixture data survives the rehearsal") : bad(`fixtures leaked: ${JSON.stringify(left)}`);
  } catch (e: any) {
    problems.push(`fatal: ${e.message}`);
    console.error(`\n  ✗ fatal: ${e.message}`);
  }

  const clean = problems.length === 0;
  if (COMMIT && clean) {
    await client.query("COMMIT");
    console.log(`\n  ${checks} checks passed — COMMITTED\n`);
  } else {
    await client.query("ROLLBACK");
    console.log(`\n  ${checks} checks, ${problems.length} problems — ROLLED BACK${!COMMIT && clean ? " (dry run; add --commit)" : ""}\n`);
    if (!clean) { problems.forEach((p) => console.log(`   - ${p}`)); process.exitCode = 1; }
  }
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
