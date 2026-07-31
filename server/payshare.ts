// PayShare — third-party group-checkout orchestration (Integration Pack v1,
// contract thin-adapter-v1, "Mode 2": PayShare owns the group session, WE own
// the PSP checkout and the money.
//
// The shape of it:
//   1. Our checkout reserves the pitch slots 'pending' (exactly as Player Pay
//      does) and calls createSession → we hand the organiser a sessionUrl.
//   2. PayShare invites the group. Each time someone joins, PayShare POSTs a
//      SIGNED create-payment hook to us and we answer with a redirectUrl to our
//      own embedded-Stripe pay page for that person's share.
//   3. They pay on our page; we call recordPayment so PayShare can track group
//      progress, then bounce them back to PayShare.
//   4. When the group finishes, PayShare POSTs a SIGNED completion webhook and
//      only THEN does the booking flip to paid.
//
// Player Pay (server/split-pay.ts) is untouched and stays live beside this.

import { randomBytes } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "./db";
import {
  facilityBookings,
  facilities,
  organizations,
  payshareSessions,
  payshareParticipants,
  payshareEvents,
} from "@shared/schema";

// ── config ──────────────────────────────────────────────────────────────────
// Keys are server-side only. Nothing in this module may ever be imported by the
// client bundle, and no key is echoed to a response.

export const PAYSHARE_CONTRACT = "thin-adapter-v1";

/** The site PayShare has allowlisted for return URLs. */
export const PAYSHARE_SITE_ORIGIN = "https://book.unitedsportscentre.com";

/** The ref PayShare's setup wizard probes with — it has no real booking. */
export const WIZARD_PROBE_REF = "payshare-wizard-probe";

export type PayShareEnv = {
  apiBase: string;
  appUrl: string;
  integrationId: string;
  apiKey: string;
  createPaymentSigningSecret: string;
  webhookSigningSecret: string;
  liveMode: boolean;
};

export function payshareEnv(): PayShareEnv | null {
  const apiBase = process.env.PAYSHARE_API_BASE;
  const integrationId = process.env.PAYSHARE_INTEGRATION_ID;
  const apiKey = process.env.PAYSHARE_API_KEY;
  const createPaymentSigningSecret = process.env.PAYSHARE_PARTNER_CREATE_PAYMENT_SIGNING_SECRET;
  const webhookSigningSecret = process.env.PAYSHARE_WEBHOOK_SIGNING_SECRET;
  if (!apiBase || !integrationId || !apiKey || !createPaymentSigningSecret || !webhookSigningSecret) return null;
  return {
    apiBase,
    appUrl: process.env.PAYSHARE_APP_URL || apiBase,
    integrationId,
    apiKey,
    createPaymentSigningSecret,
    webhookSigningSecret,
    // Same doctrine as SPORTY_AUTOSYNC / XERO_AUTOPOST: live is opt-in, never
    // the default. Absent or "0" keeps every session in PayShare test mode.
    liveMode: process.env.PAYSHARE_LIVE_MODE === "1",
  };
}

/** Env present. Separate from the per-venue switch — both must be true to sell. */
export function isPayShareConfigured(): boolean {
  return process.env.PAYSHARE_ENABLED === "1" && payshareEnv() !== null;
}

let clientCache: any = null;
export async function getPayShareClient() {
  const env = payshareEnv();
  if (!env) throw new Error("PayShare is not configured");
  if (clientCache) return clientCache;
  const { createPayShareClient } = await import("@payshare/platform-sdk");
  clientCache = createPayShareClient({
    apiBase: env.apiBase,
    integrationId: env.integrationId,
    apiKey: env.apiKey,
    contractHeader: PAYSHARE_CONTRACT,
    liveMode: env.liveMode,
  });
  return clientCache;
}

// ── error mapping ───────────────────────────────────────────────────────────
// PayShare answers a malformed createSession with CONTRACT_VIOLATION and a list
// of missing fields. That is our bug, not an outage: it must surface as a 400
// carrying the gaps so the wizard self-test can name what is missing. Returning
// 500 would read as "PayShare is down" and send someone debugging the wrong end.

export type PayShareErrorResponse = {
  status: number;
  body: { error: { code: string; message: string; details?: { gaps?: unknown } } };
};

export function payshareErrorResponse(e: any): PayShareErrorResponse {
  const code: string | undefined = e?.code ?? e?.body?.error?.code ?? e?.error?.code;
  const gaps = e?.details?.gaps ?? e?.body?.error?.details?.gaps ?? e?.error?.details?.gaps;
  const message: string = e?.body?.error?.message ?? e?.message ?? "PayShare request failed";

  if (code === "CONTRACT_VIOLATION" || gaps !== undefined) {
    return { status: 400, body: { error: { code: "CONTRACT_VIOLATION", message, details: { gaps: gaps ?? [] } } } };
  }
  // Any other 4xx from PayShare is still our request's fault, not a server fault.
  const upstream = Number(e?.status ?? e?.statusCode);
  if (Number.isFinite(upstream) && upstream >= 400 && upstream < 500) {
    return { status: 400, body: { error: { code: code || "INVALID_REQUEST", message } } };
  }
  return { status: 502, body: { error: { code: code || "PAYSHARE_UNAVAILABLE", message } } };
}

