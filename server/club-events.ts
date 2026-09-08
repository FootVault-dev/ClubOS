/**
 * Club Events — ticketed events. The first is the CUFC Club Dinner.
 *
 * Doctrine, cloned from Team Pay:
 *   - the amount is computed HERE from the ticket type on sale right now; the
 *     browser sends a quantity and its details, never a price;
 *   - paid state is read back from Stripe (confirm endpoint + webhook), never
 *     trusted from the browser, and flipped by an atomic UPDATE so a retry is a
 *     no-op rather than a second ticket;
 *   - capacity is the database's decision (trigger), not the page's;
 *   - the confirmation email IS the ticket — shown on a phone at the door.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import Stripe from "stripe";
import { db } from "./db";
import {
  clubEvents, clubEventTicketTypes, clubEventOrders, clubEventGuests, clubEventLog, users,
  type ClubEvent, type ClubEventTicketType, type ClubEventOrder, type ClubEventGuest,
} from "@shared/schema";
import {
  currentTicketType, nextTicketType, clampQuantity, normaliseEmail, isEmail, isPhone,
  PENDING_HOLD_MINUTES, dollars, nzLongDate, nzClock, nzShortDate, clubEventBrand,
  type StripeAccountKey,
} from "@shared/club-events";
import { ONLINE_PAYMENT_METHOD, isOfficePaymentMethod } from "@shared/payments";
import { stripe as clubStripe } from "./stripe";
import { sendEmail, cufcShellWrap, cufcInfoRow, CUFC_FROM, CUFC_REPLY_TO } from "./email";
import { sendPurchaseEvent } from "./meta-capi";

const PUBLIC_BASE_URL = process.env.CLUB_EVENTS_PUBLIC_URL || "https://join.cufc.co.nz";
export function eventUrl(slug: string) { return `${PUBLIC_BASE_URL}/events/${slug}`; }
export function orderUrl(slug: string, token: string) { return `${PUBLIC_BASE_URL}/events/${slug}/order/${token}`; }

const token = () => randomBytes(16).toString("hex");
const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── Stripe, per event ────────────────────────────────────────────────────────
// 'club' is the club's own account (the one every other ClubOS checkout uses).
// 'trust' is the Cross Street Football Trust's — Malcolm's ring-fence — keyed by
// its own env so a club key can never be picked up by accident. If the trust
// keys are missing, selling REFUSES rather than quietly charging the club.
let trustStripe: Stripe | null = null;
export function stripeFor(account: string): { stripe: Stripe; publishableKey: string | null; ok: boolean; reason?: string } {
  if (account === "trust") {
    const sk = process.env.CLUB_EVENTS_TRUST_STRIPE_SECRET_KEY;
    const pk = process.env.CLUB_EVENTS_TRUST_STRIPE_PUBLISHABLE_KEY || null;
    if (!sk || !pk) return { stripe: clubStripe, publishableKey: null, ok: false, reason: "Trust Stripe keys are not configured." };
    if (!trustStripe) trustStripe = new Stripe(sk, { apiVersion: "2025-04-30.basil" as any });
    return { stripe: trustStripe, publishableKey: pk, ok: true };
  }
  // The club key: the browser falls back to its build-time VITE key when this
  // is null at runtime, so both paths reach the same account.
  return { stripe: clubStripe, publishableKey: process.env.VITE_STRIPE_PUBLISHABLE_KEY || null, ok: !!process.env.STRIPE_SECRET_KEY, reason: "Stripe is not configured." };
}

// ── reads ────────────────────────────────────────────────────────────────────
export async function eventBySlug(slug: string): Promise<ClubEvent | undefined> {
  const [e] = await db.select().from(clubEvents).where(eq(clubEvents.slug, slug));
  return e;
}
export async function eventById(id: number): Promise<ClubEvent | undefined> {
  const [e] = await db.select().from(clubEvents).where(eq(clubEvents.id, id));
  return e;
}
export async function typesOf(eventId: number): Promise<ClubEventTicketType[]> {
  return db.select().from(clubEventTicketTypes).where(eq(clubEventTicketTypes.eventId, eventId)).orderBy(clubEventTicketTypes.sort, clubEventTicketTypes.priceCents);
}
export async function guestsOf(orderId: number): Promise<ClubEventGuest[]> {
  return db.select().from(clubEventGuests).where(eq(clubEventGuests.orderId, orderId)).orderBy(clubEventGuests.seatNo);
}

/** Seats held right now: paid, plus pending orders younger than the hold. Same rule as the trigger. */
export async function seatsTaken(eventId: number): Promise<number> {
  const r = await db.execute(sql`
    select coalesce(sum(quantity), 0)::int as taken from club_event_orders
    where event_id = ${eventId}
      and (status = 'paid' or (status = 'pending' and created_at > now() - make_interval(mins => ${PENDING_HOLD_MINUTES})))`);
  return Number((r.rows[0] as any)?.taken ?? 0);
}

