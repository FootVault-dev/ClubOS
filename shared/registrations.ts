// "If you ain't paid you ain't registered." — Daniel, 2026-09-08.
//
// A registration is REAL only when money has landed: `confirmed`, or confirmed
// and later refunded in part or in full (a refund is a real person who WAS
// registered and whose money moved back). `pending` is checkout scaffolding —
// the row exists so the seat is held while a parent types a card number — and
// `cancelled` never took money. Neither is a registration, and neither ever
// appears on a staff screen: not in a programme's Players tab, a count tile,
// a person's card, a family, a search result or a Rambo answer.
//
// ONE decider. Every staff-facing read of `registrations` goes through this
// list, so a new status or a new surface cannot re-open the hole.

export const REAL_REGISTRATION_STATUSES = ["confirmed", "refunded", "partially_refunded"] as const;
export type RealRegistrationStatus = (typeof REAL_REGISTRATION_STATUSES)[number];

export function isRealRegistration(status: string | null | undefined): status is RealRegistrationStatus {
  return (REAL_REGISTRATION_STATUSES as readonly string[]).includes(status ?? "");
}

/** The same list as a SQL literal, for hand-written queries: `r.status IN ${…}`. */
export const REAL_REGISTRATION_STATUS_SQL = "('confirmed','refunded','partially_refunded')";
