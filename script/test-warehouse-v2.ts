// Pure-logic tests for Warehouse v2 — asset instances, custody locations and
// self-service custom fields (D18–D25).
// Run: npx tsx script/test-warehouse-v2.ts   (exits non-zero on failure)
//
// Same discipline as script/test-warehouse-engine.ts: no real DB. The instance
// MOVE functions need an open transaction and are exercised end-to-end by the
// route tests; what is tested here is everything that decides whether those
// moves are correct — the taxonomy, the guards, the date maths and the typed
// field coercion, all of which the server, the routes and the client share.

import assert from "node:assert/strict";
import { postMovementGroup, type WarehouseDb, type NewMovementRow, type PostMovementGroupInput } from "../server/warehouse";
import {
  TRACKING_MODES,
  INSTANCE_CONDITIONS,
  FIELD_TYPES,
  FIELD_TYPE_COLUMN,
  LOCATION_KINDS,
  MOVEMENT_TYPES,
  MOVEMENT_TYPE_LABELS,
  LOCATION_KIND_LABELS,
  INSTANCE_CONDITION_LABELS,
  TRACKING_MODE_LABELS,
  isTrackingMode,
  isInstanceCondition,
  isFieldType,
  isFieldAppliesTo,
  isLocationKind,
  isCustodyLocation,
  canChangeTrackingMode,
  instanceCountsAsHeld,
  warrantyStatus,
  addDaysIso,
  isSellableLocation,
  deriveLocationZone,
  scanActionsForItem,
  scanActionsForInstance,
  scanActionsForLocation,
  slugifyFieldKey,
  isValidFieldKey,
  coerceFieldValue,
  readFieldValue,
  missingRequiredFields,
  normaliseAssetTag,
  stripInstancePrefix,
  instanceBarcodePayload,
  suggestAssetTag,
  type FieldTemplateLike,
} from "../shared/warehouse";

