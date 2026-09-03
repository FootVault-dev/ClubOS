/**
 * _verify-qr-browser.ts — does the QR Code Generator actually LOOK right?
 *
 * The page was written in the dark-admin era (text-white/90, premium-card) and
 * the admin is light-only since 2026-09-02, so the generated light-theme CSS is
 * doing the work. A CSS mapping is exactly the kind of thing that reads fine in
 * source and ships black text on a black panel — the "View ClubOS as…" bug. So
 * this signs in as an ORDINARY staff member (not a super admin, who sees a
 * different sidebar) and photographs the real page at phone and desktop.
 *
 *   npx tsx --env-file=.env script/_verify-qr-browser.ts
 */
import puppeteer from "puppeteer-core";
import pg from "pg";
import bcrypt from "bcryptjs";
import { mkdirSync } from "fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "https://app.usg.co.nz";
const OUT = "/tmp/qr-verify";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let failed = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failed++; console.log(`  FAIL ${m}`); };

const users: number[] = [];
let browser: any = null;
try {
  mkdirSync(OUT, { recursive: true });
  const email = `_qrpreflight_${Date.now()}@usg.co.nz`;
  const password = `T${Math.random().toString(36).slice(2)}!aA9`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Preflight','QR',$2,'team_member',true) RETURNING id`,
    [email, await bcrypt.hash(password, 10)]);
  const userId = rows[0].id; users.push(userId);
  // CUFC + MFL + the Centre + United Prints. The last two matter: they own the
  // historic links (field-hire is org 4, Dima's instant-quote codes are org 8),
  // and a user who is NOT in them correctly cannot see them — so a probe with
  // only CUFC and MFL would "fail" against a scoping rule that is working.
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs)
     VALUES ($1,1,'admin',NULL),($1,3,'admin',NULL),($1,4,'admin',NULL),($1,8,'admin',NULL)`,
    [userId]);

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }) });
  if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
  const [cname, cvalue] = (login.headers.get("set-cookie") || "").split(";")[0].split("=");

  browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  for (const [label, w, h, mobile] of [["desktop", 1440, 900, false], ["mobile", 390, 844, true]] as const) {
    console.log(`\n${label} ${w}×${h}`);
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
    await page.setCookie({ name: cname, value: cvalue, domain: "app.usg.co.nz", path: "/", httpOnly: true, secure: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(`${BASE}/admin/qr-codes`, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2500));

    const title = await page.$eval('[data-testid="text-page-title"]', (el) => el.textContent?.trim()).catch(() => null);
    title === "QR Code Generator" ? ok(`title reads "${title}"`) : bad(`title is ${JSON.stringify(title)}`);

    // The two pickers must exist and the business one must be populated.
    for (const t of ["select-qr-business", "select-qr-programme"]) {
      (await page.$(`[data-testid="${t}"]`)) ? ok(`${t} rendered`) : bad(`${t} MISSING`);
    }

    // Existing links must be listed — this is "keep all the previous links".
    const body = await page.evaluate(() => document.body.innerText);
    for (const k of ["field-hire", "instant-quote"]) {
      body.includes(k) ? ok(`an existing link is listed (${k})`) : bad(`existing link ${k} NOT listed`);
    }

    // Contrast: nothing may render as near-white ink on a near-white ground.
    const invisible = await page.evaluate(() => {
      // No helper functions in here: tsx/esbuild `keepNames` wraps named and
      // const-bound functions in __name(), which is not defined in the page and
      // throws "__name is not defined" the moment the callback runs.
      let n = 0;
      const els = Array.from(document.querySelectorAll("h1,h2,h3,p,label,span,button,a,td,th"));
      for (const el of els) {
        const txt = (el as HTMLElement).innerText;
        if (!txt || txt.trim().length < 2) continue;
        const s1 = getComputedStyle(el as HTMLElement);
        const fm = s1.color.match(/\d+/g);
        if (!fm) continue;
        const fg = (0.2126 * Number(fm[0]) + 0.7152 * Number(fm[1]) + 0.0722 * Number(fm[2])) / 255;
        let node: HTMLElement | null = el as HTMLElement;
        let bg: number | null = null;
        while (node && bg === null) {
          const c = getComputedStyle(node).backgroundColor;
          if (c && c.indexOf("rgba(0, 0, 0, 0)") === -1) {
            const bm = c.match(/\d+/g);
            if (bm) bg = (0.2126 * Number(bm[0]) + 0.7152 * Number(bm[1]) + 0.0722 * Number(bm[2])) / 255;
          }
          node = node.parentElement;
        }
        if (bg === null) bg = 1;
        if (Math.abs(fg - bg) < 0.12) n++;
      }
      return n;
    });

    invisible === 0 ? ok("no text sits invisibly on its own background")
                    : bad(`${invisible} element(s) render at <0.12 contrast — likely white ink on a light ground`);

    if (mobile) {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      overflow <= 1 ? ok("no horizontal overflow at 390px") : bad(`page scrolls ${overflow}px sideways at 390px`);
    }
    errors.length ? bad(`${errors.length} page error(s): ${errors[0].slice(0, 140)}`) : ok("no uncaught page errors");

    await page.screenshot({ path: `${OUT}/${label}.png`, fullPage: false });
    ok(`screenshot ${OUT}/${label}.png`);
    await page.close();
  }
} catch (e: any) { bad(`threw: ${e.message}`); }
finally {
  if (browser) await browser.close();
  for (const id of users) {
    await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`, [id]);
    await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
  }
  console.log(`\n  cleaned up ${users.length} preflight account(s)`);
  await pool.end();
}
console.log(failed === 0 ? "\n✓ QR Code Generator renders correctly for ordinary staff.\n" : `\n✗ ${failed} check(s) failed.\n`);
process.exit(failed === 0 ? 0 : 1);
