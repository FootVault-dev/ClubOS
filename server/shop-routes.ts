/**
 * Shop — native e-commerce module (MFL Store pilot, Shopify replacement).
 *
 * Public API (/api/public/shop/:brand/*) serves the standalone storefront
 * (shop.minifootball.co.nz) cross-origin: catalog, server-authoritative
 * quote/checkout (embedded Stripe PaymentElement — never hosted Checkout),
 * order status by unguessable token, and a client confirm fallback that
 * mirrors the webhook's idempotent finalize.
 *
 * Admin API (/api/admin/shop/*) powers the "Store" tab in the league
 * workspace: products (with colours / images / size-stock variants),
 * the order fulfilment pipeline, shipping options and discount codes.
 *
 * Multi-brand by design — one registry entry per brand, MFL (org 3) first.
 * Money: integer NZD cents in the DB, DOLLARS (numbers) in public API
 * responses. Totals are GST-INCLUSIVE; gstCents = round(total * 3 / 23).
 */

import type { Express, Request, Response, NextFunction } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { db } from "./db";
import { and, asc, desc, eq, inArray, or, ilike, sql } from "drizzle-orm";
import { storage } from "./storage";
import { requireAuth, requireTab } from "./auth";
import { stripe, retrievePaymentIntent } from "./stripe";
import {
  sendShopOrderConfirmation, sendShopOrderNotification, type ShopOrderEmailLine,
  sendShopShareInvite, sendShopTeamSetupSummary, sendShopShareReceipt,
  sendShopTeamAllPaidConfirmation, sendShopPrintReadyNotification,
} from "./email";
import { sendServerEvent } from "./meta-capi";
import {
  shopProducts, shopProductColours, shopProductImages, shopVariants,
  shopShippingOptions, shopDiscountCodes, shopOrders, shopOrderItems, shopOrderShares,
  whItems,
  type ShopProduct, type ShopProductColour, type ShopProductImage,
  type ShopVariant, type ShopShippingOption, type ShopDiscountCode,
  type ShopOrder, type ShopOrderItem, type ShopOrderShare,
  type ShopKitCustomisation, type ShopSponsorSlot, type ShopUnitPersonalisation,
  type ShopPrintOptions, type ShopPrintChoice,
} from "@shared/schema";
// T13 — WMS reservation on payment-confirm (dark-launched, see finalizeShopOrderPaid).
import { runReserveStock, runReleaseReservationsForRef } from "./warehouse";

// ─── Brand registry — add a row per brand to open a new store ──────────────

interface ShopBrand {
  brandKey: string;
  orgId: number;
  storeName: string;
  /** Human order numbers: `${orderPrefix}-1001` incrementing per org. */
  orderPrefix: string;
  /** Absolute base for relative /objects/... image URLs in public responses. */
  assetBase: string;
  currency: string;
  /** New-order notification inbox (follows the MFL waitlist precedent). */
  adminEmail: string;
  /** Extra origins allowed to call the public shop API for this brand. */
  allowedOrigins: RegExp[];
  /** Absolute base of the standalone storefront — used to build the Player Pay
   *  `/pay/{shareToken}` and coach `/team/{orderToken}` links in emails. */
  storefrontBase: string;
}

const SHOP_BRANDS: Record<string, ShopBrand> = {
  mfl: {
    brandKey: "mfl",
    orgId: 3,
    storeName: "MFL Store",
    orderPrefix: "MFL",
    assetBase: "https://join.minifootball.co.nz",
    currency: "NZD",
    adminEmail: "info@minifootball.co.nz",
    allowedOrigins: [
      /^https:\/\/(www\.)?minifootball\.co\.nz$/,
      /^https:\/\/shop\.minifootball\.co\.nz$/,
    ],
    storefrontBase: "https://shop.minifootball.co.nz",
  },
  cic: {
    brandKey: "cic",
    orgId: 5,
    storeName: "CIC Store",
    orderPrefix: "CIC",
    assetBase: "https://join.cicyouth.com",
    currency: "NZD",
    adminEmail: "info@cicyouth.com",
    allowedOrigins: [
      /^https:\/\/(www\.)?cicyouth\.com$/,
      /^https:\/\/shop\.cicyouth\.com$/,
    ],
    storefrontBase: "https://shop.cicyouth.com",
  },
  cufc: {
    brandKey: "cufc",
    orgId: 1,
    storeName: "Christchurch United Shop",
    orderPrefix: "CUFC",
    assetBase: "https://join.cufc.co.nz",
    currency: "NZD",
    adminEmail: "info@cufc.co.nz",
    allowedOrigins: [
      /^https:\/\/(www\.)?cufc\.co\.nz$/,
      /^https:\/\/shop\.cufc\.co\.nz$/,
      /^https:\/\/(www\.)?cufcshop\.com$/,
    ],
    // Player Pay / team-link building ONLY (coach + player-share pay links) —
    // CUFC's retail shop has no team-kit-group-payment flow today. Points at
    // the Shopify domain Daniel already owns so a stray link (nothing sends
    // one today) at least resolves to a real, on-brand site instead of a
    // storefront that doesn't exist yet.
    // TODO cutover → replace with the real CUFC storefront once it's built.
    storefrontBase: "https://cufcshop.com",
  },
  siu: {
    brandKey: "siu",
    orgId: 2,
    storeName: "South Island United Store",
    orderPrefix: "SIU",
    assetBase: "https://join.southislandunited.com",
    currency: "NZD",
    adminEmail: "info@southislandunited.com",
    allowedOrigins: [
      /^https:\/\/(www\.)?southislandunited\.com$/,
      /^https:\/\/shop\.southislandunited\.com$/,
      /^https:\/\/siu-shop\.vercel\.app$/,
    ],
    storefrontBase: "https://shop.southislandunited.com",
  },
};

function shopBrand(brandKey: string): ShopBrand | undefined {
  return SHOP_BRANDS[String(brandKey || "").toLowerCase()];
}

function shopBrandByOrgId(orgId: number): ShopBrand | undefined {
  return Object.values(SHOP_BRANDS).find((b) => b.orgId === orgId);
}

// ─── Small helpers ──────────────────────────────────────────────────────────

const toDollars = (cents: number) => Math.round(cents) / 100;

/** NZ GST content of a GST-inclusive total. */
const gstContent = (totalCents: number) => Math.round((totalCents * 3) / 23);

function absUrl(brand: ShopBrand, url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith("/") ? `${brand.assetBase}${url}` : url;
}

// KELME render naming: `…_02.webp` shots are the true back views (the `…B_01`
// shots are flat fronts). Matches the storefront's BACK_RE.
const BACK_IMG_RX = /_[0-9a-z]+_02\.(webp|jpe?g|png)$/i;

