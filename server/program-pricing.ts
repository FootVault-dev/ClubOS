// Program pricing engine. Same shape as print-pricing — one pure function
// callable from server and used to drive the public registration price
// preview. Server is the source of truth; the client uses it for display
// only and the price is re-validated server-side before Stripe charges.
//
// Models:
//   - flat: pay the full fee regardless of when you join
//   - term_prorated: discount based on sessions still to come in the term
//   - per_day: holiday camps charge per day attended (handled elsewhere)

import type { Program, Term } from "@shared/schema";

export interface ProgramQuote {
  fullPriceCents: number;
  payNowCents: number;
  discountCents: number;
  sessionsRemaining: number;
  totalSessions: number;
  reason: string;          // human-readable explanation, shown next to the price
  model: "flat" | "term_prorated" | "per_day";
}

// Approximate weekday-only count of sessions between two dates, capped at
// the program's session_count. Most NZ school terms are 10–12 weeks running
// once a week, so weeks ≈ sessions for a typical recreational class.
function weeksBetween(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + "T00:00:00").getTime();
  const b = new Date(toIso + "T00:00:00").getTime();
  if (b < a) return 0;
  return Math.max(1, Math.round((b - a) / (1000 * 60 * 60 * 24 * 7)) + 1);
}

export function quoteProgram(
  program: Program,
  term: Term | null,
  todayIso?: string,
): ProgramQuote {
  const today = todayIso ?? new Date().toISOString().split("T")[0];
  const fullPriceCents = program.termPriceCents
    ?? Math.round(parseFloat((program.fee as unknown as string) || "0") * 100);

  const totalSessions = program.sessionCount
    ?? (term ? weeksBetween(term.startDate, term.endDate) : 10);

  if (program.pricingModel !== "term_prorated" || !term) {
    return {
      fullPriceCents,
      payNowCents: fullPriceCents,
      discountCents: 0,
      sessionsRemaining: totalSessions,
      totalSessions,
      reason: "Full term price",
      model: (program.pricingModel as any) ?? "flat",
    };
  }

  // Pro-rated branch
  if (today < term.startDate) {
    return {
      fullPriceCents,
      payNowCents: fullPriceCents,
      discountCents: 0,
      sessionsRemaining: totalSessions,
      totalSessions,
      reason: `Term hasn't started yet — full price`,
      model: "term_prorated",
    };
  }
  if (today > term.endDate) {
    return {
      fullPriceCents,
      payNowCents: 0,
      discountCents: fullPriceCents,
      sessionsRemaining: 0,
      totalSessions,
      reason: "Term has ended — registration closed",
      model: "term_prorated",
    };
  }

  const sessionsRemaining = weeksBetween(today, term.endDate);
  const cappedRemaining = Math.min(sessionsRemaining, totalSessions);

  // Grace weeks — full term price for the first N weeks, pro-rata after.
  // Same column, same rule as the academy engine (shared/academy.ts), so no
  // route can quote this programme at a price another route disagrees with.
  // 0 on every programme that hasn't opted in, i.e. unchanged behaviour.
  const graceWeeks = Math.max(0, Math.min(totalSessions, Math.floor(Number((program as any).prorataGraceWeeks) || 0)));
  const msSinceStart = new Date(today + "T00:00:00").getTime() - new Date(term.startDate + "T00:00:00").getTime();
  const weeksElapsed = Math.max(0, Math.floor(msSinceStart / (1000 * 60 * 60 * 24 * 7)));
  if (weeksElapsed < graceWeeks) {
    return {
      fullPriceCents,
      payNowCents: fullPriceCents,
      discountCents: 0,
      sessionsRemaining: cappedRemaining,
      totalSessions,
      reason: `Full term price — pro-rata starts in week ${graceWeeks + 1}`,
      model: "term_prorated",
    };
  }

  const ratio = cappedRemaining / totalSessions;
  const payNowCents = Math.round(fullPriceCents * ratio);
  const discountCents = fullPriceCents - payNowCents;

  return {
    fullPriceCents,
    payNowCents,
    discountCents,
    sessionsRemaining: cappedRemaining,
    totalSessions,
    reason: `${cappedRemaining} of ${totalSessions} sessions remaining — pay only for what's left`,
    model: "term_prorated",
  };
}
