/**
 * Prove the CUFC Store (org 1, brand "cufc") works against a live ClubOS
 * origin, end to end — and that adding it changed nothing about MFL/CIC.
 *
 *   npx tsx --env-file=.env script/_verify-cufc-shop-live.ts
 *   npx tsx --env-file=.env script/_verify-cufc-shop-live.ts --base=https://join.cufc.co.nz
 *
 * Two halves, run independently so one half failing never hides the other:
 *
 *  1. PURE-FUNCTION — no network. Proves `tabsForOrgSlug("christchurch-united")`
 *     carries the "store" tab while south-island-united and united-gymnastics
 *     do not. Always meaningful, runs even with no server reachable at all.
 *
 *  2. LIVE HTTP — against --base (default https://join.cufc.co.nz, the CUFC
 *     assetBase/join host ClubOS itself serves). Until this branch is
 *     deployed, every CUFC-specific check below is EXPECTED to fail (the
 *     brand doesn't exist on prod yet) — that failure IS the proof the check
 *     works. The MFL/CIC "no regression" checks and the admin-401 check are
 *     expected to PASS today already, since they only exercise code that's
 *     already live.
 */
import { readFileSync } from "fs";
import { tabsForOrgSlug } from "../shared/tabs";

const BASE = process.argv.find((a) => a.startsWith("--base="))?.slice("--base=".length)
  || "https://join.cufc.co.nz";
const CATALOGUE_PATH = process.argv.find((a) => a.startsWith("--catalogue="))?.slice("--catalogue=".length)
  || "/Users/danielmeyn/Desktop/AIOS/DanielMeynOS/outputs/cufc-shop/2026-09-09-shopify-harvest/catalogue.json";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

console.log(`\n── 1. Pure-function: tab registry ──────────────────────────────\n`);
{
  const cufcSlugs = tabsForOrgSlug("christchurch-united").map((t) => t.slug);
  const siuSlugs = tabsForOrgSlug("south-island-united").map((t) => t.slug);
  const gymSlugs = tabsForOrgSlug("united-gymnastics").map((t) => t.slug);
  ok('tabsForOrgSlug("christchurch-united") includes "store"', cufcSlugs.includes("store"));
  ok('tabsForOrgSlug("south-island-united") does NOT include "store"', !siuSlugs.includes("store"));
  ok('tabsForOrgSlug("united-gymnastics") does NOT include "store"', !gymSlugs.includes("store"));
  // MFL/CIC still carry it (regression: their own workspace types are untouched).
  const mflSlugs = tabsForOrgSlug("mini-football-leagues").map((t) => t.slug);
  const cicSlugs = tabsForOrgSlug("christchurch-international-cup").map((t) => t.slug);
  ok('tabsForOrgSlug("mini-football-leagues") still includes "store"', mflSlugs.includes("store"));
  ok('tabsForOrgSlug("christchurch-international-cup") still includes "store"', cicSlugs.includes("store"));
}

console.log(`\n── 2. Live HTTP against ${BASE} ────────────────────────────────\n`);

interface Catalogue {
  products: { handle: string; status: string; cleanTitle: string; variants: { price: string }[] }[];
}
const catalogue: Catalogue = JSON.parse(readFileSync(CATALOGUE_PATH, "utf8"));
const activeProducts = catalogue.products.filter((p) => p.handle !== "name-and-number-print" ? p.status === "active" : false);
// name-and-number-print is force-drafted by the seed regardless of harvest status.
const expectedActiveCount = activeProducts.length;
const draftSlugs = new Set(
  catalogue.products.filter((p) => p.status === "draft" || p.handle === "name-and-number-print").map((p) => p.handle),
);

