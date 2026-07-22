// ─────────────────────────────────────────────────────────────────────────────
// FLEET — vehicle enums and the derived-status maths.
//
// No DB imports. Pure functions so the badge logic can be unit-tested and so
// the client renders exactly what the server computes.
//
// Two ideas do all the work here:
//
//  1. A compliance expiry is a CALENDAR DATE, never a timestamp. An ISO date
//     ("2026-08-14") is already a day in New Zealand; constructing a `Date`
//     from it and formatting it back prints the wrong day (this bit us on the
//     invoice page — an invoice due the 17th rendered "18 July"). Every helper
//     below works on ISO strings and, where arithmetic is unavoidable, builds a
//     Date via `Date.UTC(...)` from the parts — UTC has no DST, so the diff of
//     two such values is exact.
//
//  2. RUC does NOT expire on a date. A road user charges licence is bought in
//     blocks of distance and expires at an ODOMETER READING. Modelling it as a
//     date would be wrong in a way that silently under-reports risk — a van
//     parked for a month stays compliant, a van doing 900km a week does not.
//     So RUC has its own status function keyed on kilometres, and the odometer
//     carries the date it was read (`odometerAt`) because a reading is a fact
//     about a moment, not a property of the vehicle.
// ─────────────────────────────────────────────────────────────────────────────

export const VEHICLE_TYPES = ["car", "van", "minibus", "ute", "truck", "trailer", "other"] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const FUEL_TYPES = ["petrol", "diesel", "hybrid", "plug_in_hybrid", "electric", "lpg", "other"] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

export const VEHICLE_STATUSES = ["active", "in_workshop", "off_road", "disposed"] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export const OWNERSHIP_TYPES = ["owned", "leased", "financed"] as const;
export type OwnershipType = (typeof OWNERSHIP_TYPES)[number];

/** Light vehicles carry a WOF; heavy vehicles, heavy trailers and passenger
 *  service vehicles carry a COF. Which one applies turns on gross vehicle mass
 *  and on whether passengers are carried for hire or reward — neither of which
 *  we can infer from a make and model. So it is a field a human sets, and
 *  `suggestComplianceType` only nudges. */
export const COMPLIANCE_TYPES = ["wof", "cof"] as const;
export type ComplianceType = (typeof COMPLIANCE_TYPES)[number];

export const INSURANCE_COVER_TYPES = [
  "comprehensive",
  "third_party_fire_theft",
  "third_party",
  "mechanical_breakdown",
  "other",
] as const;
export type InsuranceCoverType = (typeof INSURANCE_COVER_TYPES)[number];

