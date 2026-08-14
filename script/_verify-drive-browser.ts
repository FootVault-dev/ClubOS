// UI preflight for Club Drive — drives the REAL live page in a real browser at
// phone and desktop sizes, as a NON-super-admin, and screenshots both.
//
//   npx tsx --env-file=.env script/_verify-drive-browser.ts
//
// Why a browser and not the API: the API accepting a request says nothing about
// what the deployed page actually renders or asks for. The Contacts tab was
// blank for every member of staff for weeks while its API worked perfectly.
//
// Signs in over the API and injects the cookie — driving the login form races
// ClubOS's SPA submit and screenshots the login page, which looks exactly like
// a permissions failure.
import pg from "pg";
import bcrypt from "bcryptjs";
import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";
import { join } from "path";

const BASE = process.env.VERIFY_BASE || "https://app.usg.co.nz";
const WORKSPACE = "christchurch-united";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = join(process.cwd(), "outputs", "drive-preflight");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let pass = 0, fail = 0;
const ok = (l: string, good: boolean, d = "") => {
  console.log(`  ${good ? "ok  " : "FAIL"} ${l}${d ? ` — ${d}` : ""}`);
  good ? pass++ : fail++;
};

const MARKER = `preflight-marlin-${Date.now()}`;
const users: number[] = [];
const nodes: number[] = [];
let browser: any = null;

try {
  mkdirSync(OUT, { recursive: true });
  console.log(`\nClub Drive — browser preflight against ${BASE}\n`);

  // A plain workspace admin: what Olga or Travis actually is.
  const email = `_drivepreflight_${Date.now()}@usg.co.nz`;
  const password = `T${Math.random().toString(36).slice(2)}!aA9`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Preflight','Test',$2,'team_member',true) RETURNING id`,
    [email, await bcrypt.hash(password, 10)],
  );
  const userId = rows[0].id;
  users.push(userId);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs)
     VALUES ($1, 2, 'admin', NULL)`,
    [userId],
  );

  // Some real content so the screenshots show the page doing its job rather
  // than an empty state that hides every layout problem.
  const { rows: [f1] } = await pool.query(
    `INSERT INTO drive_nodes (kind, name) VALUES ('folder',$1) RETURNING id`, [`Sponsorship ${MARKER}`]);
  nodes.push(f1.id);
  const { rows: [f2] } = await pool.query(
    `INSERT INTO drive_nodes (kind, name) VALUES ('folder',$1) RETURNING id`, [`Club Budgets ${MARKER}`]);
  nodes.push(f2.id);
  for (const [name, size, text] of [
    [`Partnership agreement — Fitness Canterbury ${MARKER}.pdf`, 284000, `gym partnership ${MARKER} heads of agreement`],
    [`Academy fee schedule 2026 ${MARKER}.xlsx`, 41000, `fees ${MARKER} U9 U13 term`],
    [`Board pack — August ${MARKER}.docx`, 1240000, `board ${MARKER} minutes`],
  ] as const) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO drive_nodes (parent_id, kind, name, size_bytes, mime_type, extracted_text, extract_status)
       VALUES ($1,'file',$2,$3,'application/pdf',$4,'done') RETURNING id`,
      [f1.id, name, size, text],
    );
    nodes.push(r.id);
  }

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
  const raw = login.headers.get("set-cookie") || "";
  const [cname, cvalue] = raw.split(";")[0].split("=");

  browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

  for (const [label, width, height, mobile] of [
    ["drive-desktop", 1440, 900, false],
    ["drive-mobile", 390, 844, true],
  ] as const) {
    console.log(`\n${label} (${width}×${height})`);
    const page = await browser.newPage();
    await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
    if (mobile) await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1");
    await page.setCookie({ name: cname, value: cvalue, domain: "app.usg.co.nz", path: "/", httpOnly: true, secure: true });

    // Confirm the page sends the workspace header — the exact thing whose
    // absence made Contacts blank for everyone but a super admin.
    let sawHeader = false;
    let listStatus = 0;
    page.on("request", (r: any) => {
      if (r.url().includes("/api/admin/drive/list") && r.headers()["x-workspace-slug"]) sawHeader = true;
    });
    page.on("response", (r: any) => {
      if (r.url().includes("/api/admin/drive/list")) listStatus = r.status();
    });

    await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.evaluate((slug: string) => localStorage.setItem("clubos_workspace", slug), WORKSPACE);
    await page.goto(`${BASE}/admin/drive`, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 3000));

    const body = await page.evaluate(() => document.body.innerText);
    ok("the page is Club Drive, not the login screen", !/Sign in|Forgot password/i.test(body));

    // 🔴 A tab that renders but has no sidebar link is unreachable — the exact
    // failure that emptied a single-tab user's whole sidebar once before.
    const inNav = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href="/admin/drive"]')).length > 0);
    ok("a Drive link exists in the sidebar nav", inNav);
    ok("the request carried X-Workspace-Slug", sawHeader);
    ok("the listing returned 200 (304 = cache, also fine)", listStatus === 200 || listStatus === 304, `HTTP ${listStatus}`);
    ok("a seeded folder is actually rendered", body.includes("Sponsorship"), body.slice(0, 60).replace(/\n/g, " "));

    // The page must never scroll sideways on a phone.
    const overflow = await page.evaluate(() => ({
      docWidth: document.documentElement.scrollWidth,
      winWidth: window.innerWidth,
    }));
    ok("no horizontal overflow", overflow.docWidth <= overflow.winWidth + 1,
      `${overflow.docWidth} vs ${overflow.winWidth}`);

    // Search, the whole point of the page, driven for real.
    const input = await page.$('input[placeholder*="Search"]');
    ok("the search box is present", Boolean(input));
    if (input) {
      await input.click();
      await page.keyboard.type(MARKER);
      await new Promise((r) => setTimeout(r, 2500));
      const after = await page.evaluate(() => document.body.innerText);
      ok("searching text from inside a file returns results", /result/i.test(after) && after.includes("Partnership agreement"),
        after.split("\n").find((l: string) => /result/i.test(l))?.slice(0, 50) ?? "no result line");

      // A folder must not render with a file icon — kind decides the category,
      // not the (absent) file extension.
      const folderCat = await fetch(`${BASE}/api/admin/drive/search?q=${MARKER}`, {
        headers: { cookie: `${cname}=${cvalue}`, "X-Workspace-Slug": WORKSPACE },
      }).then((r) => r.json()).then((j: any) => j.items.find((i: any) => i.kind === "folder")?.category);
      ok("a folder reports category 'folder', not 'other'", folderCat === "folder", String(folderCat));
    }

    const shot = join(OUT, `${label}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    console.log(`  → ${shot}`);
    await page.close();
  }
} catch (e: any) {
  console.error("\npreflight threw:", e.message);
  fail++;
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const id of [...nodes].reverse()) {
    await pool.query(`DELETE FROM drive_access_log WHERE node_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM drive_nodes WHERE id = $1`, [id]).catch(() => {});
  }
  for (const id of users) {
    await pool.query(`DELETE FROM drive_access_log WHERE user_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
  }
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
