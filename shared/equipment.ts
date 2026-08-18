// ─────────────────────────────────────────────────────────────────────────────
// EQUIPMENT REGISTER — enums and the derived-status maths.
//
// No DB imports. Pure functions, so the badges the client draws are computed by
// the same code the server uses to decide who gets chased.
//
// The shape of this feature came out of the 18 Aug 2026 meeting (Ryan, Travis,
// Daniel) and the whiteboard photographed at the end of it. Three sentences
// from that meeting are load-bearing and are why this file looks the way it
// does:
//
//  1. "We don't want to do it by equipment, we want to do it by TEAM" — and
//     "it should be one main person per team". So the spine is not an item
//     catalogue with an owner column; it is a HOLDER (one named person against
//     one team) who owns a list. Accountability is the product; the inventory
//     is a consequence. Two people responsible for one team is nobody
//     responsible, so the database refuses it.
//
//  2. "It shouldn't be Travis inputting information" — the person responsible
//     builds and maintains their own list, and adds to it through the year as
//     grant-funded gear arrives. Hence a per-holder self-service link.
//
//  3. "If we do an audit every term, that will get coaches in the good habit."
//     A term is the audit cadence. Per-session checkout was considered and
//     explicitly rejected as impractical.
//
// The one distinction this file exists to protect: a quantity that has NOT
// BEEN COUNTED is `null`, and null is not zero. A holder who has not yet
// counted their bibs has not told us they lost all of them. Every function
// below keeps those two apart, because collapsing them would turn an
// unfinished audit into an accusation.
// ─────────────────────────────────────────────────────────────────────────────

// ── Enums ────────────────────────────────────────────────────────────────────

/** Training gear only. Playing kit and uniform are deliberately absent: asked
 *  directly in the meeting ("do you need kit and uniform?") the answer was
 *  "No". Uniform stock lives in the Warehouse, which counts garments by size
 *  and vendor — a different question with a different shape. */
export const EQUIPMENT_CATEGORIES = [
  "balls",
  "bibs",
  "cones_markers",
  "goals_nets",
  "training_aids",
  "first_aid",
  "bags_storage",
  "technology",
  "other",
] as const;
export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

export const EQUIPMENT_CATEGORY_LABELS: Record<EquipmentCategory, string> = {
  balls: "Balls",
  bibs: "Bibs",
  cones_markers: "Cones & markers",
  goals_nets: "Goals & nets",
  training_aids: "Training aids",
  first_aid: "First aid",
  bags_storage: "Bags & storage",
  technology: "Technology",
  other: "Other",
};

/** Condition is the holder's own judgement at the moment they looked at it.
 *  `unusable` is separate from a reduced quantity on purpose: four punctured
 *  balls are still four balls we own and still four balls we must replace. */
export const EQUIPMENT_CONDITIONS = ["new", "good", "fair", "poor", "unusable"] as const;
export type EquipmentCondition = (typeof EQUIPMENT_CONDITIONS)[number];

export const EQUIPMENT_CONDITION_LABELS: Record<EquipmentCondition, string> = {
  new: "New",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
  unusable: "Unusable",
};

/** Where the item came from. `grant` earns its own value because the reason
 *  Ryan wants quantities at all is grant-funding applications — "so we can
 *  reorder and do grant funding applications for what's missing". */
export const EQUIPMENT_SOURCES = ["purchased", "grant", "donated", "sponsor", "unknown"] as const;
export type EquipmentSource = (typeof EQUIPMENT_SOURCES)[number];

export const EQUIPMENT_SOURCE_LABELS: Record<EquipmentSource, string> = {
  purchased: "Purchased",
  grant: "Grant funded",
  donated: "Donated",
  sponsor: "Sponsor",
  unknown: "Not recorded",
};

/** A holder stops being responsible without being deleted. Their list and every
 *  audit they ever submitted stays — who held the gear in March is a question
 *  somebody may ask in November. */
