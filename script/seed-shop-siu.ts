// Seed the SIU Store (org 2) — South Island United retail, replacing
// shop.southislandunited.com (Shopify). Data comes verbatim from a real
// Shopify Admin API export (prices, sizes, colours, stock, descriptions —
// nothing invented), not a hand-typed list.
//
// Dry-run by default; the whole run happens inside ONE transaction that is
// rolled back unless --commit is passed, so a dry run exercises the real DB
// constraints (unique indexes, the print_cents CHECK, etc.) without writing
// anything.
//
// Idempotent on (organization_id=2, slug): a product whose slug already
// exists is left completely alone — never touched, never re-priced — so a
// re-run can never clobber an edit Daniel makes in the Store tab afterwards.
// Shipping options are idempotent on label; discount codes on (org, code)
// the same way.
//
//   npx tsx --env-file=.env script/seed-shop-siu.ts                 # dry run (default)
//   npx tsx --env-file=.env script/seed-shop-siu.ts --commit        # write
//   npx tsx --env-file=.env script/seed-shop-siu.ts --raw=/path/to/products-raw.json --audit=/path/to/audit.json

import { Pool, type PoolClient } from "pg";
import { readFileSync } from "fs";
import { join } from "path";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const SIU_ORG_ID = 2;

// This seed needs shop_products.print_options to exist. It is normally
// applied separately, for real, by `apply-shop-print-options.ts --commit`
// (owned migration file: migrations/2026-09-09_shop_print_options.sql). That
// migration is additive and idempotent (ADD COLUMN IF NOT EXISTS), so running
// it here too — inside THIS script's own transaction, ahead of the product
// inserts — is always safe: on a DB where it's already been applied for real
// it's a silent no-op, and on a dry run it lets the whole rehearsal (incl.
// print_options) happen and then roll back with nothing written, same as
// every other check in this script.
const PRINT_OPTIONS_MIGRATION = join(process.cwd(), "migrations", "2026-09-09_shop_print_options.sql");

const DEFAULT_RAW =
  "/Users/danielmeyn/Desktop/AIOS/DanielMeynOS/outputs/siu-shop/2026-09-09-shopify-audit/products-raw.json";
const DEFAULT_AUDIT =
  "/Users/danielmeyn/Desktop/AIOS/DanielMeynOS/outputs/siu-shop/2026-09-09-shopify-audit/audit.json";

// ── Shopify raw shapes (subset actually used) ───────────────────────────────
interface RawImage {
  id: number;
  alt: string | null;
  src: string;
  position: number;
  variant_ids: number[];
}
interface RawVariant {
  id: number;
  title: string;
  price: string;
  sku: string | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  inventory_quantity: number;
}
interface RawOption {
  name: string;
  values: string[];
}
interface RawProduct {
  id: number;
  handle: string;
  title: string;
  body_html: string;
  tags: string; // comma-separated
  status: "active" | "draft" | "archived";
  options: RawOption[];
  variants: RawVariant[];
  images: RawImage[];
}
interface RawExport {
  products: RawProduct[];
  collections: unknown[];
}
interface PriceRule {
  title: string;
  value_type: "percentage" | "fixed_amount";
  value: string; // e.g. "-10.0" or "-60.0"
  starts: string;
  ends: string | null;
  codes: string[];
}
interface AuditExport {
  price_rules: PriceRule[];
  [k: string]: unknown;
}

// ── Products worth keeping despite being drafts ─────────────────────────────
// The Fusion Puffer Vest has real photography + a real price but nowhere to
// sell it yet (Daniel to price-confirm + activate); the 3 youth GK jerseys
// are the youth counterpart to the 3 adult GK jerseys already active. Both
// groups are seeded as draft (= Shopify's own status for them), invisible on
// the public catalog until someone flips them active in the Store tab.
const KEEP_DRAFT_HANDLES = new Set<string>([
  "2026-fusion-puffer-vest",
  "2026-player-goal-keeper-away-jersey-youth",
  "2026-player-goal-keeper-home-jersey-youth",
  "2026-player-goal-keeper-third-jersey-youth",
]);

// Discount codes that must NEVER be imported: 100%-off test codes. A live
// 100%-off code is a way to give the shop away, and even though Shopify
// records these as expired (ends in the past), a code is only really dead
// once it's absent from the new system entirely.
const SKIP_DISCOUNT_CODES = new Set(["TEST", "TEST1", "INV-TEST"]);

