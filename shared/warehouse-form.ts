// The item form, as data (D26).
//
// Dima decides what gets asked when someone adds an item, and in what order —
// without a developer and without a deploy. A layout is just an ordered list
// of fields, and a field is one of two things:
//
//   • a CORE field — a real column on wh_items (sku, name, unit…) or the
//     barcode editor. It can be reordered, relabelled and (mostly) hidden, but
//     its value goes to the column it belongs to.
//   • a CUSTOM field — a wh_field_templates row with no core_field, stored in
//     wh_item_fields against a typed column (D22–D24). Unchanged from v2.
//
// 🔴 Two core fields can never be removed: `sku` and `name` are NOT NULL on
// wh_items and the entire warehouse keys on SKU — scanning, labels, channel
// mapping, the ledger. A layout that omits them would make item creation fail
// at the database, so the editor refuses it here rather than letting someone
// discover it at the counter.
//
// Tested by script/test-warehouse-form.ts.

import { TRACKING_MODES, type TrackingMode } from "./warehouse";

export type CoreFieldKey =
  | "sku" | "name" | "kind" | "brandOwner" | "category" | "unit"
  | "minQty" | "costCents" | "defaultLocationId"
  | "active" | "allowNegative" | "isLoanable" | "notes" | "barcodes";

export interface CoreFieldDef {
  key: CoreFieldKey;
  /** Default label — an admin can override it per layout. */
  label: string;
  /** How it renders. 'barcodes' is the scan-and-link editor, not an input. */
  control: "text" | "textarea" | "number" | "money" | "select" | "checkbox" | "barcodes";
  /** Locked on: removing it would break item creation or the warehouse's own
   *  identity model. */
  mandatory?: boolean;
  /** Only meaningful for one tracking mode — the editor hides it elsewhere. */
  onlyFor?: TrackingMode;
  hint?: string;
}

/** Every built-in field, in the order a sensible default layout uses them. */
export const CORE_FIELDS: CoreFieldDef[] = [
  { key: "sku", label: "SKU", control: "text", mandatory: true, hint: "The code we key everything on" },
  { key: "name", label: "Name", control: "text", mandatory: true },
  { key: "barcodes", label: "Barcodes", control: "barcodes", hint: "Scan the box — links the supplier's own barcode to this item" },
  { key: "kind", label: "Kind", control: "select" },
  { key: "brandOwner", label: "Brand owner", control: "select" },
  { key: "category", label: "Category", control: "text", hint: "Also decides which extra fields appear" },
  { key: "unit", label: "Unit", control: "select", onlyFor: "stock" },
  { key: "minQty", label: "Reorder point", control: "number", onlyFor: "stock" },
  { key: "costCents", label: "Cost", control: "money" },
  { key: "defaultLocationId", label: "Default location", control: "select" },
  { key: "active", label: "Active", control: "checkbox" },
  { key: "allowNegative", label: "Allow negative", control: "checkbox", onlyFor: "stock" },
  { key: "isLoanable", label: "Can be loaned out", control: "checkbox" },
  { key: "notes", label: "Notes", control: "textarea" },
];

export const CORE_FIELD_BY_KEY: Record<string, CoreFieldDef> = Object.fromEntries(
  CORE_FIELDS.map((f) => [f.key, f]),
);

export function isCoreFieldKey(v: unknown): v is CoreFieldKey {
  return typeof v === "string" && v in CORE_FIELD_BY_KEY;
}

/** The two that can never be dropped — see the file header. */
export const MANDATORY_CORE_FIELDS: CoreFieldKey[] = CORE_FIELDS.filter((f) => f.mandatory).map((f) => f.key);

/** One row of a resolved layout, whatever its origin. */
export interface LayoutField {
  /** `core:sku` or `custom:wof_expiry` — unique within a layout. */
  id: string;
  coreField: CoreFieldKey | null;
  fieldKey: string;
  label: string;
  control: CoreFieldDef["control"] | "custom";
  required: boolean;
  hidden: boolean;
  hint?: string | null;
  mandatory: boolean;
}

export interface TemplateRow {
  id: number;
  coreField: string | null;
  fieldKey: string;
  label: string;
  fieldType: string;
  required: boolean;
  sortOrder: number;
  helpText: string | null;
  active: boolean;
  trackingMode: string | null;
  category: string | null;
}

/**
 * The layout used when an admin has never customised anything — every core
 * field that applies to this tracking mode, in CORE_FIELDS order.
 *
 * This is what makes the feature safe to ship: the form works identically to
 * before until somebody deliberately changes it.
 */
