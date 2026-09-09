/**
 * Prove the Register works on PRODUCTION, end to end, and that only the right
 * people can reach it.
 *
 *   npx tsx --env-file=.env script/_verify-pos-live.ts
 *
 * Drives the real lifecycle over HTTP as a real staff account — open a shift,
 * build a cart spanning two brands, take a part payment then the rest in
 * rounded cash, read the receipt back by its public token, refund, log a
 * decline, cash up — and proves the gates: a staffer without the tab is
 * refused, a staffer without the refund flag cannot refund, and a brand that
 * banks elsewhere cannot enter the same cart.
 *
 * Throwaway accounts mirror the membership shapes that matter and are deleted
 * afterwards; every row it creates is cleaned up.
 */
import pg from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const BASE = process.env.POS_VERIFY_BASE || "https://app.usg.co.nz";
const WS = "christchurch-united";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); };
const made: number[] = [];
const madeSales: number[] = [];
let madeShift: number | null = null;

async function mkUser(globalRole: string, tabs: string[] | null, canRefund: boolean) {
  const email = `posprobe-${crypto.randomBytes(5).toString("hex")}@example.com`;
  const password = crypto.randomBytes(16).toString("base64url");
  const hash = await bcrypt.hash(password, 10);
  const u = await pool.query(
    `insert into users (email, password, first_name, last_name, role, active, can_issue_refunds)
     values ($1,$2,'POS','Probe',$3,true,$4) returning id`, [email, hash, globalRole, canRefund]);
  const id = u.rows[0].id; made.push(id);
  const org = await pool.query(`select id from organizations where slug = $1`, [WS]);
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, tabs) values ($1,$2,'team_member',$3)`,
    [id, org.rows[0].id, tabs === null ? null : JSON.stringify(tabs)]);
  return { id, email, password };
}

async function login(email: string, password: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error(`login failed for ${email}: ${r.status} ${await r.text()}`);
  return cookie;
}

function api(cookie: string) {
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { cookie, "X-Workspace-Slug": WS, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json: any = null;
    try { json = await r.json(); } catch { /* empty body */ }
    return { status: r.status, body: json };
  };
}

async function main() {
  console.log(`\n  Register (POS) — live against ${BASE}\n`);

  const seller = await mkUser("coach", ["pos"], false);        // sells, cannot refund
  const refunder = await mkUser("coach", ["pos"], true);       // sells and refunds
  const outsider = await mkUser("coach", ["registrations"], false); // no register tab

  const S = api(await login(seller.email, seller.password));
  const R = api(await login(refunder.email, refunder.password));
  const O = api(await login(outsider.email, outsider.password));

  // ── The gate ──────────────────────────────────────────────────────────────
  const denied = await O("GET", "/api/admin/pos/bootstrap");
  ok("a staffer without the Register tab is refused", denied.status === 403, `HTTP ${denied.status}`);
  const anon = await fetch(`${BASE}/api/admin/pos/bootstrap`);
  ok("a signed-out request is refused", anon.status === 401, `HTTP ${anon.status}`);

  const boot = await S("GET", "/api/admin/pos/bootstrap");
  ok("a staffer with the tab gets the register", boot.status === 200 && Array.isArray(boot.body?.registers));
  ok("the seller is told they cannot refund", boot.body?.me?.canIssueRefunds === false);
  const brands: any[] = boot.body?.brands ?? [];
  const cufc = brands.find((b) => b.slug === "christchurch-united");
  const siu = brands.find((b) => b.slug === "south-island-united");
  const gym = brands.find((b) => b.slug === "united-gymnastics");
  ok("every brand carries its money account", !!cufc?.account && !!siu?.account && !!gym?.account, `cufc=${cufc?.account} siu=${siu?.account} gym=${gym?.account}`);
  ok("gymnastics banks separately from the football brands", gym?.account === "cugc" && cufc?.account === "club" && siu?.account === "club");

  // A register of our own, so the office till is never touched by a probe.
  const reg = await S("POST", "/api/admin/pos/registers", { name: `Probe register ${crypto.randomBytes(3).toString("hex")}`, location: "verification" });
  ok("a register can be created", reg.status === 201 && !!reg.body?.id);
  const registerId = reg.body.id;

  // ── Shift ─────────────────────────────────────────────────────────────────
  const shift = await S("POST", "/api/admin/pos/shifts/open", { registerId, openingFloatCents: 10000 });
  ok("a shift opens with a float", shift.status === 201, `HTTP ${shift.status}`);
  madeShift = shift.body?.id ?? null;
  const second = await S("POST", "/api/admin/pos/shifts/open", { registerId, openingFloatCents: 5000 });
  ok("a second shift on the same register is refused", second.status === 409, `HTTP ${second.status} ${second.body?.code ?? ""}`);

  // ── One cart, two brands ──────────────────────────────────────────────────
  const sale = await S("POST", "/api/admin/pos/sales", { registerId });
  ok("a sale opens and the database names it", sale.status === 201 && /^R-\d{6}$/.test(sale.body?.saleNumber ?? ""), sale.body?.saleNumber);
  const saleId = sale.body.id; madeSales.push(saleId);

  let s = (await S("POST", `/api/admin/pos/sales/${saleId}/lines`, { kind: "custom", orgId: cufc.id, title: "CUFC scarf", unitCents: 2500, qty: 2 })).body;
  s = (await S("POST", `/api/admin/pos/sales/${saleId}/lines`, { kind: "custom", orgId: siu.id, title: "SIU hoodie", unitCents: 7999, qty: 1 })).body;
  ok("a CUFC line and an SIU line sit in ONE cart", s?.lines?.length === 2 && s.subtotalCents === 12999, `subtotal ${s?.subtotalCents}`);
  ok("each line carries its own brand", s.lines.some((l: any) => l.brand?.includes("Christchurch United")) && s.lines.some((l: any) => l.brand?.includes("South Island")));
  ok("GST content is computed on the total", s.gstCents === Math.round((12999 * 3) / 23), `gst ${s.gstCents}`);

  const gymLine = await S("POST", `/api/admin/pos/sales/${saleId}/lines`, { kind: "custom", orgId: gym.id, title: "Leotard", unitCents: 5000, qty: 1 });
  ok("a gymnastics line is refused in a club-account cart", gymLine.status === 409 && gymLine.body?.code === "POS_BUCKET_MISMATCH", gymLine.body?.message?.slice(0, 60));

  const noReason = await S("PATCH", `/api/admin/pos/sales/${saleId}`, { discountCents: 999 });
  ok("a discount without a reason is refused", noReason.status === 400, `HTTP ${noReason.status}`);
  s = (await S("PATCH", `/api/admin/pos/sales/${saleId}`, { discountCents: 999, discountReason: "staff price" })).body;
  ok("a discount with a reason recomputes the total", s.totalCents === 12000, `total ${s.totalCents}`);

  s = (await S("PATCH", `/api/admin/pos/sales/${saleId}`, { customer: { name: "Probe Buyer", email: "pos-probe@example.com" } })).body;
  ok("a customer can be attached", s.customerEmail === "pos-probe@example.com");
  ok("nobody is signed up to marketing by buying", s.marketingOptInAt == null);

  // ── Money ─────────────────────────────────────────────────────────────────
  const over = await S("POST", `/api/admin/pos/sales/${saleId}/payments`, { method: "eftpos", amountCents: 12001, reference: "slip 1" });
  ok("paying more than is owed is refused", over.status === 409, `${over.body?.code ?? over.status}`);
  const noRef = await S("POST", `/api/admin/pos/sales/${saleId}/payments`, { method: "eftpos", amountCents: 5000 });
  ok("an EFTPOS payment without the slip number is refused", noRef.status === 400);

  const part = await S("POST", `/api/admin/pos/sales/${saleId}/payments`, { method: "eftpos", amountCents: 5000, reference: "slip 4471" });
  ok("a part payment is recorded and the sale stays open", part.status === 201 && part.body?.sale?.status === "open" && part.body.sale.paidCents === 5000);

  const frozen = await S("POST", `/api/admin/pos/sales/${saleId}/lines`, { kind: "custom", orgId: cufc.id, title: "Late add", unitCents: 100, qty: 1 });
  ok("lines freeze once money has landed", frozen.status === 409 && frozen.body?.code === "POS_LINES_FROZEN");

  // $70.00 remains; cash rounds to the nearest 10c (already a round number here),
  // and a $100 note gives $30 change.
  const cash = await S("POST", `/api/admin/pos/sales/${saleId}/payments`, { method: "cash", amountCents: 10000 });
  ok("cash settles the sale", cash.status === 201 && cash.body?.sale?.status === "paid", cash.body?.sale?.status);
  ok("change is worked out", cash.body?.changeCents === 3000, `change ${cash.body?.changeCents}`);
  ok("the sale reads paid in full", cash.body?.sale?.paidCents === 12000 && !!cash.body?.sale?.paidAt);

  // ── The receipt ───────────────────────────────────────────────────────────
  const token = cash.body.sale.token;
  const rec = await fetch(`${BASE}/api/public/pos/receipt/${token}`);
  const recBody: any = await rec.json();
  ok("the receipt is readable by its token, with no login", rec.status === 200, `HTTP ${rec.status}`);
  ok("the receipt carries the club's legal name and GST number", recBody?.seller?.gstNumber === "020-252-642" && /Incorporated/.test(recBody?.seller?.legalName ?? ""));
  ok("the receipt shows both brands' lines", (recBody?.lines ?? []).length === 2);
  ok("the receipt states the GST content", recBody?.gstCents === Math.round((12000 * 3) / 23), `gst ${recBody?.gstCents}`);
  // $120 is IRD's lightest tier: seller, date, description, amount — the buyer's
  // name is only required over $1,000. (The tier boundaries themselves are
  // exercised in shared/pos.ts's own checks; this proves the receipt honours them.)
  ok("a small receipt is the light tier and withholds the buyer's name",
    recBody?.customerName == null && recBody?.tier === "under_200", `tier ${recBody?.tier}`);
  const badToken = await fetch(`${BASE}/api/public/pos/receipt/00000000-0000-0000-0000-000000000000`);
  ok("an unknown receipt token is a 404, never a guess", badToken.status === 404);

  // ── Refund: the flag, with no role bypass ────────────────────────────────
  const cantRefund = await S("POST", `/api/admin/pos/sales/${saleId}/refunds`, { amountCents: 500, reason: "probe" });
  ok("a seller without the refund flag cannot refund", cantRefund.status === 403, `HTTP ${cantRefund.status}`);
  const noWhy = await R("POST", `/api/admin/pos/sales/${saleId}/refunds`, { amountCents: 500 });
  ok("a refund without a reason is refused", noWhy.status === 400);
  const tooMuch = await R("POST", `/api/admin/pos/sales/${saleId}/refunds`, { amountCents: 12001, reason: "probe" });
  ok("refunding more than was paid is refused", tooMuch.status === 409);
  const refunded = await R("POST", `/api/admin/pos/sales/${saleId}/refunds`, { amountCents: 2500, reason: "wrong size" });
  ok("a permitted refund is recorded", refunded.status === 201 && refunded.body?.status === "partially_refunded", refunded.body?.status);
  ok("the refund keeps its reason", refunded.body?.refunds?.[0]?.reason === "wrong size");

  // ── A sale that took money is not deletable, and cannot be voided ────────
  const void1 = await S("POST", `/api/admin/pos/sales/${saleId}/void`, { reason: "probe" });
  ok("a paid sale cannot be voided", void1.status === 409, `HTTP ${void1.status}`);

  // ── The sale that didn't happen ──────────────────────────────────────────
  const dec = await S("POST", "/api/admin/pos/declines", { registerId, reason: "eftpos_only", amountCents: 4500, note: "probe" });
  ok("an eftpos-only decline is logged for the count", dec.status === 201);
  const badReason = await S("POST", "/api/admin/pos/declines", { registerId, reason: "because" });
  ok("an unknown decline reason is refused", badReason.status === 400);

  // ── A free sale still closes ─────────────────────────────────────────────
  const free = await S("POST", "/api/admin/pos/sales", { registerId });
  madeSales.push(free.body.id);
  await S("POST", `/api/admin/pos/sales/${free.body.id}/lines`, { kind: "custom", orgId: cufc.id, title: "Comp scarf", unitCents: 0, qty: 1 });
  const freed = await S("POST", `/api/admin/pos/sales/${free.body.id}/complete`, { reason: "giveaway" });
  ok("a $0 sale can be finished without a payment", freed.status === 200 && freed.body?.status === "paid", freed.body?.status);

  // ── Cash up ──────────────────────────────────────────────────────────────
  const sum = await S("GET", `/api/admin/pos/shifts/${madeShift}/summary`);
  ok("the shift summary splits takings by tender", (sum.body?.byTender ?? []).length >= 2);
  ok("the shift summary splits takings by brand", (sum.body?.byBrand ?? []).length >= 2);
  const expected = 10000 + 7000 - 0; // float + cash in − cash refunds (the refund was against the EFTPOS payment)
  ok("expected cash is derived, not stored", sum.body?.cash?.expectedCents === expected, `expected ${sum.body?.cash?.expectedCents}, wanted ${expected}`);
  ok("declines are counted on the shift", sum.body?.declines?.total === 1);

  const closed = await S("POST", `/api/admin/pos/shifts/${madeShift}/close`, { countedCents: expected - 500, notes: "probe" });
  ok("the shift closes and reports the variance", closed.status === 200 && closed.body?.cash?.varianceCents === -500, `variance ${closed.body?.cash?.varianceCents}`);
  const afterClose = await S("POST", "/api/admin/pos/sales", { registerId });
  ok("no sale can open on a closed register", afterClose.status === 409, `HTTP ${afterClose.status}`);

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
}

async function cleanup() {
  for (const id of madeSales) {
    await pool.query(`delete from pos_refunds where sale_id = $1`, [id]).catch(() => {});
    await pool.query(`update pos_payments set status = 'canceled' where sale_id = $1`, [id]).catch(() => {});
    await pool.query(`delete from pos_payments where sale_id = $1`, [id]).catch(() => {});
    await pool.query(`update pos_sales set paid_cents = 0, refunded_cents = 0, status = 'void', voided_at = now(), void_reason = 'probe cleanup' where id = $1`, [id]).catch(() => {});
    await pool.query(`delete from pos_sale_lines where sale_id = $1`, [id]).catch(() => {});
    await pool.query(`delete from pos_sales where id = $1`, [id]).catch(() => {});
  }
  if (madeShift) {
    await pool.query(`delete from pos_declines where shift_id = $1`, [madeShift]).catch(() => {});
    await pool.query(`delete from pos_sales where shift_id = $1`, [madeShift]).catch(() => {});
    await pool.query(`delete from pos_shifts where id = $1`, [madeShift]).catch(() => {});
  }
  await pool.query(`delete from pos_registers where name like 'Probe register %'`).catch(() => {});
  for (const id of made) {
    await pool.query(`delete from user_organizations where user_id = $1`, [id]).catch(() => {});
    await pool.query(`delete from users where id = $1`, [id]).catch(() => {});
  }
}

main()
  .catch((e) => { console.error("\n  HARNESS FAILED:", e.message, "\n"); fail++; })
  .finally(async () => { await cleanup(); await pool.end(); process.exit(fail > 0 ? 1 : 0); });
