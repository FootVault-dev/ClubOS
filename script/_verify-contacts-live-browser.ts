/**
 * Loads the REAL app.usg.co.nz Contacts tab in a real browser, signed in as an
 * account with Olga's exact membership shape, and checks that people render.
 *
 * This is the only proof that matters. The API works with the header — that was
 * never in doubt. The question is whether the DEPLOYED BUNDLE sends it, and a
 * hand-made request can't answer that.
 *
 *   npx tsx --env-file=.env script/_verify-contacts-live-browser.ts
 */
import pg from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";
import { join } from "path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "https://app.usg.co.nz";
const EMAIL = "contacts-browser-probe@example.com"; // RFC 2606, undeliverable
const PASSWORD = crypto.randomBytes(24).toString("base64url");
const WORKSPACE = "christchurch-united";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); };

let userId: number | null = null;
let browser: any = null;

try {
  // ── A throwaway account shaped exactly like Olga's ─────────────────────────
  const hash = await bcrypt.hash(PASSWORD, 10);
  const ins = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Contacts','Browser Probe',$2,'admin',true) RETURNING id`,
    [EMAIL, hash],
  );
  userId = ins.rows[0].id;
  const org = await pool.query(`SELECT id FROM organizations WHERE slug = $1`, [WORKSPACE]);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs)
     VALUES ($1, $2, 'admin', NULL)`,
    [userId, org.rows[0].id],
  );
  console.log(`\nthrowaway user #${userId} — NOT a super admin, ${WORKSPACE} admin, tabs NULL\n`);

  const outDir = join(process.cwd(), "..", "..", "outputs", "ui-preflight", "clubos-contacts");
  mkdirSync(outDir, { recursive: true });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

  for (const [label, width, height, mobile] of [
    ["contacts-desktop", 1440, 900, false],
    ["contacts-mobile", 390, 844, true],
  ] as const) {
    const page = await browser.newPage();
    await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
    if (mobile) await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1");

    // Watch what the page actually asks the server, and what it gets back.
    let peopleStatus = 0;
    let sentHeader: string | null = null;
    page.on("request", (r: any) => {
      if (r.url().includes("/api/admin/people")) {
        const h = r.headers();
        sentHeader = h["x-workspace-slug"] ?? null;
      }
    });
    page.on("response", (r: any) => {
      if (r.url().includes("/api/admin/people")) peopleStatus = r.status();
    });

    // Sign in over the API and hand the browser the session cookie. The login
    // form is a SPA submit with no navigation, so driving it races the harness;
    // the cookie is the same session either way, and what's under test here is
    // what the CONTACTS bundle sends, not the login screen.
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
    const raw = login.headers.get("set-cookie") || "";
    const [name, value] = raw.split(";")[0].split("=");
    await page.setCookie({ name, value, domain: "app.usg.co.nz", path: "/", httpOnly: true, secure: true });

    // Land on the CUFC workspace, then open Contacts the way she would.
    await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.evaluate((slug: string) => localStorage.setItem("clubos_workspace", slug), WORKSPACE);
    await page.goto(`${BASE}/admin/contacts`, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 3500));

    const seen = await page.evaluate(() => {
      const text = document.body.innerText || "";
      const m = text.match(/([\d,]+)\s+people/);
      return {
        peopleCount: m ? m[1] : null,
        hasRows: /PARENT|PLAYER/.test(text),
        bodyStart: text.slice(0, 300),
      };
    });

    await page.screenshot({ path: join(outDir, `${label}.png`), fullPage: false });

    console.log(`\n  ${label} (${width}×${height})`);
    ok("the page sent X-Workspace-Slug", sentHeader === WORKSPACE, String(sentHeader));
    // 304 is a pass: the second viewport reuses the first one's cached response.
    ok("/api/admin/people was served", peopleStatus === 200 || peopleStatus === 304, `HTTP ${peopleStatus}`);
    ok("a people count is on screen", !!seen.peopleCount, seen.peopleCount ? `${seen.peopleCount} people` : "none");
    ok("real contact rows rendered", seen.hasRows, seen.hasRows ? "" : seen.bodyStart.replace(/\n/g, " | "));
    await page.close();
  }
  console.log(`\nscreenshots → outputs/ui-preflight/clubos-contacts/`);
} finally {
  if (browser) await browser.close();
  if (userId) {
    await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    console.log(`cleaned up throwaway user #${userId}`);
  }
  await pool.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
