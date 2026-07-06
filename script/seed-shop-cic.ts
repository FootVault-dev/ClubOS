// Seed the CIC Store (org 5) — Christchurch International Cup merch.
// Products/prices/descriptions transferred verbatim from the temporary CIC
// collection on shop.southislandunited.com. Idempotent: skips any product whose
// slug already exists for the org, and any shipping option whose label exists.
//
// ⚠️ Shipping prices below are PLACEHOLDERS — Daniel to confirm real rates.
//
// Run AFTER migrations/2026-07-06_mfl_shop.sql + 2026-07-07_shop_variant_price.sql:
//   npx tsx --env-file=.env script/seed-shop-cic.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const CIC_ORG_ID = 5;
const CDN = "https://cdn.shopify.com/s/files/1/0797/3961/7528/files/";

const SHIPPING = [
  {
    label: "Pickup — CIC merch stand (tournament)",
    description: "Free — collect from the CIC merch stand during the tournament.",
    priceCents: 0,
    requiresAddress: false,
    sortOrder: 0,
  },
  {
    label: "NZ Courier",
    description: "Tracked courier, 2–4 working days anywhere in New Zealand.",
    priceCents: 999, // ⚠️ placeholder — confirm real courier rate with Daniel
    requiresAddress: true,
    sortOrder: 1,
  },
  {
    label: "International shipping",
    description: "Tracked worldwide from New Zealand.",
    priceCents: 2499, // ⚠️ placeholder — confirm real international rate with Daniel
    requiresAddress: true,
    sortOrder: 2,
  },
];

interface SeedSize {
  size: string;
  stock?: number;
  priceCents?: number;
}
interface SeedProduct {
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  type: string; // 'apparel' | 'accessory' | 'giftcard'
  priceCents: number;
  badge?: string;
  images: { file: string; alt: string }[];
  sizes: SeedSize[];
}

const PRODUCTS: SeedProduct[] = [
  {
    slug: "cic-hoodie",
    title: "CIC Hoodie",
    subtitle: "Heavyweight embroidered hoodie",
    type: "apparel",
    priceCents: 7000,
    badge: "Pre-order",
    description:
      "A clean, heavyweight unisex hoodie in black with the Christchurch International Cup crest embroidered on the chest in silver thread. Built to last well beyond the tournament. 100% cotton heavyweight fleece, 380gsm. Unisex fit. Proudly shipping worldwide from New Zealand.",
    images: [
      { file: "CICHoodie1.png?v=1781664292", alt: "CIC Hoodie" },
      { file: "CIC_Hoodie_Size_Chart.png?v=1781667099", alt: "CIC Hoodie size chart" },
    ],
    sizes: [
      { size: "Y12" }, { size: "Y14" }, { size: "S" }, { size: "M" },
      { size: "L" }, { size: "XL" }, { size: "2XL" },
    ],
  },
  {
    slug: "cic-cap",
    title: "CIC Cap",
    subtitle: "Six-panel cap, woven patch",
    type: "apparel",
    priceCents: 2500,
    description:
      "Classic six-panel baseball cap in black with a woven CIC patch on the front. Clean, understated design built for matchday and beyond. 100% cotton, structured six-panel construction, metal buckle closure. Two sizes: 56 cm (kids) and 58 cm (youth/adult).",
    images: [
      { file: "CIC_Cap.png?v=1781493140", alt: "CIC Cap" },
      { file: "CICcapswithwovenpatch.jpg?v=1780911526", alt: "CIC Cap with woven patch" },
    ],
    sizes: [{ size: "Kids" }, { size: "Adults" }],
  },
  {
    slug: "cic-keyring",
    title: "CIC Keyring",
    subtitle: "Die-cast trophy keyring",
    type: "accessory",
    priceCents: 1490,
    description:
      "A miniature replica of the Christchurch International Cup trophy — crafted in high-gloss gold metal and designed to last. Every time you reach for your keys, you'll be reminded of the tournament, the matches, and the memories made on the pitch in Christchurch. A perfect gift for players, coaches and supporters alike.",
    images: [
      { file: "CICTrophykeyring2.jpg?v=1780915138", alt: "CIC trophy keyring" },
      { file: "CICTrophykeyring.jpg?v=1780915138", alt: "CIC trophy keyring" },
    ],
    sizes: [{ size: "One size" }],
  },
  {
    slug: "cic-pin-badge",
    title: "CIC Pin Badge",
    subtitle: "Collector's enamel pin",
    type: "accessory",
    priceCents: 600,
    description:
      "A collector's pin straight from New Zealand's premier international youth football tournament. Finished in black soft enamel with polished silver details. Zinc alloy construction, butterfly clip fastening, 30 mm diameter. Official Christchurch International Cup merchandise.",
    images: [
      { file: "IMG_1923.jpg?v=1781490543", alt: "CIC pin badge" },
      { file: "IMG_1924.jpg?v=1781490543", alt: "CIC pin badge" },
      { file: "IMG_1928.jpg?v=1781490543", alt: "CIC pin badge" },
      { file: "IMG_1920.jpg?v=1781490543", alt: "CIC pin badge" },
    ],
    sizes: [{ size: "One size" }],
  },
  {
    slug: "cic-gift-card",
    title: "CIC Gift Card",
    subtitle: "Spend it at the CIC merch stand",
    type: "giftcard",
    priceCents: 1000, // base = lowest denomination (drives "from $10")
    description:
      "The ultimate gift for any young footballer heading to the Christchurch International Cup. Send your player with something even better than cash — a CIC Gift Card they can spend exactly how they want at the tournament merch stand. Their tournament, their choice.",
    images: [
      { file: "CICGiftCard.png?v=1782094196", alt: "CIC Gift Card" },
      { file: "CIC_Gift_Card_25_82d630d5-cd01-4a19-8a00-535c4a94902b.png?v=1782094371", alt: "CIC $25 Gift Card" },
      { file: "CIC_Gift_Card_50_45f5dac7-0112-449f-bb69-dc9aa8bf0003.png?v=1782094385", alt: "CIC $50 Gift Card" },
      { file: "CIC_Gift_Card_100_d4c13b71-612d-4769-8ba4-884e9be56647.png?v=1782094397", alt: "CIC $100 Gift Card" },
    ],
    sizes: [
      { size: "$10", priceCents: 1000 },
      { size: "$25", priceCents: 2500 },
      { size: "$50", priceCents: 5000 },
      { size: "$100", priceCents: 10000 },
      { size: "$250", priceCents: 25000 },
      { size: "$500", priceCents: 50000 },
    ],
  },
];

