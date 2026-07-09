// Import the harvested KELME catalogue into the MFL Store (org 3).
//
// Source: outputs/mfl-store/kelme-harvest/{products.json, upload_state.json}
//   (harvested from the KELME B2B console 2026-07-06; images already optimized
//    to WebP and uploaded to the public Supabase Storage bucket `shop-images`).
//
// Pricing rules (Daniel, 2026-07-06): kit (shirt+shorts) = $49.99 NZD,
// shirt-only = $39.99 NZD, regardless of cost. cost_usd stored as a
// reference note only (KELME FOB Xiamen, ex shipping/duties/GST).
//
// Stock: seeded from KELME Headquarters Inventory per colour/size (capped at
// 200) — this is KELME's warehouse availability, NOT stock we hold. Daniel
// adjusts real numbers in the Store tab as local stock arrives.
//
// Idempotent: upserts by (organization_id, slug); re-running refreshes
// colours/images/variants for unmodified products without duplicating.
//
// Run AFTER migrations/2026-07-06_mfl_shop.sql (+ seed-shop-mfl.ts):
//   npx tsx --env-file=.env script/import-kelme-products.ts

import { Pool } from "pg";
import * as fs from "fs";

const MFL_ORG_ID = 3;
const HARVEST = "/Users/danielmeyn/Desktop/AIOS/DanielMeynOS/outputs/mfl-store/kelme-harvest";
const STOCK_CAP = 200;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

type HarvestImage = { file: string; colourCode: string; back: boolean; seq: number };
type HarvestSize = { size: string; fullLabel: string; inventory: number };
type HarvestColour = { name: string; code: string; sizes: HarvestSize[] };
type HarvestProduct = {
  type: "kit" | "shirt";
  article: string;
  pdtid: number;
  costUsd: number | null;
  params: Record<string, string>;
  colours: HarvestColour[];
  images: HarvestImage[];
};

