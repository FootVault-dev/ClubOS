/**
 * Screenshots the CUGC Mailer's tracking detail — the "who opened it" view.
 *
 * It only renders when a send exists, so this seeds a campaign with a handful
 * of fake recipients (some opened, one failed), drives a real browser to click
 * it open, screenshots, then deletes everything it made.
 *
 *   npx tsx --env-file=.env script/_preflight-cugc-mailer-detail.ts
 */
import pg from "pg";
import bcrypt from "bcryptjs";
import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";
import { join } from "path";

const BASE = process.env.VERIFY_BASE || "https://app.usg.co.nz";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  let userId: number | null = null;
  let campaignId: number | null = null;
  let browser: any = null;
  try {
    // ── seed a finished send ─────────────────────────────────────────────────
    const { rows: cRows } = await pool.query(
      `INSERT INTO email_campaigns
         (subject, body, from_email, reply_to, segment_type, segment_config,
          recipient_count, sent_count, failed_count, status, sent_at)
       VALUES ($1,$2,$3,$4,'cugc_all','{}',5,4,1,'sent', now()) RETURNING id`,
      [
        "Term 4 enrolments are open",
        "<p>Hi everyone,</p><p>Term 4 enrolments are now open for GymPlay and GymBasics. Spaces in the Wednesday classes go quickly, so get in early.</p><p>Any questions, just reply to this email.</p>",
        "Christchurch United Gymnastics Club <noreply@cugc.co.nz>",
        "info@cugc.co.nz",
      ],
    );
    campaignId = cRows[0].id;
    const people: [string, string, boolean][] = [
      ["sarah.wilson@example.com", "sent", true],
      ["james.patel@example.com", "sent", true],
      ["mia.thompson@example.com", "sent", false],
      ["olivia.chen@example.com", "sent", false],
      ["bounced.address@example.com", "failed", false],
    ];
    for (const [email, status, opened] of people) {
      await pool.query(
        `INSERT INTO email_campaign_recipients
           (campaign_id, email, status, first_opened_at, last_opened_at, open_count)
         VALUES ($1,$2,$3,$4,$4,$5)`,
        [campaignId, email, status, opened ? new Date() : null, opened ? 2 : 0],
      );
    }

    // ── a throwaway Gymnastics admin ─────────────────────────────────────────
    const email = `_cugcdetail_${Date.now()}@usg.co.nz`;
    const password = `T${Math.random().toString(36).slice(2)}!aA9`;
    const { rows } = await pool.query(
      `INSERT INTO users (email, first_name, last_name, password, role, active)
       VALUES ($1,'Preflight','Test',$2,'team_member',true) RETURNING id`,
      [email, await bcrypt.hash(password, 10)],
    );
    userId = rows[0].id;
    await pool.query(`INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1,6,'admin')`, [userId]);

    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
    const cookies = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);

    // ── drive the browser ────────────────────────────────────────────────────
    const outDir = join(process.cwd(), "..", "..", "outputs", "ui-preflight", "cugc-mailer");
    mkdirSync(outDir, { recursive: true });
    browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

    for (const [label, width, height, mobile] of [
      ["detail-desktop", 1440, 900, false],
      ["detail-mobile", 390, 844, true],
    ] as const) {
      const page = await browser.newPage();
      await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
      if (mobile) {
        await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1");
      }
      const { hostname } = new URL(BASE);
      await page.setCookie(...cookies.map((c) => {
        const i = c.indexOf("=");
        return { name: c.slice(0, i), value: c.slice(i + 1), domain: hostname, path: "/", secure: true };
      }));
      await page.goto(`${BASE}/admin/cugc-mailer`, { waitUntil: "networkidle2", timeout: 60000 });
      const sel = `[data-testid="cugc-mailer-campaign-${campaignId}"]`;
      await page.waitForSelector(sel, { timeout: 30000 });
      await page.click(sel);
      await page.waitForSelector('[data-testid="cugc-campaign-close"]', { timeout: 15000 });
      await new Promise((r) => setTimeout(r, 900)); // let it settle

      // Report the real document width — a screenshot of an overflowing page
      // can look perfectly normal.
      const dims = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      console.log(`${label}: document ${dims.scrollW}px wide in a ${dims.clientW}px viewport ${dims.scrollW > dims.clientW + 1 ? "← OVERFLOWS" : "✓"}`);

      await page.screenshot({ path: join(outDir, `${label}.png`) });
      await page.close();
    }
    console.log(`\nwrote ${outDir}/detail-{desktop,mobile}.png`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (campaignId) await pool.query(`DELETE FROM email_campaigns WHERE id = $1`, [campaignId]).catch(() => {});
    if (userId) {
      await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [userId]).catch(() => {});
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => {});
    }
    console.log("seed + throwaway user removed");
    await pool.end();
  }
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
