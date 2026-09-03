/**
 * _verify-checkout-browser.ts — can a parent actually reach a card field?
 *
 * The bundle check (_verify-checkout-live.ts) proves a Stripe key shipped. It
 * does not prove the Payment Element mounts. This drives the REAL production
 * checkout in a real browser, at phone and desktop, and asserts a card number
 * input exists inside Stripe's iframe — the exact thing six families could not
 * reach on 2026-09-02.
 *
 *   npx tsx --env-file=.env script/_verify-checkout-browser.ts
 *
 * Creates one real pending registration, then deletes it and its child/contact.
 */
import puppeteer from "puppeteer-core";
import pg from "pg";
import { mkdirSync } from "fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.CHECKOUT_BASE || "https://join.cufc.co.nz";
const SLUG = "worldcup";
const MARK = "zzcheckoutprobe";
const SHOTS = "/tmp/checkout-verify";

let failed = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failed++; console.log(`  FAIL ${m}`); };

// 1. Create a pending registration the way the booking form does.
const camp = await (await fetch(`https://app.usg.co.nz/api/public/camps/${SLUG}`)).json();
const dateId = camp.dates[camp.dates.length - 1].id;
const book = await fetch("https://app.usg.co.nz/api/public/book", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    campSlug: SLUG,
    parent: { firstName: "ZZCHECKOUT", lastName: "PROBE", email: `${MARK}@example.com`, phone: "+64200000000" },
    children: [{ firstName: "ZZCHECKOUT", lastName: "PROBE", dateOfBirth: "2015-03-18" }],
    items: [{ childIndex: 0, campDateId: dateId, productType: "FULL_DAY" }],
  }),
});
const reg = await book.json();
if (!reg.registrationId) { console.log("could not create a probe registration:", reg); process.exit(1); }
ok(`probe registration #${reg.registrationId} created ($${(reg.totalCents / 100).toFixed(2)})`);

mkdirSync(SHOTS, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

for (const [label, w, h] of [["phone", 390, 844], ["desktop", 1440, 900]] as const) {
  console.log(`\n${label} ${w}×${h}`);
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/${SLUG}/checkout?registrationId=${reg.registrationId}`, {
    waitUntil: "networkidle2", timeout: 60000,
  });

  // Stripe renders the Payment Element inside a cross-origin iframe.
  let frameOk = false;
  try {
    await page.waitForFunction(
      () => [...document.querySelectorAll("iframe")].some((f) => (f.src || "").includes("js.stripe.com")),
      { timeout: 30000 },
    );
    frameOk = true;
  } catch { /* handled below */ }

  if (!frameOk) bad("no Stripe iframe on the page — the Payment Element never mounted");
  else {
    ok("Stripe iframe mounted");
    // Stripe NESTS its inputs several frames deep and the inner frame's URL is
    // not the one on the <iframe> we waited for — so search EVERY frame rather
    // than guessing which one holds the field. (Matching on a frame whose url
    // contains "payment" reported a false failure against a checkout that was
    // demonstrably fine in the screenshot.)
    const deadline = Date.now() + 25000;
    let found = false;
    while (Date.now() < deadline && !found) {
      for (const f of page.frames()) {
        if (!f.url().includes("js.stripe.com")) continue;
        try {
          if (await f.$('input[name="number"], input[autocomplete="cc-number"]')) { found = true; break; }
        } catch { /* frame detached mid-search */ }
      }
      if (!found) await new Promise((r) => setTimeout(r, 500));
    }
    if (found) ok("card number field is present and reachable");
    else bad("Stripe mounted but NO card number input — a parent cannot type a card");
  }

  const total = await page.evaluate(() => document.body.innerText.match(/\$\d[\d,]*\.\d{2}/)?.[0] || "");
  total ? ok(`page shows an amount (${total})`) : bad("no amount rendered on the checkout");

  if (errors.length) bad(`${errors.length} page error(s): ${errors[0].slice(0, 120)}`);
  else ok("no uncaught page errors");

  await page.screenshot({ path: `${SHOTS}/${label}.png`, fullPage: false });
  ok(`screenshot ${SHOTS}/${label}.png`);
  await page.close();
}
await browser.close();

// 2. Remove the probe.
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  await c.query("begin");
  const kids = await c.query(`select distinct child_id from registration_items where registration_id=$1`, [reg.registrationId]);
  const ids = kids.rows.map((r) => r.child_id);
  await c.query(`delete from attendance where child_id = any($1::int[])`, [ids]);
  await c.query(`delete from registration_items where registration_id=$1`, [reg.registrationId]);
  await c.query(`delete from registrations where id=$1`, [reg.registrationId]);
  if (ids.length) await c.query(`delete from children where id = any($1::int[])`, [ids]);
  await c.query(`delete from contacts where email=$1`, [`${MARK}@example.com`]);
  await c.query("commit");
  ok(`\nprobe registration #${reg.registrationId} removed`);
} catch (e: any) { await c.query("rollback"); bad(`cleanup failed: ${e.message} — delete #${reg.registrationId} by hand`); }
await c.end();

console.log(failed === 0
  ? "\n✓ A parent can reach a card field on production.\n"
  : `\n✗ ${failed} check(s) failed.\n`);
process.exit(failed === 0 ? 0 : 1);