const DEFAULT_STOCK = 500;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // ── Shipping options ──────────────────────────────────────────────────
    for (const opt of SHIPPING) {
      const { rows } = await pool.query(
        `SELECT id FROM shop_shipping_options WHERE organization_id = $1 AND label = $2`,
        [CIC_ORG_ID, opt.label],
      );
      if (rows.length > 0) {
        console.log(`✓ Shipping exists (id ${rows[0].id}): ${opt.label}`);
        continue;
      }
      const { rows: created } = await pool.query(
        `INSERT INTO shop_shipping_options (organization_id, label, description, price_cents, requires_address, active, sort_order)
         VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING id`,
        [CIC_ORG_ID, opt.label, opt.description, opt.priceCents, opt.requiresAddress, opt.sortOrder],
      );
      console.log(`+ Shipping (id ${created[0].id}): ${opt.label} — $${(opt.priceCents / 100).toFixed(2)}`);
    }

    // ── Products ──────────────────────────────────────────────────────────
    let sortOrder = 0;
    for (const p of PRODUCTS) {
      const { rows: existing } = await pool.query(
        `SELECT id FROM shop_products WHERE organization_id = $1 AND slug = $2`,
        [CIC_ORG_ID, p.slug],
      );
      if (existing.length > 0) {
        console.log(`✓ Product exists (id ${existing[0].id}): ${p.title}`);
        sortOrder++;
        continue;
      }

      const { rows: prod } = await pool.query(
        `INSERT INTO shop_products (organization_id, slug, title, subtitle, description, type, price_cents, badge, status, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9) RETURNING id`,
        [CIC_ORG_ID, p.slug, p.title, p.subtitle, p.description, p.type, p.priceCents, p.badge ?? null, sortOrder],
      );
      const productId = prod[0].id as number;

      // One default colour carries the images + variants (CIC has no colourways).
      const { rows: col } = await pool.query(
        `INSERT INTO shop_product_colours (product_id, name, sort_order, active)
         VALUES ($1,'Default',0,true) RETURNING id`,
        [productId],
      );
      const colourId = col[0].id as number;

      let imgOrder = 0;
      for (const im of p.images) {
        await pool.query(
          `INSERT INTO shop_product_images (product_id, colour_id, url, alt, sort_order)
           VALUES ($1,$2,$3,$4,$5)`,
          [productId, colourId, CDN + im.file, im.alt, imgOrder++],
        );
      }

      for (const s of p.sizes) {
        await pool.query(
          `INSERT INTO shop_variants (product_id, colour_id, size, stock, price_cents, active)
           VALUES ($1,$2,$3,$4,$5,true)`,
          [productId, colourId, s.size, s.stock ?? DEFAULT_STOCK, s.priceCents ?? null],
        );
      }

      console.log(`+ Product (id ${productId}): ${p.title} — ${p.sizes.length} variant(s), ${p.images.length} image(s)`);
      sortOrder++;
    }

    console.log("Done. Reminder: CIC shipping prices are placeholders — confirm with Daniel.");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
