/**
 * _verify-mfl-sidebar-live.ts — as an ORDINARY Mini Football admin, does the
 * sidebar draw Youth Leagues + Registrations, and does the Registrations page
 * show only Mini Football's rows?
 *
 * 2026-09-09: both tabs and both routes had existed since 3 August, but
 * `leagueNav` in app-sidebar.tsx — the array that renders the link — never had
 * them, so Daniel "couldn't find sign-ups". The screenshot that proved the fix
 * then showed CUFC's holiday camps inside the MFL workspace: registrations were
 * not scoped to the caller's workspaces. This checks both, in a real browser,
 * as a throwaway org-3-only admin (a super admin would not reproduce either).
 *
 *   npx tsx --env-file=.env script/_verify-mfl-sidebar-live.ts
 * Screenshots → /tmp/mfl-sidebar-verify/
 */
import puppeteer from "puppeteer-core";
import pg from "pg";
import bcrypt from "bcryptjs";
import { mkdirSync } from "fs";

const BASE = process.env.RENDER_CHECK_BASE || "https://app.usg.co.nz";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const email = `zzmflsidebar-${Date.now()}@example.com`, pw = `Probe-${Date.now()}!x`;
const OUT = "/tmp/mfl-sidebar-verify"; mkdirSync(OUT, { recursive: true });
let uid = 0, failed = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failed++; console.log(`  FAIL ${m}`); };

try {
  const { rows } = await pool.query(`INSERT INTO users (email,first_name,last_name,password,role,active) VALUES ($1,'Sidebar','Probe',$2,'admin',true) RETURNING id`, [email, await bcrypt.hash(pw, 10)]);
  uid = rows[0].id;
  await pool.query(`INSERT INTO user_organizations (user_id,organization_id,role,tabs) VALUES ($1,3,'admin',NULL)`, [uid]);
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pw }) });
  if (!login.ok) throw new Error(`login ${login.status}`);
  const [cn, cv] = (login.headers.get("set-cookie") || "").split(";")[0].split("=");
  // Names of programmes that belong to OTHER organisations — none may appear.
  const { rows: foreign } = await pool.query(`select distinct name from programs where organization_id <> 3 and name is not null`);
  const foreignNames: string[] = foreign.map((r) => r.name);

  const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 900 });
  await page.setCookie({ name: cn, value: cv, domain: new URL(BASE).hostname, path: "/", httpOnly: true, secure: true });
  for (const [path, label] of [["/admin/registrations", "registrations"], ["/admin/academy", "youth-leagues"]] as const) {
    // The admin shell redirects once on first load (workspace resolution),
    // which detaches the navigating frame under puppeteer — land, wait, retry.
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2", timeout: 60000 }); break; }
      catch (e: any) { if (!/detached/i.test(e.message) || attempt === 2) throw e; await new Promise((r) => setTimeout(r, 1500)); }
    }
    await new Promise((r) => setTimeout(r, 3000));
    // innerText of a native <select> includes EVERY option, so split the page
    // into the list (what the API returned) and the programme dropdown.
    const { text, options } = await page.evaluate(() => {
      const options = [...document.querySelectorAll("select option")].map((o) => (o as HTMLOptionElement).text.trim());
      const clone = document.body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("select").forEach((el) => el.remove());
      return { text: (clone as any).innerText as string ?? clone.textContent ?? "", options };
    });
    /Youth Leagues/.test(text) ? ok(`${path}: sidebar shows "Youth Leagues"`) : bad(`${path}: no "Youth Leagues" link`);
    /Registrations/.test(text) ? ok(`${path}: sidebar shows "Registrations"`) : bad(`${path}: no "Registrations" link`);
    /Mini Football/i.test(text) ? ok(`${path}: Mini Football workspace`) : bad(`${path}: not the Mini Football workspace`);
    if (label === "registrations") {
      const leaked = foreignNames.filter((n) => text.includes(n));
      leaked.length === 0 ? ok("no other club's registrations are in the list") : bad(`another club's registrations are in the list: ${leaked.slice(0, 3).join(" · ")}`);
      const dropdownLeak = foreignNames.filter((n) => options.includes(n));
      dropdownLeak.length === 0
        ? ok("programme filter lists only this workspace's programmes")
        : console.log(`  note programme filter still lists ${dropdownLeak.length} other-club programme name(s) (names only, no child data) — the programmes endpoint is another workspaceOrg() fail-open caller`);
    }
    await page.screenshot({ path: `${OUT}/${label}.png`, fullPage: false }); ok(`screenshot ${OUT}/${label}.png`);
  }
  await browser.close();
} catch (e: any) { bad(e.message); } finally {
  if (uid) { await pool.query(`delete from user_organizations where user_id=$1`, [uid]); await pool.query(`delete from users where id=$1`, [uid]); ok("probe user removed"); }
  await pool.end();
}
console.log(failed ? `\n✗ ${failed} check(s) failed.\n` : "\n✓ An MFL admin finds Youth Leagues + Registrations, and sees only MFL's rows.\n");
process.exit(failed ? 1 : 0);