export const SERVICE_TYPES = ["service", "repair", "wof_check", "cof_check", "tyres", "recall", "other"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const COST_CATEGORIES = [
  "fuel",
  "ruc",
  "rego",
  "wof",
  "cof",
  "insurance",
  "service",
  "repair",
  "tyres",
  "cleaning",
  "fine",
  "toll",
  "parking",
  "lease",
  "other",
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

/** Fringe Benefit Tax. A company vehicle *available* for an employee's private
 *  use attracts FBT in New Zealand — availability, not actual use, is the test.
 *  The work-related-vehicle exemption is narrow (sign-written, not principally
 *  designed to carry passengers, private use restricted in writing, checked
 *  quarterly). We record the claim; we do not adjudicate it. Victor's call. */
export const FBT_EXEMPTIONS = ["none", "work_related_vehicle", "emergency_call", "other"] as const;
export type FbtExemption = (typeof FBT_EXEMPTIONS)[number];

export const isVehicleType = (v: unknown): v is VehicleType => VEHICLE_TYPES.includes(v as VehicleType);
export const isFuelType = (v: unknown): v is FuelType => FUEL_TYPES.includes(v as FuelType);
export const isVehicleStatus = (v: unknown): v is VehicleStatus => VEHICLE_STATUSES.includes(v as VehicleStatus);
export const isOwnershipType = (v: unknown): v is OwnershipType => OWNERSHIP_TYPES.includes(v as OwnershipType);
export const isComplianceType = (v: unknown): v is ComplianceType => COMPLIANCE_TYPES.includes(v as ComplianceType);
export const isInsuranceCoverType = (v: unknown): v is InsuranceCoverType =>
  INSURANCE_COVER_TYPES.includes(v as InsuranceCoverType);
export const isServiceType = (v: unknown): v is ServiceType => SERVICE_TYPES.includes(v as ServiceType);
export const isCostCategory = (v: unknown): v is CostCategory => COST_CATEGORIES.includes(v as CostCategory);
export const isFbtExemption = (v: unknown): v is FbtExemption => FBT_EXEMPTIONS.includes(v as FbtExemption);

// ── Thresholds ───────────────────────────────────────────────────────────────

/** A compliance date inside this many days reads amber. 30 days is the window
 *  the club actually needs to book a WOF in Christchurch without scrambling. */
export const DUE_SOON_DAYS = 30;

/** RUC inside this many kilometres reads amber. */
export const RUC_DUE_SOON_KM = 1000;

/** A vehicle whose odometer reading is older than this can't be trusted to say
 *  anything useful about RUC. Surfaced as "reading is stale", not as compliant. */
export const ODOMETER_STALE_DAYS = 90;

// ── Calendar-date helpers (ISO strings in, ISO semantics out) ────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isIsoDate = (v: unknown): v is string => typeof v === "string" && ISO_DATE.test(v);

/** Midnight-UTC epoch ms for an ISO calendar date. Only ever used to subtract
 *  one such value from another — never to format a date back to a string. */
function isoToUtcMs(iso: string): number | null {
  if (!isIsoDate(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  // Reject 2026-02-31 and friends: Date.UTC rolls them over silently.
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

/** Whole days from `todayIso` to `iso`. Negative when `iso` is in the past.
 *  Returns null if either input isn't a real calendar date. */
export function daysUntil(iso: string, todayIso: string): number | null {
  const a = isoToUtcMs(iso);
  const b = isoToUtcMs(todayIso);
  if (a === null || b === null) return null;
  return Math.round((a - b) / 86_400_000);
}

// ── Derived status ───────────────────────────────────────────────────────────

/** `unknown` is deliberately NOT `ok`. A vehicle with no WOF date recorded is
 *  not compliant — it is unaudited, and it should nag until someone types the
 *  date in. That is why it outranks `ok` in `worstStatus`. */
export type ExpiryStatus = "ok" | "due_soon" | "expired" | "unknown";

const STATUS_RANK: Record<ExpiryStatus, number> = { ok: 0, unknown: 1, due_soon: 2, expired: 3 };

export function worstStatus(statuses: readonly ExpiryStatus[]): ExpiryStatus {
  return statuses.reduce<ExpiryStatus>((worst, s) => (STATUS_RANK[s] > STATUS_RANK[worst] ? s : worst), "ok");
}

/** A WOF, rego, COF or insurance policy is valid THROUGH its expiry date, so
 *  the last valid day is `daysUntil === 0` — amber, not red. */
export function expiryStatus(
  expiresOn: string | null | undefined,
  todayIso: string,
  dueSoonDays: number = DUE_SOON_DAYS,
): ExpiryStatus {
  if (!expiresOn) return "unknown";
  const days = daysUntil(expiresOn, todayIso);
  if (days === null) return "unknown";
  if (days < 0) return "expired";
  if (days <= dueSoonDays) return "due_soon";
  return "ok";
}

/** RUC status, keyed on distance rather than time.
 *
 *  Honest about what it cannot know: the answer is only as fresh as the last
 *  odometer reading. A licence showing 4,000km of headroom against a reading
 *  taken in March means nothing in July. When the reading is stale we return
 *  `unknown` rather than a reassuring `ok` — a green badge computed from a
 *  four-month-old number is worse than no badge. */
export function rucStatus(
  args: {
    rucRequired: boolean;
    rucValidToKm: number | null | undefined;
    odometerKm: number | null | undefined;
    odometerAt: string | null | undefined;
  },
  todayIso: string,
  dueSoonKm: number = RUC_DUE_SOON_KM,
): ExpiryStatus {
  if (!args.rucRequired) return "ok";
  if (args.rucValidToKm == null || args.odometerKm == null) return "unknown";

  const remaining = args.rucValidToKm - args.odometerKm;
  // Already over the licence — no reading freshness can rescue that.
  if (remaining <= 0) return "expired";

  if (odometerIsStale(args.odometerAt, todayIso)) return "unknown";
  if (remaining <= dueSoonKm) return "due_soon";
  return "ok";
}

export function odometerIsStale(odometerAt: string | null | undefined, todayIso: string): boolean {
  if (!odometerAt) return true;
  const age = daysUntil(odometerAt, todayIso);
  if (age === null) return true;
  return -age > ODOMETER_STALE_DAYS;
}

/** Which dated compliance field applies, given the vehicle's compliance type.
 *  A vehicle carries a WOF or a COF, never both. */
export function complianceExpiry(v: {
  complianceType: string;
  wofExpiresOn: string | null;
  cofExpiresOn: string | null;
}): { label: "WOF" | "COF"; expiresOn: string | null } {
  return v.complianceType === "cof"
    ? { label: "COF", expiresOn: v.cofExpiresOn }
    : { label: "WOF", expiresOn: v.wofExpiresOn };
}

/** Best-effort nudge, never a ruling. Heavy vehicles, heavy trailers and
 *  passenger service vehicles need a COF, but that turns on gross vehicle mass
 *  and on carrying passengers for hire or reward — a club minibus moving its
 *  own team is generally not a PSV, the same minibus taking paying passengers
 *  is. The UI shows this as a hint next to a field the human owns. */
export function suggestComplianceType(vehicleType: VehicleType): ComplianceType {
  return vehicleType === "truck" ? "cof" : "wof";
}

/** Whether RUC applies, as at July 2026: diesel always; light electric vehicles
 *  since 1 April 2024; plug-in hybrids pay a reduced RUC alongside fuel excise.
 *  Petrol and petrol-hybrid vehicles pay through fuel excise instead and buy no
 *  RUC licence. This seeds the checkbox — `rucRequired` on the vehicle is the
 *  authority, so a human can always overrule it. Confirm against NZTA. */
export function suggestRucRequired(fuelType: FuelType): boolean {
  return fuelType === "diesel" || fuelType === "electric" || fuelType === "plug_in_hybrid";
}

// ── Insurance ────────────────────────────────────────────────────────────────

export type PolicyPeriod = { startsOn: string; expiresOn: string };

/** Is this vehicle insured, and until when?
 *
 *  Insurance gets its own function rather than being squeezed through
 *  `expiryStatus`, because a bare date cannot express the two states that
 *  matter most. A policy that starts NEXT MONTH is a future date — and a future
 *  date reads as a green badge on a vehicle that is uninsured right now.
 *
 *  Two rules:
 *
 *  1. Cover is judged as at TODAY. Not covered today → `expired`, whatever
 *     dates exist either side of it.
 *  2. When covered, we walk forward through CONTIGUOUS renewals. Otherwise
 *     recording next year's policy still leaves the tab nagging amber for
 *     thirty days, because today's policy really does expire next week — and a
 *     badge that cries wolf gets ignored. A gap of even one clear day stops the
 *     walk: the club is uninsured that day, and pretending otherwise is exactly
 *     the comfortable lie this tab exists to prevent.
 *
 *  `expiresOn` is what to SHOW: the far end of unbroken cover, or the date it
 *  lapsed, or null if no policy was ever recorded. */
export function insuranceStatus(
  policies: readonly PolicyPeriod[],
  todayIso: string,
  dueSoonDays: number = DUE_SOON_DAYS,
): { status: ExpiryStatus; expiresOn: string | null } {
  const valid = policies.filter((p) => isIsoDate(p.startsOn) && isIsoDate(p.expiresOn));
  if (!valid.length) return { status: "unknown", expiresOn: null };

  // ISO dates compare correctly as plain strings — zero-padded and big-endian.
  const sorted = [...valid].sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  let cursor = sorted.find((p) => p.startsOn <= todayIso && p.expiresOn >= todayIso);

  if (!cursor) {
    // Nothing covers today. Show the most recent lapse if there is one; a
    // future-only policy shows no date at all, but still reads `expired`,
    // because the van on the forecourt this morning is not insured.
    const past = sorted.filter((p) => p.expiresOn < todayIso);
    const lapsed = past.length ? past.reduce((a, b) => (a.expiresOn > b.expiresOn ? a : b)).expiresOn : null;
    return { status: "expired", expiresOn: lapsed };
  }

  // Covered. Walk renewals forward while cover stays unbroken.
  for (;;) {
    const next: PolicyPeriod | undefined = sorted.find((p) => {
      if (p.expiresOn <= cursor!.expiresOn) return false;   // extends nothing
      const gap = daysUntil(p.startsOn, cursor!.expiresOn); // days after cursor's expiry that p begins
      return gap !== null && gap <= 1;                       // same day, or the very next day
    });
    if (!next) break;
    cursor = next;
  }
  return { status: expiryStatus(cursor.expiresOn, todayIso, dueSoonDays), expiresOn: cursor.expiresOn };
}

// ── Fleet-wide rollup ────────────────────────────────────────────────────────

export type VehicleCompliance = {
  compliance: ExpiryStatus; // WOF or COF, whichever applies
  complianceLabel: "WOF" | "COF";
  complianceExpiresOn: string | null;
  rego: ExpiryStatus;
  ruc: ExpiryStatus;
  insurance: ExpiryStatus;
  insuranceExpiresOn: string | null;
  service: ExpiryStatus;
  overall: ExpiryStatus;
  odometerStale: boolean;
};

/** One place computes a vehicle's badges; the list, the detail drawer and any
 *  future reminder job all render from it. A disposed vehicle is not "expired" —
 *  it is gone, and nagging about the WOF of a van we sold is noise. */
export function vehicleCompliance(
  v: {
    status: string;
    complianceType: string;
    wofExpiresOn: string | null;
    cofExpiresOn: string | null;
    regoExpiresOn: string | null;
    rucRequired: boolean;
    rucValidToKm: number | null;
    odometerKm: number | null;
    odometerAt: string | null;
    nextServiceDueOn: string | null;
  },
  policies: readonly PolicyPeriod[],
  todayIso: string,
): VehicleCompliance {
  const { label, expiresOn } = complianceExpiry(v);

  if (v.status === "disposed") {
    const ok: ExpiryStatus = "ok";
    return {
      compliance: ok, complianceLabel: label, complianceExpiresOn: expiresOn,
      rego: ok, ruc: ok, insurance: ok, insuranceExpiresOn: null, service: ok,
      overall: ok, odometerStale: false,
    };
  }

  const compliance = expiryStatus(expiresOn, todayIso);
  const rego = expiryStatus(v.regoExpiresOn, todayIso);
  const ruc = rucStatus(v, todayIso);
  const ins = insuranceStatus(policies, todayIso);
  // A missing next-service date is a gap in the log, not a compliance failure,
  // so it stays `ok` rather than nagging the way an absent WOF date does.
  const service = v.nextServiceDueOn ? expiryStatus(v.nextServiceDueOn, todayIso) : "ok";

  return {
    compliance,
    complianceLabel: label,
    complianceExpiresOn: expiresOn,
    rego,
    ruc,
    insurance: ins.status,
    insuranceExpiresOn: ins.expiresOn,
    service,
    overall: worstStatus([compliance, rego, ruc, ins.status, service]),
    odometerStale: v.rucRequired && odometerIsStale(v.odometerAt, todayIso),
  };
}
