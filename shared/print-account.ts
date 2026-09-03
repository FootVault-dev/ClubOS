// ─────────────────────────────────────────────────────────────────────────────
// UNITED PRINTS CUSTOMER ACCOUNTS — the shared vocabulary.
//
// Imported by the server (server/print-account-routes.ts, server/print-pricing.ts)
// and by both clients (the ClubOS portal page and Dima's admin). One decider per
// question, so the price a customer is quoted and the discount Dima sees on
// their record can never disagree.
//
// 🔴 There is no pricing arithmetic in the browser. This file carries the RULES
// and the LABELS; the money is always computed server-side by quotePrintItem().
// ─────────────────────────────────────────────────────────────────────────────

/** Session cookie. `__Host-` so it is origin-locked and cannot be set by a
 *  subdomain — join.unitedprints.co.nz serves the portal, so the cookie is
 *  first-party and never needs SameSite=None. */
export const PRINT_ACCOUNT_COOKIE = "__Host-up_account";

export const PRINT_ACCOUNT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const PRINT_ACCOUNT_CODE_TTL_MS = 10 * 60 * 1000;             // 10 minutes
export const PRINT_ACCOUNT_CODE_MAX_ATTEMPTS = 5;

// 🔴 Per-EMAIL and per-IP both, because they defend against different things:
// per-email stops someone spamming one customer's inbox, per-IP stops a script
// harvesting which addresses have accounts.
//
// ⚠️ A whole office shares one IP (reference_shared_ip_rate_limits: a squad on
// one connection is ONE address). A print customer is usually a business, so
// the IP ceiling is deliberately loose enough that four people at the same firm
// signing in on the same afternoon never collide.
export const PRINT_ACCOUNT_CODE_MAX_PER_EMAIL_HOUR = 5;
export const PRINT_ACCOUNT_CODE_MAX_PER_IP_HOUR = 30;

// ── Tiers ────────────────────────────────────────────────────────────────────
// Deliberately NOT a Postgres enum or CHECK. This set will grow (wholesale,
// reseller, club) and a stale CHECK is how the MFL checkout 500'd. Validated
// here, in one place, instead.
export const PRINT_TIERS = ["standard", "trade"] as const;
export type PrintTier = (typeof PRINT_TIERS)[number];

export function isPrintTier(v: unknown): v is PrintTier {
  return typeof v === "string" && (PRINT_TIERS as readonly string[]).includes(v);
}

export const PRINT_TIER_LABEL: Record<PrintTier, string> = {
  standard: "Standard",
  trade: "Trade account",
};

/**
 * 🔴 THE COMMERCIAL RULE, in one function.
 *
 * Daniel's decision, 2026-09-03: anyone may open an account and see their own
 * orders; only Dima decides who gets trade pricing. So a discount is never
 * implied by the tier name, by signing up, or by how much someone has spent —
 * it is a number a named staff member typed against that customer, and the
 * database refuses to hold it without them (print_customers_discount_needs_approver).
 *
 * Every account therefore starts at 0. A customer with a trade tier and no
 * discount set still pays list price, which is correct: the tier is a label,
 * the number is the agreement.
 */
export function accountDiscountPct(customer: { discountPct?: number | null; disabledAt?: Date | string | null } | null | undefined): number {
  if (!customer) return 0;
  if (customer.disabledAt) return 0;           // a closed account gets list price
  const pct = Number(customer.discountPct ?? 0);
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

/** What the portal says above the price list. Never claims a discount that is 0. */
export function pricingBadge(customer: { tier?: string | null; discountPct?: number | null } | null | undefined): {
  label: string;
  detail: string;
  active: boolean;
} {
  const pct = accountDiscountPct(customer as any);
  if (pct > 0) {
    return {
      label: `${pct}% account pricing`,
      detail: `Your prices below already have your ${pct}% off applied.`,
      active: true,
    };
  }
  if (customer?.tier === "trade") {
    return {
      label: "Trade account",
      detail: "Your trade rate hasn't been set yet — you're seeing standard pricing. Talk to us and we'll sort it.",
      active: false,
    };
  }
  return {
    label: "Standard pricing",
    detail: "Ordering regularly? Ask us about a trade account.",
    active: false,
  };
}

// ── Passwords ────────────────────────────────────────────────────────────────
// The rules only. The scrypt itself lives server-side in print-account-routes.ts
// — a hashing function must never be reachable from a browser bundle.

/**
 * Stated as the failure a person can act on, not as a checklist.
 *
 * 🔴 Length is the only composition rule, and the floor is 12 — the house
 * standard shared with natural-footballers-web and atarangi-lodge
 * (reference/app-baseline-standard.md §1). Symbol-and-capital rules push people
 * towards `Password1!`, which is worse than four ordinary words.
 */
export function passwordProblem(p: string): string | null {
  if (!p || p.length < 12) return "Use at least 12 characters — length matters far more than symbols.";
  if (p.length > 200) return "That's longer than 200 characters.";
  const weak = ["password", "12345678", "qwerty", "letmein", "unitedprints", "printing", "christchurch"];
  if (weak.some((w) => p.toLowerCase().includes(w))) return "That contains something too easy to guess.";
  return null;
}

/**
 * 🔴 ONE message for every sign-in failure.
 *
 * An unknown address, a wrong password, an account with no password set and a
 * closed account all answer with this exact string. Anything more specific
 * turns the login form into a tool for discovering which businesses have an
 * account with the print shop, and which of those have never set a password.
 */
export const SIGNIN_FAILED = "That email and password don't match. Check them and try again.";

// ── Email ────────────────────────────────────────────────────────────────────

export function normalizePrintEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase().slice(0, 255);
}

