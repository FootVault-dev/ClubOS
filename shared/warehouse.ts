// Warehouse (WMS) — pure logic. No DB, no network.
//
// One physical warehouse at United Sports Centre, shared by four brands'
// sellable merch (MFL + CIC on our own commerce engine, SIU + CUFC on two
// Shopify stores), United Prints raw materials, club equipment, and event
// stock. `wh_movements` (server/warehouse.ts) is the append-only ledger of
// truth; everything here is the taxonomy + validators + pure math that the
// engine, routes and UI all share — so a stale enum can never drift between
// server and client.
//
// SPEC.md §4.1 (schema) / D15 (movement taxonomy) / D7 (SKU scheme) /
// D8 (location codes) is the design authority. No DB CHECK constraints on any
// of these open value sets (house rule — a stale CHECK once 500'd the MFL
// checkout) — every one of them is validated here instead.
//
// Tested by script/test-warehouse-shared.ts.

// ── Item kinds ───────────────────────────────────────────────────────────────

export const ITEM_KINDS = ["merch", "material", "equipment", "event"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  merch: "Merchandise",
  material: "Print material",
  equipment: "Club equipment",
  event: "Event stock",
};
export function isItemKind(v: unknown): v is ItemKind {
  return typeof v === "string" && (ITEM_KINDS as readonly string[]).includes(v);
}

// ── Brand owners ─────────────────────────────────────────────────────────────
// Identical physical products owned by different brands are different items
// (D4) — a shared shirt design for MFL and CIC gets two `wh_items` rows keyed
// by brand_owner, never one pooled row.

export const BRAND_OWNERS = ["cufc", "siu", "mfl", "cic", "up", "club"] as const;
export type BrandOwner = (typeof BRAND_OWNERS)[number];
export const BRAND_OWNER_LABELS: Record<BrandOwner, string> = {
  cufc: "Christchurch United FC",
  siu: "South Island United",
  mfl: "Mini Football Leagues",
  cic: "Christchurch International Cup",
  up: "United Print",
  club: "Club (shared)",
};
export function isBrandOwner(v: unknown): v is BrandOwner {
  return typeof v === "string" && (BRAND_OWNERS as readonly string[]).includes(v);
}

// ── Units ─────────────────────────────────────────────────────────────────────
// Also used for `purchase_unit` (a roll of vinyl is 1 `roll` = 50 `m` — the
// multiplier lives in `purchase_qty`, not in a second unit vocabulary).

export const UNITS = ["ea", "m", "roll", "box"] as const;
export type Unit = (typeof UNITS)[number];
export const UNIT_LABELS: Record<Unit, string> = {
  ea: "each",
  m: "metres",
  roll: "roll",
  box: "box",
};
export function isUnit(v: unknown): v is Unit {
  return typeof v === "string" && (UNITS as readonly string[]).includes(v);
}

// ── Locations ─────────────────────────────────────────────────────────────────

export const LOCATION_KINDS = ["bin", "zone", "virtual"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];
export function isLocationKind(v: unknown): v is LocationKind {
  return typeof v === "string" && (LOCATION_KINDS as readonly string[]).includes(v);
}

/** Named physical zones every warehouse gets (D8). Not exhaustive — a site can
 *  have other zones too — but these are the ones the app treats specially. */
export const NAMED_ZONES = ["RECEIVING", "PACK", "DISPATCH", "QUARANTINE"] as const;
export type NamedZone = (typeof NAMED_ZONES)[number];

/** Non-physical locations every movement can reference so it always has a
 *  real from/to story (D8): goods arrive FROM a supplier, leave TO a
 *  customer, vanish TO scrap, or come FROM/TO production. */
export const VIRTUAL_LOCATION_CODES = ["SUPPLIER", "CUSTOMER", "SCRAP", "PRODUCTION"] as const;
export type VirtualLocationCode = (typeof VIRTUAL_LOCATION_CODES)[number];

/** QUARANTINE is where damaged/unavailable stock lives — it doesn't vanish
 *  from the ledger, it just isn't sellable. */
export const QUARANTINE_ZONE: NamedZone = "QUARANTINE";

