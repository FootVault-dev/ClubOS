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
import { db } from "./db";
import { and, asc, desc, eq, inArray, or, ilike, sql } from "drizzle-orm";
import { storage } from "./storage";
import { requireAuth, requireTab } from "./auth";
import { stripe, retrievePaymentIntent } from "./stripe";
import { sendShopOrderConfirmation, sendShopOrderNotification, type ShopOrderEmailLine } from "./email";
import { sendServerEvent } from "./meta-capi";
import {
  shopProducts, shopProductColours, shopProductImages, shopVariants,
  shopShippingOptions, shopDiscountCodes, shopOrders, shopOrderItems,
  type ShopProduct, type ShopProductColour, type ShopProductImage,
  type ShopVariant, type ShopShippingOption, type ShopDiscountCode,
  type ShopOrder, type ShopOrderItem,
} from "@shared/schema";

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
  "pending", "paid", "processing", "ready_for_pickup",
  "shipped", "completed", "cancelled", "refunded",
] as const;

/** Statuses that count as money in the till for stats. */
const PAID_STATUSES = ["paid", "processing", "ready_for_pickup", "shipped", "completed"];

// ─── Server-authoritative cart pricing (shared by quote + checkout) ─────────

interface CartItemInput { productId: number; colourId: number; size: string; qty: number }

interface PricedLine {
  product: ShopProduct;
  colour: ShopProductColour;
  variant: ShopVariant;
  qty: number;
  unitCents: number;
  lineCents: number;
  imageUrl: string | null; // relative or absolute, as stored
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

  const lines: PricedLine[] = items.map((it) => {
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
    const unitCents = product.priceCents;
    return {
      product, colour, variant, qty: it.qty,
      unitCents, lineCents: unitCents * it.qty,
      imageUrl: image?.url || null,
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

  const emailLines: ShopOrderEmailLine[] = items.map((i) => ({
    title: i.title, colourName: i.colourName, size: i.size, qty: i.qty, lineCents: i.lineCents,
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
                .map((v) => ({ size: v.size, inStock: v.stock > 0 })),
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
          lineDollars: toDollars(l.lineCents),
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

      await db.insert(shopOrderItems).values(cart.lines.map((l) => ({
        orderId: order.id,
        productId: l.product.id,
        variantId: l.variant.id,
        title: l.product.title,
        colourName: l.colour.name,
        size: l.variant.size,
        imageUrl: l.imageUrl,
        unitCents: l.unitCents,
        qty: l.qty,
        lineCents: l.lineCents,
        costUsdSnapshot: l.product.costUsd, // reference only — never calculated with
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

      const simplified = order.status === "pending" ? "pending"
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
      const items = ids.length > 0
        ? await db.select().from(shopOrderItems).where(inArray(shopOrderItems.orderId, ids))
        : [];
      res.json(orders.map((o) => ({
        ...o,
        itemsCount: items.filter((i) => i.orderId === o.id).reduce((s, i) => s + i.qty, 0),
      })));
    } catch (e: any) {
      handleShopError(res, e, "admin orders list");
    }
  });

  app.get("/api/admin/shop/orders/:id", requireAuth, requireTab("store"), async (req, res) => {
    try {
      const [order] = await db.select().from(shopOrders).where(eq(shopOrders.id, parseInt(String(req.params.id))));
      if (!order) return res.status(404).json({ message: "Order not found" });
      const items = await db.select().from(shopOrderItems).where(eq(shopOrderItems.orderId, order.id));
      res.json({ ...order, items });
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
      if (order.status === "pending") return res.status(400).json({ message: "Order isn't paid yet" });
      const items = await db.select().from(shopOrderItems).where(eq(shopOrderItems.orderId, order.id));
      const requiresAddress = !!order.addressLine1;
      const ok = await sendShopOrderConfirmation({
        to: order.email,
        firstName: order.firstName,
        orderNumber: order.orderNumber || `#${order.id}`,
        lines: items.map((i) => ({ title: i.title, colourName: i.colourName, size: i.size, qty: i.qty, lineCents: i.lineCents })),
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