/** What the public page gets. Never the org id, never Stripe secrets, never other buyers. */
export async function publicEvent(e: ClubEvent, now = new Date()) {
  const types = await typesOf(e.id);
  const current = currentTicketType(types, now);
  const next = nextTicketType(types, now);
  const taken = e.capacity != null ? await seatsTaken(e.id) : null;
  const seatsLeft = e.capacity != null && taken != null ? Math.max(0, e.capacity - taken) : null;
  const acct = stripeFor(e.stripeAccount);
  const brand = clubEventBrand(e.brand);
  return {
    event: {
      slug: e.slug, name: e.name, tagline: e.tagline, description: e.description, includes: e.includes ?? [],
      brand: e.brand, venueName: e.venueName, venueAddress: e.venueAddress,
      startsAt: e.startsAt, endsAt: e.endsAt, tableSize: e.tableSize, maxPerOrder: e.maxPerOrder,
      ageRestriction: e.ageRestriction, status: e.status, contactEmail: e.contactEmail, paymentNote: e.paymentNote,
      currency: e.currency, siteName: brand.siteName, siteUrl: brand.siteUrl,
    },
    pricing: {
      current: current ? { id: current.id, name: current.name, priceCents: current.priceCents, salesEnd: current.salesEnd } : null,
      next: next ? { id: next.id, name: next.name, priceCents: next.priceCents, salesStart: next.salesStart } : null,
      allTypes: types.filter((t) => t.isActive).map((t) => ({ name: t.name, priceCents: t.priceCents, salesStart: t.salesStart, salesEnd: t.salesEnd })),
    },
    seatsLeft,
    soldOut: seatsLeft === 0,
    selling: e.status === "open" && !!current && seatsLeft !== 0 && acct.ok,
    stripePublishableKey: acct.publishableKey,
  };
}

// ── log ──────────────────────────────────────────────────────────────────────
export async function logEvent(p: { eventId: number; orderId?: number | null; kind: string; actor: "buyer" | "staff" | "stripe" | "system"; actorUserId?: number | null; detail?: unknown }) {
  try {
    await db.insert(clubEventLog).values({ eventId: p.eventId, orderId: p.orderId ?? null, kind: p.kind, actor: p.actor, actorUserId: p.actorUserId ?? null, detail: p.detail ?? null });
  } catch (e) { console.error("[club-events] log failed:", e); }
}

// ── buying ───────────────────────────────────────────────────────────────────
export interface GuestInput { fullName?: string | null; dietary?: string | null }
export interface BuyInput {
  quantity: unknown;
  buyerName: unknown; buyerEmail: unknown; buyerPhone: unknown;
  tableName?: unknown; buyerNotes?: unknown; guests?: unknown;
  ageConfirmed?: unknown;
  orderToken?: unknown;
  source?: unknown; sourceUrl?: unknown; fbp?: unknown; fbc?: unknown;
}
type Meta = { userAgent?: string; ip?: string };

function cleanGuests(raw: unknown, quantity: number): GuestInput[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: GuestInput[] = [];
  for (let i = 0; i < quantity; i++) {
    const g = (list[i] ?? {}) as any;
    const fullName = String(g?.fullName ?? "").trim().slice(0, 120) || null;
    const dietary = String(g?.dietary ?? "").trim().slice(0, 300) || null;
    out.push({ fullName, dietary });
  }
  return out;
}

/**
 * Start a purchase: validate, pick the ticket type on sale NOW, hold the seats
 * (a pending order — the trigger refuses it if the room is full), mint the
 * PaymentIntent on the right account. Returns the client secret.
 */
export async function beginOrder(slug: string, body: BuyInput, meta: Meta): Promise<
  { error: string } | { clientSecret: string | null; orderToken: string; ref: string; amountCents: number; publishableKey: string | null }
