/**
 * How a registration was paid for, when it wasn't paid online.
 *
 * Used by the office / walk-up registration flow: a parent registers at the
 * counter and pays by EFTPOS or cash, and we need to be able to reconcile the
 * terminal and the till against ClubOS at the end of the day.
 *
 * These values are validated in app code rather than by a database CHECK — a
 * stale CHECK on an enum-ish column is how the MFL checkout started 500ing.
 * Adding a tender here is a deploy, not a migration.
 */

export const OFFICE_PAYMENT_METHODS = [
  { value: "eftpos", label: "EFTPOS" },
  { value: "cash", label: "Cash" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "other", label: "Other" },
] as const;

export type OfficePaymentMethod = (typeof OFFICE_PAYMENT_METHODS)[number]["value"];

/**
 * Set by the system on registrations paid through our own Stripe checkout.
 * Never offered in the office picker — nobody hands a card over the counter
 * into Stripe's hosted flow, and mislabelling an online payment as a counter
 * one would corrupt the very reconciliation this exists for.
 */
export const ONLINE_PAYMENT_METHOD = "online_card";

const OFFICE_VALUES: readonly string[] = OFFICE_PAYMENT_METHODS.map((m) => m.value);

export function isOfficePaymentMethod(value: unknown): value is OfficePaymentMethod {
  return typeof value === "string" && OFFICE_VALUES.includes(value);
}

/**
 * A human label for any stored value, including rows written before this
 * feature existed. Returns null when there is genuinely nothing to show —
 * callers render "—", never an invented tender.
 */
export function paymentMethodLabel(value: unknown): string | null {
  if (value === ONLINE_PAYMENT_METHOD) return "Online (card)";
  const match = OFFICE_PAYMENT_METHODS.find((m) => m.value === value);
  return match ? match.label : null;
}

/**
 * What a registration should read as in a list, given what we actually know.
 *
 * An older online registration carries no payment_method at all, but it has a
 * Stripe PaymentIntent — so it can be shown honestly as an online card payment
 * without writing a backfilled value into the database. Anything else with no
 * method recorded reads as unknown, which is the truth.
 */
export function describePaymentMethod(reg: {
  paymentMethod?: string | null;
  stripePaymentIntentId?: string | null;
}): { label: string; known: boolean; isOffice: boolean } {
  const explicit = paymentMethodLabel(reg.paymentMethod);
  if (explicit) {
    return { label: explicit, known: true, isOffice: isOfficePaymentMethod(reg.paymentMethod) };
  }
  if (reg.stripePaymentIntentId) {
    return { label: "Online (card)", known: true, isOffice: false };
  }
  return { label: "Not recorded", known: false, isOffice: false };
}
