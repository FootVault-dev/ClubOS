/**
 * Drives the REAL cugc.co.nz free-session form in a real browser: picks a class,
 * picks a session, fills the details including the new date of birth, submits,
 * and checks the booking landed in ClubOS with the DOB stored and the age
 * derived. Then deletes the test booking.
 *
 * This is the only proof that matters — the server accepting a hand-made
 * payload doesn't tell you the deployed form sends the right one.
 *
 *   npx tsx --env-file=.env script/_verify-cugc-free-session-browser.ts
 */
import pg from "pg";
import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";
import { join } from "path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SITE = "https://cugc.co.nz/free-session";
const TAG = `ZZBROWSER${Date.now()}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); };

async function main() {
  let browser: any = null;
  try {
    const outDir = join(process.cwd(), "..", "..", "outputs", "ui-preflight", "cugc-free-session");
    mkdirSync(outDir, { recursive: true });
    browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

    for (const [label, width, height, mobile] of [
      ["form-mobile", 390, 844, true],
      ["form-desktop", 1440, 900, false],
    ] as const) {
      const page = await browser.newPage();
      await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
      if (mobile) await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1");
      await page.goto(SITE, { waitUntil: "networkidle2", timeout: 60000 });

      // Step 1 — pick the first class, step 2 — pick the first session time.
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const card = btns.find((b) => /GymPlay/i.test(b.textContent || ""));
        (card as HTMLButtonElement | undefined)?.click();
      });
      await new Promise((r) => setTimeout(r, 800));
      // The session buttons are DATES ("Wed, 12 Aug") — the times live in the
      // group headings above them, which is what an earlier selector matched.
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const slot = btns.find((b) => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+\d{1,2}\s+\w{3}$/.test((b.textContent || "").trim()));
        (slot as HTMLButtonElement | undefined)?.click();
      });
      await new Promise((r) => setTimeout(r, 800));

      const hasDob = await page.$("#childDob");
      ok(`${label}: the date-of-birth field is on the live form`, !!hasDob);
      const hasAge = await page.$("#childAge");
      ok(`${label}: the old age field is gone`, !hasAge);
      if (hasDob) {
        const required = await page.$eval("#childDob", (el: any) => el.required && el.type === "date");
        ok(`${label}: it is a required date input`, required);
      }

      const dims = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
      ok(`${label}: no horizontal overflow`, dims.s <= dims.c + 1, `${dims.s}px in ${dims.c}px`);

      await page.screenshot({ path: join(outDir, `${label}.png`), fullPage: true });

      // Only submit once — from the mobile pass.
      if (mobile && hasDob) {
        await page.type("#childName", `${TAG} Child`);
        await page.evaluate(() => {
          const el = document.querySelector("#childDob") as HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
          setter.call(el, "2020-03-15");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await page.type("#parentName", `${TAG} Parent`);
        await page.type("#email", `${TAG.toLowerCase()}@example.com`);
        // Match on the button's LABEL, not type="submit": a <button> with no
        // explicit type defaults to submit, so the header's hamburger matched
        // first and opened the nav instead of booking anything.
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("button"));
          const submit = btns.find((b) => /book my free session/i.test(b.textContent || ""));
          (submit as HTMLButtonElement | undefined)?.click();
        });
        await new Promise((r) => setTimeout(r, 6000));
        await page.screenshot({ path: join(outDir, "form-submitted.png"), fullPage: true });
      }
      await page.close();
    }

    console.log("\nWhat reached ClubOS");
    const { rows } = await pool.query(
      `SELECT child_name, child_dob, child_age, program_name, session_label, status
         FROM cugc_free_sessions WHERE child_name LIKE $1`, [`${TAG}%`],
    );
    ok("the booking landed in ClubOS", rows.length === 1, `${rows.length} row(s)`);
    if (rows[0]) {
      ok("the date of birth was stored", rows[0].child_dob === "2020-03-15", String(rows[0].child_dob));
      const expected = new Date().getMonth() + 1 > 3 || (new Date().getMonth() + 1 === 3 && new Date().getDate() >= 15) ? 6 : 5;
      ok("the age was derived from it", rows[0].child_age === expected, `${rows[0].child_age} (expected ${expected})`);
      console.log(`    booked: ${rows[0].program_name} · ${rows[0].session_label} · ${rows[0].status}`);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await pool.query(`DELETE FROM cugc_free_sessions WHERE child_name LIKE $1`, [`${TAG}%`]).catch(() => {});
    const { rows } = await pool.query(`SELECT count(*)::int n FROM cugc_free_sessions WHERE child_name LIKE $1`, [`${TAG}%`]);
    console.log(`\ncleanup — ${rows[0].n} test bookings left behind`);
    console.log(`${pass} passed, ${fail} failed`);
    await pool.end();
    process.exit(fail === 0 ? 0 : 1);
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
