// Split Pay engine — split a FIXED team fee across the squad, each member paying
// their own equal share on their own card.
//
// Lock-then-charge: members join + save a card (SetupIntent, NO charge) while the
// session is 'open'; the live per-person share recomputes as people join/drop
// (just a number — no money moves). When the captain locks, every saved card is
// charged its frozen ÷N share ONCE, off-session. Because money only moves at
// lock, the "re-split when someone drops/joins" contingency needs no refunds or
// re-charges. apportion/equalSplit guarantees the N shares sum to the fee to the
// cent, so the club always collects the full fee.
//
// This module owns split_sessions / split_members + the charge mechanics + the
// idempotent state transitions + member receipt emails. It is deliberately
// DECOUPLED from routes.ts (no import cycle): SETTLEMENT (confirm the team
// registration + materialise the leagueTeam + captain email + Purchase) lives in
// routes.ts where those helpers are, and is invoked via the exported
// markSplitSettledOnce() + isSettleReady() whenever a charge completes — from
// both the lock endpoint and the Stripe webhook (idempotent either way).
//
// Money-safety mirrors the rest of MFL: cents everywhere, NZD, GST inclusive,
// server-authoritative amounts, conditional-UPDATE idempotency guards (the same
// pattern as confirmRegistrationOnce / claimBalance), Stripe idempotency keys.

import crypto from "crypto";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { db } from "./db";
import { splitSessions, splitMembers, registrations, leagueDivisions, type SplitSession, type SplitMember } from "@shared/schema";
import { getOrCreateCustomer, createOffSessionPaymentIntent, createPaymentIntent, createRefund, stripe } from "./stripe";
import { equalSplit } from "@shared/league-pricing";

const SESSION_TTL_DAYS = 30;

// V1 (PayShare model): each player pays a FIXED equal share = team fee ÷ squad
// size, on the spot, the moment they add their card. No captain "lock" step. The
// share matches what the hub + register page display (round, not ceil) so what a
// player sees is exactly what they pay. If a teammate never pays, the club simply
// collects less — that's the group's responsibility (same as PayShare). When
// `targetCount` players have paid, the session settles (team confirmed).
function memberShareCents(s: { totalCents: number; targetCount: number | null }): number {
  const n = s.targetCount && s.targetCount > 0 ? s.targetCount : 1;
  return Math.round(s.totalCents / n);
}

