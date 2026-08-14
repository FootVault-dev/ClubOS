/**
 * Staff Chat v2 — threads, forwarding, files & links — proven on LIVE PRODUCTION.
 *
 * The security question for all three is the same: can somebody read a private
 * channel sideways? A thread reader, a forward target and a file browser are
 * each a way in if the visibility check is skipped, so every one is tested with
 * a real outsider account.
 *
 *   npx tsx --env-file=.env script/_verify-chat-v2-live.ts
 */
import "dotenv/config";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const BASE = "https://app.usg.co.nz";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;
const ok = (c: boolean, l: string, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "ok  " : "FAIL"} ${l}${d ? " — " + d : ""}`); };

const users: number[] = [];
const channels: number[] = [];

async function mkUser(name: string) {
  const email = `chatv2-${crypto.randomBytes(5).toString("hex")}@example.com`;
  const password = crypto.randomBytes(16).toString("base64url");
  const r = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,$2,'ChatProbe',$3,'admin',true) RETURNING id`,
    [email, name, await bcrypt.hash(password, 10)]);
  const id = r.rows[0].id; users.push(id);
  await pool.query(`INSERT INTO user_organizations (user_id, organization_id, role, tabs)
    VALUES ($1,1,'admin',NULL)`, [id]);
  const lr = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }) });
  return { id, cookie: (lr.headers.get("set-cookie") || "").split(";")[0] };
}
/** A new message is 201; a retry of the same client id is 200. Both are sent. */
const sentOk = (s: number) => s === 200 || s === 201;
const call = (cookie: string, path: string, method = "GET", body?: any) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { Cookie: cookie, "X-Workspace-Slug": "christchurch-united",
               ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });

async function mkChannel(name: string, isPrivate: boolean, ownerId: number) {
  const r = await pool.query(
    `INSERT INTO staff_channels (name, kind, is_private, created_by)
     VALUES ($1,'channel',$2,$3) RETURNING id`, [name, isPrivate, ownerId]);
  const id = r.rows[0].id; channels.push(id);
  await pool.query(`INSERT INTO staff_channel_members (channel_id, user_id) VALUES ($1,$2)`, [id, ownerId]);
  return id;
}

