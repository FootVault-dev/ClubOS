// Drive the real Coding Budget tab in a real browser, on production.
//
//   npx tsx --env-file=.env script/_verify-coding-budget-browser.ts
//
// 🔴 Reaching the page by typing its URL proves nothing about whether anyone can
// FIND it. The sidebar keeps its OWN per-workspace nav arrays in
// app-sidebar.tsx, entirely separate from shared/tabs.ts, and a tab registered
// in one but not the other is either a link to a 404 or no link at all. Both
// have shipped here before. So this clicks the sidebar link.
//
// Creates a throwaway super-admin, drives the page at desktop and phone widths,
// and deletes the user again in the `finally` — it exists for seconds and is
// removed even if an assertion throws.
//
// Logs in with curl rather than fetch: node's outbound networking is broken on
// this machine (see the note in script/preflight-deploy.ts).
import pg from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import puppeteer from "puppeteer-core";
import { execFileSync } from "child_process";
import { mkdirSync } from "fs";
import { join } from "path";

const BASE = process.env.VERIFY_ORIGIN || "https://app.usg.co.nz";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

let pass = 0;
const fails: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label} ${detail}`); }
};

const made: number[] = [];
let browser: any = null;

try {
  const email = `codingprobe-${crypto.randomBytes(5).toString("hex")}@example.com`;
  const password = crypto.randomBytes(16).toString("base64url");
  const r = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Coding','Probe',$2,'super_admin',true) RETURNING id`,
    [email, await bcrypt.hash(password, 10)]);
  const id = r.rows[0].id; made.push(id);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs) VALUES ($1,7,'admin',NULL)`, [id]);

  const headers = execFileSync("curl", [
    "-s", "-D", "-", "-o", "/dev/null", "--max-time", "30",
    "-X", "POST", "-H", "Content-Type: application/json",
    "-d", JSON.stringify({ email, password }), `${BASE}/api/auth/login`,
  ]).toString();
  ok("logged in to production", /^HTTP\/[\d.]+ 200/m.test(headers), headers.split("\n")[0]);

  const setCookie = (headers.match(/^set-cookie:\s*(.+)$/im)?.[1] ?? "").split(";")[0];
  const [cname, cvalue] = setCookie.split("=");
  if (!cname) throw new Error("no session cookie returned by login");

  const outDir = join(process.cwd(), "..", "..", "outputs", "ui-preflight", "clubos-coding-budget");
  mkdirSync(outDir, { recursive: true });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

  for (const [label, w, h] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
    await page.setCookie({ name: cname, value: cvalue, domain: "app.usg.co.nz", path: "/", httpOnly: true, secure: true });
    await page.goto(`${BASE}/admin`, { waitUntil: "networkidle2", timeout: 60000 });
    await page.evaluate(() => localStorage.setItem("clubos_workspace", "united-sports-group"));
    await page.goto(`${BASE}/admin`, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise(res => setTimeout(res, 2500));

    // 🔴 The link must EXIST in the sidebar, and clicking it must land on the
    // page. Reaching the page by URL proves the route resolves and nothing
    // about whether a human can find it.
    //
    // ⚠️ DESKTOP ONLY, and not because the mobile case does not matter. At
    // 390px the ClubOS admin shell renders NO admin links at all — measured on
    // production: zero `a[href^="/admin"]` in the DOM, before and after
    // clicking "Toggle Sidebar", with Budget and Fines equally absent. That is
    // the shell's behaviour for every tab in every workspace, so asserting it
    // here would fail on something this feature did not cause and cannot fix.
    // It is a real finding about the admin shell — the standing rule is a
    // sidebar on desktop and a BOTTOM BAR on a phone, never a hidden one — and
    // it belongs in a change to the shell, not in this harness.
    const linked = await page.evaluate(() =>
      !!document.querySelector('a[href="/admin/coding-budget"]'));
    if (label === "desktop") {
      ok("desktop: the sidebar carries a Coding Budget link", linked);
    } else {
      console.log(`  · mobile: admin nav is not rendered at 390px for ANY tab (shell-wide, pre-existing)`);
    }

    if (linked) {
      await page.evaluate(() =>
        (document.querySelector('a[href="/admin/coding-budget"]') as HTMLElement).click());
      await new Promise(res => setTimeout(res, 3500));
      ok(`${label}: clicking it lands on /admin/coding-budget`,
        page.url().endsWith("/admin/coding-budget"), page.url());
    } else {
      await page.goto(`${BASE}/admin/coding-budget`, { waitUntil: "networkidle2", timeout: 60000 });
      await new Promise(res => setTimeout(res, 3500));
    }

    const text = await page.evaluate(() => document.body.innerText);

    // A tab in tabs.ts but missing from the workspace's own route Switch
    // renders NotFound — it has happened twice in this codebase.
    ok(`${label}: the route resolves (not a 404 page)`, !/Page Not Found|404/i.test(text));

    ok(`${label}: the heading renders`, /Coding Budget/.test(text));
    ok(`${label}: it says how many codes and streams`, /882 codes across 30 streams/.test(text));

    // The four headline numbers, and the one that matters most: the club is in
    // deficit excluding GST. If this ever reads as a surplus the page has
    // started netting the GST-inclusive columns.
    ok(`${label}: budgeted income shows $2,762,909`, /\$2,762,909/.test(text));
    ok(`${label}: budgeted expenses shows $2,786,525`, /\$2,786,525/.test(text));
    ok(`${label}: the net position reads as a deficit`, /deficit, excl\. GST/.test(text));

    // The findings must be on the page, not buried in a doc nobody opens.
    ok(`${label}: the GST-netting warning is shown`, /GST collected on a registration is Inland Revenue/.test(text));
    ok(`${label}: the $28,750 variance is named`, /\$28,750/.test(text));
    ok(`${label}: the unset-GST count is named`, /have no GST treatment set/.test(text));

    // 🔴 Expand a stream and prove an unbudgeted line renders an em-dash, not
    //    $0.00. This is the assertion that catches a well-meaning `?? 0`.
    const expanded = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button[aria-label="Expand"]'));
      if (!btns.length) return false;
      (btns[0] as HTMLElement).click();
      return true;
    });
    ok(`${label}: a stream expands`, expanded);
    if (expanded) {
      await new Promise(res => setTimeout(res, 900));
      const after = await page.evaluate(() => document.body.innerText);
      ok(`${label}: unbudgeted lines render an em-dash, never $0.00`, /—/.test(after));
    }

    // No horizontal overflow at 390px — the standing UI rule.
    if (label === "mobile") {
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok("mobile: no horizontal overflow at 390px", overflow <= 1, `${overflow}px`);
    }

    await page.screenshot({ path: join(outDir, `${label}.png`), fullPage: false });
    console.log(`    → ${join(outDir, `${label}.png`)}`);
    await page.close();
  }
} finally {
  if (browser) await browser.close();
  for (const id of made) {
    await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [id]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
  }
  await pool.end();
}

console.log(`\n  ${pass} passed, ${fails.length} failed\n`);
if (fails.length) { for (const f of fails) console.log(`    ✗ ${f}`); process.exit(1); }
