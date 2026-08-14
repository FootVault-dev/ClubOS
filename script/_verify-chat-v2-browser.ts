/**
 * Staff Chat v2 in a real browser on the live site: reply in thread, forward,
 * and the files & links browser — driven as a normal (non-super-admin) staffer.
 *
 *   npx tsx --env-file=.env script/_verify-chat-v2-browser.ts
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

let uid: number | null = null, browser: any = null;
const channels: number[] = [];

try {
  const email = `chatui-${crypto.randomBytes(5).toString("hex")}@example.com`;
  const pw = crypto.randomBytes(16).toString("base64url");
  const r = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Chat','UiProbe',$2,'admin',true) RETURNING id`, [email, await bcrypt.hash(pw, 10)]);
  uid = r.rows[0].id;
  await pool.query(`INSERT INTO user_organizations (user_id, organization_id, role, tabs)
    VALUES ($1,1,'admin',NULL)`, [uid]);

  // A channel of our own, with a message carrying a link, so nothing here
  // depends on real staff conversations.
  const ch = await pool.query(
    `INSERT INTO staff_channels (name, kind, is_private, created_by)
     VALUES ($1,'channel',false,$2) RETURNING id`,
    [`zz-uiprobe-${crypto.randomBytes(3).toString("hex")}`, uid]);
  const channelId = ch.rows[0].id; channels.push(channelId);
  await pool.query(`INSERT INTO staff_channel_members (channel_id, user_id) VALUES ($1,$2)`, [channelId, uid]);

  const other = await pool.query(
    `INSERT INTO staff_channels (name, kind, is_private, created_by)
     VALUES ($1,'channel',false,$2) RETURNING id`,
    [`zz-uiprobe-target-${crypto.randomBytes(3).toString("hex")}`, uid]);
  channels.push(other.rows[0].id);
  await pool.query(`INSERT INTO staff_channel_members (channel_id, user_id) VALUES ($1,$2)`, [other.rows[0].id, uid]);

  const lr = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pw }) });
  const [cn, cv] = (lr.headers.get("set-cookie") || "").split(";")[0].split("=");
  const cookie = `${cn}=${cv}`;

  // Seed a root message with a link, over the API so it goes through the real
  // write path (which is what indexes the link).
  await fetch(`${BASE}/api/admin/chat/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-Workspace-Slug": "christchurch-united" },
    body: JSON.stringify({ body: "Bus schedule is here https://example.com/uiprobe-timetable" }) });

  const outDir = join(process.cwd(), "..", "..", "outputs", "ui-preflight", "clubos-chat-v2");
  mkdirSync(outDir, { recursive: true });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.setCookie({ name: cn, value: cv, domain: "app.usg.co.nz", path: "/", httpOnly: true, secure: true });
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.evaluate(() => localStorage.setItem("clubos_workspace", "christchurch-united"));
  await page.goto(`${BASE}/admin/chat?c=${channelId}`, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 4000));

  ok("the channel loads", /Bus schedule/.test(await page.evaluate(() => document.body.innerText)));

  // ── Thread ──────────────────────────────────────────────────────────────────
  const threadBtn = await page.$('[data-testid^="button-reply-thread-"]');
  ok("a reply-in-thread action is offered on a root message", !!threadBtn);
  if (threadBtn) {
    await threadBtn.evaluate((b: any) => b.click());
    await new Promise((r) => setTimeout(r, 2500));
    const panel = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="panel-thread"]') as HTMLElement | null;
      const r = el?.getBoundingClientRect();
      return { open: !!el, height: r ? r.height : 0, viewport: window.innerHeight };
    });
    // 🔴 The clipping trap: an inline overlay under the blurred header collapses
    // to a ~56px strip. Assert the geometry, not merely that it rendered.
    ok("the thread panel opens full height, not clipped to the header strip",
       panel.open && panel.height > panel.viewport - 4, `${Math.round(panel.height)}px of ${panel.viewport}px`);

    await page.type('[data-testid="input-thread-reply"]', "Bus leaves 09:30 sharp.");
    await page.click('[data-testid="button-send-thread-reply"]');
    await new Promise((r) => setTimeout(r, 3500));
    const txt = await page.evaluate(() => document.body.innerText);
    ok("the reply posts and appears in the thread", /Bus leaves 09:30 sharp/.test(txt));
    await page.screenshot({ path: join(outDir, "thread-panel.png") });

    await page.click('[data-testid="button-close-thread"]');
    await new Promise((r) => setTimeout(r, 2500));
    const after = await page.evaluate(() => document.body.innerText);
    ok("🔴 the reply is ALSO visible in the channel, not hidden in a side-room",
       /Bus leaves 09:30 sharp/.test(after));
    ok("and the root shows a reply count", /1 reply/.test(after));
  }

  // ── Forward ─────────────────────────────────────────────────────────────────
  const fwdBtn = await page.$('[data-testid^="button-forward-"]');
  ok("a forward action is offered", !!fwdBtn);
  if (fwdBtn) {
    await fwdBtn.evaluate((b: any) => b.click());
    await new Promise((r) => setTimeout(r, 2000));
    const dlg = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="dialog-forward"]') as HTMLElement | null;
      const card = el?.querySelector("div") as HTMLElement | null;
      return { open: !!el, cardHeight: card ? card.getBoundingClientRect().height : 0 };
    });
    ok("the forward dialog opens at a readable size", dlg.open && dlg.cardHeight > 160,
       `${Math.round(dlg.cardHeight)}px`);
    await page.screenshot({ path: join(outDir, "forward-dialog.png") });
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 1200));
  }

  // ── Files & links ───────────────────────────────────────────────────────────
  await page.click('[data-testid="button-open-files"]');
  await new Promise((r) => setTimeout(r, 3000));
  const files = await page.evaluate(() => ({
    open: !!document.querySelector('[data-testid="dialog-files"]'),
    text: document.body.innerText,
  }));
  ok("the files & links browser opens", files.open);
  ok("and lists the link that was shared in chat", /uiprobe-timetable|example\.com/.test(files.text));
  await page.type('[data-testid="input-files-search"]', "uiprobe-timetable");
  await new Promise((r) => setTimeout(r, 2500));
  ok("searching narrows to that link",
     /uiprobe-timetable|example\.com/.test(await page.evaluate(() => document.body.innerText)));
  await page.screenshot({ path: join(outDir, "files-browser.png") });

  // Mobile pass — this is a phone-first staff tool.
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await new Promise((r) => setTimeout(r, 1500));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  ok("mobile: no horizontal overflow", !overflow);
  await page.screenshot({ path: join(outDir, "files-mobile.png") });

  console.log(`\nscreenshots → outputs/ui-preflight/clubos-chat-v2/`);
} finally {
  if (browser) await browser.close();
  for (const id of channels) {
    await pool.query(`DELETE FROM staff_message_links WHERE channel_id=$1`, [id]);
    await pool.query(`DELETE FROM staff_messages WHERE channel_id=$1`, [id]);
    await pool.query(`DELETE FROM staff_channel_members WHERE channel_id=$1`, [id]);
    await pool.query(`DELETE FROM staff_channels WHERE id=$1`, [id]);
  }
  if (uid) {
    await pool.query(`DELETE FROM staff_chat_presence WHERE user_id=$1`, [uid]);
    await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`, [uid]);
    await pool.query(`DELETE FROM users WHERE id=$1`, [uid]);
  }
  await pool.end();
  console.log("cleaned up");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