// ── type derivation (shop_products.type is open-ended free text) ───────────
const TYPE_BY_HANDLE: Record<string, string> = {
  "fan-scarf-1": "accessory",
  "pennant": "accessory",
  "key-ring": "accessory",
  "pin-badge": "accessory",
  "bucket-hat-reversible": "headwear",
  "2026-unisex-casual-hoodie-black": "apparel",
  "2026-unisex-panel-bomber-jacket": "apparel",
  "2026-fusion-puffer-vest": "apparel",
};
function typeFor(p: RawProduct): string {
  const tags = p.tags.toLowerCase();
  if (tags.includes("goalkeeper-kit")) return "jersey-gk";
  if (tags.includes("player-kit")) return "jersey";
  return TYPE_BY_HANDLE[p.handle] || "apparel";
}

// ── description: strip HTML to plain text, and drop the stale pre-order
//    paragraph — but ONLY the specific stale claim ("…under pre-order only
//    and will be shipping in early March…"), not every dispatch-time notice.
//    2026-player-third-jersey and its youth sibling carry a DIFFERENT, still-
//    true note ("allow an additional 3–5 business days for dispatch of
//    customised jerseys") with no pre-order claim in it — that one is kept. ──
function dropStaleParagraphs(html: string): string {
  return html.replace(/<p[^>]*>[\s\S]*?<\/p>/gi, (block) =>
    /pre-order only/i.test(block) ? "" : block);
}
function stripHtml(html: string): string {
  let s = html || "";
  s = s.replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h[1-6]>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
function buildDescription(p: RawProduct): string {
  return stripHtml(dropStaleParagraphs(p.body_html));
}

const dollarsToCents = (s: string) => Math.round(parseFloat(s) * 100);

// ── Transform: raw Shopify product → seedable product ──────────────────────
interface BuildVariant { size: string; sku: string | null; stock: number }
interface BuildImage { file: string; alt: string }
interface PrintChoice {
  key: string; label: string; priceDollars: number;
  needsName: boolean; needsNumber: boolean; fromSquad?: boolean;
}
interface PrintOptions { key: string; label: string; defaultChoice: string; choices: PrintChoice[] }
interface BuildProduct {
  slug: string;
  title: string;
  description: string;
  type: string;
  priceCents: number;
  status: "active" | "draft";
  images: BuildImage[];
  variants: BuildVariant[];
  printOptions: PrintOptions | null;
}

function buildPrintOptions(printDollars: number): PrintOptions {
  return {
    key: "printing",
    label: "Printing",
    defaultChoice: "none",
    choices: [
      { key: "none", label: "No printing", priceDollars: 0, needsName: false, needsNumber: false },
      { key: "player", label: "Squad player", priceDollars: printDollars, needsName: true, needsNumber: true, fromSquad: true },
      { key: "custom", label: "Your own name & number", priceDollars: printDollars, needsName: true, needsNumber: true },
    ],
  };
}

/**
 * The product slug is a CUSTOMER-FACING URL, so three inherited Shopify handles
 * do not survive the move. They are duplication accidents from the Shopify
 * admin, not names anybody chose:
 *   "…-copy"  — someone duplicated the adult jersey to make the youth one
 *   "…-1"     — a second product created over a deleted first one
 * A shopper should never be sent to /2026-player-home-jersey-copy.
 *
 * Everything else keeps its Shopify handle deliberately, so the two stores
 * describe products by the same name while both exist.
 *
 * NOTE the image FILES on disk are named from the original Shopify handle
 * (that is how they were downloaded), so only `slug` is remapped here — never
 * the `file` above, or the catalogue would point at images that do not exist.
 */
const SLUG_OVERRIDES: Record<string, string> = {
  "2026-player-home-jersey-copy": "2026-player-home-jersey-youth",
  "2026-player-third-jersey-youth-1": "2026-player-third-jersey-youth",
  "fan-scarf-1": "2026-fan-scarf",
  // Its youth sibling is already "2026-retro-collar-jersey-youth"; the adult
  // one being "retro-kit" makes the pair look unrelated in a URL bar.
  "retro-kit": "2026-retro-collar-jersey",
};

function publicSlug(handle: string): string {
  return SLUG_OVERRIDES[handle] ?? handle;
}

function buildProduct(p: RawProduct, flags: string[]): BuildProduct {
  const hasPrinting = p.options.some((o) => o.name === "Printing");
  const sizeOption = p.options.find((o) => o.name === "Size");

  let variants: BuildVariant[] = [];
  let priceCents: number;
  let printOptions: PrintOptions | null = null;

  if (hasPrinting) {
    if (!sizeOption) throw new Error(`${p.handle}: has Printing but no Size option`);
    const sizes = sizeOption.values;
    variants = sizes.map((size) => {
      // Stock stays per (colour × size); the "None" printing variant is the
      // one true stock count — Player/Custom just re-list the same shirt.
      const none = p.variants.find((v) => v.option1 === size && v.option2 === "None");
      if (!none) throw new Error(`${p.handle}: no "None" printing variant for size ${size}`);
      return { size, sku: none.sku, stock: Math.max(0, none.inventory_quantity) };
    });
    const firstSize = sizes[0];
    const noneV = p.variants.find((v) => v.option1 === firstSize && v.option2 === "None")!;
    const playerV = p.variants.find((v) => v.option1 === firstSize && v.option2 === "Player")!;
    priceCents = dollarsToCents(noneV.price);
    const printDollars = dollarsToCents(playerV.price) / 100 - priceCents / 100;
    if (Math.round(printDollars * 100) !== 1999) {
      flags.push(`${p.handle}: printing add-on computed as $${printDollars.toFixed(2)}, not the expected $19.99 — seeded as computed, verify.`);
    }
    printOptions = buildPrintOptions(Math.round(printDollars * 100) / 100);
    // Sanity: price must be flat across every size (verified true for all
    // 14 jersey products in the export) — flag rather than silently average
    // if a future re-export ever varies it.
    const allNonePrices = new Set(sizes.map((s) => p.variants.find((v) => v.option1 === s && v.option2 === "None")!.price));
    if (allNonePrices.size > 1) {
      flags.push(`${p.handle}: plain price varies by size (${[...allNonePrices].join(", ")}) — product priced at the lowest, per-size override NOT set. Check before activating.`);
    }
  } else if (sizeOption) {
    variants = p.variants.map((v) => ({
      size: v.option1 || "One size",
      sku: v.sku,
      stock: Math.max(0, v.inventory_quantity),
    }));
    priceCents = dollarsToCents(p.variants[0].price);
    const allPrices = new Set(p.variants.map((v) => v.price));
    if (allPrices.size > 1) {
      flags.push(`${p.handle}: price varies by size (${[...allPrices].join(", ")}) — product priced at the lowest ($${p.variants[0].price}), no per-variant override set. Check before activating.`);
    }
  } else {
    const v = p.variants[0];
    variants = [{ size: "One size", sku: v.sku, stock: Math.max(0, v.inventory_quantity) }];
    priceCents = dollarsToCents(v.price);
  }

  const images: BuildImage[] = p.images.map((im, i) => ({
    file: `${p.handle}-${i + 1}.webp`,
    alt: im.alt || p.title,
  }));

  return {
    slug: publicSlug(p.handle),
    title: p.title,
    description: buildDescription(p),
    type: typeFor(p),
    priceCents,
    status: p.status === "active" ? "active" : "draft",
    images,
    variants,
    printOptions,
  };
}

// ── Shipping ─────────────────────────────────────────────────────────────
// From the audit's shipping_lines_used (real order history, not guessed):
//   "United Sports Centre @ 0.00" ×22, "NZ Standard Delivery @ 0.00" ×16,
//   "NZ Standard Delivery @ 10.00" ×6, "Standard Shipping @ 10.00" ×69
//   (older label for the same NZ courier line) — pickup and $10 NZ delivery
//   are the only two rates the data actually proves.
// Australia (~$27) and US/Canada (~$110) were Shopify carrier-calculated —
// live rates from a carrier API, not a flat price Shopify itself set — so
// there is no single number to carry over honestly. Seeded INACTIVE with
// $0 placeholders that can never be charged while inactive; Daniel sets a
// real flat rate and flips them on.
const SHIPPING: { label: string; description: string; priceCents: number; requiresAddress: boolean; active: boolean; sortOrder: number }[] = [
  {
    label: "Pickup — United Sports Centre",
    description: "Free — collect from the club office at United Sports Centre, 466 Yaldhurst Road, Christchurch.",
    priceCents: 0,
    requiresAddress: false,
    active: true,
    sortOrder: 0,
  },
  {
    label: "NZ Standard Delivery",
    description: "Tracked courier, anywhere in New Zealand. (The old store waived this above some order value — the engine has no free-over-threshold rule yet, and the real threshold isn't in the data; Daniel to decide.)",
    priceCents: 1000,
    requiresAddress: true,
    active: true,
    sortOrder: 1,
  },
  {
    label: "Australia Delivery",
    description: "⚠️ Rate unconfirmed. Shopify calculated this live via a carrier at checkout (observed ~$26–$28 in order history) — there is no single flat rate to carry over honestly. Set a real price and activate when ready.",
    priceCents: 0,
    requiresAddress: true,
    active: false,
    sortOrder: 2,
  },
  {
    label: "Rest of World Delivery",
    description: "⚠️ Rate unconfirmed. Shopify calculated this live via a carrier at checkout (observed ~$109–$111 to the US/Canada in order history) — there is no single flat rate to carry over honestly. Set a real price and activate when ready.",
    priceCents: 0,
    requiresAddress: true,
    active: false,
    sortOrder: 3,
  },
];

async function main() {
  const commit = process.argv.includes("--commit");
  const rawArg = process.argv.find((a) => a.startsWith("--raw="));
  const auditArg = process.argv.find((a) => a.startsWith("--audit="));
  const rawPath = rawArg ? rawArg.slice("--raw=".length) : DEFAULT_RAW;
  const auditPath = auditArg ? auditArg.slice("--audit=".length) : DEFAULT_AUDIT;

  const raw: RawExport = JSON.parse(readFileSync(rawPath, "utf8"));
  const audit: AuditExport = JSON.parse(readFileSync(auditPath, "utf8"));
  console.log(`Raw products: ${rawPath}`);
  console.log(`Audit (discount codes): ${auditPath}`);
  console.log(`Mode: ${commit ? "COMMIT (writing)" : "DRY RUN (rolled back at the end)"}\n`);

  const flags: string[] = [];

  // ── Selection ──────────────────────────────────────────────────────────
  const toKeep = raw.products.filter((p) => p.status === "active" || KEEP_DRAFT_HANDLES.has(p.handle));
  const skippedCic = raw.products.filter((p) => p.status !== "active" && !KEEP_DRAFT_HANDLES.has(p.handle) && /\bcic\b/i.test(p.tags));
  const skippedEmpty = raw.products.filter((p) => p.status !== "active" && !KEEP_DRAFT_HANDLES.has(p.handle) && !/\bcic\b/i.test(p.tags));

  console.log(`Products in export: ${raw.products.length}`);
  console.log(`  Keeping: ${toKeep.length} (${toKeep.filter((p) => p.status === "active").length} active, ${toKeep.filter((p) => p.status !== "active").length} draft)`);
  console.log(`  Skipping — already live on the CIC store: ${skippedCic.length} (${skippedCic.map((p) => p.handle).join(", ")})`);
  console.log(`  Skipping — draft placeholders (no product photo): ${skippedEmpty.length} (${skippedEmpty.map((p) => p.handle).join(", ")})`);
  for (const p of skippedEmpty) {
    const stock = p.variants.reduce((s, v) => s + Math.max(0, v.inventory_quantity), 0);
    if (stock > 0) flags.push(`"${p.handle}" skipped (0 product images) despite carrying ${stock} units of Shopify stock — a product page needs a photo; re-check before this becomes a real listing.`);
  }
  console.log();

  const built = toKeep.map((p) => buildProduct(p, flags));
  for (const p of built) {
    if (p.status === "draft") flags.push(`"${p.slug}" seeded as DRAFT (inactive) — real product, kept off the public catalog until Daniel prices/activates it in the Store tab.`);
  }

  // ── Discount codes ────────────────────────────────────────────────────
  const codesToImport = audit.price_rules.filter((r) => !SKIP_DISCOUNT_CODES.has(r.codes[0]));
  const codesSkipped = audit.price_rules.filter((r) => SKIP_DISCOUNT_CODES.has(r.codes[0]));
  console.log(`Discount codes in export: ${audit.price_rules.length}`);
  console.log(`  Importing: ${codesToImport.length}`);
  console.log(`  Skipping (100%-off test codes): ${codesSkipped.map((r) => r.codes[0]).join(", ")}\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client: PoolClient = await pool.connect();
  let productsInserted = 0, imagesInserted = 0, variantsInserted = 0, shippingInserted = 0, codesInserted = 0;
  let productsSkipped = 0, shippingSkipped = 0, codesSkipped2 = 0;

  try {
    await client.query("BEGIN");
    await client.query(readFileSync(PRINT_OPTIONS_MIGRATION, "utf8"));

    // ── Shipping ───────────────────────────────────────────────────────────
    for (const opt of SHIPPING) {
      const { rows } = await client.query(
        `SELECT id FROM shop_shipping_options WHERE organization_id = $1 AND label = $2`,
        [SIU_ORG_ID, opt.label],
      );
      if (rows.length > 0) {
        console.log(`✓ Shipping exists (id ${rows[0].id}): ${opt.label}`);
        shippingSkipped++;
        continue;
      }
      const { rows: created } = await client.query(
        `INSERT INTO shop_shipping_options (organization_id, label, description, price_cents, requires_address, active, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [SIU_ORG_ID, opt.label, opt.description, opt.priceCents, opt.requiresAddress, opt.active, opt.sortOrder],
      );
      console.log(`+ Shipping (id ${created[0].id}${opt.active ? "" : ", INACTIVE"}): ${opt.label} — $${(opt.priceCents / 100).toFixed(2)}`);
      shippingInserted++;
    }

    // ── Discount codes ───────────────────────────────────────────────────
    for (const r of codesToImport) {
      const code = r.codes[0].toUpperCase();
      const { rows } = await client.query(
        `SELECT id FROM shop_discount_codes WHERE organization_id = $1 AND code = $2`,
        [SIU_ORG_ID, code],
      );
      if (rows.length > 0) {
        console.log(`✓ Discount code exists (id ${rows[0].id}): ${code}`);
        codesSkipped2++;
        continue;
      }
      const kind = r.value_type === "percentage" ? "percent" : "fixed";
      const numericValue = Math.abs(parseFloat(r.value));
      const value = kind === "percent" ? Math.round(numericValue) : Math.round(numericValue * 100);
      const { rows: created } = await client.query(
        `INSERT INTO shop_discount_codes (organization_id, code, kind, value, active, starts_at, ends_at, max_uses)
         VALUES ($1,$2,$3,$4,true,$5,$6,NULL) RETURNING id`,
        [SIU_ORG_ID, code, kind, value, r.starts || null, r.ends || null],
      );
      const label = kind === "percent" ? `${value}% off` : `$${(value / 100).toFixed(2)} off`;
      console.log(`+ Discount code (id ${created[0].id}): ${code} — ${label}`);
      codesInserted++;
    }

    // ── Products ───────────────────────────────────────────────────────────
    let sortOrder = 0;
    for (const p of built) {
      const { rows: existing } = await client.query(
        `SELECT id FROM shop_products WHERE organization_id = $1 AND slug = $2`,
        [SIU_ORG_ID, p.slug],
      );
      if (existing.length > 0) {
        console.log(`✓ Product exists (id ${existing[0].id}): ${p.title} [${p.slug}] — left untouched`);
        productsSkipped++;
        sortOrder++;
        continue;
      }

      const { rows: prod } = await client.query(
        `INSERT INTO shop_products (organization_id, slug, title, description, type, price_cents, status, sort_order, print_options)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id`,
        [SIU_ORG_ID, p.slug, p.title, p.description, p.type, p.priceCents, p.status, sortOrder, p.printOptions ? JSON.stringify(p.printOptions) : null],
      );
      const productId = prod[0].id as number;
      productsInserted++;

      // Every kept SIU product has exactly one colourway (no Color option in
      // the export) — one "Default" colour carries all images and sizes.
      const { rows: col } = await client.query(
        `INSERT INTO shop_product_colours (product_id, name, sort_order, active)
         VALUES ($1,'Default',0,true) RETURNING id`,
        [productId],
      );
      const colourId = col[0].id as number;

      let imgOrder = 0;
      for (const im of p.images) {
        await client.query(
          `INSERT INTO shop_product_images (product_id, colour_id, url, alt, sort_order)
           VALUES ($1,$2,$3,$4,$5)`,
          [productId, colourId, `/shop/siu/${im.file}`, im.alt, imgOrder++],
        );
        imagesInserted++;
      }

      for (const v of p.variants) {
        await client.query(
          `INSERT INTO shop_variants (product_id, colour_id, size, sku, stock, active)
           VALUES ($1,$2,$3,$4,$5,true)`,
          [productId, colourId, v.size, v.sku, v.stock],
        );
        variantsInserted++;
      }

      console.log(`+ Product (id ${productId}, ${p.status}${p.printOptions ? ", printing" : ""}): ${p.title} [${p.slug}] — ${p.variants.length} size(s), ${p.images.length} image(s)`);
      sortOrder++;
    }

    if (commit) {
      await client.query("COMMIT");
      console.log("\nCOMMITTED.");
    } else {
      await client.query("ROLLBACK");
      console.log("\nROLLED BACK (dry run — nothing written).");
    }
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`\nTotals: ${productsInserted} product(s) inserted, ${productsSkipped} already existed`);
  console.log(`        ${imagesInserted} image(s), ${variantsInserted} size variant(s)`);
  console.log(`        ${shippingInserted} shipping option(s) inserted, ${shippingSkipped} already existed`);
  console.log(`        ${codesInserted} discount code(s) inserted, ${codesSkipped2} already existed`);
  if (flags.length > 0) {
    console.log(`\nFlags for Daniel:`);
    for (const f of flags) console.log(`  ⚠ ${f}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
