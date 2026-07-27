// Tests for the data-driven item form (D26).
// Run: npx tsx script/test-warehouse-form.ts   (exits non-zero on failure)
//
// The layout is admin-editable, which means the rows in the database are
// eventually going to be wrong in some way nobody predicted. Everything here
// is about the form still being submittable when that happens.

import assert from "node:assert/strict";
import {
  CORE_FIELDS, CORE_FIELD_BY_KEY, MANDATORY_CORE_FIELDS, TRACKING_MODE_CHOICES,
  defaultLayout, resolveLayout, validateLayout, visibleFields, isCoreFieldKey,
  type TemplateRow,
} from "../shared/warehouse-form";
import { TRACKING_MODES } from "../shared/warehouse";

let passed = 0;
function ok(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e: any) { console.error(`FAIL: ${name}\n  ${e.stack || e.message}`); process.exitCode = 1; }
}

let nextId = 1;
const row = (over: Partial<TemplateRow> = {}): TemplateRow => ({
  id: nextId++, coreField: null, fieldKey: "f", label: "F", fieldType: "text",
  required: false, sortOrder: 0, helpText: null, active: true,
  trackingMode: null, category: null, ...over,
});
const coreRow = (key: string, sortOrder: number, over: Partial<TemplateRow> = {}) =>
  row({ coreField: key, fieldKey: key, label: CORE_FIELD_BY_KEY[key]?.label ?? key, sortOrder, ...over });

// ── The registry ─────────────────────────────────────────────────────────────

ok("sku and name are the mandatory core fields", () => {
  assert.deepEqual(MANDATORY_CORE_FIELDS.sort(), ["name", "sku"]);
});

ok("every core field has a unique key and a control", () => {
  const keys = CORE_FIELDS.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length, "duplicate core field key");
  for (const f of CORE_FIELDS) assert.ok(f.control, `${f.key} has no control`);
  assert.ok(isCoreFieldKey("sku"));
  assert.ok(!isCoreFieldKey("nonsense"));
});

ok("both tracking modes are offered with plain-English wording and examples", () => {
  assert.deepEqual(TRACKING_MODE_CHOICES.map((c) => c.mode).sort(), [...TRACKING_MODES].sort());
  for (const c of TRACKING_MODE_CHOICES) {
    assert.ok(c.blurb.length > 20, `${c.mode} needs a real explanation`);
    assert.ok(c.examples.length > 5, `${c.mode} needs examples`);
  }
  // The examples Daniel actually asked for.
  const stock = TRACKING_MODE_CHOICES.find((c) => c.mode === "stock")!;
  const asset = TRACKING_MODE_CHOICES.find((c) => c.mode === "asset")!;
  assert.match(stock.examples, /home kit/i);
  assert.match(asset.examples, /printer/i);
});

// ── Defaults — the safety property ───────────────────────────────────────────

ok("with nothing customised, the layout is the built-in default", () => {
  const layout = resolveLayout([], "stock");
  assert.deepEqual(layout.map((f) => f.coreField), defaultLayout("stock").map((f) => f.coreField));
  assert.ok(layout.length > 5);
});

ok("mode-specific fields only appear for their mode", () => {
  const stock = defaultLayout("stock").map((f) => f.coreField);
  const asset = defaultLayout("asset").map((f) => f.coreField);
  // A quantity-shaped question makes no sense for one physical printer.
  assert.ok(stock.includes("minQty"));
  assert.ok(!asset.includes("minQty"));
  assert.ok(stock.includes("allowNegative"));
  assert.ok(!asset.includes("allowNegative"));
  // Both still ask the things every item needs.
  for (const k of MANDATORY_CORE_FIELDS) {
    assert.ok(stock.includes(k) && asset.includes(k), `${k} must be on both`);
  }
});

ok("barcodes are on the default form for both modes", () => {
  for (const mode of TRACKING_MODES) {
    assert.ok(defaultLayout(mode).some((f) => f.coreField === "barcodes"), `${mode} should offer barcodes`);
  }
});

// ── Admin edits ──────────────────────────────────────────────────────────────

ok("a saved order is respected", () => {
  const rows = [coreRow("name", 0), coreRow("sku", 1), coreRow("barcodes", 2)];
  const layout = resolveLayout(rows, "stock");
  assert.deepEqual(layout.map((f) => f.coreField), ["name", "sku", "barcodes"]);
});

ok("a relabelled field keeps its own label", () => {
  const rows = [coreRow("sku", 0, { label: "Product code" }), coreRow("name", 1)];
  const layout = resolveLayout(rows, "stock");
  assert.equal(layout.find((f) => f.coreField === "sku")!.label, "Product code");
});

