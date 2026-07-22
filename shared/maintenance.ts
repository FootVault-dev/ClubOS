// ─────────────────────────────────────────────────────────────────────────────
// MAINTENANCE — the United Sports Centre's cleaning/consumable supplies and its
// machines & equipment (mowers, tractors, power tools…).
//
// Pure logic only: no DB, no Express, no React. Imported by both
// `server/maintenance-routes.ts` and `client/src/pages/venue-maintenance.tsx`
// so the badge a phone-first user (Riley) reads on screen is the badge the
// server derived — never a client-side guess.
//
// Two ideas do all the work here, both lifted from the fleet (shared/vehicles.ts)
// and housing (shared/housing.ts) precedents:
//
//  1. Stock and service state are DERIVED, never stored. A stored "low stock"
//     flag is only true until the next stocktake nobody re-runs it after; a
//     stored "overdue" flag on a machine is only true until the day nobody
//     flips it. Both are computed fresh from qty/reorder level and from
//     next-service-due vs today.
//
//  2. `unknown` is NOT `ok`. A machine with no service date on file is
//     unaudited, not compliant — it should nag until someone logs a service.
//     A green badge computed from an absent fact is worse than no badge. Same
//     reasoning as the fleet's WOF/RUC status and housing's payment state.
//
// A `retired` asset never nags, and an `archived` supply never counts towards
// the low/out-of-stock rollups — both wrapped in their own status function so
// that rule lives in exactly one place (mirrors `vehicleCompliance`'s handling
// of a `disposed` vehicle).
// ─────────────────────────────────────────────────────────────────────────────

// ── Vocabularies ─────────────────────────────────────────────────────────────
// All stored as TEXT and validated here, never as pg enums or DB CHECK
// constraints — this database has a documented history of enum/CHECK drift,
// and these lists will grow as Riley finds more things to track.

export const SUPPLY_CATEGORIES = ["cleaning", "consumable", "parts", "safety", "other"] as const;
export type SupplyCategory = (typeof SUPPLY_CATEGORIES)[number];

export const SUPPLY_STATUSES = ["active", "archived"] as const;
export type SupplyStatus = (typeof SUPPLY_STATUSES)[number];

export const STOCK_MOVEMENT_REASONS = ["received", "used", "adjusted", "stocktake"] as const;
export type StockMovementReason = (typeof STOCK_MOVEMENT_REASONS)[number];

