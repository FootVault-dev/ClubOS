// ─────────────────────────────────────────────────────────────────────────────
// Stripe Payouts — explain every bulk bank deposit.
//
// Stripe batches a day's card takings into one bank payout, so the club's bank
// statement shows "STRIPE $3,412.18" with no clue which programmes, players or
// parents are inside it. This tab answers that: list every payout on the
// account, then break a payout into its balance transactions and resolve each
// charge back to the ClubOS record that created it — programme + player +
// parent for registrations, order + customer for the shops, invoice number +
// recipient for USG invoices, and so on.
//
// Two Stripe accounts, matching the two clients that exist in this codebase:
//   club — server/stripe.ts      (CUFC/USG: registrations, MFL, shops, invoices…)
//   cugc — server/cugc-stripe.ts (United Gymnastics: its own account + tables)
//
// READ-ONLY by design: nothing here writes to Stripe or the database, and there
// is no migration — names come from rows other flows already store. Resolution
// is by payment-intent id first (registrations, split_members, members,
// shop_orders, facility_bookings, usg_invoices, print_orders all store theirs),
// charge metadata second (registrationId / kind:"invoice" / shopOrderId /
// printOrderId / splitSessionId / kind:"adspace"…), and for weekly-plan
// subscription charges via Stripe invoice → subscription id →
// registrations.stripe_subscription_id.
//
// Routes (session + the "payouts" tab — SUPER_ADMIN_ONLY_TABS: a payout line
// names families next to amounts, same class of data as invoices/housing):
//   GET /api/admin/payouts        ?account=club|cugc&starting_after=po_…
//   GET /api/admin/payouts/:id    ?account=club|cugc
//   GET /api/admin/payouts/upcoming ?account=club|cugc  — what has not landed yet
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import type Stripe from "stripe";
import { inArray, or } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireTab } from "./auth";
import { stripe } from "./stripe";
import { cugcStripe } from "./cugc-stripe";
import { subscriptionIdFromInvoice } from "@shared/league-weekly";
import {
  registrations,
  contacts,
  programs,
  splitMembers,
  splitSessions,
  members,
  shopOrders,
  facilityBookings,
  facilities,
  usgInvoices,
  printOrders,
  cugcRegistrations,
  organizations,
} from "@shared/schema";

type AccountKey = "club" | "cugc";

function accountFrom(req: Request): AccountKey {
  return req.query.account === "cugc" ? "cugc" : "club";
}

function stripeFor(key: AccountKey): Stripe | null {
  if (key === "cugc") return process.env.CUGC_STRIPE_SECRET_KEY ? cugcStripe : null;
  return process.env.STRIPE_SECRET_KEY ? stripe : null;
}

function accountsSummary() {
  return [
    { key: "club" as const, label: "Club (CUFC / USG)", available: Boolean(process.env.STRIPE_SECRET_KEY) },
    { key: "cugc" as const, label: "Gymnastics (CUGC)", available: Boolean(process.env.CUGC_STRIPE_SECRET_KEY) },
  ];
}