/**
 * Location codes are one of:
 *  - a virtual code (`SUPPLIER`, `CUSTOMER`, `SCRAP`, `PRODUCTION`)
 *  - a bare named zone (`RECEIVING`, `PACK`, `DISPATCH`, `QUARANTINE`)
 *  - a shallow bin code `ZONE-AISLE-BAY-LEVEL` (D8), e.g. `A-01-2`,
 *    `RECEIVING-01-1-3` — 2 to 4 dash-separated uppercase alphanumeric
 *    segments, human-speakable, no length limit beyond staying short.
 */
export function isValidLocationCode(code: unknown): boolean {
  if (typeof code !== "string") return false;
  const c = code.trim();
  if (!c) return false;
  if ((VIRTUAL_LOCATION_CODES as readonly string[]).includes(c)) return true;
  if ((NAMED_ZONES as readonly string[]).includes(c)) return true;
  const segments = c.split("-");
  if (segments.length < 2 || segments.length > 4) return false;
  return segments.every((s) => /^[A-Z0-9]{1,10}$/.test(s));
}

/** Uppercases + trims a location code — does not otherwise reshape it
 *  (unlike SKUs, location segments are meaningful and must not be reordered). */
export function normaliseLocationCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Zone is auto-derived from a location's own code (D8/§4.1's schema comment
 *  "first segment of a bin code, or the named zone itself") — never a second
 *  free-text field a human can let drift out of sync with the code. A bin
 *  `A-01-2` zones to `A`; a bare named zone `RECEIVING` zones to itself;
 *  virtual locations (SUPPLIER/CUSTOMER/SCRAP/PRODUCTION) have no zone at all
 *  — stock parked there isn't shelved anywhere physical. */
export function deriveLocationZone(code: string, kind: LocationKind): string | null {
  if (kind === "virtual") return null;
  const first = code.split("-")[0];
  return first || null;
}

/** The bin/item label QR payload for a location (§4.4/D5): `LOC:` + the
 *  location's own code — item labels encode the SKU directly (no prefix
 *  needed, a SKU can never collide with this shape). Centralised here so the
 *  server's label endpoint (T4) and the scan resolver that will decode it
 *  later (T7) can never drift apart on the prefix string. */
export const LOCATION_BARCODE_PREFIX = "LOC:";
export function locationBarcodePayload(code: string): string {
  return `${LOCATION_BARCODE_PREFIX}${code}`;
}

// ── SKUs ──────────────────────────────────────────────────────────────────────
// Scheme (D7): BRAND-CAT-STYLE-COLOUR-SIZE, uppercase, <=20 chars, encode only
// durable attributes. Characters that are visually ambiguous when printed
// small on a label (0/O, 1/I/l) are avoided in generated codes, but existing
// supplier SKUs are not rejected for containing them.

const SKU_MAX_LEN = 20;

/** Uppercases, trims, collapses whitespace/underscores to a single dash, and
 *  strips anything that isn't A-Z0-9 or a dash. Truncates to 20 chars. */
export function normaliseSku(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^A-Z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, SKU_MAX_LEN);
}

/** A SKU is valid once normalised if it's non-empty, <=20 chars, and only
 *  uppercase letters/digits/dashes (no leading/trailing/double dashes). */
export function isValidSku(sku: unknown): boolean {
  if (typeof sku !== "string") return false;
  const s = sku.trim();
  if (!s || s.length > SKU_MAX_LEN) return false;
  return /^[A-Z0-9]+(-[A-Z0-9]+)*$/.test(s);
}

// ── Barcode aliases ───────────────────────────────────────────────────────────

/** Alias codes (manufacturer EANs etc.) are looked up verbatim — never
 *  reshaped like a SKU, since we don't own the format. Just trims. */
export function normaliseAliasCode(code: string): string {
  return code.trim();
}

// ── Movement taxonomy (D15) ───────────────────────────────────────────────────

export const MOVEMENT_TYPES = [
  "receipt",
  "putaway",
  "pick",
  "dispatch",
  "transfer",
  "adjustment",
  "count",
  "consume",
  "return",
  "loan_out",
  "loan_return",
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];
export const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  receipt: "Receipt",
  putaway: "Putaway",
  pick: "Pick",
  dispatch: "Dispatch",
  transfer: "Transfer",
  adjustment: "Adjustment",
  count: "Count",
  consume: "Consume",
  return: "Return",
  loan_out: "Loan out",
  loan_return: "Loan return",
};
export function isMovementType(v: unknown): v is MovementType {
  return typeof v === "string" && (MOVEMENT_TYPES as readonly string[]).includes(v);
}