> {
  const e = await eventBySlug(slug);
  if (!e) return { error: "not_found" };
  if (e.status !== "open") return { error: "Tickets aren't on sale for this event." };
  const acct = stripeFor(e.stripeAccount);
  if (!acct.ok) return { error: "Online payment isn't available right now. Please contact the club." };

  const quantity = clampQuantity(body.quantity, e.maxPerOrder);
  if (!quantity) return { error: `Choose between 1 and ${e.maxPerOrder} tickets.` };
  const buyerName = String(body.buyerName ?? "").trim().slice(0, 120);
  const buyerEmail = normaliseEmail(body.buyerEmail);
  const buyerPhone = String(body.buyerPhone ?? "").trim().slice(0, 40);
  if (buyerName.length < 2) return { error: "Please enter your name." };
  if (!isEmail(buyerEmail)) return { error: "Please enter a valid email address — your ticket is sent there." };
  if (!isPhone(buyerPhone)) return { error: "Please enter a phone number." };
  if (e.ageRestriction && body.ageConfirmed !== true) return { error: `Please confirm everyone attending is ${e.ageRestriction}.` };

  // A retry from the same browser reuses its own pending order instead of
  // holding a second block of seats.
  const existingToken = typeof body.orderToken === "string" ? body.orderToken : "";
  if (existingToken) {
    const [prev] = await db.select().from(clubEventOrders).where(and(eq(clubEventOrders.token, existingToken), eq(clubEventOrders.eventId, e.id)));
    if (prev && prev.status === "paid") return { error: "already_paid" };
    if (prev && prev.status === "pending" && prev.quantity === quantity && prev.stripePaymentIntentId) {
      const pi = await acct.stripe.paymentIntents.retrieve(prev.stripePaymentIntentId);
      if (pi.status === "succeeded") { await markPaidOnce(prev.id, pi.id, pi.amount_received || pi.amount, ONLINE_PAYMENT_METHOD); return { error: "already_paid" }; }
      if (pi.status !== "canceled") {
        return { clientSecret: pi.client_secret, orderToken: prev.token, ref: prev.ref, amountCents: prev.totalCents, publishableKey: acct.publishableKey };
      }
    }
  }

  const types = await typesOf(e.id);
  const type = currentTicketType(types);
  if (!type) return { error: "Tickets aren't on sale right now." };
  const unit = type.priceCents;
  const total = unit * quantity;
  if (total > 0 && total < 50) return { error: "That amount is too small to charge." };

  const guests = cleanGuests(body.guests, quantity);
  const tableName = String(body.tableName ?? "").trim().slice(0, 80) || null;
  const buyerNotes = String(body.buyerNotes ?? "").trim().slice(0, 1000) || null;

  let order: ClubEventOrder;
  try {
    order = await db.transaction(async (tx) => {
      const [o] = await tx.insert(clubEventOrders).values({
        eventId: e.id, ticketTypeId: type.id, ref: "", token: token(),
        buyerName, buyerEmail, buyerPhone, quantity, unitPriceCents: unit, totalCents: total,
        status: "pending", tableName, buyerNotes,
        source: String(body.source ?? "").slice(0, 80) || null,
        sourceUrl: String(body.sourceUrl ?? "").slice(0, 500) || null,
        fbp: String(body.fbp ?? "").slice(0, 120) || null, fbc: String(body.fbc ?? "").slice(0, 200) || null,
        userAgent: meta.userAgent?.slice(0, 300) || null, ipAddress: meta.ip?.slice(0, 64) || null,
      }).returning();
      await tx.insert(clubEventGuests).values(guests.map((g, i) => ({ orderId: o.id, seatNo: i + 1, fullName: g.fullName, dietary: g.dietary })));
      return o;
    });
  } catch (err: any) {
    if (/sold out/i.test(String(err?.message))) return { error: "Sorry, those seats have just gone. There aren't enough left for that many tickets." };
    throw err;
  }
  await logEvent({ eventId: e.id, orderId: order.id, kind: "order_started", actor: "buyer", detail: { quantity, unit, type: type.name } });

  // Free tickets: no Stripe at all.
  if (total === 0) {
    await markPaidOnce(order.id, null, 0, "other");
    return { clientSecret: null, orderToken: order.token, ref: order.ref, amountCents: 0, publishableKey: acct.publishableKey };
  }

  let customerId: string | undefined;
  try {
    const found = await acct.stripe.customers.list({ email: buyerEmail, limit: 1 });
    customerId = found.data[0]?.id ?? (await acct.stripe.customers.create({ email: buyerEmail, name: buyerName, phone: buyerPhone })).id;
  } catch (err) { console.error("[club-events] customer failed:", err); }

  const pi = await acct.stripe.paymentIntents.create({
    amount: total, currency: e.currency.toLowerCase(),
    receipt_email: buyerEmail,
    ...(customerId ? { customer: customerId } : {}),
    description: `${e.name} — ${quantity} × ${type.name} — ${order.ref}`,
    metadata: {
      // 🔴 `kind` is what the webhook branches on. Never `registrationId`.
      kind: "club_event", clubEventOrderId: String(order.id), clubEventId: String(e.id), ref: order.ref,
    },
    payment_method_types: ["card"],
  }, { idempotencyKey: `club-event-order-${order.id}-${total}` });

  await db.update(clubEventOrders).set({ stripePaymentIntentId: pi.id, stripeCustomerId: customerId ?? null, updatedAt: new Date() }).where(eq(clubEventOrders.id, order.id));
  return { clientSecret: pi.client_secret, orderToken: order.token, ref: order.ref, amountCents: total, publishableKey: acct.publishableKey };
}

