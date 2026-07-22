// Pure-logic tests for shared/warehouse.ts.  Run: npx tsx script/test-warehouse-shared.ts
import assert from "node:assert/strict";
import {
  ITEM_KINDS, isItemKind,
  BRAND_OWNERS, isBrandOwner,
  UNITS, isUnit,
  LOCATION_KINDS, isLocationKind,
  NAMED_ZONES, VIRTUAL_LOCATION_CODES, QUARANTINE_ZONE,
  isValidLocationCode, normaliseLocationCode,
  deriveLocationZone, LOCATION_BARCODE_PREFIX, locationBarcodePayload,
  normaliseSku, isValidSku,
  normaliseAliasCode,
  MOVEMENT_TYPES, isMovementType, MOVEMENT_TYPE_LABELS,
  REASON_CODES, isReasonCode, REASON_CODE_LABELS,
  DISPOSITIONS, isDisposition, dispositionForReason,
  isSellableLocation,
  REF_KINDS, isRefKind,
  RESERVATION_STATUSES, isReservationStatus,
  PO_STATUSES, isPoStatus,
  isValidDateOnly,
  computeReceiveDiscrepancy, receiveDiscrepancyNote, derivePoStatusFromLines,
  REQUISITION_STATUSES, isRequisitionStatus, REQUISITION_TERMINAL_STATUSES,
  LOAN_STATUSES, isLoanStatus,
  CONDITION_GRADES, isConditionGrade,
  isLoanOverdue,
  COUNT_STATUSES, isCountStatus,
  COUNT_LINE_RESOLUTIONS, isCountLineResolution,
  COUNT_VARIANCE_PERCENT_THRESHOLD, COUNT_VARIANCE_CENTS_THRESHOLD,
  countLineNeedsRecount,
  availableQty, wouldGoNegative, legsSumToZero,
  stripLocationPrefix, scanActionsForItem, scanActionsForLocation,
  scanQuantityToUnits, buildLocationMoveLegs,
} from "../shared/warehouse";

