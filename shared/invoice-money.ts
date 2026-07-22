/**
 * Money is stored and computed in integer CENTS. Dollars exist only at the
 * edge (client display). Never do arithmetic on a float dollar amount.
 *
 * This is a verbatim mirror of apps/invoices/src/lib/money.ts (the reference
 * implementation, already property-tested) — the public payable page and this
 * server must agree byte-for-byte on the surcharge maths, because the server
 * is what actually charges the card via the PaymentIntent amount. If the two
 * ever drift, update BOTH files from the same source of truth.
 */

export const GST_RATE = 0.15;

/**
 * Stripe's published New Zealand online card pricing, verified against
 * https://stripe.com/nz/pricing on 2026-07-10.
 *
 * This is the ONLY place the rate card lives. Under NZ's Retail Payment System
 * Act 2022 a surcharge may recover the merchant's cost of acceptance and no
 * more, so if Stripe's rates change and this constant does not, our surcharge
 * becomes unlawful. Update here, nowhere else (and in the apps/invoices copy).
 */
export const STRIPE_NZ = {
  domestic: { rate: 0.0265, fixedCents: 30 },
  international: { rate: 0.035, fixedCents: 30 },
} as const;

export type CardTier = keyof typeof STRIPE_NZ;

/** GST content of a GST-INCLUSIVE amount. 15% inclusive => amount * 3/23. */
export function gstContentOfInclusive(inclusiveCents: number): number {
  return Math.round((inclusiveCents * 3) / 23);
}

/** The GST-exclusive base of a GST-inclusive amount. */
export function exclusiveOfInclusive(inclusiveCents: number): number {
  return inclusiveCents - gstContentOfInclusive(inclusiveCents);
}

/** GST added on top of a GST-EXCLUSIVE amount. */
export function gstOnExclusive(exclusiveCents: number): number {
  return Math.round(exclusiveCents * GST_RATE);
}

export interface CardBreakdown {
  /** What the payer's card is actually charged. */
  totalCents: number;
  /** What we add on top of the invoice total. */
  surchargeCents: number;
  /** What Stripe will deduct. surchargeCents never exceeds this. */
  stripeFeeCents: number;
  /** What lands in the club's bank account. */
  netCents: number;
}

/**
 * Gross up an invoice total so that, after Stripe's cut, the club banks exactly
 * the amount owed.
 *
 *   charge = (target + fixed) / (1 - rate)
 *
 * Stripe applies its percentage to the whole captured amount, including the
 * surcharge — there is no NZ-available "surcharge" object that Stripe exempts
 * (docs.stripe.com/payments/advanced/surcharge is US-only), so the naive
 * `target * (1 + rate)` under-recovers.
 *
 * The loop below shaves cents off the total until the surcharge we charge is
 * never MORE than the fee Stripe charges us. Rounding can otherwise leave us a
 * cent to the good, and "no more than the cost of acceptance" is the legal test,
 * not a rounding convention. We would rather be a cent short than a cent unlawful.
 */
export function cardBreakdown(targetCents: number, tier: CardTier = "domestic"): CardBreakdown {
  const { rate, fixedCents } = STRIPE_NZ[tier];

  let totalCents = Math.ceil((targetCents + fixedCents) / (1 - rate));
  let stripeFeeCents = Math.round(totalCents * rate) + fixedCents;

  while (totalCents - targetCents > stripeFeeCents && totalCents > targetCents) {
    totalCents -= 1;
    stripeFeeCents = Math.round(totalCents * rate) + fixedCents;
  }

  return {
    totalCents,
    surchargeCents: totalCents - targetCents,
    stripeFeeCents,
    netCents: totalCents - stripeFeeCents,
  };
}

/** $1,234.56 — always two decimals, even for round amounts. */
export function formatNZD(cents: number): string {
  return (cents / 100).toLocaleString("en-NZ", {
    style: "currency",
    currency: "NZD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Cents from a dollar string like "12,844.15". Parsing, not arithmetic. */
export function centsFromDollars(dollars: string): number {
  return Math.round(parseFloat(dollars.replace(/,/g, "")) * 100);
}