function token(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function maskEmail(email: string): string {
  const [u, d] = String(email).split("@");
  if (!d) return "***";
  const head = u.length <= 1 ? u : u[0] + "***";
  return `${head}@${d}`;
}

async function sessionByCode(code: string): Promise<SplitSession | undefined> {
  const [s] = await db.select().from(splitSessions).where(eq(splitSessions.shareCode, code));
  return s;
}

async function membersOf(sessionId: number): Promise<SplitMember[]> {
  return db.select().from(splitMembers)
    .where(eq(splitMembers.splitSessionId, sessionId))
    .orderBy(asc(splitMembers.id));
}

// Conditional-UPDATE guards — only the winning caller proceeds, so side effects
// (charge, settle, receipt) fire exactly once under webhook + client races.
async function flipStatusOnce(sessionId: number, from: string, to: string): Promise<boolean> {
  const [row] = await db.update(splitSessions).set({ status: to })
    .where(and(eq(splitSessions.id, sessionId), eq(splitSessions.status, from)))
    .returning({ id: splitSessions.id });
  return !!row;
}

async function markPaidOnce(memberId: number, paymentIntentId: string): Promise<boolean> {
  const [row] = await db.update(splitMembers)
    .set({ status: "paid", paidAt: new Date(), stripePaymentIntentId: paymentIntentId })
    .where(and(eq(splitMembers.id, memberId), ne(splitMembers.status, "paid")))
    .returning({ id: splitMembers.id });
  return !!row;
}

// Atomic open→settled flip. The winner runs the one-time settlement in routes.ts
// (confirm reg + materialise team + captain email + Purchase). Fires when the
// squad target has been reached (every player paid their share on the spot).
export async function markSplitSettledOnce(sessionId: number): Promise<boolean> {
  const [row] = await db.update(splitSessions).set({ status: "settled", settledAt: new Date() })
    .where(and(eq(splitSessions.id, sessionId), eq(splitSessions.status, "open")))
    .returning({ id: splitSessions.id });
  return !!row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Create — called from the register endpoint when paymentChoice === 'split'. The
// team registration has already been created ('pending'); we attach a split
// session + the organiser (captain) as the first paying member and hand back a
// SetupIntent so the captain saves their own card on the hub.
// ─────────────────────────────────────────────────────────────────────────────
export async function createSplitForRegistration(opts: {
  organizationId: number;
  registration: { id: number; totalCents: number; teamName?: string | null; leagueDivisionId?: number | null; programId: number };
  captain: { email: string; firstName: string; lastName?: string; phone?: string };
  targetCount?: number | null;
  deadlineAt?: Date | null;
}): Promise<{ sessionId: number; shareCode: string; organiserToken: string; memberToken: string; paymentClientSecret: string | null; customerId: string }> {
  const { registration: reg, captain } = opts;
  const organiserToken = token();

  // Unique share code (retry on the rare collision; the unique index is the backstop).
  let shareCode = token(6);
  for (let i = 0; i < 5; i++) {
    const existing = await sessionByCode(shareCode);
    if (!existing) break;
    shareCode = token(6);
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000);
  const [session] = await db.insert(splitSessions).values({
    organizationId: opts.organizationId,
    registrationId: reg.id,
    programId: reg.programId,
    leagueDivisionId: reg.leagueDivisionId ?? null,
    teamName: reg.teamName ?? null,
    totalCents: reg.totalCents,
    currency: "NZD",
    status: "open",
    targetCount: opts.targetCount ?? null,
    organiserToken,
    shareCode,
    deadlineAt: opts.deadlineAt ?? null,
    expiresAt,
  }).returning();

  // Captain is the first paying member. They pay their own fixed share on the hub.
  const customer = await getOrCreateCustomer({
    email: captain.email,
    name: `${captain.firstName} ${captain.lastName ?? ""}`.trim(),
    phone: captain.phone,
  });
  const shareCents = memberShareCents(session);
  const memberToken = token();
  const [captainMember] = await db.insert(splitMembers).values({
    splitSessionId: session.id,
    name: `${captain.firstName} ${captain.lastName ?? ""}`.trim(),
    email: captain.email.trim().toLowerCase(),
    phone: captain.phone ?? null,
    role: "organiser",
    status: "joined",
    stripeCustomerId: customer.id,
    chargedCents: shareCents,
    memberToken,
  }).returning();

  // On-session PaymentIntent for the captain's share — confirmed on the hub via
  // Elements. Stable idempotency key so a refresh reuses the same intent.
  const pi = await createPaymentIntent({
    registrationId: reg.id,
    campName: `${session.teamName || "Team"} — split share`,
    totalCents: shareCents,
    currency: "NZD",
    parentEmail: captain.email,
    customerId: customer.id,
    metadata: {
      registrationType: "league_share",
      splitSessionId: String(session.id),
      splitMemberId: String(captainMember.id),
      registrationId: String(reg.id),
    },
    idempotencyKey: `split-${session.id}-member-${captainMember.id}-pay`,
  });
  await db.update(splitMembers).set({ stripePaymentIntentId: pi.id }).where(eq(splitMembers.id, captainMember.id));

  return { sessionId: session.id, shareCode, organiserToken, memberToken, paymentClientSecret: pi.client_secret, customerId: customer.id };
}

// Public view for the hub / joiner / polling. viewerToken (organiser or member)
// unlocks that viewer's own status + email. Other members' emails are masked.
export async function getSplitView(code: string, viewerToken?: string) {
  const s = await sessionByCode(code);
  if (!s) return null;
  const members = await membersOf(s.id);
  const active = members.filter((m) => m.status !== "removed");
  // "cardCount" now tracks how many have paid (no separate card-saved state).
  const withCard = active.filter((m) => m.status === "paid");
  const paid = active.filter((m) => m.status === "paid");
  let viewer = viewerToken ? members.find((m) => m.memberToken === viewerToken) : undefined;
  const isOrganiserView = !!viewerToken && viewerToken === s.organiserToken;
  // The captain identifies with the session organiserToken (NOT a member token),
  // so resolve their own member record here — otherwise the hub shows them no
  // pay form and they can't pay their share.
  if (!viewer && isOrganiserView) viewer = members.find((m) => m.role === "organiser");

  return {
    code: s.shareCode,
    status: s.status,
    teamName: s.teamName,
    totalCents: s.totalCents,
    currency: s.currency,
    targetCount: s.targetCount,
    joinedCount: active.length,
    cardCount: withCard.length,
    paidCount: paid.length,
    shareLockedCents: s.shareLockedCents,
    // Each player's fixed share = team fee ÷ squad size (matches what's charged).
    provisionalShareCents: memberShareCents(s),
    lockedAt: s.lockedAt,
    settledAt: s.settledAt,
    deadlineAt: s.deadlineAt,
    isOrganiserView,
    members: active.map((m) => ({
      id: m.id,
      name: m.name,
      emailMasked: maskEmail(m.email),
      role: m.role,
      status: m.status,
      chargedCents: m.chargedCents,
      isYou: viewer ? m.id === viewer.id : false,
    })),
    viewer: viewer ? {
      memberId: viewer.id, role: viewer.role, status: viewer.status,
      chargedCents: viewer.chargedCents, email: viewer.email,
      setupIntentId: viewer.stripeSetupIntentId,
    } : null,
  };
}

// A squad member opens the link and joins. Creates (or reactivates) their member
// row, then issues an on-session PaymentIntent for their fixed share so they pay
// on the spot (PayShare model — no card-save, no captain lock).
export async function joinSplit(code: string, body: { name?: string; email: string; phone?: string }) {
  const s = await sessionByCode(code);
  if (!s) return { error: "not_found" as const };
  if (s.status !== "open") return { error: "closed" as const };
  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !/.+@.+\..+/.test(email)) return { error: "invalid_email" as const };
  const phone = String(body.phone || "").trim();
  if (!phone) return { error: "Please add a mobile number." as const };

  const customer = await getOrCreateCustomer({ email, name: body.name, phone });
  const shareCents = memberShareCents(s);

  const existing = (await membersOf(s.id)).find((m) => m.email.toLowerCase() === email);
  let member: SplitMember;
  if (existing) {
    if (existing.status === "paid") {
      // Already paid — just hand back their token; nothing more to charge.
      return { memberToken: existing.memberToken, paymentClientSecret: null, memberId: existing.id, alreadyPaid: true as const };
    }
    [member] = await db.update(splitMembers).set({
      name: body.name ?? existing.name,
      phone: body.phone ?? existing.phone,
      status: "joined", // re-join reactivates a removed/idle row
      stripeCustomerId: customer.id,
      chargedCents: shareCents,
      memberToken: existing.memberToken || token(),
    }).where(eq(splitMembers.id, existing.id)).returning();
  } else {
    try {
      [member] = await db.insert(splitMembers).values({
        splitSessionId: s.id, name: body.name ?? null, email, phone: body.phone ?? null,
        role: "member", status: "joined",
        stripeCustomerId: customer.id, chargedCents: shareCents, memberToken: token(),
      }).returning();
    } catch (e: any) {
      // Lost a same-email race → load + update the row that won.
      if (e?.code === "23505" || /duplicate|unique/i.test(e?.message || "")) {
        const row = (await membersOf(s.id)).find((m) => m.email.toLowerCase() === email)!;
        [member] = await db.update(splitMembers).set({ stripeCustomerId: customer.id, chargedCents: shareCents })
          .where(eq(splitMembers.id, row.id)).returning();
      } else throw e;
    }
  }

  const pi = await createPaymentIntent({
    registrationId: s.registrationId ?? 0,
    campName: `${s.teamName || "Team"} — split share`,
    totalCents: shareCents,
    currency: s.currency || "NZD",
    parentEmail: member.email,
    customerId: customer.id,
    metadata: {
      registrationType: "league_share",
      splitSessionId: String(s.id),
      splitMemberId: String(member.id),
      registrationId: String(s.registrationId ?? ""),
    },
    idempotencyKey: `split-${s.id}-member-${member.id}-pay`,
  });
  await db.update(splitMembers).set({ stripePaymentIntentId: pi.id }).where(eq(splitMembers.id, member.id));
  return { memberToken: member.memberToken, paymentClientSecret: pi.client_secret, memberId: member.id };
}

// Mark a member's card saved from their SetupIntent (webhook setup_intent.succeeded
// AND the client confirm-setup fallback both call this). Pulls the saved
// payment_method off the SetupIntent. Idempotent; never downgrades a 'paid' member.
export async function markCardSavedBySetupIntent(setupIntentId: string): Promise<void> {
  if (!setupIntentId) return;
  const [m] = await db.select().from(splitMembers).where(eq(splitMembers.stripeSetupIntentId, setupIntentId));
  if (!m) return;
  const si = await stripe.setupIntents.retrieve(setupIntentId);
  const pm = typeof si.payment_method === "string" ? si.payment_method : (si.payment_method as any)?.id;
  if (si.status !== "succeeded" || !pm) return;
  const customerId = (typeof si.customer === "string" ? si.customer : (si.customer as any)?.id) || m.stripeCustomerId;
  await db.update(splitMembers).set({
    stripePaymentMethodId: pm,
    stripeCustomerId: customerId,
    status: "card_saved",
  }).where(and(eq(splitMembers.id, m.id), ne(splitMembers.status, "paid")));
}

// Issue (or reuse) the on-session PaymentIntent for an existing member's share —
// refresh-safe: the hub calls this whenever an unpaid member needs the pay form
// (e.g. after a reload that lost the original client secret, or to retry a
// declined card). The stable idempotency key returns the SAME intent created at
// join, whose client secret can be re-confirmed if a card was declined.
export async function payShareIntent(code: string, memberToken: string): Promise<{ error?: string; paymentClientSecret?: string | null }> {
  const s = await sessionByCode(code);
  if (!s) return { error: "not_found" };
  if (s.status !== "open") return { error: "closed" };
  const [m] = await db.select().from(splitMembers).where(and(eq(splitMembers.memberToken, memberToken), eq(splitMembers.splitSessionId, s.id)));
  if (!m) return { error: "not_found" };
  if (m.status === "paid") return { error: "already_paid" };
  let customerId = m.stripeCustomerId;
  if (!customerId) {
    const c = await getOrCreateCustomer({ email: m.email, name: m.name ?? undefined, phone: m.phone ?? undefined });
    customerId = c.id;
  }
  const shareCents = memberShareCents(s);
  const pi = await createPaymentIntent({
    registrationId: s.registrationId ?? 0,
    campName: `${s.teamName || "Team"} — split share`,
    totalCents: shareCents,
    currency: s.currency || "NZD",
    parentEmail: m.email,
    customerId,
    metadata: {
      registrationType: "league_share",
      splitSessionId: String(s.id),
      splitMemberId: String(m.id),
      registrationId: String(s.registrationId ?? ""),
    },
    idempotencyKey: `split-${s.id}-member-${m.id}-pay`,
  });
  await db.update(splitMembers).set({
    stripePaymentIntentId: pi.id, stripeCustomerId: customerId, chargedCents: shareCents,
    status: m.status === "failed" ? "joined" : m.status,
  }).where(and(eq(splitMembers.id, m.id), ne(splitMembers.status, "paid")));
  return { paymentClientSecret: pi.client_secret };
}

export async function removeMember(code: string, organiserToken: string, memberId: number) {
  const s = await sessionByCode(code);
  if (!s || s.organiserToken !== organiserToken) return { error: "forbidden" as const };
  if (s.status !== "open") return { error: "closed" as const };
  const [m] = await db.select().from(splitMembers).where(and(eq(splitMembers.id, memberId), eq(splitMembers.splitSessionId, s.id)));
  if (!m) return { error: "not_found" as const };
  if (m.role === "organiser") return { error: "cannot_remove_organiser" as const };
  await db.update(splitMembers).set({ status: "removed" }).where(eq(splitMembers.id, memberId));
  return { ok: true as const };
}

export async function leaveSplit(code: string, memberToken: string) {
  const s = await sessionByCode(code);
  if (!s) return { error: "not_found" as const };
  if (s.status !== "open") return { error: "closed" as const };
  const [m] = await db.select().from(splitMembers).where(and(eq(splitMembers.memberToken, memberToken), eq(splitMembers.splitSessionId, s.id)));
  if (!m) return { error: "not_found" as const };
  if (m.role === "organiser") return { error: "organiser_cannot_leave" as const }; // captain cancels instead
  await db.update(splitMembers).set({ status: "removed" }).where(eq(splitMembers.id, m.id));
  return { ok: true as const };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lock & charge — the captain freezes the roster and we charge every saved card
// its exact ÷N share ONCE, off-session. Only members holding a valid card are
// included. Blocks if any member still hasn't added a card. After charging, the
// caller checks isSettleReady() → settles. A declined card → member 'failed';
// they retry on-session OR the captain resolves — NEVER re-split onto others.
// capacityCheck (injected from routes) re-verifies the division isn't full, so
// we never charge for a team that can't be placed.
// ─────────────────────────────────────────────────────────────────────────────
export async function lockAndChargeSplit(
  code: string,
  organiserToken: string,
  opts?: { capacityCheck?: (divisionId: number | null) => Promise<boolean> },
): Promise<{ error?: string; missingCards?: number; status?: string; shareCents?: number; charged?: number; failed?: number; sessionId?: number }> {
  const s = await sessionByCode(code);
  if (!s) return { error: "not_found" };
  if (s.organiserToken !== organiserToken) return { error: "forbidden" };
  if (s.status === "settled") return { status: "settled", sessionId: s.id };
  if (s.status !== "open") return { error: "not_open", status: s.status };

  const active = (await membersOf(s.id)).filter((m) => m.status !== "removed");
  const missing = active.filter((m) => m.status === "joined"); // joined but no card yet
  if (missing.length > 0) return { error: "members_without_card", missingCards: missing.length };
  const eligible = active.filter((m) => m.status === "card_saved" && m.stripePaymentMethodId && m.stripeCustomerId);
  if (eligible.length === 0) return { error: "no_payers" };

  if (opts?.capacityCheck) {
    const ok = await opts.capacityCheck(s.leagueDivisionId ?? null);
    if (!ok) return { error: "division_full" };
  }

  const shares = equalSplit(s.totalCents, eligible.length);
  const shareMax = Math.max(...shares);

  // Atomic open→settling. Only the winner charges (guards a double-tap / race).
  const flipped = await flipStatusOnce(s.id, "open", "settling");
  if (!flipped) return { error: "already_locking", status: "settling" };
  await db.update(splitSessions)
    .set({ lockedAt: new Date(), shareLockedCents: shareMax, targetCount: eligible.length })
    .where(eq(splitSessions.id, s.id));

  // Freeze each member's share BEFORE charging so the webhook can reconcile.
  for (let i = 0; i < eligible.length; i++) {
    await db.update(splitMembers).set({ chargedCents: shares[i] }).where(eq(splitMembers.id, eligible[i].id));
  }

  let charged = 0, failed = 0;
  for (let i = 0; i < eligible.length; i++) {
    const m = eligible[i];
    try {
      const pi = await createOffSessionPaymentIntent({
        customerId: m.stripeCustomerId!,
        paymentMethodId: m.stripePaymentMethodId!,
        amountCents: shares[i],
        currency: s.currency || "NZD",
        description: `${s.teamName || "Team"} — split share (${eligible.length}-way)`,
        metadata: {
          registrationType: "league_share",
          splitSessionId: String(s.id),
          splitMemberId: String(m.id),
          registrationId: String(s.registrationId ?? ""),
        },
        idempotencyKey: `split-${s.id}-member-${m.id}`,
      });
      await db.update(splitMembers).set({ stripePaymentIntentId: pi.id }).where(eq(splitMembers.id, m.id));
      if (pi.status === "succeeded") {
        if (await markPaidOnce(m.id, pi.id)) { charged++; void sendMemberReceipt(s, m, shares[i]); }
      } else {
        // requires_action / processing → not paid yet; member retries on-session.
        failed++;
        await db.update(splitMembers).set({ status: "failed" }).where(and(eq(splitMembers.id, m.id), ne(splitMembers.status, "paid")));
      }
    } catch (e: any) {
      failed++;
      const piId = e?.raw?.payment_intent?.id ?? e?.payment_intent?.id ?? null;
      await db.update(splitMembers).set({ status: "failed", ...(piId ? { stripePaymentIntentId: piId } : {}) })
        .where(and(eq(splitMembers.id, m.id), ne(splitMembers.status, "paid")));
      console.error(`[SplitPay] lock charge failed session=${s.id} member=${m.id}:`, e?.message);
    }
  }
  return { status: failed > 0 ? "settling" : "charged", shareCents: shareMax, charged, failed, sessionId: s.id };
}

// Webhook: a league_share PaymentIntent succeeded → mark that member paid (once).
export async function markPaidByPaymentIntent(pi: any): Promise<{ sessionId: number } | null> {
  const memberId = parseInt(pi.metadata?.splitMemberId);
  if (!memberId) return null;
  const [m] = await db.select().from(splitMembers).where(eq(splitMembers.id, memberId));
  if (!m) return null;
  if (await markPaidOnce(m.id, pi.id)) {
    const [s] = await db.select().from(splitSessions).where(eq(splitSessions.id, m.splitSessionId));
    if (s) void sendMemberReceipt(s, m, m.chargedCents ?? pi.amount_received ?? 0);
  }
  return { sessionId: m.splitSessionId };
}

// Webhook: a league_share PaymentIntent failed → mark that member failed (unless
// already paid via another path).
export async function markFailedByPaymentIntent(pi: any): Promise<{ sessionId: number } | null> {
  const memberId = parseInt(pi.metadata?.splitMemberId);
  if (!memberId) return null;
  const [m] = await db.select().from(splitMembers).where(eq(splitMembers.id, memberId));
  if (!m) return null;
  await db.update(splitMembers).set({ status: "failed" }).where(and(eq(splitMembers.id, m.id), ne(splitMembers.status, "paid")));
  return { sessionId: m.splitSessionId };
}

// A failed member retries on-session: an on-session PaymentIntent they complete
// via Elements. On success the webhook marks them paid + the session settles.
export async function retryMemberCharge(code: string, memberToken: string): Promise<{ error?: string; clientSecret?: string | null }> {
  const s = await sessionByCode(code);
  if (!s) return { error: "not_found" };
  if (s.status !== "settling") return { error: "not_locked" };
  const [m] = await db.select().from(splitMembers).where(and(eq(splitMembers.memberToken, memberToken), eq(splitMembers.splitSessionId, s.id)));
  if (!m) return { error: "not_found" };
  if (m.status === "paid") return { error: "already_paid" };
  if (!m.chargedCents) return { error: "no_amount" };

  const pi = await createPaymentIntent({
    registrationId: s.registrationId ?? 0,
    campName: `${s.teamName || "Team"} — split share`,
    totalCents: m.chargedCents,
    currency: s.currency || "NZD",
    parentEmail: m.email,
    customerId: m.stripeCustomerId ?? undefined,
    metadata: {
      registrationType: "league_share",
      splitSessionId: String(s.id),
      splitMemberId: String(m.id),
      registrationId: String(s.registrationId ?? ""),
    },
    idempotencyKey: `split-retry-${m.id}-${m.stripePaymentIntentId ?? "0"}`,
  });
  await db.update(splitMembers).set({ stripePaymentIntentId: pi.id, status: "card_saved" }).where(eq(splitMembers.id, m.id));
  return { clientSecret: pi.client_secret };
}

// Recovery / admin "collect the rest": (re)charge any member who should pay but
// hasn't, for a session already 'settling'. Covers (a) the rare crash mid-lock
// where a share was frozen (chargedCents set) but never charged, and (b) an admin
// forcing a retry of a declined card. Off-session on the member's saved card.
// Idempotent; the caller settles afterwards if complete.
export async function chargeOutstandingShares(sessionId: number): Promise<{ charged: number; failed: number; sessionId: number }> {
  const [s] = await db.select().from(splitSessions).where(eq(splitSessions.id, sessionId));
  let charged = 0, failed = 0;
  if (!s || s.status !== "settling") return { charged, failed, sessionId };
  const outstanding = (await membersOf(sessionId)).filter(
    (m) => m.status !== "removed" && m.status !== "paid" && m.chargedCents != null && m.stripeCustomerId && m.stripePaymentMethodId,
  );
  for (const m of outstanding) {
    try {
      const pi = await createOffSessionPaymentIntent({
        customerId: m.stripeCustomerId!,
        paymentMethodId: m.stripePaymentMethodId!,
        amountCents: m.chargedCents!,
        currency: s.currency || "NZD",
        description: `${s.teamName || "Team"} — split share (collect)`,
        metadata: { registrationType: "league_share", splitSessionId: String(s.id), splitMemberId: String(m.id), registrationId: String(s.registrationId ?? "") },
        idempotencyKey: `split-${s.id}-member-${m.id}-collect-${m.stripePaymentIntentId ?? "0"}`,
      });
      await db.update(splitMembers).set({ stripePaymentIntentId: pi.id }).where(eq(splitMembers.id, m.id));
      if (pi.status === "succeeded" && (await markPaidOnce(m.id, pi.id))) { charged++; void sendMemberReceipt(s, m, m.chargedCents!); }
      else { failed++; await db.update(splitMembers).set({ status: "failed" }).where(and(eq(splitMembers.id, m.id), ne(splitMembers.status, "paid"))); }
    } catch (e: any) {
      failed++;
      await db.update(splitMembers).set({ status: "failed" }).where(and(eq(splitMembers.id, m.id), ne(splitMembers.status, "paid")));
      console.error(`[SplitPay] chargeOutstanding failed session=${s.id} member=${m.id}:`, e?.message);
    }
  }
  return { charged, failed, sessionId };
}

// True when the squad target has paid → ready to settle (confirm the team). In
// the charge-on-pay model the bar is the squad size: once `targetCount` players
// have each paid their share, the fee is collected and the team is confirmed.
export async function isSettleReady(sessionId: number): Promise<boolean> {
  const [s] = await db.select().from(splitSessions).where(eq(splitSessions.id, sessionId));
  if (!s || s.status !== "open") return false;
  const paid = (await membersOf(sessionId)).filter((m) => m.status === "paid");
  const target = s.targetCount && s.targetCount > 0 ? s.targetCount : paid.length;
  return paid.length > 0 && paid.length >= target;
}

// The registration this split funds (routes.ts settlement needs it).
export async function getSplitRegistrationId(sessionId: number): Promise<number | null> {
  const [s] = await db.select().from(splitSessions).where(eq(splitSessions.id, sessionId));
  return s?.registrationId ?? null;
}

// Captain cancels — refund any members already charged, cancel the session + the
// pending team registration. Only the EXPLICIT cancel ever refunds. Disallowed
// once settled (a confirmed team must be unwound via the admin refund flow).
export async function cancelSplit(code: string, organiserToken: string): Promise<{ ok?: boolean; error?: string; refunded?: number }> {
  const s = await sessionByCode(code);
  if (!s) return { error: "not_found" };
  if (s.organiserToken !== organiserToken) return { error: "forbidden" };
  return doCancel(s);
}

// Admin cancel (no organiser token) — refunds anyone charged + cancels.
export async function adminCancelSplit(sessionId: number): Promise<{ ok?: boolean; error?: string; refunded?: number }> {
  const [s] = await db.select().from(splitSessions).where(eq(splitSessions.id, sessionId));
  if (!s) return { error: "not_found" };
  return doCancel(s);
}

async function doCancel(s: SplitSession): Promise<{ ok?: boolean; error?: string; refunded?: number }> {
  if (s.status === "settled") return { error: "already_settled" };
  const members = await membersOf(s.id);
  let refunded = 0;
  for (const m of members) {
    if (m.status === "paid" && m.stripePaymentIntentId) {
      try {
        const r = await createRefund({
          paymentIntentId: m.stripePaymentIntentId,
          reason: "split cancelled",
          metadata: { splitMemberId: String(m.id), splitSessionId: String(s.id) },
          idempotencyKey: `split-refund-${m.id}`,
        });
        await db.update(splitMembers).set({ stripeRefundId: r.id, stripeRefundStatus: r.status ?? "pending" }).where(eq(splitMembers.id, m.id));
        refunded++;
      } catch (e: any) {
        console.error(`[SplitPay] refund failed member=${m.id}:`, e?.message);
      }
    }
  }
  await db.update(splitSessions).set({ status: "cancelled" }).where(eq(splitSessions.id, s.id));
  if (s.registrationId) {
    try { await db.update(registrations).set({ status: "cancelled" }).where(and(eq(registrations.id, s.registrationId), ne(registrations.status, "confirmed"))); } catch {}
  }
  return { ok: true, refunded };
}

// ── Admin views ──────────────────────────────────────────────────────────────
export async function listSplitsForCompetition(competitionId: number) {
  const rows = await db.select().from(splitSessions)
    .innerJoin(leagueDivisions, eq(splitSessions.leagueDivisionId, leagueDivisions.id))
    .where(eq(leagueDivisions.competitionId, competitionId))
    .orderBy(desc(splitSessions.createdAt));
  const out = [] as any[];
  for (const row of rows) {
    const s = (row as any).split_sessions as SplitSession;
    const div = (row as any).league_divisions as any;
    const members = await membersOf(s.id);
    const active = members.filter((m) => m.status !== "removed");
    const paid = active.filter((m) => m.status === "paid");
    out.push({
      id: s.id, shareCode: s.shareCode, teamName: s.teamName, divisionName: div?.name ?? null,
      status: s.status, totalCents: s.totalCents,
      joinedCount: active.length,
      cardCount: active.filter((m) => m.status === "card_saved" || m.status === "paid").length,
      paidCount: paid.length,
      collectedCents: paid.reduce((a, m) => a + (m.chargedCents ?? 0), 0),
      createdAt: s.createdAt, lockedAt: s.lockedAt, settledAt: s.settledAt,
    });
  }
  return out;
}

export async function getSplitDetail(sessionId: number) {
  const [s] = await db.select().from(splitSessions).where(eq(splitSessions.id, sessionId));
  if (!s) return null;
  const members = await membersOf(sessionId);
  return {
    session: s,
    members: members.map((m) => ({
      id: m.id, name: m.name, email: m.email, phone: m.phone, role: m.role, status: m.status,
      chargedCents: m.chargedCents, paidAt: m.paidAt, stripeRefundStatus: m.stripeRefundStatus,
    })),
  };
}

// MFL-branded "your share is paid" receipt to a member. Fire-and-forget.
async function sendMemberReceipt(s: SplitSession, m: SplitMember, amountCents: number): Promise<void> {
  try {
    const { sendSplitShareReceiptEmail } = await import("./email");
    await sendSplitShareReceiptEmail({
      to: m.email,
      memberName: m.name || "there",
      teamName: s.teamName || "your team",
      amountCents,
      registrationId: s.registrationId ?? undefined,
    });
  } catch (e: any) {
    console.error(`[SplitPay] member receipt email failed member=${m.id}:`, e?.message);
  }
}