export const REASON_CODES = [
  "damaged",
  "shrinkage",
  "count_variance",
  "sample",
  "write_off",
  "store_use",
  "event_use",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export const REASON_CODE_LABELS: Record<ReasonCode, string> = {
  damaged: "Damaged",
  shrinkage: "Shrinkage",
  count_variance: "Count variance",
  sample: "Sample given out",
  write_off: "Write-off",
  store_use: "Store use",
  event_use: "Event use",
};
export function isReasonCode(v: unknown): v is ReasonCode {
  return typeof v === "string" && (REASON_CODES as readonly string[]).includes(v);
}

/** Physical disposition of stock after a movement (D15's "damaged stock moves
 *  to QUARANTINE, it doesn't vanish"). Not a stored column — `wh_stock` has no
 *  disposition field — it's derived from WHICH location a leg targets: the
 *  QUARANTINE zone is `unavailable`, everywhere else is `on_hand`. Exposed
 *  here so routes/UI can decide "does this reason send stock to quarantine?"
 *  with one shared rule instead of duplicating the reason list. */
export const DISPOSITIONS = ["on_hand", "unavailable"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export function isDisposition(v: unknown): v is Disposition {
  return typeof v === "string" && (DISPOSITIONS as readonly string[]).includes(v);
}

/** Reason codes that always route stock to QUARANTINE rather than a sellable
 *  bin. `sample`, `store_use` and `event_use` consume stock outright (it
 *  leaves the building) rather than quarantining it. */
const QUARANTINE_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>(["damaged", "shrinkage"]);

export function dispositionForReason(reason: ReasonCode | null | undefined): Disposition {
  if (reason && QUARANTINE_REASONS.has(reason)) return "unavailable";
  return "on_hand";
}

/** Is this location a sellable/usable bin, or does stock there not count as
 *  available (quarantine, or a virtual location like SUPPLIER/CUSTOMER)? */
export function isSellableLocation(location: { code: string; kind: LocationKind }): boolean {
  if (location.kind === "virtual") return false;
  if (location.code.trim().toUpperCase() === QUARANTINE_ZONE) return false;
  return true;
}

// ── Polymorphic movement / reservation references ────────────────────────────

export const REF_KINDS = ["shop_order", "shopify_order", "print_order", "requisition", "loan", "po", "count"] as const;
export type RefKind = (typeof REF_KINDS)[number];
export function isRefKind(v: unknown): v is RefKind {
  return typeof v === "string" && (REF_KINDS as readonly string[]).includes(v);
}

// ── Reservations ──────────────────────────────────────────────────────────────

export const RESERVATION_STATUSES = ["active", "released", "consumed"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export function isReservationStatus(v: unknown): v is ReservationStatus {
  return typeof v === "string" && (RESERVATION_STATUSES as readonly string[]).includes(v);
}

// ── Purchase orders ───────────────────────────────────────────────────────────

export const PO_STATUSES = ["draft", "sent", "partial", "received", "closed", "cancelled"] as const;
export type PoStatus = (typeof PO_STATUSES)[number];
export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  partial: "Partially received",
  received: "Received",
  closed: "Closed",
  cancelled: "Cancelled",
};
export function isPoStatus(v: unknown): v is PoStatus {
  return typeof v === "string" && (PO_STATUSES as readonly string[]).includes(v);
}

// ── Dates (DB `date` columns — expected_on, needed_by, due_on…) ─────────────
// Plain YYYY-MM-DD shape check only. NZ-local semantics + never round-tripping
// through `Date` is the CALLER's job (house rule, grep nzTodayIso()) — this is
// just the shared shape validator so every date-only field (PO expected_on
// here, requisition needed_by / loan due_on later) rejects the same junk.

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isValidDateOnly(v: unknown): v is string {
  return typeof v === "string" && DATE_ONLY_RE.test(v);
}

// ── Receiving (T6) ───────────────────────────────────────────────────────────
// A receive-scan reports qtyGood (undamaged units landing in the named
// sellable bin) and qtyDamaged (units landing in QUARANTINE, reason
// 'damaged' — the only D15 reason code that applies at receiving time).
// `expectedQty` is what the PO line still owes (qty_ordered minus whatever's
// already been received against it, derived from the ledger) unless the
// caller overrides it with what a packing slip actually says. It's compared
// against the real total purely to produce a human-readable discrepancy
// NOTE on the movement group — D15 has no reason code for "unexpected
// surplus", so an over-receipt is recorded as a note, never routed anywhere
// special. Only genuinely damaged stock is quarantined.

export interface ReceiveDiscrepancy {
  expectedQty: number;
  qtyGood: number;
  qtyDamaged: number;
  /** > 0 when more arrived (good + damaged) than was expected. */
  overQty: number;
  /** > 0 when less arrived than was expected. */
  shortQty: number;
}

export function computeReceiveDiscrepancy(expectedQty: number, qtyGood: number, qtyDamaged: number): ReceiveDiscrepancy {
  const diff = qtyGood + qtyDamaged - expectedQty;
  return {
    expectedQty,
    qtyGood,
    qtyDamaged,
    overQty: diff > 0 ? diff : 0,
    shortQty: diff < 0 ? -diff : 0,
  };
}

/** Human-readable note for the receipt movement group. Null when the scan
 *  matched exactly — no damage, no over/short — nothing worth flagging. */
export function receiveDiscrepancyNote(d: ReceiveDiscrepancy): string | null {
  const parts: string[] = [];
  if (d.qtyDamaged > 0) parts.push(`${d.qtyDamaged} damaged (quarantined)`);
  if (d.overQty > 0) parts.push(`${d.overQty} over expected`);
  if (d.shortQty > 0) parts.push(`${d.shortQty} short of expected`);
  if (parts.length === 0) return null;
  return `Expected ${d.expectedQty}, received ${d.qtyGood + d.qtyDamaged} — ${parts.join(", ")}.`;
}

/** A PO line's derived receiving position (qty_received is never a stored
 *  column — schema.ts's own comment on wh_po_lines — it's the SUM of every
 *  receipt movement, good + damaged, referencing that line). */
export interface PoLineReceiptStatus {
  qtyOrdered: number;
  qtyReceived: number;
}

/**
 * Auto-advances a PO's status from its lines' derived receiving totals.
 * Never touches 'draft' (nothing has been sent to the supplier yet — a
 * receive-scan against a draft PO is rejected before this is ever reached)
 * or the two terminal states 'cancelled'/'closed' (a human closed the PO on
 * purpose; more stock turning up shouldn't silently reopen it).
 */
export function derivePoStatusFromLines(currentStatus: PoStatus, lines: PoLineReceiptStatus[]): PoStatus {
  if (currentStatus === "draft" || currentStatus === "cancelled" || currentStatus === "closed") return currentStatus;
  if (lines.length === 0) return currentStatus;
  const allReceived = lines.every((l) => l.qtyReceived >= l.qtyOrdered);
  if (allReceived) return "received";
  const anyReceived = lines.some((l) => l.qtyReceived > 0);
  return anyReceived ? "partial" : currentStatus;
}

// ── Requisitions ───────────────────────────────────────────────────────────────

export const REQUISITION_STATUSES = ["submitted", "approved", "picking", "ready", "collected", "declined"] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];
export const REQUISITION_STATUS_LABELS: Record<RequisitionStatus, string> = {
  submitted: "Submitted",
  approved: "Approved",
  picking: "Picking",
  ready: "Ready for collection",
  collected: "Collected",
  declined: "Declined",
};
export function isRequisitionStatus(v: unknown): v is RequisitionStatus {
  return typeof v === "string" && (REQUISITION_STATUSES as readonly string[]).includes(v);
}

/** Terminal states — no further transition is valid. */
export const REQUISITION_TERMINAL_STATUSES: ReadonlySet<RequisitionStatus> = new Set<RequisitionStatus>([
  "collected",
  "declined",
]);

// ── Equipment loans ───────────────────────────────────────────────────────────

export const LOAN_STATUSES = ["out", "returned"] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];
export function isLoanStatus(v: unknown): v is LoanStatus {
  return typeof v === "string" && (LOAN_STATUSES as readonly string[]).includes(v);
}

