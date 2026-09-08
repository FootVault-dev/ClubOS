/**
 * _verify-workspace-isolation-live.ts — two tabs, two workspaces, one browser:
 * does each tab keep showing ITS OWN club's programmes?
 *
 * 2026-09-09: `localStorage.clubos_workspace` is shared by every tab, and the
 * request header was read from it on every call. Daniel opened Mini Football
 * in one tab and Christchurch United in another; each tab's sidebar kept its
 * own name while every list on it came back scoped to whichever workspace was
 * switched to LAST — the CUFC Academy page listed four Ballers age groups and
 * none of CUFC's programmes, then the reverse. The server was right both times.
 *
 * This logs in a throwaway admin who belongs to BOTH clubs, opens the CUFC
 * Academy in tab A, switches tab B to Mini Football (the way the switcher does:
 * write localStorage, reload), then navigates INSIDE tab A without a reload and
 * asserts it still lists CUFC's programmes and no Ballers. Also checks each
 * workspace's page from a fresh tab. Fails on the pre-fix build.
 *
 *   npx tsx --env-file=.env script/_verify-workspace-isolation-live.ts
 */
import puppeteer from "puppeteer-core";
import pg from "pg";
import bcrypt from "bcryptjs";
import { mkdirSync } from "fs";

const BASE = process.env.RENDER_CHECK_BASE || "https://app.usg.co.nz";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const email = `zzisolation-${Date.now()}@example.com`, pw = `Probe-${Date.now()}!x`;
const OUT = "/tmp/workspace-isolation"; mkdirSync(OUT, { recursive: true });
let uid = 0, failed = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failed++; console.log(`  FAIL ${m}`); };
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gotoRetry(page: any, url: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 }); return; }
    catch (e: any) { if (!/detached/i.test(e.message) || attempt === 2) throw e; await settle(1500); }
  }
}

try {
  const { rows: cufcProgs } = await pool.query(`select name from programs where organization_id=1 and type='academy' and is_active`);
  const { rows: mflProgs } = await pool.query(`select name from programs where organization_id=3 and type='academy' and is_active`);
  const cufcNames: string[] = cufcProgs.map((r) => r.name), mflNames: string[] = mflProgs.map((r) => r.name);
  if (!cufcNames.length || !mflNames.length) throw new Error("need active academy programmes in both org 1 and org 3 to test");

  const { rows } = await pool.query(`INSERT INTO users (email,first_name,last_name,password,role,active) VALUES ($1,'Isolation','Probe',$2,'admin',true) RETURNING id`, [email, await bcrypt.hash(pw, 10)]);
  uid = rows[0].id;
  await pool.query(`INSERT INTO user_organizations (user_id,organization_id,role,tabs) VALUES ($1,1,'admin',NULL),($1,3,'admin',NULL)`, [uid]);
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pw }) });
  if (!login.ok) throw new Error(`login ${login.status}`);
  const [cn, cv] = (login.headers.get("set-cookie") || "").split(";")[0].split("=");

  const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: ["--no-sandbox"] });
  const host = new URL(BASE).hostname;
  const cookie = { name: cn, value: cv, domain: host, path: "/", httpOnly: true, secure: true };
  const listOf = async (page: any) => page.evaluate(() => document.body.innerText);
  const hasAll = (text: string, names: string[]) => names.every((n) => text.includes(n));
  const hasAny = (text: string, names: string[]) => names.some((n) => text.includes(n));

  // Tab A: Christchurch United academy.
  const A = await browser.newPage(); await A.setViewport({ width: 1440, height: 900 }); await A.setCookie(cookie);
  await A.evaluateOnNewDocument(() => localStorage.setItem("clubos_workspace", "christchurch-united"));
  await gotoRetry(A, `${BASE}/admin/academy`); await settle(2500);
  let tA = await listOf(A);
  hasAll(tA, cufcNames) && !hasAny(tA, mflNames) ? ok(`tab A (CUFC): its ${cufcNames.length} programmes, no Ballers`) : bad(`tab A (CUFC) initial: ${hasAny(tA, mflNames) ? "shows Ballers" : "missing CUFC programmes"}`);

  // Tab B: switch to Mini Football the way the switcher does (localStorage + load).
  const B = await browser.newPage(); await B.setViewport({ width: 1440, height: 900 }); await B.setCookie(cookie);
  await B.evaluateOnNewDocument(() => localStorage.setItem("clubos_workspace", "mini-football-leagues"));
  await gotoRetry(B, `${BASE}/admin/academy`); await settle(2500);
  const tB = await listOf(B);
  hasAll(tB, mflNames) && !hasAny(tB, cufcNames) ? ok(`tab B (MFL): its ${mflNames.length} age groups, none of CUFC's`) : bad(`tab B (MFL): ${hasAny(tB, cufcNames) ? "shows CUFC programmes" : "missing Ballers"}`);
  await B.screenshot({ path: `${OUT}/tab-b-mfl.png` });

  // Back in tab A, navigate WITHOUT reloading — its requests must still say CUFC.
  await A.evaluate(() => (window as any).history.pushState({}, "", "/admin/registrations"));
  await A.evaluate(() => window.dispatchEvent(new PopStateEvent("popstate")));
  await settle(2500);
  await A.evaluate(() => (window as any).history.pushState({}, "", "/admin/academy"));
  await A.evaluate(() => window.dispatchEvent(new PopStateEvent("popstate")));
  await settle(3500);
  tA = await listOf(A);
  const slugA = await A.evaluate(() => localStorage.getItem("clubos_workspace"));
  ok(`shared localStorage now says "${slugA}" (written by tab B)`);
  hasAll(tA, cufcNames) && !hasAny(tA, mflNames)
    ? ok("tab A (CUFC) after tab B switched: still its own programmes, no Ballers")
    : bad(`tab A (CUFC) after tab B switched: ${hasAny(tA, mflNames) ? "NOW SHOWS BALLERS — tabs are crossing" : "lost its programmes"}`);
  await A.screenshot({ path: `${OUT}/tab-a-cufc-after.png` });
  await browser.close();
} catch (e: any) { bad(e.message); } finally {
  if (uid) { await pool.query(`delete from user_organizations where user_id=$1`, [uid]); await pool.query(`delete from users where id=$1`, [uid]); ok("probe user removed"); }
  await pool.end();
}
console.log(failed ? `\n✗ ${failed} check(s) failed.\n` : "\n✓ Each tab keeps its own workspace; CUFC and Ballers never cross.\n");
process.exit(failed ? 1 : 0);
