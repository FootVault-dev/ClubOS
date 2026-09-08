/**
 * Club Events — live checks against a running server (default: production).
 *
 *   npx tsx --env-file=.env script/_verify-club-events-live.ts
 *   BASE=http://localhost:5000 npx tsx --env-file=.env script/_verify-club-events-live.ts
 *
 * Talks HTTP through curl (node's outbound fetch is intermittently dead on this
 * Mac). Creates ONE real pending order + PaymentIntent against the dinner —
 * never confirms it — then cancels the intent at Stripe and deletes the rows.
 */
import { execFileSync } from "child_process";
import pg from "pg";
import Stripe from "stripe";

const BASE = process.env.BASE || "https://app.usg.co.nz";
const SLUG = process.env.SLUG || "club-dinner-2026";
let pass = 0, fail = 0;
const ok = (l: string) => { pass++; console.log(`  ✓ ${l}`); };
const bad = (l: string) => { fail++; console.log(`  ✗ ${l}`); };
const check = (cond: boolean, l: string) => (cond ? ok(l) : bad(l));

function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const args = ["-s", "-o", "-", "-w", "\n%{http_code}", "-X", method, `${BASE}${path}`, "-H", "Content-Type: application/json"];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  if (body !== undefined) args.push("--data", JSON.stringify(body));
  const out = execFileSync("curl", args, { encoding: "utf8", timeout: 30000 });
  const i = out.lastIndexOf("\n");
  const status = Number(out.slice(i + 1));
  let json: any = null; try { json = JSON.parse(out.slice(0, i)); } catch { json = out.slice(0, i); }
  return { status, json };
}

