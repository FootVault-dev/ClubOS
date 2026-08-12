// Pricing engine for the United Prints MIS. One pure function:
// quotePrintItem(material, config) → QuoteResult
//
// Called from both the public quote page (every keystroke) and the admin
// order-edit screen. Server-side ONLY — clients never compute the price they
// pay; the server re-runs this on every checkout and validates against the
// PaymentIntent amount before charging Stripe.
//
// Returns NEEDS_HUMAN_QUOTE if the configuration falls outside what the
// engine can confidently price (size out of range, qty over caps, total
// over $2,500, material flagged human-quote-required, or a non-stock size
// on a tiered product).
//
// All money in cents. GST (15% NZ) is applied at the order level on the sum
// of items, not per-item — this keeps rounding consistent with how Stripe
// handles totals.

import type { PrintMaterial } from "@shared/schema";

export interface ItemConfig {
  widthMm?: number;
  heightMm?: number;
  quantity: number;
  sides?: number;
  selectedAddonIds?: string[];
  rush?: boolean;
  // For garment_decoration: { method, colours, decorationLocation, hasArtwork }
  // For per_piece_tiered / bundle: { tierId } (matched to size_tiers_json)
  extra?: Record<string, unknown>;
}

export interface BreakdownLine {
  label: string;
  cents: number;
}

export interface QuoteResult {
  ok: true;
  unitPriceCents: number;        // before qty discount, addons
  qtyDiscountCents: number;      // negative is implicit; this is positive (the discount amount)
  addonsTotalCents: number;
  rushFeeCents: number;
  subtotalCents: number;          // pre-GST line subtotal
  estimatedCostCents: number;     // for margin tracking
  breakdown: BreakdownLine[];
  turnaroundDays: number;
}

export interface QuoteFallback {
  ok: false;
  reason: "size_out_of_range" | "over_roll_width" | "qty_over_cap" | "total_over_cap" | "human_quote_required" | "no_matching_tier" | "missing_dimensions";
  message: string;
}

export type QuoteOutcome = QuoteResult | QuoteFallback;

const GST_RATE = 0.15;
const RUSH_MULTIPLIER = 0.30;       // +30% on subtotal for rush
const TOTAL_HARD_CAP_CENTS = 250000; // $2,500 — anything bigger needs human review
const QTY_HARD_CAP_DEFAULT = 500;
const QTY_HARD_CAP_GARMENT = 250;

interface AddonDef {
  id: string;
  name: string;
  formula: "flat" | "per_unit" | "per_perimeter_m" | "per_corner";
  unitPriceCents: number;
  default?: boolean;
}

interface QtyTier {
  minQty: number;
  discountPct: number;
}

interface SizeTier {
  id: string;
  label: string;
  w?: number;
  h?: number;
  priceCents: number;
}