export const ASSET_CATEGORIES = ["mower", "tractor", "trailer", "power_tool", "appliance", "other"] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const ASSET_STATUSES = ["active", "retired"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const SERVICE_RECORD_KINDS = ["service", "repair", "inspection"] as const;
export type ServiceRecordKind = (typeof SERVICE_RECORD_KINDS)[number];

export const isSupplyCategory = (v: unknown): v is SupplyCategory => SUPPLY_CATEGORIES.includes(v as SupplyCategory);
export const isSupplyStatus = (v: unknown): v is SupplyStatus => SUPPLY_STATUSES.includes(v as SupplyStatus);
export const isStockMovementReason = (v: unknown): v is StockMovementReason =>
  STOCK_MOVEMENT_REASONS.includes(v as StockMovementReason);
export const isAssetCategory = (v: unknown): v is AssetCategory => ASSET_CATEGORIES.includes(v as AssetCategory);
export const isAssetStatus = (v: unknown): v is AssetStatus => ASSET_STATUSES.includes(v as AssetStatus);
export const isServiceRecordKind = (v: unknown): v is ServiceRecordKind =>
  SERVICE_RECORD_KINDS.includes(v as ServiceRecordKind);

export const SUPPLY_CATEGORY_LABELS: Record<SupplyCategory, string> = {
  cleaning: "Cleaning",
  consumable: "Consumable",
  parts: "Parts",
  safety: "Safety",
  other: "Other",
};

export const STOCK_MOVEMENT_REASON_LABELS: Record<StockMovementReason, string> = {
  received: "Received",
  used: "Used",
  adjusted: "Adjusted",
  stocktake: "Stocktake",
};

export const ASSET_CATEGORY_LABELS: Record<AssetCategory, string> = {
  mower: "Mower",
  tractor: "Tractor",
  trailer: "Trailer",
  power_tool: "Power tool",
  appliance: "Appliance",
  other: "Other",
};

export const SERVICE_RECORD_KIND_LABELS: Record<ServiceRecordKind, string> = {
  service: "Service",
  repair: "Repair",
  inspection: "Inspection",
};

/** A next-service date inside this many days reads amber. Mirrors the fleet's
 *  own `DUE_SOON_DAYS` (shared/vehicles.ts) — 30 days is the window the club
 *  actually needs to book a machine in for servicing without scrambling. */
export const SERVICE_DUE_SOON_DAYS = 30;

// ── Calendar dates (timezone-free) ───────────────────────────────────────────
// Duplicated deliberately rather than imported from shared/housing.ts or
// shared/vehicles.ts — same reasoning those two give for not sharing with
// shared/academy.ts: this module must not gain a dependency on unrelated
// domain logic just to borrow a date helper.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isIsoDate = (v: unknown): v is string => typeof v === "string" && ISO_DATE.test(v);

/** Today in New Zealand as `YYYY-MM-DD`. NEVER `new Date().toISOString()` —
 *  NZ is UTC+12/+13, so from midday UTC onwards that reads tomorrow's date. */
export function nzTodayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** Midnight-UTC epoch ms for an ISO calendar date, used only to subtract one
 *  such value from another — never to format a date back to a string. */
function isoToUtcMs(iso: string): number | null {
  if (!isIsoDate(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  // Reject 2026-02-31 and friends: Date.UTC rolls them over silently.
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

// ── Stock status ─────────────────────────────────────────────────────────────

export type StockStatus = "out" | "low" | "no_level" | "ok";

/** Priority order matters: out-of-stock always wins, even over a supply with
 *  no reorder level set. `no_level` is a nudge to set one — not a failure — so
 *  it sits below `low` but a coordinator still sees it's un-configured. */
export function stockStatus(qtyOnHand: number, reorderLevel: number | null | undefined): StockStatus {
  if (qtyOnHand <= 0) return "out";
  if (reorderLevel != null && qtyOnHand <= reorderLevel) return "low";
  if (reorderLevel == null) return "no_level";
  return "ok";
}

/** Wraps `stockStatus` with the one rule that decides who gets counted: an
 *  archived supply never contributes to the low/out-of-stock rollups. Mirrors
 *  `vehicleCompliance`'s all-`ok` handling of a disposed vehicle. */
export function supplyStockStatus(supply: {
  status: string;
  qtyOnHand: number;
  reorderLevel: number | null;
}): StockStatus {
  if (supply.status === "archived") return "ok";
  return stockStatus(supply.qtyOnHand, supply.reorderLevel);
}

// ── Service status ───────────────────────────────────────────────────────────

export type ServiceStatus = "overdue" | "due_soon" | "unknown" | "ok";

const SERVICE_STATUS_RANK: Record<ServiceStatus, number> = { ok: 0, unknown: 1, due_soon: 2, overdue: 3 };

/** Worst status wins. `unknown` deliberately outranks `ok` — an unaudited
 *  machine is not "fine", it just hasn't been checked. Same ranking idea as
 *  the fleet's `worstStatus` (shared/vehicles.ts) and housing's overdue rule. */
export function worstServiceStatus(statuses: readonly ServiceStatus[]): ServiceStatus {
  return statuses.reduce<ServiceStatus>(
    (worst, s) => (SERVICE_STATUS_RANK[s] > SERVICE_STATUS_RANK[worst] ? s : worst),
    "ok",
  );
}

/** `nextServiceDueOn == null` reads `unknown`, never `ok` — a machine that has
 *  never had a service date recorded should nag, not sit quietly at green. */
export function serviceStatus(
  nextServiceDueOn: string | null | undefined,
  todayIso: string,
  dueSoonDays: number = SERVICE_DUE_SOON_DAYS,
): ServiceStatus {
  if (!nextServiceDueOn) return "unknown";
  const days = daysUntil(nextServiceDueOn, todayIso);
  if (days === null) return "unknown";
  if (days < 0) return "overdue";
  if (days <= dueSoonDays) return "due_soon";
  return "ok";
}

/** Wraps `serviceStatus` with the one rule that decides who gets counted: a
 *  retired asset never nags, whatever its `nextServiceDueOn` says — it isn't
 *  coming back into service, so reminding anyone about it is noise. */
export function assetServiceStatus(
  asset: { status: string; nextServiceDueOn: string | null },
  todayIso: string,
  dueSoonDays: number = SERVICE_DUE_SOON_DAYS,
): ServiceStatus {
  if (asset.status === "retired") return "ok";
  return serviceStatus(asset.nextServiceDueOn, todayIso, dueSoonDays);
}

// ── Money ────────────────────────────────────────────────────────────────────

/** Parse a dollar string ("1,250.50", "$300") to integer cents. Returns null on
 *  anything that isn't money, so a bad input can never silently become $0. */
export function dollarsToCents(input: unknown): number | null {
  const raw = String(input ?? "").replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) return null;
  return Math.round(Number(raw) * 100);
}
