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

// ── Tracking mode (D18) ──────────────────────────────────────────────────────
// The only level that changes an item's DATA STRUCTURE rather than just
// grouping it: 'stock' is counted in bulk and lives in wh_stock; 'asset' is
// owned one-by-one and lives in wh_item_instances. Fixed at creation — see
// canChangeTrackingMode() below for why it is not a UI toggle.

export const TRACKING_MODES = ["stock", "asset"] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];
export const TRACKING_MODE_LABELS: Record<TrackingMode, string> = {
  stock: "Counted stock",
  asset: "Tracked asset",
};
export const TRACKING_MODE_BLURBS: Record<TrackingMode, string> = {
  stock: "How many do we have — shirts, vinyl, footballs. Counted in bulk per bin.",
  asset: "Which one is it — heat presses, laptops, desks. Each unit tracked on its own.",
};
export function isTrackingMode(v: unknown): v is TrackingMode {
  return typeof v === "string" && (TRACKING_MODES as readonly string[]).includes(v);
}

/**
 * Changing tracking_mode moves an item's physical reality between two
 * different child tables, so it is only ever safe while the item has NO
 * history at all. Once anything has been scanned, counted or bought, a change
 * is a deliberate data migration, not a dropdown — the ledger would otherwise
 * describe quantities that no longer have anywhere to live.
 */
export function canChangeTrackingMode(history: { movementCount: number; instanceCount: number }): boolean {
  return history.movementCount === 0 && history.instanceCount === 0;
}

// ── Asset instance condition (D19) ───────────────────────────────────────────
// 'decommissioned' IS retirement: the instance keeps its whole ledger and stops
// counting towards "how many do we have". Retire, never delete — the same rule
// the Vehicles tab runs on, for the same reason (an insurer or the IRD may ask
// about a thing years after it left the building).

export const INSTANCE_CONDITIONS = ["new", "working", "damaged", "decommissioned"] as const;
export type InstanceCondition = (typeof INSTANCE_CONDITIONS)[number];
export const INSTANCE_CONDITION_LABELS: Record<InstanceCondition, string> = {
  new: "New",
  working: "Working",
  damaged: "Damaged",
  decommissioned: "Decommissioned",
};
export function isInstanceCondition(v: unknown): v is InstanceCondition {
  return typeof v === "string" && (INSTANCE_CONDITIONS as readonly string[]).includes(v);
}

/** Does this instance still count as something the club has? A decommissioned
 *  press is history, not inventory. Derived — never a stored `is_active`. */
export function instanceCountsAsHeld(condition: InstanceCondition): boolean {
  return condition !== "decommissioned";
}

/** Warranty status for one instance, as at a caller-supplied NZ `today`
 *  (bare ISO date strings compared as strings — never through a JS `Date`,
 *  which reads a day behind in NZ). 'unknown' when no warranty is recorded:
 *  an unaudited asset must never render as a reassuring green. */
export type WarrantyStatus = "unknown" | "expired" | "expiring" | "ok";
export function warrantyStatus(warrantyUntil: string | null | undefined, todayIso: string): WarrantyStatus {
  if (!warrantyUntil || !isValidDateOnly(warrantyUntil)) return "unknown";
  if (warrantyUntil < todayIso) return "expired";
  const soon = addDaysIso(todayIso, 30);
  return warrantyUntil <= soon ? "expiring" : "ok";
}

/** Adds whole days to a bare ISO date, staying in string space (UTC arithmetic
 *  on a date-only value can never drift a timezone, because there is no clock
 *  in it — the result is re-serialised as a bare date immediately). */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
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

// D20 — 'person' and 'vehicle' are LOCATIONS, not a free-text "assigned to"
// field. A thing issued to Riley or sitting in the van is somewhere specific,
// and the ledger has to be able to say so; two ways of recording where
// something is guarantees they disagree by Friday.
export const LOCATION_KINDS = ["bin", "zone", "virtual", "person", "vehicle"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];
export const LOCATION_KIND_LABELS: Record<LocationKind, string> = {
  bin: "Bin",
  zone: "Zone",
  virtual: "Virtual",
  person: "Person",
  vehicle: "Vehicle",
};
export function isLocationKind(v: unknown): v is LocationKind {
  return typeof v === "string" && (LOCATION_KINDS as readonly string[]).includes(v);
}