/** Condition grade on a returned loan line — the library/tool-crib standard
 *  (A resalable/reusable as-is · B usable, needs repackage/clean · C damaged,
 *  needs repair · D scrap, write off). */
export const CONDITION_GRADES = ["A", "B", "C", "D"] as const;
export type ConditionGrade = (typeof CONDITION_GRADES)[number];
export const CONDITION_GRADE_LABELS: Record<ConditionGrade, string> = {
  A: "A — good, as new",
  B: "B — usable, needs clean/repackage",
  C: "C — damaged, needs repair",
  D: "D — scrap, write off",
};
export function isConditionGrade(v: unknown): v is ConditionGrade {
  return typeof v === "string" && (CONDITION_GRADES as readonly string[]).includes(v);
}

/** Is a loan overdue? DERIVED, never stored (D14) — never trust a stale
 *  `overdue` column, always recompute from `due_on`/`status` at read time. */
export function isLoanOverdue(loan: { status: LoanStatus; dueOn: string }, todayIso: string): boolean {
  return loan.status === "out" && loan.dueOn < todayIso;
}

// ── Cycle counts ───────────────────────────────────────────────────────────────

export const COUNT_STATUSES = ["open", "submitted", "approved"] as const;
export type CountStatus = (typeof COUNT_STATUSES)[number];
export const COUNT_STATUS_LABELS: Record<CountStatus, string> = {
  open: "Counting",
  submitted: "Submitted — pending review",
  approved: "Approved",
};
export function isCountStatus(v: unknown): v is CountStatus {
  return typeof v === "string" && (COUNT_STATUSES as readonly string[]).includes(v);
}

