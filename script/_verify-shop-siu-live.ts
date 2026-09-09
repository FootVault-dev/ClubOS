/**
 * Prove the SIU Store (org 2, brand "siu") works against a live ClubOS
 * origin, end to end — and that adding it changed nothing about MFL/CIC/CUFC.
 *
 *   npx tsx --env-file=.env script/_verify-shop-siu-live.ts
 *   npx tsx --env-file=.env script/_verify-shop-siu-live.ts --base=https://join.southislandunited.com
 *
 * Two halves, run independently so one half failing never hides the other:
 *
 *  1. PURE-FUNCTION — no network. Proves `tabsForOrgSlug("south-island-united")`
 *     carries the "store" tab while christchurch-united (its own copy),
 *     united-gymnastics and mini-football-leagues behave as expected.
 *     Always meaningful, runs even with no server reachable at all.
 *
 *  2. LIVE HTTP — against --base (default https://join.southislandunited.com,
 *     the SIU assetBase/join host ClubOS itself serves). Until BOTH (a) this
 *     branch is deployed and (b) migrations/2026-09-09_shop_print_options.sql
 *     has been applied for real and (c) script/seed-shop-siu.ts has been run
 *     with --commit, every SIU-specific check below is EXPECTED to fail —
 *     that failure IS the proof the check works. The MFL/CIC/CUFC "no
 *     regression" checks and the admin-401 check are expected to PASS today
 *     already, since they only exercise code that's already live.
 */
import { tabsForOrgSlug } from "../shared/tabs";

const BASE = process.argv.find((a) => a.startsWith("--base="))?.slice("--base=".length)
  || "https://join.southislandunited.com";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

console.log(`\n── 1. Pure-function: tab registry ──────────────────────────────\n`);
{
  const siuSlugs = tabsForOrgSlug("south-island-united").map((t) => t.slug);
  const cufcSlugs = tabsForOrgSlug("christchurch-united").map((t) => t.slug);
  const gymSlugs = tabsForOrgSlug("united-gymnastics").map((t) => t.slug);
  ok('tabsForOrgSlug("south-island-united") includes "store"', siuSlugs.includes("store"));
  ok('tabsForOrgSlug("christchurch-united") still includes its OWN "store" (regression)', cufcSlugs.includes("store"));
  ok('tabsForOrgSlug("united-gymnastics") does NOT include "store"', !gymSlugs.includes("store"));
  const mflSlugs = tabsForOrgSlug("mini-football-leagues").map((t) => t.slug);
  const cicSlugs = tabsForOrgSlug("christchurch-international-cup").map((t) => t.slug);
  ok('tabsForOrgSlug("mini-football-leagues") still includes "store" (regression)', mflSlugs.includes("store"));
  ok('tabsForOrgSlug("christchurch-international-cup") still includes "store" (regression)', cicSlugs.includes("store"));
}

console.log(`\n── 2. Live HTTP against ${BASE} ────────────────────────────────\n`);

// Expected active product count from the seed's own selection rule: every
// Shopify-active product, minus nothing (all 18 active products are kept).
const EXPECTED_ACTIVE_COUNT = 18;

// Adult ladder: $130 plain / $149.99 printed. Youth ladder: $120 / $139.99.
// Printing add-on = $19.99 on both, verified against the Shopify export in
// seed-shop-siu.ts (computed per-product, not hardcoded there — hardcoded
// here deliberately, as the independent expectation this test is checking).
const ADULT_SLUG = "2026-player-home-jersey";
const YOUTH_SLUG = "2026-player-away-jersey-youth";

async function getJson(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, init);
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body };
}