export function defaultLayout(mode: TrackingMode): LayoutField[] {
  return CORE_FIELDS.filter((f) => !f.onlyFor || f.onlyFor === mode).map((f) => ({
    id: `core:${f.key}`,
    coreField: f.key,
    fieldKey: f.key,
    label: f.label,
    control: f.control,
    required: f.mandatory === true,
    hidden: false,
    hint: f.hint ?? null,
    mandatory: f.mandatory === true,
  }));
}

/**
 * Resolves the stored rows into the ordered list the form renders.
 *
 * Rules that matter:
 *  • No stored CORE rows at all → the default layout (nothing customised yet).
 *  • A mandatory field missing from a stored layout is APPENDED rather than
 *    dropped, so a layout saved before a mandatory field existed — or one
 *    edited by hand — can never produce an unsubmittable form.
 *  • Inactive rows are kept but marked hidden, so unhiding restores the label
 *    and position instead of starting again.
 *  • Custom fields only appear once a category is chosen, because that is what
 *    they hang off (D23).
 */
export function resolveLayout(
  rows: TemplateRow[],
  mode: TrackingMode,
  category?: string | null,
): LayoutField[] {
  const forMode = rows.filter((r) => r.trackingMode == null || r.trackingMode === mode);

  const coreRows = forMode
    .filter((r) => r.coreField && isCoreFieldKey(r.coreField))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  let core: LayoutField[];
  if (coreRows.length === 0) {
    core = defaultLayout(mode);
  } else {
    core = coreRows
      .filter((r) => {
        const def = CORE_FIELD_BY_KEY[r.coreField!];
        return !def.onlyFor || def.onlyFor === mode;
      })
      .map((r) => {
        const def = CORE_FIELD_BY_KEY[r.coreField!];
        return {
          id: `core:${def.key}`,
          coreField: def.key,
          fieldKey: def.key,
          label: r.label || def.label,
          control: def.control,
          required: def.mandatory === true || r.required,
          hidden: !r.active,
          hint: r.helpText ?? def.hint ?? null,
          mandatory: def.mandatory === true,
        };
      });

    // Never let a mandatory field go missing, however the rows were edited.
    for (const key of MANDATORY_CORE_FIELDS) {
      if (!core.some((f) => f.coreField === key)) {
        const def = CORE_FIELD_BY_KEY[key];
        core.unshift({
          id: `core:${key}`,
          coreField: key,
          fieldKey: key,
          label: def.label,
          control: def.control,
          required: true,
          hidden: false,
          hint: def.hint ?? null,
          mandatory: true,
        });
      }
    }
  }

  // A hidden mandatory field is a contradiction — force it visible.
  core = core.map((f) => (f.mandatory ? { ...f, hidden: false, required: true } : f));

  const custom: LayoutField[] = category
    ? forMode
        .filter((r) => !r.coreField && r.active && r.category === category)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
        .map((r) => ({
          id: `custom:${r.fieldKey}`,
          coreField: null,
          fieldKey: r.fieldKey,
          label: r.label,
          control: "custom" as const,
          required: r.required,
          hidden: false,
          hint: r.helpText,
          mandatory: false,
        }))
    : [];

  return [...core, ...custom];
}

/** Fields the form actually renders (hidden ones are configuration, not UI). */
export function visibleFields(layout: LayoutField[]): LayoutField[] {
  return layout.filter((f) => !f.hidden);
}

export interface LayoutValidation {
  ok: boolean;
  errors: string[];
}

/** Guards a layout an admin is trying to SAVE. */
export function validateLayout(order: Array<{ coreField: string | null; active: boolean }>): LayoutValidation {
  const errors: string[] = [];
  for (const key of MANDATORY_CORE_FIELDS) {
    const row = order.find((r) => r.coreField === key);
    const def = CORE_FIELD_BY_KEY[key];
    if (!row) errors.push(`${def.label} has to stay on the form — the warehouse keys on it.`);
    else if (!row.active) errors.push(`${def.label} can't be hidden — the warehouse keys on it.`);
  }
  const seen = new Set<string>();
  for (const r of order) {
    if (!r.coreField) continue;
    if (seen.has(r.coreField)) errors.push(`${r.coreField} appears twice.`);
    seen.add(r.coreField);
  }
  return { ok: errors.length === 0, errors };
}

/** Plain-English description of each mode, shown on the first step of New item. */
export const TRACKING_MODE_CHOICES: Array<{
  mode: TrackingMode;
  title: string;
  blurb: string;
  examples: string;
}> = [
  {
    mode: "stock",
    title: "Stock",
    blurb: "Something we hold a quantity of. We count how many are on the shelf.",
    examples: "CUFC blue home kit · vinyl rolls · footballs · cones",
  },
  {
    mode: "asset",
    title: "Asset",
    blurb: "Something we own one of and track individually — its serial, condition and who has it.",
    examples: "a printer · heat press · mower · laptop",
  },
];

export { TRACKING_MODES };
