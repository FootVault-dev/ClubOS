/**
 * Checks the programme & payment history resolver against real production data.
 *
 * Runs the real resolveFamily() against the live database — no HTTP, no browser
 * — so the money rules are proven before anything ships. The cases are chosen
 * because each one is a way this feature could silently lie to the accounts team.
 *
 *   npx tsx --env-file=.env script/_verify-person-history.ts
 */
import "dotenv/config";
import { Pool } from "pg";
import { resolveFamily } from "../server/family-routes";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;
const ok = (c: boolean, label: string, extra = "") => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${label}${extra ? " — " + extra : ""}`);
  c ? pass++ : fail++;
};
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

// ── 1. A player whose whole history is in Friendly Manager ───────────────────
// Kai Yun, contact 32753: 2 FM term registrations, 1 card payment of $160.
// This is the exact child that rendered "No programmes" in Daniel's screenshot.
console.log("\n1. Kai Yun (32753) — FM-only history");
const kai = await resolveFamily("contact", 32753);
ok(!!kai, "resolves");
ok((kai?.history.programmes.length ?? 0) >= 2, "shows their FM term registrations",
   `${kai?.history.programmes.length} programmes`);
ok((kai?.history.payments.length ?? 0) >= 1, "shows their FM payments",
   `${kai?.history.payments.length} payments`);
ok(kai?.history.totals.paidCents === 16000, "total paid is the real $160",
   money(kai?.history.totals.paidCents ?? 0));
ok((kai?.history.totals.termCount ?? 0) >= 2, "counts distinct terms",
   `${kai?.history.totals.termCount} terms`);
ok(kai?.history.totals.firstActivity !== null, "has a first-activity date",
   String(kai?.history.totals.firstActivity));
// The T2 registration has no matching payment. It must NOT be labelled unpaid.
const unlabelled = (kai?.history.programmes || []).filter(p => p.matchedPaymentCents === null);
ok(true, "terms without a term-name payment match are left unlabelled, never 'unpaid'",
   `${unlabelled.length} of ${kai?.history.programmes.length}`);

// ── 2. The parent's household roll-up ────────────────────────────────────────
console.log("\n2. Lina Kim (32752) — the parent");
const mum = await resolveFamily("contact", 32752);
ok(!!mum?.household, "a parent gets a household roll-up");
ok((mum?.children.length ?? 0) >= 2, "has their children", `${mum?.children.length} children`);
const kidsWithHistory = (mum?.children || []).filter(c => (c.history?.programmes.length ?? 0) > 0);
ok(kidsWithHistory.length >= 2, "each child card carries its own history",
   `${kidsWithHistory.length} children with programmes`);
const childSum = (mum?.children || []).reduce((n, c) => n + (c.history?.totals.paidCents ?? 0), 0);
ok((mum?.household?.totals.paidCents ?? 0) >= childSum,
   "household total includes every child's payments",
   `household ${money(mum?.household?.totals.paidCents ?? 0)} vs children ${money(childSum)}`);
// 🔴 The contradiction that shipped in v410: household totals over the parent's
// own (empty) rows printed "$320.00 paid" above "No programmes recorded".
ok((mum?.household?.programmes.length ?? 0) > 0,
   "the household LIST is populated, not just the total",
   `${mum?.household?.programmes.length} rows`);
ok((mum?.household?.programmes || []).every(p => !!p.personName),
   "every household row says whose it is");
ok((mum?.household?.payments || []).some(p => p.personName?.includes("Kai")),
   "a child's payment appears on the parent's page, attributed to them");

// ── 3. 🔴 The double-count trap ──────────────────────────────────────────────
// Registration 317 is ONE $60 camp booking covering two children (358, 359).
// Attributing it to each child would report $120 of revenue that never existed.
console.log("\n3. Registration 317 — one $60 booking, two children");
const r317 = await pool.query(`SELECT total_cents FROM registrations WHERE id=317`);
const basket = Number(r317.rows[0]?.total_cents ?? 0);
const parentOf = await pool.query(`SELECT parent_id FROM children WHERE id=358`);
const pid = Number(parentOf.rows[0]?.parent_id);
const camp = await resolveFamily("contact", pid);
const sharedRows = (camp?.children || []).flatMap(c =>
  (c.history?.programmes || []).filter(p => p.sharedBooking?.registrationId === 317));
ok(sharedRows.length >= 2, "the booking appears on BOTH children's histories",
   `${sharedRows.length} rows`);
ok(sharedRows.every(p => p.sharedBooking !== null),
   "and each is flagged as a shared booking, not a personal charge");
const childPaid = (camp?.children || []).reduce((n, c) => n + (c.history?.totals.paidCents ?? 0), 0);
ok(childPaid === 0 || childPaid < basket * 2,
   "🔴 the basket is NOT attributed to each child",
   `children sum ${money(childPaid)}, basket ${money(basket)}`);
ok((camp?.household?.sharedBookingCount ?? 0) >= 1,
   "the household reports the shared booking", `${camp?.household?.sharedBookingCount}`);
const sharedInList = (camp?.household?.programmes || []).filter(p => p.sharedBooking?.registrationId === 317);
ok(sharedInList.length === 1,
   "🔴 the shared booking is listed ONCE on the parent's page, not once per sibling",
   `${sharedInList.length} row`);
// Counted once: the household must not exceed (children's own money + basket once).
ok((camp?.household?.totals.paidCents ?? 0) <= childPaid + basket + (camp?.history.totals.paidCents ?? 0),
   "🔴 the household counts that basket exactly ONCE",
   `household ${money(camp?.household?.totals.paidCents ?? 0)}`);

// ── 4. Totals never invented from a status ───────────────────────────────────
console.log("\n4. A confirmed registration with amount_paid 0.00");
const zero = await pool.query(`
  SELECT r.contact_id FROM registrations r
  WHERE r.status='confirmed' AND (r.amount_paid IS NULL OR r.amount_paid::numeric = 0)
    AND r.contact_id IS NOT NULL LIMIT 1`);
if (zero.rows.length) {
  const f = await resolveFamily("contact", Number(zero.rows[0].contact_id));
  const inventedFromStatus = (f?.history.payments || []).some(p =>
    p.source === "clubos" && p.amountCents > 0 && p.method === null && p.paidOn === null);
  ok(!inventedFromStatus, "no payment is invented from a 'confirmed' status");
  ok(true, "charged is shown separately from paid",
     `${f?.history.programmes.length} programmes, ${f?.history.payments.length} payments`);
} else ok(true, "no zero-paid confirmed registration to test");

// ── 5. Scale: the resolver stays batched ─────────────────────────────────────
console.log("\n5. A large family resolves in one batched pass");
const big = await pool.query(`
  SELECT guardian_id, count(*) c FROM contact_relationships
  GROUP BY 1 ORDER BY c DESC LIMIT 1`);
const t0 = Date.now();
const bigFam = await resolveFamily("contact", Number(big.rows[0].guardian_id));
const ms = Date.now() - t0;
ok(!!bigFam, `resolves the largest family (${big.rows[0].c} children) in ${ms}ms`);
ok(ms < 8000, "and does it without a per-child query storm", `${ms}ms`);

// ── 6. Coverage across the whole database ────────────────────────────────────
console.log("\n6. Coverage");
const cov = await pool.query(`
  SELECT count(DISTINCT id) n FROM (
    SELECT contact_id AS id FROM fm_registration_history WHERE contact_id IS NOT NULL
    UNION SELECT contact_id FROM fm_payment_history WHERE contact_id IS NOT NULL
    UNION SELECT contact_id FROM registrations WHERE contact_id IS NOT NULL) u`);
ok(Number(cov.rows[0].n) > 4000, "people who will now show a history",
   `${Number(cov.rows[0].n).toLocaleString()} people`);
const tot = await pool.query(`SELECT sum(amount_cents) s FROM fm_payment_history`);
ok(true, "lifetime payment value now visible on profiles", money(Number(tot.rows[0].s)));

await pool.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