let passed = 0;
async function ok(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
  } catch (e: any) {
    console.error(`FAIL: ${name}\n  ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

// ── D18 tracking mode ────────────────────────────────────────────────────────

await ok("tracking modes are exactly stock|asset and every one has a label", () => {
  assert.deepEqual([...TRACKING_MODES], ["stock", "asset"]);
  for (const m of TRACKING_MODES) assert.ok(TRACKING_MODE_LABELS[m], `no label for ${m}`);
  assert.ok(isTrackingMode("asset"));
  assert.ok(!isTrackingMode("assets"));
  assert.ok(!isTrackingMode(undefined));
});

await ok("tracking mode can only change while the item has no history at all", () => {
  assert.ok(canChangeTrackingMode({ movementCount: 0, instanceCount: 0 }));
  // One scan is enough to freeze it — the ledger would otherwise describe
  // quantities with nowhere to live.
  assert.ok(!canChangeTrackingMode({ movementCount: 1, instanceCount: 0 }));
  assert.ok(!canChangeTrackingMode({ movementCount: 0, instanceCount: 1 }));
});

// ── D19 instance conditions ──────────────────────────────────────────────────

await ok("every condition has a label; decommissioned stops counting as held", () => {
  for (const c of INSTANCE_CONDITIONS) assert.ok(INSTANCE_CONDITION_LABELS[c], `no label for ${c}`);
  assert.ok(instanceCountsAsHeld("new"));
  assert.ok(instanceCountsAsHeld("working"));
  // Damaged is still ours — it is in quarantine, not gone.
  assert.ok(instanceCountsAsHeld("damaged"));
  assert.ok(!instanceCountsAsHeld("decommissioned"));
  assert.ok(isInstanceCondition("working"));
  assert.ok(!isInstanceCondition("broken"));
});

await ok("an instance leg must move exactly one unit — the ledger rejects anything else", async () => {
  const { db, calls } = makeFakeDb();
  await assert.rejects(
    () =>
      postMovementGroup(
        db,
        input({ legs: [{ itemId: 1, instanceId: 99, locationId: 10, locationCode: "A-01-1", delta: -3 }] }),
      ),
    /exactly one unit/,
  );
  // Rejected before a single row was written.
  assert.equal(calls.insertMovementLegs, 0);
  assert.equal(calls.upsertStockLeg, 0);
});

await ok("an instance leg of ±1 is accepted and carries instance_id onto the row", async () => {
  const { db, insertedRows } = makeFakeDb({ "1:10": 1 });
  await postMovementGroup(
    db,
    input({
      movementType: "transfer",
      legs: [
        { itemId: 1, instanceId: 99, locationId: 10, locationCode: "A-01-1", delta: -1 },
        { itemId: 1, instanceId: 99, locationId: 11, locationCode: "PERSON-RILEY", delta: 1 },
      ],
    }),
  );
  assert.equal(insertedRows.length, 2);
  assert.deepEqual(insertedRows.map((r) => r.instanceId), [99, 99]);
});

await ok("a bulk-stock leg still writes a null instance_id (nothing changed for existing flows)", async () => {
  const { db, insertedRows } = makeFakeDb({ "1:10": 50 });
  await postMovementGroup(db, input());
  assert.equal(insertedRows.length, 1);
  assert.equal(insertedRows[0].instanceId, null);
});

// ── D20/D21 custody locations ────────────────────────────────────────────────

await ok("person and vehicle are location kinds with labels", () => {
  for (const k of LOCATION_KINDS) assert.ok(LOCATION_KIND_LABELS[k], `no label for ${k}`);
  assert.ok(isLocationKind("person"));
  assert.ok(isLocationKind("vehicle"));
  assert.ok(isCustodyLocation("person"));
  assert.ok(isCustodyLocation("vehicle"));
  assert.ok(!isCustodyLocation("bin"));
  assert.ok(!isCustodyLocation("virtual"));
});

await ok("custody stock is NOT sellable — the oversell guard", () => {
  assert.ok(isSellableLocation({ code: "A-01-2", kind: "bin" }));
  // The whole point: a shirt in a coach's car boot must never be offered.
  assert.ok(!isSellableLocation({ code: "PERSON-RILEY", kind: "person" }));
  assert.ok(!isSellableLocation({ code: "VEHICLE-ABC123", kind: "vehicle" }));
  assert.ok(!isSellableLocation({ code: "QUARANTINE", kind: "zone" }));
  assert.ok(!isSellableLocation({ code: "SUPPLIER", kind: "virtual" }));
});

await ok("custody locations derive no zone — they are not an aisle in the warehouse", () => {
  assert.equal(deriveLocationZone("A-01-2", "bin"), "A");
  assert.equal(deriveLocationZone("RECEIVING", "zone"), "RECEIVING");
  assert.equal(deriveLocationZone("SUPPLIER", "virtual"), null);
  // Would otherwise file every staff member's kit under an imaginary 'PERSON' aisle.
  assert.equal(deriveLocationZone("PERSON-RILEY", "person"), null);
  assert.equal(deriveLocationZone("VEHICLE-ABC123", "vehicle"), null);
});

// ── Scan action sheets ───────────────────────────────────────────────────────

await ok("scanning a stock item offers a counter sale; scanning an asset DEFINITION offers nothing", () => {
  const stock = scanActionsForItem({ isLoanable: false, trackingMode: "stock" });
  assert.ok(stock.includes("sale"));
  assert.ok(!stock.includes("loan_out"));
  assert.ok(scanActionsForItem({ isLoanable: true, trackingMode: "stock" }).includes("loan_out"));
  // An asset is moved as a named object — the UI sends you to the unit list.
  assert.deepEqual(scanActionsForItem({ isLoanable: true, trackingMode: "asset" }), []);
  // Unspecified tracking mode behaves as stock — every pre-v2 caller is unaffected.
  assert.ok(scanActionsForItem({ isLoanable: false }).includes("sale"));
});

await ok("scanning ONE asset offers move/retire, and nothing at all once retired", () => {
  const live = scanActionsForInstance({ condition: "working", isLoanable: false });
  assert.deepEqual(live, ["transfer", "decommission"]);
  assert.ok(scanActionsForInstance({ condition: "working", isLoanable: true }).includes("loan_out"));
  // A retired press must not quietly reappear on the floor.
  assert.deepEqual(scanActionsForInstance({ condition: "decommissioned", isLoanable: true }), []);
});

await ok("you cannot put stock AWAY into a person or a van, but you can count what they hold", () => {
  assert.deepEqual(scanActionsForLocation({ kind: "bin" }), ["putaway", "transfer", "count"]);
  assert.deepEqual(scanActionsForLocation({ kind: "person" }), ["transfer", "count"]);
  assert.deepEqual(scanActionsForLocation({ kind: "vehicle" }), ["transfer", "count"]);
  assert.deepEqual(scanActionsForLocation({ kind: "virtual" }), []);
});

await ok("every movement type has a label, including the two new ones", () => {
  for (const m of MOVEMENT_TYPES) assert.ok(MOVEMENT_TYPE_LABELS[m], `no label for ${m}`);
  assert.ok((MOVEMENT_TYPES as readonly string[]).includes("sale"));
  assert.ok((MOVEMENT_TYPES as readonly string[]).includes("decommission"));
});

// ── Asset tags ───────────────────────────────────────────────────────────────

await ok("an AST:-prefixed code is an asset tag and nothing else", () => {
  assert.deepEqual(stripInstancePrefix("AST:UP-PRESS-001"), { isInstanceCode: true, code: "UP-PRESS-001" });
  assert.deepEqual(stripInstancePrefix("ast:up-press-001"), { isInstanceCode: true, code: "UP-PRESS-001" });
  assert.deepEqual(stripInstancePrefix("UP-PRESS-001"), { isInstanceCode: false, code: "UP-PRESS-001" });
  assert.equal(instanceBarcodePayload("UP-PRESS-001"), "AST:UP-PRESS-001");
  assert.equal(normaliseAssetTag("  up-press-001 "), "UP-PRESS-001");
});

await ok("suggested asset tags are zero-padded off the SKU", () => {
  assert.equal(suggestAssetTag("UP-PRESS-A3", 7), "UP-PRESS-A3-007");
  assert.equal(suggestAssetTag("UP-PRESS-A3", 142), "UP-PRESS-A3-142");
});

// ── Warranty dates (D19) ─────────────────────────────────────────────────────

await ok("warranty status never renders an unaudited asset as green", () => {
  const today = "2026-07-27";
  // No date recorded is 'unknown', NOT 'ok' — the Vehicles-tab rule.
  assert.equal(warrantyStatus(null, today), "unknown");
  assert.equal(warrantyStatus(undefined, today), "unknown");
  assert.equal(warrantyStatus("not-a-date", today), "unknown");
  assert.equal(warrantyStatus("2026-07-26", today), "expired");
  assert.equal(warrantyStatus("2026-07-27", today), "expiring"); // today still counts as expiring, not expired
  assert.equal(warrantyStatus("2026-08-26", today), "expiring");
  assert.equal(warrantyStatus("2026-08-27", today), "ok");
});

await ok("date maths stays in string space and survives month/year ends", () => {
  assert.equal(addDaysIso("2026-07-27", 30), "2026-08-26");
  assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysIso("2026-02-28", 1), "2026-03-01"); // 2026 is not a leap year
  assert.equal(addDaysIso("2028-02-28", 1), "2028-02-29"); // 2028 is
  assert.equal(addDaysIso("2026-01-31", 30), "2026-03-02");
});

// ── D23/D24 custom fields ────────────────────────────────────────────────────

await ok("field keys slugify from the label and freeze", () => {
  assert.equal(slugifyFieldKey("WOF expiry"), "wof_expiry");
  assert.equal(slugifyFieldKey("  Vinyl width (mm)  "), "vinyl_width_mm");
  assert.equal(slugifyFieldKey("Owner's name"), "owners_name");
  assert.equal(slugifyFieldKey("A---B"), "a_b");
  assert.ok(isValidFieldKey("wof_expiry"));
  assert.ok(!isValidFieldKey("WOF expiry"));
  assert.ok(!isValidFieldKey("_leading"));
  assert.ok(!isValidFieldKey(""));
});

await ok("every field type maps to exactly one typed column (D24)", () => {
  for (const t of FIELD_TYPES) assert.ok(FIELD_TYPE_COLUMN[t], `no column for ${t}`);
  assert.equal(FIELD_TYPE_COLUMN.date, "valueDate");
  assert.equal(FIELD_TYPE_COLUMN.number, "valueNumber");
  assert.equal(FIELD_TYPE_COLUMN.boolean, "valueBoolean");
  // A chosen option is stored as text — it is still a string, just a checked one.
  assert.equal(FIELD_TYPE_COLUMN.select, "valueText");
  assert.ok(isFieldType("date"));
  assert.ok(!isFieldType("datetime"));
  assert.ok(isFieldAppliesTo("instance"));
  assert.ok(!isFieldAppliesTo("unit"));
});

const T = (over: Partial<FieldTemplateLike> = {}): FieldTemplateLike => ({
  fieldKey: "wof_expiry",
  label: "WOF expiry",
  fieldType: "date",
  required: false,
  ...over,
});

await ok("a date lands in value_date, and a bad one is refused by name", () => {
  const good = coerceFieldValue(T(), "2026-09-01");
  assert.ok(good.ok && good.value.valueDate === "2026-09-01");
  assert.ok(good.ok && good.value.valueText === null);
  const bad = coerceFieldValue(T(), "01/09/2026");
  assert.ok(!bad.ok && /WOF expiry must be a date/.test(bad.error));
});

await ok("a number lands in value_number; text that isn't a number is refused", () => {
  const good = coerceFieldValue(T({ fieldType: "number", label: "Vinyl width" }), "610");
  assert.ok(good.ok && good.value.valueNumber === 610);
  const alsoGood = coerceFieldValue(T({ fieldType: "number" }), 12.5);
  assert.ok(alsoGood.ok && alsoGood.value.valueNumber === 12.5);
  const bad = coerceFieldValue(T({ fieldType: "number", label: "Vinyl width" }), "wide");
  assert.ok(!bad.ok && /Vinyl width must be a number/.test(bad.error));
});

await ok("booleans accept the words humans and forms actually send", () => {
  for (const truthy of [true, "true", "yes", "1", "YES"]) {
    const r = coerceFieldValue(T({ fieldType: "boolean" }), truthy);
    assert.ok(r.ok && r.value.valueBoolean === true, `${truthy} should be true`);
  }
  for (const falsy of [false, "false", "no", "0"]) {
    const r = coerceFieldValue(T({ fieldType: "boolean" }), falsy);
    assert.ok(r.ok && r.value.valueBoolean === false, `${falsy} should be false`);
  }
  const bad = coerceFieldValue(T({ fieldType: "boolean", label: "Serviced" }), "maybe");
  assert.ok(!bad.ok && /Serviced must be yes or no/.test(bad.error));
});

await ok("a select is checked against its own option list", () => {
  const tmpl = T({ fieldType: "select", label: "Grade", options: ["A", "B", "C"] });
  const good = coerceFieldValue(tmpl, "B");
  assert.ok(good.ok && good.value.valueText === "B");
  const bad = coerceFieldValue(tmpl, "D");
  assert.ok(!bad.ok && /Grade must be one of: A, B, C/.test(bad.error));
  const noOptions = coerceFieldValue(T({ fieldType: "select", label: "Grade", options: [] }), "B");
  assert.ok(!noOptions.ok && /no options set up/.test(noOptions.error));
});

await ok("blank clears an optional field and is refused on a required one", () => {
  for (const blank of [undefined, null, "", "   "]) {
    const optional = coerceFieldValue(T(), blank);
    assert.ok(optional.ok, `blank ${JSON.stringify(blank)} should clear an optional field`);
    assert.ok(optional.ok && optional.value.valueDate === null);
    const required = coerceFieldValue(T({ required: true }), blank);
    assert.ok(!required.ok && /WOF expiry is required/.test(required.error));
  }
});

await ok("false is a real answer, not an empty one", () => {
  // The trap: `if (!value)` would treat a deliberate "no" as never-answered.
  const r = coerceFieldValue(T({ fieldType: "boolean", required: true }), false);
  assert.ok(r.ok, "false must satisfy a required boolean");
  assert.equal(readFieldValue("boolean", r.ok ? r.value : {}), false);
  assert.notEqual(readFieldValue("boolean", r.ok ? r.value : {}), null);
});

await ok("readFieldValue pulls back the populated slot and null when never set", () => {
  assert.equal(readFieldValue("date", { valueDate: "2026-09-01" }), "2026-09-01");
  assert.equal(readFieldValue("number", { valueNumber: 610 }), 610);
  assert.equal(readFieldValue("text", { valueText: "hi" }), "hi");
  assert.equal(readFieldValue("select", { valueText: "B" }), "B");
  assert.equal(readFieldValue("date", {}), null);
  // A date field must not accidentally read a value someone put in value_text.
  assert.equal(readFieldValue("date", { valueText: "2026-09-01" }), null);
});

await ok("missingRequiredFields lists labels, ignores optional gaps, and respects false", () => {
  const templates: FieldTemplateLike[] = [
    T({ fieldKey: "wof_expiry", label: "WOF expiry", required: true }),
    T({ fieldKey: "notes", label: "Notes", fieldType: "text", required: false }),
    T({ fieldKey: "serviced", label: "Serviced", fieldType: "boolean", required: true }),
  ];
  assert.deepEqual(missingRequiredFields(templates, {}), ["WOF expiry", "Serviced"]);
  assert.deepEqual(
    missingRequiredFields(templates, { wof_expiry: { valueDate: "2026-09-01" }, serviced: { valueBoolean: false } }),
    [],
    "a deliberate 'no' must count as answered",
  );
});

// ── Fakes (mirrors script/test-warehouse-engine.ts) ──────────────────────────

function makeFakeDb(initialStock: Record<string, number> = {}) {
  const stock = new Map<string, number>(Object.entries(initialStock));
  const idempotency = new Map<string, string>();
  const insertedRows: Array<NewMovementRow & { id: number }> = [];
  let nextId = 1;
  const calls = { findIdempotency: 0, insertMovementLegs: 0, upsertStockLeg: 0 };

  const db: WarehouseDb = {
    async findMovementGroupByIdempotencyKey(key) {
      calls.findIdempotency++;
      const groupId = idempotency.get(key);
      return groupId ? { groupId } : undefined;
    },
    async insertMovementLegs(rows) {
      calls.insertMovementLegs++;
      const out: { id: number }[] = [];
      for (const row of rows) {
        const id = nextId++;
        insertedRows.push({ ...row, id });
        if (row.idempotencyKey) idempotency.set(row.idempotencyKey, row.groupId);
        out.push({ id });
      }
      return out;
    },
    async upsertStockLeg(leg) {
      calls.upsertStockLeg++;
      const key = `${leg.itemId}:${leg.locationId}`;
      const newOnHand = (stock.get(key) ?? 0) + leg.delta;
      if (!leg.allowNegative && newOnHand < 0) return null;
      stock.set(key, newOnHand);
      return { onHand: newOnHand };
    },
  };

  return { db, stock, insertedRows, calls };
}

function input(overrides: Partial<PostMovementGroupInput> = {}): PostMovementGroupInput {
  return {
    legs: [{ itemId: 1, locationId: 10, locationCode: "A-01-1", delta: -3 }],
    movementType: "pick",
    operatorUserId: 7,
    ...overrides,
  };
}

if (process.exitCode) {
  console.error(`\n${passed} passed, at least one FAILED.`);
} else {
  console.log(`✅ warehouse v2: ${passed} test groups passed.`);
}