async function postJson(path: string, payload: unknown) {
  return getJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

try {
  // ── Admin route stays gated ────────────────────────────────────────────
  const adminRes = await fetch(`${BASE}/api/admin/shop/products`, { redirect: "manual" });
  ok("admin /api/admin/shop/products refuses an anonymous request with 401, not 404",
    adminRes.status === 401, `HTTP ${adminRes.status}`);

  // ── No regression: MFL, CIC and CUFC catalogs still serve ──────────────
  for (const brand of ["mfl", "cic", "cufc"]) {
    const r = await getJson(`/api/public/shop/${brand}/catalog`);
    ok(`${brand.toUpperCase()} catalog still 200 (no regression)`, r.status === 200, `HTTP ${r.status}`);
  }

  // ── The SIU catalog itself ───────────────────────────────────────────────
  const catRes = await getJson(`/api/public/shop/siu/catalog`);
  ok("SIU catalog reachable (200)", catRes.status === 200,
    `HTTP ${catRes.status} — NOT DEPLOYED / NOT SEEDED YET if this fails`);

  let products: any[] = [];
  let shippingOptions: any[] = [];
  if (catRes.status === 200) {
    const body = catRes.body;
    ok('store name is "South Island United Store"', body?.store?.name === "South Island United Store", String(body?.store?.name));
    ok("currency is NZD", body?.store?.currency === "NZD", String(body?.store?.currency));
    products = body?.products || [];
    shippingOptions = body?.store?.shippingOptions || [];
    ok(`catalog carries ${EXPECTED_ACTIVE_COUNT} active products`, products.length === EXPECTED_ACTIVE_COUNT, `got ${products.length}`);

    // The 9 CIC-tagged drafts and 9 empty-image drafts must never appear —
    // and neither must the 4 kept-but-draft products (Fusion Puffer Vest +
    // 3 youth GK jerseys), since draft is excluded from the public catalog
    // by the engine itself (status = 'active' filter), not by the seed.
    const neverPublic = [
      "cic-hoodie", "cic-cap", "cic-keyring", "cic-2026-gift-card",
      "bucket-hat", "fan-scarf", "key-ring-1", "pin-badge-1",
      "2026-fusion-puffer-vest", "2026-player-goal-keeper-away-jersey-youth",
    ];
    const returnedSlugs = new Set(products.map((p: any) => p.slug));
    const leaked = neverPublic.filter((s) => returnedSlugs.has(s));
    ok("no CIC/empty-placeholder/draft product leaks into the public catalog", leaked.length === 0, leaked.join(", "));

    // Every image URL in the catalog resolves and is a real image.
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
    ok(`every catalog image resolves (${imageUrls.size} image(s))`, imageUrls.size > 0 && imgFail === 0, `${imgOk} ok, ${imgFail} failed`);

    // Every jersey product carries a printOptions block with the contract
    // shape; every non-jersey product carries none.
    const jerseySlugs = products.filter((p: any) => /jersey/i.test(p.type) || /jersey/i.test(p.title)).map((p: any) => p.slug);
    const missingPrintOptions = products.filter((p: any) => jerseySlugs.includes(p.slug) && !p.printOptions);
    ok(`every jersey product carries printOptions (${jerseySlugs.length} jersey product(s))`, missingPrintOptions.length === 0,
      missingPrintOptions.map((p: any) => p.slug).join(", "));
    const nonJerseyWithPrintOptions = products.filter((p: any) => !jerseySlugs.includes(p.slug) && p.printOptions);
    ok("no non-jersey product carries printOptions", nonJerseyWithPrintOptions.length === 0,
      nonJerseyWithPrintOptions.map((p: any) => p.slug).join(", "));
  }

  const adult = products.find((p: any) => p.slug === ADULT_SLUG);
  const youth = products.find((p: any) => p.slug === YOUTH_SLUG);
  const pickup = shippingOptions.find((s: any) => /pickup/i.test(s.label));

  function firstColourAndSize(p: any) {
    const colour = p?.colours?.[0];
    const size = colour?.sizes?.[0];
    return { colour, size };
  }

  // ── Quote: plain price, no printing chosen ──────────────────────────────
  if (adult && pickup) {
    const { colour, size } = firstColourAndSize(adult);
    const q = await postJson(`/api/public/shop/siu/quote`, {
      items: [{ productId: adult.id, colourId: colour.id, size: size.size, qty: 1 }],
      shippingOptionId: pickup.id,
    });
    ok("quote for an adult jersey with NO printing succeeds", q.status === 200, `HTTP ${q.status}`);
    if (q.status === 200) {
      const line = q.body.lines[0];
      ok("adult jersey, no printing = $130.00 unit / $0.00 print", line.unitDollars === 130 && line.printDollars === 0,
        `unit=${line.unitDollars} print=${line.printDollars}`);
      ok("adult jersey, no printing → total = $130.00", q.body.totalDollars === 130, `got $${q.body.totalDollars}`);
    }
  } else {
    ok("adult jersey + pickup available to quote", false, "could not find product/shipping to quote");
  }

  // ── Quote: Player printing chosen (name + number supplied) ─────────────
  if (adult && pickup) {
    const { colour, size } = firstColourAndSize(adult);
    const q = await postJson(`/api/public/shop/siu/quote`, {
      items: [{
        productId: adult.id, colourId: colour.id, size: size.size, qty: 1,
        units: [{ print: "player", name: "MEYN", number: "29" }],
      }],
      shippingOptionId: pickup.id,
    });
    ok("quote for an adult jersey with Player printing succeeds", q.status === 200, `HTTP ${q.status}`);
    if (q.status === 200) {
      const line = q.body.lines[0];
      ok("adult jersey, Player printing = $130.00 unit + $19.99 print = $149.99 line",
        line.unitDollars === 130 && line.printDollars === 19.99 && line.lineDollars === 149.99,
        `unit=${line.unitDollars} print=${line.printDollars} line=${line.lineDollars}`);
    }
  }

  // ── Quote: Custom printing chosen ───────────────────────────────────────
  if (adult && pickup) {
    const { colour, size } = firstColourAndSize(adult);
    const q = await postJson(`/api/public/shop/siu/quote`, {
      items: [{
        productId: adult.id, colourId: colour.id, size: size.size, qty: 1,
        units: [{ print: "custom", name: "UNITED", number: "7" }],
      }],
      shippingOptionId: pickup.id,
    });
    ok("adult jersey, Custom printing also = $149.99 line",
      q.status === 200 && q.body.lines[0].lineDollars === 149.99, `HTTP ${q.status}, line=${q.body?.lines?.[0]?.lineDollars}`);
  }

  // ── Youth ladder ─────────────────────────────────────────────────────────
  if (youth && pickup) {
    const { colour, size } = firstColourAndSize(youth);
    const plain = await postJson(`/api/public/shop/siu/quote`, {
      items: [{ productId: youth.id, colourId: colour.id, size: size.size, qty: 1 }],
      shippingOptionId: pickup.id,
    });
    ok("youth jersey, no printing = $120.00", plain.status === 200 && plain.body.totalDollars === 120,
      `HTTP ${plain.status}, total=${plain.body?.totalDollars}`);
    const printed = await postJson(`/api/public/shop/siu/quote`, {
      items: [{
        productId: youth.id, colourId: colour.id, size: size.size, qty: 1,
        units: [{ print: "player", name: "MEYN", number: "9" }],
      }],
      shippingOptionId: pickup.id,
    });
    ok("youth jersey, Player printing = $139.99", printed.status === 200 && printed.body.lines[0].lineDollars === 139.99,
      `HTTP ${printed.status}, line=${printed.body?.lines?.[0]?.lineDollars}`);
  } else {
    ok("youth jersey + pickup available to quote", false, "could not find product/shipping to quote");
  }

  // ── An unknown printing key is refused ──────────────────────────────────
  if (adult && pickup) {
    const { colour, size } = firstColourAndSize(adult);
    const q = await postJson(`/api/public/shop/siu/quote`, {
      items: [{
        productId: adult.id, colourId: colour.id, size: size.size, qty: 1,
        units: [{ print: "glitter", name: "MEYN", number: "9" }],
      }],
      shippingOptionId: pickup.id,
    });
    ok("an unknown printing key is refused (4xx)", q.status >= 400 && q.status < 500, `HTTP ${q.status}`);
  }

  // ── A choice that needs a name, with no name, is refused ────────────────
  if (adult && pickup) {
    const { colour, size } = firstColourAndSize(adult);
    const q = await postJson(`/api/public/shop/siu/quote`, {
      items: [{
        productId: adult.id, colourId: colour.id, size: size.size, qty: 1,
        units: [{ print: "player", number: "9" }], // no name
      }],
      shippingOptionId: pickup.id,
    });
    ok("Player printing with no name is refused (4xx)", q.status >= 400 && q.status < 500, `HTTP ${q.status}`);
  }
  if (adult && pickup) {
    const { colour, size } = firstColourAndSize(adult);
    const q = await postJson(`/api/public/shop/siu/quote`, {
      items: [{
        productId: adult.id, colourId: colour.id, size: size.size, qty: 1,
        units: [{ print: "player", name: "MEYN" }], // no number
      }],
      shippingOptionId: pickup.id,
    });
    ok("Player printing with no number is refused (4xx)", q.status >= 400 && q.status < 500, `HTTP ${q.status}`);
  }

  // ── A non-jersey product refuses a non-default print choice ─────────────
  {
    const nonJersey = products.find((p: any) => p.slug === "fan-scarf-1" || p.slug === "pennant");
    if (nonJersey && pickup) {
      const { colour, size } = firstColourAndSize(nonJersey);
      const q = await postJson(`/api/public/shop/siu/quote`, {
        items: [{
          productId: nonJersey.id, colourId: colour.id, size: size.size, qty: 1,
          units: [{ print: "player", name: "MEYN", number: "9" }],
        }],
        shippingOptionId: pickup.id,
      });
      ok(`${nonJersey.slug} (no print_options) refuses a printing choice`, q.status >= 400 && q.status < 500, `HTTP ${q.status}`);
    }
  }

  // ── A discount code applies ─────────────────────────────────────────────
  if (adult && pickup) {
    const { colour, size } = firstColourAndSize(adult);
    const q = await postJson(`/api/public/shop/siu/quote`, {
      items: [{ productId: adult.id, colourId: colour.id, size: size.size, qty: 1 }],
      shippingOptionId: pickup.id,
      discountCode: "UNITEDSTEEL",
    });
    ok("discount code UNITEDSTEEL (20% off) applies", q.status === 200 && q.body.discount?.code === "UNITEDSTEEL", `HTTP ${q.status}, discount=${JSON.stringify(q.body?.discount)}`);
    if (q.status === 200) {
      ok("UNITEDSTEEL discounts $130.00 to $104.00", q.body.discountDollars === 26 && q.body.totalDollars === 104,
        `discount=$${q.body.discountDollars} total=$${q.body.totalDollars}`);
    }
    const badCode = await postJson(`/api/public/shop/siu/quote`, {
      items: [{ productId: adult.id, colourId: colour.id, size: size.size, qty: 1 }],
      shippingOptionId: pickup.id,
      discountCode: "NOTAREALCODE",
    });
    ok("an unknown discount code is refused (4xx)", badCode.status >= 400 && badCode.status < 500, `HTTP ${badCode.status}`);
    const expiredTestCode = await postJson(`/api/public/shop/siu/quote`, {
      items: [{ productId: adult.id, colourId: colour.id, size: size.size, qty: 1 }],
      shippingOptionId: pickup.id,
      discountCode: "TEST",
    });
    ok("the 100%-off TEST code was never imported and is refused", expiredTestCode.status >= 400 && expiredTestCode.status < 500, `HTTP ${expiredTestCode.status}`);
  }

  // ── Checkout mints a real PaymentIntent ─────────────────────────────────
  if (adult && pickup) {
    const { colour, size } = firstColourAndSize(adult);
    const c = await postJson(`/api/public/shop/siu/checkout`, {
      items: [{ productId: adult.id, colourId: colour.id, size: size.size, qty: 1 }],
      shippingOptionId: pickup.id,
      customer: {
        firstName: "Verify", lastName: "Script",
        email: `siu-shop-verify-${Date.now()}@example.com`,
        phone: "0210000000",
      },
    });
    ok("checkout succeeds for an adult jersey via Pickup", c.status === 200, `HTTP ${c.status} ${JSON.stringify(c.body)}`);
    if (c.status === 200) {
      const secretLooksReal = /^pi_[a-zA-Z0-9]+$/.test(String(c.body.clientSecret || "").split("_secret_")[0]);
      ok("checkout returns a real Stripe PaymentIntent client secret", secretLooksReal, String(c.body.clientSecret || "").slice(0, 12));
      ok("checkout mints an SIU-prefixed order number", /^SIU-\d+$/.test(String(c.body.orderNumber || "")), String(c.body.orderNumber));
    }
  } else {
    ok("adult jersey + pickup available to checkout", false, "could not find product/shipping to check out");
  }

  // ── The inactive Australia/Rest-of-world options are unreachable ────────
  // The public catalog only ever returns active shipping options (confirmed
  // by reading priceCart's own `eq(shopShippingOptions.active, true)`
  // filter), so their absence here — with no unconfirmed rate ever shown to
  // a customer — IS the proof they're inactive, not something to probe by id.
  const auOption = shippingOptions.find((s: any) => /australia/i.test(s.label));
  ok("Australia Delivery (rate unconfirmed) never reaches the public shipping list",
    !auOption, "an inactive option must never be selectable at checkout");
  const rowOption = shippingOptions.find((s: any) => /rest of world/i.test(s.label));
  ok("Rest of World Delivery (rate unconfirmed) never reaches the public shipping list",
    !rowOption, "an inactive option must never be selectable at checkout");
} catch (e: any) {
  console.error("\nLive checks aborted:", e?.message || e);
  fail++;
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail > 0 ? 1 : 0);
