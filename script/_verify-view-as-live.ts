/**
 * Proves the View As security rules on LIVE PRODUCTION.
 *
 * Impersonation is the highest-blast-radius thing in this codebase, so every
 * rule is asserted against the real server rather than read off the source:
 * super-admin only, never onto a peer, read-only while active, audited, and
 * always able to get home.
 *
 *   npx tsx --env-file=.env script/_verify-view-as-live.ts
 */
import "dotenv/config";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const BASE = "https://app.usg.co.nz";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;
const ok = (c: boolean, l: string, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "ok  " : "FAIL"} ${l}${d ? ` — ${d}` : ""}`); };

const made: number[] = [];
async function mkUser(role: string, tabs: any, orgId = 1) {
  const email = `viewas-${crypto.randomBytes(6).toString("hex")}@example.com`;
  const password = crypto.randomBytes(18).toString("base64url");
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'View','As Probe',$2,$3,true) RETURNING id`, [email, hash, role]);
  const id = r.rows[0].id; made.push(id);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs)
     VALUES ($1,$2,'admin',$3::jsonb)`, [id, orgId, tabs === null ? null : JSON.stringify(tabs)]);
  return { id, email, password };
}
async function login(email: string, password: string) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }) });
  return r.ok ? (r.headers.get("set-cookie") || "").split(";")[0] : null;
}
const call = (cookie: string, path: string, method = "GET", body?: any) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { Cookie: cookie, "X-Workspace-Slug": "christchurch-united",
               ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

try {
  const superUser = await mkUser("super_admin", null);
  const staff = await mkUser("admin", null);
  const peer = await mkUser("super_admin", null);
  console.log(`\nsuper #${superUser.id} · staff #${staff.id} · peer super #${peer.id}\n`);

  const sc = await login(superUser.email, superUser.password);
  const stc = await login(staff.email, staff.password);
  ok(!!sc && !!stc, "both accounts sign in");
  if (!sc || !stc) throw new Error("login failed");

  // ── Who may use it ─────────────────────────────────────────────────────────
  console.log("1. Who may use it");
  ok((await call(stc, "/api/admin/view-as/users")).status === 403,
     "a non-super-admin cannot list staff to view as");
  ok((await call(stc, `/api/admin/view-as/${superUser.id}`, "POST")).status === 403,
     "a non-super-admin cannot start a session");
  const list = await call(sc, "/api/admin/view-as/users");
  ok(list.status === 200, "a super admin can list staff");
  const listed = await list.json();
  ok(!(listed.users || []).some((u: any) => u.role === "super_admin"),
     "the list excludes super admins", `${listed.users?.length} staff`);
  ok((await call(sc, `/api/admin/view-as/${peer.id}`, "POST")).status === 403,
     "🔴 cannot view as another super admin");

  // ── Starting ───────────────────────────────────────────────────────────────
  console.log("\n2. Viewing as a staff member");
  const start = await call(sc, `/api/admin/view-as/${staff.id}`, "POST");
  ok(start.status === 200, "starts");
  const me = await (await call(sc, "/api/auth/me")).json();
  ok(me.id === staff.id, "the session now answers as the staff member", `id ${me.id}`);
  ok(me.viewingAs?.target?.id === staff.id && me.viewingAs?.readOnly === true,
     "and reports viewingAs so the banner and the way out can render");

  // ── 🔴 Read-only ───────────────────────────────────────────────────────────
  console.log("\n3. 🔴 Read-only while active");
  ok((await call(sc, "/api/admin/people?q=&filter=all&limit=3")).status === 200,
     "GET still works — looking is the whole feature");
  const write = await call(sc, "/api/auth/me", "PATCH", { firstName: "Hacked" });
  ok(write.status === 403, "a PATCH is refused", `HTTP ${write.status}`);
  const post = await call(sc, "/api/admin/feedback", "POST", { title: "x", body: "x", kind: "bug" });
  ok(post.status === 403, "a POST is refused", `HTTP ${post.status}`);
  const del = await call(sc, "/api/admin/people/contact-32753/guardians/contact-32752", "DELETE");
  ok(del.status === 403, "a DELETE is refused", `HTTP ${del.status}`);
  const nameNow = await pool.query(`SELECT first_name FROM users WHERE id=$1`, [staff.id]);
  ok(nameNow.rows[0].first_name === "View",
     "🔴 and nothing was actually written under the staff member's name",
     nameNow.rows[0].first_name);

  // ── Getting home ───────────────────────────────────────────────────────────
  console.log("\n4. Getting home");
  const stop = await call(sc, "/api/admin/view-as/stop", "POST");
  ok(stop.status === 200, "stop is the one write allowed while viewing", `HTTP ${stop.status}`);
  const back = await (await call(sc, "/api/auth/me")).json();
  ok(back.id === superUser.id, "back to the real account", `id ${back.id}`);
  ok(!back.viewingAs, "banner gone");
  const wroteAfter = await call(sc, "/api/auth/me", "PATCH", { firstName: "Super" });
  ok(wroteAfter.status === 200, "writes work again afterwards", `HTTP ${wroteAfter.status}`);

  // 🔴 The way out must survive a trailing slash too — an exact-match allow-list
  // refused it, and being unable to leave is this feature's worst failure.
  await call(sc, `/api/admin/view-as/${staff.id}`, "POST");
  const slashStop = await call(sc, "/api/admin/view-as/stop/", "POST");
  ok(slashStop.status === 200 || slashStop.status === 404,
     "a trailing slash is not a trap", `HTTP ${slashStop.status}`);
  if (slashStop.status !== 200) await call(sc, "/api/admin/view-as/stop", "POST");
  const home = await (await call(sc, "/api/auth/me")).json();
  ok(home.id === superUser.id, "and we always end up home", `id ${home.id}`);

  // ── Audit ──────────────────────────────────────────────────────────────────
  console.log("\n5. Audit trail");
  const ev = await pool.query(
    `SELECT actor_user_id, target_user_id, started_at, ended_at FROM view_as_events
     WHERE actor_user_id=$1 ORDER BY id DESC LIMIT 1`, [superUser.id]);
  ok(ev.rows.length === 1, "the session was recorded");
  ok(Number(ev.rows[0]?.target_user_id) === staff.id, "against the right target");
  ok(!!ev.rows[0]?.ended_at, "and closed when it stopped");
} finally {
  for (const id of made) {
    await pool.query(`DELETE FROM view_as_events WHERE actor_user_id=$1 OR target_user_id=$1`, [id]);
    await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`, [id]);
    await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
  }
  console.log(`\ncleaned up ${made.length} throwaway accounts`);
  await pool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
