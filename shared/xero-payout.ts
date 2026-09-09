// The Stripe payout → Xero split: what a payment WAS, decided in one place.
//
// 🔴 The category is DERIVED from the ClubOS record that owns the PaymentIntent,
// never from the charge's metadata. Stripe does NOT copy PaymentIntent metadata
// onto the charge, so a charge's metadata is usually `{}` — verified live on
// payout po_1UBZKKB0V2tnya31 where 9 of 11 charges carried none. A resolver that
// read metadata would silently file most of a payout as unknown.
//
// 🔴 The map from a category to a Xero account code is DATA (`xero_account_map`),
// not code. Victor owns account codes and GST treatment; changing one is an edit
// in the tab, never a deploy. This file only decides WHAT something is.

export type XeroCategoryKey =
  | "academy_term" | "academy_camp" | "academy_other"
  | "league_team" | "league_player"
  | "tournament_team" | "tournament_player"
  | "club_event" | "membership" | "facility_hire"
  | "shop" | "print" | "invoice" | "gymnastics"
  | "unallocated";

export const XERO_CATEGORIES: { key: XeroCategoryKey; label: string; note?: string }[] = [
  { key: "academy_term",     label: "Academy — term programmes" },
  { key: "academy_camp",     label: "Holiday camps" },
  { key: "academy_other",    label: "Academy — other programmes" },
  { key: "league_team",      label: "Mini Football Leagues — team entry" },
  { key: "league_player",    label: "Mini Football Leagues — player share" },
  { key: "tournament_team",  label: "Tournaments — team entry" },
  { key: "tournament_player",label: "Tournaments — player share" },
  { key: "club_event",       label: "Club events — tickets" },
  { key: "membership",       label: "Memberships" },
  { key: "facility_hire",    label: "Facility hire" },
  { key: "shop",             label: "Merchandise / shop" },
  { key: "print",            label: "United Prints" },
  { key: "invoice",          label: "Invoices (sponsorship, rebates)" },
  { key: "gymnastics",       label: "United Gymnastics" },
  // 🔴 Never dropped, never guessed. A payout must always balance, so anything
  // ClubOS cannot identify lands here for a human to code once — and then it
  // becomes a rule. An empty unallocated line is the goal, not the assumption.
  { key: "unallocated",      label: "Stripe — uncoded", note: "Needs a human to code, once" },
];

/** A payment resolved to the ClubOS record that owns it. */
export interface ResolvedPayment {
  source: string;              // which table answered
  recordId: number | string;
  organizationId: number | null;
  /** Programme type for registrations: 'camp' | 'academy' | 'league' | … */
  programType?: string | null;
  /** `scheduleType` on the programme: 'term' | 'holiday' | … */
  scheduleType?: string | null;
  competitionKind?: string | null;
  description?: string | null;
  /** True when the payer bought one share of a team entry, not the whole team. */
  isPlayerShare?: boolean;
  /** The programme that was sold, when there is one — the level they code at. */
  programId?: number | null;
  /** Set when the charge was found through a subscription rather than directly. */
  viaSubscription?: string | null;
}

/**
 * What was this payment for? One decider, used by the walker, the preview and
 * the poster — so the category shown in a dry run is the category posted.
 */
export function categoriseResolved(r: ResolvedPayment | null): XeroCategoryKey {
  if (!r) return "unallocated";
  switch (r.source) {
    case "registrations": {
      // A registration's category comes from its PROGRAMME, not the payment.
      // The same checkout sells a $50 camp day and a $805 academy term.
      //
      // 🔴 These strings are the LIVE values in `programs.type`, checked against
      // the database, not guessed: 'academy' | 'holiday_camp' | 'league_team'.
      // The first draft of this function guessed 'camp' and 'league' and filed
      // every camp and every league entry as "academy other" — a wrong category
      // that still balances, which is the failure mode worth fearing here.
      if (r.programType === "holiday_camp") return "academy_camp";
      if (r.programType === "league_team") return r.isPlayerShare ? "league_player" : "league_team";
      if (r.programType === "academy") {
        return r.scheduleType === "term" ? "academy_term" : "academy_other";
      }
      return "academy_other";
    }
    case "split_members":
    case "payshare_participants":   return "league_player";
    case "teampay_players":         return "tournament_player";
    case "teampay_entries":         return "tournament_team";
    case "club_event_orders":       return "club_event";
    case "members":                 return "membership";
    case "facility_bookings":       return "facility_hire";
    case "shop_orders":
    case "shop_order_shares":       return "shop";
    case "print_orders":            return "print";
    case "usg_invoices":            return "invoice";
    case "cugc_registrations":      return "gymnastics";
    default:                        return "unallocated";
  }
}

export interface SplitLine {
  category: XeroCategoryKey;
  label: string;
  /** Gross, in cents. Charges positive, refunds negative. */
  grossCents: number;
  count: number;
}

export interface PayoutSplit {
  payoutId: string;
  currency: string;
  arrivalDate: string;
  /** What Stripe actually paid into the bank, in cents. */
  payoutCents: number;
  lines: SplitLine[];
  /** Stripe's fees across the payout, positive cents (posted as a negative line). */
  feeCents: number;
  /** Fees Stripe charged directly (billing, payout fees), positive cents. */
  stripeChargeCents: number;
  /** An earlier payout that failed and came back inside this batch, in cents. */
  reversalCents: number;
  /** grossTotal − fees − stripeCharges. MUST equal payoutCents. */
  computedCents: number;
  balances: boolean;
  unresolvedCount: number;
}

/**
 * Group resolved lines into the document Xero receives.
 *
 * 🔴 The reconciliation is the product. A split that does not equal the payout to
 * the cent is not posted at all — a bank line that half-matches is worse for the
 * accounts team than one that does not match, because it looks done.
 */
export function buildSplit(params: {
  payoutId: string; currency: string; arrivalDate: string; payoutCents: number;
  items: { category: XeroCategoryKey; grossCents: number; feeCents: number }[];
  stripeChargeCents: number; reversalCents?: number;
}): PayoutSplit {
  const byCat = new Map<XeroCategoryKey, SplitLine>();
  let feeCents = 0;
  for (const it of params.items) {
    feeCents += it.feeCents;
    const label = XERO_CATEGORIES.find(c => c.key === it.category)?.label ?? it.category;
    const line = byCat.get(it.category) ?? { category: it.category, label, grossCents: 0, count: 0 };
    line.grossCents += it.grossCents;
    line.count += 1;
    byCat.set(it.category, line);
  }
  // Stable order: the declared category order, so two runs read the same.
  const lines = XERO_CATEGORIES.map(c => byCat.get(c.key)).filter((l): l is SplitLine => !!l);
  const grossTotal = lines.reduce((s, l) => s + l.grossCents, 0);
  const reversalCents = params.reversalCents ?? 0;
  const computedCents = grossTotal - feeCents - params.stripeChargeCents + reversalCents;
  return {
    payoutId: params.payoutId, currency: params.currency, arrivalDate: params.arrivalDate,
    payoutCents: params.payoutCents, lines, feeCents, stripeChargeCents: params.stripeChargeCents, reversalCents,
    computedCents, balances: computedCents === params.payoutCents,
    unresolvedCount: byCat.get("unallocated")?.count ?? 0,
  };
}
