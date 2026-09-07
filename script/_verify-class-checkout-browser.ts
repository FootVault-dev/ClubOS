/**
 * _verify-class-checkout-browser.ts — can a parent actually reach a card field
 * on a LIVE class-book (term programme) checkout?
 *
 * Third sibling after the camp and MFL-league probes. The class-book path
 * (`/{slug}/class-book`, class-booking-page.tsx) is a single page: the form
 * POSTs /api/public/class-registrations/intent and mounts the Payment Element
 * in place, so there is no checkout URL to deep-link — this drives the REAL
 * form in real Chrome, at phone and desktop, and asserts Stripe's card input.
 * Built 2026-09-08 before pointing paid ads at the Ballers Youth League.
 *
 *   npx tsx --env-file=.env script/_verify-class-checkout-browser.ts                      # ballers-u9 on join.minifootball.co.nz
 *   CLASS_SLUG=u4-u8 CHECKOUT_BASE=https://join.cufc.co.nz npx tsx --env-file=.env script/_verify-class-checkout-browser.ts
 *
 * Creates one real pending registration (guardian + child contact + relationship)
 * per viewport, then deletes them. No card is entered, no money moves. The
 * intent endpoint fires a server-side Lead to Meta for the probe email.
 */
import puppeteer from "puppeteer-core";
import pg from "pg";
import { mkdirSync } from "fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.CHECKOUT_BASE || "https://join.minifootball.co.nz";
const API = "https://app.usg.co.nz";
const SLUG = process.env.CLASS_SLUG || "ballers-u9";
const MARK = "zzclasscheckoutprobe";
const EMAIL = `${MARK}@example.com`;
const SHOTS = "/tmp/class-checkout-verify";

let failed = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failed++; console.log(`  FAIL ${m}`); };

// 0. The programme is live and priced.
const q = await (await fetch(`${API}/api/public/program-quote/${SLUG}`)).json();
if (!q?.program) { bad(`${SLUG}: no programme`); process.exit(1); }
ok(`${SLUG}: "${q.program.name}", ${q.term?.startDate} → ${q.term?.endDate}, quote $${(q.quote?.payNowCents / 100).toFixed(2)}`);
if (!(q.quote?.payNowCents > 0)) bad("quote is $0 — term_price_cents / option price missing");

