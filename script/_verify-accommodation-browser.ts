/**
 * UI preflight for the Accommodation tab, against the LIVE site.
 *
 * "The numbers are right in the API" is a different claim from "the page
 * works". This logs in as a throwaway super admin, walks all seven views at
 * phone and desktop size, asserts what has to be on screen, and screenshots
 * each one so the layout can actually be looked at.
 *
 *   npx tsx --env-file=.env script/_verify-accommodation-browser.ts
 */
import pg from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";
import { join } from "path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "https://app.usg.co.nz";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); };

const made: number[] = [];
let browser: any = null;

const VIEWS = [
  { tab: "overview",  must: ["Accommodation", "Rooms let", "Still to sort out"] },
  { tab: "houses",    must: ["Main House", "Second House", "Tiny House", "Shed Residency", "Sick Room 1"] },
  // The Occupancy view opens on Active, and all four unconfirmed-room stays
  // have ended — so that assertion belongs after switching to "All", below.
  { tab: "tenants",   must: ["Rovu Boyers", "Club remuneration"] },
  { tab: "invoicing", must: ["Jan–May 2026", "May–Sep 2026", "Works out at", "$7,668.57"] },
  { tab: "roster",    must: ["Lewis Partridge", "Off site", "Not confirmed"] },
  { tab: "actions",   must: ["Confirm full legal names", "Where the source documents disagree"] },
  { tab: "utilities", must: [] },
];

try {
  const email = `accomprobe-${crypto.randomBytes(5).toString("hex")}@example.com`;
  const password = crypto.randomBytes(16).toString("base64url");
  const r = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Accom','Probe',$2,'super_admin',true) RETURNING id`,
    [email, await bcrypt.hash(password, 10)]);
  const id = r.rows[0].id; made.push(id);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs) VALUES ($1,7,'admin',NULL)`, [id]);

  const lr = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }) });
  ok("logged in to production", lr.ok);
  const cookie = (lr.headers.get("set-cookie") || "").split(";")[0];
  const [cname, cvalue] = cookie.split("=");

  const outDir = join(process.cwd(), "..", "..", "outputs", "ui-preflight", "clubos-accommodation");
  mkdirSync(outDir, { recursive: true });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

  for (const [label, w, h] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
    await page.setCookie({ name: cname, value: cvalue, domain: "app.usg.co.nz", path: "/", httpOnly: true, secure: true });
    await page.goto(`${BASE}/admin`, { waitUntil: "networkidle2", timeout: 60000 });
    await page.evaluate(() => localStorage.setItem("clubos_workspace", "united-sports-group"));
    await page.goto(`${BASE}/admin/accommodation`, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((res) => setTimeout(res, 3500));

    // The route must resolve. A tab registered in tabs.ts but missing from the
    // workspace's own route Switch renders NotFound — it has happened twice.
    const first = await page.evaluate(() => document.body.innerText);
    ok(`${label}: /admin/accommodation resolves (not a 404 page)`, !/Page Not Found|404/i.test(first));

    for (const v of VIEWS) {
      // 🔴 A synthetic el.click() does NOT switch a Radix tab — it activates on
      // real pointer events, so the element "clicks", nothing changes, and every
      // later assertion is silently made against the previous view. The first
      // run of this script passed 43 checks that way while only ever looking at
      // the Overview screen. page.click() dispatches genuine mouse events.
      let clicked = false;
      try {
        await page.click(`[data-testid="tab-${v.tab}"]`);
        clicked = true;
      } catch { clicked = false; }
      ok(`${label}: the ${v.tab} tab is reachable`, clicked);
      if (!clicked) continue;
      await new Promise((res) => setTimeout(res, 2500));

      // And prove the switch actually happened, rather than trusting the click.
      const active = await page.evaluate((t: string) =>
        document.querySelector(`[data-testid="tab-${t}"]`)?.getAttribute("data-state"), v.tab);
      ok(`${label}: the ${v.tab} tab is actually selected`, active === "active", `data-state=${active}`);

      const seen = await page.evaluate(() => ({
        text: document.body.innerText,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      const hay = seen.text.toLowerCase();
      for (const m of v.must) {
        // Case-insensitive: innerText reflects CSS text-transform, so a label
        // styled uppercase comes back as "ROOMS LET".
        ok(`${label}/${v.tab}: shows "${m}"`, hay.includes(m.toLowerCase()));
      }
      // 🔴 A page that scrolls sideways on a phone is broken, however good the
      // numbers on it are. The tables inside scroll in their own container.
      ok(`${label}/${v.tab}: no horizontal overflow`, seen.overflow <= 1, `${seen.overflow}px`);

      await page.screenshot({ path: join(outDir, `${v.tab}-${label}.png`), fullPage: true });
    }

    // The unplaced stays live behind the "All" filter, because every one of
    // them ended months ago. They must be visible SOMEWHERE, clearly flagged.
    await page.click('[data-testid="tab-tenants"]');
    await new Promise((res) => setTimeout(res, 1500));
    await page.click('[data-testid="filter-all"]').catch(() => {});
    await new Promise((res) => setTimeout(res, 2000));
    const all = await page.evaluate(() => ({
      text: document.body.innerText,
      flags: document.querySelectorAll('[data-testid^="room-unconfirmed-"]').length,
    }));
    ok(`${label}: all 25 stays list, with the 4 unplaced ones flagged`, all.flags === 4, `${all.flags} flagged`);
    ok(`${label}: an unplaced stay says so instead of naming a room`, /room unconfirmed/i.test(all.text));
    await page.screenshot({ path: join(outDir, `tenants-all-${label}.png`), fullPage: true });

    // A door code must not be sitting in the open on a shared screen.
    await page.click('[data-testid="tab-houses"]');
    await new Promise((res) => setTimeout(res, 2500));
    const keys = await page.evaluate(() => document.body.innerText);
    ok(`${label}: key codes are masked until asked for`,
      !keys.includes("MH-KEY-01") && keys.includes("••••••••"));

    await page.close();
  }
  console.log(`\n  screenshots → outputs/ui-preflight/clubos-accommodation/`);
} finally {
  if (browser) await browser.close();
  for (const id of made) {
    await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`, [id]);
    await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
  }
  console.log(`  cleaned up ${made.length} probe account(s)`);
  await pool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