/** Locations that hold real things but are not part of the warehouse floor.
 *  Stock here is genuinely ours and genuinely counted — it just isn't on a
 *  shelf, so it must never be offered for sale. */
const CUSTODY_KINDS: ReadonlySet<LocationKind> = new Set<LocationKind>(["person", "vehicle"]);
export function isCustodyLocation(kind: LocationKind): boolean {
  return CUSTODY_KINDS.has(kind);
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

/** SCRAP is where written-off stock lives (D14/D15's "vanish TO scrap") — a
 *  loan line returned in grade D (scrap, write off) posts a real ledger row
 *  into this virtual location rather than simply never coming back, so the
 *  write-off stays auditable. */
export const SCRAP_ZONE: VirtualLocationCode = "SCRAP";

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

/** A location's optional human name — "United Sports Centre Warehouse" beside
 *  the code USC-WAREHOUSE. Trimmed, collapsed, and NOT uppercased: this is
 *  prose a person reads, not an identifier a scanner matches. Blank → null,
 *  never an empty string, so "has a name" is one honest test everywhere. */
export const LOCATION_NAME_MAX = 80;
export function normaliseLocationName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const n = name.trim().replace(/\s+/g, " ");
  return n ? n.slice(0, LOCATION_NAME_MAX) : null;
}

/** What to SHOW a human picking a location. The name when there is one, the
 *  code otherwise — because a location that pre-dates names (RECEIVING, every
 *  seeded bin) must never render blank in a dropdown.
 *
 *  🔴 Display only. The code stays the identity: it is what a bin label
 *  encodes, what `LOC:` resolves, and what the ledger and CSV exports print.
 *  Never look a location up by this. */
export function locationLabel(loc: { code: string; name?: string | null }): string {
  const n = normaliseLocationName(loc.name);
  return n || loc.code;
}

/** Zone is auto-derived from a location's own code (D8/§4.1's schema comment
 *  "first segment of a bin code, or the named zone itself") — never a second
 *  free-text field a human can let drift out of sync with the code. A bin
 *  `A-01-2` zones to `A`; a bare named zone `RECEIVING` zones to itself;
 *  virtual locations (SUPPLIER/CUSTOMER/SCRAP/PRODUCTION) have no zone at all
 *  — stock parked there isn't shelved anywhere physical. */