/** Flip an order to paid, once. Atomic on status. */
export async function markPaidOnce(orderId: number, paymentIntentId: string | null, amountCents: number, method: string, extra?: { reference?: string | null; servedByUserId?: number | null; actorUserId?: number | null }): Promise<boolean> {
  let r: { id: number; eventId: number }[];
  try {
    r = await db.update(clubEventOrders)
      .set({
        status: "paid", paidAt: new Date(), paidCents: amountCents, paymentMethod: method,
        ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
        ...(extra?.reference !== undefined ? { paymentReference: extra.reference } : {}),
        ...(extra?.servedByUserId !== undefined ? { servedByUserId: extra.servedByUserId } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(clubEventOrders.id, orderId), eq(clubEventOrders.status, "pending")))
      .returning({ id: clubEventOrders.id, eventId: clubEventOrders.eventId });
  } catch (err: any) {
    // The buyer's 30-minute hold expired while the card form sat open, the seats
    // sold on, and the room is now full. The money landed; give it straight back.
    if (/sold out/i.test(String(err?.message)) && paymentIntentId) {
      await refundOverfill(orderId, paymentIntentId, amountCents);
      return false;
    }
    throw err;
  }
  if (!r.length) return false;
  await logEvent({ eventId: r[0].eventId, orderId, kind: "paid", actor: paymentIntentId ? "stripe" : "staff", actorUserId: extra?.actorUserId ?? null, detail: { amountCents, method, paymentIntentId } });
  await afterPayment(orderId);
  return true;
}

/** A payment that landed after its hold expired into a full room: refund it, record it, tell them. */
async function refundOverfill(orderId: number, paymentIntentId: string, amountCents: number) {
  const [o] = await db.select().from(clubEventOrders).where(eq(clubEventOrders.id, orderId));
  if (!o || o.status !== "pending") return;
  const e = await eventById(o.eventId);
  if (!e) return;
  const acct = stripeFor(e.stripeAccount);
  let refundId: string | null = null;
  try {
    const rf = await acct.stripe.refunds.create({ payment_intent: paymentIntentId, metadata: { clubEventOrderId: String(o.id), ref: o.ref, why: "sold out while paying" } }, { idempotencyKey: `club-event-overfill-${o.id}` });
    refundId = rf.id;
  } catch (err) { console.error("[club-events] overfill refund FAILED — needs a human:", o.ref, err); }
  await db.update(clubEventOrders).set({
    status: "refunded", paidAt: new Date(), paidCents: amountCents, paymentMethod: ONLINE_PAYMENT_METHOD, stripePaymentIntentId: paymentIntentId,
    refundedCents: refundId ? amountCents : 0, refundedAt: refundId ? new Date() : null, stripeRefundId: refundId,
    refundReason: refundId ? "Sold out while paying — refunded automatically" : "SOLD OUT WHILE PAYING — automatic refund FAILED, refund by hand",
    updatedAt: new Date(),
  }).where(eq(clubEventOrders.id, o.id));
  await logEvent({ eventId: e.id, orderId: o.id, kind: "overfill_refund", actor: "system", detail: { amountCents, paymentIntentId, refundId } });
  try {
    await sendEmail({
      to: o.buyerEmail, from: CUFC_FROM, replyTo: e.contactEmail || CUFC_REPLY_TO,
      subject: `Sorry — ${e.name} sold out while you were paying`,
      html: cufcShellWrap("Sold out", `<p style="margin:0 0 14px;">Kia ora ${esc(o.buyerName.split(/\s+/)[0])},</p>
        <p style="margin:0 0 14px;">The last seats for <strong>${esc(e.name)}</strong> went while your payment was going through, so we couldn't confirm your booking.</p>
        <p style="margin:0 0 14px;">${refundId ? `Your ${esc(dollars(amountCents))} has been refunded to your card. It can take 5 to 10 business days to show.` : `We are refunding your ${esc(dollars(amountCents))} by hand and will confirm by email.`}</p>
        <p style="margin:0;color:#7d8ba8;font-size:12px;">Sorry to miss you. Questions: reply to this email.</p>`),
    });
  } catch (err) { console.error("[club-events] overfill email failed:", err); }
}

/** Read the truth back from Stripe. */
export async function confirmOrder(orderToken: string): Promise<{ error?: string; paid?: boolean; ref?: string }> {
  const [o] = await db.select().from(clubEventOrders).where(eq(clubEventOrders.token, orderToken));
  if (!o) return { error: "not_found" };
  if (o.status === "paid") return { paid: true, ref: o.ref };
  if (!o.stripePaymentIntentId) return { error: "No payment to confirm." };
  const e = await eventById(o.eventId);
  const acct = stripeFor(e?.stripeAccount ?? "club");
  const pi = await acct.stripe.paymentIntents.retrieve(o.stripePaymentIntentId);
  if (pi.status !== "succeeded") return { paid: false };
  await markPaidOnce(o.id, pi.id, pi.amount_received || pi.amount, ONLINE_PAYMENT_METHOD);
  return { paid: true, ref: o.ref };
}

/** The Stripe webhook's club_event branch. Idempotent. Club account only — the trust account has no webhook. */
export async function markPaidByPaymentIntent(pi: any): Promise<boolean> {
  const orderId = Number(pi?.metadata?.clubEventOrderId);
  if (!Number.isInteger(orderId)) return false;
  return markPaidOnce(orderId, pi.id, pi.amount_received || pi.amount, ONLINE_PAYMENT_METHOD);
}

/** Pending orders that were paid while the buyer's tab was closed: ask Stripe. */
export async function reconcile(eventId: number): Promise<{ checked: number; paid: number }> {
  const e = await eventById(eventId);
  if (!e) return { checked: 0, paid: 0 };
  const acct = stripeFor(e.stripeAccount);
  const pend = await db.select().from(clubEventOrders).where(and(eq(clubEventOrders.eventId, eventId), eq(clubEventOrders.status, "pending")));
  let paid = 0, checked = 0;
  for (const o of pend) {
    if (!o.stripePaymentIntentId) continue;
    checked++;
    try {
      const pi = await acct.stripe.paymentIntents.retrieve(o.stripePaymentIntentId);
      if (pi.status === "succeeded" && await markPaidOnce(o.id, pi.id, pi.amount_received || pi.amount, ONLINE_PAYMENT_METHOD)) paid++;
    } catch (err) { console.error("[club-events] reconcile failed for", o.ref, err); }
  }
  return { checked, paid };
}

// ── after payment: the ticket email + the Purchase event ─────────────────────
async function afterPayment(orderId: number) {
  try {
    const [o] = await db.select().from(clubEventOrders).where(eq(clubEventOrders.id, orderId));
    if (!o) return;
    const e = await eventById(o.eventId);
    if (!e) return;
    try {
      if ((o.paidCents ?? 0) > 0) {
        const [first = "", ...rest] = o.buyerName.trim().split(/\s+/);
        await sendPurchaseEvent({
          registrationId: 0, campId: 0,
          totalCents: o.paidCents ?? 0, currency: e.currency,
          email: o.buyerEmail, phone: o.buyerPhone ?? undefined, firstName: first, lastName: rest.join(" "),
          fbp: o.fbp ?? undefined, fbc: o.fbc ?? undefined, userAgent: o.userAgent ?? undefined, ipAddress: o.ipAddress ?? undefined,
          sourceUrl: eventUrl(e.slug),
          eventId: `club-event-order-${o.id}`,
          contentName: `${e.name} — ticket`, contentIds: [e.slug],
        });
      }
    } catch (err) { console.error("[club-events] meta purchase failed:", err); }
    await sendTicketEmail(o, e);
  } catch (err) { console.error("[club-events] afterPayment failed:", err); }
}

export async function sendTicketEmail(o: ClubEventOrder, e: ClubEvent): Promise<boolean> {
  const guests = await guestsOf(o.id);
  const when = `${nzLongDate(e.startsAt)}, ${nzClock(e.startsAt)}${e.endsAt ? ` to ${nzClock(e.endsAt)}` : ""}`;
  const names = guests.map((g) => g.fullName).filter(Boolean);
  const paidLine = o.paymentMethod === ONLINE_PAYMENT_METHOD ? "Paid by card online" : `Paid ${labelForMethod(o.paymentMethod)}${o.paymentReference ? ` · ref ${esc(o.paymentReference)}` : ""}`;
  const inner = `
    <p style="margin:0 0 14px;">Kia ora ${esc(o.buyerName.split(/\s+/)[0])},</p>
    <p style="margin:0 0 16px;">You're booked for <strong>${esc(e.name)}</strong>. This email is your ticket — show it on your phone at the door, or give your name and the ticket number below.</p>
    <div style="background:#0c1226;border:1px solid #D4AF37;border-radius:12px;padding:16px 18px;margin:0 0 18px;text-align:center;">
      <div style="color:#7d8ba8;font-size:11px;letter-spacing:2px;text-transform:uppercase;">Ticket number</div>
      <div style="color:#D4AF37;font-size:26px;font-weight:800;letter-spacing:1px;margin-top:4px;">${esc(o.ref)}</div>
      <div style="color:#ffffff;font-size:14px;margin-top:6px;">${o.quantity} ${o.quantity === 1 ? "seat" : "seats"} · ${esc(dollars(o.paidCents ?? o.totalCents))}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      ${cufcInfoRow("When", esc(when))}
      ${cufcInfoRow("Where", esc([e.venueName, e.venueAddress].filter(Boolean).join(", ")))}
      ${cufcInfoRow("Tickets", `${o.quantity} × ${esc(dollars(o.unitPriceCents))}`)}
      ${o.tableName ? cufcInfoRow("Table", esc(o.tableName)) : ""}
      ${names.length ? cufcInfoRow("Guests", esc(names.join(", "))) : ""}
      ${cufcInfoRow("Payment", paidLine)}
      ${e.ageRestriction ? cufcInfoRow("Please note", `This event is ${esc(e.ageRestriction)}.`) : ""}
    </table>
    <p style="margin:18px 0 0;">Need to add guest names or dietary requirements, or want your group seated together? Open your booking:</p>
    <p style="margin:12px 0 0;text-align:center;"><a href="${orderUrl(e.slug, o.token)}" style="display:inline-block;background:#D4AF37;color:#0C1640;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:999px;">Manage my booking</a></p>
    ${e.paymentNote ? `<p style="margin:18px 0 0;color:#7d8ba8;font-size:12px;">${esc(e.paymentNote)}</p>` : ""}
    <p style="margin:18px 0 0;color:#7d8ba8;font-size:12px;">Questions? Reply to this email${e.contactEmail ? ` or write to ${esc(e.contactEmail)}` : ""}.</p>`;
  return sendEmail({
    to: o.buyerEmail, from: CUFC_FROM, replyTo: e.contactEmail || CUFC_REPLY_TO,
    subject: `Your ticket — ${e.name} · ${o.ref}`,
    html: cufcShellWrap(`You're in — ${e.name}`, inner),
  });
}

function labelForMethod(m: string | null): string {
  switch (m) {
    case "eftpos": return "by EFTPOS";
    case "cash": return "in cash";
    case "bank_transfer": return "by bank transfer";
    case ONLINE_PAYMENT_METHOD: return "by card online";
    default: return "";
  }
}

// ── the buyer's order page ───────────────────────────────────────────────────
export async function orderByToken(orderToken: string) {
  const [o] = await db.select().from(clubEventOrders).where(eq(clubEventOrders.token, orderToken));
  if (!o) return undefined;
  const e = await eventById(o.eventId);
  if (!e) return undefined;
  const guests = await guestsOf(o.id);
  const editable = o.status === "paid" && new Date(e.startsAt).getTime() > Date.now();
  return {
    order: {
      ref: o.ref, status: o.status, quantity: o.quantity, unitPriceCents: o.unitPriceCents, totalCents: o.totalCents,
      paidCents: o.paidCents, paidAt: o.paidAt, buyerName: o.buyerName, buyerEmail: o.buyerEmail, tableName: o.tableName,
      paymentMethod: o.paymentMethod,
    },
    guests: guests.map((g) => ({ seatNo: g.seatNo, fullName: g.fullName, dietary: g.dietary })),
    event: {
      slug: e.slug, name: e.name, venueName: e.venueName, venueAddress: e.venueAddress, startsAt: e.startsAt, endsAt: e.endsAt,
      ageRestriction: e.ageRestriction, brand: e.brand, contactEmail: e.contactEmail, tableSize: e.tableSize,
    },
    editable,
  };
}

export async function updateOrderGuests(orderToken: string, body: { tableName?: unknown; guests?: unknown }): Promise<{ error?: string; ok?: boolean }> {
  const [o] = await db.select().from(clubEventOrders).where(eq(clubEventOrders.token, orderToken));
  if (!o) return { error: "not_found" };
  const e = await eventById(o.eventId);
  if (!e) return { error: "not_found" };
  if (o.status !== "paid") return { error: "This booking isn't confirmed." };
  if (new Date(e.startsAt).getTime() <= Date.now()) return { error: "This event has started — changes are closed." };
  const guests = cleanGuests(body.guests, o.quantity);
  const tableName = String(body.tableName ?? "").trim().slice(0, 80) || null;
  await db.transaction(async (tx) => {
    await tx.update(clubEventOrders).set({ tableName, updatedAt: new Date() }).where(eq(clubEventOrders.id, o.id));
    for (let i = 0; i < guests.length; i++) {
      await tx.update(clubEventGuests).set({ fullName: guests[i].fullName, dietary: guests[i].dietary, updatedAt: new Date() })
        .where(and(eq(clubEventGuests.orderId, o.id), eq(clubEventGuests.seatNo, i + 1)));
    }
  });
  await logEvent({ eventId: e.id, orderId: o.id, kind: "guests_updated", actor: "buyer" });
  return { ok: true };
}

export async function resendTicket(orderId: number): Promise<boolean> {
  const [o] = await db.select().from(clubEventOrders).where(eq(clubEventOrders.id, orderId));
  if (!o || o.status !== "paid") return false;
  const e = await eventById(o.eventId);
  if (!e) return false;
  return sendTicketEmail(o, e);
}

// ── staff: office / EFTPOS sales ─────────────────────────────────────────────
export async function manualOrder(e: ClubEvent, body: any, staffUserId: number): Promise<{ error?: string; order?: ClubEventOrder }> {
  const quantity = clampQuantity(body?.quantity, 50);
  if (!quantity) return { error: "Quantity must be between 1 and 50." };
  const buyerName = String(body?.buyerName ?? "").trim().slice(0, 120);
  const buyerEmail = normaliseEmail(body?.buyerEmail);
  const buyerPhone = String(body?.buyerPhone ?? "").trim().slice(0, 40) || null;
  if (buyerName.length < 2) return { error: "Buyer name is required." };
  if (!isEmail(buyerEmail)) return { error: "A valid buyer email is required — the ticket is sent there." };
  const method = String(body?.paymentMethod ?? "");
  if (!isOfficePaymentMethod(method)) return { error: "Choose how they paid: EFTPOS, cash, bank transfer or other." };
  const reference = String(body?.paymentReference ?? "").trim().slice(0, 120) || null;

  const types = await typesOf(e.id);
  let type = body?.ticketTypeId ? types.find((t) => t.id === Number(body.ticketTypeId)) : currentTicketType(types);
  if (!type) return { error: "No ticket type is on sale — pick one explicitly." };
  // Staff may override the price for a comp or a negotiated table (audited).
  const unit = body?.unitPriceCents != null && body.unitPriceCents !== "" ? Math.max(0, Math.round(Number(body.unitPriceCents))) : type.priceCents;
  if (!Number.isFinite(unit)) return { error: "Bad price." };
  const total = unit * quantity;
  const guests = cleanGuests(body?.guests, quantity);
  const tableName = String(body?.tableName ?? "").trim().slice(0, 80) || null;
  const staffNotes = String(body?.staffNotes ?? "").trim().slice(0, 1000) || null;

  let order: ClubEventOrder;
  try {
    order = await db.transaction(async (tx) => {
      const [o] = await tx.insert(clubEventOrders).values({
        eventId: e.id, ticketTypeId: type!.id, ref: "", token: token(),
        buyerName, buyerEmail, buyerPhone, quantity, unitPriceCents: unit, totalCents: total,
        status: "paid", paidAt: new Date(), paidCents: total, paymentMethod: method, paymentReference: reference,
        servedByUserId: staffUserId, tableName, staffNotes, source: "office",
      }).returning();
      await tx.insert(clubEventGuests).values(guests.map((g, i) => ({ orderId: o.id, seatNo: i + 1, fullName: g.fullName, dietary: g.dietary })));
      return o;
    });
  } catch (err: any) {
    if (/sold out/i.test(String(err?.message))) return { error: "Sold out — not enough seats left for that many tickets." };
    throw err;
  }
  await logEvent({ eventId: e.id, orderId: order.id, kind: "paid", actor: "staff", actorUserId: staffUserId, detail: { amountCents: total, method, reference, priceOverridden: unit !== type.priceCents } });
  await afterPayment(order.id);
  return { order };
}

// ── staff: refunds + cancellations ───────────────────────────────────────────
export async function cancelPending(orderId: number, staffUserId: number): Promise<boolean> {
  const r = await db.update(clubEventOrders).set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(clubEventOrders.id, orderId), eq(clubEventOrders.status, "pending"))).returning({ eventId: clubEventOrders.eventId });
  if (!r.length) return false;
  await logEvent({ eventId: r[0].eventId, orderId, kind: "cancelled", actor: "staff", actorUserId: staffUserId });
  return true;
}

