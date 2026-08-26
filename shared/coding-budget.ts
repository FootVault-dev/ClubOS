/**
 * CODING BUDGET — the club's chart of accounts.
 *
 * Victor Zoubkov's coding structure for FY2026: thirty top-level streams (income
 * 01–20, expenses 21–30) and 882 codes beneath them. This is the categorisation
 * Xero will be matched to and every transaction mapped against, so the vocabulary
 * lives in ONE file that the server, the seed and the page all import.
 *
 * The rules that are not obvious:
 *
 * 🔴 A budget of NULL is not a budget of zero. Most lines carry no figure of
 *    their own because they roll up from their children; a handful (the four
 *    residency terms, the twenty-four Ethnic Tournament registrations) carry an
 *    explicit 0, which is the club saying "we expect nothing from this". A page
 *    that renders both as "$0.00" destroys the difference, so `budgetExclCents`
 *    is nullable all the way down and renders as an em-dash when unset.
 *
 * 🔴 Only a POSTABLE line may receive a transaction. Victor's own Issues sheet
 *    raises double-counting twice — field hire is centralised under code 30 and
 *    must not be recreated inside each programme's expenses. A control row that
 *    can accept a transaction is the mechanism by which that happens, so the
 *    database refuses it outright rather than trusting a UI to hide the option.
 *
 * 🔴 GST treatment starts UNSET and stays unset until a human decides. The
 *    workbook mixes 15%, zero-rated and out-of-scope lines — donations at
 *    $863,000 carry no GST, FIFA prize money is an overseas supply — and there
 *    is no safe default. Defaulting to 15% would write a tax position into the
 *    club's chart of accounts that nobody chose.
 *
 * 🔴 Nothing stores a total. What a stream has earned is the sum of the
 *    transactions under it and its descendants, computed on read. The workbook
 *    this replaces stores its totals, and its stated TOTAL INCOME is $28,750
 *    adrift of the sum of its own codes.
 */

/** Income streams are 01–20, expenses 21–30. */
export type CodingKind = "income" | "expense";

/**
 * What a line is FOR, taken from the workbook's Invoice Treatment column.
 *
 *   entry     — a transaction line. The leaf a real invoice or bill is coded to.
 *   coding    — a coding line: postable, but usually rolls up entry lines.
 *   subtotal  — a control row. Displays a total; must never receive money.
 *   reserved  — codes 14–20, held for future income streams. Not yet approved,
 *               so not yet postable. Victor: "do not use until approved".
 */
export type CodingTreatment = "entry" | "coding" | "subtotal" | "reserved";

export const CODING_TREATMENTS: readonly CodingTreatment[] = [
  "entry", "coding", "subtotal", "reserved",
];

/**
 * 🔴 The ONE decider for whether a code may receive a transaction. The database
 * enforces the same rule through a generated column + composite foreign key, so
 * this function and the schema cannot drift: change one without the other and
 * inserts start failing loudly rather than double-counting quietly.
 */
export function isPostable(treatment: string): boolean {
  return treatment === "entry" || treatment === "coding";
}

/** GST position on a line. `null` means nobody has decided yet — never assume. */
export type GstTreatment = "standard" | "zero_rated" | "exempt" | "no_gst";

export const GST_TREATMENTS: readonly GstTreatment[] = [
  "standard", "zero_rated", "exempt", "no_gst",
];

export const GST_LABELS: Record<GstTreatment, string> = {
  standard: "15% GST",
  zero_rated: "Zero-rated",
  exempt: "Exempt",
  no_gst: "No GST",
};

/** Where a mapped transaction came from. Text, not a CHECK — this list grows. */
export type CodingSource = "manual" | "xero" | "clubos" | "import";

/** Draft → approved → reconciled against the bank. */
export type CodingStatus = "draft" | "approved" | "reconciled";

export const CODING_STATUSES: readonly CodingStatus[] = [
  "draft", "approved", "reconciled",
];

// ─────────────────────────────────────────────────────────────────────────────
// The tree
// ─────────────────────────────────────────────────────────────────────────────

export interface CodingAccount {
  id: number;
  code: string;              // "01-01-01-01"
  parentCode: string | null; // "01-01-01"
  topCode: string;           // "01"
  depth: number;             // 1..5
  name: string;
  kind: CodingKind;
  treatment: CodingTreatment;
  budgetExclCents: number | null;
  budgetInclCents: number | null;
  xeroAccount: string | null;         // Victor's SUGGESTION, from the workbook
  xeroTracking: string | null;
  xeroAccountCode: string | null;     // what he ACTUALLY set in Xero
  gstTreatment: GstTreatment | null;  // null = undecided
  note: string | null;
  active: boolean;
}