export const COUNT_LINE_RESOLUTIONS = ["accepted", "recount"] as const;
export type CountLineResolution = (typeof COUNT_LINE_RESOLUTIONS)[number];
export function isCountLineResolution(v: unknown): v is CountLineResolution {
  return typeof v === "string" && (COUNT_LINE_RESOLUTIONS as readonly string[]).includes(v);
}

/** Variance thresholds from D12: >10% (relative) OR >$100 (absolute, cents)
 *  triggers an independent recount rather than auto-accepting the count. */
export const COUNT_VARIANCE_PERCENT_THRESHOLD = 0.1;
export const COUNT_VARIANCE_CENTS_THRESHOLD = 10_000;

/**
 * Does a counted line need an independent recount, per D12's doctrine?
 * `unitCostCents` is optional — with no cost on file we can only apply the
 * percentage rule, never the dollar one (a missing cost must never read as
 * "$0 variance, all clear").
 */
export function countLineNeedsRecount(
  expectedQty: number,
  countedQty: number,
  unitCostCents?: number | null,
): boolean {
  const diff = Math.abs(countedQty - expectedQty);
  if (diff === 0) return false;
  const percentVariance = expectedQty !== 0 ? diff / Math.abs(expectedQty) : 1;
  if (percentVariance > COUNT_VARIANCE_PERCENT_THRESHOLD) return true;
  if (typeof unitCostCents === "number" && diff * unitCostCents > COUNT_VARIANCE_CENTS_THRESHOLD) return true;
  return false;
}

// ── Stock math ─────────────────────────────────────────────────────────────────

/**
 * `available` is DERIVED, never stored (D2): on_hand minus everything already
 * promised to an order. Never clamped to zero — a negative result means a
 * reservation was made against a bin that shouldn't have allowed it, and
 * hiding that behind a floor of 0 would make the bug invisible.
 */
export function availableQty(onHand: number, reserved: number): number {
  return onHand - reserved;
}

/** Would applying `delta` to `onHand` leave it negative? Mirrors the atomic
 *  SQL guard in `postMovementGroup` (`WHERE on_hand + delta >= 0`) so the same
 *  rule can be checked client-side before a scan is even submitted. */
export function wouldGoNegative(onHand: number, delta: number, allowNegative: boolean): boolean {
  if (allowNegative) return false;
  return onHand + delta < 0;
}

/** A transfer's legs must sum to zero — stock leaving one location and
 *  arriving at another, never created or destroyed in transit. */
export function legsSumToZero(deltas: number[]): boolean {
  const sum = deltas.reduce((a, b) => a + b, 0);
  return Math.abs(sum) < 1e-9;
}

// ── Scan resolution & location moves (T7) ───────────────────────────────────
// The scan station's whole job (§4.4): read a code, work out what it names,
// offer the right next actions. The actual lookups need wh_items/
// wh_locations/wh_barcode_aliases tables (server/warehouse.ts's
// resolveScanCode, behind a bespoke ScanLookupDb seam — same reasoning as
// WarehouseDb/ReservationDb there, see that file's header comment);
// everything below is the DB-free half — the LOC: prefix convention, the
// advisory action lists, the pack_qty multiplier arithmetic, and the
// two-leg shape every putaway/transfer shares — kept here so it's
// unit-testable with no DB and shared with the future scan station UI (T15)
// so client and server never carry two different copies of this logic.