/** Deliberately loose. This gate exists to catch a typo, not to adjudicate
 *  RFC 5322 — a real address that a strict regex rejects is a customer we
 *  cannot serve, which is a worse failure than a bounced email. */
export function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

// ── What a signed-in customer is told about themselves ───────────────────────

export type PrintAccountOrderLine = {
  description: string;
  quantity: number;
  sizeLabel: string | null;
};

export type PrintAccountOrder = {
  id: number;
  orderNumber: string | null;
  title: string;
  status: string;
  /** Plain-English status for a customer, never the raw enum. */
  statusLabel: string;
  placedOn: string | null;   // bare ISO date, never a JS Date round-trip
  dueOn: string | null;
  readyOn: string | null;
  totalCents: number;
  paidCents: number;
  /** DERIVED, never stored. */
  outstandingCents: number;
  lines: PrintAccountOrderLine[];
};

export type PrintAccountMe = {
  email: string;
  name: string | null;
  phone: string | null;
  company: string | null;
  tier: string;
  discountPct: number;
  memberSince: string | null;
  orders: PrintAccountOrder[];
  /** Lifetime totals, DERIVED from the orders above so the two can never differ. */
  orderCount: number;
  lifetimeSpentCents: number;
};

/**
 * The customer-facing name for an internal order status.
 *
 * 🔴 A customer must never be shown `in_design` or `inquiry`. They are our
 * words for our workflow, and two of them ("inquiry", "quote_sent") mean
 * "we have not agreed to make this yet" — which reads to a customer as an
 * order they placed.
 *
 * An unknown status falls back to the honest generic rather than the raw key,
 * because the status set grows and a customer should never read a database
 * value off their own order page.
 */
// Keys are the real print_order_status enum values, verified against
// shared/schema.ts on 2026-09-03 — not guessed. The enum carries both the
// original lifecycle and the v1 additions, so several near-synonyms exist.
const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  inquiry: "Enquiry",
  quoted: "Quote sent",
  quote_sent: "Quote sent",
  confirmed: "Confirmed",
  paid: "Paid",
  artwork_pending: "Waiting on your artwork",
  in_design: "In design",
  in_proof: "Proof being prepared",
  proof_approved: "Proof approved",
  in_production: "In production",
  finishing: "Finishing",
  ready: "Ready for pickup",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export function customerStatusLabel(status: string | null | undefined): string {
  const key = String(status ?? "").toLowerCase();
  return STATUS_LABEL[key] ?? "In progress";
}

/** Which statuses a customer would call "finished". Used for the counter only. */
export function isClosedStatus(status: string | null | undefined): boolean {
  const key = String(status ?? "").toLowerCase();
  return key === "delivered" || key === "cancelled";
}

/**
 * 🔴 A cancelled order is not money the customer spent.
 *
 * Lifetime spend drives the loyalty tier this is the groundwork for, so what
 * counts has to be decided once, here, rather than by whichever page happens to
 * sum a column. Draft and enquiry rows are excluded for the same reason: the
 * shop has not agreed to make them, and a customer seeing an abandoned enquiry
 * in their spend total would be reading a number that means nothing.
 */
export function countsTowardSpend(status: string | null | undefined): boolean {
  const key = String(status ?? "").toLowerCase();
  return key !== "cancelled" && key !== "draft" && key !== "inquiry";
}