/** A code's ancestors, nearest first: "01-02-03" → ["01-02", "01"]. */
export function ancestorCodes(code: string): string[] {
  const parts = code.split("-");
  const out: string[] = [];
  for (let i = parts.length - 1; i > 0; i--) out.push(parts.slice(0, i).join("-"));
  return out;
}

/** Whether `code` is `ancestor` or sits beneath it. Prefix match on segments. */
export function isUnder(code: string, ancestor: string): boolean {
  return code === ancestor || code.startsWith(ancestor + "-");
}

/**
 * Roll a per-code figure up the tree, so every parent carries the sum of
 * everything beneath it.
 *
 * 🔴 Sums the LEAVES only, by walking each code's ancestors — never adds a
 * parent's own figure to its children's. The workbook carries a figure on both
 * a control row and its children (Staff Wages 21-01 is $503,000 AND its eleven
 * roles sum to $503,000), so adding both counts every salary twice.
 */
export function rollUp(
  rows: Array<{ code: string; cents: number }>,
): Map<string, number> {
  const out = new Map<string, number>();
  const add = (code: string, cents: number) =>
    out.set(code, (out.get(code) ?? 0) + cents);
  for (const { code, cents } of rows) {
    add(code, cents);
    for (const a of ancestorCodes(code)) add(a, cents);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Money
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A line's budget: its OWN stated figure if it has one, otherwise the sum of
 * its children's.
 *
 * 🔴 The stated figure wins, and getting this backwards is a real trap. The
 * workbook budgets at several depths at once, and the detail beneath a branch
 * is not always complete: `02 Tournaments` is $200,000, but the only
 * descendants carrying any figure at all are the Ethnic Tournament's
 * twenty-four registration slots, every one of them an explicit zero. Summing
 * the deepest figures therefore reported Tournaments at $0 and the club's
 * income $200,000 light. `21-01 Business Management` is the reassuring case —
 * $503,000 stated, and its eleven named roles happen to sum to $503,000 too —
 * but a coincidence in one branch is not a rule.
 *
 * Reading the stated figure first also means a control row never double-counts:
 * its children are consulted only when it says nothing itself.
 */
export function budgetFor(
  accounts: Array<Pick<CodingAccount, "code" | "parentCode" | "budgetExclCents">>,
  root: string,
): number | null {
  const self = accounts.find(a => a.code === root);
  if (self?.budgetExclCents != null) return self.budgetExclCents;

  const children = accounts.filter(a => a.parentCode === root);
  if (!children.length) return null;

  let total: number | null = null;
  for (const c of children) {
    const n = budgetFor(accounts, c.code);
    if (n != null) total = (total ?? 0) + n;
  }
  return total;
}

/** Dollars from cents, for display. Money is cents everywhere else. */
export function dollars(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("en-NZ", {
    style: "currency", currency: "NZD", maximumFractionDigits: 2,
  });
}

/**
 * Today in New Zealand as a bare ISO date.
 *
 * 🔴 Never `new Date().toISOString().slice(0, 10)` — that is the UTC date, which
 * is yesterday here for most of the working day.
 */
export function nzTodayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation — the app-side half of the invariants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why a transaction may not be coded to this account, or null if it may be.
 * Server-side; the UI uses the same function so the two cannot disagree.
 */
export function whyNotPostable(
  account: Pick<CodingAccount, "code" | "name" | "treatment" | "active"> | undefined,
): string | null {
  if (!account) return "That code does not exist.";
  if (!account.active) return `${account.code} is no longer in use.`;
  if (account.treatment === "subtotal") {
    return `${account.code} ${account.name} is a control row — it totals the codes beneath it. `
      + `Code the transaction to one of those instead, or it will be counted twice.`;
  }
  if (account.treatment === "reserved") {
    return `${account.code} is reserved for a future income stream and is not approved for use yet.`;
  }
  return null;
}

/** GST at the New Zealand rate, in cents, rounded half-up. */
export const NZ_GST_RATE = 0.15;

export function gstOn(exclCents: number, treatment: GstTreatment | null): number {
  return treatment === "standard" ? Math.round(exclCents * NZ_GST_RATE) : 0;
}