export function deriveLocationZone(code: string, kind: LocationKind): string | null {
  if (kind === "virtual") return null;
  // D21 — a person or a vehicle is not shelved anywhere either. Deriving a
  // zone 'PERSON' from PERSON-RILEY would file every staff member's kit under
  // one imaginary aisle in the warehouse map.
  if (isCustodyLocation(kind)) return null;
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
  // D25 — a sale over the counter in the office/shop. Distinct from 'dispatch',
  // which fulfils an order that already exists in ClubOS: a counter sale has no
  // order behind it, the customer is standing there, and the movement IS the
  // whole record of it.
  "sale",
  // D19 — an asset leaves service. Its instance keeps every row it ever wrote.
  "decommission",
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
  sale: "Counter sale",
  decommission: "Decommission",
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
  // A physical count putting real numbers against what the shelf actually
  // holds. Distinct from 'count_variance', which is the audited blind-count
  // flow's discrepancy — this is somebody walking the racks with a scanner.
  "stock_take",
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
  stock_take: "Stock take",
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
  // D21 — a shirt in someone's car boot or issued to a coach is out of the
  // building. Counting custody stock as available is how a shop oversells.
  if (isCustodyLocation(location.kind)) return false;
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

/**
 * The requisition workflow (D13) — unlike a PO's free-form status field
 * (any value is directly PATCHable, gated only by the receiving-history
 * delete guard), a requisition's whole point is that stock can't leave the
 * building without a real approve/decline decision, so every status change
 * is validated against this graph server-side rather than accepted verbatim
 * from a client. `declined` is reachable from every non-terminal state (an
 * operator can abort even mid-pick — e.g. discovering the last unit is
 * damaged) except `ready`, where the physical stock has already been pulled
 * and staged — declining is no longer meaningful and the resolution is
 * `collected` (or an operator manually restocking via an adjustment, outside
 * this workflow).
 */
export const REQUISITION_TRANSITIONS: Record<RequisitionStatus, readonly RequisitionStatus[]> = {
  submitted: ["approved", "declined"],
  approved: ["picking", "declined"],
  picking: ["ready", "declined"],
  ready: ["collected"],
  collected: [],
  declined: [],
};

export function isValidRequisitionTransition(from: RequisitionStatus, to: RequisitionStatus): boolean {
  return REQUISITION_TRANSITIONS[from]?.includes(to) ?? false;
}

/** A requisition can only move to `ready` (staged for collection) once every
 *  line has actually been picked in full — otherwise "ready" would lie to
 *  the requester about what's waiting for them at the collection point. */
export function allRequisitionLinesPicked(lines: readonly { qtyRequested: number; qtyPicked: number }[]): boolean {
  return lines.every((l) => l.qtyPicked >= l.qtyRequested);
}

/**
 * Recomputes a requisition's status from its lines' picked totals — the D13
 * sibling of `derivePoStatusFromLines` (T6) one level up: the dispatch route
 * (server/warehouse-routes.ts) calls this after every pick movement so the
 * ledger's own activity trail — not a client-supplied status — is what
 * drives `approved`→`picking`→`ready`. `approve`/`decline`/`collect` stay
 * explicit human decisions (gated by `isValidRequisitionTransition` at their
 * own routes); this function only ever reacts to REAL picking evidence.
 *
 * Never touches `submitted` (nothing should be pickable before approval —
 * enforced by the dispatch route's own status gate) or a terminal state.
 * A requisition that goes from fully unpicked to fully picked in a SINGLE
 * dispatch call (e.g. a one-line requisition picked in one scan) skips
 * straight from `approved` to `ready` — there's no meaningful moment it sat
 * "mid-pick" to persist separately, and `REQUISITION_TRANSITIONS` governs
 * discrete human-facing actions, not this evidence-derived computation (the
 * evidence — every line's own `qtyPicked` — is the thing that makes the jump
 * honest, the same way `allRequisitionLinesPicked` is the thing that makes
 * an explicit "ready" claim honest).
 */
export function deriveRequisitionStatusFromLines(
  current: RequisitionStatus,
  lines: readonly { qtyRequested: number; qtyPicked: number }[],
): RequisitionStatus {
  if (current !== "approved" && current !== "picking") return current;
  if (lines.length === 0) return current;
  if (allRequisitionLinesPicked(lines)) return "ready";
  const anyPicked = lines.some((l) => l.qtyPicked > 0);
  return anyPicked ? "picking" : current;
}

// ── Chargeback report (T9) ───────────────────────────────────────────────────

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `YYYY-MM` — the chargeback report's period key. Deliberately narrower than
 *  `isValidDateOnly`'s `YYYY-MM-DD` (a chargeback bills a whole month, never
 *  a day), so the two are kept as separate validators rather than one sharing
 *  a truncation trick that would accept `2026-13-01` as `"2026-13"`. */
export function isValidMonth(v: unknown): v is string {
  return typeof v === "string" && MONTH_RE.test(v);
}

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

// ── Equipment loans: check-out / return (T10) ────────────────────────────────
// wh_loan_lines has no stored "returned" flag — `condition_grade` is set ONLY
// on return (schema.ts's own comment on the table), so its presence IS the
// derived per-line signal, the same "derived, never a second stored flag"
// doctrine as qty_received/qty_picked one level down at the LINE grain rather
// than the whole-record STATUS grain those two drive.

/** Has this specific loan line already come back? */
export function loanLineIsReturned(line: { conditionGrade: ConditionGrade | null | undefined }): boolean {
  return line.conditionGrade != null;
}

