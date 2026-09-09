// UI preflight for the Payouts page's "Still to come" panel — the real live
// page, both widths, as an ordinary staff member with the payouts tab.
import pg from "pg";
import bcrypt from "bcryptjs";
import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";
import { join } from "path";

const BASE = process.env.VERIFY_BASE || "https://app.usg.co.nz";
const WORKSPACE = "united-sports-group";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = join(process.cwd(), "outputs", "payouts-preflight");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;
const ok = (l: string, good: boolean, d = "") => {
  console.log(`  ${good ? "ok  " : "FAIL"} ${l}${d ? ` — ${d}` : ""}`);
  good ? pass++ : fail++;
};
const users: number[] = [];
let browser: any = null;

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`\nPayouts — browser preflight against ${BASE}\n`);

  const email = `_payoutui_${Date.now()}@usg.co.nz`;
  const password = `T${Math.random().toString(36).slice(2)}!aA9`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Preflight','PayoutUI',$2,'team_member',true) RETURNING id`,
    [email, await bcrypt.hash(password, 10)],
  );
  users.push(rows[0].id);
  const { rows: o } = await pool.query(`SELECT id FROM organizations WHERE slug=$1`, [WORKSPACE]);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs)
     VALUES ($1,$2,'team_member',$3::jsonb)`,
    [rows[0].id, o[0].id, JSON.stringify(["payouts"])],
  );

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login failed HTTP ${login.status}`);
  const [cn, cv] = (login.headers.get("set-cookie") || "").split(";")[0].split("=");

  browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

  for (const [label, width, height, mobile] of [
    ["payouts-desktop", 1440, 900, false],
    ["payouts-mobile", 390, 844, true],
  ] as const) {
    console.log(`\n${label} (${width}×${height})`);
    const page = await browser.newPage();
    await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
    if (mobile) await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1");
    await page.setCookie({ name: cn, value: cv, domain: "app.usg.co.nz", path: "/", httpOnly: true, secure: true });

    await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.evaluate((s: string) => localStorage.setItem("clubos_workspace", s), WORKSPACE);
    await page.goto(`${BASE}/admin/payouts`, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 3500));

    const m: any = await page.evaluate(`(function(){
      var de = document.documentElement;
      var panel = document.querySelector('[data-testid="panel-upcoming"]');
      var inflight = document.querySelector('[data-testid="text-inflight-total"]');
      var bal = document.querySelector('[data-testid="text-balance-pending"]');
      var body = document.body.innerText;
      return {
        docWidth: de.scrollWidth, winWidth: window.innerWidth,
        hasPanel: !!panel,
        inflight: inflight ? inflight.innerText.trim() : null,
        balance: bal ? bal.innerText.trim() : null,
        aboveTable: !!panel && !!document.querySelector('table') &&
          panel.getBoundingClientRect().top < document.querySelector('table').getBoundingClientRect().top,
        saysSchedule: /pays out every day/i.test(body),
        saysNoDate: /no arrival date/i.test(body),
        loginScreen: /Sign in|Forgot password/i.test(body)
      };
    })()`);

    ok("the page is Payouts, not the login screen", !m.loginScreen);
    ok("the Still to come panel renders", m.hasPanel);
    ok("it sits ABOVE the payout history", m.aboveTable);
    ok("the in-flight figure is shown", Boolean(m.inflight), m.inflight ?? "");
    ok("the held balance is shown", Boolean(m.balance), (m.balance ?? "").split("\n")[0]);
    ok("the balance is stated to have NO arrival date", m.saysNoDate);
    ok("the payout schedule is stated in plain English", m.saysSchedule);
    ok("no horizontal overflow", m.docWidth <= m.winWidth + 1, `${m.docWidth} vs ${m.winWidth}`);

    const shot = join(OUT, `${label}.png`);
    await page.screenshot({ path: shot });
    console.log(`  → ${shot}`);
    await page.close();
  }
}

main()
  .catch((e) => { console.error("\nthrew:", e.message); fail++; })
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
    for (const id of users) {
      await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`, [id]).catch(() => {});
      await pool.query(`DELETE FROM users WHERE id=$1`, [id]).catch(() => {});
    }
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
