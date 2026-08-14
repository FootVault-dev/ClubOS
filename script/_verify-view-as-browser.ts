/**
 * The visible half of View As, on the live site: the eye button in the header,
 * the picker, and the banner you must not be able to miss.
 *
 *   npx tsx --env-file=.env script/_verify-view-as-browser.ts
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

async function mk(role: string, first: string) {
  const email = `vabrowser-${crypto.randomBytes(5).toString("hex")}@example.com`;
  const password = crypto.randomBytes(16).toString("base64url");
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,$2,'Probe',$3,$4,true) RETURNING id`, [email, first, hash, role]);
  const id = r.rows[0].id; made.push(id);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs)
     VALUES ($1,1,'admin',NULL)`, [id]);
  return { id, email, password };
}

try {
  const su = await mk("super_admin", "Super");
  const staff = await mk("admin", "Janine");
  console.log(`\nsuper #${su.id}, staff #${staff.id}\n`);

  const lr = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: su.email, password: su.password }) });
  const [cname, cvalue] = (lr.headers.get("set-cookie") || "").split(";")[0].split("=");

  const outDir = join(process.cwd(), "..", "..", "outputs", "ui-preflight", "clubos-view-as");
  mkdirSync(outDir, { recursive: true });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.setCookie({ name: cname, value: cvalue, domain: "app.usg.co.nz", path: "/", httpOnly: true, secure: true });
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.evaluate(() => localStorage.setItem("clubos_workspace", "christchurch-united"));
  await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
  await new Promise(r => setTimeout(r, 2000));

  ok("the eye button renders for a super admin",
     !!(await page.$('[data-testid="button-open-view-as"]')));

  await page.click('[data-testid="button-open-view-as"]');
  await new Promise(r => setTimeout(r, 1800));
  const picker = await page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="overlay-view-as"]') as HTMLElement | null;
    const card = overlay?.firstElementChild as HTMLElement | null;
    const r = card?.getBoundingClientRect();
    return {
      text: document.body.innerText,
      // 🔴 The bug: clipped to the 56px header strip by its backdrop-filter.
      overlayHeight: overlay ? overlay.getBoundingClientRect().height : 0,
      cardHeight: r ? r.height : 0,
      cardTop: r ? r.top : 0,
      viewport: window.innerHeight,
    };
  });
  ok("the picker opens and lists staff", /Janine/.test(picker.text));
  ok("it says what will happen (read-only, logged)", /read-only/i.test(picker.text) && /logged/i.test(picker.text));
  ok("🔴 the overlay covers the whole viewport, not the header strip",
     picker.overlayHeight > picker.viewport - 4, `${Math.round(picker.overlayHeight)}px of ${picker.viewport}px`);
  ok("🔴 the dialog is a readable size, not a sliver",
     picker.cardHeight > 160, `${Math.round(picker.cardHeight)}px tall, top ${Math.round(picker.cardTop)}px`);
  await page.screenshot({ path: join(outDir, "picker.png") });

  await page.click(`[data-testid="button-view-as-${staff.id}"]`);
  await new Promise(r => setTimeout(r, 4000));

  const after = await page.evaluate(() => {
    const pill = document.querySelector('[data-testid="banner-view-as"]') as HTMLElement | null;
    const r = pill?.getBoundingClientRect();
    return {
      text: document.body.innerText,
      banner: !!pill,
      exit: !!document.querySelector('[data-testid="button-stop-view-as"]'),
      pillWidth: r ? r.width : 0,
      pillTop: r ? r.top : 999,
      pillRight: r ? r.right : 0,
    };
  });
  ok("the amber pill is on screen", after.banner);
  ok("it names who you're viewing", /Janine/.test(after.text));
  ok("the pill sits in the header, not a full-width bar",
     after.pillWidth > 0 && after.pillWidth < 460, `${Math.round(after.pillWidth)}px wide`);
  ok("and it's up in the top right", after.pillTop < 60 && after.pillRight > 900,
     `top ${Math.round(after.pillTop)}px, right edge ${Math.round(after.pillRight)}px`);
  ok("and there is a visible way out", after.exit);
  await page.screenshot({ path: join(outDir, "viewing-as.png") });

  await page.click('[data-testid="button-stop-view-as"]');
  await new Promise(r => setTimeout(r, 4000));
  const home = await page.evaluate(() => ({
    banner: !!document.querySelector('[data-testid="banner-view-as"]'),
    eye: !!document.querySelector('[data-testid="button-open-view-as"]'),
  }));
  ok("clicking out returns to the real account", !home.banner && home.eye);

  console.log(`\nscreenshots → outputs/ui-preflight/clubos-view-as/`);
} finally {
  if (browser) await browser.close();
  for (const id of made) {
    await pool.query(`DELETE FROM view_as_events WHERE actor_user_id=$1 OR target_user_id=$1`, [id]);
    await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`, [id]);
    await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
  }
  console.log(`cleaned up ${made.length} accounts`);
  await pool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