/** Resolve a team-order item's colourId + back-view image for kit previews. */
async function teamKitViews(
  brand: ShopBrand,
  item: { productId: number | null; colourName: string | null } | undefined,
): Promise<{ colourId: string; backImage: string | null }> {
  if (!item?.productId) return { colourId: "", backImage: null };
  try {
    const colours = await db.select().from(shopProductColours)
      .where(eq(shopProductColours.productId, item.productId));
    const colour = colours.find((c) => c.name === item.colourName) || colours[0];
    if (!colour) return { colourId: "", backImage: null };
    const imgs = await db.select().from(shopProductImages)
      .where(eq(shopProductImages.colourId, colour.id));
    const back = imgs.find((i) => BACK_IMG_RX.test(i.url));
    return { colourId: String(colour.id), backImage: back ? absUrl(brand, back.url) : null };
  } catch {
    return { colourId: "", backImage: null };
  }
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RX = /.+@.+\..+/;

class ShopError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function slugify(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "product";
}

const ORDER_STATUSES = [
  "pending", "awaiting_players", "paid", "processing", "ready_for_pickup",
  "shipped", "completed", "cancelled", "refunded",
] as const;

/** Statuses that count as money in the till for stats. */
const PAID_STATUSES = ["paid", "processing", "ready_for_pickup", "shipped", "completed"];

// ─── Kit customisation — validation (contract in @shared/schema) ────────────
// Personalisation is included in the price ($0 — NO price impact anywhere).
// Sanitise everything that ends up in a print spec: strip control chars, cap
// lengths, and only accept sponsor logos our own upload endpoint minted
// (Supabase public shop-images bucket) so arbitrary URLs can't reach Dima.

const CONTROL_CHARS_RX = /[\u0000-\u001F\u007F]/g;
const SHIRT_NUMBER_RX = /^\d{1,2}$/;
const SHOP_LOGO_BUCKET = "shop-images";

function sanitizeText(value: any, maxLen: number): string {
  return String(value ?? "").replace(CONTROL_CHARS_RX, "").trim().slice(0, maxLen);
}

/** Public URL prefix every customer-supplied sponsor logoUrl must carry. */
function shopLogoUrlPrefix(): string {
  const base = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${SHOP_LOGO_BUCKET}/`;
}

function parseSponsorSlot(raw: any): ShopSponsorSlot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const slot: ShopSponsorSlot = {};
  const text = sanitizeText(raw.text, 60);
  if (text) slot.text = text;
  const logoUrl = String(raw.logoUrl || "").trim();
  if (logoUrl) {
    if (!process.env.SUPABASE_URL || !logoUrl.startsWith(shopLogoUrlPrefix())) {
      throw new ShopError("Sponsor logos must be uploaded through the store.");
    }
    slot.logoUrl = logoUrl; // logoUrl wins over text when both are present
  }
  return slot.text || slot.logoUrl ? slot : undefined;
}

function parseKitCustomisation(raw: any): ShopKitCustomisation | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ShopError("Kit customisation is invalid.");
  const out: ShopKitCustomisation = {};
  const teamLogo = parseSponsorSlot(raw.teamLogo);
  const front = parseSponsorSlot(raw.frontSponsor);
  const backTop = parseSponsorSlot(raw.backTopSponsor);
  const backBottom = parseSponsorSlot(raw.backBottomSponsor);
  if (teamLogo) out.teamLogo = teamLogo;
  if (front) out.frontSponsor = front;
  if (backTop) out.backTopSponsor = backTop;
  if (backBottom) out.backBottomSponsor = backBottom;
  return Object.keys(out).length > 0 ? out : null;
}

/** Shirt name ≤ 14 chars; number = 1–2 digits (kept as a string). `choice` —
 *  when the product carries print_options — enforces that choice's own
 *  needsName/needsNumber requirement. */
function parseUnitPersonalisation(raw: any, choice?: ShopPrintChoice | null): ShopUnitPersonalisation {
  const unit: ShopUnitPersonalisation = {};
  const name = sanitizeText(raw?.name, 14);
  if (name) unit.name = name;
  const number = String(raw?.number ?? "").trim();
  if (number) {
    if (!SHIRT_NUMBER_RX.test(number)) throw new ShopError("Shirt numbers must be 1–2 digits.");
    unit.number = number;
  }
  if (choice?.needsName && !unit.name) throw new ShopError(`"${choice.label}" printing needs a name.`);
  if (choice?.needsNumber && !unit.number) throw new ShopError(`"${choice.label}" printing needs a number.`);
  return unit;
}

/** Resolve one unit's printing choice against a product's print_options —
 *  `null` printOptions (every MFL/CIC/CUFC product today) accepts only an
 *  absent/"none" key and always prices at 0, so this is a no-op for them. */
function resolvePrintChoice(
  printOptions: ShopPrintOptions | null | undefined,
  rawKey: any,
): { key: string; priceCents: number; choice: ShopPrintChoice | null } {
  const key = rawKey != null && String(rawKey).trim() !== ""
    ? String(rawKey).trim()
    : (printOptions?.defaultChoice ?? "none");
  if (!printOptions) {
    if (key !== "none") throw new ShopError("This item does not support printing.");
    return { key: "none", priceCents: 0, choice: null };
  }
  const choice = printOptions.choices.find((c) => c.key === key);
  if (!choice) throw new ShopError(`Unknown printing option "${key}".`);
  return { key, priceCents: Math.round(choice.priceDollars * 100), choice };
}

/** One unit (one shirt) — sanitised personalisation + its printing choice.
 *  `unit.print` is stored ONLY when it differs from the product's own
 *  defaultChoice, so a product with no print_options (or a unit that just
 *  takes the default) produces byte-identical output to the pre-printing
 *  ShopUnitPersonalisation shape. */
function parseUnitWithPrint(
  raw: any,
  printOptions: ShopPrintOptions | null | undefined,
): { unit: ShopUnitPersonalisation; printCents: number } {
  const { key, priceCents, choice } = resolvePrintChoice(printOptions, raw?.print);
  const unit = parseUnitPersonalisation(raw, choice);
  if (printOptions && key !== printOptions.defaultChoice) unit.print = key;
  return { unit, printCents: priceCents };
}

/** Per-shirt personalisation + printing list — when present, length MUST
 *  equal qty. Printing is priced SERVER-SIDE here, from print_options; the
 *  browser only ever sends a choice key. */
function parseUnitsWithPrint(
  raw: any,
  qty: number,
  printOptions: ShopPrintOptions | null | undefined,
): { units: ShopUnitPersonalisation[] | null; printCents: number } {
  if (raw == null) {
    // No per-shirt data at all — every unit takes the default choice
    // (price 0 for every product today, but resolved properly regardless).
    const { priceCents } = resolvePrintChoice(printOptions, undefined);
    return { units: null, printCents: priceCents * qty };
  }
  if (!Array.isArray(raw)) throw new ShopError("Shirt personalisation is invalid.");
  if (raw.length !== qty) throw new ShopError("Add a name/number entry for every shirt in the line.");
  let printCents = 0;
  const units = raw.map((u) => {
    const parsed = parseUnitWithPrint(u, printOptions);
    printCents += parsed.printCents;
    return parsed.unit;
  });
  const anyPersonalised = units.some((u) => u.name || u.number || u.print);
  return { units: anyPersonalised ? units : null, printCents };
}

/** Admin: validate a product's print_options before it's stored — this shape
 *  is trusted everywhere else in the engine (pricing, catalog, checkout), so
 *  it's checked once here rather than defensively at every read site. */
function parsePrintOptionsInput(raw: any): ShopPrintOptions | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ShopError("Printing options are invalid.");
  const key = sanitizeText(raw.key, 40) || "printing";
  const label = sanitizeText(raw.label, 60) || "Printing";
  if (!Array.isArray(raw.choices) || raw.choices.length === 0) {
    throw new ShopError("Printing options need at least one choice.");
  }
  const choices: ShopPrintChoice[] = raw.choices.map((c: any) => {
    const choiceKey = sanitizeText(c?.key, 40);
    if (!choiceKey) throw new ShopError("Every printing choice needs a key.");
    const priceDollars = Number(c?.priceDollars);
    if (!Number.isFinite(priceDollars) || priceDollars < 0) {
      throw new ShopError(`Printing choice "${choiceKey}" needs a valid, non-negative price.`);
    }
    return {
      key: choiceKey,
      label: sanitizeText(c?.label, 60) || choiceKey,
      priceDollars,
      needsName: !!c?.needsName,
      needsNumber: !!c?.needsNumber,
      ...(c?.fromSquad ? { fromSquad: true } : {}),
    };
  });
  const defaultChoice = sanitizeText(raw.defaultChoice, 40) || choices[0].key;
  if (!choices.some((c) => c.key === defaultChoice)) {
    throw new ShopError("defaultChoice must match one of the printing choices.");
  }
  return { key, label, defaultChoice, choices };
}

/** Resolve each unit's `print` key to a human label (e.g. "Squad player") for
 *  the admin order-notification "print spec" — so whoever presses the heat
 *  press sees "Player · MEYN #29", not just "MEYN #29". A unit with no
 *  `print` key, or a product with no print_options at all (every MFL/CIC/CUFC
 *  product today), passes through unchanged — `printLabel` is simply absent. */
function labelPrintUnits(
  units: ShopUnitPersonalisation[] | null | undefined,
  printOptions: ShopPrintOptions | null | undefined,
): { name?: string; number?: string; printLabel?: string }[] | undefined {
  if (!units || units.length === 0) return undefined;
  if (!printOptions) return units;
  return units.map((u) => {
    if (!u.print) return u;
    const choice = printOptions.choices.find((c) => c.key === u.print);
    return choice ? { ...u, printLabel: choice.label } : u;
  });
}

/** Batch-fetch print_options for the products behind a set of order items,
 *  keyed by productId — feeds labelPrintUnits() for the order emails. */
async function printOptionsByProductForItems(
  items: { productId: number | null }[],
): Promise<Map<number, ShopPrintOptions | null>> {
  const productIds = Array.from(new Set(items.map((i) => i.productId).filter((id): id is number => id != null)));
  if (productIds.length === 0) return new Map();
  const rows = await db.select({ id: shopProducts.id, printOptions: shopProducts.printOptions })
    .from(shopProducts).where(inArray(shopProducts.id, productIds));
  return new Map(rows.map((r) => [r.id, (r.printOptions as ShopPrintOptions | null) ?? null]));
}

/** Print-spec sponsor rows for the READY TO PRINT email. */
function sponsorSummary(customisation: ShopKitCustomisation | null | undefined) {
  if (!customisation) return [];
  const slots: { label: string; slot?: ShopSponsorSlot }[] = [
    { label: "Team logo (chest crest)", slot: customisation.teamLogo },
    { label: "Front sponsor", slot: customisation.frontSponsor },
    { label: "Back top sponsor", slot: customisation.backTopSponsor },
    { label: "Back bottom sponsor", slot: customisation.backBottomSponsor },
  ];
  return slots
    .filter((s) => s.slot && (s.slot.text || s.slot.logoUrl))
    .map((s) => ({ label: s.label, text: s.slot!.text, logoUrl: s.slot!.logoUrl }));
}

// ─── Server-authoritative cart pricing (shared by quote + checkout) ─────────

interface CartItemInput { productId: number; colourId: number; size: string; qty: number }

interface PricedLine {
  product: ShopProduct;
  colour: ShopProductColour;
  variant: ShopVariant;
  qty: number;
  unitCents: number;
  /** Printing add-on total for this line (all units), priced server-side
   *  from the product's print_options. 0 for every product without one. */
  printCents: number;
  lineCents: number; // unitCents × qty + printCents
  imageUrl: string | null; // relative or absolute, as stored
  /** Parsed per-shirt personalisation + printing choice, or null when none
   *  was supplied / needed. Same shape persisted onto shop_order_items.units. */
  units: ShopUnitPersonalisation[] | null;
}

interface PricedCart {
  lines: PricedLine[];
  subtotalCents: number;
  discountCents: number;
  discount: ShopDiscountCode | null;
  shipping: ShopShippingOption;
  shippingCents: number;
  totalCents: number;
}

function discountLabel(d: ShopDiscountCode): string {
  return d.kind === "percent" ? `${d.value}% off` : `$${toDollars(d.value).toFixed(2)} off`;
}

async function priceCart(
  brand: ShopBrand,
  rawItems: any,
  discountCode: string | null | undefined,
  shippingOptionId: any,
): Promise<PricedCart> {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new ShopError("Your cart is empty.");
  if (rawItems.length > 40) throw new ShopError("Too many lines in one order.");

  const items: CartItemInput[] = rawItems.map((it: any) => ({
    productId: parseInt(String(it?.productId)),
    colourId: parseInt(String(it?.colourId)),
    size: String(it?.size || "").trim(),
    qty: parseInt(String(it?.qty)),
  }));
  for (const it of items) {
    if (!Number.isFinite(it.productId) || !Number.isFinite(it.colourId) || !it.size) {
      throw new ShopError("One of the items in your cart is invalid.");
    }
    if (!Number.isFinite(it.qty) || it.qty < 1 || it.qty > 20) {
      throw new ShopError("Quantity must be between 1 and 20.");
    }
  }

  const productIds = Array.from(new Set(items.map((i) => i.productId)));
  const products = await db.select().from(shopProducts).where(and(
    inArray(shopProducts.id, productIds),
    eq(shopProducts.organizationId, brand.orgId),
    eq(shopProducts.status, "active"),
  ));
  const colours = productIds.length > 0
    ? await db.select().from(shopProductColours).where(inArray(shopProductColours.productId, productIds))
    : [];
  const variants = productIds.length > 0
    ? await db.select().from(shopVariants).where(inArray(shopVariants.productId, productIds))
    : [];
  const images = productIds.length > 0
    ? await db.select().from(shopProductImages)
        .where(inArray(shopProductImages.productId, productIds))
        .orderBy(asc(shopProductImages.sortOrder), asc(shopProductImages.id))
    : [];

  // Aggregate demand per variant so 2 cart lines of the same variant can't
  // sneak past a stock check line-by-line.
  const demand = new Map<number, number>();

  const lines: PricedLine[] = items.map((it, idx) => {
    const product = products.find((p) => p.id === it.productId);
    if (!product) throw new ShopError("An item in your cart is no longer available.");
    const colour = colours.find((c) => c.id === it.colourId && c.productId === product.id && c.active);
    if (!colour) throw new ShopError(`That colour is no longer available for ${product.title}.`);
    const variant = variants.find((v) => v.colourId === colour.id && v.size === it.size && v.active);
    if (!variant) throw new ShopError(`Size ${it.size} is no longer available for ${product.title}.`);
    demand.set(variant.id, (demand.get(variant.id) || 0) + it.qty);
    if (demand.get(variant.id)! > variant.stock) {
      throw new ShopError(`${product.title} (${colour.name} · ${it.size}) is out of stock.`, 409);
    }
    const image = images.find((im) => im.colourId === colour.id) || images.find((im) => im.productId === product.id && im.colourId == null) || null;
    // Per-variant price wins when set (gift-card denominations); otherwise the
    // product price (all standard products, incl. every MFL kit).
    const unitCents = variant.priceCents ?? product.priceCents;
    // Printing add-on, priced server-side from the product's own
    // print_options — rawItems[idx] is index-aligned with `items` (built by
    // a straight .map above). A product with no print_options (every
    // MFL/CIC/CUFC product today) always prices printCents at 0.
    const printOptions = (product.printOptions as ShopPrintOptions | null) ?? null;
    const { units, printCents } = parseUnitsWithPrint(rawItems[idx]?.units, it.qty, printOptions);
    return {
      product, colour, variant, qty: it.qty,
      unitCents, printCents, lineCents: unitCents * it.qty + printCents,
      imageUrl: image?.url || null,
      units,
    };
  });

  const subtotalCents = lines.reduce((s, l) => s + l.lineCents, 0);

  // Discount — server-side lookup, never client-priced.
  let discount: ShopDiscountCode | null = null;
  let discountCents = 0;
  const code = String(discountCode || "").trim().toUpperCase();
  if (code) {
    const [found] = await db.select().from(shopDiscountCodes).where(and(
      eq(shopDiscountCodes.organizationId, brand.orgId),
      eq(shopDiscountCodes.code, code),
    ));
    const now = new Date();
    const valid = found
      && found.active
      && (!found.startsAt || new Date(found.startsAt) <= now)
      && (!found.endsAt || new Date(found.endsAt) >= now)
      && (found.maxUses == null || found.usedCount < found.maxUses);
    if (!valid) throw new ShopError("That discount code isn't valid.");
    discount = found!;
    discountCents = discount.kind === "percent"
      ? Math.round((subtotalCents * discount.value) / 100)
      : Math.min(discount.value, subtotalCents);
  }

  const shipId = parseInt(String(shippingOptionId));
  if (!Number.isFinite(shipId)) throw new ShopError("Pick a delivery option.");
  const [shipping] = await db.select().from(shopShippingOptions).where(and(
    eq(shopShippingOptions.id, shipId),
    eq(shopShippingOptions.organizationId, brand.orgId),
    eq(shopShippingOptions.active, true),
  ));
  if (!shipping) throw new ShopError("That delivery option isn't available.");

  const shippingCents = shipping.priceCents;
  const totalCents = subtotalCents - discountCents + shippingCents;

  return { lines, subtotalCents, discountCents, discount, shipping, shippingCents, totalCents };
}

// ─── Order-number claim (MFL-1001 incrementing per org) ─────────────────────
// Atomic claim mirrors storage.assignOrderNumber; the unique constraint on
// order_number is the backstop — a rare concurrent race retries.

async function assignShopOrderNumber(orderId: number, orgId: number, prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const result = await db.execute(sql`
        UPDATE shop_orders
        SET order_number = ${prefix} || '-' || (
          SELECT COALESCE(MAX(NULLIF(regexp_replace(order_number, '^.*-', ''), '')::int), 1000) + 1
          FROM shop_orders
          WHERE organization_id = ${orgId} AND order_number IS NOT NULL
        )
        WHERE id = ${orderId} AND order_number IS NULL
        RETURNING order_number
      `);
      const rows = result.rows as any[];
      if (rows.length > 0) return rows[0].order_number as string;
      const [existing] = await db.select({ orderNumber: shopOrders.orderNumber })
        .from(shopOrders).where(eq(shopOrders.id, orderId));
      if (existing?.orderNumber) return existing.orderNumber;
      throw new ShopError("Order not found", 404);
    } catch (e: any) {
      if (e?.code === "23505" && attempt < 3) continue; // number race — try again
      throw e;
    }
  }
  throw new Error("Could not assign an order number");
}

// ─── Idempotent finalize (webhook + client-confirm fallback share this) ─────
// Mirrors storage.confirmRegistrationOnce: an atomic pending→paid gate means
// the one-time side effects (stock decrement, discount usage, emails, the
// Purchase CAPI event) fire exactly once even when the Stripe webhook and the
// client confirm race on the same payment.

export async function finalizeShopOrderPaid(orderId: number, paymentIntentId: string): Promise<boolean> {
  const [order] = await db.update(shopOrders)
    .set({ status: "paid", paidAt: new Date(), updatedAt: new Date() })
    .where(and(eq(shopOrders.id, orderId), eq(shopOrders.status, "pending")))
    .returning();
  if (!order) return false; // already finalized (or unknown) — nothing else to do

  // Stamp the PI id if checkout didn't (or a retry PI superseded it).
  if (order.stripePaymentIntentId !== paymentIntentId) {
    await db.update(shopOrders).set({ stripePaymentIntentId: paymentIntentId })
      .where(eq(shopOrders.id, orderId)).catch(() => {});
  }

  const items = await db.select().from(shopOrderItems).where(eq(shopOrderItems.orderId, orderId));
  const brand = shopBrandByOrgId(order.organizationId);

  // Stock down (floor 0) — snapshot rows keep the truth even if a variant is gone.
  for (const item of items) {
    if (item.variantId) {
      try {
        await db.execute(sql`
          UPDATE shop_variants SET stock = GREATEST(stock - ${item.qty}, 0) WHERE id = ${item.variantId}
        `);
      } catch (e) {
        console.error(`[Shop] stock decrement failed for variant ${item.variantId}:`, e);
      }
      // WMS reservation (T13, dark-launched behind WMS_NATIVE_SYNC) — the
      // decrement above stays checkout availability's source of truth
      // unchanged (D11); this is purely additive so a variant mapped to a
      // wh_item also gets a WMS reservation for scan-at-dispatch to consume.
      // Best-effort: a reservation failure must never fail the paid order.
      if (process.env.WMS_NATIVE_SYNC === "1") {
        try {
          const [mapped] = await db.select({ id: whItems.id }).from(whItems)
            .where(eq(whItems.shopVariantId, item.variantId));
          if (mapped) {
            await runReserveStock({ itemId: mapped.id, qty: item.qty, ref: { kind: "shop_order", id: order.id } });
          }
        } catch (e) {
          console.error(`[Shop] WMS reserve failed for variant ${item.variantId}:`, e);
        }
      }
    }
  }

  // Discount usage.
  if (order.discountCode) {
    try {
      await db.execute(sql`
        UPDATE shop_discount_codes SET used_count = used_count + 1
        WHERE organization_id = ${order.organizationId} AND code = ${order.discountCode}
      `);
    } catch (e) {
      console.error("[Shop] discount used_count increment failed:", e);
    }
  }

  const printOptionsByProduct = await printOptionsByProductForItems(items);
  const emailLines: ShopOrderEmailLine[] = items.map((i) => ({
    title: i.title, colourName: i.colourName, size: i.size, qty: i.qty, lineCents: i.lineCents,
    units: labelPrintUnits(i.units, i.productId != null ? printOptionsByProduct.get(i.productId) : undefined),
  }));
  const requiresAddress = !!order.addressLine1;
  const addressSummary = requiresAddress
    ? [order.addressLine1, order.addressLine2, order.suburb, order.city, order.postcode].filter(Boolean).join(", ")
    : null;

  // Emails are best-effort — the order is already paid.
  try {
    await sendShopOrderConfirmation({
      to: order.email,
      firstName: order.firstName,
      orderNumber: order.orderNumber || `#${order.id}`,
      lines: emailLines,
      subtotalCents: order.subtotalCents,
      discountCents: order.discountCents,
      discountCode: order.discountCode,
      shippingLabel: order.shippingLabel,
      shippingCents: order.shippingCents,
      gstCents: order.gstCents,
      totalCents: order.totalCents,
      requiresAddress,
      addressSummary,
      brandKey: brand?.brandKey,
    });
  } catch (e) {
    console.error("[Shop] confirmation email failed:", e);
  }
  try {
    await sendShopOrderNotification({
      to: brand?.adminEmail || "info@minifootball.co.nz",
      orderNumber: order.orderNumber || `#${order.id}`,
      customerName: `${order.firstName} ${order.lastName}`.trim(),
      email: order.email,
      phone: order.phone,
      lines: emailLines,
      totalCents: order.totalCents,
      shippingLabel: order.shippingLabel,
      requiresAddress,
      addressSummary,
      brandKey: brand?.brandKey,
    });
  } catch (e) {
    console.error("[Shop] admin notification email failed:", e);
  }

  // Server Purchase event — the storefront fires the pixel with the SAME
  // eventId (`shop_purchase_${orderId}`) so Meta dedups the pair.
  try {
    await sendServerEvent({
      eventName: "Purchase",
      eventId: `shop_purchase_${order.id}`,
      eventTime: Math.floor(Date.now() / 1000),
      email: order.email,
      phone: order.phone || undefined,
      firstName: order.firstName,
      lastName: order.lastName,
      customData: {
        value: toDollars(order.totalCents),
        currency: order.currency || "NZD",
        content_type: "product",
        content_ids: items.map((i) => String(i.productId ?? i.title)),
        content_name: `${brand?.storeName || "Store"} Order`,
        num_items: items.reduce((s, i) => s + i.qty, 0),
      },
    });
  } catch (e) {
    console.error("[Shop] Purchase CAPI failed:", e);
  }

  console.log(`[Shop] Order ${order.orderNumber || order.id} finalized as paid (${paymentIntentId})`);
  return true;
}

