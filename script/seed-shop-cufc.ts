// Seed the CUFC Store (org 1) — Christchurch United retail, replacing
// cufcshop.com (Shopify). Data comes verbatim from a real Shopify Admin API
// harvest (prices, sizes, colours, stock, descriptions — nothing invented),
// not a hand-typed list like the CIC/MFL seeds. Dry-run by default; the whole
// run (including the dry one) happens inside ONE transaction that is rolled
// back unless --commit is passed, so a dry run exercises the real DB
// constraints (unique indexes etc.) without writing anything.
//
// Idempotent on (organization_id=1, slug): a product whose slug already
// exists is left completely alone — never touched, never re-priced — so a
// re-run can never clobber an edit Daniel makes in the Store tab afterwards.
// Shipping options are idempotent on label the same way.
//
//   npx tsx --env-file=.env script/seed-shop-cufc.ts                 # dry run (default)
//   npx tsx --env-file=.env script/seed-shop-cufc.ts --commit        # write
//   npx tsx --env-file=.env script/seed-shop-cufc.ts --catalogue=/path/to/catalogue.json

import { Pool, type PoolClient } from "pg";
import { readFileSync } from "fs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const CUFC_ORG_ID = 1;

const DEFAULT_CATALOGUE =
  "/Users/danielmeyn/Desktop/AIOS/DanielMeynOS/outputs/cufc-shop/2026-09-09-shopify-harvest/catalogue.json";

// Products the harvest reports differently than the live store actually
// behaves — corrections applied here rather than hand-editing the harvest
// file, so the harvest stays an honest, untouched record of what Shopify said.
//
// "name-and-number-print": Shopify's Admin API reports it `active`, but it has
// zero stock and zero images and is NOT reachable as a buyable product on the
// live cufcshop.com storefront (confirmed by browsing the live site during the
// harvest). Seeding it live would sell something nobody can actually order.
const FORCE_DRAFT = new Set<string>(["name-and-number-print"]);

// ── Shipping (org-level, same shape as the CIC/MFL seeds) ──────────────────
// ⚠️ PLACEHOLDER — Daniel confirms the real courier rate; Shopify's own rates
// were not readable from the Admin API scope this harvest was granted.
const SHIPPING = [
  {
    label: "Pickup — United Sports Centre",
    description: "Free — collect from the club office at United Sports Centre, 466 Yaldhurst Road, Christchurch.",
    priceCents: 0,
    requiresAddress: false,
    sortOrder: 0,
  },
  {
    label: "NZ Courier",
    description: "Tracked courier, 2–4 working days anywhere in New Zealand.",
    priceCents: 999, // ⚠️ placeholder — confirm the real courier rate with Daniel
    requiresAddress: true,
    sortOrder: 1,
  },
];

// ── Colour swatches — only unambiguous, single-word colour names ───────────
const SWATCH_HEX: Record<string, string> = {
  Blue: "#263996",
  White: "#FFFFFF",
  Black: "#000000",
  Navy: "#0C1640",
  Grey: "#8A8A8A",
  Gray: "#8A8A8A",
};

// ── Harvest shape (subset actually used) ────────────────────────────────────
interface HarvestImage {
  shopifyId: number;
  file: string;
  alt: string;
  variantIds: number[];
}
interface HarvestVariant {
  shopifyId: number;
  title: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  sku: string | null;
  price: string;
  inventoryQuantity: number;
  imageId: number | null;
}
interface HarvestProduct {
  handle: string;
  title: string; // raw title, WITH the supplier article code — the true duplicate key
  cleanTitle: string;
  status: "active" | "draft";
  category: string;
  audience: "adults" | "kids" | "all";
  options: string[];
  description: string;
  images: HarvestImage[];
  variants: HarvestVariant[];
}
interface Catalogue {
  storeEmail: string;
  currency: string;
  products: HarvestProduct[];
}

// ── Transform: harvest product → seedable colour/variant/image tree ────────
interface BuildColour {
  name: string;
  swatchHex: string | null;
  images: { file: string; alt: string }[];
  variants: { size: string; sku: string | null; stock: number; priceCents: number | null }[];
}
interface BuildProduct {
  slug: string;
  title: string;
  subtitle: string | null; // audience, since shop_products has no tag column
  description: string;
  type: string;
  priceCents: number; // lowest variant price
  status: "active" | "draft";
  colours: BuildColour[];
}