// NZ wall-clock for "when did this family pay" — server-rendered so the client
// never round-trips a date through a JS Date (house rule).
const NZ_WHEN = new Intl.DateTimeFormat("en-NZ", {
  timeZone: "Pacific/Auckland",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const nzWhen = (unixSeconds: number) => NZ_WHEN.format(new Date(unixSeconds * 1000));

// Stripe pins payout arrival_date to 00:00 UTC of the arrival CALENDAR date, so
// the UTC slice IS the intended date — converting to Pacific/Auckland would
// print the following day. (Deliberate exception to the usual NZ conversion.)
const arrivalIso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

interface ResolvedRef {
  source:
    | "registration"
    | "membership"
    | "shop"
    | "invoice"
    | "split"
    | "facility"
    | "print"
    | "cugc"
    | "adspace"
    | "stripe";
  programme: string;
  player: string | null;
  parent: string | null;
  detail: string | null;
}

const fullName = (c: { firstName: string | null; lastName: string | null } | undefined | null) =>
  c ? [c.firstName, c.lastName].filter(Boolean).join(" ") || null : null;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function orgNames(ids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(inArray(organizations.id, Array.from(new Set(ids))));
  for (const r of rows) map.set(r.id, r.name);
  return map;
}

/** Everything the CLUB account can explain, keyed by payment-intent id. Also
 *  returns a subscription-id → ref map for weekly-plan invoice charges. */
async function resolveClubByPaymentIntent(piIds: string[]) {
  const byPi = new Map<string, ResolvedRef>();
  const bySubscription = new Map<string, ResolvedRef>();
  if (piIds.length === 0) return { byPi, bySubscription };

  for (const ids of chunk(Array.from(new Set(piIds)), 200)) {
    // 1. Registrations — camps, academy, classes, MFL teams (deposit + balance PI).
    const regs = await db
      .select()
      .from(registrations)
      .where(or(inArray(registrations.stripePaymentIntentId, ids), inArray(registrations.balancePaymentIntentId, ids)));
    if (regs.length > 0) {
      const contactIds = new Set<number>();
      const programIds = new Set<number>();
      for (const r of regs) {
        contactIds.add(r.contactId);
        if (r.guardianId) contactIds.add(r.guardianId);
        programIds.add(r.programId);
      }
      const contactRows = await db
        .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName })
        .from(contacts)
        .where(inArray(contacts.id, Array.from(contactIds)));
      const contactById = new Map(contactRows.map((c) => [c.id, c]));
      const programRows = await db
        .select({ id: programs.id, name: programs.name })
        .from(programs)
        .where(inArray(programs.id, Array.from(programIds)));
      const programById = new Map(programRows.map((p) => [p.id, p.name]));
      for (const r of regs) {
        const ref: ResolvedRef = {
          source: "registration",
          programme: programById.get(r.programId) ?? `Programme #${r.programId}`,
          player: fullName(contactById.get(r.contactId)),
          parent: r.guardianId ? fullName(contactById.get(r.guardianId)) : null,
          detail: r.teamName ? `Team ${r.teamName}` : null,
        };
        if (r.stripePaymentIntentId) byPi.set(r.stripePaymentIntentId, ref);
        if (r.balancePaymentIntentId) byPi.set(r.balancePaymentIntentId, { ...ref, detail: ref.detail ? `${ref.detail} · balance instalment` : "Balance instalment" });
        if (r.stripeSubscriptionId) bySubscription.set(r.stripeSubscriptionId, { ...ref, detail: ref.detail ? `${ref.detail} · weekly plan` : "Weekly plan" });
      }
    }

    // 2. MFL Player Pay — each squad member's share is its own charge.
    const splits = await db.select().from(splitMembers).where(inArray(splitMembers.stripePaymentIntentId, ids));
    if (splits.length > 0) {
      const sessionRows = await db
        .select({ id: splitSessions.id, teamName: splitSessions.teamName })
        .from(splitSessions)
        .where(inArray(splitSessions.id, Array.from(new Set(splits.map((s) => s.splitSessionId)))));
      const sessionById = new Map(sessionRows.map((s) => [s.id, s]));
      for (const m of splits) {
        if (!m.stripePaymentIntentId) continue;
        const session = sessionById.get(m.splitSessionId);
        byPi.set(m.stripePaymentIntentId, {
          source: "split",
          programme: "MFL Player Pay",
          player: m.name || m.email,
          parent: null,
          detail: session?.teamName ? `Team ${session.teamName}` : null,
        });
      }
    }

    // 3. Memberships (SIU/CUFC join pages).
    const memberRows = await db.select().from(members).where(inArray(members.stripePaymentIntentId, ids));
    if (memberRows.length > 0) {
      const orgs = await orgNames(memberRows.map((m) => m.organizationId));
      for (const m of memberRows) {
        if (!m.stripePaymentIntentId) continue;
        byPi.set(m.stripePaymentIntentId, {
          source: "membership",
          programme: `${orgs.get(m.organizationId) ?? "Club"} membership${m.tierName ? ` — ${m.tierName}` : ""}`,
          player: m.name,
          parent: null,
          detail: null,
        });
      }
    }

    // 4. Shop orders (MFL + CIC native stores).
    const orders = await db.select().from(shopOrders).where(inArray(shopOrders.stripePaymentIntentId, ids));
    if (orders.length > 0) {
      const orgs = await orgNames(orders.map((o) => o.organizationId));
      for (const o of orders) {
        if (!o.stripePaymentIntentId) continue;
        byPi.set(o.stripePaymentIntentId, {
          source: "shop",
          programme: `${orgs.get(o.organizationId) ?? "Club"} store — order #${o.id}`,
          player: [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email,
          parent: null,
          detail: null,
        });
      }
    }

    // 5. Facility hire (USC pitches, cages, rooms).
    const bookings = await db.select().from(facilityBookings).where(inArray(facilityBookings.stripePaymentIntentId, ids));
    if (bookings.length > 0) {
      const facRows = await db
        .select({ id: facilities.id, name: facilities.name })
        .from(facilities)
        .where(inArray(facilities.id, Array.from(new Set(bookings.map((b) => b.facilityId)))));
      const facById = new Map(facRows.map((f) => [f.id, f.name]));
      for (const b of bookings) {
        if (!b.stripePaymentIntentId) continue;
        byPi.set(b.stripePaymentIntentId, {
          source: "facility",
          programme: `Facility hire — ${facById.get(b.facilityId) ?? "USC"}`,
          player: b.customerName,
          parent: null,
          detail: null,
        });
      }
    }

    // 6. USG invoices (the payable invoice pages).
    const invoiceRows = await db.select().from(usgInvoices).where(inArray(usgInvoices.stripePaymentIntentId, ids));
    for (const inv of invoiceRows) {
      if (!inv.stripePaymentIntentId) continue;
      byPi.set(inv.stripePaymentIntentId, {
        source: "invoice",
        programme: `Invoice ${inv.number} — ${inv.title}`,
        player: inv.recipientName,
        parent: null,
        detail: null,
      });
    }

    // 7. United Print orders paid by card.
    const prints = await db.select().from(printOrders).where(inArray(printOrders.stripePaymentIntentId, ids));
    for (const p of prints) {
      if (!p.stripePaymentIntentId) continue;
      byPi.set(p.stripePaymentIntentId, {
        source: "print",
        programme: `United Print — ${p.title}`,
        player: p.customerName,
        parent: null,
        detail: p.customerCompany ?? null,
      });
    }
  }

  return { byPi, bySubscription };
}

/** Stripe's own account-level lines (its Billing usage fee, adjustments…) —
 *  labelled explicitly so they never render as mystery customer payments
 *  (Daniel, 2026-07-24: "no mystery payments"). */
function describeOther(t: Stripe.BalanceTransaction): ResolvedRef {
  const verbatim = t.description ?? t.type;
  if (t.type === "stripe_fee" || t.reporting_category === "fee") {
    const isBilling = (t.description ?? "").toLowerCase().includes("billing");
    return {
      source: "stripe",
      programme: isBilling ? "Stripe Billing usage fee" : "Stripe fee",
      player: null,
      parent: null,
      detail: isBilling
        ? `${verbatim} · Stripe's own charge for running the weekly payment plans — not a customer payment`
        : `${verbatim} · Stripe's own charge — not a customer payment`,
    };
  }
  return {
    source: "stripe",
    programme: `Stripe ${(t.reporting_category ?? t.type).replace(/_/g, " ")}`,
    player: null,
    parent: null,
    detail: `${verbatim} · Stripe account movement — not a customer payment`,
  };
}

/** Registrations behind weekly-plan subscription ids, looked up DIRECTLY by
 *  subscription id. A week-N subscription charge carries no payment intent
 *  the DB knows (only the deposit/balance PIs are stored), so the PI-derived
 *  bySubscription map almost never contains it — before this lookup every
 *  MFL weekly line rendered as "Subscription update · not matched". */
async function resolveClubBySubscriptionIds(subIds: string[]): Promise<Map<string, ResolvedRef>> {
  const bySub = new Map<string, ResolvedRef>();
  if (subIds.length === 0) return bySub;
  const regs = await db.select().from(registrations).where(inArray(registrations.stripeSubscriptionId, subIds));
  if (regs.length > 0) {
    const contactIds = new Set<number>();
    const programIds = new Set<number>();
    for (const r of regs) {
      contactIds.add(r.contactId);
      if (r.guardianId) contactIds.add(r.guardianId);
      programIds.add(r.programId);
    }
    const contactRows = await db
      .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName })
      .from(contacts)
      .where(inArray(contacts.id, Array.from(contactIds)));
    const contactById = new Map(contactRows.map((c) => [c.id, c]));
    const programRows = await db
      .select({ id: programs.id, name: programs.name })
      .from(programs)
      .where(inArray(programs.id, Array.from(programIds)));
    const programById = new Map(programRows.map((p) => [p.id, p.name]));
    for (const r of regs) {
      if (!r.stripeSubscriptionId) continue;
      bySub.set(r.stripeSubscriptionId, {
        source: "registration",
        programme: programById.get(r.programId) ?? `Programme #${r.programId}`,
        player: fullName(contactById.get(r.contactId)),
        parent: r.guardianId ? fullName(contactById.get(r.guardianId)) : null,
        detail: r.teamName ? `Team ${r.teamName} · weekly plan` : "Weekly plan",
      });
    }
  }
  // Weekly venue hire ("Pay weekly" bookings) stores its subscription too.
  const remaining = subIds.filter((s) => !bySub.has(s));
  if (remaining.length > 0) {
    const bookings = await db.select().from(facilityBookings).where(inArray(facilityBookings.stripeSubscriptionId, remaining));
    if (bookings.length > 0) {
      const facRows = await db
        .select({ id: facilities.id, name: facilities.name })
        .from(facilities)
        .where(inArray(facilities.id, Array.from(new Set(bookings.map((b) => b.facilityId)))));
      const facById = new Map(facRows.map((f) => [f.id, f.name]));
      for (const b of bookings) {
        if (!b.stripeSubscriptionId || bySub.has(b.stripeSubscriptionId)) continue;
        bySub.set(b.stripeSubscriptionId, {
          source: "facility",
          programme: `Facility hire — ${facById.get(b.facilityId) ?? "USC"}`,
          player: b.customerName,
          parent: null,
          detail: "Weekly plan",
        });
      }
    }
  }
  return bySub;
}