async function main() {
  console.log(`\n  Club Events live — ${BASE}\n`);

  // ── public event ──
  const ev = http("GET", `/api/public/club-events/${SLUG}`);
  check(ev.status === 200, `GET event → 200 (${ev.status})`);
  const e = ev.json?.event; const p = ev.json?.pricing;
  check(!!e?.name && !!e?.startsAt && !!e?.venueName, `event carries name/date/venue: ${e?.name} @ ${e?.venueName}`);
  check(Array.isArray(e?.includes) && e.includes.length >= 3, "event carries what's included");
  check(!("organizationId" in (e ?? {})) && !("id" in (e ?? {})), "public shape leaks no ids");
  check(!!p?.current && [15000, 16500].includes(p.current.priceCents), `a ticket type is on sale now: ${p?.current?.name} ${p?.current?.priceCents}`);
  const nzNow = new Date();
  const earlyBirdWindow = nzNow < new Date("2026-09-30T11:00:00Z");
  check(earlyBirdWindow ? p?.current?.priceCents === 15000 : p?.current?.priceCents === 16500, `price matches the clock (${earlyBirdWindow ? "early bird $150" : "standard $165"})`);
  check(earlyBirdWindow ? p?.next?.priceCents === 16500 : p?.next == null, "the next price is announced while early bird runs");
  check(ev.json?.selling === true, "selling = true");
  check(ev.json?.stripePublishableKey === null || /^pk_(live|test)_/.test(ev.json?.stripePublishableKey), "publishable key is a pk_ or null (client falls back)");
  check(http("GET", "/api/public/club-events/nope-nope").status === 404, "unknown slug → 404");
  check(http("OPTIONS", `/api/public/club-events/${SLUG}`, undefined, { Origin: "https://cufc.co.nz" }).status === 204, "CORS preflight from cufc.co.nz → 204");

  // ── purchase validation (server-side, never trusting the browser) ──
  const base = { quantity: 2, buyerName: "Verify Bot", buyerEmail: "verify-club-events@example.com", buyerPhone: "021 000 0000", ageConfirmed: true, source: "verify" };
  check(http("POST", `/api/public/club-events/${SLUG}/intent`, { ...base, quantity: 0 }).status === 400, "qty 0 → 400");
  check(http("POST", `/api/public/club-events/${SLUG}/intent`, { ...base, quantity: 11 }).status === 400, "qty 11 (> max per order) → 400");
  check(http("POST", `/api/public/club-events/${SLUG}/intent`, { ...base, buyerEmail: "nope" }).status === 400, "bad email → 400");
  check(http("POST", `/api/public/club-events/${SLUG}/intent`, { ...base, buyerPhone: "" }).status === 400, "no phone → 400");
  check(http("POST", `/api/public/club-events/${SLUG}/intent`, { ...base, ageConfirmed: false }).status === 400, "18+ not confirmed → 400");
  check(http("POST", `/api/public/club-events/nope-nope/intent`, base).status === 404, "intent on unknown event → 404");

  // ── a real pending order ──
  const it = http("POST", `/api/public/club-events/${SLUG}/intent`, { ...base, guests: [{ fullName: "Guest One", dietary: "vegetarian" }], tableName: "Verify table" });
  check(it.status === 200, `valid intent → 200 (${it.status}) ${it.status !== 200 ? JSON.stringify(it.json) : ""}`);
  const token = it.json?.orderToken as string;
  check(/^[0-9a-f]{32}$/.test(token || ""), "order token is 128 random bits");
  check(/^DIN26-\d{4}$/.test(it.json?.ref || ""), `ticket reference minted by the DB: ${it.json?.ref}`);
  check(it.json?.amountCents === 2 * (p?.current?.priceCents ?? 0), `amount = 2 × current price (${it.json?.amountCents})`);
  check(typeof it.json?.clientSecret === "string" && it.json.clientSecret.startsWith("pi_"), "a Stripe client secret came back");

  // retry with the same token reuses the hold rather than taking a second one
  const it2 = http("POST", `/api/public/club-events/${SLUG}/intent`, { ...base, orderToken: token });
  check(it2.status === 200 && it2.json?.orderToken === token && it2.json?.ref === it.json?.ref, "a retry reuses its own pending order");

  const od = http("GET", `/api/public/club-events/order/${token}`);
  check(od.status === 200 && od.json?.order?.status === "pending", "order page by token → 200, pending");
  check(od.json?.guests?.[0]?.fullName === "Guest One" && od.json?.guests?.[0]?.dietary === "vegetarian", "guest name + dietary stored per seat");
  check(od.json?.guests?.length === 2, "one guest row per seat");
  check(od.json?.order?.tableName === "Verify table", "table name stored");
  check(http("PATCH", `/api/public/club-events/order/${token}`, { tableName: "x" }).status === 400, "guest edits refused on an unpaid order");
  const cf = http("POST", `/api/public/club-events/order/${token}/confirm`);
  check(cf.status === 200 && cf.json?.paid === false, "confirm reads Stripe: not paid");
  check(http("GET", `/api/public/club-events/order/0000000000000000000000000000dead`).status === 404, "unknown token → 404");

  // ── admin gate ──
  check(http("GET", "/api/admin/club-events").status === 401, "admin list unauthenticated → 401");
  check(http("POST", "/api/admin/club-events/1/orders", {}).status === 401, "office sale unauthenticated → 401");
  check(http("POST", "/api/admin/club-events/1/orders/1/refund", {}).status === 401, "refund unauthenticated → 401");

  // ── cleanup: cancel the intent at Stripe, delete the rows ──
  const pgc = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await pgc.connect();
  const row = (await pgc.query(`select id, stripe_payment_intent_id, status from club_event_orders where token = $1`, [token])).rows[0];
  if (row?.stripe_payment_intent_id && process.env.STRIPE_SECRET_KEY) {
    try {
      const s = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-04-30.basil" as any });
      const pi = await s.paymentIntents.cancel(row.stripe_payment_intent_id);
      check(pi.status === "canceled", "fixture PaymentIntent cancelled at Stripe");
    } catch (err: any) { bad(`could not cancel fixture intent: ${err.message}`); }
  }
  if (row) {
    await pgc.query(`delete from club_event_log where order_id = $1`, [row.id]);
    await pgc.query(`delete from club_event_orders where id = $1 and status = 'pending'`, [row.id]);
    const left = (await pgc.query(`select count(*)::int c from club_event_orders where buyer_email = 'verify-club-events@example.com'`)).rows[0].c;
    check(left === 0, "fixture order removed");
  }
  await pgc.end();

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