try {
  // ── Admin route stays gated ────────────────────────────────────────────
  const adminRes = await fetch(`${BASE}/api/admin/shop/products`, { redirect: "manual" });
  ok("admin /api/admin/shop/products refuses an anonymous request (401)", adminRes.status === 401, `HTTP ${adminRes.status}`);

  // ── No regression: MFL and CIC catalogs still serve ────────────────────
  const mflRes = await fetch(`${BASE}/api/public/shop/mfl/catalog`);
  ok("MFL catalog still 200 (no regression)", mflRes.status === 200, `HTTP ${mflRes.status}`);
  const cicRes = await fetch(`${BASE}/api/public/shop/cic/catalog`);
  ok("CIC catalog still 200 (no regression)", cicRes.status === 200, `HTTP ${cicRes.status}`);

  // ── The CUFC catalog itself ─────────────────────────────────────────────
  const catRes = await fetch(`${BASE}/api/public/shop/cufc/catalog`);
  ok("CUFC catalog reachable (200)", catRes.status === 200, `HTTP ${catRes.status} — NOT DEPLOYED YET if this fails`);

  if (catRes.status === 200) {
    const body: any = await catRes.json();
    ok(`store name is "Christchurch United Shop"`, body?.store?.name === "Christchurch United Shop", String(body?.store?.name));
    ok(`currency is NZD`, body?.store?.currency === "NZD", String(body?.store?.currency));
    const products: any[] = body?.products || [];
    ok(`catalog carries ${expectedActiveCount} active products`, products.length === expectedActiveCount, `got ${products.length}`);

    // Drafts absent.
    const returnedSlugs = new Set(products.map((p) => p.slug));
    let anyDraftLeaked = false;
    for (const slug of draftSlugs) {
      if (returnedSlugs.has(slug)) anyDraftLeaked = true;
    }
    ok("no draft product is in the public catalog", !anyDraftLeaked, [...draftSlugs].join(", "));

    // Spot-check prices against the harvest, for every active product whose
    // handle appears — the product-level price must equal the harvest's
    // lowest variant price, and where the harvest shows price variation the
    // API's per-colour/size prices must carry that variant's own price.
    let priceMismatches = 0, variantPriceMismatches = 0, checked = 0;
    for (const hp of activeProducts) {
      const found = products.find((p) => p.slug === hp.handle);
      if (!found) continue;
      checked++;
      const prices = hp.variants.map((v) => Math.round(parseFloat(v.price) * 100));
      const minCents = Math.min(...prices);
      const gotCents = Math.round(found.priceDollars * 100);
      if (gotCents !== minCents) priceMismatches++;
      const priceVaries = new Set(prices).size > 1;
      if (priceVaries) {
        // At least one colour/size in the API response must carry a
        // priceDollars that isn't the product-level (min) price.
        const anyVariantOverride = (found.colours || []).some((c: any) =>
          (c.sizes || []).some((s: any) => typeof s.priceDollars === "number" && Math.round(s.priceDollars * 100) !== minCents));
        if (!anyVariantOverride) variantPriceMismatches++;
      }
    }
    ok(`product-level prices match the harvest (${checked} checked)`, priceMismatches === 0, `${priceMismatches} mismatch(es)`);
    ok(`per-variant prices carry through where the harvest varies`, variantPriceMismatches === 0, `${variantPriceMismatches} product(s) missing an override`);

    // Every image URL in the catalog resolves.
    const imageUrls = new Set<string>();
    for (const p of products) {
      for (const im of p.images || []) if (im.url) imageUrls.add(im.url);
      for (const c of p.colours || []) for (const im of c.images || []) if (im.url) imageUrls.add(im.url);
    }
    let imgOk = 0, imgFail = 0;
    for (const url of imageUrls) {
      try {
        const r = await fetch(url);
        const ct = r.headers.get("content-type") || "";
        if (r.status === 200 && ct.startsWith("image/")) imgOk++; else imgFail++;
      } catch { imgFail++; }
    }
    ok(`every catalog image resolves (${imageUrls.size} image(s))`, imgFail === 0, `${imgOk} ok, ${imgFail} failed`);

    // Quote a U4-U8 set with Pickup and check the total matches the harvest.
    const u4u8 = products.find((p) => p.slug === "short-sleev-football-set-kids");
    if (u4u8) {
      const colour = u4u8.colours?.[0];
      const size = colour?.sizes?.[0];
      const pickup = body?.store?.shippingOptions?.find((s: any) => /pickup/i.test(s.label));
      if (colour && size && pickup) {
        const quoteRes = await fetch(`${BASE}/api/public/shop/cufc/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: [{ productId: u4u8.id, colourId: colour.id, size: size.size, qty: 1 }],
            shippingOptionId: pickup.id,
          }),
        });
        ok("quote for a U4-U8 set + Pickup succeeds", quoteRes.status === 200, `HTTP ${quoteRes.status}`);
        if (quoteRes.status === 200) {
          const q: any = await quoteRes.json();
          const expectedUnit = size.priceDollars ?? u4u8.priceDollars;
          ok("quote total = unit price + free pickup", q.totalDollars === expectedUnit, `expected $${expectedUnit}, got $${q.totalDollars}`);
        }
      } else {
        ok("quote for a U4-U8 set + Pickup succeeds", false, "could not find product/colour/size/pickup option to quote");
      }
    } else {
      ok("U4-U8 set present to quote", false, "short-sleev-football-set-kids not in catalog");
    }
  }
} catch (e: any) {
  console.error("\nLive checks aborted:", e?.message || e);
  fail++;
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail > 0 ? 1 : 0);