/** CUGC has its own Stripe account and its own enrolment table. */
async function resolveCugcByPaymentIntent(piIds: string[]) {
  const byPi = new Map<string, ResolvedRef>();
  if (piIds.length === 0) return byPi;
  for (const ids of chunk(Array.from(new Set(piIds)), 200)) {
    const rows = await db.select().from(cugcRegistrations).where(inArray(cugcRegistrations.stripePaymentIntent, ids));
    for (const r of rows) {
      if (!r.stripePaymentIntent) continue;
      byPi.set(r.stripePaymentIntent, {
        source: "cugc",
        programme: `${r.programName} — ${r.optionLabel}${r.term ? ` (${r.term})` : ""}`,
        player: r.gymnastName,
        parent: r.parentName,
        detail: null,
      });
    }
  }
  return byPi;
}

/** Second chance: charges whose PI never got written back to a row (rare —
 *  e.g. a lost webhook) but whose metadata names the record. */
async function resolveClubByMetadata(
  unresolved: Array<{ chargeId: string; metadata: Record<string, string> }>,
): Promise<Map<string, ResolvedRef>> {
  const byCharge = new Map<string, ResolvedRef>();
  const regIds: number[] = [];
  const shopIds: number[] = [];
  const printIds: number[] = [];
  const memberIds: number[] = [];
  const invoiceTokens: string[] = [];

  for (const u of unresolved) {
    const m = u.metadata;
    if (m.kind === "adspace") {
      byCharge.set(u.chargeId, { source: "adspace", programme: "USC AdSpace booking", player: null, parent: null, detail: null });
      continue;
    }
    // CIC Content Marketplace (kids' photo storefront) — orders live in a
    // separate app's store, not this DB; its metadata names the order. The
    // payer column falls back to the charge's billing details in the UI.
    if (typeof m.order_number === "string" && m.order_number.startsWith("CICP-")) {
      const qty = Number(m.qty);
      byCharge.set(u.chargeId, {
        source: "shop",
        programme: `CIC Content Marketplace — ${m.order_number}`,
        player: null,
        parent: null,
        detail: Number.isFinite(qty) && qty > 0 ? `${qty} photo${qty === 1 ? "" : "s"}` : null,
      });
      continue;
    }
    if (m.kind === "invoice" && m.invoiceToken) invoiceTokens.push(m.invoiceToken);
    else if (m.kind === "membership" && m.memberId && Number.isFinite(Number(m.memberId))) memberIds.push(Number(m.memberId));
    else if (m.shopOrderId && Number.isFinite(Number(m.shopOrderId))) shopIds.push(Number(m.shopOrderId));
    else if (m.printOrderId && Number.isFinite(Number(m.printOrderId))) printIds.push(Number(m.printOrderId));
    else if (m.registrationId && Number.isFinite(Number(m.registrationId))) regIds.push(Number(m.registrationId));
  }

  const regById = new Map<number, ResolvedRef>();
  if (regIds.length > 0) {
    const regs = await db.select().from(registrations).where(inArray(registrations.id, Array.from(new Set(regIds))));
    const contactIds = new Set<number>();
    const programIds = new Set<number>();
    for (const r of regs) {
      contactIds.add(r.contactId);
      if (r.guardianId) contactIds.add(r.guardianId);
      programIds.add(r.programId);
    }
    const contactRows = contactIds.size
      ? await db
          .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName })
          .from(contacts)
          .where(inArray(contacts.id, Array.from(contactIds)))
      : [];
    const contactById = new Map(contactRows.map((c) => [c.id, c]));
    const programRows = programIds.size
      ? await db.select({ id: programs.id, name: programs.name }).from(programs).where(inArray(programs.id, Array.from(programIds)))
      : [];
    const programById = new Map(programRows.map((p) => [p.id, p.name]));
    for (const r of regs) {
      regById.set(r.id, {
        source: "registration",
        programme: programById.get(r.programId) ?? `Programme #${r.programId}`,
        player: fullName(contactById.get(r.contactId)),
        parent: r.guardianId ? fullName(contactById.get(r.guardianId)) : null,
        detail: r.teamName ? `Team ${r.teamName}` : null,
      });
    }
  }

  const shopById = new Map<number, ResolvedRef>();
  if (shopIds.length > 0) {
    const orders = await db.select().from(shopOrders).where(inArray(shopOrders.id, Array.from(new Set(shopIds))));
    const orgs = await orgNames(orders.map((o) => o.organizationId));
    for (const o of orders) {
      shopById.set(o.id, {
        source: "shop",
        programme: `${orgs.get(o.organizationId) ?? "Club"} store — order #${o.id}`,
        player: [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email,
        parent: null,
        detail: null,
      });
    }
  }

  const printById = new Map<number, ResolvedRef>();
  if (printIds.length > 0) {
    const prints = await db.select().from(printOrders).where(inArray(printOrders.id, Array.from(new Set(printIds))));
    for (const p of prints) {
      printById.set(p.id, { source: "print", programme: `United Print — ${p.title}`, player: p.customerName, parent: null, detail: p.customerCompany ?? null });
    }
  }

  const memberById = new Map<number, ResolvedRef>();
  if (memberIds.length > 0) {
    const rows = await db.select().from(members).where(inArray(members.id, Array.from(new Set(memberIds))));
    const orgs = await orgNames(rows.map((m) => m.organizationId));
    for (const m of rows) {
      memberById.set(m.id, {
        source: "membership",
        programme: `${orgs.get(m.organizationId) ?? "Club"} membership${m.tierName ? ` — ${m.tierName}` : ""}`,
        player: m.name,
        parent: null,
        detail: null,
      });
    }
  }

  const invoiceByToken = new Map<string, ResolvedRef>();
  if (invoiceTokens.length > 0) {
    const rows = await db.select().from(usgInvoices).where(inArray(usgInvoices.token, Array.from(new Set(invoiceTokens))));
    for (const inv of rows) {
      invoiceByToken.set(inv.token, { source: "invoice", programme: `Invoice ${inv.number} — ${inv.title}`, player: inv.recipientName, parent: null, detail: null });
    }
  }

  for (const u of unresolved) {
    if (byCharge.has(u.chargeId)) continue;
    const m = u.metadata;
    const ref =
      (m.kind === "invoice" && m.invoiceToken && invoiceByToken.get(m.invoiceToken)) ||
      (m.kind === "membership" && m.memberId && memberById.get(Number(m.memberId))) ||
      (m.shopOrderId && shopById.get(Number(m.shopOrderId))) ||
      (m.printOrderId && printById.get(Number(m.printOrderId))) ||
      (m.registrationId && regById.get(Number(m.registrationId))) ||
      null;
    if (ref) byCharge.set(u.chargeId, ref);
  }
  return byCharge;
}