// ── the business hooks ──────────────────────────────────────────────────────

export type PayShareBooking = {
  bookingId: string;
  organizationId: number;
  amountMinor: string;
  currency: string;
  merchantDisplayName: string;
  platformContextId: string | null;
  customerEmail: string | null;
  orderSummary: Record<string, unknown>;
  isProbe: boolean;
};

/**
 * The wizard's self-test calls our routes before any real booking exists, so a
 * probe ref must answer with a well-formed synthetic booking. It is deliberately
 * marked isProbe: nothing downstream may reserve a slot, take money, or confirm
 * anything on its behalf.
 */
export function resolveWizardProbeBooking(bookingId: string): PayShareBooking | null {
  if (!bookingId || !bookingId.startsWith(WIZARD_PROBE_REF)) return null;
  return {
    bookingId,
    organizationId: 4, // United Sports Centre
    amountMinor: "17020", // $170.20 — a real full-pitch peak hour
    currency: "NZD",
    merchantDisplayName: "United Sports Centre",
    platformContextId: null,
    customerEmail: null,
    orderSummary: {
      merchantDisplayName: "United Sports Centre",
      orderReference: bookingId,
      itemDescription: "Full pitch hire — 60 min (self-test)",
      orderBlurb: "PayShare integration self-test — not a real booking",
    },
    isProbe: true,
  };
}

/**
 * Load a booking group server-side. Never trust an amount from the browser: the
 * total is recomputed from the rows we actually reserved.
 */
export async function getBookingByRef(bookingId: string): Promise<PayShareBooking | null> {
  const probe = resolveWizardProbeBooking(bookingId);
  if (probe) return probe;

  const rows = await db
    .select({ booking: facilityBookings, facility: facilities })
    .from(facilityBookings)
    .leftJoin(facilities, eq(facilityBookings.facilityId, facilities.id))
    .where(eq(facilityBookings.bookingGroupId, bookingId));
  if (rows.length === 0) return null;

  const first = rows[0].booking;
  const totalCents = rows.reduce((s, r) => s + (r.booking.totalCents || 0), 0);

  const org = (
    await db.select().from(organizations).where(eq(organizations.id, first.organizationId)).limit(1)
  )[0];

  const ordered = rows
    .slice()
    .sort((a, b) =>
      (a.booking.bookingDate + a.booking.startTime).localeCompare(b.booking.bookingDate + b.booking.startTime),
    );
  const firstSlot = ordered[0].booking;
  const lastSlot = ordered[ordered.length - 1].booking;

  const sizeLabel =
    firstSlot.halfFull === "half"
      ? `${firstSlot.halfPosition ? firstSlot.halfPosition + " " : ""}half pitch`
      : firstSlot.halfFull === "quarter"
        ? `quarter pitch ${(firstSlot.halfPosition || "").toUpperCase()}`
        : "full pitch";
  const facilityName = ordered[0].facility?.name || "Facility";
  const sessionWord = rows.length === 1 ? "session" : "sessions";

  return {
    bookingId,
    organizationId: first.organizationId,
    // Minor units. Our booking totals are already GST-inclusive cents.
    amountMinor: String(totalCents),
    // Explicit, never defaulted — PayShare requires a currency on every session.
    currency: "NZD",
    merchantDisplayName: org?.name || "United Sports Centre",
    // One venue per integration today; this is the multi-property hook.
    platformContextId: String(first.organizationId),
    customerEmail: first.customerEmail || null,
    orderSummary: {
      // Required by PayShare after wizard Confirm — omitting either is a
      // CONTRACT_VIOLATION, not a warning.
      merchantDisplayName: org?.name || "United Sports Centre",
      orderReference: bookingId,
      // Recommended: these drive what the group sees on the pay screens.
      itemDescription: `${facilityName} — ${sizeLabel} (${rows.length} ${sessionWord})`,
      bookingStart: toIsoInstant(firstSlot.bookingDate, firstSlot.startTime),
      bookingEnd: toIsoInstant(lastSlot.bookingDate, lastSlot.endTime),
      orderBlurb: `${facilityName} · ${sizeLabel}`,
    },
    isProbe: false,
  };
}

/**
 * NZ local wall-clock → ISO instant. Deliberately not `new Date(date)`: a bare
 * date string is parsed as UTC and renders the day before in New Zealand, which
 * is exactly the bug that once printed the wrong day on an invoice.
 */
function toIsoInstant(date: string, time: string): string {
  const offset = nzUtcOffsetHours(date);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs)).padStart(2, "0");
  const mm = String(Math.round((abs % 1) * 60)).padStart(2, "0");
  const hhmm = time.length === 5 ? `${time}:00` : time;
  return new Date(`${date}T${hhmm}${sign}${hh}:${mm}`).toISOString();
}

