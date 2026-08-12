/**
 * Opens a real player profile and a real parent profile on app.usg.co.nz as a
 * normal (non-super-admin) staff account, and checks the programme & payment
 * history actually renders — the numbers, the tabs, and the shared-booking note.
 *
 *   npx tsx --env-file=.env script/_verify-history-live-browser.ts
 */
import pg from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";
import { join } from "path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "https://app.usg.co.nz";
const EMAIL = "history-browser-probe@example.com"; // RFC 2606, undeliverable
const PASSWORD = crypto.randomBytes(24).toString("base64url");
const WORKSPACE = "christchurch-united";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); };

let userId: number | null = null;
let browser: any = null;

try {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const ins = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'History','Browser Probe',$2,'admin',true) RETURNING id`, [EMAIL, hash]);
  userId = ins.rows[0].id;
  const org = await pool.query(`SELECT id FROM organizations WHERE slug=$1`, [WORKSPACE]);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs)
     VALUES ($1,$2,'admin',NULL)`, [userId, org.rows[0].id]);
  console.log(`\nthrowaway user #${userId} — NOT a super admin\n`);

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed HTTP ${login.status}`);
  const [name, value] = (login.headers.get("set-cookie") || "").split(";")[0].split("=");

  const outDir = join(process.cwd(), "..", "..", "outputs", "ui-preflight", "clubos-contacts");
  mkdirSync(outDir, { recursive: true });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

  const cases = [
    { label: "player-kai-yun", key: "contact-32753", who: "player", expectMoney: "$160.00" },
    { label: "parent-lina-kim", key: "contact-32752", who: "parent", expectMoney: "$320.00" },
  ];

  for (const c of cases) {
    for (const [vp, width, height, mobile] of [
      ["desktop", 1440, 900, false], ["mobile", 390, 844, true],
    ] as const) {
      const page = await browser.newPage();
      await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
      if (mobile) await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1");
      await page.setCookie({ name, value, domain: "app.usg.co.nz", path: "/", httpOnly: true, secure: true });
      await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.evaluate((s: string) => localStorage.setItem("clubos_workspace", s), WORKSPACE);
      await page.goto(`${BASE}/admin/people/${c.key}`, { waitUntil: "networkidle2", timeout: 60000 });
      await new Promise(r => setTimeout(r, 2500));

      const seen = await page.evaluate(() => {
        const t = document.body.innerText || "";
        return {
          text: t,
          hasHistory: /programme & payment history/i.test(t),
          hasProgrammesTab: /Programmes \(\d+\)/.test(t),
          hasPaymentsTab: /Payments \(\d+\)/.test(t),
          noProgrammes: /No programmes\b/.test(t),
          overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
        };
      });

      if (vp === "desktop") {
        console.log(`\n  ${c.who} — ${c.key}`);
        ok("history section renders", seen.hasHistory);
        ok("programmes tab has entries", seen.hasProgrammesTab);
        ok("payments tab has entries", seen.hasPaymentsTab);
        ok(`shows the real total ${c.expectMoney}`, seen.text.includes(c.expectMoney));
        if (c.who === "parent") ok("child cards no longer say 'No programmes'", !seen.noProgrammes);
      } else {
        ok(`mobile: no horizontal overflow`, !seen.overflow);
        ok(`mobile: history still renders`, seen.hasHistory);
      }

      await page.screenshot({ path: join(outDir, `history-${c.label}-${vp}.png`), fullPage: false });
      await page.close();
    }
  }
  console.log(`\nscreenshots → outputs/ui-preflight/clubos-contacts/`);
} finally {
  if (browser) await browser.close();
  if (userId) {
    await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id=$1`, [userId]);
    console.log(`cleaned up throwaway user #${userId}`);
  }
  await pool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
