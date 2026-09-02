/**
 * Dashboard periods and revenue sources.
 *
 * Shared between client and server so the period the user picks and the period
 * the SQL runs are the same object, computed by the same function. A dashboard
 * whose filter and query disagree is worse than no dashboard.
 *
 * 🔴 Every date here is a bare `YYYY-MM-DD` calendar date in New Zealand, never
 * a JS `Date`. `new Date("2026-09-02")` is UTC midnight, which is midday on the
 * 2nd in NZ — and `toISOString().slice(0,10)` on a local date reads a day
 * behind for half of every day. This has bitten ClubOS repeatedly (an invoice
 * printed "18 July" when it was due the 17th).
 */

export const DASHBOARD_PERIODS = [
  "today",
  "7d",
  "30d",
  "ytd",
  "year",
  "custom",
] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

export const PERIOD_LABELS: Record<DashboardPeriod, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  ytd: "Year to date",
  year: "This year",
  custom: "Custom",
};

/** Today in New Zealand, as `YYYY-MM-DD`. `en-CA` formats exactly that way. */
export function nzTodayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function parseIso(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

/** Calendar-date arithmetic anchored at UTC midnight: timezone-free by design. */
export function addDaysIso(iso: string, days: number): string {
  const p = parseIso(iso);
  if (!p) return iso;
  const t = Date.UTC(p.y, p.m - 1, p.d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Inclusive whole-day span between two calendar dates. */
export function daysInclusive(fromIso: string, toIso: string): number {
  const a = parseIso(fromIso);
  const b = parseIso(toIso);
  if (!a || !b) return 0;
  const ms = Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d);
  return Math.floor(ms / 86_400_000) + 1;
}

export type DateRange = { from: string; to: string };

/**
 * Resolve a period to an inclusive calendar range in NZ.
 *
 * "Year to date" and "This year" are the same range today and diverge only in
 * intent, so they resolve identically — the distinction is kept because a user
 * reading the filter means different things by them, and "This year" will mean
 * the whole calendar year the moment historical comparison arrives.
 */
export function resolvePeriod(
  period: DashboardPeriod,
  custom?: Partial<DateRange>,
  today: string = nzTodayIso(),
): DateRange {
  switch (period) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: addDaysIso(today, -6), to: today };
    case "30d":
      return { from: addDaysIso(today, -29), to: today };
    case "ytd":
    case "year":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case "custom": {
      const from = custom?.from && parseIso(custom.from) ? custom.from : addDaysIso(today, -29);
      const to = custom?.to && parseIso(custom.to) ? custom.to : today;
      // A backwards range is a user slip, not an error worth a red screen.
      return from <= to ? { from, to } : { from: to, to: from };
    }
  }
}

/**
 * The immediately preceding range of the same length, for the "vs previous"
 * comparison. Same length, ending the day before `from` — so a 30-day period
 * compares against the 30 days before it, not against last month's calendar.
 */
export function previousRange(range: DateRange): DateRange {
  const len = daysInclusive(range.from, range.to);
  const to = addDaysIso(range.from, -1);
  return { from: addDaysIso(to, -(len - 1)), to };
}

/** Every calendar date in the range, inclusive — so a chart can show days with
 *  no revenue as real zeros rather than skipping them and lying about the shape. */
export function eachDay(range: DateRange): string[] {
  const out: string[] = [];
  const n = daysInclusive(range.from, range.to);
  for (let i = 0; i < n; i++) out.push(addDaysIso(range.from, i));
  return out;
}

// ── Revenue sources ─────────────────────────────────────────────────────────
//
// 🔴 Every workspace earns money in a DIFFERENT table, and six of the nine have
// no `programs` row at all. A revenue widget that only reads `registrations`
// therefore reports a confident $0.00 for United Sports Centre, Gymnastics,
// United Prints, the Cup and the Group — which is the exact bug this dashboard
// was rebuilt to fix, just moved somewhere less obvious.
//
// So each workspace declares its own source, and a workspace with no wired
// source says so instead of showing zero. `label` is displayed under the
// figure, because "revenue" alone is a claim and these sources do not all mean
// the same thing: a confirmed venue booking is money owed, not money banked.

/**
 * How a table is tied to a workspace.
 *
 * 🔴 `registrations` has NO `organization_id` of its own — it reaches one
 * through `program_id → programs.organization_id`. Assuming a direct column
 * is what the first run of the verification script caught, and it would have
 * been a 500 on the CUFC dashboard: the exact failure this rebuild exists to
 * end. Every source states its scoping rather than leaving it to be guessed.
 */
export type OrgScope =
  | { kind: "column"; column: string }
  | { kind: "viaPrograms"; column: string };

