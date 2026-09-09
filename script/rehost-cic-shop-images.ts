/**
 * Cut the LIVE CIC store's last dependency on the SIU Shopify account.
 *
 * Probed 2026-09-09: all 5 CIC products (Hoodie, Cap, Keyring, Pin Badge, Gift
 * Card) carry 14 of 14 images hotlinked from
 * cdn.shopify.com/s/files/1/0797/3961/7528/ — the SIU Shopify CDN. Not "some":
 * every one. The day that account closes, shop.cicyouth.com loses every product
 * photo. This script re-hosts them onto ClubOS itself (client/public/shop/cic/),
 * the CUFC precedent — deliberately NOT the Supabase shop-images bucket, whose
 * org-wide free quota 402'd every project on 2026-09-05.
 *
 * 🔴 ORDER OF OPERATIONS — THIS BITES, AND IT BITES A LIVE STORE.
 *
 *   1. --download   writes the .webp files. Safe any time, changes nothing live.
 *   2. COMMIT + DEPLOY those files to prod.
 *   3. --commit     repoints the DB at /shop/cic/... — ONLY after step 2.
 *
 * Run --commit before the deploy and the live CIC store 404s every image, because
 * the DB will point at files production does not have yet. Same shape as the CUGC
 * DOB gate that 400'd the live trial form for a few minutes in August: deploy the
 * thing being pointed AT first, then point at it. --commit refuses to run unless
 * it can fetch each file from prod, so the mistake is hard to make.
 *
 *   npx tsx --env-file=.env script/rehost-cic-shop-images.ts --download
 *   npx tsx --env-file=.env script/rehost-cic-shop-images.ts             # dry run
 *   npx tsx --env-file=.env script/rehost-cic-shop-images.ts --commit
 */
import { Pool } from "pg";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const CIC_ORG_ID = 5;
const OUT_DIR = path.join(process.cwd(), "client/public/shop/cic");
const PUBLIC_PREFIX = "/shop/cic";
const PROD_BASE = "https://join.cicyouth.com";
const SHOPIFY_HOST = "cdn.shopify.com";

const download = process.argv.includes("--download");
const commit = process.argv.includes("--commit");

/** node's fetch is intermittently dead on this Mac (curl is not) — memory
 *  reference_clubos_node_fetch_broken. Shell out so this works either way. */
function curlBinary(url: string): Buffer {
  return execFileSync("curl", ["-fsSL", "--max-time", "60", url], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer",
  }) as unknown as Buffer;
}
function curlStatus(url: string): number {
  return parseInt(
    execFileSync("curl", ["-so", "/dev/null", "-w", "%{http_code}", "--max-time", "30", url], {
      encoding: "utf8",
    }).trim(),
    10,
  );
}

/** Stable local filename for a Shopify CDN url: {product-slug}-{n}.webp */
function localName(slug: string, n: number): string {
  return `${slug}-${n}.webp`;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT i.id, i.url, i.product_id, i.colour_id, p.slug, p.title
         FROM shop_product_images i
         JOIN shop_products p ON p.id = i.product_id
        WHERE p.organization_id = $1
        ORDER BY p.slug, i.sort_order, i.id`,
      [CIC_ORG_ID],
    );
    const hotlinked = rows.filter((r) => String(r.url || "").includes(SHOPIFY_HOST));
    console.log(`\n  CIC store images: ${rows.length} total, ${hotlinked.length} hotlinked from Shopify\n`);
    if (hotlinked.length === 0) {
      console.log("  Nothing to do — no image depends on the Shopify CDN.\n");
      return;
    }

    // Assign a deterministic local name per product, in sort order.
    const perProduct = new Map<string, number>();
    const plan = hotlinked.map((r) => {
      const n = (perProduct.get(r.slug) || 0) + 1;
      perProduct.set(r.slug, n);
      const file = localName(r.slug, n);
      return { ...r, file, newUrl: `${PUBLIC_PREFIX}/${file}` };
    });

    if (download) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      for (const p of plan) {
        const dest = path.join(OUT_DIR, p.file);
        if (fs.existsSync(dest)) {
          console.log(`  = ${p.file} (already downloaded)`);
          continue;
        }
        const buf = curlBinary(p.url);
        // Same recipe as the CUFC/SIU catalogues: 1600px wide, q82 WebP.
        await sharp(buf).resize({ width: 1600, withoutEnlargement: true })
          .webp({ quality: 82 }).toFile(dest);
        const kb = Math.round(fs.statSync(dest).size / 1024);
        console.log(`  + ${p.file}  (${kb} KB)  ← ${p.title}`);
      }
      console.log(`\n  Downloaded into ${OUT_DIR}`);
      console.log("  NEXT: commit + deploy these files, THEN re-run with --commit.\n");
      return;
    }

    // Both the dry run and --commit show exactly what would change.
    for (const p of plan) {
      const onDisk = fs.existsSync(path.join(OUT_DIR, p.file));
      console.log(`  ${p.title}`);
      console.log(`      from ${p.url.slice(0, 88)}`);
      console.log(`      to   ${p.newUrl}   ${onDisk ? "(file present)" : "🔴 FILE MISSING — run --download"}`);
    }

    if (!commit) {
      console.log(`\n  DRY RUN — nothing written. ${plan.length} image(s) would be repointed.`);
      console.log("  Run --download first, deploy, then --commit.\n");
      return;
    }

    // 🔴 The guard that makes the ordering mistake impossible: every file must
    // already be served by PRODUCTION before the DB is allowed to point at it.
    console.log("\n  Checking production actually serves each file before repointing…");
    const missing: string[] = [];
    for (const p of plan) {
      const code = curlStatus(`${PROD_BASE}${p.newUrl}`);
      console.log(`      ${code === 200 ? "✓" : "✗"} ${code}  ${p.newUrl}`);
      if (code !== 200) missing.push(p.newUrl);
    }
    if (missing.length > 0) {
      console.error(
        `\n  🔴 REFUSING TO WRITE. ${missing.length} file(s) are not on production yet.\n` +
        "  Repointing now would break every product photo on the LIVE CIC store.\n" +
        "  Commit + deploy the files in client/public/shop/cic/, then run --commit again.\n",
      );
      process.exitCode = 1;
      return;
    }

    await client.query("BEGIN");
    let n = 0;
    for (const p of plan) {
      const res = await client.query(
        `UPDATE shop_product_images SET url = $1 WHERE id = $2 AND url = $3`,
        [p.newUrl, p.id, p.url],
      );
      n += res.rowCount ?? 0;
    }
    const { rows: left } = await client.query(
      `SELECT COUNT(*)::int AS c FROM shop_product_images i
         JOIN shop_products p ON p.id = i.product_id
        WHERE p.organization_id = $1 AND i.url LIKE $2`,
      [CIC_ORG_ID, `%${SHOPIFY_HOST}%`],
    );
    if (left[0].c !== 0) {
      await client.query("ROLLBACK");
      console.error(`\n  🔴 ROLLED BACK — ${left[0].c} image(s) still on the Shopify CDN.\n`);
      process.exitCode = 1;
      return;
    }
    await client.query("COMMIT");
    console.log(`\n  ✓ ${n} image(s) repointed. The CIC store no longer needs the Shopify account.\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