/** Every line of the loan graded on return — LOAN_STATUSES has no partial
 *  state (unlike PO/requisition's multi-step workflows, a loan is only ever
 *  'out' or 'returned'), so a loan with 3 lines and 2 returned stays 'out'
 *  until the last one comes back too. An empty line list is never "returned"
 *  (there's nothing to have returned). */
export function allLoanLinesReturned(lines: readonly { conditionGrade: ConditionGrade | null | undefined }[]): boolean {
  return lines.length > 0 && lines.every((l) => loanLineIsReturned(l));
}

/**
 * Recomputes a loan's stored `status` from its lines' own condition grades —
 * the D14 sibling of derivePoStatusFromLines (T6) / deriveRequisitionStatus-
 * FromLines (T9) one level up. Never touches an already-'returned' loan
 * (terminal — a loan can't be "un-returned"; borrowing the same gear again is
 * a brand-new wh_loans row, a fresh checkout).
 */
export function deriveLoanStatusFromLines(
  current: LoanStatus,
  lines: readonly { conditionGrade: ConditionGrade | null | undefined }[],
): LoanStatus {
  if (current !== "out") return current;
  return allLoanLinesReturned(lines) ? "returned" : "out";
}

/**
 * A 'D' grade (scrap, write off) return is tagged with the EXISTING
 * 'write_off' reason code (D15) on its loan_return ledger leg — this is not a
 * new disposition/routing rule like receiving's automatic QUARANTINE routing
 * for genuinely damaged stock (T6/dispositionForReason); WHERE a returned
 * item physically goes (a normal bin, QUARANTINE, wherever) stays the
 * operator's own choice of locationId, exactly like every other movement leg
 * in this file. This only decides the ledger's reason_code so a written-off
 * loan return is searchable/auditable by reason like any other write-off.
 */
