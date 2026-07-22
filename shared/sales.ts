// ─────────────────────────────────────────────────────────────────────────────
// SALES — United Print prospect database + pipeline. Shared enums and derived
// statuses. Pure functions, no DB imports — same shape as shared/vehicles.ts.
//
// Stage values are validated HERE, application-side, never as a DB CHECK —
// a stale CHECK is how the MFL checkout 500'd when code shipped a value the
// database had never heard of.
// ─────────────────────────────────────────────────────────────────────────────

export const SALES_STAGES = [
  { key: "new", label: "New", color: "#64748b" },
  { key: "contacted", label: "Contacted", color: "#0ea5e9" },
  { key: "call_booked", label: "Call booked", color: "#8b5cf6" },
  { key: "sales_call", label: "Sales call", color: "#f59e0b" },
  { key: "quote_sent", label: "Quote sent", color: "#f97316" },
  { key: "won", label: "Won — invoiced", color: "#22c55e" },
  { key: "paid", label: "Invoice paid", color: "#10b981" },
  { key: "declined", label: "Declined", color: "#ef4444" },
] as const;

export type SalesStage = (typeof SALES_STAGES)[number]["key"];

export function isSalesStage(x: unknown): x is SalesStage {
  return typeof x === "string" && SALES_STAGES.some((s) => s.key === x);
}

export function stageLabel(key: string): string {
  return SALES_STAGES.find((s) => s.key === key)?.label ?? key;
}

/** Stages whose deal value counts as "in the pipeline" (not yet won, not dead). */
export const OPEN_PIPELINE_STAGES: readonly SalesStage[] = ["contacted", "call_booked", "sales_call", "quote_sent"];

export const SALES_ACTIVITY_TYPES = ["call", "email", "meeting", "note", "stage_change"] as const;
export type SalesActivityType = (typeof SALES_ACTIVITY_TYPES)[number];
export function isSalesActivityType(x: unknown): x is SalesActivityType {
  return typeof x === "string" && (SALES_ACTIVITY_TYPES as readonly string[]).includes(x);
}

/** Call/contact outcomes — the quick-log buttons in the UI. */
export const SALES_OUTCOMES = [
  "no_answer",
  "left_message",
  "gatekeeper",
  "callback",
  "interested",
  "not_interested",
  "call_booked",
  "other",
] as const;
export type SalesOutcome = (typeof SALES_OUTCOMES)[number];
export function isSalesOutcome(x: unknown): x is SalesOutcome {
  return typeof x === "string" && (SALES_OUTCOMES as readonly string[]).includes(x);
}

export const SALES_TIERS = ["A", "B", "C"] as const;
export type SalesTier = (typeof SALES_TIERS)[number];
export function isSalesTier(x: unknown): x is SalesTier {
  return typeof x === "string" && (SALES_TIERS as readonly string[]).includes(x);
}

export const SALES_REGIONS = ["christchurch", "canterbury", "south-island", "north-island", "nz-wide"] as const;
export type SalesRegion = (typeof SALES_REGIONS)[number];
export function isSalesRegion(x: unknown): x is SalesRegion {
  return typeof x === "string" && (SALES_REGIONS as readonly string[]).includes(x);
}

export const SALES_SOURCES = ["research-fleet", "manual"] as const;
export type SalesSource = (typeof SALES_SOURCES)[number];
export function isSalesSource(x: unknown): x is SalesSource {
  return typeof x === "string" && (SALES_SOURCES as readonly string[]).includes(x);
}

export function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Calendar-day addition on the date PARTS — no timezone in play, so an NZ
 *  evening never reads as yesterday the way `new Date().toISOString()` does. */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

export type FollowUpStatus = "none" | "overdue" | "due_today" | "upcoming" | "scheduled";

/** DERIVED, never stored — same rule as housing arrears and vehicle compliance.
 *  ISO strings compare chronologically, so plain string comparison is exact. */
export function followUpStatus(nextFollowUpOn: string | null | undefined, todayIso: string): FollowUpStatus {
  if (!nextFollowUpOn || !isIsoDate(nextFollowUpOn)) return "none";
  if (nextFollowUpOn < todayIso) return "overdue";
  if (nextFollowUpOn === todayIso) return "due_today";
  if (nextFollowUpOn <= addDaysIso(todayIso, 7)) return "upcoming";
  return "scheduled";
}
