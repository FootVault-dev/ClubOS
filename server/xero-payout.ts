// Walk a Stripe payout and resolve every charge in it to what ClubOS sold.
//
// Read-only against Stripe and the database. Produces the split; posting it to
// Xero is a separate step, so a dry run can be trusted to show exactly what a
// post would contain.

import Stripe from "stripe";
import { db } from "./db";
import { sql } from "drizzle-orm";
import {
  buildSplit, categoriseResolved, type PayoutSplit, type ResolvedPayment, type XeroCategoryKey,
} from "@shared/xero-payout";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", { apiVersion: "2025-04-30.basil" as any });

/** A payout Stripe will not break down. Reported by name, never posted. */
export class PayoutNotSplittable extends Error {
  constructor(public payoutId: string, reason: string) {
    super(`${payoutId}: ${reason}`);
    this.name = "PayoutNotSplittable";
  }
}

/**
 * Find the ClubOS record behind each PaymentIntent.
 *
 * 🔴 ONE query across every table that stores a PaymentIntent, not a lookup per
 * charge — a busy payout carries 100+ charges and a per-charge round trip makes
 * a month-end run take minutes.
 *
 * 🔴 A registration's programme is joined in HERE, because the category needs it
 * and a second pass would have to re-open every row.
 */
export async function resolvePaymentIntents(ids: string[]): Promise<Map<string, ResolvedPayment>> {
  const out = new Map<string, ResolvedPayment>();
  if (ids.length === 0) return out;

  const rows = await db.execute(sql`
    WITH ids(pi) AS (SELECT unnest(${sql.raw(`ARRAY[${ids.map(i => `'${i.replace(/'/g, "")}'`).join(",")}]::text[]`)}))
    SELECT * FROM (
      SELECT i.pi, 'registrations' AS source, r.id::text AS record_id, p.organization_id,
             p.type AS program_type, p.schedule_type, NULL::text AS competition_kind, p.name AS descr, p.id AS program_id
        FROM ids i JOIN registrations r ON r.stripe_payment_intent_id = i.pi
        LEFT JOIN programs p ON p.id = r.program_id
      UNION ALL
      SELECT i.pi, 'split_members', m.id::text, NULL::int, NULL, NULL, NULL, m.name, NULL::int
        FROM ids i JOIN split_members m ON m.stripe_payment_intent_id = i.pi
      UNION ALL
      SELECT i.pi, 'payshare_participants', pp.id::text, NULL::int, NULL, NULL, NULL, NULL, NULL::int
        FROM ids i JOIN payshare_participants pp ON pp.stripe_payment_intent_id = i.pi
      UNION ALL
      SELECT i.pi, 'teampay_players', tp.id::text, c.organization_id, NULL, NULL, c.kind, c.name, NULL::int
        FROM ids i JOIN teampay_players tp ON tp.stripe_payment_intent_id = i.pi
        LEFT JOIN teampay_entries te ON te.id = tp.entry_id
        LEFT JOIN teampay_competitions c ON c.id = te.competition_id
      UNION ALL
      SELECT i.pi, 'teampay_entries', te.id::text, c.organization_id, NULL, NULL, c.kind, c.name, NULL::int
        FROM ids i JOIN teampay_entries te ON te.team_stripe_payment_intent_id = i.pi
        LEFT JOIN teampay_competitions c ON c.id = te.competition_id
      UNION ALL
      SELECT i.pi, 'club_event_orders', o.id::text, e.organization_id, NULL, NULL, NULL, e.name, NULL::int
        FROM ids i JOIN club_event_orders o ON o.stripe_payment_intent_id = i.pi
        LEFT JOIN club_events e ON e.id = o.event_id
      UNION ALL
      SELECT i.pi, 'members', mb.id::text, mb.organization_id, NULL, NULL, NULL, mb.tier_name, NULL::int
        FROM ids i JOIN members mb ON mb.stripe_payment_intent_id = i.pi
      UNION ALL
      SELECT i.pi, 'facility_bookings', fb.id::text, fb.organization_id, NULL, NULL, NULL, fb.customer_name, NULL::int
        FROM ids i JOIN facility_bookings fb ON fb.stripe_payment_intent_id = i.pi
      UNION ALL
      SELECT i.pi, 'shop_orders', so.id::text, so.organization_id, NULL, NULL, NULL, so.order_number, NULL::int
        FROM ids i JOIN shop_orders so ON so.stripe_payment_intent_id = i.pi
      UNION ALL
      SELECT i.pi, 'shop_order_shares', ss.id::text, NULL::int, NULL, NULL, NULL, ss.player_name, NULL::int
        FROM ids i JOIN shop_order_shares ss ON ss.stripe_payment_intent_id = i.pi
      UNION ALL
      SELECT i.pi, 'print_orders', po.id::text, po.organization_id, NULL, NULL, NULL, po.customer_name, NULL::int
        FROM ids i JOIN print_orders po ON po.stripe_payment_intent_id = i.pi
      UNION ALL
      SELECT i.pi, 'usg_invoices', ui.id::text, ui.organization_id, NULL, NULL, NULL, ui.recipient_name, NULL::int
        FROM ids i JOIN usg_invoices ui ON ui.stripe_payment_intent_id = i.pi
      UNION ALL
      SELECT i.pi, 'cugc_registrations', cr.id::text, cr.organization_id, NULL, NULL, NULL, cr.program_name, NULL::int
        FROM ids i JOIN cugc_registrations cr ON cr.stripe_payment_intent = i.pi
    ) hits
  `);

  for (const r of rows.rows as any[]) {
    // First answer wins: a PaymentIntent belongs to exactly one sale. Two hits
    // would mean two records claim the same money, which is worth knowing about.
    if (out.has(r.pi)) {
      console.warn(`[xero-payout] ${r.pi} matched twice: ${out.get(r.pi)!.source} and ${r.source}`);
      continue;
    }
    out.set(r.pi, {
      source: r.source, recordId: r.record_id, organizationId: r.organization_id ?? null,
      programType: r.program_type, scheduleType: r.schedule_type,
      competitionKind: r.competition_kind, description: r.descr,
      programId: r.program_id ?? null,
    });
  }
  return out;
}