/** NZDT (+13) roughly late Sep→early Apr, else NZST (+12). */
function nzUtcOffsetHours(date: string): number {
  const m = Number(date.slice(5, 7));
  if (m >= 10 || m <= 3) return 13;
  if (m >= 5 && m <= 8) return 12;
  // April and September straddle a transition; resolve against the real zone.
  const probe = new Date(`${date}T12:00:00Z`);
  const nz = new Date(probe.toLocaleString("en-US", { timeZone: "Pacific/Auckland" }));
  const utc = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((nz.getTime() - utc.getTime()) / 3_600_000);
}

// ── event dedupe (cross-machine) ────────────────────────────────────────────
// The SDK offers an in-memory Map/Set for idempotency. Prod runs TWO Fly
// machines, so in-memory dedupe is not dedupe: the same replayed webhook can
// land on the other machine and confirm a booking a second time. The unique
// index on (event_id, kind) is the guard; a duplicate replays the stored
// response verbatim rather than doing the work again.

export async function rememberEvent(
  eventId: string,
  kind: "create_payment" | "webhook",
  sessionId: string | null,
  response: unknown,
): Promise<{ fresh: boolean; response: unknown }> {
  const existing = (
    await db
      .select()
      .from(payshareEvents)
      .where(and(eq(payshareEvents.eventId, eventId), eq(payshareEvents.kind, kind)))
      .limit(1)
  )[0];
  if (existing) return { fresh: false, response: existing.responseJson };
  try {
    await db.insert(payshareEvents).values({ eventId, kind, sessionId, responseJson: response as any });
    return { fresh: true, response };
  } catch {
    // Lost the race against the other machine — re-read and replay theirs.
    const now = (
      await db
        .select()
        .from(payshareEvents)
        .where(and(eq(payshareEvents.eventId, eventId), eq(payshareEvents.kind, kind)))
        .limit(1)
    )[0];
    return { fresh: false, response: now?.responseJson ?? response };
  }
}

export function newPayToken(): string {
  return randomBytes(24).toString("hex");
}

// ── session + participant persistence ───────────────────────────────────────

export async function recordSession(input: {
  organizationId: number;
  sessionId: string;
  bookingGroupId: string | null;
  amountMinor: string;
  currency: string;
  sessionUrl: string | null;
  merchantOrderRef: string | null;
  expiresAt: Date | null;
}) {
  const [row] = await db
    .insert(payshareSessions)
    .values({
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      bookingGroupId: input.bookingGroupId,
      amountMinor: Number(input.amountMinor),
      currency: input.currency,
      sessionUrl: input.sessionUrl,
      merchantOrderRef: input.merchantOrderRef,
      expiresAt: input.expiresAt,
    })
    .returning();
  return row;
}

export async function getSessionByPayShareId(sessionId: string) {
  return (
    await db.select().from(payshareSessions).where(eq(payshareSessions.sessionId, sessionId)).limit(1)
  )[0];
}

export async function getParticipantByToken(payToken: string) {
  const p = (
    await db.select().from(payshareParticipants).where(eq(payshareParticipants.payToken, payToken)).limit(1)
  )[0];
  if (!p) return null;
  const s = (
    await db.select().from(payshareSessions).where(eq(payshareSessions.id, p.payshareSessionId)).limit(1)
  )[0];
  return s ? { participant: p, session: s } : null;
}

/**
 * Upsert the participant PayShare just told us about. Idempotent on
 * (session, participant) so a retried hook returns the SAME pay token — and
 * therefore the same pay page and the same payment intent — instead of charging
 * someone twice.
 */
export async function upsertParticipant(input: {
  payshareSessionId: number;
  participantId: string;
  role: string;
  shareAmountMinor: string;
  currency: string;
  returnUrl: string | null;
}) {
  const existing = (
    await db
      .select()
      .from(payshareParticipants)
      .where(
        and(
          eq(payshareParticipants.payshareSessionId, input.payshareSessionId),
          eq(payshareParticipants.participantId, input.participantId),
        ),
      )
      .limit(1)
  )[0];
  if (existing) return existing;

  try {
    const [row] = await db
      .insert(payshareParticipants)
      .values({
        payshareSessionId: input.payshareSessionId,
        participantId: input.participantId,
        role: input.role === "host" ? "host" : "participant",
        shareAmountMinor: Number(input.shareAmountMinor),
        currency: input.currency,
        payToken: newPayToken(),
        returnUrl: input.returnUrl,
      })
      .returning();
    return row;
  } catch {
    return (
      await db
        .select()
        .from(payshareParticipants)
        .where(
          and(
            eq(payshareParticipants.payshareSessionId, input.payshareSessionId),
            eq(payshareParticipants.participantId, input.participantId),
          ),
        )
        .limit(1)
    )[0];
  }
}
