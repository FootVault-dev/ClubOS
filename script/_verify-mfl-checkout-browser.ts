/**
 * _verify-mfl-checkout-browser.ts — can a captain actually reach a card field
 * on the LIVE Mini Football Leagues checkout?
 *
 * Sibling of _verify-checkout-browser.ts (which drives a camp). MFL has its own
 * checkout page (mfl-checkout-page.tsx, route /league/:slug/checkout) served on
 * join.minifootball.co.nz, so the camp probe proves nothing about it. Built
 * 2026-09-08 before pointing paid ads at Term 4.
 *
 *   npx tsx --env-file=.env script/_verify-mfl-checkout-browser.ts            # term-4
 *   MFL_SLUG=term-5 npx tsx --env-file=.env script/_verify-mfl-checkout-browser.ts
 *
 * Creates ONE real pending league registration through the public register
 * endpoint (the same call the form makes), opens its checkout in a real Chrome
 * at phone + desktop, asserts Stripe's card-number input exists, then deletes
 * the registration and its probe contact. No card is entered, no money moves.
 * Side effect: the register endpoint fires one server-side Lead event to Meta
 * for the probe email — the same noise the camp probe makes.
 */
import puppeteer from "puppeteer-core";
import pg from "pg";
import { mkdirSync } from "fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.CHECKOUT_BASE || "https://join.minifootball.co.nz";
const API = "https://app.usg.co.nz";
const SLUG = process.env.MFL_SLUG || "term-4";
const MARK = "zzmflcheckoutprobe";
const SHOTS = "/tmp/mfl-checkout-verify";

let failed = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failed++; console.log(`  FAIL ${m}`); };

// 0. The term is open and lists nights with spots.
const cfg = await (await fetch(`${API}/api/public/league/register/${SLUG}`)).json();
if (!cfg?.program?.isActive) { bad(`${SLUG} is not an active league program`); process.exit(1); }
ok(`${SLUG} is live: "${cfg.program.name}", ${cfg.competition.startDate} → ${cfg.competition.endDate}`);
const nights = (cfg.divisions as any[]).filter((d) => d.spotsLeft > 0);
nights.length ? ok(`${nights.length} nights with spots (${nights.map((d: any) => `${d.name} $${d.teamCostCents / 100}`).join(" · ")})`) : bad("no night has a spot");
const night = nights.sort((a, b) => b.spotsLeft - a.spotsLeft)[0];

// 1. Register a probe team the way the form does.
const reg = await (await fetch(`${API}/api/public/league/register`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    slug: SLUG,
    teams: [{ teamName: "ZZ Checkout Probe FC", divisionId: night.id, upsells: [] }],
    captain: { firstName: "ZZCHECKOUT", lastName: "PROBE", email: `${MARK}@example.com`, phone: "+64200000000" },
    utmSource: "verify", utmMedium: "probe", utmCampaign: "checkout-verify",
  }),
})).json();
if (!reg.registrationId) { console.log("could not create a probe registration:", reg); process.exit(1); }
ok(`probe registration #${reg.registrationId} on ${night.name} ($${((reg.totalCents ?? 0) / 100).toFixed(2)} total, $${((reg.depositDueCents ?? reg.amountDueCents ?? 0) / 100).toFixed(2)} due now)`);

mkdirSync(SHOTS, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

for (const [label, w, h] of [["phone", 390, 844], ["desktop", 1440, 900]] as const) {
  console.log(`\n${label} ${w}×${h}`);
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/league/${SLUG}/checkout?registrationId=${reg.registrationId}`, {
    waitUntil: "networkidle2", timeout: 60000,
  });

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
    else bad("Stripe mounted but NO card number input — a captain cannot type a card");
  }

  const text = await page.evaluate(() => document.body.innerText);
  const total = text.match(/\$\d[\d,]*\.\d{2}/)?.[0] || "";
  total ? ok(`page shows an amount (${total})`) : bad("no amount rendered on the checkout");
  /early bird/i.test(text) ? ok("early bird line is on the checkout") : console.log("  note early bird not named on the checkout page");
  const blank = (await page.evaluate(() => document.body.innerText.trim().length)) < 40;
  blank ? bad("checkout body is blank (white screen)") : ok("checkout body rendered");

  if (errors.length) bad(`${errors.length} page error(s): ${errors[0].slice(0, 120)}`);
  else ok("no uncaught page errors");

  await page.screenshot({ path: `${SHOTS}/${label}.png`, fullPage: false });
  ok(`screenshot ${SHOTS}/${label}.png`);
  await page.close();
}
await browser.close();

// 2. Remove the probe. A pending league registration materialises NO league_team
//    until it is paid, so only the registration row and the probe contact exist.
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  await c.query("begin");
  const teams = await c.query(`select id from league_teams where registration_id=$1`, [reg.registrationId]);
  if (teams.rowCount) bad(`probe registration materialised ${teams.rowCount} league_team row(s) without payment — investigate before deleting`);
  await c.query(`delete from registration_items where registration_id=$1`, [reg.registrationId]);
  await c.query(`delete from registrations where id=$1`, [reg.registrationId]);
  const contacts = await c.query(`delete from contacts where email=$1 returning id`, [`${MARK}@example.com`]);
  await c.query("commit");
  ok(`\nprobe registration #${reg.registrationId} removed (${contacts.rowCount} probe contact row(s) removed)`);
} catch (e: any) { await c.query("rollback"); bad(`cleanup failed: ${e.message} — delete registration #${reg.registrationId} and contact ${MARK}@example.com by hand`); }
await c.end();

console.log(failed === 0
  ? "\n✓ A captain can reach a card field on the live MFL checkout.\n"
  : `\n✗ ${failed} check(s) failed.\n`);
process.exit(failed === 0 ? 0 : 1);