/**
 * Resolve payments that stage one could not: subscription renewals, whose
 * PaymentIntent ClubOS never records.
 *
 * The subscription's own metadata carries the `registrationId` this code wrote
 * when it created the subscription, so this reads back our own record rather
 * than inferring one. A customer with several registrations is therefore not
 * ambiguous — the subscription names the right one.
 */
async function resolveViaSubscriptions(
  unknownIds: string[],
  txns: Stripe.BalanceTransaction[],
  piOf: (t: Stripe.BalanceTransaction) => string | null,
): Promise<Map<string, ResolvedPayment>> {
  const out = new Map<string, ResolvedPayment>();

  // Customer per unresolved PaymentIntent, read off the charge we already have.
  const custOf = new Map<string, string>();
  for (const t of txns) {
    const pi = piOf(t);
    if (!pi || !unknownIds.includes(pi)) continue;
    const s: any = t.source;
    const cust = typeof s?.customer === "string" ? s.customer : s?.customer?.id;
    if (cust) custOf.set(pi, cust);
  }
  if (custOf.size === 0) return out;

  // One lookup per distinct customer, not per charge.
  const regIdOfCustomer = new Map<string, number>();
  for (const cust of Array.from(new Set(custOf.values()))) {
    try {
      const subs = await stripe.subscriptions.list({ customer: cust, status: "all", limit: 10 });
      for (const sub of subs.data) {
        const rid = Number(sub.metadata?.registrationId);
        if (Number.isFinite(rid) && rid > 0) { regIdOfCustomer.set(cust, rid); break; }
      }
    } catch (e: any) {
      console.warn(`[xero-payout] subscription lookup failed for ${cust}: ${e?.message}`);
    }
  }
  if (regIdOfCustomer.size === 0) return out;

  const regIds = Array.from(new Set(regIdOfCustomer.values()));
  const rows = await db.execute(sql`
    SELECT r.id, p.organization_id, p.type AS program_type, p.schedule_type, p.name AS descr
      FROM registrations r LEFT JOIN programs p ON p.id = r.program_id
     WHERE r.id = ANY(${sql.raw(`ARRAY[${regIds.join(",")}]::int[]`)})`);
  const regs = new Map<number, any>((rows.rows as any[]).map(r => [Number(r.id), r]));

  for (const [pi, cust] of Array.from(custOf.entries())) {
    const rid = regIdOfCustomer.get(cust);
    const reg = rid ? regs.get(rid) : null;
    if (!reg) continue;
    out.set(pi, {
      source: "registrations", recordId: reg.id, organizationId: reg.organization_id ?? null,
      programType: reg.program_type, scheduleType: reg.schedule_type,
      competitionKind: null, description: reg.descr,
      // A weekly share of a team entry is a player paying, not the team.
      isPlayerShare: true, viaSubscription: cust,
    });
  }
  return out;
}