/**
 * Refund a paid order. Online: through Stripe on the account that took it.
 * Office tenders: recorded only — the cash goes back over the counter.
 * A full refund releases the seats (status → refunded); a partial keeps them.
 */
export async function refundOrder(orderId: number, amountCents: number | null, reason: string | null, staffUserId: number): Promise<{ error?: string; refundedCents?: number; status?: string }> {
  const [o] = await db.select().from(clubEventOrders).where(eq(clubEventOrders.id, orderId));
  if (!o) return { error: "not_found" };
  if (o.status !== "paid") return { error: "Only a paid order can be refunded." };
  const paid = o.paidCents ?? 0;
  const remaining = paid - o.refundedCents;
  const amount = amountCents == null ? remaining : Math.round(amountCents);
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Nothing to refund." };
  if (amount > remaining) return { error: `Only ${dollars(remaining)} is left to refund.` };

  let stripeRefundId: string | null = null;
  if (o.paymentMethod === ONLINE_PAYMENT_METHOD) {
    if (!o.stripePaymentIntentId) return { error: "No Stripe payment on this order." };
    const e = await eventById(o.eventId);
    const acct = stripeFor(e?.stripeAccount ?? "club");
    const refund = await acct.stripe.refunds.create(
      { payment_intent: o.stripePaymentIntentId, amount, reason: "requested_by_customer", metadata: { clubEventOrderId: String(o.id), ref: o.ref } },
      { idempotencyKey: `club-event-refund-${o.id}-${o.refundedCents + amount}` },
    );
    stripeRefundId = refund.id;
  }
  const newRefunded = o.refundedCents + amount;
  const full = newRefunded >= paid;
  await db.update(clubEventOrders).set({
    refundedCents: newRefunded, refundedAt: new Date(), refundReason: reason, stripeRefundId: stripeRefundId ?? o.stripeRefundId,
    status: full ? "refunded" : "paid", updatedAt: new Date(),
  }).where(eq(clubEventOrders.id, o.id));
  await logEvent({ eventId: o.eventId, orderId: o.id, kind: full ? "refunded" : "partial_refund", actor: "staff", actorUserId: staffUserId, detail: { amount, reason, stripeRefundId } });
  return { refundedCents: newRefunded, status: full ? "refunded" : "paid" };
}