// ─── Player Pay — share finalize (webhook + client-confirm share this) ──────
// Same idempotency discipline as finalizeShopOrderPaid: an atomic
// pending→paid gate on the SHARE means the receipt fires once, and an atomic
// awaiting_players→paid gate on the ORDER means the one-time team side
// effects (stock, coach + admin emails, the Purchase CAPI event) fire exactly
// once even when the last two players pay in the same second.

export async function finalizeShopSharePaid(shareId: number, paymentIntentId: string): Promise<boolean> {
  const [share] = await db.update(shopOrderShares)
    .set({ status: "paid", paidAt: new Date(), stripePaymentIntentId: paymentIntentId })
    .where(and(eq(shopOrderShares.id, shareId), eq(shopOrderShares.status, "pending")))
    .returning();
  if (!share) return false; // already finalized (or unknown)

  const [order] = await db.select().from(shopOrders).where(eq(shopOrders.id, share.orderId));
  if (!order) return true; // share row won the gate but the order is gone — nothing else to do
  const [item] = await db.select().from(shopOrderItems).where(eq(shopOrderItems.orderId, order.id));

  // Player receipt — best-effort, the share is already paid.
  try {
    await sendShopShareReceipt({
      to: share.playerEmail,
      playerName: share.playerName,
      teamName: order.teamName || "your team",
      orderNumber: order.orderNumber || `#${order.id}`,
      kitTitle: item?.title || "Team kit",
      size: share.size,
      shirtNumber: share.shirtNumber,
      amountCents: share.amountCents,
    });
  } catch (e) {
    console.error("[Shop] share receipt email failed:", e);
  }

  console.log(`[Shop] Share ${share.id} (order ${order.orderNumber || order.id}) paid (${paymentIntentId})`);

  // All paid? → flip the order.
  const [{ remaining }] = (await db.execute(sql`
    SELECT COUNT(*)::int AS remaining FROM shop_order_shares
    WHERE order_id = ${order.id} AND status <> 'paid'
  `)).rows as any[];
  if (Number(remaining) === 0) {
    await finalizeTeamOrderAllPaid(order.id);
  }
  return true;
}

/** One-time team-order completion — adapted from finalizeShopOrderPaid but
 *  gated on awaiting_players→paid and stock-decremented by ROSTER SIZE COUNTS
 *  (the single line item spans multiple size variants). */
async function finalizeTeamOrderAllPaid(orderId: number): Promise<void> {
  const [order] = await db.update(shopOrders)
    .set({ status: "paid", paidAt: new Date(), allPaidAt: new Date(), updatedAt: new Date() })
    .where(and(eq(shopOrders.id, orderId), eq(shopOrders.status, "awaiting_players")))
    .returning();
  if (!order) return; // another share's finalize already won the gate

  const brand = shopBrandByOrgId(order.organizationId);
  const [item] = await db.select().from(shopOrderItems).where(eq(shopOrderItems.orderId, order.id));
  const shares = await db.select().from(shopOrderShares)
    .where(eq(shopOrderShares.orderId, order.id))
    .orderBy(asc(shopOrderShares.id));

  // Stock down by roster size counts. The line item snapshots colourName, so
  // resolve colour → variants; if the colour/variant has since been deleted we
  // log and move on (snapshots keep the print spec intact regardless).
  if (item?.productId && item.colourName) {
    try {
      const [colour] = await db.select().from(shopProductColours).where(and(
        eq(shopProductColours.productId, item.productId),
        eq(shopProductColours.name, item.colourName),
      ));
      if (colour) {
        const sizeCounts = new Map<string, number>();
        for (const s of shares) sizeCounts.set(s.size, (sizeCounts.get(s.size) || 0) + 1);
        for (const [size, count] of Array.from(sizeCounts.entries())) {
          await db.execute(sql`
            UPDATE shop_variants SET stock = GREATEST(stock - ${count}, 0)
            WHERE colour_id = ${colour.id} AND size = ${size}
          `);
        }
      } else {
        console.error(`[Shop] team order ${order.id}: colour "${item.colourName}" no longer exists — stock not decremented`);
      }
    } catch (e) {
      console.error(`[Shop] team order ${order.id} stock decrement failed:`, e);
    }
  }

  const roster = shares.map((s) => ({ name: s.shirtName || s.playerName, number: s.shirtNumber, size: s.size }));
  const requiresAddress = !!order.addressLine1;
  const addressSummary = requiresAddress
    ? [order.addressLine1, order.addressLine2, order.suburb, order.city, order.postcode].filter(Boolean).join(", ")
    : null;

  // Emails are best-effort — the order is already paid.
  try {
    await sendShopTeamAllPaidConfirmation({
      to: order.email,
      coachFirstName: order.firstName,
      teamName: order.teamName || "Your team",
      orderNumber: order.orderNumber || `#${order.id}`,
      playerCount: shares.length,
      totalCents: order.totalCents,
      shippingLabel: order.shippingLabel,
      requiresAddress,
      addressSummary,
    });
  } catch (e) {
    console.error("[Shop] team all-paid coach email failed:", e);
  }
  try {
    await sendShopPrintReadyNotification({
      to: brand?.adminEmail || "info@minifootball.co.nz",
      orderNumber: order.orderNumber || `#${order.id}`,
      teamName: order.teamName || "—",
      coachName: `${order.firstName} ${order.lastName}`.trim(),
      coachEmail: order.email,
      coachPhone: order.phone,
      kitTitle: item?.title || "Team kit",
      colourName: item?.colourName,
      sponsors: sponsorSummary(item?.customisation),
      roster,
      totalCents: order.totalCents,
      shippingLabel: order.shippingLabel,
      requiresAddress,
      addressSummary,
    });
  } catch (e) {
    console.error("[Shop] print-ready admin email failed:", e);
  }

  // ONE server Purchase event for the FULL order total (not per share) — the
  // storefront never fires a pixel Purchase for team orders, and the eventId
  // matches the standard-checkout convention so nothing can double-count.
  try {
    await sendServerEvent({
      eventName: "Purchase",
      eventId: `shop_purchase_${order.id}`,
      eventTime: Math.floor(Date.now() / 1000),
      email: order.email,
      phone: order.phone || undefined,
      firstName: order.firstName,
      lastName: order.lastName,
      customData: {
        value: toDollars(order.totalCents),
        currency: order.currency || "NZD",
        content_type: "product",
        content_ids: item ? [String(item.productId ?? item.title)] : [],
        content_name: `${brand?.storeName || "Store"} Team Order`,
        num_items: shares.length,
      },
    });
  } catch (e) {
    console.error("[Shop] team Purchase CAPI failed:", e);
  }

  console.log(`[Shop] Team order ${order.orderNumber || order.id} fully paid — flipped to paid (${shares.length} shares)`);
}

// ─── Player Pay / upload plumbing ───────────────────────────────────────────

/** Lazy Supabase client for the PUBLIC `shop-images` bucket (sponsor logos).
 *  Separate from the private clubos-uploads object store — these URLs go
 *  straight into print-spec emails so they must be publicly fetchable. */
let shopStorageClient: SupabaseClient | null = null;
function getShopStorageClient(): SupabaseClient {
  if (!shopStorageClient) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for shop logo uploads");
    shopStorageClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return shopStorageClient;
}

