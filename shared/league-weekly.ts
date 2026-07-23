// ── MFL weekly-plan missed-payment derivation ────────────────────────────────
// ONE derivation shared by the admin Registrations list, the payment-breakdown
// modal and the reminder sender, so they can never disagree about who is
// behind. Missed is DERIVED, never stored (a charge that lands late simply
// stops being missed on the next read).
//
// Anchor doctrine: the weekly schedule hangs off the REAL first-charge date —
// the Stripe subscription's trial_end, persisted at creation as
// registrations.weekly_first_charge_date (backfilled once from Stripe for
// older rows). Deriving from the competition start alone is WRONG for teams
// that registered after the term began: their subscription anchors at
// signup + 2 days, and comp-start maths would flag them missed on day one.
// Fallback chain when the stored anchor is missing: reproduce the creation
// rule max(comp start, registered + 2d); with no comp start either, we can't
// know the schedule → report nothing missed rather than invent an overdue.

export type MissedPaymentInput = {
  status?: string | null;              // registration status — only 'confirmed' can be missed
  paymentMode?: string | null;         // 'deposit_weekly' | 'installment' | 'split' | 'upfront' | …
  weeksTotal?: number | null;
  weeksPaid?: number | null;
  weeklyAmountCents?: number | null;
  weeklyFirstChargeDate?: string | null; // ISO date — Stripe trial_end (the real anchor)
  compStartDate?: string | null;         // fallback anchor input
  registeredAt?: string | Date | null;   // fallback anchor input (late signups)
  balanceStatus?: string | null;          // installment mode
  balanceCents?: number | null;           // installment mode
  nowMs: number;                          // pass Date.now() — keeps the fn pure/testable
};

export type MissedPaymentResult = {
  missedCount: number;   // how many charges are behind (weekly) or 1 (failed instalment)
  missedCents: number;   // dollars behind right now
  payoffCents: number;   // what clears the whole registration in one go
  kind: "weekly_missed" | "balance_failed" | null;
};

const DAY_MS = 86_400_000;
const NONE: MissedPaymentResult = { missedCount: 0, missedCents: 0, payoffCents: 0, kind: null };

/** The subscription id behind a Stripe invoice, across API versions.
 *  Pre-basil the invoice carries top-level `subscription`; from 2025-03's
 *  basil restructure (incl. the 2026 clover our webhook endpoint runs on) it
 *  lives at `parent.subscription_details.subscription`. Reading only the old
 *  field silently killed every weekly advance on prod — never again. */
export function subscriptionIdFromInvoice(invoice: any): string | undefined {
  const direct = invoice?.subscription;
  if (typeof direct === "string" && direct) return direct;
  if (direct && typeof direct === "object" && typeof direct.id === "string") return direct.id;
  const nested = invoice?.parent?.subscription_details?.subscription;
  if (typeof nested === "string" && nested) return nested;
  if (nested && typeof nested === "object" && typeof nested.id === "string") return nested.id;
  return undefined;
}

/** Parse a bare ISO date at UTC midnight — same maths the breakdown endpoint uses. */
function isoToUtcMs(iso: string): number | null {
  const ms = new Date(iso.slice(0, 10) + "T00:00:00Z").getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** The weekly schedule's first-charge anchor in ms, or null when unknowable. */
export function weeklyAnchorMs(i: Pick<MissedPaymentInput, "weeklyFirstChargeDate" | "compStartDate" | "registeredAt">): number | null {
  if (i.weeklyFirstChargeDate) {
    const ms = isoToUtcMs(i.weeklyFirstChargeDate);
    if (ms != null) return ms;
  }
  // Reproduce the creation rule: trial_end = max(comp start, signup + 2d).
  const startMs = i.compStartDate ? isoToUtcMs(i.compStartDate) : null;
  const regMs = i.registeredAt ? new Date(i.registeredAt as any).getTime() : null;
  if (startMs != null && regMs != null && Number.isFinite(regMs)) return Math.max(startMs, regMs + 2 * DAY_MS);
  if (startMs != null) return startMs;
  return null;
}

/** How far behind a registration's payments are, right now. */
export function missedPayments(i: MissedPaymentInput): MissedPaymentResult {
  if (i.status && i.status !== "confirmed") return NONE;

  if (i.paymentMode === "deposit_weekly") {
    const weeksTotal = i.weeksTotal ?? 0;
    const weeklyCents = i.weeklyAmountCents ?? 0;
    const weeksPaid = Math.max(0, i.weeksPaid ?? 0);
    if (weeksTotal <= 0 || weeklyCents <= 0) return NONE;
    const remainingCents = Math.max(0, (weeksTotal - weeksPaid) * weeklyCents);
    if (remainingCents <= 0) return NONE;

    const anchorMs = weeklyAnchorMs(i);
    if (anchorMs == null) return { ...NONE, payoffCents: remainingCents };

    // Week n is due at anchor + (n-1) weeks; strictly past-due matches the
    // breakdown endpoint's `dueSec < nowSec` (the due day itself gets grace —
    // Stripe may still be charging it).
    let weeksDue = 0;
    for (let n = 1; n <= weeksTotal; n++) {
      if (anchorMs + (n - 1) * 7 * DAY_MS < i.nowMs) weeksDue = n;
      else break;
    }
    const missedCount = Math.max(0, weeksDue - weeksPaid);
    if (missedCount === 0) return { ...NONE, payoffCents: remainingCents };
    return { missedCount, missedCents: missedCount * weeklyCents, payoffCents: remainingCents, kind: "weekly_missed" };
  }

  if (i.paymentMode === "installment" && i.balanceStatus === "failed") {
    const owed = i.balanceCents ?? 0;
    if (owed <= 0) return NONE;
    return { missedCount: 1, missedCents: owed, payoffCents: owed, kind: "balance_failed" };
  }

  return NONE;
}