export interface WalkedItem {
  balanceTxnId: string;
  type: string;
  paymentIntentId: string | null;
  grossCents: number;
  feeCents: number;
  category: XeroCategoryKey;
  resolved: ResolvedPayment | null;
  description: string | null;
}

export interface WalkedPayout { split: PayoutSplit; items: WalkedItem[]; }

/**
 * Rules for charges no ClubOS table owns — another app billing the same Stripe
 * account. Loaded from the database so adding one is a row, not a deploy: the
 * promise that each unresolved charge becomes a rule ONCE only holds if a human
 * can actually write the rule without us.
 */
async function loadRules(): Promise<{ kind: string; value: string; category: XeroCategoryKey }[]> {
  try {
    const r = await db.execute(sql`SELECT match_kind, match_value, category FROM xero_payout_rules WHERE active ORDER BY length(match_value) DESC`);
    return (r.rows as any[]).map(x => ({ kind: x.match_kind, value: x.match_value, category: x.category as XeroCategoryKey }));
  } catch {
    // The table not existing yet must not stop a dry run from being useful.
    return [];
  }
}

/**
 * Read one payout and everything inside it.
 *
 * 🔴 Pages to the end. Stripe caps a list at 100 and a busy Monday payout after
 * a term opens carries more than that; a single page would silently drop the
 * tail and still balance-check as "close".
 */