let passed = 0;
function ok(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e: any) { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// ── Item kinds ────────────────────────────────────────────────────────────
ok("four item kinds", () => assert.equal(ITEM_KINDS.length, 4));
ok("merch is a kind", () => assert.equal(isItemKind("merch"), true));
ok("junk kind rejected", () => assert.equal(isItemKind("widget"), false));
ok("non-string kind rejected", () => assert.equal(isItemKind(1), false));

// ── Brand owners ──────────────────────────────────────────────────────────
ok("six brand owners", () => assert.equal(BRAND_OWNERS.length, 6));
ok("siu is an owner", () => assert.equal(isBrandOwner("siu"), true));
ok("junk owner rejected", () => assert.equal(isBrandOwner("nike"), false));

// ── Units ─────────────────────────────────────────────────────────────────
ok("four units", () => assert.equal(UNITS.length, 4));
ok("roll is a unit", () => assert.equal(isUnit("roll"), true));
ok("junk unit rejected", () => assert.equal(isUnit("kg"), false));

// ── Location kinds / zones ────────────────────────────────────────────────
ok("three location kinds", () => assert.equal(LOCATION_KINDS.length, 3));
ok("bin is a location kind", () => assert.equal(isLocationKind("bin"), true));
ok("junk location kind rejected", () => assert.equal(isLocationKind("shelf"), false));
ok("four named zones", () => assert.equal(NAMED_ZONES.length, 4));
ok("four virtual location codes", () => assert.equal(VIRTUAL_LOCATION_CODES.length, 4));
ok("quarantine zone constant", () => assert.equal(QUARANTINE_ZONE, "QUARANTINE"));

// ── Location codes (D8) ───────────────────────────────────────────────────
ok("virtual code SUPPLIER valid", () => assert.equal(isValidLocationCode("SUPPLIER"), true));
ok("bare named zone RECEIVING valid", () => assert.equal(isValidLocationCode("RECEIVING"), true));
ok("shallow bin A-01-2 valid", () => assert.equal(isValidLocationCode("A-01-2"), true));
ok("deeper bin RECEIVING-01-1-3 valid", () => assert.equal(isValidLocationCode("RECEIVING-01-1-3"), true));
ok("single segment (not a virtual/zone) invalid", () => assert.equal(isValidLocationCode("A"), false));
ok("too many segments invalid", () => assert.equal(isValidLocationCode("A-01-2-3-4"), false));
ok("lowercase segment invalid", () => assert.equal(isValidLocationCode("a-01-2"), false));
ok("empty string invalid", () => assert.equal(isValidLocationCode(""), false));
ok("whitespace-only invalid", () => assert.equal(isValidLocationCode("   "), false));
ok("non-string invalid", () => assert.equal(isValidLocationCode(123), false));
ok("normalise trims + uppercases", () => assert.equal(normaliseLocationCode(" a-01-2 "), "A-01-2"));

ok("zone: a bin code zones to its first segment", () => assert.equal(deriveLocationZone("A-01-2", "bin"), "A"));
ok("zone: a deep bin still zones to its first segment", () => assert.equal(deriveLocationZone("RECEIVING-01-1-3", "bin"), "RECEIVING"));
ok("zone: a bare named zone is its own zone", () => assert.equal(deriveLocationZone("RECEIVING", "zone"), "RECEIVING"));
ok("zone: a virtual location has no zone", () => assert.equal(deriveLocationZone("SUPPLIER", "virtual"), null));
ok("LOCATION_BARCODE_PREFIX is 'LOC:'", () => assert.equal(LOCATION_BARCODE_PREFIX, "LOC:"));
ok("locationBarcodePayload prefixes the code", () => assert.equal(locationBarcodePayload("A-01-2"), "LOC:A-01-2"));
ok("locationBarcodePayload works for a virtual/zone code too", () => assert.equal(locationBarcodePayload("QUARANTINE"), "LOC:QUARANTINE"));

// ── SKUs (D7) ─────────────────────────────────────────────────────────────
ok("normalise uppercases and dashes", () => assert.equal(normaliseSku("mfl kit  home_M"), "MFL-KIT-HOME-M"));
ok("normalise strips illegal chars", () => assert.equal(normaliseSku("SIU#SHIRT@2026!"), "SIUSHIRT2026"));
ok("normalise collapses repeated dashes", () => assert.equal(normaliseSku("A--B---C"), "A-B-C"));
ok("normalise strips leading/trailing dash", () => assert.equal(normaliseSku("-A-B-"), "A-B"));
ok("normalise truncates to 20 chars", () => {
  const long = "A".repeat(30);
  assert.equal(normaliseSku(long).length, 20);
});
ok("valid SKU accepted", () => assert.equal(isValidSku("MFL-KIT-HOME-GOLD-M"), true));
ok("SKU over 20 chars rejected", () => assert.equal(isValidSku("A".repeat(21)), false));
ok("SKU with lowercase rejected", () => assert.equal(isValidSku("mfl-kit"), false));
ok("SKU with double dash rejected", () => assert.equal(isValidSku("MFL--KIT"), false));
ok("SKU with leading dash rejected", () => assert.equal(isValidSku("-MFL-KIT"), false));
ok("empty SKU rejected", () => assert.equal(isValidSku(""), false));
ok("non-string SKU rejected", () => assert.equal(isValidSku(42), false));

// ── Barcode aliases ───────────────────────────────────────────────────────
ok("alias code only trims, does not reshape", () => assert.equal(normaliseAliasCode("  9312345678901 "), "9312345678901"));
ok("alias code preserves case/format (not a SKU)", () => assert.equal(normaliseAliasCode("abc-123_XYZ"), "abc-123_XYZ"));

// ── Movement taxonomy (D15) ───────────────────────────────────────────────
ok("eleven movement types", () => assert.equal(MOVEMENT_TYPES.length, 11));
ok("receipt is a movement type", () => assert.equal(isMovementType("receipt"), true));
ok("junk movement type rejected", () => assert.equal(isMovementType("teleport"), false));
ok("every movement type has a label", () => {
  for (const t of MOVEMENT_TYPES) assert.ok(MOVEMENT_TYPE_LABELS[t], `missing label for ${t}`);
});

ok("seven reason codes", () => assert.equal(REASON_CODES.length, 7));
ok("damaged is a reason code", () => assert.equal(isReasonCode("damaged"), true));
ok("junk reason code rejected", () => assert.equal(isReasonCode("lost_in_space"), false));
ok("every reason code has a label", () => {
  for (const r of REASON_CODES) assert.ok(REASON_CODE_LABELS[r], `missing label for ${r}`);
});

// ── Dispositions (derived from reason, not stored) ───────────────────────
ok("two dispositions", () => assert.equal(DISPOSITIONS.length, 2));
ok("on_hand is a disposition", () => assert.equal(isDisposition("on_hand"), true));
ok("junk disposition rejected", () => assert.equal(isDisposition("lost"), false));
ok("damaged routes to quarantine (unavailable)", () => assert.equal(dispositionForReason("damaged"), "unavailable"));
ok("shrinkage routes to quarantine (unavailable)", () => assert.equal(dispositionForReason("shrinkage"), "unavailable"));
ok("sample consumes outright (on_hand disposition, not quarantine)", () => assert.equal(dispositionForReason("sample"), "on_hand"));
ok("store_use consumes outright", () => assert.equal(dispositionForReason("store_use"), "on_hand"));
ok("event_use consumes outright", () => assert.equal(dispositionForReason("event_use"), "on_hand"));
ok("no reason defaults on_hand", () => assert.equal(dispositionForReason(null), "on_hand"));
ok("undefined reason defaults on_hand", () => assert.equal(dispositionForReason(undefined), "on_hand"));

// ── Sellable locations ────────────────────────────────────────────────────
ok("a bin is sellable", () => assert.equal(isSellableLocation({ code: "A-01-2", kind: "bin" }), true));
ok("a virtual location is never sellable", () => assert.equal(isSellableLocation({ code: "SUPPLIER", kind: "virtual" }), false));
ok("QUARANTINE zone is not sellable", () => assert.equal(isSellableLocation({ code: "QUARANTINE", kind: "zone" }), false));
ok("QUARANTINE not sellable regardless of case", () => assert.equal(isSellableLocation({ code: "quarantine", kind: "zone" }), false));
ok("RECEIVING zone is sellable-ish (not excluded)", () => assert.equal(isSellableLocation({ code: "RECEIVING", kind: "zone" }), true));

// ── Ref kinds ─────────────────────────────────────────────────────────────
ok("seven ref kinds", () => assert.equal(REF_KINDS.length, 7));
ok("requisition is a ref kind", () => assert.equal(isRefKind("requisition"), true));
ok("junk ref kind rejected", () => assert.equal(isRefKind("invoice"), false));

// ── Reservation statuses ──────────────────────────────────────────────────
ok("three reservation statuses", () => assert.equal(RESERVATION_STATUSES.length, 3));
ok("active is a reservation status", () => assert.equal(isReservationStatus("active"), true));
ok("junk reservation status rejected", () => assert.equal(isReservationStatus("pending"), false));

// ── PO statuses ───────────────────────────────────────────────────────────
ok("six PO statuses", () => assert.equal(PO_STATUSES.length, 6));
ok("sent is a PO status", () => assert.equal(isPoStatus("sent"), true));
ok("junk PO status rejected", () => assert.equal(isPoStatus("shipped"), false));

// ── Dates (YYYY-MM-DD shape only) ─────────────────────────────────────────
ok("plain YYYY-MM-DD accepted", () => assert.equal(isValidDateOnly("2026-07-22"), true));
ok("a Date object is rejected (never round-trip through Date)", () => assert.equal(isValidDateOnly(new Date() as any), false));
ok("a full ISO timestamp is rejected", () => assert.equal(isValidDateOnly("2026-07-22T00:00:00.000Z"), false));
ok("garbage rejected", () => assert.equal(isValidDateOnly("22/07/2026"), false));
ok("empty string rejected", () => assert.equal(isValidDateOnly(""), false));

// ── Receiving (T6) ────────────────────────────────────────────────────────
ok("exact receipt has no over/short", () => {
  const d = computeReceiveDiscrepancy(50, 50, 0);
  assert.equal(d.overQty, 0);
  assert.equal(d.shortQty, 0);
});
ok("over-receipt flagged, no damage", () => {
  const d = computeReceiveDiscrepancy(50, 55, 0);
  assert.equal(d.overQty, 5);
  assert.equal(d.shortQty, 0);
});
ok("short receipt flagged", () => {
  const d = computeReceiveDiscrepancy(50, 40, 0);
  assert.equal(d.overQty, 0);
  assert.equal(d.shortQty, 10);
});
ok("damaged units count toward the total, not as a shortfall", () => {
  const d = computeReceiveDiscrepancy(50, 45, 5);
  assert.equal(d.overQty, 0);
  assert.equal(d.shortQty, 0);
});
ok("damaged units on top of full expected qty are both damaged AND over", () => {
  const d = computeReceiveDiscrepancy(50, 50, 3);
  assert.equal(d.overQty, 3);
  assert.equal(d.qtyDamaged, 3);
});

ok("a clean exact receipt has no discrepancy note", () => {
  assert.equal(receiveDiscrepancyNote(computeReceiveDiscrepancy(50, 50, 0)), null);
});
ok("a damaged-only receipt notes the damage", () => {
  const note = receiveDiscrepancyNote(computeReceiveDiscrepancy(50, 45, 5));
  assert.match(note!, /5 damaged \(quarantined\)/);
});
ok("an over-receipt notes it", () => {
  const note = receiveDiscrepancyNote(computeReceiveDiscrepancy(50, 55, 0));
  assert.match(note!, /5 over expected/);
});
ok("a short receipt notes it", () => {
  const note = receiveDiscrepancyNote(computeReceiveDiscrepancy(50, 40, 0));
  assert.match(note!, /10 short of expected/);
});
ok("a receipt that is both damaged and short notes both", () => {
  const note = receiveDiscrepancyNote(computeReceiveDiscrepancy(50, 30, 5));
  assert.match(note!, /5 damaged \(quarantined\)/);
  assert.match(note!, /15 short of expected/);
});

ok("PO stays draft even if (hypothetically) lines show receipts", () => {
  assert.equal(derivePoStatusFromLines("draft", [{ qtyOrdered: 10, qtyReceived: 10 }]), "draft");
});
ok("cancelled PO never auto-advances", () => {
  assert.equal(derivePoStatusFromLines("cancelled", [{ qtyOrdered: 10, qtyReceived: 10 }]), "cancelled");
});
ok("closed PO never auto-advances", () => {
  assert.equal(derivePoStatusFromLines("closed", [{ qtyOrdered: 10, qtyReceived: 0 }]), "closed");
});
ok("sent PO with nothing received yet stays sent", () => {
  assert.equal(derivePoStatusFromLines("sent", [{ qtyOrdered: 10, qtyReceived: 0 }]), "sent");
});
ok("sent PO with one of two lines received becomes partial", () => {
  assert.equal(
    derivePoStatusFromLines("sent", [
      { qtyOrdered: 10, qtyReceived: 10 },
      { qtyOrdered: 5, qtyReceived: 0 },
    ]),
    "partial",
  );
});
ok("partial PO with every line now fully received becomes received", () => {
  assert.equal(
    derivePoStatusFromLines("partial", [
      { qtyOrdered: 10, qtyReceived: 10 },
      { qtyOrdered: 5, qtyReceived: 5 },
    ]),
    "received",
  );
});
ok("over-received lines still count as fully received", () => {
  assert.equal(derivePoStatusFromLines("sent", [{ qtyOrdered: 10, qtyReceived: 12 }]), "received");
});
ok("a PO with no lines at all never auto-advances", () => {
  assert.equal(derivePoStatusFromLines("sent", []), "sent");
});

// ── Requisition statuses ──────────────────────────────────────────────────
ok("six requisition statuses", () => assert.equal(REQUISITION_STATUSES.length, 6));
ok("submitted is a requisition status", () => assert.equal(isRequisitionStatus("submitted"), true));
ok("junk requisition status rejected", () => assert.equal(isRequisitionStatus("cancelled"), false));
ok("collected + declined are terminal", () => {
  assert.equal(REQUISITION_TERMINAL_STATUSES.has("collected"), true);
  assert.equal(REQUISITION_TERMINAL_STATUSES.has("declined"), true);
});
ok("submitted is not terminal", () => assert.equal(REQUISITION_TERMINAL_STATUSES.has("submitted"), false));

// ── Loan statuses / condition grades ──────────────────────────────────────
ok("two loan statuses", () => assert.equal(LOAN_STATUSES.length, 2));
ok("out is a loan status", () => assert.equal(isLoanStatus("out"), true));
ok("junk loan status rejected", () => assert.equal(isLoanStatus("lost"), false));
ok("four condition grades", () => assert.equal(CONDITION_GRADES.length, 4));
ok("A is a condition grade", () => assert.equal(isConditionGrade("A"), true));
ok("junk condition grade rejected", () => assert.equal(isConditionGrade("E"), false));

ok("a loan out and overdue is overdue", () => {
  assert.equal(isLoanOverdue({ status: "out", dueOn: "2026-07-01" }, "2026-07-22"), true);
});
ok("a loan out but not yet due is not overdue", () => {
  assert.equal(isLoanOverdue({ status: "out", dueOn: "2026-08-01" }, "2026-07-22"), false);
});
ok("a returned loan is never overdue even past due_on", () => {
  assert.equal(isLoanOverdue({ status: "returned", dueOn: "2026-01-01" }, "2026-07-22"), false);
});
ok("due exactly today is not overdue yet", () => {
  assert.equal(isLoanOverdue({ status: "out", dueOn: "2026-07-22" }, "2026-07-22"), false);
});

// ── Cycle counts ──────────────────────────────────────────────────────────
ok("three count statuses", () => assert.equal(COUNT_STATUSES.length, 3));
ok("open is a count status", () => assert.equal(isCountStatus("open"), true));
ok("junk count status rejected", () => assert.equal(isCountStatus("draft"), false));
ok("two count line resolutions", () => assert.equal(COUNT_LINE_RESOLUTIONS.length, 2));
ok("accepted is a resolution", () => assert.equal(isCountLineResolution("accepted"), true));
ok("junk resolution rejected", () => assert.equal(isCountLineResolution("ignored"), false));
ok("variance thresholds match D12 (10%, $100)", () => {
  assert.equal(COUNT_VARIANCE_PERCENT_THRESHOLD, 0.1);
  assert.equal(COUNT_VARIANCE_CENTS_THRESHOLD, 10_000);
});

ok("exact match never needs a recount", () => assert.equal(countLineNeedsRecount(50, 50, 500), false));
ok("small variance under both thresholds does not need a recount", () => {
  // diff 1 of 50 = 2% (< 10%); 1 * 500c = $5 (< $100)
  assert.equal(countLineNeedsRecount(50, 49, 500), false);
});
ok("relative variance over 10% needs a recount", () => {
  // diff 6 of 50 = 12% (> 10%), even with no cost
  assert.equal(countLineNeedsRecount(50, 44, null), true);
});
ok("absolute variance over $100 needs a recount even with small percent", () => {
  // diff 3 of 1000 = 0.3% (< 10%) but 3 * 5000c = $150 (> $100)
  assert.equal(countLineNeedsRecount(1000, 997, 5000), true);
});
ok("a missing unit cost never silently reads as $0 variance — only the percent rule applies", () => {
  // diff 1 of 1000 = 0.1% (< 10%), no cost on file → cannot apply dollar rule → no recount
  assert.equal(countLineNeedsRecount(1000, 999, null), false);
  assert.equal(countLineNeedsRecount(1000, 999, undefined), false);
});
ok("expected zero falls back to 100% relative variance on any diff", () => {
  assert.equal(countLineNeedsRecount(0, 1, null), true);
});
ok("expected zero and counted zero is no variance", () => assert.equal(countLineNeedsRecount(0, 0, 500), false));

// ── Stock math ────────────────────────────────────────────────────────────
ok("available = on_hand - reserved", () => assert.equal(availableQty(10, 3), 7));
ok("available can go negative and is not clamped", () => assert.equal(availableQty(2, 5), -3));
ok("available with zero reserved equals on_hand", () => assert.equal(availableQty(10, 0), 10));

ok("a negative delta that empties the bin exactly is fine", () => assert.equal(wouldGoNegative(5, -5, false), false));
ok("a negative delta that overdraws the bin is blocked", () => assert.equal(wouldGoNegative(5, -6, false), true));
ok("a positive delta never goes negative", () => assert.equal(wouldGoNegative(0, 3, false), false));
ok("allow_negative bypasses the guard entirely", () => assert.equal(wouldGoNegative(5, -100, true), false));

ok("transfer legs summing to zero pass", () => assert.equal(legsSumToZero([-5, 5]), true));
ok("multi-leg group summing to zero passes", () => assert.equal(legsSumToZero([-10, 4, 6]), true));
ok("legs that do not sum to zero fail", () => assert.equal(legsSumToZero([-5, 4]), false));
ok("a single non-zero leg fails (not a transfer)", () => assert.equal(legsSumToZero([5]), false));
ok("an empty leg list trivially sums to zero", () => assert.equal(legsSumToZero([]), true));

// ── Scan resolution & location moves (T7) ────────────────────────────────
ok("LOC: prefix is stripped and the remainder normalised", () => {
  assert.deepEqual(stripLocationPrefix("LOC:A-01-2"), { isLocationCode: true, code: "A-01-2" });
});
ok("LOC: prefix is matched case-insensitively, code still normalised", () => {
  assert.deepEqual(stripLocationPrefix("loc:a-01-2 "), { isLocationCode: true, code: "A-01-2" });
});
ok("a code with no LOC: prefix is left as isLocationCode: false, just trimmed", () => {
  assert.deepEqual(stripLocationPrefix("  A-01-2  "), { isLocationCode: false, code: "A-01-2" });
});
ok("an empty code has no prefix either", () => {
  assert.deepEqual(stripLocationPrefix(""), { isLocationCode: false, code: "" });
});

ok("scanActionsForItem: a non-loanable item never offers loan actions", () => {
  const actions = scanActionsForItem({ isLoanable: false });
  assert.deepEqual(actions, ["putaway", "pick", "dispatch", "transfer", "consume"]);
});
ok("scanActionsForItem: a loanable item adds loan_out + loan_return", () => {
  const actions = scanActionsForItem({ isLoanable: true });
  assert.ok(actions.includes("loan_out"));
  assert.ok(actions.includes("loan_return"));
  assert.equal(actions.length, 7);
});

ok("scanActionsForLocation: a virtual location offers nothing (no printed label anyone scans)", () => {
  assert.deepEqual(scanActionsForLocation({ kind: "virtual" }), []);
});
ok("scanActionsForLocation: a bin offers putaway/transfer/count", () => {
  assert.deepEqual(scanActionsForLocation({ kind: "bin" }), ["putaway", "transfer", "count"]);
});
ok("scanActionsForLocation: a zone offers the same set as a bin", () => {
  assert.deepEqual(scanActionsForLocation({ kind: "zone" }), ["putaway", "transfer", "count"]);
});

ok("scanQuantityToUnits: one scan of a non-multiplied alias is one unit", () => {
  assert.equal(scanQuantityToUnits(1, 1), 1);
});
ok("scanQuantityToUnits: a case-of-6 alias scanned 4 times is 24 units", () => {
  assert.equal(scanQuantityToUnits(4, 6), 24);
});
ok("scanQuantityToUnits: zero scans is zero units regardless of pack size", () => {
  assert.equal(scanQuantityToUnits(0, 6), 0);
});

ok("buildLocationMoveLegs: builds an opposite-signed pair carrying the item's allowNegative", () => {
  const legs = buildLocationMoveLegs(
    { id: 1, allowNegative: false },
    { id: 10, code: "A-01-1" },
    { id: 20, code: "A-02-1" },
    5,
  );
  assert.deepEqual(legs, [
    { itemId: 1, locationId: 10, locationCode: "A-01-1", delta: -5, allowNegative: false },
    { itemId: 1, locationId: 20, locationCode: "A-02-1", delta: 5, allowNegative: false },
  ]);
  assert.equal(legsSumToZero(legs.map((l) => l.delta)), true, "a move's own legs must satisfy the transfer invariant");
});
ok("buildLocationMoveLegs: propagates allowNegative: true to both legs", () => {
  const legs = buildLocationMoveLegs({ id: 2, allowNegative: true }, { id: 11, code: "B" }, { id: 21, code: "C" }, 3);
  assert.equal(legs[0].allowNegative, true);
  assert.equal(legs[1].allowNegative, true);
});

console.log(`\n✅ warehouse (shared): ${passed} assertions passed`);
if (process.exitCode) console.error("❌ some assertions failed");
