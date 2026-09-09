/**
 * POS — the vocabulary and the arithmetic of the register.
 *
 * Validated here, not by database CHECKs, so a new tender or decline reason is
 * a deploy rather than a migration (the same rule as shared/payments.ts and
 * shared/fines.ts). The arithmetic lives here so the server and the register
 * compute the same rounding and the same GST from the same function.
 */

// ── Money accounts (buckets) ───────────────────────────────────────────────
// The Stripe account and bank account a sale's money lands in. A sale is bound
// to exactly one; the org → account map is data (pos_org_money_accounts).
export const POS_MONEY_ACCOUNTS = [
  { value: "club",  label: "Christchurch United Football Club" },
  { value: "cugc",  label: "United Gymnastics" },
  { value: "trust", label: "Cross Street Football Trust" },
] as const;
export type PosMoneyAccount = (typeof POS_MONEY_ACCOUNTS)[number]["value"];
export function isPosMoneyAccount(v: unknown): v is PosMoneyAccount {
  return typeof v === "string" && POS_MONEY_ACCOUNTS.some((a) => a.value === v);
}

// ── Tenders ───────────────────────────────────────────────────────────────
// `eftpos` is the club's STANDALONE bank terminal: staff key the amount into it
// and record the slip number here. `card_present` is a card taken through a
// Stripe reader or Tap to Pay — it always carries a PaymentIntent.
export const POS_TENDERS = [
  { value: "cash",          label: "Cash",             rounds: true,  needsReference: false },
  { value: "eftpos",        label: "EFTPOS terminal",  rounds: false, needsReference: true  },
  { value: "card_present",  label: "Card reader",      rounds: false, needsReference: false },
  { value: "bank_transfer", label: "Bank transfer",    rounds: false, needsReference: true  },
  { value: "other",         label: "Other",            rounds: false, needsReference: true  },
] as const;
export type PosTender = (typeof POS_TENDERS)[number]["value"];
export function isPosTender(v: unknown): v is PosTender {
  return typeof v === "string" && POS_TENDERS.some((t) => t.value === v);
}
export function posTenderLabel(v: unknown): string {
  return POS_TENDERS.find((t) => t.value === v)?.label ?? "Not recorded";
}
/** Tenders staff can record without a reader — everything but card_present. */
export const POS_MANUAL_TENDERS = POS_TENDERS.filter((t) => t.value !== "card_present");

// ── Statuses and kinds ─────────────────────────────────────────────────────
export const POS_SALE_STATUSES = ["open", "paid", "void", "refunded", "partially_refunded"] as const;
export type PosSaleStatus = (typeof POS_SALE_STATUSES)[number];

export const POS_LINE_KINDS = ["variant", "registration", "event_ticket", "custom"] as const;
export type PosLineKind = (typeof POS_LINE_KINDS)[number];
export function isPosLineKind(v: unknown): v is PosLineKind {
  return typeof v === "string" && (POS_LINE_KINDS as readonly string[]).includes(v);
}

export const POS_PAYMENT_STATUSES = ["pending", "succeeded", "failed", "canceled"] as const;

// Why a sale did NOT happen. `eftpos_only` is the one we are counting: a
// customer whose only card runs on the domestic eftpos rails, which a Stripe
// reader cannot take. Enough of these justifies an eftpos integration.
export const POS_DECLINE_REASONS = [
  { value: "eftpos_only",   label: "Eftpos-only card (no Visa/Mastercard)" },
  { value: "card_declined", label: "Card declined" },
  { value: "no_change",     label: "Couldn't give change" },
  { value: "price",         label: "Changed their mind at the price" },
  { value: "other",         label: "Other" },
] as const;
export type PosDeclineReason = (typeof POS_DECLINE_REASONS)[number]["value"];
export function isPosDeclineReason(v: unknown): v is PosDeclineReason {
  return typeof v === "string" && POS_DECLINE_REASONS.some((r) => r.value === v);
}

// ── Arithmetic ────────────────────────────────────────────────────────────
/** GST content of a GST-inclusive amount (15%): total × 3 ÷ 23, rounded. */
export function gstContentCents(totalInclCents: number): number {
  return Math.round((totalInclCents * 3) / 23);
}

/**
 * NZ cash rounding: the 5c coin went in 2006, so a cash total rounds to the
 * nearest 10 cents — 1–4 down, 5–9 up. Retailer convention, not statute. Only
 * the CASH-tendered total rounds; card, EFTPOS and bank totals never do.
 * Returns the rounded total and the adjustment (−4..+5) that gets recorded.
 */
export function roundCashToTenCents(cents: number): { roundedCents: number; roundingCents: number } {
  const c = Math.max(0, Math.round(cents));
  const remainder = c % 10;
  const roundingCents = remainder === 0 ? 0 : remainder >= 5 ? 10 - remainder : -remainder;
  return { roundedCents: c + roundingCents, roundingCents };
}

/**
 * IRD taxable supply information tiers (from 1 April 2023). Under $200 a
 * receipt needs seller, date, description and amount; from $200 the GST
 * number and GST content too; over $1,000 the buyer's name and one identifier
 * as well, if they are GST-registered and ask.
 */
export type ReceiptTier = "under_200" | "to_1000" | "over_1000";
export function receiptTier(totalCents: number): ReceiptTier {
  if (totalCents > 100_000) return "over_1000";
  if (totalCents >= 20_000) return "to_1000";
  return "under_200";
}

// The seller on every receipt. The GST number is printed regardless of tier —
// it costs nothing and saves a school's accounts team an email.
export const POS_SELLER = {
  legalName: "Christchurch United Football Club Incorporated",
  gstNumber: "020-252-642",
  address: "United Sports Centre, 482A Yaldhurst Road, Christchurch",
} as const;

/** Expected cash in the drawer at close: float + cash in − cash refunded out. */
export function shiftExpectedCashCents(p: { openingFloatCents: number; cashPaymentsCents: number; cashRefundsCents: number }): number {
  return p.openingFloatCents + p.cashPaymentsCents - p.cashRefundsCents;
}