/** Does this code carry the `LOC:` prefix (§4.4/D5)? If so it's
 *  UNAMBIGUOUSLY a location — the caller must look ONLY at wh_locations,
 *  never fall through to an item/alias lookup even on a miss (a mistyped
 *  bin code should read as "unknown", not get silently checked against SKUs
 *  it was never meant to be). Case-insensitive on the prefix itself (a
 *  human might type `loc:a-01-2` by hand); the code portion is always run
 *  through normaliseLocationCode regardless of how it was cased. */
export function stripLocationPrefix(code: string): { isLocationCode: boolean; code: string } {
  const trimmed = code.trim();
  if (trimmed.toUpperCase().startsWith(LOCATION_BARCODE_PREFIX)) {
    return { isLocationCode: true, code: normaliseLocationCode(trimmed.slice(LOCATION_BARCODE_PREFIX.length)) };
  }
  return { isLocationCode: false, code: trimmed };
}

/** The scan station's action sheet once a code resolves to an ITEM (§4.4).
 *  Advisory, not a live capability check — putaway/transfer get a real
 *  endpoint in T7 itself; receive/pick/dispatch/consume/loan_out/
 *  loan_return/count wire up across T6 and T8-T11, and the UI is expected to
 *  grey out whatever it can't yet actually call. Equipment loan actions only
 *  appear when the item itself is loanable (wh_items.is_loanable) — offering
 *  "loan out" on a box of vinyl makes no sense. */
export function scanActionsForItem(item: { isLoanable: boolean }): MovementType[] {
  const actions: MovementType[] = ["putaway", "pick", "dispatch", "transfer", "consume"];
  if (item.isLoanable) actions.push("loan_out", "loan_return");
  return actions;
}

/** Same advisory list once a code resolves to a LOCATION. A virtual
 *  location (SUPPLIER/CUSTOMER/SCRAP/PRODUCTION) has no printed label
 *  anyone would ever scan — it's chosen from a dropdown as one leg of a
 *  receipt/dispatch/write-off, never walked to with a trolley — so scanning
 *  one offers nothing. A real bin/zone offers the full set. */
export function scanActionsForLocation(location: { kind: LocationKind }): MovementType[] {
  if (location.kind === "virtual") return [];
  return ["putaway", "transfer", "count"];
}

/** A barcode alias's pack_qty is a per-scan multiplier (D5) — scanning a
 *  case barcode `scans` times (or entering a case count once against it)
 *  posts `scans * packQty` eaches, never `scans` eaches. Its own one-line
 *  function so the scan station (T15) and any server-side receiving/putaway
 *  flow multiply it exactly the same way. */
export function scanQuantityToUnits(scans: number, packQty: number): number {
  return scans * packQty;
}

/** One (item, fromLocation, toLocation, qty) move as the two ledger legs
 *  every putaway/transfer needs (D8: every movement has a real from/to
 *  story) — stock leaving fromLocation, the same qty arriving at
 *  toLocation. `allowNegative` is the ITEM's own setting, applied to both
 *  legs — it only ever matters for the source leg's guard (the destination
 *  leg's delta is always positive and can never go negative), but passing
 *  it uniformly means putaway and transfer's route handlers build their
 *  legs identically instead of each deciding separately. `movementType`
 *  itself is NOT baked in here — it's the one thing that differs between a
 *  putaway and a transfer, so the caller supplies it directly to
 *  postMovementGroup/runMovementGroup. */
export interface LocationMoveLeg {
  itemId: number;
  locationId: number;
  locationCode: string;
  delta: number;
  allowNegative: boolean;
}

export function buildLocationMoveLegs(
  item: { id: number; allowNegative: boolean },
  fromLocation: { id: number; code: string },
  toLocation: { id: number; code: string },
  qty: number,
): [LocationMoveLeg, LocationMoveLeg] {
  return [
    { itemId: item.id, locationId: fromLocation.id, locationCode: fromLocation.code, delta: -qty, allowNegative: item.allowNegative },
    { itemId: item.id, locationId: toLocation.id, locationCode: toLocation.code, delta: qty, allowNegative: item.allowNegative },
  ];
}