// ── staff: the door ──────────────────────────────────────────────────────────
export async function setCheckedIn(guestId: number, on: boolean, staffUserId: number): Promise<boolean> {
  const r = await db.update(clubEventGuests)
    .set(on ? { checkedInAt: new Date(), checkedInByUserId: staffUserId, updatedAt: new Date() } : { checkedInAt: null, checkedInByUserId: null, updatedAt: new Date() })
    .where(eq(clubEventGuests.id, guestId)).returning({ id: clubEventGuests.id });
  return r.length > 0;
}

// ── staff: reads ─────────────────────────────────────────────────────────────
export interface EventStats {
  seatsPaid: number; seatsPending: number; ordersPaid: number; revenueCents: number; refundedCents: number;
  byType: { name: string; seats: number; revenueCents: number }[];
  byTender: { method: string; seats: number; revenueCents: number }[];
  guestsNamed: number; dietaryCount: number; checkedIn: number; tables: number;
}
export async function eventStats(e: ClubEvent): Promise<EventStats> {
  const rows = await db.execute(sql`
    select o.status, o.quantity, o.paid_cents, o.refunded_cents, o.payment_method, t.name as type_name, o.created_at
    from club_event_orders o join club_event_ticket_types t on t.id = o.ticket_type_id
    where o.event_id = ${e.id}`);
  const list = rows.rows as any[];
  const paid = list.filter((r) => r.status === "paid");
  const cutoff = Date.now() - PENDING_HOLD_MINUTES * 60_000;
  const pending = list.filter((r) => r.status === "pending" && new Date(r.created_at).getTime() > cutoff);
  const seatsPaid = paid.reduce((s, r) => s + r.quantity, 0);
  const byType = new Map<string, { seats: number; revenueCents: number }>();
  const byTender = new Map<string, { seats: number; revenueCents: number }>();
  let revenue = 0, refunded = 0;
  for (const r of paid) {
    revenue += r.paid_cents ?? 0; refunded += r.refunded_cents ?? 0;
    const t = byType.get(r.type_name) ?? { seats: 0, revenueCents: 0 }; t.seats += r.quantity; t.revenueCents += r.paid_cents ?? 0; byType.set(r.type_name, t);
    const m = r.payment_method ?? "unknown";
    const d = byTender.get(m) ?? { seats: 0, revenueCents: 0 }; d.seats += r.quantity; d.revenueCents += r.paid_cents ?? 0; byTender.set(m, d);
  }
  const g = await db.execute(sql`
    select count(*) filter (where g.full_name is not null)::int as named,
           count(*) filter (where g.dietary is not null and g.dietary <> '')::int as dietary,
           count(*) filter (where g.checked_in_at is not null)::int as checked_in
    from club_event_guests g join club_event_orders o on o.id = g.order_id
    where o.event_id = ${e.id} and o.status = 'paid'`);
  const gr = (g.rows[0] as any) ?? {};
  return {
    seatsPaid, seatsPending: pending.reduce((s, r) => s + r.quantity, 0), ordersPaid: paid.length,
    revenueCents: revenue, refundedCents: refunded,
    byType: Array.from(byType.entries()).map(([name, v]) => ({ name, ...v })),
    byTender: Array.from(byTender.entries()).map(([method, v]) => ({ method, ...v })),
    guestsNamed: gr.named ?? 0, dietaryCount: gr.dietary ?? 0, checkedIn: gr.checked_in ?? 0,
    tables: Math.ceil(seatsPaid / Math.max(1, e.tableSize)),
  };
}