/** Simple in-memory per-IP rolling-hour limiter for public logo uploads. */
const logoUploadHits = new Map<string, number[]>();
const LOGO_UPLOADS_PER_HOUR = 20;

/** In-memory remind throttle: max 1 reminder per share per 10 minutes. */
const shareRemindLast = new Map<number, number>();
const REMIND_COOLDOWN_MS = 10 * 60 * 1000;

async function loadTeamOrderByToken(brand: ShopBrand, token: string): Promise<ShopOrder | null> {
  if (!UUID_RX.test(token)) return null;
  const [order] = await db.select().from(shopOrders).where(and(
    eq(shopOrders.orderToken, token),
    eq(shopOrders.organizationId, brand.orgId),
    eq(shopOrders.paymentMode, "player_pay"),
  ));
  return order || null;
}

async function loadShareByToken(brand: ShopBrand, token: string): Promise<{ share: ShopOrderShare; order: ShopOrder } | null> {
  if (!UUID_RX.test(token)) return null;
  const [share] = await db.select().from(shopOrderShares).where(eq(shopOrderShares.shareToken, token));
  if (!share) return null;
  const [order] = await db.select().from(shopOrders).where(and(
    eq(shopOrders.id, share.orderId),
    eq(shopOrders.organizationId, brand.orgId),
  ));
  if (!order) return null;
  return { share, order };
}

// ─── Route registration ─────────────────────────────────────────────────────

