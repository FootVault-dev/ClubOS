/**
 * The Fines page in a real browser, on production, at phone and desktop sizes.
 * Logs in as a throwaway account holding ONLY the fines grant — the closest
 * shape to Travis — so this also proves the sidebar renders for him.
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
const made: number[] = []; const madeFines: number[] = []; let browser: any = null;

try {
  const email = `finesui-${crypto.randomBytes(5).toString("hex")}@example.com`;
  const password = crypto.randomBytes(16).toString("base64url");
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Fines','UI',$2,'team_member',true) RETURNING id`, [email, hash]);
  const id = r.rows[0].id; made.push(id);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs, unlocked_tabs)
     VALUES ($1,7,'team_member','["calendar"]'::jsonb,'["fines"]'::jsonb)`, [id]);

  const lr = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }) });
  const cookie = (lr.headers.get("set-cookie") || "").split(";")[0];
  const [cname, cvalue] = cookie.split("=");

  // Two fines so the page has something real to lay out.
  for (const body of [
    { direction: "club_owes", category: "parking", counterparty: "UI Probe Council", amountCents: 4000, dueOn: "2026-08-25", description: "Screenshot probe" },
    { direction: "owed_to_club", category: "disciplinary", counterparty: "UI Probe player", amountCents: 2500, dueOn: "2026-09-30" },
  ]) {
    const res = await fetch(`${BASE}/api/admin/fines`, {
      method: "POST", headers: { cookie, "X-Workspace-Slug": "united-sports-group", "Content-Type": "application/json" },
      body: JSON.stringify(body) });
    const j = await res.json(); if (j?.fine?.id) madeFines.push(j.fine.id);
  }

  const outDir = join(process.cwd(), "..", "..", "outputs", "ui-preflight", "clubos-fines");
  mkdirSync(outDir, { recursive: true });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

  for (const [label, w, h] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e)));
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
    await page.setCookie({ name: cname, value: cvalue, domain: "app.usg.co.nz", path: "/", httpOnly: true, secure: true });
    await page.goto(`${BASE}/admin`, { waitUntil: "networkidle2", timeout: 60000 });
    await page.evaluate(() => localStorage.setItem("clubos_workspace", "united-sports-group"));
    await page.goto(`${BASE}/admin/fines`, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((res) => setTimeout(res, 3500));

    const seen = await page.evaluate(() => ({
      text: document.body.innerText,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sidebarHasFines: !!Array.from(document.querySelectorAll("a")).find(a => /\/admin\/fines$/.test(a.getAttribute("href") || "")),
    }));
    ok(`${label}: no JavaScript errors`, errors.length === 0, errors[0] ?? "");
    ok(`${label}: both fines render`, seen.text.includes("UI Probe Council") && seen.text.includes("UI Probe player"));
    // Case-insensitive: the chip labels are uppercased by CSS, and innerText
    // returns the RENDERED text, not the source string.
    const flat = seen.text.toLowerCase();
    ok(`${label}: the two totals are shown separately`,
       flat.includes("fines the club has to pay") && flat.includes("fines owed to the club"));
    ok(`${label}: amounts render as dollars`, /\$40\.00/.test(seen.text) && /\$25\.00/.test(seen.text));
    ok(`${label}: 🔴 the two totals are never netted into one`, !/\$15\.00/.test(seen.text));
    // On a phone the sidebar is off-canvas behind the toggle, so the link is
    // legitimately not in the DOM — asserting it there would be asserting a bug.
    if (label === "desktop") ok(`${label}: the sidebar carries the Fines link`, seen.sidebarHasFines);
    ok(`${label}: no horizontal overflow`, seen.overflow <= 1, `${seen.overflow}px`);
    await page.screenshot({ path: join(outDir, `fines-${label}.png`), fullPage: true });
    await page.close();
  }
  console.log(`\n  screenshots → outputs/ui-preflight/clubos-fines/`);
} finally {
  if (browser) await browser.close();
  for (const id of madeFines) {
    await pool.query(`DELETE FROM fine_attachments WHERE fine_id=$1`, [id]);
    await pool.query(`DELETE FROM fines WHERE id=$1`, [id]);
  }
  for (const id of made) {
    await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`, [id]);
    await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
  }
  const left = await pool.query(`SELECT count(*)::int n FROM fines WHERE organization_id=7`);
  console.log(`  cleaned up ${made.length} accounts, ${madeFines.length} fines · ${left.rows[0].n} real fines remain`);
  await pool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