ok("an inactive field is kept but hidden, so unhiding restores it", () => {
  const rows = [coreRow("sku", 0), coreRow("name", 1), coreRow("notes", 2, { active: false, label: "Internal notes" })];
  const layout = resolveLayout(rows, "stock");
  const notes = layout.find((f) => f.coreField === "notes")!;
  assert.equal(notes.hidden, true);
  assert.equal(notes.label, "Internal notes", "the label survives being hidden");
  assert.ok(!visibleFields(layout).some((f) => f.coreField === "notes"));
});

// ── The layout can't break item creation ─────────────────────────────────────

ok("🔴 a mandatory field missing from stored rows is put back, not dropped", () => {
  // Someone edited rows by hand, or saved a layout from before this existed.
  const rows = [coreRow("category", 0), coreRow("notes", 1)];
  const layout = resolveLayout(rows, "stock");
  for (const k of MANDATORY_CORE_FIELDS) {
    assert.ok(layout.some((f) => f.coreField === k), `${k} must be re-inserted`);
  }
});

ok("🔴 a mandatory field marked inactive is forced visible and required", () => {
  const rows = [coreRow("sku", 0, { active: false }), coreRow("name", 1, { active: false, required: false })];
  const layout = resolveLayout(rows, "stock");
  for (const k of MANDATORY_CORE_FIELDS) {
    const f = layout.find((x) => x.coreField === k)!;
    assert.equal(f.hidden, false, `${k} must never be hidden`);
    assert.equal(f.required, true, `${k} must stay required`);
    assert.equal(f.mandatory, true);
  }
});

ok("saving a layout without sku or name is refused, with a reason", () => {
  const bad = validateLayout([{ coreField: "category", active: true }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2, "one message per missing mandatory field");
  assert.ok(bad.errors.every((e) => /keys on it/.test(e)), "the message should explain WHY");
});

ok("saving a layout that hides sku is refused", () => {
  const bad = validateLayout([
    { coreField: "sku", active: false },
    { coreField: "name", active: true },
  ]);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /can't be hidden/);
});

ok("a duplicated field is refused", () => {
  const bad = validateLayout([
    { coreField: "sku", active: true },
    { coreField: "name", active: true },
    { coreField: "sku", active: true },
  ]);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /twice/.test(e)));
});

ok("a good layout passes", () => {
  const good = validateLayout([
    { coreField: "sku", active: true },
    { coreField: "name", active: true },
    { coreField: "notes", active: false },
    { coreField: null, active: true },
  ]);
  assert.deepEqual(good, { ok: true, errors: [] });
});

ok("a field scoped to the other mode is dropped even if stored", () => {
  // minQty is stock-only; a row for it must not render on an asset form.
  const rows = [coreRow("sku", 0), coreRow("name", 1), coreRow("minQty", 2)];
  const layout = resolveLayout(rows, "asset");
  assert.ok(!layout.some((f) => f.coreField === "minQty"));
});

ok("tracking_mode on a row scopes it", () => {
  const rows = [
    coreRow("sku", 0), coreRow("name", 1),
    coreRow("costCents", 2, { trackingMode: "asset" }),
  ];
  assert.ok(resolveLayout(rows, "asset").some((f) => f.coreField === "costCents"));
  assert.ok(!resolveLayout(rows, "stock").some((f) => f.coreField === "costCents"));
});

// ── Custom fields still work exactly as in v2 ────────────────────────────────

ok("custom fields append after the core ones, only once a category is chosen", () => {
  const rows = [
    coreRow("sku", 0), coreRow("name", 1),
    row({ fieldKey: "roll_width_mm", label: "Roll width", category: "Print materials", sortOrder: 0 }),
  ];
  assert.equal(resolveLayout(rows, "stock", null).length, 2, "no category means no custom fields yet");
  const withCat = resolveLayout(rows, "stock", "Print materials");
  assert.equal(withCat.length, 3);
  assert.equal(withCat[2].fieldKey, "roll_width_mm");
  assert.equal(withCat[2].control, "custom");
});

ok("a custom field from another category doesn't leak in", () => {
  const rows = [
    coreRow("sku", 0), coreRow("name", 1),
    row({ fieldKey: "wof_expiry", label: "WOF", category: "Vehicles", sortOrder: 0 }),
  ];
  assert.ok(!resolveLayout(rows, "stock", "Print materials").some((f) => f.fieldKey === "wof_expiry"));
});

ok("ids are unique across a resolved layout", () => {
  const rows = [
    coreRow("sku", 0), coreRow("name", 1),
    row({ fieldKey: "sku", label: "Custom SKU-ish", category: "Kit", sortOrder: 0 }),
  ];
  const layout = resolveLayout(rows, "stock", "Kit");
  const ids = layout.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "core:sku and custom:sku must not collide");
});

if (process.exitCode) console.error(`\n${passed} passed, at least one FAILED.`);
else console.log(`✅ warehouse form layout: ${passed} test groups passed.`);