function moneyLabel(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function findQtyDiscountPct(tiers: QtyTier[], qty: number): number {
  const sorted = [...tiers].sort((a, b) => b.minQty - a.minQty);
  for (const t of sorted) {
    if (qty >= t.minQty) return t.discountPct;
  }
  return 0;
}

function computeAddon(addon: AddonDef, config: ItemConfig, areaM2: number, perimeterM: number): { cents: number; label: string } {
  switch (addon.formula) {
    case "flat":
      return { cents: addon.unitPriceCents * config.quantity, label: `${addon.name}` };
    case "per_unit":
      // Number of units = quantity (e.g. eyelets per banner, where the addon already counts the corners)
      return { cents: addon.unitPriceCents * config.quantity, label: `${addon.name} ×${config.quantity}` };
    case "per_perimeter_m": {
      const meters = perimeterM * config.quantity;
      return { cents: Math.round(addon.unitPriceCents * meters), label: `${addon.name} (${meters.toFixed(1)}m)` };
    }
    case "per_corner": {
      const corners = 4 * config.quantity;
      return { cents: addon.unitPriceCents * corners, label: `${addon.name} ×${corners}` };
    }
    default:
      return { cents: 0, label: addon.name };
  }
}

export function quotePrintItem(material: PrintMaterial, config: ItemConfig): QuoteOutcome {
  // Hard fallbacks ─────────────────────────────────────────────────────────
  if (material.humanQuoteRequired) {
    return { ok: false, reason: "human_quote_required", message: `${material.name} needs a custom quote — we'll get back to you within 4 hours.` };
  }
  const qtyCap = material.category === "garment" ? QTY_HARD_CAP_GARMENT : QTY_HARD_CAP_DEFAULT;
  if (config.quantity > qtyCap) {
    return { ok: false, reason: "qty_over_cap", message: `Orders over ${qtyCap} units need a custom quote — better pricing for big runs.` };
  }

  // Pricing branches ────────────────────────────────────────────────────────
  const breakdown: BreakdownLine[] = [];
  let unitPriceCents = 0;
  let estimatedCostCents = 0;
  let areaM2 = 0;
  let perimeterM = 0;

  switch (material.pricingMethod) {
    case "per_m2": {
      if (!config.widthMm || !config.heightMm) {
        return { ok: false, reason: "missing_dimensions", message: "We need width and height to price this." };
      }
      // Size range check
      if (material.sizeMinWMm && config.widthMm < material.sizeMinWMm) return outOfRange(material);
      if (material.sizeMaxWMm && config.widthMm > material.sizeMaxWMm) return outOfRange(material);
      if (material.sizeMinHMm && config.heightMm < material.sizeMinHMm) return outOfRange(material);
      if (material.sizeMaxHMm && config.heightMm > material.sizeMaxHMm) return outOfRange(material);

      // Physical limit of the machine, checked last so the friendlier
      // range messages win where both apply.
      const rollFail = overRollWidth(material, config.widthMm, config.heightMm);
      if (rollFail) return rollFail;

      areaM2 = (config.widthMm * config.heightMm) / 1_000_000;
      perimeterM = 2 * (config.widthMm + config.heightMm) / 1000;

      const baseTotalCents = Math.round(areaM2 * material.baseRateCents * config.quantity);
      const sides = config.sides ?? 1;
      const sidesMultiplier = sides === 2 ? 1.7 : 1;  // double-sided is 1.7×, not 2×
      unitPriceCents = Math.round(baseTotalCents * sidesMultiplier);

      breakdown.push({
        label: `${areaM2.toFixed(2)} m² × ${moneyLabel(material.baseRateCents)}/m² × ${config.quantity}${sides === 2 ? " (×1.7 double-sided)" : ""}`,
        cents: unitPriceCents,
      });

      estimatedCostCents = Math.round(areaM2 * material.substrateCostPerM2Cents * config.quantity * sidesMultiplier);
      break;
    }

    case "per_piece": {
      unitPriceCents = material.baseRateCents * config.quantity;
      breakdown.push({ label: `${config.quantity} × ${moneyLabel(material.baseRateCents)}`, cents: unitPriceCents });
      // Cost: assume 40% of base rate is material; engine doesn't see margin perfectly here
      estimatedCostCents = Math.round(unitPriceCents * 0.4);
      break;
    }

    case "per_piece_tiered": {
      const tiers = (material.sizeTiersJson as SizeTier[]) ?? [];
      const tierId = (config.extra?.tierId as string) ?? "";
      const tier = tiers.find((t) => t.id === tierId);
      if (!tier) {
        // Custom-size fallback — if the material has a base_rate_cents, use per_m2 for non-stock
        if (material.baseRateCents > 0 && config.widthMm && config.heightMm) {
          // A custom size on a tiered product is still printed on the same
          // machine, so the roll limit applies here too.
          const rollFail = overRollWidth(material, config.widthMm, config.heightMm);
          if (rollFail) return rollFail;
          areaM2 = (config.widthMm * config.heightMm) / 1_000_000;
          unitPriceCents = Math.round(areaM2 * material.baseRateCents * config.quantity);
          breakdown.push({ label: `Custom size — ${areaM2.toFixed(2)} m² × ${moneyLabel(material.baseRateCents)}/m² × ${config.quantity}`, cents: unitPriceCents });
          estimatedCostCents = Math.round(areaM2 * material.substrateCostPerM2Cents * config.quantity);
        } else {
          return { ok: false, reason: "no_matching_tier", message: "This size needs a custom quote — pop your details in and we'll come back to you." };
        }
      } else {
        unitPriceCents = tier.priceCents * config.quantity;
        breakdown.push({ label: `${tier.label} × ${config.quantity}`, cents: unitPriceCents });
        estimatedCostCents = Math.round(unitPriceCents * 0.4);
      }
      break;
    }

    case "garment_decoration": {
      // Engine picks decoration method based on qty + colours.
      // Below 20 → DTG (digital direct-to-garment). 20+ → screen print.
      // Embroidery = caller passes extra.method = 'embroidery'.
      const method = (config.extra?.method as string) ?? (config.quantity < 20 ? "dtg" : "screen_print");
      const colours = Math.max(1, (config.extra?.colours as number) ?? 1);

      // Pull from configJson on the material — convention:
      // addonsJson includes entries like {id: 'screen_print_setup_per_colour', formula: 'flat', unitPriceCents: 4500}
      const blankCostCents = material.baseRateCents;  // base AS Colour blank
      const decorationPerPieceCents = method === "screen_print" ? 800 : (method === "embroidery" ? 1200 : 1500);
      const setupCents = method === "screen_print" ? 4500 * colours : 0;

      unitPriceCents = (blankCostCents + decorationPerPieceCents) * config.quantity + setupCents;

      breakdown.push({ label: `${config.quantity} × blank @ ${moneyLabel(blankCostCents)}`, cents: blankCostCents * config.quantity });
      breakdown.push({ label: `${method.toUpperCase()} decoration ${config.quantity} × ${moneyLabel(decorationPerPieceCents)}`, cents: decorationPerPieceCents * config.quantity });
      if (setupCents > 0) breakdown.push({ label: `Screen setup × ${colours} colour${colours > 1 ? "s" : ""}`, cents: setupCents });

      estimatedCostCents = Math.round((blankCostCents * 0.6 + decorationPerPieceCents * 0.4) * config.quantity);
      break;
    }

    case "bundle": {
      const tiers = (material.sizeTiersJson as SizeTier[]) ?? [];
      const tierId = (config.extra?.tierId as string) ?? tiers[0]?.id;
      const tier = tiers.find((t) => t.id === tierId);
      if (!tier) {
        return { ok: false, reason: "no_matching_tier", message: "Pick a size to see pricing." };
      }
      unitPriceCents = tier.priceCents * config.quantity;
      breakdown.push({ label: `${tier.label} × ${config.quantity}`, cents: unitPriceCents });
      estimatedCostCents = Math.round(unitPriceCents * 0.45);
      break;
    }
  }

  // Quantity discount ──────────────────────────────────────────────────────
  const qtyTiers = (material.qtyTiersJson as QtyTier[]) ?? [];
  const qtyDiscountPct = findQtyDiscountPct(qtyTiers, config.quantity);
  const qtyDiscountCents = Math.round((unitPriceCents * qtyDiscountPct) / 100);
  if (qtyDiscountCents > 0) {
    breakdown.push({ label: `Quantity discount (−${qtyDiscountPct}%)`, cents: -qtyDiscountCents });
  }

  // Add-ons ────────────────────────────────────────────────────────────────
  const addons = (material.addonsJson as AddonDef[]) ?? [];
  const selected = config.selectedAddonIds ?? addons.filter((a) => a.default).map((a) => a.id);
  let addonsTotalCents = 0;
  for (const addonId of selected) {
    const addon = addons.find((a) => a.id === addonId);
    if (!addon) continue;
    const result = computeAddon(addon, config, areaM2, perimeterM);
    addonsTotalCents += result.cents;
    if (result.cents > 0) breakdown.push({ label: result.label, cents: result.cents });
  }

  // Subtotal so far (pre-rush, pre-min-charge)
  let subtotalCents = unitPriceCents - qtyDiscountCents + addonsTotalCents;

  // Minimum charge ─────────────────────────────────────────────────────────
  if (subtotalCents < material.minChargeCents) {
    const topUp = material.minChargeCents - subtotalCents;
    breakdown.push({ label: `Shop minimum (${moneyLabel(material.minChargeCents)})`, cents: topUp });
    subtotalCents = material.minChargeCents;
  }

  // Rush fee ──────────────────────────────────────────────────────────────
  let rushFeeCents = 0;
  if (config.rush && material.rushAvailable) {
    rushFeeCents = Math.round(subtotalCents * RUSH_MULTIPLIER);
    breakdown.push({ label: `Rush 48hr (+${(RUSH_MULTIPLIER * 100).toFixed(0)}%)`, cents: rushFeeCents });
    subtotalCents += rushFeeCents;
  }

  // Total cap check ────────────────────────────────────────────────────────
  const projectedTotal = Math.round(subtotalCents * (1 + GST_RATE));
  if (projectedTotal > TOTAL_HARD_CAP_CENTS) {
    return { ok: false, reason: "total_over_cap", message: "This order is over $2,500 — we'll quote it manually for better pricing on your run size." };
  }

  return {
    ok: true,
    unitPriceCents,
    qtyDiscountCents,
    addonsTotalCents,
    rushFeeCents,
    subtotalCents,
    estimatedCostCents,
    breakdown,
    turnaroundDays: config.rush && material.rushAvailable ? 2 : material.turnaroundDays,
  };
}

function outOfRange(material: PrintMaterial): QuoteFallback {
  return {
    ok: false,
    reason: "size_out_of_range",
    message: `Size is outside our standard range for ${material.name} — pop your details in and we'll quote it within 4 hours.`,
  };
}

/**
 * The printer's roll width.
 *
 * 🔴 Checked against the NARROWER of the two dimensions, deliberately. Our
 * printer runs a 1.6m roll with no limit on length, so a 3000 × 800mm banner
 * is fine — it goes through with the 800mm across the roll. Testing the field
 * that happens to be labelled "width" would refuse that job, and refuse it
 * silently: the customer just sees "too big" on something we print every week.
 *
 * NULL maxRollWidthMm means the product isn't roll-fed (a composite panel, a
 * garment) and there is nothing to check.
 */
function overRollWidth(material: PrintMaterial, widthMm: number, heightMm: number): QuoteFallback | null {
  const limit = material.maxRollWidthMm;
  if (!limit || limit <= 0) return null;
  const narrower = Math.min(widthMm, heightMm);
  if (narrower <= limit) return null;
  return {
    ok: false,
    reason: "over_roll_width",
    message: `Our printer runs a ${(limit / 1000).toFixed(2).replace(/0$/, "")}m roll, so one side needs to be ${(limit / 1000).toFixed(2).replace(/0$/, "")}m or under — the other side can be any length. Send it through and we'll quote it as panels if you need it bigger.`,
  };
}

// Order-level totals — given a list of line subtotals (after rush, before
// GST), compute GST and final total. Keep this here so the rounding rule is
// applied consistently from public flow + admin re-quote flow.
export function quoteOrderTotals(lineSubtotalsCents: number[], deliveryQuoteCents = 0): {
  subtotalCents: number;
  gstCents: number;
  totalCents: number;
} {
  const sumLines = lineSubtotalsCents.reduce((a, b) => a + b, 0);
  const subtotalCents = sumLines + deliveryQuoteCents;
  const gstCents = Math.round(subtotalCents * GST_RATE);
  const totalCents = subtotalCents + gstCents;
  return { subtotalCents, gstCents, totalCents };
}