export const HOLDER_STATUSES = ["active", "inactive"] as const;
export type HolderStatus = (typeof HOLDER_STATUSES)[number];

/** A round is opened, then closed once staff stop chasing it. Closing is a
 *  human act, not a date passing — a round with two stragglers left is still
 *  worth chasing a fortnight after it was due. */
export const ROUND_STATUSES = ["open", "closed"] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

export const isEquipmentCategory = (v: unknown): v is EquipmentCategory =>
  EQUIPMENT_CATEGORIES.includes(v as EquipmentCategory);
export const isEquipmentCondition = (v: unknown): v is EquipmentCondition =>
  EQUIPMENT_CONDITIONS.includes(v as EquipmentCondition);
export const isEquipmentSource = (v: unknown): v is EquipmentSource =>
  EQUIPMENT_SOURCES.includes(v as EquipmentSource);
export const isHolderStatus = (v: unknown): v is HolderStatus => HOLDER_STATUSES.includes(v as HolderStatus);
export const isRoundStatus = (v: unknown): v is RoundStatus => ROUND_STATUSES.includes(v as RoundStatus);

// ── Calendar dates ───────────────────────────────────────────────────────────
// An audit due date is a day in New Zealand, not an instant. Building a `Date`
// from "2026-09-24" and formatting it back prints the wrong day — the invoice
// page shipped "18 July" on an invoice due the 17th exactly that way. So these
// helpers take ISO strings and, where arithmetic is unavoidable, go through
// Date.UTC on the parts. UTC has no DST, so the difference of two such values
// is exact.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isIsoDate = (v: unknown): v is string => typeof v === "string" && ISO_DATE.test(v);

