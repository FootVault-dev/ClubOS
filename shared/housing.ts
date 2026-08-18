// ─────────────────────────────────────────────────────────────────────────────
// HOUSING — the on-site residency houses, their rooms, who lives in them, the
// rent they owe, and the power/wifi bills the club has to pay.
//
// Pure logic only: no DB, no Express, no React. Imported by both
// `server/housing-routes.ts` and `client/src/pages/venue-housing.tsx` so the
// number a coordinator reads on screen is the number the server derived.
//
// Two rules shape everything here:
//
//  1. **Overdue is DERIVED, never stored.** A stored `status='overdue'` is only
//     true until the day nobody runs the job that flips it. Overdue is
//     `unpaid && due_on < today-in-NZ`, computed on read. Same rule the invoice
//     pages use.
//
//  2. **Never build a `Date` from an ISO date string.** `new Date("2026-07-17")`
//     is midnight UTC, which is 12pm on the 17th in Auckland — and reading it
//     back with any local getter after noon NZ hands you the 16th. Every
//     function here does calendar-part arithmetic anchored at UTC midnight, so
//     it is timezone-free. This exact bug printed "18 July" on an invoice due
//     the 17th (see `project_invoice_pages`).
// ─────────────────────────────────────────────────────────────────────────────

// ── Vocabularies ─────────────────────────────────────────────────────────────
// All stored as TEXT and validated here, never as pg enums: this database has a
// documented history of enum drift, and these lists will grow.

export const ROOM_TYPES = ["single", "double", "twin", "ensuite", "studio", "other"] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

export const RENT_FREQUENCIES = ["weekly", "fortnightly", "monthly"] as const;
export type RentFrequency = (typeof RENT_FREQUENCIES)[number];

export const UTILITY_KINDS = [
  "power", "internet", "water", "gas", "rates", "insurance", "waste", "other",
] as const;
export type UtilityKind = (typeof UTILITY_KINDS)[number];

