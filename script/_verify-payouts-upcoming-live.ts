// "Still to come" on the Payouts page, proven against LIVE Stripe and live prod.
//
//   npx tsx --env-file=.env script/_verify-payouts-upcoming-live.ts
//
// The two things worth asserting, because both would put a wrong number in
// front of whoever reconciles the bank:
//
//  1. Stripe's `status` query filter on payouts.list is SILENTLY IGNORED on this
//     account — asking for in_transit returns paid payouts. If the endpoint ever
//     goes back to filtering server-side, "on its way to the bank" starts naming
//     deposits that landed weeks ago. Checked directly against Stripe here.
//  2. The Stripe BALANCE is not a payout. It must never be folded into the
//     in-flight total, because it has no arrival date at all.
import pg from "pg";
import bcrypt from "bcryptjs";
import Stripe from "stripe";

const BASE = process.env.VERIFY_BASE || "https://app.usg.co.nz";
const WORKSPACE = "united-sports-group";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;
const ok = (l: string, good: boolean, d = "") => {
  console.log(`  ${good ? "ok  " : "FAIL"} ${l}${d ? ` — ${d}` : ""}`);
  good ? pass++ : fail++;
};

const users: number[] = [];

async function main() {
  console.log(`\nPayouts "Still to come" — live against ${BASE}\n`);

  // ── The Stripe truth, read directly ───────────────────────────────────────
  const s2 = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-06-20" as any });
  const [rawList, rawFiltered, balance] = await Promise.all([
    s2.payouts.list({ limit: 100 }),
    s2.payouts.list({ status: "in_transit", limit: 10 }),
    s2.balance.retrieve(),
  ]);

  console.log("Stripe, read directly");
  const notPaid = rawList.data.filter((p) => p.status === "pending" || p.status === "in_transit");
  ok("payouts.list returns rows", rawList.data.length > 0, `${rawList.data.length} rows`);
  // The trap, asserted rather than remembered.
  const filteredAllPaid = rawFiltered.data.length > 0 && rawFiltered.data.every((p) => p.status === "paid");
  ok("Stripe's status filter is unreliable here — do NOT filter server-side",
    filteredAllPaid || rawFiltered.data.every((p) => p.status === "in_transit"),
    filteredAllPaid ? "confirmed: status:in_transit returned only PAID rows" : "filter behaved; JS filter still required");
  const pendingCents = balance.pending.reduce((t, b) => t + b.amount, 0);
  console.log(`  Stripe says: ${notPaid.length} payout(s) in flight, balance pending ${(pendingCents / 100).toFixed(2)}`);

  // ── A real staff account with the payouts tab ─────────────────────────────
  const email = `_payoutupcoming_${Date.now()}@usg.co.nz`;
  const password = `T${Math.random().toString(36).slice(2)}!aA9`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Preflight','Payouts',$2,'team_member',true) RETURNING id`,
    [email, await bcrypt.hash(password, 10)],
  );
  const userId = rows[0].id;
  users.push(userId);
  const { rows: orgRows } = await pool.query(`SELECT id FROM organizations WHERE slug = $1`, [WORKSPACE]);
  const orgId = orgRows[0].id;
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs)
     VALUES ($1, $2, 'team_member', $3::jsonb)`,
    [userId, orgId, JSON.stringify(["payouts"])],
  );

  console.log("\nThe endpoint");
  const anon = await fetch(`${BASE}/api/admin/payouts/upcoming`);
  ok("unauthenticated is refused, and the route EXISTS (401, not 404)", anon.status === 401, `HTTP ${anon.status}`);

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const get = (p: string) => fetch(`${BASE}${p}`, { headers: { cookie, "X-Workspace-Slug": WORKSPACE } });

  const r = await get("/api/admin/payouts/upcoming?account=club");
  ok("a staffer with the payouts tab gets 200", r.status === 200, `HTTP ${r.status}`);
  const body: any = await r.json();

  // 🔴 The route-order trap: with /:id registered first, Express parses
  // "upcoming" as a payout id and answers 400 "Invalid payout id".
  ok("\"upcoming\" is NOT parsed as a payout id", !/Invalid payout id/i.test(JSON.stringify(body)));
  ok("the response is the upcoming shape", Array.isArray(body.inFlight) && Array.isArray(body.upcoming),
    Object.keys(body).join(","));

  console.log("\nWhat it reports");
  ok("every in-flight row is genuinely not paid",
    body.inFlight.every((p: any) => p.status === "pending" || p.status === "in_transit"),
    body.inFlight.map((p: any) => p.status).join(",") || "none in flight");
  ok("in-flight count matches Stripe", body.inFlight.length === notPaid.length,
    `page ${body.inFlight.length} vs Stripe ${notPaid.length}`);

  // ── The derived rows, the thing Stripe's own dashboard shows ──────────────
  // Rebuild the buckets independently here. If the endpoint and this script
  // agree AND both equal Stripe's own balance, the figures on the page are the
  // figures in the Stripe dashboard.
  const mine = new Map<string, number>();
  let scanned = 0;
  for await (const t of s2.balanceTransactions.list({ limit: 100, available_on: { gte: Math.floor(Date.now()/1000) - 14*86400 } } as any)) {
    if (++scanned > 2000) break;
    if (t.status !== "pending" || t.type === "payout") continue;
    const d = new Date(t.available_on * 1000).toISOString().slice(0, 10);
    mine.set(d, (mine.get(d) ?? 0) + t.net);
  }
  const mineTotal = Array.from(mine.values()).reduce((a, b) => a + b, 0);

  ok("an upcoming row exists for every pending available-day",
    body.upcoming.length === Array.from(mine.values()).filter((v) => v !== 0).length,
    `page ${body.upcoming.length} vs Stripe ${mine.size}`);
  ok("every upcoming bucket matches Stripe to the cent",
    body.upcoming.every((u: any) => mine.get(u.availableOn) === u.amountCents),
    body.upcoming.map((u: any) => `${u.availableOn}:${u.amountCents}`).join(" "));
  const bucketTotal = body.upcoming.reduce((t: number, u: any) => t + u.amountCents, 0);
  ok("the buckets add up to Stripe's pending balance", bucketTotal === pendingCents,
    `${bucketTotal} vs ${pendingCents}`);
  ok("the endpoint says it reconciles", body.reconciles === true);
  ok("the total is in-flight PLUS upcoming, nothing double counted",
    body.totalCents === body.inFlight.reduce((t: number, p: any) => t + p.amountCents, 0) + bucketTotal,
    `${body.totalCents}`);

  // 🔴 The date is the whole point of Daniel's request — it must be after the
  // money is available, and never land on a weekend.
  ok("every arrive-by is AFTER the day the money becomes available",
    body.upcoming.every((u: any) => u.arriveBy > u.availableOn),
    body.upcoming.map((u: any) => `${u.availableOn}→${u.arriveBy}`).join(" "));
  ok("no arrive-by lands on a weekend",
    body.upcoming.every((u: any) => {
      const [y, m, d] = u.arriveBy.split("-").map(Number);
      const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      return wd !== 0 && wd !== 6;
    }),
    body.upcoming.map((u: any) => u.arriveBy).join(" "));
  ok("the rows are ordered soonest first",
    body.upcoming.every((u: any, i: number) => i === 0 || body.upcoming[i - 1].arriveBy <= u.arriveBy));
  ok("a payout schedule is reported", body.schedule?.interval != null, JSON.stringify(body.schedule));
  console.log("  page shows: " + (body.upcoming.map((u: any) => `$${(u.amountCents/100).toFixed(2)} by ${u.arriveBy}`).join(", ") || "nothing upcoming"));

  console.log("\nThe other account");
  const g = await get("/api/admin/payouts/upcoming?account=cugc");
  ok("gymnastics answers too", g.status === 200, `HTTP ${g.status}`);
  const gb: any = await g.json();
  ok("gymnastics reports its OWN upcoming rows, not the club's",
    JSON.stringify(gb.upcoming) !== JSON.stringify(body.upcoming) || body.upcoming.length === 0,
    `cugc total ${gb.totalCents}`);
  ok("gymnastics reconciles too", gb.reconciles === true);

  console.log("\nThe gate");
  const email2 = `_payoutnotab_${Date.now()}@usg.co.nz`;
  const pw2 = `T${Math.random().toString(36).slice(2)}!aA9`;
  const { rows: r2 } = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Preflight','NoTab',$2,'team_member',true) RETURNING id`,
    [email2, await bcrypt.hash(pw2, 10)],
  );
  users.push(r2[0].id);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs)
     VALUES ($1, $2, 'team_member', $3::jsonb)`,
    [r2[0].id, orgId, JSON.stringify(["content"])],
  );
  const l2 = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email2, password: pw2 }),
  });
  const c2 = (l2.headers.get("set-cookie") || "").split(";")[0];
  const denied = await fetch(`${BASE}/api/admin/payouts/upcoming`, {
    headers: { cookie: c2, "X-Workspace-Slug": WORKSPACE },
  });
  ok("a staffer WITHOUT the payouts tab is refused", denied.status === 403 || denied.status === 401,
    `HTTP ${denied.status}`);
}

main()
  .catch((e) => { console.error("\nthrew:", e.message); fail++; })
  .finally(async () => {
    for (const id of users) {
      await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [id]).catch(() => {});
      await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
    }
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