export type RevenueSource = {
  /** Table to sum. */
  table: string;
  /** How rows in this table belong to a workspace. */
  orgScope: OrgScope;
  /** Money column, in cents. */
  amountColumn: string;
  /** Column holding the date the money is attributed to. */
  dateColumn: string;
  /** Status values that count. Empty = every row counts. */
  statuses: string[];
  /** Status column name, when `statuses` is non-empty. */
  statusColumn?: string;
  /** What the number actually means, shown to the user. */
  label: string;
  /** Set when the date column is a proxy — surfaced in the UI, never hidden. */
  dateCaveat?: string;
};

export const REVENUE_SOURCES: Record<string, RevenueSource> = {
  // 🔴 `paid_at` is NULL on all 448 confirmed registrations and `amount_paid`
  // sums to $308 against a $53,200 total — both columns exist and neither is
  // populated. `registered_at` + `total_cents` are the only honest pair, so the
  // caveat says which date is being charted rather than implying settlement.
  "christchurch-united": {
    table: "registrations",
    orgScope: { kind: "viaPrograms", column: "program_id" },
    amountColumn: "total_cents",
    dateColumn: "registered_at",
    statusColumn: "status",
    statuses: ["confirmed"],
    label: "Confirmed registrations",
    dateCaveat: "By registration date — ClubOS does not record when each payment cleared.",
  },
  "south-island-united": {
    table: "registrations",
    orgScope: { kind: "viaPrograms", column: "program_id" },
    amountColumn: "total_cents",
    dateColumn: "registered_at",
    statusColumn: "status",
    statuses: ["confirmed"],
    label: "Confirmed registrations",
    dateCaveat: "By registration date — ClubOS does not record when each payment cleared.",
  },
  "mini-football-leagues": {
    table: "registrations",
    orgScope: { kind: "viaPrograms", column: "program_id" },
    amountColumn: "total_cents",
    dateColumn: "registered_at",
    statusColumn: "status",
    statuses: ["confirmed"],
    label: "Confirmed registrations",
    dateCaveat: "By registration date — ClubOS does not record when each payment cleared.",
  },
  // 🔴 2,259 bookings are `confirmed` and only 6 are `paid`, so this is the
  // value of confirmed bookings, NOT money received. Labelled as such: calling
  // $153k "revenue" here would be a claim the data cannot support.
  "united-sports-centre": {
    table: "facility_bookings",
    orgScope: { kind: "column", column: "organization_id" },
    amountColumn: "total_cents",
    dateColumn: "booking_date",
    statusColumn: "status",
    statuses: ["confirmed", "paid"],
    label: "Confirmed bookings",
    dateCaveat: "Booked value by booking date — not all of it has been paid yet.",
  },
  "united-gymnastics": {
    table: "cugc_registrations",
    orgScope: { kind: "column", column: "organization_id" },
    amountColumn: "price_cents",
    dateColumn: "paid_at",
    statusColumn: "status",
    statuses: ["paid"],
    label: "Paid registrations",
  },
  "united-sports-group": {
    table: "usg_invoices",
    orgScope: { kind: "column", column: "organization_id" },
    amountColumn: "total_cents",
    dateColumn: "paid_at",
    statusColumn: "status",
    statuses: ["paid"],
    label: "Paid invoices",
  },
  "united-prints": {
    table: "print_orders",
    orgScope: { kind: "column", column: "organization_id" },
    amountColumn: "total_cents",
    dateColumn: "created_at",
    statusColumn: "status",
    statuses: ["delivered", "ready", "in_production", "confirmed"],
    label: "Accepted print jobs",
    dateCaveat: "By order date — print orders carry no payment timestamp.",
  },
  // Deliberately absent: christchurch-international-cup and sandbox.
  //
  // The Cup's 132 team entries all carry `paid_amount_cents = 0` — the money is
  // real and is simply not recorded in ClubOS. Charting that as $0.00 would
  // state, in the club's own dashboard, that the tournament earned nothing.
  // An unwired workspace says it is unwired.
};

export function revenueSourceFor(slug: string | undefined | null): RevenueSource | null {
  if (!slug) return null;
  return REVENUE_SOURCES[slug] ?? null;
}

export type RevenuePoint = { date: string; cents: number };

export type RevenueResponse = {
  /** null when this workspace has no wired revenue source. */
  source: { label: string; caveat?: string } | null;
  range: DateRange;
  totalCents: number;
  /** Same-length preceding range, for the comparison line. */
  previousCents: number;
  /** One entry per calendar day in the range, zeros included. */
  series: RevenuePoint[];
  /** Rows counted — lets the UI say "across 41 registrations". */
  count: number;
};

/** Percentage change, or null when the previous period was zero (a change from
 *  nothing is not a percentage, and rendering ∞% or +100% would be a fiction). */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}