export function reasonCodeForConditionGrade(grade: ConditionGrade): ReasonCode | null {
  return grade === "D" ? "write_off" : null;
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

/** Strictly linear (open -> submitted -> approved, no reopen/decline branch)
 *  — unlike REQUISITION_TRANSITIONS there's no alternate path, but the same
 *  explicit-graph shape is kept for consistency and so a future admin UI can
 *  ask "what can this session do next" the same way it asks for requisitions. */
export const COUNT_TRANSITIONS: Record<CountStatus, readonly CountStatus[]> = {
  open: ["submitted"],
  submitted: ["approved"],
  approved: [],
};
export function isValidCountTransition(from: CountStatus, to: CountStatus): boolean {
  return COUNT_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Blind counting (D12) only means something WHILE the session is in
 * progress — a counter entering figures must never see expected_qty, but
 * once a session is `approved` the whole point is a transparent audit trail,
 * so expected_qty (and the variance it implies) is shown freely. A
 * non-blind session (`blind:false`, an explicit choice at creation) never
 * hides it at all — that is what "not blind" means.
 */
export function shouldHideExpectedQty(blind: boolean, status: CountStatus): boolean {
  return blind && status !== "approved";
}

/** Turns the raw variance check into the line's STORED `resolution` (D12) —
 *  the one place that decision is made, so the count-entry route and any
 *  future recount UI always agree on what a variance means. */
export function countLineResolution(
  expectedQty: number,
  countedQty: number,
  unitCostCents?: number | null,
): CountLineResolution {
  return countLineNeedsRecount(expectedQty, countedQty, unitCostCents) ? "recount" : "accepted";
}

/** The signed quantity change an approved count line turns into on the
 *  ledger (D12: "approved variance posts an adjustment movement") — counted
 *  minus expected, in the same direction postMovementGroup's `delta` already
 *  expects. Zero means the count simply confirmed what was on record — no
 *  movement gets posted for that line at all (see buildCountAdjustmentLegs). */
export function countLineVarianceQty(expectedQty: number, countedQty: number): number {
  return countedQty - expectedQty;
}

/** The approval guard D12 asks for by name — "counter ≠ approver" — plus the
 *  status-chain check (isValidCountTransition), folded into one call so a
 *  route only has to ask ONE question to know whether an approve attempt is
 *  allowed. Enforced app-side (both columns are the same `users` FK — a
 *  same-table CHECK can't express "these two columns must differ" here any
 *  more than it could elsewhere in this schema). A session nobody was ever
 *  assigned to count (`countedBy` null) has no counter to conflict with, so
 *  any operator may approve it. */
export function canApproveCount(
  count: { status: CountStatus; countedBy: number | null },
  approverUserId: number,
): boolean {
  if (!isValidCountTransition(count.status, "approved")) return false;
  if (count.countedBy != null && count.countedBy === approverUserId) return false;
  return true;
}

/** Input to the approval step (server/warehouse-routes.ts's counts/:id/
 *  approve) — one row per counted line: what loadCountLines already projects
 *  plus the item's own allowNegative (D16) for the movement guard. */
export interface CountLineForApproval {
  itemId: number;
  locationId: number;
  locationCode: string;
  expectedQty: number;
  countedQty: number | null;
  allowNegative: boolean;
}

/**
 * D12's "approved variance posts an adjustment movement" turned into the
 * legs postMovementGroup needs — one per line whose count genuinely differs
 * from what was expected (delta = counted − expected), skipping any line
 * that matched exactly (nothing to correct) or was never actually counted
 * (shouldn't be reachable post-submit — the submit endpoint requires every
 * line counted first — but a missing count must never be silently treated
 * as "0 variance" rather than simply excluded). Returns the SAME shape as
 * buildLocationMoveLegs's `LocationMoveLeg` (no per-leg reasonCode override
 * needed — the whole adjustment group shares one reason, 'count_variance',
 * set once at the group level by the caller) rather than inventing a
 * near-duplicate type.
 */
export function buildCountAdjustmentLegs(lines: CountLineForApproval[]): LocationMoveLeg[] {
  const legs: LocationMoveLeg[] = [];
  for (const l of lines) {
    if (l.countedQty === null) continue;
    const delta = countLineVarianceQty(l.expectedQty, l.countedQty);
    if (delta === 0) continue;
    legs.push({ itemId: l.itemId, locationId: l.locationId, locationCode: l.locationCode, delta, allowNegative: l.allowNegative });
  }
  return legs;
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
export function scanActionsForItem(item: { isLoanable: boolean; trackingMode?: TrackingMode }): MovementType[] {
  // An asset is moved as a named object, never as a quantity — its actions
  // come from scanActionsForInstance once a specific unit is identified.
  // Scanning the DEFINITION of an asset (rather than one unit's tag) offers
  // nothing to post; the UI sends the operator to the instance list instead.
  if (item.trackingMode === "asset") return [];
  const actions: MovementType[] = ["putaway", "pick", "dispatch", "transfer", "consume", "sale"];
  if (item.isLoanable) actions.push("loan_out", "loan_return");
  return actions;
}

/** The action sheet once a scan resolves to ONE physical asset (D19). No
 *  pick/dispatch/sale: assets are not sold over the counter, they are moved,
 *  lent, and eventually retired. */
export function scanActionsForInstance(instance: {
  condition: InstanceCondition;
  isLoanable: boolean;
}): MovementType[] {
  // A decommissioned unit is history. Offering to move it would let a retired
  // press quietly reappear on the floor.
  if (instance.condition === "decommissioned") return [];
  const actions: MovementType[] = ["transfer", "decommission"];
  if (instance.isLoanable) actions.push("loan_out", "loan_return");
  return actions;
}

/** Same advisory list once a code resolves to a LOCATION. A virtual
 *  location (SUPPLIER/CUSTOMER/SCRAP/PRODUCTION) has no printed label
 *  anyone would ever scan — it's chosen from a dropdown as one leg of a
 *  receipt/dispatch/write-off, never walked to with a trolley — so scanning
 *  one offers nothing. A real bin/zone offers the full set. */
export function scanActionsForLocation(location: { kind: LocationKind }): MovementType[] {
  if (location.kind === "virtual") return [];
  // D20 — you cannot "put stock away" into a person or a van; things get
  // there by being transferred, and go back the same way. Counting what
  // someone is holding is exactly the audit that makes custody locations
  // worth having, so it stays.
  if (isCustodyLocation(location.kind)) return ["transfer", "count"];
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

// ── Pick queue + dispatch (T8) ──────────────────────────────────────────────
// Three places stock can be promised to leave the building, unified behind
// one dispatch endpoint (server/warehouse-routes.ts): a paid **native** shop
// order (this app's own commerce engine — shop_orders/shop_order_items), a
// **Shopify** order (we hold NO local order row for these at all — Shopify is
// the order's system of record, so the ONLY local trace is an active
// wh_reservations row with ref_kind='shopify_order', created by T12's future
// webhook path or T5's manual reservation endpoint today), or an approved
// staff **requisition** (D13 — never carries a wh_reservations row at all,
// their trail is movements-only, so a 'requisition' dispatch skips the
// reserve/consume path entirely and posts a plain 'pick' movement instead).
// This just discriminates which shape a dispatch request body carries — the
// three flows share nothing else in common at the pure-logic level (unlike
// putaway/transfer's shared two-leg shape), so there's no equivalent
// "buildXLegs" helper here.
export const DISPATCH_SOURCE_KINDS = ["shop_order", "shopify_order", "requisition"] as const;
export type DispatchSourceKind = (typeof DISPATCH_SOURCE_KINDS)[number];
export function isDispatchSourceKind(v: unknown): v is DispatchSourceKind {
  return typeof v === "string" && (DISPATCH_SOURCE_KINDS as readonly string[]).includes(v);
}

/** Once every WMS-mapped item on a native shop order has been dispatched,
 *  the order advances past 'paid' into the existing fulfilment pipeline
 *  (server/shop-routes.ts's ADMIN_SETTABLE_STATUSES) — 'shipped' when its
 *  shipping option requires a delivery address, 'ready_for_pickup'
 *  otherwise (no shipping option at all, or a pickup-style option). */
export function nextOrderStatusAfterDispatch(shippingRequiresAddress: boolean | null | undefined): "shipped" | "ready_for_pickup" {
  return shippingRequiresAddress ? "shipped" : "ready_for_pickup";
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

// ── Channel sync (T12/§4.3) ─────────────────────────────────────────────────
// Two Shopify stores hold WMS-mapped inventory (D9) — the enum-ish `store`
// column on wh_items/wh_shopify_variant_links/wh_shopify_events/
// wh_sync_state, validated here per the house rule (no DB CHECKs on open
// value sets) rather than in server/warehouse-sync.ts, since a future T16c
// sync-dashboard page will want the same validator/list client-side. The
// echo-suppression/drift/debounce/fan-out MATH itself is server-only
// reasoning (nothing a client UI needs to recompute) and lives in
// server/warehouse-sync.ts instead, tested by script/test-warehouse-sync.ts —
// same "pure logic in shared only when a client would ever import it" split
// SPEC.md already draws between this file and server/warehouse.ts's engine.

export const SHOPIFY_STORES = ["siu", "cufc"] as const;
export type ShopifyStoreKey = (typeof SHOPIFY_STORES)[number];
export function isShopifyStoreKey(v: unknown): v is ShopifyStoreKey {
  return typeof v === "string" && (SHOPIFY_STORES as readonly string[]).includes(v);
}

/** wh_sync_state.store is one of these three — a mapped item's native (own
 *  commerce engine) push state and its Shopify push state are tracked as
 *  separate rows even when an item somehow had both (it never does today,
 *  but nothing stops it structurally). */
export const SYNC_STORES = ["siu", "cufc", "native"] as const;
export type SyncStore = (typeof SYNC_STORES)[number];
export function isSyncStore(v: unknown): v is SyncStore {
  return typeof v === "string" && (SYNC_STORES as readonly string[]).includes(v);
}

// ── Asset tags (D19) ─────────────────────────────────────────────────────────
// The label we print and stick on a physical asset. Prefixed for the same
// reason locations are: a scan must resolve to exactly one KIND of thing, and
// an unprefixed tag could otherwise collide with a SKU or a supplier EAN.

export const INSTANCE_BARCODE_PREFIX = "AST:";

export function instanceBarcodePayload(assetTag: string): string {
  return `${INSTANCE_BARCODE_PREFIX}${assetTag}`;
}

/** Mirrors stripLocationPrefix: an `AST:`-prefixed code is an asset tag and
 *  nothing else, so a miss is "unknown" rather than falling through to a SKU
 *  lookup that might match something unrelated. */
export function stripInstancePrefix(code: string): { isInstanceCode: boolean; code: string } {
  const trimmed = code.trim();
  if (trimmed.toUpperCase().startsWith(INSTANCE_BARCODE_PREFIX)) {
    return { isInstanceCode: true, code: normaliseAssetTag(trimmed.slice(INSTANCE_BARCODE_PREFIX.length)) };
  }
  return { isInstanceCode: false, code: trimmed };
}

/** Uppercased and trimmed — we own this format, so unlike a manufacturer's
 *  serial it is normalised on the way in and looked up normalised. */
export function normaliseAssetTag(tag: string): string {
  return tag.trim().toUpperCase();
}

/** Suggested tag for a new instance: the item's SKU plus a zero-padded
 *  sequence, e.g. `UP-PRESS-A3` unit 7 → `UP-PRESS-A3-007`. Only a suggestion
 *  — an asset already carrying an employer's or supplier's own asset label
 *  should keep it, so nothing here is enforced. */
export function suggestAssetTag(sku: string, sequence: number): string {
  return `${normaliseSku(sku)}-${String(sequence).padStart(3, "0")}`;
}

// ── Custom fields (D22–D24) ──────────────────────────────────────────────────
// Admin-editable schema-in-data. Adding, reordering or removing a field on a
// category changes what renders on the item card with no migration and no
// developer — which is the whole reason the table exists. The typed columns
// are what make it more than a notes box: "every WOF expiring this month" has
// to be an indexed date comparison in Postgres.

export const FIELD_TYPES = ["text", "number", "date", "select", "boolean"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  select: "Choose from a list",
  boolean: "Yes / no",
};
export function isFieldType(v: unknown): v is FieldType {
  return typeof v === "string" && (FIELD_TYPES as readonly string[]).includes(v);
}

/** D22 — does a field describe the DEFINITION ("vinyl width", true of every
 *  roll) or ONE physical unit ("WOF expiry", true of one van)? The source
 *  spec put custom fields on items only, but its own worked example is
 *  per-instance, so both are supported and the author chooses per field. */
export const FIELD_APPLIES_TO = ["item", "instance"] as const;
export type FieldAppliesTo = (typeof FIELD_APPLIES_TO)[number];
export const FIELD_APPLIES_TO_LABELS: Record<FieldAppliesTo, string> = {
  item: "The item (every unit of it)",
  instance: "Each unit on its own",
};
export function isFieldAppliesTo(v: unknown): v is FieldAppliesTo {
  return typeof v === "string" && (FIELD_APPLIES_TO as readonly string[]).includes(v);
}

/** The typed column a value of this type is written to and read from (D24).
 *  ONE mapping shared by the server writer, the server reader and the client
 *  form, so a value can never be written to value_text and then looked for in
 *  value_date. 'select' stores its chosen option as text. */
export const FIELD_TYPE_COLUMN: Record<FieldType, "valueText" | "valueNumber" | "valueDate" | "valueBoolean"> = {
  text: "valueText",
  number: "valueNumber",
  date: "valueDate",
  select: "valueText",
  boolean: "valueBoolean",
};

const FIELD_KEY_MAX_LEN = 40;

/** Slugified from the label once, at creation, and then frozen: the key is
 *  what every stored value is filed under, so renaming a label must never
 *  orphan the data already sitting behind it. */
export function slugifyFieldKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, FIELD_KEY_MAX_LEN);
}

export function isValidFieldKey(key: unknown): boolean {
  if (typeof key !== "string") return false;
  const k = key.trim();
  if (!k || k.length > FIELD_KEY_MAX_LEN) return false;
  return /^[a-z0-9]+(_[a-z0-9]+)*$/.test(k);
}

export interface FieldTemplateLike {
  fieldKey: string;
  label: string;
  fieldType: FieldType;
  options?: string[] | null;
  required: boolean;
}

/** The four typed slots, exactly one of which a coerced value occupies. */
export interface TypedFieldValue {
  valueText: string | null;
  valueNumber: number | null;
  valueDate: string | null;
  valueBoolean: boolean | null;
}

export const EMPTY_FIELD_VALUE: TypedFieldValue = {
  valueText: null,
  valueNumber: null,
  valueDate: null,
  valueBoolean: null,
};

export type FieldCoercion = { ok: true; value: TypedFieldValue } | { ok: false; error: string };

/**
 * Validates one submitted value against its template and places it in the
 * right typed column. Blank is blank for every type — a required field
 * rejects it, an optional one clears the row rather than storing "".
 *
 * `select` checks membership against the template's own option list, so a
 * value removed from the list can no longer be chosen (already-stored values
 * are left alone — rewriting history to match an edited dropdown would be
 * worse than showing a stale one).
 */
export function coerceFieldValue(template: FieldTemplateLike, raw: unknown): FieldCoercion {
  const blank = raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");

  if (blank) {
    if (template.required) return { ok: false, error: `${template.label} is required` };
    return { ok: true, value: { ...EMPTY_FIELD_VALUE } };
  }

  switch (template.fieldType) {
    case "text":
      return { ok: true, value: { ...EMPTY_FIELD_VALUE, valueText: String(raw).trim() } };

    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return { ok: false, error: `${template.label} must be a number` };
      return { ok: true, value: { ...EMPTY_FIELD_VALUE, valueNumber: n } };
    }

    case "date": {
      const s = String(raw).trim();
      if (!isValidDateOnly(s)) return { ok: false, error: `${template.label} must be a date (YYYY-MM-DD)` };
      return { ok: true, value: { ...EMPTY_FIELD_VALUE, valueDate: s } };
    }

    case "select": {
      const s = String(raw).trim();
      const options = template.options ?? [];
      if (options.length === 0) return { ok: false, error: `${template.label} has no options set up yet` };
      if (!options.includes(s)) return { ok: false, error: `${template.label} must be one of: ${options.join(", ")}` };
      return { ok: true, value: { ...EMPTY_FIELD_VALUE, valueText: s } };
    }

    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: { ...EMPTY_FIELD_VALUE, valueBoolean: raw } };
      const s = String(raw).trim().toLowerCase();
      if (["true", "yes", "1"].includes(s)) return { ok: true, value: { ...EMPTY_FIELD_VALUE, valueBoolean: true } };
      if (["false", "no", "0"].includes(s)) return { ok: true, value: { ...EMPTY_FIELD_VALUE, valueBoolean: false } };
      return { ok: false, error: `${template.label} must be yes or no` };
    }
  }
}

/** Pulls the populated slot back out for display. Returns null for a value
 *  that was never set — distinct from `false` on a boolean field, which is a
 *  real answer somebody gave. */
export function readFieldValue(fieldType: FieldType, stored: Partial<TypedFieldValue>): string | number | boolean | null {
  switch (FIELD_TYPE_COLUMN[fieldType]) {
    case "valueNumber":
      return stored.valueNumber ?? null;
    case "valueDate":
      return stored.valueDate ?? null;
    case "valueBoolean":
      return stored.valueBoolean ?? null;
    default:
      return stored.valueText ?? null;
  }
}

/** Every required field on a template set that has no value yet. Drives the
 *  item card's "incomplete" badge — an asset nobody has finished describing
 *  is a known gap, which is more useful than a form that silently passes. */
export function missingRequiredFields(
  templates: FieldTemplateLike[],
  values: Record<string, Partial<TypedFieldValue> | undefined>,
): string[] {
  return templates
    .filter((t) => t.required)
    .filter((t) => readFieldValue(t.fieldType, values[t.fieldKey] ?? {}) === null)
    .map((t) => t.label);
}