/** The whole detail build — exported so script/_test-payouts.ts can exercise
 *  the exact production code path read-only against real data. */
export async function explainPayout(client: Stripe, account: AccountKey, id: string) {
  const payout = await client.payouts.retrieve(id);

  // Page through every balance transaction inside the payout (a bulk term-
  // start payout can easily carry hundreds of charges). Hard cap at 1,000
  // rows — flagged as truncated rather than silently dropped.
  const txns: Stripe.BalanceTransaction[] = [];
  let after: string | undefined;
  let truncated = false;
  for (let page = 0; page < 10; page++) {
    const batch = await client.balanceTransactions.list({
      payout: id,
      limit: 100,
      expand: ["data.source"],
      ...(after ? { starting_after: after } : {}),
    });
    txns.push(...batch.data);
    if (!batch.has_more) break;
    after = batch.data[batch.data.length - 1]?.id;
    if (page === 9 && batch.has_more) truncated = true;
  }

  // Partition. The payout's own negative transaction is excluded from lines.
  interface ChargeInfo {
    txn: Stripe.BalanceTransaction;
    kind: "charge" | "refund";
    chargeId: string | null;
    paymentIntentId: string | null;
    invoiceId: string | null;
    description: string | null;
    metadata: Record<string, string>;
    payerName: string | null;
    payerEmail: string | null;
  }
  const money: ChargeInfo[] = [];
  const other: Stripe.BalanceTransaction[] = [];
  for (const t of txns) {
    if (t.type === "payout") continue;
    const src = t.source && typeof t.source === "object" ? (t.source as any) : null;
    if (t.type === "charge" || t.type === "payment") {
      const charge = src as Stripe.Charge | null;
      money.push({
        txn: t,
        kind: "charge",
        chargeId: charge?.id ?? (typeof t.source === "string" ? t.source : null),
        paymentIntentId: typeof charge?.payment_intent === "string" ? charge.payment_intent : charge?.payment_intent?.id ?? null,
        invoiceId: typeof (charge as any)?.invoice === "string" ? (charge as any).invoice : null,
        description: charge?.description ?? t.description ?? null,
        metadata: (charge?.metadata as Record<string, string>) ?? {},
        payerName: charge?.billing_details?.name ?? null,
        payerEmail: charge?.billing_details?.email ?? charge?.receipt_email ?? null,
      });
    } else if (t.type === "refund" || t.type === "payment_refund") {
      const refund = src as Stripe.Refund | null;
      money.push({
        txn: t,
        kind: "refund",
        chargeId: typeof refund?.charge === "string" ? refund.charge : (refund?.charge as Stripe.Charge | null)?.id ?? null,
        paymentIntentId: typeof refund?.payment_intent === "string" ? refund.payment_intent : (refund?.payment_intent as any)?.id ?? null,
        invoiceId: null,
        description: t.description ?? "Refund",
        metadata: (refund?.metadata as Record<string, string>) ?? {},
        payerName: null,
        payerEmail: null,
      });
    } else {
      other.push(t);
    }
  }

  // Resolve to ClubOS records.
  const piIds = money.map((m) => m.paymentIntentId).filter((x): x is string => Boolean(x));
  let byPi: Map<string, ResolvedRef>;
  let bySubscription = new Map<string, ResolvedRef>();
  if (account === "cugc") {
    byPi = await resolveCugcByPaymentIntent(piIds);
  } else {
    const r = await resolveClubByPaymentIntent(piIds);
    byPi = r.byPi;
    bySubscription = r.bySubscription;
  }

  const resolvedByCharge = new Map<string, ResolvedRef>();
  for (const m of money) {
    const ref = m.paymentIntentId ? byPi.get(m.paymentIntentId) : undefined;
    if (ref && m.chargeId) resolvedByCharge.set(m.chargeId, ref);
  }

  // Metadata fallback for anything the PI join didn't name (club account only —
  // the CUGC account's metadata ids point at cugc_registrations, already tried).
  // DB-only and cheap, so it runs BEFORE the per-charge Stripe lookups below.
  if (account === "club") {
    const unresolved = money
      .filter((m) => m.chargeId && !resolvedByCharge.has(m.chargeId) && Object.keys(m.metadata).length > 0)
      .map((m) => ({ chargeId: m.chargeId as string, metadata: m.metadata }));
    if (unresolved.length > 0) {
      const metaRefs = await resolveClubByMetadata(unresolved);
      metaRefs.forEach((ref, chargeId) => resolvedByCharge.set(chargeId, ref));
    }
  }

  // Weekly-plan subscription charges (MFL weekly teams, weekly venue hire):
  // the registration/booking stores a SUBSCRIPTION id, and a week-N charge
  // carries no payment intent the DB knows. 🔴 On the 2026-02-25.clover API
  // version BOTH legacy links are gone — `charge.invoice` no longer exists,
  // and `invoice.subscription` moved to parent.subscription_details (the
  // same trap the invoice.paid webhook hit, v349). The route that works:
  // charge → payment intent → InvoicePayment → invoice →
  // subscriptionIdFromInvoice() → registrations / facility_bookings.
  const needInvoice = money
    .filter((m) => m.kind === "charge" && m.chargeId && !resolvedByCharge.has(m.chargeId) && (m.invoiceId || m.paymentIntentId))
    .slice(0, 50); // bounded work — anything past the cap just stays unresolved
  if (needInvoice.length > 0) {
    const subByCharge = new Map<string, string>();
    const subByInvoice = new Map<string, string | null>();
    for (const m of needInvoice) {
      try {
        let invId = m.invoiceId;
        if (!invId && m.paymentIntentId) {
          const ip = await client.invoicePayments.list({
            payment: { type: "payment_intent", payment_intent: m.paymentIntentId },
            limit: 1,
          });
          const inv = ip.data[0]?.invoice;
          invId = typeof inv === "string" ? inv : inv?.id ?? null;
        }
        if (!invId) continue; // a plain one-off card charge — not an invoice payment
        let subId = subByInvoice.get(invId);
        if (subId === undefined) {
          const inv = await client.invoices.retrieve(invId);
          subId = subscriptionIdFromInvoice(inv) ?? null;
          subByInvoice.set(invId, subId);
        }
        if (subId && m.chargeId) subByCharge.set(m.chargeId, subId);
      } catch {
        // best-effort — an unreadable invoice just stays unresolved
      }
    }
    // A week-N charge's registration is NOT in this payout's PI set, so the
    // PI-derived bySubscription map almost never has it — look up directly.
    if (account === "club") {
      const missing = Array.from(new Set(subByCharge.values())).filter((s) => !bySubscription.has(s));
      const direct = await resolveClubBySubscriptionIds(missing);
      direct.forEach((ref, subId) => bySubscription.set(subId, ref));
    }
    for (const m of needInvoice) {
      const subId = m.chargeId ? subByCharge.get(m.chargeId) : undefined;
      const ref = subId ? bySubscription.get(subId) : undefined;
      if (ref && m.chargeId) resolvedByCharge.set(m.chargeId, ref);
    }
  }

  const lines = [
    ...money.map((m) => ({
      id: m.txn.id,
      kind: m.kind,
      when: nzWhen(m.txn.created),
      grossCents: m.txn.amount,
      feeCents: m.txn.fee,
      netCents: m.txn.net,
      description: m.description,
      payerName: m.payerName,
      payerEmail: m.payerEmail,
      resolved: (m.chargeId && resolvedByCharge.get(m.chargeId)) || null,
    })),
    ...other.map((t) => ({
      id: t.id,
      kind: "other" as const,
      when: nzWhen(t.created),
      grossCents: t.amount,
      feeCents: t.fee,
      netCents: t.net,
      description: t.description ?? t.type,
      payerName: null,
      payerEmail: null,
      resolved: describeOther(t),
    })),
  ];

  const charges = lines.filter((l) => l.kind === "charge");
  const refunds = lines.filter((l) => l.kind === "refund");
  const others = lines.filter((l) => l.kind === "other");

  // ── A negative payout has no lines of its own ───────────────────────────
  // Olga, 2026-08-20: "No splits for this transaction", on a -$1,740.99 payout.
  // Reproduced against Stripe: `balance_transactions?payout=po_…` returns ZERO
  // rows for it. That is not a bug in the query — a negative payout is Stripe
  // pulling money FROM the bank to square a balance the refunds pushed under
  // zero, so it has no payments attached. Stripe's own description says so:
  // "Withdrawal to cover a negative balance".
  //
  // Answering "nothing here" is useless to whoever is reconciling the bank: the
  // money left the account and they have to explain it. So we go and find what
  // actually caused it — the refunds in the days before it — and say so.
  let negativeBalance: {
    reason: string;
    windowFrom: string;
    causes: { when: string; type: string; amountCents: number; description: string | null }[];
    causeTotalCents: number;
  } | null = null;
  if (payout.amount < 0 && lines.length === 0) {
    const WINDOW_DAYS = 7;
    const from = payout.created - WINDOW_DAYS * 24 * 60 * 60;
    try {
      const around = await client.balanceTransactions.list({
        limit: 100,
        created: { gte: from, lte: payout.created },
      });
      const causes = around.data
        .filter((t) => t.amount < 0 && t.type !== "payout")
        .sort((a, b) => a.amount - b.amount)
        .map((t) => ({
          when: arrivalIso(t.created),
          type: t.type,
          amountCents: t.amount,
          description: t.description ?? null,
        }));
      negativeBalance = {
        reason: payout.description || "Withdrawal to cover a negative balance",
        windowFrom: arrivalIso(from),
        causes,
        causeTotalCents: causes.reduce((n, c) => n + c.amountCents, 0),
      };
    } catch {
      // Stripe unreachable for the window — still explain what the payout IS.
      negativeBalance = {
        reason: payout.description || "Withdrawal to cover a negative balance",
        windowFrom: arrivalIso(from), causes: [], causeTotalCents: 0,
      };
    }
  }

  return {
    negativeBalance,
    truncated,
    payout: {
      id: payout.id,
      amountCents: payout.amount,
      currency: payout.currency.toUpperCase(),
      status: payout.status,
      arrivalDate: arrivalIso(payout.arrival_date),
      createdAt: nzWhen(payout.created),
      automatic: payout.automatic,
      description: payout.description ?? null,
    },
    summary: {
      grossCents: charges.reduce((s, l) => s + l.grossCents, 0),
      feeCents: lines.reduce((s, l) => s + l.feeCents, 0),
      refundCents: refunds.reduce((s, l) => s + l.grossCents, 0),
      otherCents: others.reduce((s, l) => s + l.grossCents, 0),
      chargeCount: charges.length,
      refundCount: refunds.length,
      otherCount: others.length,
      resolvedCount: charges.filter((l) => l.resolved).length,
    },
    lines,
  };
}