export async function adminEvents(orgId: number) {
  const list = await db.select().from(clubEvents).where(eq(clubEvents.organizationId, orgId)).orderBy(desc(clubEvents.startsAt));
  return Promise.all(list.map(async (e) => ({ ...e, stats: await eventStats(e), ticketTypes: await typesOf(e.id) })));
}

export async function adminOrders(eventId: number) {
  const rows = await db.execute(sql`
    select o.*, t.name as ticket_type_name,
           u.first_name as served_by_first, u.last_name as served_by_last,
           (select count(*) from club_event_guests g where g.order_id = o.id and g.checked_in_at is not null)::int as checked_in
    from club_event_orders o
    join club_event_ticket_types t on t.id = o.ticket_type_id
    left join users u on u.id = o.served_by_user_id
    where o.event_id = ${eventId}
    order by o.created_at desc`);
  return (rows.rows as any[]).map((r) => ({
    id: r.id, ref: r.ref, token: r.token, status: r.status, quantity: r.quantity,
    unitPriceCents: r.unit_price_cents, totalCents: r.total_cents, paidCents: r.paid_cents, paidAt: r.paid_at,
    refundedCents: r.refunded_cents, refundedAt: r.refunded_at, refundReason: r.refund_reason,
    buyerName: r.buyer_name, buyerEmail: r.buyer_email, buyerPhone: r.buyer_phone,
    paymentMethod: r.payment_method, paymentReference: r.payment_reference, stripePaymentIntentId: r.stripe_payment_intent_id,
    servedBy: r.served_by_first ? `${r.served_by_first} ${r.served_by_last ?? ""}`.trim() : null,
    tableName: r.table_name, buyerNotes: r.buyer_notes, staffNotes: r.staff_notes, source: r.source,
    ticketTypeName: r.ticket_type_name, checkedIn: r.checked_in, createdAt: r.created_at,
  }));
}