const dollarsToCents = (s: string) => Math.round(parseFloat(s) * 100);

function buildProduct(p: HarvestProduct): BuildProduct {
  const colorIdx = p.options.indexOf("Color");
  const sizeIdx = p.options.indexOf("Size");
  const optAt = (v: HarvestVariant, idx: number): string | null =>
    idx === 0 ? v.option1 : idx === 1 ? v.option2 : idx === 2 ? v.option3 : null;
  const colourOf = (v: HarvestVariant) => (colorIdx >= 0 ? optAt(v, colorIdx) || "Default" : "Default");
  const sizeOf = (v: HarvestVariant) => (sizeIdx >= 0 ? optAt(v, sizeIdx) || "One size" : "One size");

  const colourOrder: string[] = [];
  for (const v of p.variants) {
    const c = colourOf(v);
    if (!colourOrder.includes(c)) colourOrder.push(c);
  }

  const variantColourById = new Map<number, string>();
  for (const v of p.variants) variantColourById.set(v.shopifyId, colourOf(v));

  // Image → colour assignment. When the product has only one colour, every
  // image belongs to it (Shopify often leaves the single colour's images
  // untagged with variantIds since there's nothing to disambiguate). When
  // there are multiple colours, an image is assigned by which variants its
  // own variantIds list actually references.
  const imagesByColour = new Map<string, HarvestImage[]>();
  for (const c of colourOrder) imagesByColour.set(c, []);
  if (colourOrder.length === 1) {
    imagesByColour.set(colourOrder[0], [...p.images]);
  } else {
    for (const im of p.images) {
      const cols = new Set<string>();
      for (const vid of im.variantIds) {
        const c = variantColourById.get(vid);
        if (c) cols.add(c);
      }
      for (const c of cols) imagesByColour.get(c)?.push(im);
      if (cols.size === 0) {
        console.warn(`  ⚠ ${p.handle}: image ${im.file} has no colour it can be matched to (multi-colour product) — skipped`);
      }
    }
  }

  const allPricesCents = p.variants.map((v) => dollarsToCents(v.price));
  const minPriceCents = Math.min(...allPricesCents);
  const priceVaries = new Set(allPricesCents).size > 1;

  const colours: BuildColour[] = colourOrder.map((cname) => {
    const vs = p.variants.filter((v) => colourOf(v) === cname);
    return {
      name: cname,
      swatchHex: SWATCH_HEX[cname] ?? null,
      images: (imagesByColour.get(cname) || []).map((im) => ({ file: im.file, alt: im.alt || p.cleanTitle })),
      variants: vs.map((v) => ({
        size: sizeOf(v),
        sku: v.sku || null,
        stock: Math.max(0, v.inventoryQuantity),
        priceCents: priceVaries ? dollarsToCents(v.price) : null,
      })),
    };
  });

  const audience = p.audience === "adults" ? "Adults" : p.audience === "kids" ? "Kids" : null;

  return {
    slug: p.handle,
    title: p.cleanTitle,
    subtitle: audience,
    description: p.description || "",
    type: p.category,
    priceCents: minPriceCents,
    status: FORCE_DRAFT.has(p.handle) ? "draft" : p.status,
    colours,
  };
}