export function registerShopRoutes(app: Express) {

  // CORS for the standalone storefront (shop.minifootball.co.nz, its Vercel
  // staging aliases, and local dev). Same allowlist pattern as the CUGC and
  // skills-challenge public endpoints.
  const setShopCors = (req: Request, res: Response) => {
    const origin = String(req.headers.origin || "");
    const allowed =
      Object.values(SHOP_BRANDS).some((b) => b.allowedOrigins.some((rx) => rx.test(origin))) ||
      /\.vercel\.app$/.test(origin) ||
      /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
    if (allowed) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Vary", "Origin");
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
  };
  app.use("/api/public/shop", (req: Request, res: Response, next: NextFunction) => {
    setShopCors(req, res);
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  const handleShopError = (res: Response, e: any, context: string) => {
    if (e instanceof ShopError) return res.status(e.status).json({ message: e.message });
    console.error(`[Shop] ${context} error:`, e);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  };

  // ── Public: catalog ────────────────────────────────────────────────────────
  app.get("/api/public/shop/:brand/catalog", async (req, res) => {
    try {
      const brand = shopBrand(String(req.params.brand));
      if (!brand) return res.status(404).json({ message: "Store not found" });

      const [products, shippingOptions] = await Promise.all([
        db.select().from(shopProducts).where(and(
          eq(shopProducts.organizationId, brand.orgId),
          eq(shopProducts.status, "active"),
        )).orderBy(asc(shopProducts.sortOrder), asc(shopProducts.id)),
        db.select().from(shopShippingOptions).where(and(
          eq(shopShippingOptions.organizationId, brand.orgId),
          eq(shopShippingOptions.active, true),
        )).orderBy(asc(shopShippingOptions.sortOrder), asc(shopShippingOptions.id)),
      ]);

      const productIds = products.map((p) => p.id);
      const [colours, images, variants] = productIds.length > 0
        ? await Promise.all([
            db.select().from(shopProductColours)
              .where(and(inArray(shopProductColours.productId, productIds), eq(shopProductColours.active, true)))
              .orderBy(asc(shopProductColours.sortOrder), asc(shopProductColours.id)),
            db.select().from(shopProductImages)
              .where(inArray(shopProductImages.productId, productIds))
              .orderBy(asc(shopProductImages.sortOrder), asc(shopProductImages.id)),
            db.select().from(shopVariants)
              .where(and(inArray(shopVariants.productId, productIds), eq(shopVariants.active, true))),
          ])
        : [[], [], []] as [ShopProductColour[], ShopProductImage[], ShopVariant[]];

      res.json({
        store: {
          name: brand.storeName,
          currency: brand.currency,
          shippingOptions: shippingOptions.map((s) => ({
            id: s.id,
            label: s.label,
            priceDollars: toDollars(s.priceCents),
            description: s.description || undefined,
            requiresAddress: s.requiresAddress,
          })),
        },
        products: products.map((p) => {
          const productImages = images.filter((im) => im.productId === p.id && im.colourId == null);
          const productColours = colours.filter((c) => c.productId === p.id);
          return {
            id: p.id,
            slug: p.slug,
            title: p.title,
            subtitle: p.subtitle || undefined,
            type: p.type,
            priceDollars: toDollars(p.priceCents),
            compareAtDollars: p.compareAtCents != null ? toDollars(p.compareAtCents) : undefined,
            // Printing as a priced add-on (SIU, 2026-09) — stored directly in
            // dollars (the same shape the storefront renders), null for every
            // product without one (every MFL/CIC/CUFC product today).
            printOptions: (p.printOptions as ShopPrintOptions | null) ?? null,
            images: productImages.map((im) => ({ url: absUrl(brand, im.url), alt: im.alt || p.title })),
            colours: productColours.map((c) => ({
              id: c.id,
              name: c.name,
              swatchHex: c.swatchHex || undefined,
              images: images
                .filter((im) => im.colourId === c.id)
                .map((im) => ({ url: absUrl(brand, im.url), alt: im.alt || `${p.title} — ${c.name}` })),
              sizes: variants
                .filter((v) => v.colourId === c.id)
                .map((v) => ({
                  size: v.size,
                  inStock: v.stock > 0,
                  // Only variable-price products (e.g. gift cards) carry a per-variant
                  // price; MFL kits leave this null so the field is omitted.
                  ...(v.priceCents != null ? { priceDollars: toDollars(v.priceCents) } : {}),
                })),
            })),
            description: p.description || undefined,
            badge: p.badge || undefined,
          };
        }),
      });
    } catch (e: any) {
      handleShopError(res, e, "catalog");
    }
  });

  // ── Public: quote (server-authoritative repricing) ─────────────────────────
  app.post("/api/public/shop/:brand/quote", async (req, res) => {
    try {
      const brand = shopBrand(String(req.params.brand));
      if (!brand) return res.status(404).json({ message: "Store not found" });

      const cart = await priceCart(brand, req.body?.items, req.body?.discountCode, req.body?.shippingOptionId);
      res.json({
        lines: cart.lines.map((l) => ({
          productId: l.product.id,
          colourId: l.colour.id,
          size: l.variant.size,
          qty: l.qty,
          title: l.product.title,
          colourName: l.colour.name,
          image: absUrl(brand, l.imageUrl),
          unitDollars: toDollars(l.unitCents),
          printDollars: toDollars(l.printCents),
          lineDollars: toDollars(l.lineCents), // unit×qty + printDollars
        })),
        subtotalDollars: toDollars(cart.subtotalCents),
        discountDollars: toDollars(cart.discountCents),
        shippingDollars: toDollars(cart.shippingCents),
        totalDollars: toDollars(cart.totalCents),
        ...(cart.discount ? { discount: { code: cart.discount.code, label: discountLabel(cart.discount) } } : {}),
      });
    } catch (e: any) {
      handleShopError(res, e, "quote");
    }
  });

  // ── Public: checkout → pending order + embedded PaymentIntent ─────────────
  app.post("/api/public/shop/:brand/checkout", async (req, res) => {
    try {
      const brand = shopBrand(String(req.params.brand));
      if (!brand) return res.status(404).json({ message: "Store not found" });

      const customer = req.body?.customer || {};
      const firstName = String(customer.firstName || "").trim();
      const lastName = String(customer.lastName || "").trim();
      const email = String(customer.email || "").trim();
      const phone = String(customer.phone || "").trim();
      if (!firstName || !lastName) throw new ShopError("Please add your first and last name.");
      if (!EMAIL_RX.test(email)) throw new ShopError("Please add a valid email address.");
      if (!phone) throw new ShopError("Please add your phone number."); // phone is mandatory

      const cart = await priceCart(brand, req.body?.items, req.body?.discountCode, req.body?.shippingOptionId);

      // Kit customisation (sponsor slots) is a print spec, not a priced
      // add-on — parsed separately here. Per-shirt personalisation AND its
      // printing choice (l.units / l.printCents) were already parsed and
      // priced inside priceCart, so they aren't re-parsed here — one place
      // decides what a unit costs. rawItems and cart.lines are index-aligned
      // (priceCart maps items 1:1 in order).
      const rawItems: any[] = Array.isArray(req.body?.items) ? req.body.items : [];
      const itemExtras = cart.lines.map((l, idx) => ({
        customisation: parseKitCustomisation(rawItems[idx]?.customisation),
      }));

      // Address — required only when the chosen option ships.
      const addr = req.body?.shippingAddress || {};
      const addressLine1 = String(addr.line1 || "").trim() || null;
      const addressLine2 = String(addr.line2 || "").trim() || null;
      const suburb = String(addr.suburb || "").trim() || null;
      const city = String(addr.city || "").trim() || null;
      const postcode = String(addr.postcode || "").trim() || null;
      if (cart.shipping.requiresAddress && (!addressLine1 || !city || !postcode)) {
        throw new ShopError("Please add your delivery address (street, city and postcode).");
      }

      // Stripe won't process a near-zero charge; a fully-discounted free-pickup
      // order needs a human anyway.
      if (cart.totalCents < 50) {
        throw new ShopError("Order total is too low to process online — get in touch and we'll sort it.");
      }

      // Contact upsert — same pattern as the MFL captain flow.
      let contact = await storage.findContactByEmail(email);
      if (!contact) {
        contact = await storage.createContact({
          type: "guardian", firstName, lastName, email, phone,
        } as any);
      } else {
        contact = (await storage.updateContact(contact.id, { firstName, lastName, phone } as any)) || contact;
      }

      const utm = req.body?.utm || {};
      const gstCents = gstContent(cart.totalCents);

      const [order] = await db.insert(shopOrders).values({
        organizationId: brand.orgId,
        status: "pending",
        firstName, lastName, email, phone,
        shippingOptionId: cart.shipping.id,
        shippingLabel: cart.shipping.label,
        shippingCents: cart.shippingCents,
        addressLine1: cart.shipping.requiresAddress ? addressLine1 : null,
        addressLine2: cart.shipping.requiresAddress ? addressLine2 : null,
        suburb: cart.shipping.requiresAddress ? suburb : null,
        city: cart.shipping.requiresAddress ? city : null,
        postcode: cart.shipping.requiresAddress ? postcode : null,
        subtotalCents: cart.subtotalCents,
        discountCents: cart.discountCents,
        discountCode: cart.discount?.code || null,
        gstCents,
        totalCents: cart.totalCents,
        currency: brand.currency,
        contactId: contact.id,
        source: "online",
        utmSource: utm.source || req.body?.utmSource || null,
        utmMedium: utm.medium || req.body?.utmMedium || null,
        utmCampaign: utm.campaign || req.body?.utmCampaign || null,
        utmContent: utm.content || req.body?.utmContent || null,
        utmTerm: utm.term || req.body?.utmTerm || null,
        fbclid: utm.fbclid || req.body?.fbclid || null,
        gclid: utm.gclid || req.body?.gclid || null,
        visitorId: req.body?.visitorId || null,
        notes: String(req.body?.notes || "").trim() || null,
      }).returning();

      const orderNumber = await assignShopOrderNumber(order.id, brand.orgId, brand.orderPrefix);

      await db.insert(shopOrderItems).values(cart.lines.map((l, idx) => ({
        orderId: order.id,
        productId: l.product.id,
        variantId: l.variant.id,
        title: l.product.title,
        colourName: l.colour.name,
        size: l.variant.size,
        imageUrl: l.imageUrl,
        unitCents: l.unitCents,
        printCents: l.printCents,
        qty: l.qty,
        lineCents: l.lineCents,
        costUsdSnapshot: l.product.costUsd, // reference only — never calculated with
        customisation: itemExtras[idx].customisation,
        units: l.units,
      })));

      // Embedded PaymentElement flow — our own on-brand card form, no hosted
      // Checkout, no redirect. NB: metadata carries shopOrderId (NOT
      // registrationId) so the webhook's registration branches never fire.
      const intent = await stripe.paymentIntents.create(
        {
          amount: cart.totalCents,
          currency: brand.currency.toLowerCase(),
          receipt_email: email,
          automatic_payment_methods: { enabled: true },
          description: `${brand.storeName} — Order ${orderNumber}`,
          metadata: {
            registrationType: "shop_order",
            shopOrderId: String(order.id),
            orgId: String(brand.orgId),
            brand: brand.brandKey,
          },
        },
        { idempotencyKey: `shop_order_${order.id}` },
      );

      await db.update(shopOrders)
        .set({ stripePaymentIntentId: intent.id })
        .where(eq(shopOrders.id, order.id));

      res.json({
        orderId: order.id,
        orderToken: order.orderToken,
        orderNumber,
        clientSecret: intent.client_secret,
        publishableKey: process.env.VITE_STRIPE_PUBLISHABLE_KEY || process.env.STRIPE_PUBLISHABLE_KEY || "",
        totalDollars: toDollars(cart.totalCents),
      });
    } catch (e: any) {
      handleShopError(res, e, "checkout");
    }
  });

  // ── Public: order status by token ──────────────────────────────────────────
  app.get("/api/public/shop/:brand/order/:orderToken", async (req, res) => {
    try {
      const brand = shopBrand(String(req.params.brand));
      if (!brand) return res.status(404).json({ message: "Store not found" });
      const token = String(req.params.orderToken || "");
      if (!UUID_RX.test(token)) return res.status(404).json({ message: "Order not found" });

      const [order] = await db.select().from(shopOrders).where(and(
        eq(shopOrders.orderToken, token),
        eq(shopOrders.organizationId, brand.orgId),
      ));
      if (!order) return res.status(404).json({ message: "Order not found" });

      const simplified = (order.status === "pending" || order.status === "awaiting_players") ? "pending"
        : (order.status === "cancelled" || order.status === "refunded") ? "failed"
        : "paid";

      if (simplified === "pending") return res.json({ status: "pending" });

      const items = await db.select().from(shopOrderItems).where(eq(shopOrderItems.orderId, order.id));
      res.json({
        status: simplified,
        orderNumber: order.orderNumber || undefined,
        summary: {
          lines: items.map((i) => ({
            title: i.title,
            colourName: i.colourName || undefined,
            size: i.size || undefined,
            qty: i.qty,
            image: absUrl(brand, i.imageUrl),
            unitDollars: toDollars(i.unitCents),
            printDollars: toDollars(i.printCents),
            lineDollars: toDollars(i.lineCents),
          })),
          totalDollars: toDollars(order.totalCents),
          shippingLabel: order.shippingLabel || undefined,
        },
      });
    } catch (e: any) {
      handleShopError(res, e, "order status");
    }
  });

  // ── Public: client confirm fallback (mirrors /api/public/confirm-payment) ──
  app.post("/api/public/shop/:brand/order/:orderToken/confirm", async (req, res) => {
    try {
      const brand = shopBrand(String(req.params.brand));
      if (!brand) return res.status(404).json({ message: "Store not found" });
      const token = String(req.params.orderToken || "");
      if (!UUID_RX.test(token)) return res.status(404).json({ message: "Order not found" });

      const [order] = await db.select().from(shopOrders).where(and(
        eq(shopOrders.orderToken, token),
        eq(shopOrders.organizationId, brand.orgId),
      ));
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.status !== "pending") return res.json({ ok: true, alreadyConfirmed: true });
      if (!order.stripePaymentIntentId) return res.status(400).json({ message: "No payment intent" });

      const pi = await retrievePaymentIntent(order.stripePaymentIntentId);
      if (pi.status !== "succeeded") return res.status(400).json({ message: "Payment not completed" });
      if (pi.metadata?.shopOrderId && parseInt(pi.metadata.shopOrderId) !== order.id) {
        return res.status(403).json({ message: "Payment mismatch" });
      }

      await finalizeShopOrderPaid(order.id, pi.id);
      res.json({ ok: true });
    } catch (e: any) {
      handleShopError(res, e, "confirm");
    }
  });

  // ── Public: sponsor logo upload (kit customisation) ───────────────────────
  // Multipart field `file`, ≤5MB, image-only. sharp validates + normalises
  // (rotate, ≤1200px, webp q85) → PUBLIC Supabase bucket `shop-images` at
  // {brand}/custom/{uuid}.webp. The returned URL is the ONLY logoUrl shape
  // checkout accepts (prefix-checked), so arbitrary URLs can't enter specs.
  const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
  app.post(
    "/api/public/shop/:brand/upload-logo",
    (req: Request, res: Response, next: NextFunction) => {
      logoUpload.single("file")(req, res, (err: any) => {
        if (err) {
          const msg = err?.code === "LIMIT_FILE_SIZE" ? "Logo too big — max 5MB" : err?.message || "Upload rejected";
          return res.status(400).json({ message: msg });
        }
        next();
      });
    },
    async (req: Request, res: Response) => {
      try {
        const brand = shopBrand(String(req.params.brand));
        if (!brand) return res.status(404).json({ message: "Store not found" });

        const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim() || "unknown";
        const now = Date.now();
        const hits = (logoUploadHits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
        if (hits.length >= LOGO_UPLOADS_PER_HOUR) {
          return res.status(429).json({ message: "Too many uploads — try again in a bit." });
        }
        hits.push(now);
        logoUploadHits.set(ip, hits);

        const file = (req as any).file;
        if (!file) throw new ShopError("No file uploaded.");
        const sharp = (await import("sharp")).default;
        let meta: import("sharp").Metadata;
        try {
          meta = await sharp(file.buffer, { failOn: "error", animated: false, limitInputPixels: 50_000_000 }).metadata();
        } catch {
          throw new ShopError("That file isn't a valid image.");
        }
        if (!meta.format || !["jpeg", "jpg", "png", "webp", "avif", "gif"].includes(meta.format)) {
          throw new ShopError("Upload a JPG, PNG or WebP image.");
        }
        const buf = await sharp(file.buffer)
          .rotate()
          .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 85, effort: 4 })
          .toBuffer();

        const path = `${brand.brandKey}/custom/${randomUUID()}.webp`;
        const { error } = await getShopStorageClient().storage
          .from(SHOP_LOGO_BUCKET)
          .upload(path, buf, { contentType: "image/webp", cacheControl: "public, max-age=31536000", upsert: false });
        if (error) throw new Error(`Supabase logo upload failed: ${error.message}`);

        res.json({ url: `${shopLogoUrlPrefix()}${path}` });
      } catch (e: any) {
        handleShopError(res, e, "upload logo");
      }
    },
  );

  // ── Public: Player Pay — team checkout (coach sets up, players pay) ───────
  // No money moves here: the order is created as awaiting_players and each
  // player gets a personal pay link. Discounts are deliberately OMITTED for
  // team orders (v1). Personalisation stays $0 — included in the unit price.
  app.post("/api/public/shop/:brand/team-checkout", async (req, res) => {
    try {
      const brand = shopBrand(String(req.params.brand));
      if (!brand) return res.status(404).json({ message: "Store not found" });

      const coach = req.body?.coach || {};
      const firstName = sanitizeText(coach.firstName, 40);
      const lastName = sanitizeText(coach.lastName, 40);
      const email = String(coach.email || "").trim();
      const phone = String(coach.phone || "").trim();
      if (!firstName || !lastName) throw new ShopError("Please add your first and last name.");
      if (!EMAIL_RX.test(email)) throw new ShopError("Please add a valid email address.");
      if (!phone) throw new ShopError("Please add your phone number."); // phone is mandatory

      const teamName = sanitizeText(req.body?.teamName, 40);
      if (!teamName) throw new ShopError("Please add your team name.");

      const rawPlayers: any[] = Array.isArray(req.body?.players) ? req.body.players : [];
      if (rawPlayers.length < 2) throw new ShopError("Player Pay needs at least 2 players.");
      if (rawPlayers.length > 30) throw new ShopError("Player Pay supports up to 30 players per order.");
      const players = rawPlayers.map((p, i) => {
        const name = sanitizeText(p?.name, 30);
        if (!name) throw new ShopError(`Player ${i + 1} needs a name.`);
        const number = String(p?.number ?? "").trim();
        if (number && !SHIRT_NUMBER_RX.test(number)) throw new ShopError(`${name}'s shirt number must be 1–2 digits.`);
        const size = sanitizeText(p?.size, 20);
        if (!size) throw new ShopError(`${name} needs a size.`);
        const playerEmail = String(p?.email || "").trim();
        if (!EMAIL_RX.test(playerEmail)) throw new ShopError(`${name} needs a valid email address.`);
        const playerPhone = String(p?.phone || "").trim() || null;
        return { name, number: number || null, size, email: playerEmail, phone: playerPhone };
      });

      const productId = parseInt(String(req.body?.productId));
      const colourId = parseInt(String(req.body?.colourId));
      if (!Number.isFinite(productId) || !Number.isFinite(colourId)) throw new ShopError("Pick a kit and colour.");
      const [product] = await db.select().from(shopProducts).where(and(
        eq(shopProducts.id, productId),
        eq(shopProducts.organizationId, brand.orgId),
        eq(shopProducts.status, "active"),
      ));
      if (!product) throw new ShopError("That kit is no longer available.");
      const [colour] = await db.select().from(shopProductColours).where(and(
        eq(shopProductColours.id, colourId),
        eq(shopProductColours.productId, product.id),
        eq(shopProductColours.active, true),
      ));
      if (!colour) throw new ShopError(`That colour is no longer available for ${product.title}.`);

      // Aggregate stock check per size across the whole roster.
      const variants = await db.select().from(shopVariants).where(and(
        eq(shopVariants.colourId, colour.id),
        eq(shopVariants.active, true),
      ));
      const sizeCounts = new Map<string, number>();
      for (const p of players) sizeCounts.set(p.size, (sizeCounts.get(p.size) || 0) + 1);
      for (const [size, count] of Array.from(sizeCounts.entries())) {
        const variant = variants.find((v) => v.size === size);
        if (!variant) throw new ShopError(`Size ${size} isn't available for ${product.title}.`);
        if (count > variant.stock) {
          throw new ShopError(`${product.title} (${colour.name} · ${size}) doesn't have enough stock for your roster.`, 409);
        }
      }

      const customisation = parseKitCustomisation(req.body?.customisation);

      // Shipping — same lookup as priceCart. NOTE: no discount codes on team
      // orders (v1 — deliberately omitted).
      const shipId = parseInt(String(req.body?.shippingOptionId));
      if (!Number.isFinite(shipId)) throw new ShopError("Pick a delivery option.");
      const [shipping] = await db.select().from(shopShippingOptions).where(and(
        eq(shopShippingOptions.id, shipId),
        eq(shopShippingOptions.organizationId, brand.orgId),
        eq(shopShippingOptions.active, true),
      ));
      if (!shipping) throw new ShopError("That delivery option isn't available.");

      const addr = req.body?.shippingAddress || {};
      const addressLine1 = String(addr.line1 || "").trim() || null;
      const addressLine2 = String(addr.line2 || "").trim() || null;
      const suburb = String(addr.suburb || "").trim() || null;
      const city = String(addr.city || "").trim() || null;
      const postcode = String(addr.postcode || "").trim() || null;
      if (shipping.requiresAddress && (!addressLine1 || !city || !postcode)) {
        throw new ShopError("Please add the delivery address (street, city and postcode).");
      }

      // Totals: roster × unit price + shipping (GST-inclusive, as elsewhere).
      const unitCents = product.priceCents;
      const subtotalCents = unitCents * players.length;
      const totalCents = subtotalCents + shipping.priceCents;
      const gstCents = gstContent(totalCents);

      // Share split: unit price + an even shipping split, remainder cents on
      // the LAST share — the shares MUST sum exactly to totalCents.
      const shipSplit = Math.floor(shipping.priceCents / players.length);
      const shipRemainder = shipping.priceCents - shipSplit * players.length;
      const shareAmounts = players.map((_, i) =>
        unitCents + shipSplit + (i === players.length - 1 ? shipRemainder : 0));
      // (n × unit) + (n × split) + remainder === subtotal + shipping === total
      if (shareAmounts.reduce((s, a) => s + a, 0) !== totalCents) {
        throw new Error("Share split doesn't sum to the order total"); // invariant — never user-visible
      }
      // Stripe won't process a near-zero charge — each share is its own PI.
      if (shareAmounts.some((a) => a < 50)) {
        throw new ShopError("Each player's share is too small to process online — get in touch and we'll sort it.");
      }

      // Contact upsert — the coach, same pattern as the standard checkout.
      let contact = await storage.findContactByEmail(email);
      if (!contact) {
        contact = await storage.createContact({
          type: "guardian", firstName, lastName, email, phone,
        } as any);
      } else {
        contact = (await storage.updateContact(contact.id, { firstName, lastName, phone } as any)) || contact;
      }

      const utm = req.body?.utm || {};
      const [order] = await db.insert(shopOrders).values({
        organizationId: brand.orgId,
        status: "awaiting_players",
        paymentMode: "player_pay",
        teamName,
        firstName, lastName, email, phone,
        shippingOptionId: shipping.id,
        shippingLabel: shipping.label,
        shippingCents: shipping.priceCents,
        addressLine1: shipping.requiresAddress ? addressLine1 : null,
        addressLine2: shipping.requiresAddress ? addressLine2 : null,
        suburb: shipping.requiresAddress ? suburb : null,
        city: shipping.requiresAddress ? city : null,
        postcode: shipping.requiresAddress ? postcode : null,
        subtotalCents,
        discountCents: 0,
        discountCode: null,
        gstCents,
        totalCents,
        currency: brand.currency,
        contactId: contact.id,
        source: "online",
        utmSource: utm.source || req.body?.utmSource || null,
        utmMedium: utm.medium || req.body?.utmMedium || null,
        utmCampaign: utm.campaign || req.body?.utmCampaign || null,
        utmContent: utm.content || req.body?.utmContent || null,
        utmTerm: utm.term || req.body?.utmTerm || null,
        fbclid: utm.fbclid || req.body?.fbclid || null,
        gclid: utm.gclid || req.body?.gclid || null,
        visitorId: req.body?.visitorId || null,
        notes: String(req.body?.notes || "").trim() || null,
      }).returning();

      const orderNumber = await assignShopOrderNumber(order.id, brand.orgId, brand.orderPrefix);

      // ONE line item spanning the roster: qty = player count, per-shirt
      // names/numbers in units, sponsor slots in customisation. variantId is
      // null (sizes vary) — team stock decrements by roster size counts at
      // the all-paid finalize instead.
      const images = await db.select().from(shopProductImages)
        .where(eq(shopProductImages.productId, product.id))
        .orderBy(asc(shopProductImages.sortOrder), asc(shopProductImages.id));
      const image = images.find((im) => im.colourId === colour.id) || images.find((im) => im.colourId == null) || null;
      await db.insert(shopOrderItems).values({
        orderId: order.id,
        productId: product.id,
        variantId: null,
        title: product.title,
        colourName: colour.name,
        size: null,
        imageUrl: image?.url || null,
        unitCents,
        qty: players.length,
        lineCents: subtotalCents,
        costUsdSnapshot: product.costUsd, // reference only — never calculated with
        customisation,
        units: players.map((p) => ({
          ...(p.name ? { name: p.name } : {}),
          ...(p.number ? { number: p.number } : {}),
        })),
      });

      const shares = await db.insert(shopOrderShares).values(players.map((p, i) => ({
        orderId: order.id,
        playerName: p.name,
        playerEmail: p.email,
        playerPhone: p.phone,
        size: p.size,
        shirtName: p.name,
        shirtNumber: p.number,
        amountCents: shareAmounts[i],
      }))).returning();

      // Emails — best-effort; the order + pay links exist regardless.
      const coachUrl = `${brand.storefrontBase}/team/${order.orderToken}`;
      for (const s of shares) {
        try {
          await sendShopShareInvite({
            to: s.playerEmail,
            coachFirstName: firstName,
            teamName,
            kitTitle: product.title,
            colourName: colour.name,
            playerName: s.playerName,
            shirtNumber: s.shirtNumber,
            size: s.size,
            amountCents: s.amountCents,
            payUrl: `${brand.storefrontBase}/pay/${s.shareToken}`,
          });
        } catch (e) {
          console.error(`[Shop] share invite email failed (${s.playerEmail}):`, e);
        }
      }
      try {
        await sendShopTeamSetupSummary({
          to: email,
          coachFirstName: firstName,
          teamName,
          orderNumber,
          kitTitle: product.title,
          colourName: colour.name,
          players: shares.map((s) => ({ name: s.playerName, number: s.shirtNumber, size: s.size, amountCents: s.amountCents })),
          totalCents,
          coachUrl,
        });
      } catch (e) {
        console.error("[Shop] team setup summary email failed:", e);
      }

      res.json({
        orderId: order.id,
        orderToken: order.orderToken,
        orderNumber,
        coachUrl,
        totalDollars: toDollars(totalCents),
        shares: shares.map((s) => ({
          playerName: s.playerName,
          size: s.size,
          amountDollars: toDollars(s.amountCents),
          status: s.status,
          payUrl: `${brand.storefrontBase}/pay/${s.shareToken}`,
          shareToken: s.shareToken,
        })),
      });
    } catch (e: any) {
      handleShopError(res, e, "team checkout");
    }
  });

  // ── Public: Player Pay — coach/team status by order token ─────────────────
  app.get("/api/public/shop/:brand/team/:orderToken", async (req, res) => {
    try {
      const brand = shopBrand(String(req.params.brand));
      if (!brand) return res.status(404).json({ message: "Store not found" });
      const order = await loadTeamOrderByToken(brand, String(req.params.orderToken || ""));
      if (!order) return res.status(404).json({ message: "Order not found" }); // generic on bad token

      const [item] = await db.select().from(shopOrderItems).where(eq(shopOrderItems.orderId, order.id));
      const shares = await db.select().from(shopOrderShares)
        .where(eq(shopOrderShares.orderId, order.id))
        .orderBy(asc(shopOrderShares.id));
      const paidCount = shares.filter((s) => s.status === "paid").length;
      const views = await teamKitViews(brand, item);

      res.json({
        orderNumber: order.orderNumber || `#${order.id}`,
        teamName: order.teamName,
        coachFirstName: order.firstName,
        product: {
          productId: String(item?.productId ?? ""),
          colourId: views.colourId,
          title: item?.title || "Team kit",
          colourName: item?.colourName || null,
          image: absUrl(brand, item?.imageUrl),
          backImage: views.backImage,
        },
        customisation: item?.customisation || null,
        unitDollars: toDollars(item?.unitCents ?? 0),
        shippingLabel: order.shippingLabel,
        shippingDollars: toDollars(order.shippingCents ?? 0),
        totalDollars: toDollars(order.totalCents),
        paidCount,
        playerCount: shares.length,
        allPaid: shares.length > 0 && paidCount === shares.length,
        // `shares` is the storefront contract; `players` kept as a back-compat alias.
        shares: shares.map((s) => ({
          playerName: s.playerName,
          playerNumber: s.shirtNumber,
          size: s.size,
          amountDollars: toDollars(s.amountCents),
          status: s.status,
          payUrl: `${brand.storefrontBase}/pay/${s.shareToken}`,
          shareToken: s.shareToken,
          paidAt: s.paidAt,
        })),
        players: shares.map((s) => ({
          name: s.playerName,
          number: s.shirtNumber,
          size: s.size,
          amountDollars: toDollars(s.amountCents),
          status: s.status,
          payUrl: `${brand.storefrontBase}/pay/${s.shareToken}`,
          paidAt: s.paidAt,
        })),
      });
    } catch (e: any) {
      handleShopError(res, e, "team status");
    }
  });

  // ── Public: Player Pay — coach re-sends a player's invite ─────────────────
  app.post("/api/public/shop/:brand/team/:orderToken/remind", async (req, res) => {
    try {
      const brand = shopBrand(String(req.params.brand));
      if (!brand) return res.status(404).json({ message: "Store not found" });
      const order = await loadTeamOrderByToken(brand, String(req.params.orderToken || ""));
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.status !== "awaiting_players") throw new ShopError("This order is no longer collecting payments.");

      const shareToken = String(req.body?.shareToken || "");
      if (!UUID_RX.test(shareToken)) return res.status(404).json({ message: "Player not found" });
      const [share] = await db.select().from(shopOrderShares).where(and(
        eq(shopOrderShares.shareToken, shareToken),
        eq(shopOrderShares.orderId, order.id),
      ));
      if (!share) return res.status(404).json({ message: "Player not found" });
      if (share.status === "paid") throw new ShopError(`${share.playerName} has already paid.`);

      const last = shareRemindLast.get(share.id) || 0;
      if (Date.now() - last < REMIND_COOLDOWN_MS) {
        throw new ShopError("A reminder was sent to that player in the last few minutes — give them a moment.", 429);
      }

      const [item] = await db.select().from(shopOrderItems).where(eq(shopOrderItems.orderId, order.id));
      await sendShopShareInvite({
        to: share.playerEmail,
        coachFirstName: order.firstName,
        teamName: order.teamName || "your team",
        kitTitle: item?.title || "Team kit",
        colourName: item?.colourName,
        playerName: share.playerName,
        shirtNumber: share.shirtNumber,
        size: share.size,
        amountCents: share.amountCents,
        payUrl: `${brand.storefrontBase}/pay/${share.shareToken}`,
      });
      shareRemindLast.set(share.id, Date.now());
      res.json({ ok: true });
    } catch (e: any) {
      handleShopError(res, e, "team remind");
    }
  });

  // ── Public: Player Pay — a player's share by share token ──────────────────
  app.get("/api/public/shop/:brand/share/:shareToken", async (req, res) => {
    try {
      const brand = shopBrand(String(req.params.brand));
      if (!brand) return res.status(404).json({ message: "Store not found" });
      const found = await loadShareByToken(brand, String(req.params.shareToken || ""));
      if (!found) return res.status(404).json({ message: "Not found" }); // generic on bad token
      const { share, order } = found;

      const [item] = await db.select().from(shopOrderItems).where(eq(shopOrderItems.orderId, order.id));
      const views = await teamKitViews(brand, item);
      res.json({
        orderNumber: order.orderNumber || `#${order.id}`,
        teamName: order.teamName,
        coachFirstName: order.firstName,
        // Flat fields are the storefront contract; nested `player` kept as alias.
        playerName: share.playerName,
        playerNumber: share.shirtNumber,
        size: share.size,
        player: { name: share.playerName, number: share.shirtNumber, size: share.size },
        customisation: item?.customisation || null,
        product: {
          title: item?.title || "Team kit",
          colourName: item?.colourName || null,
          image: absUrl(brand, item?.imageUrl),
          backImage: views.backImage,
        },
        amountDollars: toDollars(share.amountCents),
        status: share.status,
      });
    } catch (e: any) {
      handleShopError(res, e, "share status");
    }
  });

  // ── Public: Player Pay — share PaymentIntent (embedded PaymentElement) ────
  app.post("/api/public/shop/:brand/share/:shareToken/intent", async (req, res) => {
    try {
      const brand = shopBrand(String(req.params.brand));
      if (!brand) return res.status(404).json({ message: "Store not found" });
      const found = await loadShareByToken(brand, String(req.params.shareToken || ""));
      if (!found) return res.status(404).json({ message: "Not found" });
      const { share, order } = found;

      if (share.status !== "pending") throw new ShopError("This share has already been paid.", 409);
      if (order.status !== "awaiting_players") throw new ShopError("This order is no longer collecting payments.", 409);

      const publishableKey = process.env.VITE_STRIPE_PUBLISHABLE_KEY || process.env.STRIPE_PUBLISHABLE_KEY || "";

      // Reuse an in-flight PI for this share instead of minting a fresh one on
      // every page load — one player, one live PaymentIntent.
      if (share.stripePaymentIntentId) {
        try {
          const existing = await retrievePaymentIntent(share.stripePaymentIntentId);
          if (existing.status === "succeeded") {
            await finalizeShopSharePaid(share.id, existing.id);
            throw new ShopError("This share has already been paid.", 409);
          }
          const reusable = ["requires_payment_method", "requires_confirmation", "requires_action", "processing"];
          if (reusable.includes(existing.status) && existing.amount === share.amountCents) {
            return res.json({
              clientSecret: existing.client_secret,
              publishableKey,
              amountDollars: toDollars(share.amountCents),
            });
          }
        } catch (e: any) {
          if (e instanceof ShopError) throw e;
          // stale/canceled PI — fall through and mint a new one
        }
      }

      // First creation uses a stable key (double-clicks collapse into one PI);
      // replacements after a stale PI get a fresh key so Stripe doesn't hand
      // back the unusable one.
      const idempotencyKey = share.stripePaymentIntentId
        ? `shop_share_${share.id}_${Date.now()}`
        : `shop_share_${share.id}`;
      const intent = await stripe.paymentIntents.create(
        {
          amount: share.amountCents,
          currency: brand.currency.toLowerCase(),
          receipt_email: share.playerEmail,
          automatic_payment_methods: { enabled: true },
          description: `${brand.storeName} — ${order.teamName || "Team"} kit share (${share.playerName})`,
          metadata: {
            registrationType: "shop_share",
            shopShareId: String(share.id),
            shopOrderId: String(order.id),
            orgId: String(brand.orgId),
            brand: brand.brandKey,
          },
        },
        { idempotencyKey },
      );

      await db.update(shopOrderShares)
        .set({ stripePaymentIntentId: intent.id })
        .where(eq(shopOrderShares.id, share.id));

      res.json({
        clientSecret: intent.client_secret,
        publishableKey,
        amountDollars: toDollars(share.amountCents),
      });
    } catch (e: any) {
      handleShopError(res, e, "share intent");
    }
  });

  // ── Public: Player Pay — client confirm fallback (mirrors the webhook) ────
  app.post("/api/public/shop/:brand/share/:shareToken/confirm", async (req, res) => {
    try {
      const brand = shopBrand(String(req.params.brand));
      if (!brand) return res.status(404).json({ message: "Store not found" });
      const found = await loadShareByToken(brand, String(req.params.shareToken || ""));
      if (!found) return res.status(404).json({ message: "Not found" });
      const { share } = found;

      if (share.status === "paid") return res.json({ ok: true, alreadyConfirmed: true });
      if (!share.stripePaymentIntentId) return res.status(400).json({ message: "No payment intent" });

      const pi = await retrievePaymentIntent(share.stripePaymentIntentId);
      if (pi.status !== "succeeded") return res.status(400).json({ message: "Payment not completed" });
      if (pi.metadata?.shopShareId && parseInt(pi.metadata.shopShareId) !== share.id) {
        return res.status(403).json({ message: "Payment mismatch" });
      }

      await finalizeShopSharePaid(share.id, pi.id);
      res.json({ ok: true });
    } catch (e: any) {
      handleShopError(res, e, "share confirm");
    }
  });

  // ═══ Admin — everything below is requireAuth + requireTab("store") ═════════
  // ("store" is in SUPER_ADMIN_ONLY_TABS for the pilot — Daniel-only dark launch.)

  const adminOrgId = (req: Request): number => {
    const orgId = parseInt(String(req.query.orgId || req.body?.organizationId || ""));
    if (!Number.isFinite(orgId)) throw new ShopError("orgId required");
    return orgId;
  };

  // ── Admin: products (nested colours / images / variants) ──────────────────
  app.get("/api/admin/shop/products", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const orgId = adminOrgId(req);
      const products = await db.select().from(shopProducts)
        .where(eq(shopProducts.organizationId, orgId))
        .orderBy(asc(shopProducts.sortOrder), asc(shopProducts.id));
      const ids = products.map((p) => p.id);
      const [colours, images, variants] = ids.length > 0
        ? await Promise.all([
            db.select().from(shopProductColours).where(inArray(shopProductColours.productId, ids))
              .orderBy(asc(shopProductColours.sortOrder), asc(shopProductColours.id)),
            db.select().from(shopProductImages).where(inArray(shopProductImages.productId, ids))
              .orderBy(asc(shopProductImages.sortOrder), asc(shopProductImages.id)),
            db.select().from(shopVariants).where(inArray(shopVariants.productId, ids))
              .orderBy(asc(shopVariants.id)),
          ])
        : [[], [], []] as [ShopProductColour[], ShopProductImage[], ShopVariant[]];
      res.json(products.map((p) => ({
        ...p,
        colours: colours.filter((c) => c.productId === p.id).map((c) => ({
          ...c,
          images: images.filter((im) => im.colourId === c.id),
          variants: variants.filter((v) => v.colourId === c.id),
        })),
        images: images.filter((im) => im.productId === p.id && im.colourId == null),
        totalStock: variants.filter((v) => v.productId === p.id && v.active).reduce((s, v) => s + v.stock, 0),
      })));
    } catch (e: any) {
      handleShopError(res, e, "admin products list");
    }
  });

  app.post("/api/admin/shop/products", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const orgId = adminOrgId(req);
      const title = String(req.body?.title || "").trim();
      if (!title) throw new ShopError("Title is required");
      const slug = slugify(String(req.body?.slug || "").trim() || title);
      const [created] = await db.insert(shopProducts).values({
        organizationId: orgId,
        slug,
        title,
        subtitle: String(req.body?.subtitle || "").trim() || null,
        description: String(req.body?.description || "").trim() || null,
        type: String(req.body?.type || "shirt").trim() || "shirt",
        priceCents: parseInt(String(req.body?.priceCents)) || 0,
        compareAtCents: req.body?.compareAtCents != null && req.body.compareAtCents !== "" ? parseInt(String(req.body.compareAtCents)) : null,
        costUsd: req.body?.costUsd != null && req.body.costUsd !== "" ? String(req.body.costUsd) : null,
        badge: String(req.body?.badge || "").trim() || null,
        status: ["draft", "active", "archived"].includes(req.body?.status) ? req.body.status : "draft",
        sortOrder: parseInt(String(req.body?.sortOrder)) || 0,
        printOptions: parsePrintOptionsInput(req.body?.printOptions),
      }).returning();
      res.status(201).json(created);
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "A product with that slug already exists in this store." });
      handleShopError(res, e, "admin product create");
    }
  });

  app.patch("/api/admin/shop/products/:id", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      const patch: Record<string, any> = { updatedAt: new Date() };
      const b = req.body || {};
      if (b.title !== undefined) patch.title = String(b.title).trim();
      if (b.slug !== undefined) patch.slug = slugify(String(b.slug));
      if (b.subtitle !== undefined) patch.subtitle = String(b.subtitle).trim() || null;
      if (b.description !== undefined) patch.description = String(b.description).trim() || null;
      if (b.type !== undefined) patch.type = String(b.type).trim() || "shirt";
      if (b.priceCents !== undefined) patch.priceCents = parseInt(String(b.priceCents)) || 0;
      if (b.compareAtCents !== undefined) patch.compareAtCents = b.compareAtCents === null || b.compareAtCents === "" ? null : parseInt(String(b.compareAtCents));
      if (b.costUsd !== undefined) patch.costUsd = b.costUsd === null || b.costUsd === "" ? null : String(b.costUsd);
      if (b.badge !== undefined) patch.badge = String(b.badge).trim() || null;
      if (b.status !== undefined && ["draft", "active", "archived"].includes(b.status)) patch.status = b.status;
      if (b.sortOrder !== undefined) patch.sortOrder = parseInt(String(b.sortOrder)) || 0;
      // Printing as a priced add-on (SIU, 2026-09) — null clears it (no
      // printing offered), an object is validated before it's ever trusted
      // by pricing/catalog/checkout.
      if (b.printOptions !== undefined) patch.printOptions = parsePrintOptionsInput(b.printOptions);
      const [updated] = await db.update(shopProducts).set(patch).where(eq(shopProducts.id, id)).returning();
      if (!updated) return res.status(404).json({ message: "Product not found" });
      res.json(updated);
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "A product with that slug already exists in this store." });
      handleShopError(res, e, "admin product update");
    }
  });

  app.delete("/api/admin/shop/products/:id", requireAuth, requireTab("store"), async (req, res) => {
    try {
      await db.delete(shopProducts).where(eq(shopProducts.id, parseInt(String(req.params.id))));
      res.json({ ok: true });
    } catch (e: any) {
      handleShopError(res, e, "admin product delete");
    }
  });

  app.post("/api/admin/shop/products/reorder", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map((v: any) => parseInt(v)).filter(Number.isFinite) : [];
      for (let i = 0; i < ids.length; i++) {
        await db.update(shopProducts).set({ sortOrder: i, updatedAt: new Date() }).where(eq(shopProducts.id, ids[i]));
      }
      res.json({ ok: true });
    } catch (e: any) {
      handleShopError(res, e, "admin product reorder");
    }
  });

  // ── Admin: colours ─────────────────────────────────────────────────────────
  app.post("/api/admin/shop/products/:id/colours", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const productId = parseInt(String(req.params.id));
      const name = String(req.body?.name || "").trim();
      if (!name) throw new ShopError("Colour name is required");
      const existing = await db.select({ id: shopProductColours.id }).from(shopProductColours)
        .where(eq(shopProductColours.productId, productId));
      const [created] = await db.insert(shopProductColours).values({
        productId,
        name,
        swatchHex: String(req.body?.swatchHex || "").trim() || null,
        sortOrder: existing.length,
        active: true,
      }).returning();
      res.status(201).json(created);
    } catch (e: any) {
      handleShopError(res, e, "admin colour create");
    }
  });

  app.patch("/api/admin/shop/colours/:id", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const patch: Record<string, any> = {};
      const b = req.body || {};
      if (b.name !== undefined) patch.name = String(b.name).trim();
      if (b.swatchHex !== undefined) patch.swatchHex = String(b.swatchHex).trim() || null;
      if (b.active !== undefined) patch.active = !!b.active;
      if (b.sortOrder !== undefined) patch.sortOrder = parseInt(String(b.sortOrder)) || 0;
      const [updated] = await db.update(shopProductColours).set(patch)
        .where(eq(shopProductColours.id, parseInt(String(req.params.id)))).returning();
      if (!updated) return res.status(404).json({ message: "Colour not found" });
      res.json(updated);
    } catch (e: any) {
      handleShopError(res, e, "admin colour update");
    }
  });

  app.delete("/api/admin/shop/colours/:id", requireAuth, requireTab("store"), async (req, res) => {
    try {
      await db.delete(shopProductColours).where(eq(shopProductColours.id, parseInt(String(req.params.id))));
      res.json({ ok: true });
    } catch (e: any) {
      handleShopError(res, e, "admin colour delete");
    }
  });

  // ── Admin: images (uploads go through the EXISTING /api/admin/uploads/image;
  //    this endpoint just attaches the returned URL to a product/colour) ──────
  app.post("/api/admin/shop/products/:id/images", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const productId = parseInt(String(req.params.id));
      const url = String(req.body?.url || "").trim();
      if (!url) throw new ShopError("Image url is required");
      const colourId = req.body?.colourId != null && req.body.colourId !== "" ? parseInt(String(req.body.colourId)) : null;
      const siblings = await db.select({ id: shopProductImages.id }).from(shopProductImages)
        .where(eq(shopProductImages.productId, productId));
      const [created] = await db.insert(shopProductImages).values({
        productId,
        colourId,
        url,
        alt: String(req.body?.alt || "").trim() || null,
        sortOrder: siblings.length,
      }).returning();
      res.status(201).json(created);
    } catch (e: any) {
      handleShopError(res, e, "admin image attach");
    }
  });

  app.delete("/api/admin/shop/images/:id", requireAuth, requireTab("store"), async (req, res) => {
    try {
      await db.delete(shopProductImages).where(eq(shopProductImages.id, parseInt(String(req.params.id))));
      res.json({ ok: true });
    } catch (e: any) {
      handleShopError(res, e, "admin image delete");
    }
  });

  // ── Admin: size/stock matrix per colour (declarative upsert) ──────────────
  // Sizes present in the payload are created/updated + reactivated; sizes
  // missing from it are deactivated (kept for order-history integrity).
  app.put("/api/admin/shop/colours/:id/variants", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const colourId = parseInt(String(req.params.id));
      const [colour] = await db.select().from(shopProductColours).where(eq(shopProductColours.id, colourId));
      if (!colour) return res.status(404).json({ message: "Colour not found" });

      const sizes: { size: string; stock: number; sku?: string | null }[] =
        (Array.isArray(req.body?.sizes) ? req.body.sizes : [])
          .map((s: any) => ({
            size: String(s?.size || "").trim(),
            stock: Math.max(parseInt(String(s?.stock)) || 0, 0),
            sku: String(s?.sku || "").trim() || null,
          }))
          .filter((s: any) => s.size);

      const existing = await db.select().from(shopVariants).where(eq(shopVariants.colourId, colourId));
      const keep = new Set(sizes.map((s) => s.size));

      for (const s of sizes) {
        const match = existing.find((v) => v.size === s.size);
        if (match) {
          await db.update(shopVariants)
            .set({ stock: s.stock, sku: s.sku, active: true })
            .where(eq(shopVariants.id, match.id));
        } else {
          await db.insert(shopVariants).values({
            productId: colour.productId, colourId, size: s.size, stock: s.stock, sku: s.sku, active: true,
          });
        }
      }
      for (const v of existing) {
        if (!keep.has(v.size) && v.active) {
          await db.update(shopVariants).set({ active: false }).where(eq(shopVariants.id, v.id));
        }
      }
      const updated = await db.select().from(shopVariants)
        .where(eq(shopVariants.colourId, colourId)).orderBy(asc(shopVariants.id));
      res.json(updated);
    } catch (e: any) {
      handleShopError(res, e, "admin variants upsert");
    }
  });

  // ── Admin: orders (list / detail / fulfilment pipeline) ────────────────────
  app.get("/api/admin/shop/orders", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const orgId = adminOrgId(req);
      const status = String(req.query.status || "").trim();
      const q = String(req.query.q || "").trim();
      const filters: any[] = [eq(shopOrders.organizationId, orgId)];
      if (status && (ORDER_STATUSES as readonly string[]).includes(status)) filters.push(eq(shopOrders.status, status));
      if (q) {
        const like = `%${q}%`;
        filters.push(or(
          ilike(shopOrders.firstName, like),
          ilike(shopOrders.lastName, like),
          ilike(shopOrders.email, like),
          ilike(shopOrders.orderNumber, like),
        ));
      }
      const orders = await db.select().from(shopOrders)
        .where(and(...filters))
        .orderBy(desc(shopOrders.createdAt))
        .limit(300);
      const ids = orders.map((o) => o.id);
      const [items, shares] = ids.length > 0
        ? await Promise.all([
            db.select().from(shopOrderItems).where(inArray(shopOrderItems.orderId, ids)),
            db.select({ orderId: shopOrderShares.orderId, status: shopOrderShares.status })
              .from(shopOrderShares).where(inArray(shopOrderShares.orderId, ids)),
          ])
        : [[], []] as [ShopOrderItem[], { orderId: number; status: string }[]];
      res.json(orders.map((o) => {
        const orderShares = shares.filter((s) => s.orderId === o.id);
        return {
          ...o,
          itemsCount: items.filter((i) => i.orderId === o.id).reduce((s, i) => s + i.qty, 0),
          playerCount: orderShares.length,
          paidCount: orderShares.filter((s) => s.status === "paid").length,
        };
      }));
    } catch (e: any) {
      handleShopError(res, e, "admin orders list");
    }
  });

  app.get("/api/admin/shop/orders/:id", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const [order] = await db.select().from(shopOrders).where(eq(shopOrders.id, parseInt(String(req.params.id))));
      if (!order) return res.status(404).json({ message: "Order not found" });
      const brand = shopBrandByOrgId(order.organizationId);
      const [items, shares] = await Promise.all([
        db.select().from(shopOrderItems).where(eq(shopOrderItems.orderId, order.id)),
        db.select().from(shopOrderShares).where(eq(shopOrderShares.orderId, order.id))
          .orderBy(asc(shopOrderShares.id)),
      ]);
      res.json({
        ...order,
        items,
        shares: shares.map((s) => ({
          ...s,
          payUrl: brand ? `${brand.storefrontBase}/pay/${s.shareToken}` : null,
        })),
      });
    } catch (e: any) {
      handleShopError(res, e, "admin order detail");
    }
  });

  // The fulfilment pipeline. Paid states are only ever set by Stripe (webhook /
  // confirm fallback) — admins move a paid order through processing → done.
  const ADMIN_SETTABLE_STATUSES = ["processing", "ready_for_pickup", "shipped", "completed", "cancelled", "refunded"];
  app.patch("/api/admin/shop/orders/:id/status", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const status = String(req.body?.status || "");
      if (!ADMIN_SETTABLE_STATUSES.includes(status)) {
        return res.status(400).json({ message: `Status must be one of: ${ADMIN_SETTABLE_STATUSES.join(", ")}` });
      }
      const [updated] = await db.update(shopOrders)
        .set({ status, updatedAt: new Date() })
        .where(eq(shopOrders.id, parseInt(String(req.params.id))))
        .returning();
      if (!updated) return res.status(404).json({ message: "Order not found" });
      // WMS reservation release (dark-launched behind WMS_NATIVE_SYNC, mirrors
      // the reserve call in finalizeShopOrderPaid) — a cancelled/refunded
      // order must release its active shop_order reservation, or `available`
      // stays permanently reduced by a promise that will never be dispatched.
      // Best-effort + idempotent (releaseReservationsForRef only touches
      // still-active reservations): never fails the status update itself.
      if (process.env.WMS_NATIVE_SYNC === "1" && (status === "cancelled" || status === "refunded")) {
        try {
          await runReleaseReservationsForRef({ kind: "shop_order", id: updated.id });
        } catch (e) {
          console.error(`[Shop] WMS reservation release failed for order ${updated.id}:`, e);
        }
      }
      res.json(updated);
    } catch (e: any) {
      handleShopError(res, e, "admin order status");
    }
  });

  app.patch("/api/admin/shop/orders/:id", requireAuth, requireTab("store"), async (req, res) => {
    try {
      if (req.body?.notes === undefined) return res.status(400).json({ message: "Nothing to update" });
      const [updated] = await db.update(shopOrders)
        .set({ notes: String(req.body.notes || "").trim() || null, updatedAt: new Date() })
        .where(eq(shopOrders.id, parseInt(String(req.params.id))))
        .returning();
      if (!updated) return res.status(404).json({ message: "Order not found" });
      res.json(updated);
    } catch (e: any) {
      handleShopError(res, e, "admin order notes");
    }
  });

  app.post("/api/admin/shop/orders/:id/resend-confirmation", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const [order] = await db.select().from(shopOrders).where(eq(shopOrders.id, parseInt(String(req.params.id))));
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.status === "pending" || order.status === "awaiting_players") {
        return res.status(400).json({ message: "Order isn't paid yet" });
      }
      const items = await db.select().from(shopOrderItems).where(eq(shopOrderItems.orderId, order.id));
      const requiresAddress = !!order.addressLine1;
      const brand = shopBrandByOrgId(order.organizationId);
      const printOptionsByProduct = await printOptionsByProductForItems(items);
      const ok = await sendShopOrderConfirmation({
        to: order.email,
        firstName: order.firstName,
        orderNumber: order.orderNumber || `#${order.id}`,
        lines: items.map((i) => ({
          title: i.title, colourName: i.colourName, size: i.size, qty: i.qty, lineCents: i.lineCents,
          units: labelPrintUnits(i.units, i.productId != null ? printOptionsByProduct.get(i.productId) : undefined),
        })),
        subtotalCents: order.subtotalCents,
        discountCents: order.discountCents,
        discountCode: order.discountCode,
        shippingLabel: order.shippingLabel,
        shippingCents: order.shippingCents,
        gstCents: order.gstCents,
        totalCents: order.totalCents,
        requiresAddress,
        addressSummary: requiresAddress
          ? [order.addressLine1, order.addressLine2, order.suburb, order.city, order.postcode].filter(Boolean).join(", ")
          : null,
        brandKey: brand?.brandKey,
      });
      res.json({ ok });
    } catch (e: any) {
      handleShopError(res, e, "admin resend confirmation");
    }
  });

  // ── Admin: shipping options ────────────────────────────────────────────────
  app.get("/api/admin/shop/shipping-options", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const orgId = adminOrgId(req);
      const rows = await db.select().from(shopShippingOptions)
        .where(eq(shopShippingOptions.organizationId, orgId))
        .orderBy(asc(shopShippingOptions.sortOrder), asc(shopShippingOptions.id));
      res.json(rows);
    } catch (e: any) {
      handleShopError(res, e, "admin shipping list");
    }
  });

  app.post("/api/admin/shop/shipping-options", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const orgId = adminOrgId(req);
      const label = String(req.body?.label || "").trim();
      if (!label) throw new ShopError("Label is required");
      const [created] = await db.insert(shopShippingOptions).values({
        organizationId: orgId,
        label,
        description: String(req.body?.description || "").trim() || null,
        priceCents: parseInt(String(req.body?.priceCents)) || 0,
        requiresAddress: !!req.body?.requiresAddress,
        active: req.body?.active === undefined ? true : !!req.body.active,
        sortOrder: parseInt(String(req.body?.sortOrder)) || 0,
      }).returning();
      res.status(201).json(created);
    } catch (e: any) {
      handleShopError(res, e, "admin shipping create");
    }
  });

  app.patch("/api/admin/shop/shipping-options/:id", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const patch: Record<string, any> = {};
      const b = req.body || {};
      if (b.label !== undefined) patch.label = String(b.label).trim();
      if (b.description !== undefined) patch.description = String(b.description).trim() || null;
      if (b.priceCents !== undefined) patch.priceCents = parseInt(String(b.priceCents)) || 0;
      if (b.requiresAddress !== undefined) patch.requiresAddress = !!b.requiresAddress;
      if (b.active !== undefined) patch.active = !!b.active;
      if (b.sortOrder !== undefined) patch.sortOrder = parseInt(String(b.sortOrder)) || 0;
      const [updated] = await db.update(shopShippingOptions).set(patch)
        .where(eq(shopShippingOptions.id, parseInt(String(req.params.id)))).returning();
      if (!updated) return res.status(404).json({ message: "Shipping option not found" });
      res.json(updated);
    } catch (e: any) {
      handleShopError(res, e, "admin shipping update");
    }
  });

  app.delete("/api/admin/shop/shipping-options/:id", requireAuth, requireTab("store"), async (req, res) => {
    try {
      await db.delete(shopShippingOptions).where(eq(shopShippingOptions.id, parseInt(String(req.params.id))));
      res.json({ ok: true });
    } catch (e: any) {
      handleShopError(res, e, "admin shipping delete");
    }
  });

  // ── Admin: discount codes ──────────────────────────────────────────────────
  app.get("/api/admin/shop/discount-codes", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const orgId = adminOrgId(req);
      const rows = await db.select().from(shopDiscountCodes)
        .where(eq(shopDiscountCodes.organizationId, orgId))
        .orderBy(desc(shopDiscountCodes.createdAt));
      res.json(rows);
    } catch (e: any) {
      handleShopError(res, e, "admin discounts list");
    }
  });

  app.post("/api/admin/shop/discount-codes", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const orgId = adminOrgId(req);
      const code = String(req.body?.code || "").trim().toUpperCase().replace(/\s+/g, "");
      if (!code) throw new ShopError("Code is required");
      const kind = req.body?.kind === "fixed" ? "fixed" : "percent";
      const value = parseInt(String(req.body?.value)) || 0;
      if (value <= 0) throw new ShopError(kind === "percent" ? "Percent must be above 0" : "Amount must be above $0");
      if (kind === "percent" && value > 100) throw new ShopError("Percent can't exceed 100");
      const [created] = await db.insert(shopDiscountCodes).values({
        organizationId: orgId,
        code,
        kind,
        value,
        active: req.body?.active === undefined ? true : !!req.body.active,
        startsAt: req.body?.startsAt ? new Date(req.body.startsAt) : null,
        endsAt: req.body?.endsAt ? new Date(req.body.endsAt) : null,
        maxUses: req.body?.maxUses ? parseInt(String(req.body.maxUses)) : null,
      }).returning();
      res.status(201).json(created);
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "That code already exists in this store." });
      handleShopError(res, e, "admin discount create");
    }
  });

  app.patch("/api/admin/shop/discount-codes/:id", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const patch: Record<string, any> = {};
      const b = req.body || {};
      if (b.code !== undefined) patch.code = String(b.code).trim().toUpperCase().replace(/\s+/g, "");
      if (b.kind !== undefined) patch.kind = b.kind === "fixed" ? "fixed" : "percent";
      if (b.value !== undefined) patch.value = parseInt(String(b.value)) || 0;
      if (b.active !== undefined) patch.active = !!b.active;
      if (b.startsAt !== undefined) patch.startsAt = b.startsAt ? new Date(b.startsAt) : null;
      if (b.endsAt !== undefined) patch.endsAt = b.endsAt ? new Date(b.endsAt) : null;
      if (b.maxUses !== undefined) patch.maxUses = b.maxUses ? parseInt(String(b.maxUses)) : null;
      const [updated] = await db.update(shopDiscountCodes).set(patch)
        .where(eq(shopDiscountCodes.id, parseInt(String(req.params.id)))).returning();
      if (!updated) return res.status(404).json({ message: "Discount code not found" });
      res.json(updated);
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "That code already exists in this store." });
      handleShopError(res, e, "admin discount update");
    }
  });

  app.delete("/api/admin/shop/discount-codes/:id", requireAuth, requireTab("store"), async (req, res) => {
    try {
      await db.delete(shopDiscountCodes).where(eq(shopDiscountCodes.id, parseInt(String(req.params.id))));
      res.json({ ok: true });
    } catch (e: any) {
      handleShopError(res, e, "admin discount delete");
    }
  });

  // ── Admin: stats header ────────────────────────────────────────────────────
  app.get("/api/admin/shop/stats", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const orgId = adminOrgId(req);
      const orders = await db.select().from(shopOrders).where(eq(shopOrders.organizationId, orgId));
      const paidIds = orders.filter((o) => PAID_STATUSES.includes(o.status)).map((o) => o.id);
      const items = paidIds.length > 0
        ? await db.select().from(shopOrderItems).where(inArray(shopOrderItems.orderId, paidIds))
        : [];
      const byStatus: Record<string, number> = {};
      for (const o of orders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
      res.json({
        revenueCents: orders.filter((o) => PAID_STATUSES.includes(o.status)).reduce((s, o) => s + o.totalCents, 0),
        ordersCount: paidIds.length,
        unitsSold: items.reduce((s, i) => s + i.qty, 0),
        byStatus,
      });
    } catch (e: any) {
      handleShopError(res, e, "admin stats");
    }
  });
}
