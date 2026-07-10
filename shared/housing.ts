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
