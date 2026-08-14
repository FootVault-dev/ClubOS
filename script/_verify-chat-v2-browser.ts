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
const extraUsers: number[] = [];
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

  // 🔴 A second member — @ mentions can only offer OTHER people, so a
  // single-member channel produces an empty list and the earlier failure was
  // the harness's setup, not the app.
  const mate = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Mentionable','Colleague',$2,'admin',true) RETURNING id`,
    [`chatmate-${crypto.randomBytes(5).toString("hex")}@example.com`, await bcrypt.hash(crypto.randomBytes(12).toString("hex"), 10)]);
  const mateId = mate.rows[0].id; extraUsers.push(mateId);
  await pool.query(`INSERT INTO staff_channel_members (channel_id, user_id) VALUES ($1,$2)`, [channelId, mateId]);

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
    // 🔴 Reversed 2026-08-15: replies are thread-only. The channel keeps just
    // the root and its count, so the feed stays clean.
    ok("🔴 the reply is NOT in the channel feed — thread only",
       !/Bus leaves 09:30 sharp/.test(after));
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

  // ── Drag & drop, and the sticky draft ──────────────────────────────────────
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 1200));

  // 🔴 Drop target is the WHOLE conversation, not the thin composer bar.
  const dragOverCentre = async (type: string) => page.evaluate((ev: string) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "team-sheet.pdf", { type: "application/pdf" }));
    const target = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2) || document.body;
    target.dispatchEvent(new DragEvent(ev, { bubbles: true, dataTransfer: dt, clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 }));
  }, type);
  const overlayOpen = () => page.evaluate(() =>
    !!document.querySelector('[data-testid="chat-drop-overlay"]'));

  await dragOverCentre("dragenter");
  await new Promise((r) => setTimeout(r, 700));
  ok("dragging over the MIDDLE of the messages shows the overlay", await overlayOpen());
  const overlaySize = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-drop-overlay"]') as HTMLElement | null;
    const r = el?.getBoundingClientRect();
    return { h: r ? r.height : 0, viewport: window.innerHeight };
  });
  ok("and it covers the screen, not a strip",
     overlaySize.h > overlaySize.viewport - 4, `${Math.round(overlaySize.h)}px of ${overlaySize.viewport}px`);
  await page.screenshot({ path: join(outDir, "drag-drop.png") });

  // 🔴 Dragging back out must clear it — a stuck overlay blocks the whole app.
  await dragOverCentre("dragleave");
  await new Promise((r) => setTimeout(r, 600));
  ok("dragging back out clears the overlay", !(await overlayOpen()));

  // 🔴 And an abandoned drag (dropped outside / Escape) must clear it too:
  // neither fires a drop nor a balancing dragleave.
  await dragOverCentre("dragenter");
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(() => window.dispatchEvent(new Event("dragend")));
  await new Promise((r) => setTimeout(r, 600));
  ok("an abandoned drag doesn't leave the overlay stuck", !(await overlayOpen()));

  // 🔴 Travis's actual complaint: type, leave the tab, come back, it's gone.
  const composerSel = 'textarea';
  await page.click(composerSel);
  await page.type(composerSel, "Half-written note about the bus");
  await new Promise((r) => setTimeout(r, 900));
  await page.goto(`${BASE}/admin/registrations`, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2000));
  await page.goto(`${BASE}/admin/chat?c=${channelId}`, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3500));
  const restored = await page.evaluate(() => {
    const ta = document.querySelector("textarea") as HTMLTextAreaElement | null;
    return ta?.value ?? "";
  });
  ok("🔴 the draft is still there after switching tabs and coming back",
     restored.includes("Half-written note about the bus"), JSON.stringify(restored.slice(0, 40)));

  // ── @ mentions inside a thread ─────────────────────────────────────────────
  // 🔴 The server takes mentions EXPLICITLY, so a plain textarea pinged nobody.
  await page.goto(`${BASE}/admin/chat?c=${channelId}`, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3500));
  const openThread = await page.$('[data-testid^="button-open-thread-"]');
  if (openThread) {
    await openThread.evaluate((b: any) => b.click());
    await new Promise((r) => setTimeout(r, 2500));
    await page.click('[data-testid="input-thread-reply"]');
    await page.type('[data-testid="input-thread-reply"]', "@");
    await new Promise((r) => setTimeout(r, 1200));
    const hasList = await page.evaluate(() =>
      !!document.querySelector('[data-testid^="thread-mention-"]'));
    ok("🔴 typing @ in a thread opens the mention list", hasList);
    await page.screenshot({ path: join(outDir, "thread-mentions.png") });
  } else {
    ok("a thread exists to test mentions in", false, "no thread affordance found");
  }

  // ── Full emoji catalogue on desktop (Daniel, 2026-08-15) ───────────────────
  // Mobile has had one since 2026-08-07; desktop offered only the six quick
  // reactions, so the two clients disagreed about what a reaction could be.
  await page.keyboard.press("Escape");
  await page.goto(`${BASE}/admin/chat?c=${channelId}`, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3500));
  await page.evaluate(() => {
    const row = document.querySelector('[data-testid^="button-forward-"]')?.parentElement;
    (row as HTMLElement | null)?.style.setProperty("display", "flex");
  });
  const reactBtn = await page.$('button[title="React"]');
  ok("a react action is offered", !!reactBtn);
  if (reactBtn) {
    await reactBtn.evaluate((b: any) => b.click());
    await new Promise((r) => setTimeout(r, 1200));
    ok("the six quick reactions are one click away",
       await page.evaluate(() => !!document.querySelector('[data-testid^="quick-emoji-"]')));
    ok("🔴 and a '+' opens the rest (WhatsApp's shape)",
       await page.evaluate(() => !!document.querySelector('[data-testid="button-more-emoji"]')));

    await page.click('[data-testid="button-more-emoji"]');
    await new Promise((r) => setTimeout(r, 1200));
    const cat = await page.evaluate(() => ({
      picker: !!document.querySelector('[data-testid="emoji-picker"]'),
      search: !!document.querySelector('[data-testid="input-emoji-search"]'),
      // 🔴 The bug that shipped: tabs rendered, grid was empty, because the
      // dataset is an ARRAY of groups and was indexed as a map.
      count: document.querySelectorAll('[data-testid="emoji-option"]').length,
      tabs: document.querySelectorAll('[data-testid^="emoji-tab-"]').length,
    }));
    ok("the full catalogue opens", cat.picker && cat.search);
    ok("🔴 and the grid actually CONTAINS emoji", cat.count > 50, `${cat.count} emoji`);
    ok("with category tabs to scroll through", cat.tabs >= 8, `${cat.tabs} categories`);

    await page.type('[data-testid="input-emoji-search"]', "rocket");
    await new Promise((r) => setTimeout(r, 900));
    const found = await page.evaluate(() =>
      document.querySelectorAll('[data-testid="emoji-option"]').length);
    ok("searching finds something", found > 0, `${found} results for "rocket"`);
    await page.screenshot({ path: join(outDir, "emoji-picker.png") });
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 800));
  }

  // ── Actions inside the thread ──────────────────────────────────────────────
  // 🔴 Thread messages had no react/forward at all — the panel was a read-only
  // dead end.
  const openThread2 = await page.$('[data-testid^="button-open-thread-"]');
  if (openThread2) {
    await openThread2.evaluate((b: any) => b.click());
    await new Promise((r) => setTimeout(r, 2500));
    await page.evaluate(() => {
      const rows = document.querySelectorAll('[data-testid="panel-thread"] .group');
      (rows[0] as HTMLElement | undefined)?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const acts = await page.evaluate(() => ({
      react: !!document.querySelector('[data-testid^="thread-react-"]'),
      forward: !!document.querySelector('[data-testid^="thread-forward-"]'),
      staleCopy: /Replies also appear in the channel/.test(document.body.innerText),
    }));
    ok("🔴 thread messages can be reacted to", acts.react);
    ok("🔴 and forwarded", acts.forward);
    ok("the footnote no longer claims replies appear in the channel", !acts.staleCopy);
    await page.screenshot({ path: join(outDir, "thread-actions.png") });
    await page.keyboard.press("Escape");
  } else {
    ok("a thread exists to test actions in", false);
  }

  // ── Full screen for attachments, and mark-as-unread ────────────────────────
  await page.goto(`${BASE}/admin/chat?c=${channelId}`, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3000));

  // 🔴 Mark unread must SURVIVE — the auto-read effect fires whenever the newest
  // message is on screen, so the real test is whether it sticks, not whether the
  // request returned 200.
  const before = await (await fetch(`${BASE}/api/admin/chat/sync`, {
    headers: { Cookie: cookie, "X-Workspace-Slug": "christchurch-united" } })).json();
  const wasUnread = (before.channels || []).find((c: any) => c.id === channelId)?.unreadCount ?? 0;

  const kebab = await page.$('[data-testid="button-channel-menu"]');
  ok("the conversation menu is reachable", !!kebab);
  if (kebab) await kebab.evaluate((b: any) => b.click());
  await new Promise((r) => setTimeout(r, 1000));
  const item = await page.$('[data-testid="menu-mark-unread"]');
  ok("a 'Mark as unread' option is offered", !!item);
  if (item) {
    await item.evaluate((b: any) => b.click());
    await new Promise((r) => setTimeout(r, 3500));
    const after = await (await fetch(`${BASE}/api/admin/chat/sync`, {
      headers: { Cookie: cookie, "X-Workspace-Slug": "christchurch-united" } })).json();
    const nowUnread = (after.channels || []).find((c: any) => c.id === channelId)?.unreadCount ?? 0;
    ok("🔴 and it STAYS unread (the auto-read effect doesn't undo it)",
       nowUnread > 0, `unread ${wasUnread} → ${nowUnread}`);
    ok("and it closes the conversation, which is what makes that possible",
       !(await page.evaluate(() => !!document.querySelector('[data-testid="composer-dropzone"]'))));
  }

  // Attachment full screen — the lightbox capped at 78vh and left a screenshot
  // of a screenshot unreadable.
  await page.goto(`${BASE}/admin/chat?c=${channelId}`, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));

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
  for (const id of extraUsers) {
    await pool.query(`DELETE FROM staff_chat_presence WHERE user_id=$1`, [id]);
    await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
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
