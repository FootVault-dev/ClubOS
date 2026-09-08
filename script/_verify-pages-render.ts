/**
 * _verify-pages-render.ts — does every main admin page actually RENDER?
 *
 * Daniel, 2026-09-04: "white screen error again when I click on a contact —
 * make sure this never happens again as it's happening all the time,
 * particularly around new updates or features launching."
 *
 * He is right, and the reason is that nothing we had could see it. tsc passes,
 * `npm run build` passes, route probes return 200 — and the page still white-
 * screens, because the failure is at RUNTIME in the browser. The three that hit
 * production recently:
 *   · an un-imported icon                        (whole admin, every workspace)
 *   · a prop named `ref` stripped by React 18    (two chat channels)
 *   · a useMutation below an early return        (#310, the person page, v499)
 * Nothing they have in common is visible to a compiler.
 *
 * So: open the real pages in a real browser as an ordinary workspace admin, and
 * fail if one comes back empty or throws. Runs after every deploy.
 *
 *   npx tsx --env-file=.env script/_verify-pages-render.ts
 */
import puppeteer from "puppeteer-core";
import pg from "pg";
import bcrypt from "bcryptjs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.RENDER_CHECK_BASE || "https://app.usg.co.nz";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let failed = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failed++; console.log(`  FAIL ${m}`); };
const users: number[] = [];
let browser: any = null;

try {
  const email = `_render_${Date.now()}@usg.co.nz`;
  const pw = `T${Math.random().toString(36).slice(2)}!aA9`;
  const { rows } = await pool.query(
    `INSERT INTO users (email,first_name,last_name,password,role,active)
     VALUES ($1,'Render','Check',$2,'admin',true) RETURNING id`, [email, await bcrypt.hash(pw, 10)]);
  users.push(rows[0].id);
  // A plain workspace admin in CUFC — what Olga and Travis are. A super admin
  // sees different pages and would not reproduce what staff hit.
  await pool.query(`INSERT INTO user_organizations (user_id,organization_id,role,tabs)
                    VALUES ($1,1,'admin',NULL)`, [rows[0].id]);
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pw }) });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const [cn, cv] = (login.headers.get("set-cookie") || "").split(";")[0].split("=");

  // A real person to open — the page that broke in v499.
  const { rows: pr } = await pool.query(`select id from contacts where type='guardian' order by id desc limit 1`);
  const personPath = pr.length ? `/admin/people/contact-${pr[0].id}` : null;

  const PAGES: [string, string][] = [
    ["/admin", "Dashboard"],
    ["/admin/registrations", "Registrations"],
    ["/admin/contacts", "Contacts"],
    ["/admin/contacts?q=a", "Contacts (searched)"],
    ...(personPath ? [[personPath, "Person detail"] as [string, string]] : []),
    ["/admin/academy", "Academy"],
    ["/admin/mailer", "Mailer"],
    ["/admin/camps", "Camps"],
    ["/admin/discounts", "Discounts"],
    ["/admin/chat", "Chat"],
    ["/admin/knowledge-base", "Knowledge Base"],
    ["/admin/task-tracker", "Task Tracker"],
    ["/admin/qr-codes", "QR Code Generator"],
    ["/admin/club-events", "Events (club dinner)"],
  ];

  browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  for (const [path, label] of PAGES) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setCookie({ name: cn, value: cv, domain: "app.usg.co.nz", path: "/", httpOnly: true, secure: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(BASE + path, { waitUntil: "networkidle2", timeout: 45000 });
      await new Promise((r) => setTimeout(r, 2500));
      const text = (await page.evaluate(() => document.body.innerText || "")).trim();
      // The sidebar alone is ~200 chars, so a page whose CONTENT died still has
      // text. Measure the main region, not the document.
      const main = (await page.evaluate(() => {
        const m = document.querySelector("main") || document.querySelector("[role=main]");
        return (m as HTMLElement | null)?.innerText?.trim() || "";
      }));
      const body = main || text;
      const react = errors.find((e) => /Minified React error|Rendered more hooks|is not defined|undefined is not/i.test(e));
      if (react) bad(`${label.padEnd(22)} ${react.slice(0, 90)}`);
      else if (body.length < 40) bad(`${label.padEnd(22)} rendered ${body.length} chars — blank page`);
      else if (errors.length) bad(`${label.padEnd(22)} ${errors[0].slice(0, 90)}`);
      else ok(`${label.padEnd(22)} ${body.length} chars`);
    } catch (e: any) {
      bad(`${label.padEnd(22)} ${e.message.slice(0, 90)}`);
    }
    await page.close();
  }
} catch (e: any) { bad(`threw: ${e.message}`); }
finally {
  if (browser) await browser.close();
  for (const id of users) {
    await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`, [id]);
    await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
  }
  await pool.end();
}

console.log(failed === 0
  ? "\n✓ Every page renders.\n"
  : `\n✗ ${failed} page(s) failed to render — DO NOT leave this deployed.\n`);
process.exit(failed === 0 ? 0 : 1);