const HEX: Record<string, string> = {
  black: "#1d1d1d", white: "#f2f2f2", red: "#dc2626", yellow: "#eab308", "light yellow": "#fde047",
  "neon green": "#a3e635", green: "#16a34a", "mint green": "#6ee7b7", "dark green": "#166534",
  "dark blue": "#1e3a8a", navy: "#172554", "royal blue": "#2563eb", "sky blue": "#7dd3fc",
  "light blue": "#93c5fd", blue: "#2563eb", "lake blue": "#0e7490", turquoise: "#2dd4bf",
  "light turquoise": "#5eead4", orange: "#ea580c", purple: "#7c3aed", violet: "#8b5cf6",
  pink: "#ec4899", "rose hermosa": "#f43f5e", rose: "#f43f5e", maroon: "#7f1d1d", brown: "#78350f",
  grey: "#6b7280", gray: "#6b7280", "light grey": "#d1d5db", silver: "#cbd5e1", gold: "#d1b96e",
  "fluorescent green": "#a3e635", "fluorescent yellow": "#e8ff2a", cyan: "#22d3ee",
  beige: "#e7dcc3", khaki: "#bdb76b", wine: "#722f37", coffee: "#6f4e37",
};
function swatch(name: string): string | null {
  const n = name.toLowerCase().trim();
  if (HEX[n]) return HEX[n];
  const first = n.split("/")[0].trim();
  if (HEX[first]) return HEX[first];
  for (const [k, v] of Object.entries(HEX)) if (first.includes(k) || k.includes(first)) return v;
  return null;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(`${HARVEST}/products.json`, "utf8"));
  const uploads = JSON.parse(fs.readFileSync(`${HARVEST}/upload_state.json`, "utf8"));
  const urlFor = (file: string): string | null => {
    const key = "mfl/" + file.replace(/^images\//, "").replace(/\.(jpg|jpeg|png)$/i, ".webp");
    return uploads[key]?.url ?? null;
  };

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let created = 0, updated = 0, skipped = 0, sort = 0;
  try {
    for (const p of manifest.products as HarvestProduct[]) {
      sort += 10;
      // build colour set with images + sizes (skip colours with no usable image or sizes)
      const colours = p.colours
        .map((c) => {
          let imgs = p.images
            .filter((i) => i.colourCode === c.code)
            .sort((a, b) => Number(a.back) - Number(b.back) || a.seq - b.seq);
          if (!imgs.length && c.code) {
            imgs = p.images.filter((i) => i.colourCode.replace(/^0+/, "") === c.code.replace(/^0+/, ""));
          }
          const urls = imgs.map((i) => urlFor(i.file)).filter(Boolean) as string[];
          const sizes = c.sizes.filter((s) => s.size);
          return { ...c, urls, sizesClean: sizes };
        })
        .filter((c) => c.urls.length && c.sizesClean.length);
      if (!colours.length) { skipped++; continue; }

      const junior = colours[0].sizesClean.every((s) => /^\d/.test(s.size));
      const title = (junior ? "Junior " : "") + (p.type === "kit" ? "Football Kit " : "Football Shirt ") + p.article;
      const subtitle = p.type === "kit" ? "Shirt + shorts" : null;
      const material = p.params?.["Composition/Material"] || "";
      const description =
        (p.type === "kit"
          ? "Full kit — shirt and matching shorts. Match-ready breathable KELME polyester, built for game night."
          : "Training-grade KELME shirt. Breathable, durable, made to be worn every week.") +
        (junior ? " Junior cut — sizes are height-based (cm)." : "") +
        (material ? ` Material: ${material}.` : "");
      const priceCents = p.type === "kit" ? 4999 : 3999;
      const slug = p.article.toLowerCase();

      const { rows: existing } = await pool.query(
        `SELECT id FROM shop_products WHERE organization_id = $1 AND slug = $2`, [MFL_ORG_ID, slug]);
      let productId: number;
      if (existing.length) {
        productId = existing[0].id;
        await pool.query(
          `UPDATE shop_products SET title=$1, subtitle=$2, description=$3, type=$4, price_cents=$5, cost_usd=$6, updated_at=now() WHERE id=$7`,
          [title, subtitle, description, p.type, priceCents, p.costUsd, productId]);
        // refresh children
        await pool.query(`DELETE FROM shop_product_colours WHERE product_id=$1`, [productId]);
        await pool.query(`DELETE FROM shop_product_images WHERE product_id=$1`, [productId]);
        updated++;
      } else {
        const { rows } = await pool.query(
          `INSERT INTO shop_products (organization_id, slug, title, subtitle, description, type, price_cents, cost_usd, status, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9) RETURNING id`,
          [MFL_ORG_ID, slug, title, subtitle, description, p.type, priceCents, p.costUsd, sort]);
        productId = rows[0].id;
        created++;
      }

      // product-level card image (colour_id NULL) = first image of the first colour
      await pool.query(
        `INSERT INTO shop_product_images (product_id, colour_id, url, alt, sort_order) VALUES ($1,NULL,$2,$3,0)`,
        [productId, colours[0].urls[0], title]);

      let cSort = 0;
      for (const c of colours) {
        cSort += 10;
        const { rows: cRows } = await pool.query(
          `INSERT INTO shop_product_colours (product_id, name, swatch_hex, sort_order, active)
           VALUES ($1,$2,$3,$4,true) RETURNING id`,
          [productId, c.name, swatch(c.name), cSort]);
        const colourId = cRows[0].id;
        let iSort = 0;
        for (const u of c.urls) {
          iSort += 10;
          await pool.query(
            `INSERT INTO shop_product_images (product_id, colour_id, url, alt, sort_order) VALUES ($1,$2,$3,$4,$5)`,
            [productId, colourId, u, `${title} — ${c.name}`, iSort]);
        }
        for (const s of c.sizesClean) {
          const stock = Math.min(Math.max(s.inventory, 0), STOCK_CAP);
          await pool.query(
            `INSERT INTO shop_variants (product_id, colour_id, size, sku, stock, active)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (colour_id, size) DO UPDATE SET stock = EXCLUDED.stock, active = EXCLUDED.active`,
            [productId, colourId, s.size, `${p.article}-${c.code || "STD"}-${s.size}`, stock, stock > 0]);
        }
      }
      if ((created + updated) % 20 === 0) console.log(`… ${created + updated} products in`);
    }
    console.log(`DONE. created ${created}, updated ${updated}, skipped(no usable colours/images) ${skipped}`);
    console.log("Reminder: stock = KELME warehouse availability (capped 200), not local stock — adjust in the Store tab.");
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