export const PAYMENT_METHODS = [
  "bank_transfer", "automatic_payment", "cash", "card", "other",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const isRoomType = (v: any): v is RoomType => ROOM_TYPES.includes(v);
export const isRentFrequency = (v: any): v is RentFrequency => RENT_FREQUENCIES.includes(v);
export const isUtilityKind = (v: any): v is UtilityKind => UTILITY_KINDS.includes(v);
export const isPaymentMethod = (v: any): v is PaymentMethod => PAYMENT_METHODS.includes(v);

export const UTILITY_KIND_LABELS: Record<UtilityKind, string> = {
  power: "Power",
  internet: "Internet / WiFi",
  water: "Water",
  gas: "Gas",
  rates: "Rates",
  insurance: "Insurance",
  waste: "Waste",
  other: "Other",
};

export const RENT_FREQUENCY_LABELS: Record<RentFrequency, string> = {
  weekly: "Weekly",
  fortnightly: "Fortnightly",
  monthly: "Monthly",
};

/** How many days ahead of `due_on` a charge starts showing as "due soon". */
export const DUE_SOON_DAYS = 7;

/** Safety rail on charge generation — a runaway loop must not write 10k rows. */
export const MAX_GENERATED_CHARGES = 520; // 10 years of weekly rent

// ── Calendar dates (timezone-free) ───────────────────────────────────────────

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface Ymd { y: number; m: number; d: number }

/** Parse `YYYY-MM-DD`. Returns null for anything else — including `Date`s and
 *  full timestamps, which callers must never pass in. */
export function parseIso(iso: unknown): Ymd | null {
  const match = ISO_RE.exec(String(iso ?? "").trim());
  if (!match) return null;
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last of this
}

export function toIso({ y, m, d }: Ymd): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Today in New Zealand as `YYYY-MM-DD`. Mirrors `nzTodayIso` in shared/academy.ts.
 *  Duplicated deliberately: this module must not import the academy's pricing code. */
export function nzTodayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** Lexicographic comparison is correct for zero-padded ISO dates. */
export function compareIso(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addDaysIso(iso: string, days: number): string | null {
  const p = parseIso(iso);
  if (!p) return null;
  const t = Date.UTC(p.y, p.m - 1, p.d) + days * 86_400_000;
  const dt = new Date(t);
  return toIso({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
}

/** Add whole months, clamping the day to the target month's length.
 *
 *  ⚠ Callers must always add from the ORIGINAL anchor (`addMonthsIso(start, n)`),
 *  never by repeatedly stepping one month from the previous result. A tenancy
 *  starting the 31st would otherwise clamp to Feb 28 and then stay on the 28th
 *  forever — the tenant's rent day would silently drift three days earlier. */
export function addMonthsIso(iso: string, months: number): string | null {
  const p = parseIso(iso);
  if (!p) return null;
  const total = (p.y * 12 + (p.m - 1)) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return toIso({ y, m, d: Math.min(p.d, daysInMonth(y, m)) });
}

/** Whole days from `a` to `b`. Negative when `b` is before `a`. */
export function daysBetween(a: string, b: string): number | null {
  const pa = parseIso(a), pb = parseIso(b);
  if (!pa || !pb) return null;
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

// ── Tenancy state ────────────────────────────────────────────────────────────

export type TenancyState = "upcoming" | "active" | "ended";

/** A tenancy is active on `today` if it has started and has not yet finished.
 *  `endDate` is INCLUSIVE — the tenant's last night. A null end means ongoing. */
export function tenancyState(startDate: string, endDate: string | null, today: string): TenancyState {
  if (compareIso(startDate, today) > 0) return "upcoming";
  if (endDate && compareIso(endDate, today) < 0) return "ended";
  return "active";
}

/** Do two tenancy date ranges overlap? A null end is "forever".
 *  Backs up the DB exclusion constraint so the API can return a friendly 409
 *  instead of a raw Postgres error. */
export function rangesOverlap(
  aStart: string, aEnd: string | null,
  bStart: string, bEnd: string | null,
): boolean {
  const aEndsBeforeB = aEnd !== null && compareIso(aEnd, bStart) < 0;
  const bEndsBeforeA = bEnd !== null && compareIso(bEnd, aStart) < 0;
  return !(aEndsBeforeB || bEndsBeforeA);
}

// ── Payment state (rent charges AND utility bills share this) ────────────────

export type PaymentState = "paid" | "waived" | "overdue" | "due_soon" | "upcoming";

export interface PayableLike {
  dueOn: string;
  paidOn?: string | null;
  waived?: boolean | null;
}

/** The single definition of "are we behind on this?".
 *
 *  Precedence matters: a charge that was paid late is **paid**, not overdue —
 *  the money arrived. Only an unpaid, unwaived charge whose due date has passed
 *  in New Zealand is overdue. */
export function paymentState(p: PayableLike, today: string, dueSoonDays = DUE_SOON_DAYS): PaymentState {
  if (p.paidOn) return "paid";
  if (p.waived) return "waived";
  if (compareIso(p.dueOn, today) < 0) return "overdue";
  const until = daysBetween(today, p.dueOn);
  if (until !== null && until <= dueSoonDays) return "due_soon";
  return "upcoming";
}

export const PAYMENT_STATE_LABELS: Record<PaymentState, string> = {
  paid: "Paid",
  waived: "Waived",
  overdue: "Overdue",
  due_soon: "Due soon",
  upcoming: "Upcoming",
};

/** Days overdue, or 0 when not overdue. Used to sort the chase list. */
export function daysOverdue(p: PayableLike, today: string): number {
  if (paymentState(p, today) !== "overdue") return 0;
  return daysBetween(p.dueOn, today) ?? 0;
}

/** What is still owed on a payable. A part-payment leaves the balance owing. */
export function amountOutstandingCents(
  p: PayableLike & { amountCents: number; paidAmountCents?: number | null },
): number {
  if (p.waived) return 0;
  const paid = p.paidAmountCents ?? 0;
  return Math.max(0, p.amountCents - paid);
}

// ── Rent schedule ────────────────────────────────────────────────────────────

export interface ChargePeriod {
  /** 0-based period number since the tenancy started. */
  index: number;
  periodStart: string;
  /** Inclusive last day the period covers. */
  periodEnd: string;
  /** Rent is payable IN ADVANCE (NZ Residential Tenancies Act), so the charge
   *  falls due on the first day of the period it covers. */
  dueOn: string;
}

function periodStartFor(start: string, freq: RentFrequency, n: number): string | null {
  switch (freq) {
    case "weekly": return addDaysIso(start, 7 * n);
    case "fortnightly": return addDaysIso(start, 14 * n);
    case "monthly": return addMonthsIso(start, n); // always from the anchor — see addMonthsIso
  }
}

/**
 * Every rent charge a tenancy owes from `startDate` up to and including
 * `horizon`, stopping early at `endDate` if the tenancy finishes first.
 *
 * Deterministic and pure, so generating twice produces the same `dueOn` values —
 * which is what makes the DB's `(tenancy_id, due_on)` unique index enough to
 * make the generator idempotent. Re-running it never double-charges a tenant.
 */
export function chargePeriods(
  startDate: string,
  endDate: string | null,
  freq: RentFrequency,
  horizon: string,
  max = MAX_GENERATED_CHARGES,
): ChargePeriod[] {
  if (!parseIso(startDate) || !parseIso(horizon)) return [];
  if (endDate && !parseIso(endDate)) return [];
  if (endDate && compareIso(endDate, startDate) < 0) return [];
  if (!isRentFrequency(freq)) return [];

  const out: ChargePeriod[] = [];
  for (let n = 0; n < max; n++) {
    const periodStart = periodStartFor(startDate, freq, n);
    if (!periodStart) break;
    if (compareIso(periodStart, horizon) > 0) break;
    if (endDate && compareIso(periodStart, endDate) > 0) break;

    const nextStart = periodStartFor(startDate, freq, n + 1);
    let periodEnd = nextStart ? addDaysIso(nextStart, -1) : periodStart;
    if (!periodEnd) break;
    // A tenancy that ends mid-period is only charged to its last night.
    if (endDate && compareIso(periodEnd, endDate) > 0) periodEnd = endDate;

    out.push({ index: n, periodStart, periodEnd, dueOn: periodStart });
  }
  return out;
}

/** Annualised rent, for the occupancy/revenue summary. Months are 1/12 of a
 *  year and weeks are 1/52.1775 of one — using 52 would understate a weekly
 *  rent roll by roughly a week's rent every year.
 *
 *  `rent_frequency` is TEXT in the database, so an unrecognised value is
 *  possible. It contributes 0 rather than `NaN`: a rent roll that reads "$—"
 *  is a visible bug, one that silently reads NaN is not. */
export function annualisedRentCents(rentCents: number, freq: RentFrequency | string): number {
  switch (freq) {
    case "weekly": return Math.round(rentCents * 365.25 / 7);
    case "fortnightly": return Math.round(rentCents * 365.25 / 14);
    case "monthly": return rentCents * 12;
    default: return 0;
  }
}

// ── Occupancy ────────────────────────────────────────────────────────────────

export interface OccupancySummary {
  rooms: number;
  occupied: number;
  vacant: number;
  /** 0–100, rounded. `0` when there are no rooms (never NaN on screen). */
  occupancyPct: number;
}

/** Occupancy is DERIVED from active tenancies, never a flag on the room. A
 *  stored `is_occupied` goes stale the moment a tenancy ends and nobody clicks. */
export function summariseOccupancy(
  rooms: { id: number }[],
  activeTenancyRoomIds: Iterable<number>,
): OccupancySummary {
  const occupiedIds = new Set(activeTenancyRoomIds);
  const occupied = rooms.filter(r => occupiedIds.has(r.id)).length;
  const total = rooms.length;
  return {
    rooms: total,
    occupied,
    vacant: total - occupied,
    occupancyPct: total === 0 ? 0 : Math.round((occupied / total) * 100),
  };
}

// ── Money ────────────────────────────────────────────────────────────────────

/** Parse a dollar string ("1,250.50", "$300") to integer cents. Returns null on
 *  anything that isn't money, so a bad input can never silently become $0. */
export function dollarsToCents(input: unknown): number | null {
  const raw = String(input ?? "").replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) return null;
  return Math.round(Number(raw) * 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCOMMODATION (2026-08-18) — the CUFC residency at 482A Yaldhurst Road.
//
// Everything below exists because the club's real run sheet needs it and the
// original housing model could not express it: an occupant whose rent is paid
// by their playing contract, a power contribution billed separately from rent,
// a term that bills as one invoice rather than 20 weekly ones, and weeks the
// occupant was away and not charged.
//
// 🔴 THE ONE RULE: what somebody owes is DERIVED here, from their rate, their
// dates and their holiday deduction — never read from a stored total. The
// source workbook stores its totals, and it states four different figures for
// the same term, three of which disagree with its own rows. `statedTotalCents`
// is kept only so the tab can show the club's own historic number beside the
// recomputed one and name the difference out loud.
// ─────────────────────────────────────────────────────────────────────────────

// ── Vocabularies ─────────────────────────────────────────────────────────────
// TEXT in the database, validated here. `undecided` is a real value, not a
// blank: which agreement these occupancies actually are is an open legal
// question (ACT-005, with Harcourts), and a system that forces a choice would
// be recording a legal position nobody has taken.
export const AGREEMENT_TYPES = [
  "licence_to_occupy", "boarding_agreement", "short_term_rental",
  "club_remuneration", "residential_tenancy", "undecided",
] as const;
export type AgreementType = (typeof AGREEMENT_TYPES)[number];

export const AGREEMENT_TYPE_LABELS: Record<AgreementType, string> = {
  licence_to_occupy: "Licence to occupy",
  boarding_agreement: "Boarding agreement",
  short_term_rental: "Short-term rental",
  club_remuneration: "Club remuneration",
  residential_tenancy: "Residential tenancy",
  undecided: "Not yet decided",
};

export const OCCUPANT_CATEGORIES = [
  "senior_squad", "academy", "international", "staff", "trialist", "other",
] as const;
export type OccupantCategory = (typeof OCCUPANT_CATEGORIES)[number];

export const OCCUPANT_CATEGORY_LABELS: Record<OccupantCategory, string> = {
  senior_squad: "Senior squad",
  academy: "Academy",
  international: "International",
  staff: "Staff",
  trialist: "Trialist",
  other: "Other",
};

/** The state of the room itself, not of anyone in it. `unknown` is the default
 *  and reads as "nobody has inspected this", which is not the same as fine. */
export const CONDITION_STATUSES = [
  "inspected_good", "clean_ready", "ready_for_use",
  "pending_checkout", "needs_attention", "unknown",
] as const;
export type ConditionStatus = (typeof CONDITION_STATUSES)[number];

export const CONDITION_STATUS_LABELS: Record<ConditionStatus, string> = {
  inspected_good: "Inspected — good",
  clean_ready: "Clean & ready",
  ready_for_use: "Ready for use",
  pending_checkout: "Pending check-out",
  needs_attention: "Needs attention",
  unknown: "Not inspected",
};

/** Whether the occupant's own condition report has been signed. */
export const CONDITION_REPORTS = ["signed", "pending", "returned", "none"] as const;
export type ConditionReport = (typeof CONDITION_REPORTS)[number];

export const CONDITION_REPORT_LABELS: Record<ConditionReport, string> = {
  signed: "Signed", pending: "Pending", returned: "Returned", none: "Not started",
};

export const ACTION_KINDS = ["action", "conflict"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const ACTION_PRIORITIES = ["high", "medium", "low"] as const;
export type ActionPriority = (typeof ACTION_PRIORITIES)[number];

export const ACTION_STATUSES = [
  "open", "in_progress", "under_review", "pending", "completed", "dismissed",
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const ACTION_STATUS_LABELS: Record<ActionStatus, string> = {
  open: "Open", in_progress: "In progress", under_review: "Under review",
  pending: "Pending", completed: "Completed", dismissed: "Dismissed",
};

/** An action still needing someone. Completed and dismissed are both finished —
 *  dismissed means "we looked and decided no", which is a decision, not a gap. */
export function isActionOpen(status: string): boolean {
  return status !== "completed" && status !== "dismissed";
}

export const CHARGE_KINDS = ["rent", "utilities", "combined"] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

export const CHARGE_KIND_LABELS: Record<ChargeKind, string> = {
  rent: "Rent", utilities: "Power / utilities", combined: "Rent & power",
};

export const isAgreementType = (v: any): v is AgreementType => AGREEMENT_TYPES.includes(v);
export const isOccupantCategory = (v: any): v is OccupantCategory => OCCUPANT_CATEGORIES.includes(v);
export const isConditionStatus = (v: any): v is ConditionStatus => CONDITION_STATUSES.includes(v);
export const isConditionReport = (v: any): v is ConditionReport => CONDITION_REPORTS.includes(v);
export const isActionKind = (v: any): v is ActionKind => ACTION_KINDS.includes(v);
export const isActionPriority = (v: any): v is ActionPriority => ACTION_PRIORITIES.includes(v);
export const isActionStatus = (v: any): v is ActionStatus => ACTION_STATUSES.includes(v);
export const isChargeKind = (v: any): v is ChargeKind => CHARGE_KINDS.includes(v);

// ── Duration ─────────────────────────────────────────────────────────────────

/** Nights occupied, from `startDate` to `endDate` INCLUSIVE — the convention the
 *  tenancy table uses, where `end_date` is the tenant's last night.
 *
 *  ⚠ The club's run sheet writes the CHECK-OUT day instead, which is the day
 *  after. `checkOutToLastNight()` converts; getting this wrong bills everyone an
 *  extra day. */
export function occupiedDays(startDate: string, endDate: string): number | null {
  const n = daysBetween(startDate, endDate);
  return n === null ? null : n + 1;
}

/** The run sheet's check-out date → the tenancy table's inclusive last night. */
export function checkOutToLastNight(checkOut: string): string | null {
  return addDaysIso(checkOut, -1);
}

/**
 * Days actually charged: nights occupied, less any weeks the occupant was away.
 *
 * The club deducts whole weeks for the Christmas break ("Vacated 22 Dec for 2
 * wks holiday"). That deduction is the entire reason 23 calendar weeks are
 * billed as 21, and without it every December tenancy overcharges by $60–$460.
 *
 * Never negative: a holiday longer than the tenancy is a data-entry mistake, and
 * the right answer to it is zero, not a credit note.
 */
export function billableDays(startDate: string, endDate: string, holidayWeeks = 0): number | null {
  const days = occupiedDays(startDate, endDate);
  if (days === null) return null;
  const holiday = Number.isFinite(holidayWeeks) ? Math.max(0, holidayWeeks) * 7 : 0;
  return Math.max(0, days - holiday);
}

/** Billable days as weeks. For display and comparison against the run sheet's
 *  own week counts — the money is always computed from DAYS, never from this. */
export function billableWeeks(startDate: string, endDate: string, holidayWeeks = 0): number | null {
  const d = billableDays(startDate, endDate, holidayWeeks);
  return d === null ? null : d / 7;
}

// ── What an occupancy costs ──────────────────────────────────────────────────

export interface TenancyMoneyInput {
  startDate: string;
  /** Inclusive last night. Null = still going; pass `asAt` to value it to date. */
  endDate: string | null;
  rentCents: number;
  utilitiesCents?: number | null;
  /** True when the rent figure already covers power — the Jan–May arrangement. */
  utilitiesIncluded?: boolean | null;
  holidayWeeks?: number | null;
  rentFrequency?: RentFrequency | string | null;
}

export interface TenancyMoney {
  days: number;
  weeks: number;
  /** Per week, whatever the stored frequency — so two tenancies can be compared. */
  weeklyRentCents: number;
  weeklyUtilitiesCents: number;
  rentCents: number;
  utilitiesCents: number;
  totalCents: number;
  /** True when the end date is open and this was valued to `asAt` instead. */
  openEnded: boolean;
}

/** A rent figure expressed per week, whatever frequency it is stored at, so
 *  a fortnightly and a weekly tenancy can sit in the same column. */
export function weeklyEquivalentCents(amountCents: number, freq: RentFrequency | string | null | undefined): number {
  switch (freq) {
    case "fortnightly": return Math.round(amountCents / 2);
    case "monthly": return Math.round(amountCents * 12 / 52.1775);
    case "weekly":
    default: return amountCents;   // an unknown frequency is treated as weekly,
                                   // which is what every row in this residency is
  }
}

/**
 * What an occupancy costs, derived. The single definition — the server computes
 * it, the client renders what the server sent, and the seed compares it against
 * the club's own figure to produce the variance list.
 *
 * 🔴 Rounded ONCE, at the end, from whole days. Rounding the weeks first is how
 * the source workbook turned 5.4286 weeks into "5.3" and would have turned a
 * $1,248.57 invoice into $1,219.00 — a $29.57 error on one five-week stay.
 */
export function tenancyMoney(t: TenancyMoneyInput, asAt?: string): TenancyMoney | null {
  const end = t.endDate ?? asAt ?? nzTodayIso();
  if (!parseIso(t.startDate) || !parseIso(end)) return null;
  if (compareIso(end, t.startDate) < 0) {
    // Valued before it starts: no days, no money — not a negative bill.
    return {
      days: 0, weeks: 0,
      weeklyRentCents: weeklyEquivalentCents(t.rentCents, t.rentFrequency),
      weeklyUtilitiesCents: t.utilitiesIncluded ? 0 : weeklyEquivalentCents(t.utilitiesCents ?? 0, t.rentFrequency),
      rentCents: 0, utilitiesCents: 0, totalCents: 0,
      openEnded: t.endDate === null,
    };
  }

  const days = billableDays(t.startDate, end, t.holidayWeeks ?? 0) ?? 0;
  const weeklyRent = weeklyEquivalentCents(t.rentCents, t.rentFrequency);
  const weeklyUtil = t.utilitiesIncluded ? 0 : weeklyEquivalentCents(t.utilitiesCents ?? 0, t.rentFrequency);

  const rentCents = Math.round(weeklyRent * days / 7);
  const utilitiesCents = Math.round(weeklyUtil * days / 7);

  return {
    days,
    weeks: days / 7,
    weeklyRentCents: weeklyRent,
    weeklyUtilitiesCents: weeklyUtil,
    rentCents,
    utilitiesCents,
    totalCents: rentCents + utilitiesCents,
    openEnded: t.endDate === null,
  };
}

/** The gap between what the club's document said and what the figures produce.
 *  Positive means the recomputed cost is HIGHER than the club recorded — i.e.
 *  somebody was probably under-billed. Null when there is nothing to compare. */
export function statedVarianceCents(computedCents: number, statedCents: number | null | undefined): number | null {
  if (statedCents === null || statedCents === undefined) return null;
  return computedCents - statedCents;
}

/** Ignore rounding noise when deciding whether to show a variance at all. One
 *  cent either way is a rounding artefact; a dollar is a question. */
export const VARIANCE_TOLERANCE_CENTS = 1;

export function hasMaterialVariance(computedCents: number, statedCents: number | null | undefined): boolean {
  const v = statedVarianceCents(computedCents, statedCents);
  return v !== null && Math.abs(v) > VARIANCE_TOLERANCE_CENTS;
}

// ── Occupancy, with reserve beds excluded ────────────────────────────────────

export interface RoomLike { id: number; isReserve?: boolean | null }

export interface AccommodationOccupancy extends OccupancySummary {
  /** Sick / quarantine / overflow beds. Counted, but never in the percentage. */
  reserveRooms: number;
  reserveOccupied: number;
}

/**
 * Occupancy over the rooms that can actually be let.
 *
 * 🔴 The two sick rooms are emergency beds, not stock. Including them makes a
 * residency with every lettable room full report 85%, which reads as spare
 * capacity that does not exist — and the whole reason this tab was built is a
 * residency revenue line nobody could explain.
 */
export function summariseAccommodation(
  rooms: RoomLike[],
  activeTenancyRoomIds: Iterable<number>,
): AccommodationOccupancy {
  const occupiedIds = new Set(activeTenancyRoomIds);
  const lettable = rooms.filter(r => !r.isReserve);
  const reserve = rooms.filter(r => !!r.isReserve);
  return {
    ...summariseOccupancy(lettable, occupiedIds),
    reserveRooms: reserve.length,
    reserveOccupied: reserve.filter(r => occupiedIds.has(r.id)).length,
  };
}

// ── Conflicts the database cannot catch ──────────────────────────────────────

export interface OverlapCandidate {
  id: number;
  contactId: number;
  roomId: number | null;
  startDate: string;
  endDate: string | null;
}

export interface PersonOverlap {
  contactId: number;
  a: OverlapCandidate;
  b: OverlapCandidate;
}

/**
 * One person recorded in two different rooms at the same time.
 *
 * 🔴 A warning, never a constraint. The database stops two people sharing a
 * room; it deliberately does not stop one person holding two, because that
 * genuinely happens here — Deen Hasanovic rented both Tiny House rooms at once
 * for a single combined rate. So this reports and lets a human judge, rather
 * than refusing a booking the club actually made.
 */
export function findPersonOverlaps(tenancies: OverlapCandidate[]): PersonOverlap[] {
  const byPerson = new Map<number, OverlapCandidate[]>();
  for (const t of tenancies) {
    if (!byPerson.has(t.contactId)) byPerson.set(t.contactId, []);
    byPerson.get(t.contactId)!.push(t);
  }
  const out: PersonOverlap[] = [];
  for (const [contactId, list] of Array.from(byPerson.entries())) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        // Same room twice is the DB's problem and it already refused it.
        if (a.roomId !== null && a.roomId === b.roomId) continue;
        if (rangesOverlap(a.startDate, a.endDate, b.startDate, b.endDate)) out.push({ contactId, a, b });
      }
    }
  }
  return out;
}

// ── Where someone sits in the accommodation population ───────────────────────

export type AccommodationStatus = "resident" | "arriving" | "former" | "non_resident";

export const ACCOMMODATION_STATUS_LABELS: Record<AccommodationStatus, string> = {
  resident: "Living on site",
  arriving: "Arriving",
  former: "Previously housed",
  non_resident: "Off site",
};

/**
 * DERIVED from the person's tenancies, never stored. A stored status is wrong
 * from the moment a tenancy ends and nobody clicks — which is exactly how the
 * source sheet ended up listing the Tiny House as empty while three other pages
 * of the same workbook had Takumi living in it.
 */
export function accommodationStatus(
  tenancies: { startDate: string; endDate: string | null }[],
  today: string,
): AccommodationStatus {
  if (tenancies.length === 0) return "non_resident";
  const states = tenancies.map(t => tenancyState(t.startDate, t.endDate, today));
  if (states.includes("active")) return "resident";
  if (states.includes("upcoming")) return "arriving";
  return "former";
}