export async function walkPayout(payoutId: string): Promise<WalkedPayout> {
  const payout = await stripe.payouts.retrieve(payoutId);

  const txns: Stripe.BalanceTransaction[] = [];
  let starting_after: string | undefined;
  for (;;) {
    let page: Stripe.ApiList<Stripe.BalanceTransaction>;
    try {
      page = await stripe.balanceTransactions.list({
        payout: payoutId, limit: 100, expand: ["data.source"], ...(starting_after ? { starting_after } : {}),
      });
    } catch (e: any) {
      // 🔴 Stripe refuses this listing for an auto-debit — a payout that takes
      // money OUT of the bank to cover a negative balance. It is a real event on
      // this account (found while walking 30 payouts) and it is not a sale, so it
      // is reported, never posted, and never silently treated as an empty payout.
      if (/auto-debit/i.test(e?.message ?? "")) {
        throw new PayoutNotSplittable(payoutId, "Stripe auto-debit: money taken from the bank to cover a negative balance. Code this one by hand.");
      }
      throw e;
    }
    txns.push(...page.data);
    if (!page.has_more) break;
    starting_after = page.data[page.data.length - 1].id;
  }

  // Collect the PaymentIntent behind each charge or refund.
  const piOf = (t: Stripe.BalanceTransaction): string | null => {
    const s: any = t.source;
    if (!s || typeof s === "string") return null;
    if (typeof s.payment_intent === "string") return s.payment_intent;
    if (s.payment_intent?.id) return s.payment_intent.id;
    // A refund points at its charge; the charge carries the PaymentIntent.
    if (typeof s.charge === "object" && s.charge?.payment_intent) return s.charge.payment_intent;
    return null;
  };

  const ids = Array.from(new Set(txns.map(piOf).filter((x): x is string => !!x)));
  const resolved = await resolvePaymentIntents(ids);

  // 🔴 SECOND STAGE — a subscription renewal is NOT stored on the registration.
  // Only the FIRST payment's PaymentIntent is; every weekly charge after it is a
  // new PaymentIntent nothing in ClubOS has ever seen. Verified live: the MFL
  // weekly charges in payout po_1UDNiZ… resolved to nothing at stage one, while
  // their subscription carried `registrationId` in its own metadata all along.
  // Without this, every league weekly payment would file as uncoded forever.
  const stillUnknown = ids.filter(i => !resolved.has(i));
  if (stillUnknown.length) {
    const extra = await resolveViaSubscriptions(stillUnknown, txns, piOf);
    for (const [pi, rec] of Array.from(extra.entries())) resolved.set(pi, rec);
  }

  const rules = await loadRules();
  // Longest match first (loadRules orders by length), so a specific rule beats a
  // general one rather than whichever happened to be inserted first.
  const applyRules = (desc: string | null): XeroCategoryKey | null => {
    if (!desc) return null;
    for (const r of rules) if (r.kind === "description_prefix" && desc.startsWith(r.value)) return r.category;
    return null;
  };

  const items: WalkedItem[] = [];
  let stripeChargeCents = 0;

  // 🔴 A batch can contain MORE THAN ONE payout row. When an earlier payout is
  // reversed (a failed bank transfer), the money comes back inside a later
  // batch as a second payout row, and it is not revenue — it is a transfer
  // returning. Found on po_1U68BI…, a refund-heavy day where ignoring it made
  // the split read −$604.48 against a real payout of $1,136.51. Skipping "the
  // payout row" by TYPE alone silently loses it; only this payout's OWN row is
  // the transfer being explained.
  let reversalCents = 0;
  for (const t of txns) {
    if (t.type !== "payout") continue;
    const srcId = typeof t.source === "string" ? t.source : (t.source as any)?.id;
    if (srcId === payoutId) continue;
    reversalCents += t.net;
  }

  for (const t of txns) {
    // This payout's own row is the transfer to the bank, not something sold.
    if (t.type === "payout") continue;
    // Stripe's own charges (billing, payout fees) are not a sale and have no
    // ClubOS record; they go straight to the fee line.
    if (t.type === "stripe_fee" || t.type === "adjustment" || t.type === "payout_failure") {
      stripeChargeCents += -t.net;
      continue;
    }
    const pi = piOf(t);
    const rec = pi ? resolved.get(pi) ?? null : null;
    const description: string | null = (t.source as any)?.description ?? null;
    // A ClubOS record always wins; a rule only speaks for what ClubOS cannot own.
    const category = rec ? categoriseResolved(rec) : (applyRules(description) ?? "unallocated");
    items.push({
      balanceTxnId: t.id, type: t.type, paymentIntentId: pi,
      grossCents: t.amount, feeCents: t.fee,
      category, resolved: rec, description,
    });
  }

  const split = buildSplit({
    payoutId: payout.id, currency: payout.currency.toUpperCase(),
    arrivalDate: new Date(payout.arrival_date * 1000).toISOString().slice(0, 10),
    payoutCents: payout.amount,
    items: items.map(i => ({ category: i.category, grossCents: i.grossCents, feeCents: i.feeCents })),
    stripeChargeCents, reversalCents,
  });

  return { split, items };
}

/** Payouts that have actually landed, newest first. */
export async function listRecentPayouts(limit = 10) {
  const res = await stripe.payouts.list({ limit, status: "paid" });
  return res.data.map(p => ({
    id: p.id, amountCents: p.amount, currency: p.currency.toUpperCase(),
    arrivalDate: new Date(p.arrival_date * 1000).toISOString().slice(0, 10),
  }));
}
