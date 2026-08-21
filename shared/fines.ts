// ─────────────────────────────────────────────────────────────────────────────
// FINES — enums and the derived-status maths.
//
// No DB imports. Pure functions, so the server and the client can never
// disagree about whether a fine is overdue.
//
// Two ideas do the work here, both inherited from the rest of this codebase:
//
//  1. A fine has a DIRECTION. Either the club owes it (a parking ticket, a
//     Mainland Football misconduct charge) or someone owes the club (a
//     disciplinary fine on a player). It is the same object — an amount, a
//     due date, a payment, a piece of paper — pointing opposite ways, so it is
//     one table with a direction rather than two tables that drift apart. Every
//     total on the page is split by it, because netting them off would produce
//     a number that means nothing.
//
//  2. PAID IS A FACT, OVERDUE IS A CALCULATION. `paidOn` is recorded; overdue
//     is `paidOn is null and dueOn < today` and is never stored. This is the
//     same rule the housing charges use, and for the same reason: a stored
//     "overdue" flag has to be un-set by something, and nothing will remember
//     to. It also means a fine paid late reads as PAID, not overdue — which is
//     the truth about it today, and the thing a stored flag gets wrong.
//
// Dates are ISO calendar strings ("2026-08-21") and are never round-tripped
// through `new Date()`. That bug has already shipped twice in this codebase
// (an invoice due the 17th printed "18 July"; a fleet policy expiring 8 May
// read 7 May in a probe). `today` always comes from the server in
// Pacific/Auckland.
// ─────────────────────────────────────────────────────────────────────────────

export const FINE_DIRECTIONS = ["club_owes", "owed_to_club"] as const;
export type FineDirection = (typeof FINE_DIRECTIONS)[number];

/** What kind of fine it is. Drives nothing but grouping and language — the
 *  money maths is identical — so this list can grow without a migration. */
export const FINE_CATEGORIES = [
  "traffic",       // speed camera, red light
  "parking",       // council or private
  "toll",
  "federation",    // Mainland Football / NZF / OFC — red cards, misconduct, late team sheets
  "disciplinary",  // the club fining a player or staff member
  "regulatory",    // council, WorkSafe, IRD penalties
  "other",
] as const;
export type FineCategory = (typeof FINE_CATEGORIES)[number];

/** An attachment is either the fine that arrived, or the proof we paid it.
 *  Keeping them apart is the point: "has this been paid" is answerable at a
 *  glance only if the receipt is distinguishable from the notice. */
export const FINE_ATTACHMENT_KINDS = ["notice", "payment_confirmation", "correspondence", "other"] as const;
export type FineAttachmentKind = (typeof FINE_ATTACHMENT_KINDS)[number];

export const isFineDirection = (v: unknown): v is FineDirection =>
  FINE_DIRECTIONS.includes(v as FineDirection);
export const isFineCategory = (v: unknown): v is FineCategory =>
  FINE_CATEGORIES.includes(v as FineCategory);
export const isFineAttachmentKind = (v: unknown): v is FineAttachmentKind =>
  FINE_ATTACHMENT_KINDS.includes(v as FineAttachmentKind);

/** A fine inside this many days of its due date reads amber. Shorter than the
 *  fleet's 30 days on purpose: a New Zealand infringement notice typically
 *  gives 28 days total, and reminder fees start the day after. */
export const DUE_SOON_DAYS = 14;

// ── Calendar-date helpers (ISO strings in, ISO semantics out) ────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (v: unknown): v is string => typeof v === "string" && ISO_DATE.test(v);