export function registerPayoutRoutes(app: Express) {
  const tab = requireTab("payouts");

  // ── List payouts ──────────────────────────────────────────────────────────
  app.get("/api/admin/payouts", requireAuth, tab, async (req: Request, res: Response) => {
    try {
      const account = accountFrom(req);
      const client = stripeFor(account);
      if (!client) return res.json({ account, accounts: accountsSummary(), payouts: [], hasMore: false });

      const startingAfter =
        typeof req.query.starting_after === "string" && /^po_[A-Za-z0-9]+$/.test(req.query.starting_after)
          ? req.query.starting_after
          : undefined;
      const list = await client.payouts.list({ limit: 30, ...(startingAfter ? { starting_after: startingAfter } : {}) });
      res.json({
        account,
        accounts: accountsSummary(),
        hasMore: list.has_more,
        payouts: list.data.map((p) => ({
          id: p.id,
          amountCents: p.amount,
          currency: p.currency.toUpperCase(),
          status: p.status, // paid | in_transit | pending | failed | canceled
          arrivalDate: arrivalIso(p.arrival_date),
          createdAt: nzWhen(p.created),
          automatic: p.automatic,
          description: p.description ?? null,
        })),
      });
    } catch (error: any) {
      res.status(502).json({ message: `Stripe error: ${error?.message ?? "unknown"}` });
    }
  });

  // ── What is still to come ─────────────────────────────────────────────────
  // 🔴 Registered BEFORE "/:id". Express matches in order, so with the
  // parameterised route first, "upcoming" is parsed as a payout id and answered
  // 400 "Invalid payout id" — the same trap that once left View As with no way
  // out.
  //
  // Two different things, deliberately never added together:
  //
  //   inFlight  — payouts Stripe HAS created that have not reached the bank.
  //               A fact, with a real amount and a real arrival date.
  //   balance   — money taken on cards that Stripe has not turned into a payout
  //               yet. Real money, but it has NO arrival date and is NOT a
  //               payout. Presenting it as one would put a date on the page that
  //               Stripe has never promised.
  app.get("/api/admin/payouts/upcoming", requireAuth, tab, async (req: Request, res: Response) => {
    try {
      const account = accountFrom(req);
      const client = stripeFor(account);
      if (!client) {
        return res.json({
          account, configured: false, inFlight: [], inFlightCents: 0,
          pending: [], available: [], schedule: null,
        });
      }

      const [list, balance, acct] = await Promise.all([
        client.payouts.list({ limit: 100 }),
        client.balance.retrieve(),
        client.accounts.retrieve(),
      ]);

      // 🔴 Stripe's `status` query filter is SILENTLY IGNORED on this account —
      // asking for status:"in_transit" returns the same rows as no filter at
      // all, every one of them `paid`. Filtering server-side would have printed
      // "on its way to the bank" over deposits that landed a fortnight ago.
      // Filter on each row's OWN status, and never re-introduce the query param.
      const inFlight = list.data
        .filter((p) => p.status === "pending" || p.status === "in_transit")
        .map((p) => ({
          id: p.id,
          amountCents: p.amount,
          currency: p.currency.toUpperCase(),
          status: p.status,
          arrivalDate: arrivalIso(p.arrival_date),
          createdAt: nzWhen(p.created),
          automatic: p.automatic,
          description: p.description ?? null,
        }))
        .sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate));

      const money = (rows: Stripe.Balance["pending"]) =>
        rows.map((b) => ({ currency: b.currency.toUpperCase(), amountCents: b.amount }));

      const sch = (acct as any)?.settings?.payouts?.schedule ?? null;

      res.json({
        account,
        configured: true,
        inFlight,
        // Only ever the sum of REAL payouts. The balance is never folded in.
        inFlightCents: inFlight.reduce((t, p) => t + p.amountCents, 0),
        pending: money(balance.pending),
        available: money(balance.available),
        schedule: sch
          ? {
              interval: sch.interval ?? null,
              delayDays: typeof sch.delay_days === "number" ? sch.delay_days : null,
              weeklyAnchor: sch.weekly_anchor ?? null,
              monthlyAnchor: typeof sch.monthly_anchor === "number" ? sch.monthly_anchor : null,
            }
          : null,
        payoutsEnabled: Boolean((acct as any)?.payouts_enabled),
      });
    } catch (error: any) {
      res.status(502).json({ message: `Stripe error: ${error?.message ?? "unknown"}` });
    }
  });

  // ── One payout, broken into its transactions with names attached ──────────
  app.get("/api/admin/payouts/:id", requireAuth, tab, async (req: Request, res: Response) => {
    try {
      const account = accountFrom(req);
      const client = stripeFor(account);
      if (!client) return res.status(404).json({ message: "That Stripe account is not configured" });
      const id = String(req.params.id);
      if (!/^po_[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ message: "Invalid payout id" });

      const result = await explainPayout(client, account, id);
      res.json({ account, ...result });
    } catch (error: any) {
      const status = error?.statusCode === 404 ? 404 : 502;
      res.status(status).json({ message: `Stripe error: ${error?.message ?? "unknown"}` });
    }
  });
}