try {
  const alice = await mkUser("Alice");
  const outsider = await mkUser("Outsider");
  ok(!!alice.cookie && !!outsider.cookie, "two accounts sign in");

  const priv = await mkChannel(`zz-probe-private-${crypto.randomBytes(3).toString("hex")}`, true, alice.id);
  const pub = await mkChannel(`zz-probe-public-${crypto.randomBytes(3).toString("hex")}`, false, alice.id);
  console.log(`\nprivate #${priv} · public #${pub}\n`);

  // ── Threads ────────────────────────────────────────────────────────────────
  console.log("1. Threads");
  const rootRes = await call(alice.cookie, `/api/admin/chat/channels/${priv}/messages`, "POST",
    { body: "Week 2 field is not ready — moving to the centre. https://example.com/bus-times" });
  ok(sentOk(rootRes.status), "root message posts", `HTTP ${rootRes.status}`);
  const root = await rootRes.json();
  const rootId = root?.id ?? root?.message?.id;

  const replyRes = await call(alice.cookie, `/api/admin/chat/channels/${priv}/messages`, "POST",
    { body: "Bus leaves 09:30.", parentMessageId: rootId });
  ok(sentOk(replyRes.status), "a reply posts against the root", `HTTP ${replyRes.status}`);
  const reply = await replyRes.json();
  const replyId = reply?.id ?? reply?.message?.id;

  // 🔴 One level only.
  const nested = await call(alice.cookie, `/api/admin/chat/channels/${priv}/messages`, "POST",
    { body: "reply to a reply", parentMessageId: replyId });
  ok(nested.status === 400, "🔴 a reply to a reply is refused (one level only)", `HTTP ${nested.status}`);

  // 🔴 Parent must be in the same channel.
  const crossRoot = await call(alice.cookie, `/api/admin/chat/channels/${pub}/messages`, "POST",
    { body: "elsewhere" });
  const crossJson = await crossRoot.json();
  const crossId = crossJson?.id ?? crossJson?.message?.id ?? null;
  ok(!!crossId, "a message in the other channel exists to test against", String(crossId));
  const cross = await call(alice.cookie, `/api/admin/chat/channels/${priv}/messages`, "POST",
    { body: "hijack", parentMessageId: crossId });
  ok(cross.status === 400, "🔴 you cannot hang a reply off a message in another channel", `HTTP ${cross.status}`);

  const thread = await call(alice.cookie, `/api/admin/chat/messages/${rootId}/thread`);
  const tj = await thread.json();
  ok(thread.status === 200 && tj.replyCount === 1, "the thread reads back root + replies",
     `${tj.replyCount} replies`);
  const fromReply = await (await call(alice.cookie, `/api/admin/chat/messages/${replyId}/thread`)).json();
  ok(fromReply.root?.id === rootId, "opening a thread from a REPLY resolves to the root");

  // Reply count is on the channel list, so the channel can show "N replies".
  const list = await (await call(alice.cookie, `/api/admin/chat/channels/${priv}/messages`)).json();
  const rootInList = (list.messages || []).find((m: any) => m.id === rootId);
  const replyInList = (list.messages || []).find((m: any) => m.id === replyId);
  ok(rootInList?.replyCount === 1, "the root carries a reply count in the channel list");
  ok(!!replyInList, "🔴 and the reply is STILL VISIBLE in the channel, not hidden in a side-room");

  // 🔴 An outsider must not read a private thread.
  const stolen = await call(outsider.cookie, `/api/admin/chat/messages/${rootId}/thread`);
  ok(stolen.status === 404, "🔴 an outsider cannot read a private channel's thread", `HTTP ${stolen.status}`);

  // ── Forwarding ─────────────────────────────────────────────────────────────
  console.log("\n2. Forwarding");
  const fwd = await call(alice.cookie, `/api/admin/chat/messages/${rootId}/forward`, "POST",
    { channelIds: [pub], comment: "FYI" });
  const fj = await fwd.json();
  ok(fwd.status === 200 && fj.forwardedTo?.includes(pub), "a message forwards into another channel");

  const pubList = await (await call(alice.cookie, `/api/admin/chat/channels/${pub}/messages`)).json();
  const forwarded = (pubList.messages || []).find((m: any) => m.forwardedFrom);
  ok(!!forwarded, "the forward carries provenance, not a bare copy");
  ok(forwarded?.forwardedFrom?.authorName?.includes("Alice"),
     "and names who originally said it", forwarded?.forwardedFrom?.authorName);

  // 🔴 An outsider cannot forward OUT of a private channel they can't read.
  const leak = await call(outsider.cookie, `/api/admin/chat/messages/${rootId}/forward`, "POST",
    { channelIds: [pub] });
  ok(leak.status === 404, "🔴 an outsider cannot forward a message they cannot read", `HTTP ${leak.status}`);

  // 🔴 And cannot forward INTO a private channel they are not in.
  const intoPriv = await call(outsider.cookie, `/api/admin/chat/messages/${crossId}/forward`, "POST",
    { channelIds: [priv] });
  const ipj = await intoPriv.json().catch(() => ({}));
  ok(intoPriv.status === 200 && !(ipj.forwardedTo || []).includes(priv),
     "🔴 and cannot forward INTO a private channel they are not a member of",
     `refused: ${JSON.stringify(ipj.refused || [])}`);

  // ── Files & links ──────────────────────────────────────────────────────────
  console.log("\n3. Files & links");
  const files = await (await call(alice.cookie, "/api/admin/chat/files")).json();
  const mine = (files.items || []).filter((i: any) => i.channelId === priv);
  ok(mine.some((i: any) => i.type === "link" && i.url.includes("example.com")),
     "a link pasted in a message is indexed and findable", `${files.items?.length} items`);

  const searched = await (await call(alice.cookie, "/api/admin/chat/files?q=bus-times")).json();
  ok((searched.items || []).some((i: any) => i.url?.includes("bus-times")), "and is searchable by text");

  const outsiderFiles = await (await call(outsider.cookie, "/api/admin/chat/files")).json();
  ok(!(outsiderFiles.items || []).some((i: any) => i.channelId === priv),
     "🔴 an outsider never sees a private channel's files or links");
} finally {
  for (const id of channels) {
    await pool.query(`DELETE FROM staff_message_links WHERE channel_id=$1`, [id]);
    await pool.query(`DELETE FROM staff_messages WHERE channel_id=$1`, [id]);
    await pool.query(`DELETE FROM staff_channel_members WHERE channel_id=$1`, [id]);
    await pool.query(`DELETE FROM staff_channels WHERE id=$1`, [id]);
  }
  for (const id of users) {
    await pool.query(`DELETE FROM staff_chat_presence WHERE user_id=$1`, [id]);
    await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`, [id]);
    await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
  }
  console.log(`\ncleaned up ${users.length} accounts, ${channels.length} channels`);
  await pool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