function isoToUtcMs(iso: string): number | null {
  if (!isIsoDate(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  // Date.UTC rolls 2026-02-31 over silently; reject it rather than accept a
  // date that does not exist.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

/** Whole days from `todayIso` to `iso`. Negative when `iso` is in the past. */
export function daysUntil(iso: string, todayIso: string): number | null {
  const a = isoToUtcMs(iso);
  const b = isoToUtcMs(todayIso);
  if (a === null || b === null) return null;
  return Math.round((a - b) / 86_400_000);
}

// ── Derived status ───────────────────────────────────────────────────────────

/** `open` means live and not yet urgent. `waived` covers a fine that was
 *  successfully challenged or written off — it must not sit in "unpaid"
 *  forever, but it is also not "paid", because no money moved. */
export type FineStatus = "paid" | "waived" | "overdue" | "due_soon" | "open";

/** Worst first. Drives the default sort and the summary chips: the whole point
 *  of the page is that the things needing action are at the top. */
const STATUS_RANK: Record<FineStatus, number> = {
  overdue: 4, due_soon: 3, open: 2, waived: 1, paid: 0,
};

export function worseFineStatus(a: FineStatus, b: FineStatus): FineStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

export function fineStatus(
  fine: { paidOn: string | null; waivedOn: string | null; dueOn: string | null },
  todayIso: string,
  dueSoonDays: number = DUE_SOON_DAYS,
): FineStatus {
  // Payment wins over everything, including a later waiver: if money left the
  // account, "waived" would be a lie about the bank statement.
  if (fine.paidOn) return "paid";
  if (fine.waivedOn) return "waived";
  if (!fine.dueOn) return "open";
  const days = daysUntil(fine.dueOn, todayIso);
  // An unparseable date is a data-entry problem, not an overdue fine. Reading
  // it as overdue would put a red badge on something nobody can act on.
  if (days === null) return "open";
  if (days < 0) return "overdue";
  if (days <= dueSoonDays) return "due_soon";
  return "open";
}

/** Is this fine still costing us (or owed to us)? Everything the totals count. */
export function isOutstanding(status: FineStatus): boolean {
  return status === "overdue" || status === "due_soon" || status === "open";
}

// ── Money ────────────────────────────────────────────────────────────────────

export type FineTotals = {
  /** Unpaid, unwaived — the number that matters. */
  outstandingCents: number;
  paidCents: number;
  waivedCents: number;
  overdueCents: number;
  count: number;
  outstandingCount: number;
  overdueCount: number;
};

const emptyTotals = (): FineTotals => ({
  outstandingCents: 0, paidCents: 0, waivedCents: 0, overdueCents: 0,
  count: 0, outstandingCount: 0, overdueCount: 0,
});

/** 🔴 Totals are split by direction and NEVER netted. "We owe $340 and are owed
 *  $120" is two facts a human acts on differently; "$220 net" is a number that
 *  describes nothing and would hide an overdue council fine behind a player's
 *  unpaid subs. */
export function summariseFines(
  fines: ReadonlyArray<{
    direction: string;
    amountCents: number;
    paidOn: string | null;
    waivedOn: string | null;
    dueOn: string | null;
  }>,
  todayIso: string,
): Record<FineDirection, FineTotals> {
  const out: Record<FineDirection, FineTotals> = {
    club_owes: emptyTotals(),
    owed_to_club: emptyTotals(),
  };
  for (const f of fines) {
    if (!isFineDirection(f.direction)) continue;
    const t = out[f.direction];
    const status = fineStatus(f, todayIso);
    const amount = Number.isFinite(f.amountCents) ? f.amountCents : 0;
    t.count += 1;
    if (status === "paid") t.paidCents += amount;
    else if (status === "waived") t.waivedCents += amount;
    else {
      t.outstandingCents += amount;
      t.outstandingCount += 1;
      if (status === "overdue") { t.overdueCents += amount; t.overdueCount += 1; }
    }
  }
  return out;
}

// ── Labels ───────────────────────────────────────────────────────────────────

export const DIRECTION_LABEL: Record<FineDirection, string> = {
  club_owes: "We owe",
  owed_to_club: "Owed to us",
};

/** Long form, for a heading where the short label would be ambiguous. */
export const DIRECTION_SENTENCE: Record<FineDirection, string> = {
  club_owes: "Fines the club has to pay",
  owed_to_club: "Fines owed to the club",
};

export const CATEGORY_LABEL: Record<FineCategory, string> = {
  traffic: "Traffic",
  parking: "Parking",
  toll: "Toll",
  federation: "Federation",
  disciplinary: "Disciplinary",
  regulatory: "Regulatory",
  other: "Other",
};

export const ATTACHMENT_KIND_LABEL: Record<FineAttachmentKind, string> = {
  notice: "The fine",
  payment_confirmation: "Payment confirmation",
  correspondence: "Correspondence",
  other: "Other",
};

export const STATUS_LABEL: Record<FineStatus, string> = {
  paid: "Paid",
  waived: "Waived",
  overdue: "Overdue",
  due_soon: "Due soon",
  open: "Unpaid",
};
