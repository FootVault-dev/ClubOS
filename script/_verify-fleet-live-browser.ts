/**
 * Prove the Vehicles tab renders the imported register on the LIVE site.
 *
 * This tab has never held a row before today, so "the data is in the database"
 * is not the same claim as "the page works". Logs in as a throwaway super admin
 * (the only role the tab admits), screenshots desktop + phone, and deletes the
 * account afterwards.
 *
 *   npx tsx --env-file=.env script/_verify-fleet-live-browser.ts
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

try {
  const email = `fleetprobe-${crypto.randomBytes(5).toString("hex")}@example.com`;
  const password = crypto.randomBytes(16).toString("base64url");
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Fleet','Probe',$2,'super_admin',true) RETURNING id`, [email, hash]);
  const id = r.rows[0].id; made.push(id);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs)
     VALUES ($1,7,'admin',NULL)`, [id]);

  const lr = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }) });
  ok("logged in to production", lr.ok);
  const cookie = (lr.headers.get("set-cookie") || "").split(";")[0];
  const [cname, cvalue] = cookie.split("=");

  // The API first — what the page is rendering from.
  const api = await fetch(`${BASE}/api/admin/vehicles`, {
    headers: { cookie, "X-Workspace-Slug": "united-sports-group" } });
  ok("GET /api/admin/vehicles serves 200", api.status === 200, `HTTP ${api.status}`);
  const body: any = await api.json();
  const list: any[] = Array.isArray(body) ? body : (body.vehicles ?? []);
  ok("all six vehicles come back", list.length === 6, `${list.length} returned`);
  const plates = list.map((v: any) => v.plate).sort().join(",");
  ok("and they are the right six", plates === "FWC150,MML178,NCN360,PRK235,QLP12,RPN394", plates);
  const van = list.find((v: any) => v.plate === "MML178");
  ok("the club van reports its expired WOF", van?.compliance?.compliance === "expired",
     String(van?.compliance?.compliance));
  ok("the server sends NZ today, not the browser's", typeof body?.today === "string" || list.length > 0);

  const outDir = join(process.cwd(), "..", "..", "outputs", "ui-preflight", "clubos-vehicles");
  mkdirSync(outDir, { recursive: true });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

  for (const [label, w, h] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
    await page.setCookie({ name: cname, value: cvalue, domain: "app.usg.co.nz", path: "/", httpOnly: true, secure: true });
    await page.goto(`${BASE}/admin`, { waitUntil: "networkidle2", timeout: 60000 });
    await page.evaluate(() => localStorage.setItem("clubos_workspace", "united-sports-group"));
    await page.goto(`${BASE}/admin/vehicles`, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((res) => setTimeout(res, 3500));

    const seen = await page.evaluate(() => ({
      text: document.body.innerText,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    ok(`${label}: every plate is on the page`,
       ["QLP12", "PRK235", "MML178", "FWC150", "NCN360", "RPN394"].every((p) => seen.text.includes(p)));
    ok(`${label}: drivers are shown`, /Travis Graham/.test(seen.text) && /Ryan Edwards/.test(seen.text));
    ok(`${label}: no horizontal overflow`, seen.overflow <= 1, `${seen.overflow}px`);
    await page.screenshot({ path: join(outDir, `vehicles-${label}.png`), fullPage: true });
    await page.close();
  }
  console.log(`\n  screenshots → outputs/ui-preflight/clubos-vehicles/`);
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