mkdirSync(SHOTS, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

for (const [label, w, h] of [["phone", 390, 844], ["desktop", 1440, 900]] as const) {
  console.log(`\n${label} ${w}×${h}`);
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/${SLUG}/class-book?source=verify&utm_source=verify&utm_medium=probe`, {
    waitUntil: "networkidle2", timeout: 60000,
  });
  const text0 = await page.evaluate(() => document.body.innerText);
  /\$\d[\d,]*\.\d{2}/.test(text0) ? ok(`form shows a price (${text0.match(/\$\d[\d,]*\.\d{2}/)?.[0]})`) : bad("no price on the form");

  // Fill the form the way a parent does. Placeholders are the page's own.
  const firsts = await page.$$('input[placeholder="First name"]');
  const lasts = await page.$$('input[placeholder="Last name"]');
  if (firsts.length < 2 || lasts.length < 2) { bad(`expected parent + child name fields, found ${firsts.length}/${lasts.length}`); await page.close(); continue; }
  await firsts[0].type("ZZCHECKOUT"); await lasts[0].type("PROBE");
  await (await page.$('input[placeholder="Email"]'))!.type(EMAIL);
  await (await page.$('input[placeholder="Mobile"]'))!.type("+64200000000");
  await firsts[1].type("ZZCHILD"); await lasts[1].type("PROBE");
  // Date of birth is optional client-side here (formValid does not require it) — left blank on purpose.

  const btn = (await page.$$('button')).filter(async () => true);
  let clicked = false;
  for (const bEl of await page.$$('button')) {
    const t = (await page.evaluate((el) => el.textContent || "", bEl)).trim();
    if (/Continue to payment/i.test(t)) { await bEl.click(); clicked = true; break; }
  }
  clicked ? ok("clicked Continue to payment") : bad("no 'Continue to payment' button");

  let frameOk = false;
  try {
    await page.waitForFunction(
      () => [...document.querySelectorAll("iframe")].some((f) => (f.src || "").includes("js.stripe.com")),
      { timeout: 30000 },
    );
    frameOk = true;
  } catch { /* handled below */ }
  if (!frameOk) {
    const err = await page.evaluate(() => document.body.innerText.slice(0, 400));
    bad(`no Stripe iframe — the Payment Element never mounted. Page says: ${err.replace(/\s+/g, " ").slice(0, 200)}`);
  } else {
    ok("Stripe iframe mounted");
    // This page renders the Payment Element as an ACCORDION (Card / Klarna
    // collapsed), so the card inputs do not exist until the parent taps
    // "Card". Do what the parent does, inside Stripe's own frame.
    let tapped = false;
    const tapDeadline = Date.now() + 15000;
    while (Date.now() < tapDeadline && !tapped) {
      for (const f of page.frames()) {
        if (!f.url().includes("js.stripe.com")) continue;
        try {
          tapped = await f.evaluate(() => {
            const el = [...document.querySelectorAll('[data-testid="card-accordion-item"], [data-testid="card-accordion-item-button"], button, [role="button"], label')]
              .find((e) => /^\s*card\s*$/i.test((e as HTMLElement).innerText || (e as HTMLElement).textContent || ""));
            if (el) { (el as HTMLElement).click(); return true; }
            return false;
          });
          if (tapped) break;
        } catch { /* frame detached */ }
      }
      if (!tapped) await new Promise((r) => setTimeout(r, 500));
    }
    tapped ? ok("tapped the Card option in the accordion") : console.log("  note no collapsed Card option found (tabs layout?) — looking for the input directly");
    const deadline = Date.now() + 40000;
    let found = false;
    while (Date.now() < deadline && !found) {
      for (const f of page.frames()) {
        if (!f.url().includes("js.stripe.com")) continue;
        try { if (await f.$('input[name="number"], input[autocomplete="cc-number"]')) { found = true; break; } } catch { /* detached */ }
      }
      if (!found) await new Promise((r) => setTimeout(r, 500));
    }
    found ? ok("card number field is present and reachable") : bad("Stripe mounted but NO card number input");
  }
  // Stripe swaps its iframes while the Payment Element settles, and puppeteer
  // throws "detached Frame" if an evaluate lands mid-swap — retry, never crash,
  // because a crash here skips the cleanup below and leaves probe rows on prod.
  let text1 = "";
  for (let i = 0; i < 5 && !text1; i++) {
    try { text1 = await page.evaluate(() => document.body.innerText); } catch { await new Promise((r) => setTimeout(r, 700)); }
  }
  const total = text1.match(/\$\d[\d,]*\.\d{2}/)?.[0] || "";
  total ? ok(`payment step shows an amount (${total})`) : bad("no amount on the payment step");
  if (errors.length) bad(`${errors.length} page error(s): ${errors[0].slice(0, 120)}`); else ok("no uncaught page errors");
  try { await page.screenshot({ path: `${SHOTS}/${label}.png`, fullPage: false }); ok(`screenshot ${SHOTS}/${label}.png`); } catch (e: any) { bad(`screenshot failed: ${e.message.slice(0, 80)}`); }
  await page.close();
}
await browser.close();

// Remove the probes: registrations → relationships → child contacts → guardian.
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  await c.query("begin");
  const g = await c.query(`select id from contacts where email=$1`, [EMAIL]);
  const gids = g.rows.map((r) => r.id);
  const rels = await c.query(`select player_id from contact_relationships where guardian_id = any($1::int[])`, [gids]);
  const kids = [...new Set(rels.rows.map((r) => r.player_id))];
  const regs = await c.query(`select id, status, stripe_payment_intent_id from registrations where guardian_id = any($1::int[]) or contact_id = any($2::int[])`, [gids, kids]);
  if (regs.rows.some((r) => r.status === "confirmed")) throw new Error("a probe registration is CONFIRMED — refusing to delete; investigate");
  await c.query(`delete from registration_items where registration_id = any($1::int[])`, [regs.rows.map((r) => r.id)]);
  await c.query(`delete from registrations where id = any($1::int[])`, [regs.rows.map((r) => r.id)]);
  await c.query(`delete from contact_relationships where guardian_id = any($1::int[]) or player_id = any($2::int[])`, [gids, kids]);
  if (kids.length) await c.query(`delete from contacts where id = any($1::int[]) and last_name='PROBE'`, [kids]);
  await c.query(`delete from contacts where id = any($1::int[])`, [gids]);
  await c.query("commit");
  ok(`\nremoved ${regs.rowCount} probe registration(s), ${kids.length} child contact(s), ${gids.length} guardian contact(s)`);
} catch (e: any) { await c.query("rollback"); bad(`cleanup failed: ${e.message} — remove ${EMAIL} rows by hand`); }
await c.end();

console.log(failed === 0 ? "\n✓ A parent can reach a card field on the live class-book checkout.\n" : `\n✗ ${failed} check(s) failed.\n`);
process.exit(failed === 0 ? 0 : 1);