export async function adminGuests(eventId: number) {
  const rows = await db.execute(sql`
    select g.id, g.seat_no, g.full_name, g.dietary, g.checked_in_at,
           o.id as order_id, o.ref, o.buyer_name, o.buyer_email, o.buyer_phone, o.table_name, o.status, o.quantity
    from club_event_guests g join club_event_orders o on o.id = g.order_id
    where o.event_id = ${eventId} and o.status = 'paid'
    order by coalesce(o.table_name, ''), o.buyer_name, o.id, g.seat_no`);
  return (rows.rows as any[]).map((r) => ({
    id: r.id, seatNo: r.seat_no, fullName: r.full_name, dietary: r.dietary, checkedInAt: r.checked_in_at,
    orderId: r.order_id, ref: r.ref, buyerName: r.buyer_name, buyerEmail: r.buyer_email, buyerPhone: r.buyer_phone,
    tableName: r.table_name, quantity: r.quantity,
  }));
}

export function guestsCsv(rows: Awaited<ReturnType<typeof adminGuests>>): string {
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Ticket", "Seat", "Guest", "Dietary", "Booked by", "Email", "Phone", "Table", "Checked in"].join(",");
  const body = rows.map((r) => [r.ref, r.seatNo, r.fullName ?? "", r.dietary ?? "", r.buyerName, r.buyerEmail, r.buyerPhone ?? "", r.tableName ?? "", r.checkedInAt ? "yes" : ""].map(q).join(","));
  return [head, ...body].join("\n");
}

// ── staff: writes on the event itself ────────────────────────────────────────
export function cleanEventInput(body: any) {
  const out: Partial<typeof clubEvents.$inferInsert> = {};
  const s = (k: string, max = 300) => (body?.[k] === undefined ? undefined : (String(body[k] ?? "").trim().slice(0, max) || null));
  if (body?.name !== undefined) out.name = String(body.name).trim().slice(0, 160);
  if (body?.slug !== undefined) out.slug = String(body.slug).trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  if (body?.shortCode !== undefined) out.shortCode = String(body.shortCode).trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "EV";
  for (const k of ["tagline", "venueName", "venueAddress", "ageRestriction", "contactEmail", "paymentNote"] as const) {
    const v = s(k); if (v !== undefined) (out as any)[k] = v;
  }
  const d = s("description", 8000); if (d !== undefined) out.description = d;
  if (body?.includes !== undefined) out.includes = Array.isArray(body.includes) ? body.includes.map((x: unknown) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 20) : [];
  if (body?.startsAt !== undefined) out.startsAt = new Date(body.startsAt);
  if (body?.endsAt !== undefined) out.endsAt = body.endsAt ? new Date(body.endsAt) : null;
  if (body?.capacity !== undefined) out.capacity = body.capacity === null || body.capacity === "" ? null : Math.max(1, Math.round(Number(body.capacity)));
  if (body?.tableSize !== undefined) out.tableSize = Math.max(1, Math.round(Number(body.tableSize) || 10));
  if (body?.maxPerOrder !== undefined) out.maxPerOrder = Math.min(50, Math.max(1, Math.round(Number(body.maxPerOrder) || 10)));
  if (body?.status !== undefined) out.status = String(body.status);
  if (body?.stripeAccount !== undefined) out.stripeAccount = String(body.stripeAccount);
  if (body?.brand !== undefined) out.brand = String(body.brand).slice(0, 40);
  return out;
}

export function cleanTicketTypeInput(body: any) {
  const out: Partial<typeof clubEventTicketTypes.$inferInsert> = {};
  if (body?.name !== undefined) out.name = String(body.name).trim().slice(0, 80);
  if (body?.priceCents !== undefined) out.priceCents = Math.max(0, Math.round(Number(body.priceCents) || 0));
  if (body?.salesStart !== undefined) out.salesStart = body.salesStart ? new Date(body.salesStart) : null;
  if (body?.salesEnd !== undefined) out.salesEnd = body.salesEnd ? new Date(body.salesEnd) : null;
  if (body?.quantityCap !== undefined) out.quantityCap = body.quantityCap === null || body.quantityCap === "" ? null : Math.max(1, Math.round(Number(body.quantityCap)));
  if (body?.sort !== undefined) out.sort = Math.round(Number(body.sort) || 0);
  if (body?.isActive !== undefined) out.isActive = !!body.isActive;
  return out;
}

/** Who is signed in — for "served by" and audit rows. */
export async function staffName(userId: number): Promise<string | null> {
  const [u] = await db.select({ f: users.firstName, l: users.lastName }).from(users).where(eq(users.id, userId));
  return u ? `${u.f ?? ""} ${u.l ?? ""}`.trim() : null;
}

export { nzShortDate };