function isoToUtcMs(iso: string): number | null {
  if (!isIsoDate(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  // Reject 2026-02-31 and friends — Date.UTC rolls them over in silence.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

/** Whole days from `a` to `b`. Negative when `b` is in the past. */
export function daysBetween(a: string, b: string): number | null {
  const ms1 = isoToUtcMs(a);
  const ms2 = isoToUtcMs(b);
  if (ms1 === null || ms2 === null) return null;
  return Math.round((ms2 - ms1) / 86_400_000);
}

// ── Audit status — DERIVED, never stored ─────────────────────────────────────

export const AUDIT_STATUSES = ["submitted", "due_soon", "outstanding", "overdue"] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

/** A return inside this many days of its due date reads amber. */
export const AUDIT_DUE_SOON_DAYS = 7;

export interface AuditStatusInput {
  /** ISO timestamp the holder pressed submit, or null if they never have. */
  submittedAt: string | null;
  /** The round's due date, ISO calendar date. */
  dueOn: string | null;
  /** Today in New Zealand — always supplied by the server, never invented by
   *  the browser. `new Date().toISOString()` is UTC and reads a day behind in
   *  NZ for eleven hours of every day. */
  todayIso: string;
}

/**
 * Where one holder stands in one audit round.
 *
 * 🔴 There is no `status` column behind this. A return row exists or it does
 * not, and the due date either has or has not passed. A stored status would
 * need something to un-set it when a round's date is edited or a late return
 * arrives, and the thing that would have to remember is a person.
 *
 * 🔴 A LATE return is `submitted`, not `overdue`. Once the count is in, the
 * chase is over; whether it arrived on time is a separate question answered by
 * comparing `submittedAt` with `dueOn`, and it must not keep the holder on the
 * outstanding list forever.
 */
export function auditStatus({ submittedAt, dueOn, todayIso }: AuditStatusInput): AuditStatus {
  if (submittedAt) return "submitted";
  if (!dueOn) return "outstanding";
  const days = daysBetween(todayIso, dueOn);
  if (days === null) return "outstanding";
  if (days < 0) return "overdue";
  if (days <= AUDIT_DUE_SOON_DAYS) return "due_soon";
  return "outstanding";
}

/** Was a submitted return in on time? `null` when it was never submitted, or
 *  when the round carries no due date to be late against. */
export function submittedLate(submittedAtIso: string | null, dueOn: string | null): boolean | null {
  if (!submittedAtIso || !dueOn) return null;
  const day = submittedAtIso.slice(0, 10);
  const days = daysBetween(day, dueOn);
  if (days === null) return null;
  return days < 0;
}

export const AUDIT_STATUS_LABELS: Record<AuditStatus, string> = {
  submitted: "Submitted",
  due_soon: "Due soon",
  outstanding: "Not yet submitted",
  overdue: "Overdue",
};

// ── Variance ─────────────────────────────────────────────────────────────────

export interface VarianceInput {
  /** What the register said the holder had when the round opened. */
  expected: number | null;
  /** What they counted. `null` means they did not count this line — which is
   *  NOT the same as counting zero, and must never be rendered as a loss. */
  counted: number | null;
}

export type VarianceKind = "not_counted" | "match" | "short" | "surplus";

export interface Variance {
  kind: VarianceKind;
  /** counted − expected. `null` whenever the line was not counted. */
  delta: number | null;
}

/**
 * 🔴 The one rule this whole file exists for: `counted === null` is
 * "not counted", never zero. Reporting an uncounted line as a total loss would
 * accuse a coach of losing gear on the strength of them not having finished a
 * form yet.
 */
export function variance({ expected, counted }: VarianceInput): Variance {
  if (counted === null || counted === undefined) return { kind: "not_counted", delta: null };
  const exp = expected ?? 0;
  const delta = counted - exp;
  if (delta === 0) return { kind: "match", delta: 0 };
  return { kind: delta < 0 ? "short" : "surplus", delta };
}

// ── Roll-ups ─────────────────────────────────────────────────────────────────

export interface CategoryTotal {
  category: EquipmentCategory;
  label: string;
  quantity: number;
  lines: number;
}

/**
 * Total quantity per category across whatever items are passed in. This is the
 * number the meeting actually asked for — "so we can reorder and do grant
 * funding applications for what's missing" — and it is why quantity is a
 * required field on an item rather than an optional nicety.
 */
export function categoryTotals(
  items: Array<{ category: string; quantity: number | null }>,
): CategoryTotal[] {
  const byCat = new Map<EquipmentCategory, { quantity: number; lines: number }>();
  for (const item of items) {
    const cat: EquipmentCategory = isEquipmentCategory(item.category) ? item.category : "other";
    const acc = byCat.get(cat) ?? { quantity: 0, lines: 0 };
    acc.quantity += item.quantity ?? 0;
    acc.lines += 1;
    byCat.set(cat, acc);
  }
  return EQUIPMENT_CATEGORIES.filter(c => byCat.has(c)).map(c => ({
    category: c,
    label: EQUIPMENT_CATEGORY_LABELS[c],
    quantity: byCat.get(c)!.quantity,
    lines: byCat.get(c)!.lines,
  }));
}

export interface RoundProgress {
  holders: number;
  submitted: number;
  outstanding: number;
  overdue: number;
  /** 0–100, rounded. `null` when there are no holders — 0% would read as a
   *  failure by 25 people who do not exist. */
  percent: number | null;
}

export function roundProgress(
  rows: Array<{ submittedAt: string | null }>,
  dueOn: string | null,
  todayIso: string,
): RoundProgress {
  let submitted = 0;
  let overdue = 0;
  for (const r of rows) {
    const st = auditStatus({ submittedAt: r.submittedAt, dueOn, todayIso });
    if (st === "submitted") submitted++;
    else if (st === "overdue") overdue++;
  }
  const holders = rows.length;
  return {
    holders,
    submitted,
    outstanding: holders - submitted,
    overdue,
    percent: holders === 0 ? null : Math.round((submitted / holders) * 100),
  };
}