async function main() {
  const commit = process.argv.includes("--commit");
  const catalogueArg = process.argv.find((a) => a.startsWith("--catalogue="));
  const cataloguePath = catalogueArg ? catalogueArg.slice("--catalogue=".length) : DEFAULT_CATALOGUE;

  const raw: Catalogue = JSON.parse(readFileSync(cataloguePath, "utf8"));
  console.log(`Catalogue: ${cataloguePath}`);
  console.log(`Mode: ${commit ? "COMMIT (writing)" : "DRY RUN (rolled back at the end)"}\n`);

  const built = raw.products.map(buildProduct);

  const flags: string[] = [];
  // Duplicate detection keys on the RAW Shopify title (including the supplier
  // article code) — that's what actually identifies "the same product listed
  // twice", not the display title after the code is stripped. Two different
  // colourways of the same style (e.g. Blue vs White socks) legitimately
  // share a display title but carry different article codes, and flagging
  // those as duplicates would be noise, not a real finding.
  const seenRawTitles = new Map<string, string[]>();
  for (const rp of raw.products) {
    seenRawTitles.set(rp.title, [...(seenRawTitles.get(rp.title) || []), rp.handle]);
  }
  for (const [title, handles] of seenRawTitles) {
    if (handles.length > 1) flags.push(`Duplicate listing "${title}": ${handles.join(", ")} — same article code, seeded both verbatim, needs Daniel's call.`);
  }
  for (const p of built) {
    if (p.status === "draft" && FORCE_DRAFT.has(p.slug)) {
      flags.push(`"${p.slug}" forced to draft (harvest said active, but it has no stock/images and isn't buyable on the live site).`);
    }
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client: PoolClient = await pool.connect();
  let productsInserted = 0, coloursInserted = 0, imagesInserted = 0, variantsInserted = 0, shippingInserted = 0;
  let productsSkipped = 0, shippingSkipped = 0;

  try {
    await client.query("BEGIN");

    // ── Shipping ───────────────────────────────────────────────────────────
    for (const opt of SHIPPING) {
      const { rows } = await client.query(
        `SELECT id FROM shop_shipping_options WHERE organization_id = $1 AND label = $2`,
        [CUFC_ORG_ID, opt.label],
      );
      if (rows.length > 0) {
        console.log(`✓ Shipping exists (id ${rows[0].id}): ${opt.label}`);
        shippingSkipped++;
        continue;
      }
      const { rows: created } = await client.query(
        `INSERT INTO shop_shipping_options (organization_id, label, description, price_cents, requires_address, active, sort_order)
         VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING id`,
        [CUFC_ORG_ID, opt.label, opt.description, opt.priceCents, opt.requiresAddress, opt.sortOrder],
      );
      console.log(`+ Shipping (id ${created[0].id}): ${opt.label} — $${(opt.priceCents / 100).toFixed(2)}`);
      shippingInserted++;
    }

    // ── Products ───────────────────────────────────────────────────────────
    let sortOrder = 0;
    for (const p of built) {
      const { rows: existing } = await client.query(
        `SELECT id FROM shop_products WHERE organization_id = $1 AND slug = $2`,
        [CUFC_ORG_ID, p.slug],
      );
      if (existing.length > 0) {
        console.log(`✓ Product exists (id ${existing[0].id}): ${p.title} [${p.slug}] — left untouched`);
        productsSkipped++;
        sortOrder++;
        continue;
      }

      const { rows: prod } = await client.query(
        `INSERT INTO shop_products (organization_id, slug, title, subtitle, description, type, price_cents, status, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [CUFC_ORG_ID, p.slug, p.title, p.subtitle, p.description, p.type, p.priceCents, p.status, sortOrder],
      );
      const productId = prod[0].id as number;
      productsInserted++;

      let colourOrder = 0;
      let variantCount = 0, imageCount = 0;
      for (const c of p.colours) {
        const { rows: col } = await client.query(
          `INSERT INTO shop_product_colours (product_id, name, swatch_hex, sort_order, active)
           VALUES ($1,$2,$3,$4,true) RETURNING id`,
          [productId, c.name, c.swatchHex, colourOrder++],
        );
        const colourId = col[0].id as number;
        coloursInserted++;

        let imgOrder = 0;
        for (const im of c.images) {
          await client.query(
            `INSERT INTO shop_product_images (product_id, colour_id, url, alt, sort_order)
             VALUES ($1,$2,$3,$4,$5)`,
            [productId, colourId, `/shop/cufc/${im.file}`, im.alt, imgOrder++],
          );
          imagesInserted++; imageCount++;
        }

        for (const v of c.variants) {
          await client.query(
            `INSERT INTO shop_variants (product_id, colour_id, size, sku, stock, price_cents, active)
             VALUES ($1,$2,$3,$4,$5,$6,true)`,
            [productId, colourId, v.size, v.sku, v.stock, v.priceCents],
          );
          variantsInserted++; variantCount++;
        }
      }

      console.log(`+ Product (id ${productId}, ${p.status}): ${p.title} [${p.slug}] — ${p.colours.length} colour(s), ${variantCount} variant(s), ${imageCount} image(s)`);
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
  console.log(`        ${coloursInserted} colour(s), ${imagesInserted} image(s), ${variantsInserted} variant(s)`);
  console.log(`        ${shippingInserted} shipping option(s) inserted, ${shippingSkipped} already existed`);
  if (flags.length > 0) {
    console.log(`\nFlags for Daniel:`);
    for (const f of flags) console.log(`  ⚠ ${f}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
