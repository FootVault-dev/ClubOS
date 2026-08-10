// Prove the refund permission gate on LIVE PRODUCTION, end to end.
//
// Creates a throwaway staff account, signs in as it against app.usg.co.nz, and
// checks the refund endpoint's behaviour with and without the permission — then
// deletes the account in a finally block so a mid-run crash cannot leave a live
// login behind.
//
// 🔴 No money can move: every call targets registration id 999999, which does
// not exist. A request that PASSES the gate therefore fails at "not found",
// which is exactly the signal we want — 403 means blocked, 404 means allowed
// through. Never point this at a real registration id.
import "dotenv/config";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const BASE = "https://app.usg.co.nz";
const EMAIL = `refund-gate-probe@example.com`; // RFC 2606, undeliverable
const PASSWORD = crypto.randomBytes(24).toString("base64url");
const NONEXISTENT_REG = 999999;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;
const ok = (c: boolean, label: string, extra = "") => {
  console.log(`${c ? "  ok  " : " FAIL "} ${label}${extra ? " — " + extra : ""}`);
  c ? pass++ : fail++;
};

let userId: number | null = null;

async function setPermission(v: boolean) {
  await pool.query(`UPDATE users SET can_issue_refunds = $1 WHERE id = $2`, [v, userId]);
}

async function login(): Promise<string | null> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) return null;
  const raw = res.headers.get("set-cookie");
  return raw ? raw.split(";")[0] : null;
}

async function attemptRefund(cookie: string) {
  const res = await fetch(`${BASE}/api/admin/registrations/${NONEXISTENT_REG}/refund`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ reason: "gate probe — must never reach Stripe" }),
  });
  return { status: res.status, body: await res.text().catch(() => "") };
}

try {
  // ── Create the throwaway account ───────────────────────────────────────────
  const hash = await bcrypt.hash(PASSWORD, 10);
  const ins = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active, can_issue_refunds)
     VALUES ($1,'Refund','Gate Probe',$2,'coach',true,false) RETURNING id`,
    [EMAIL, hash],
  );
  userId = ins.rows[0].id;
  console.log(`\nThrowaway user #${userId} created (role=coach, can_issue_refunds=false)\n`);

  // ── 1. Unauthenticated ─────────────────────────────────────────────────────
  const anon = await fetch(`${BASE}/api/admin/registrations/${NONEXISTENT_REG}/refund`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  ok(anon.status === 401, "unauthenticated refund is 401", `got ${anon.status}`);

  // ── 2. Logged in, permission OFF → must be 403 ─────────────────────────────
  const cookie = await login();
  ok(!!cookie, "throwaway account can sign in");
  if (!cookie) throw new Error("no session cookie — cannot continue");

  const denied = await attemptRefund(cookie);
  ok(denied.status === 403, "logged-in staff WITHOUT permission is 403", `got ${denied.status}`);
  ok(
    /permission to issue refunds/i.test(denied.body),
    "403 explains how to get access rather than just saying no",
    denied.body.slice(0, 90),
  );

  // Confirm the client-facing flag agrees with the server.
  const me1 = await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })).json();
  ok(me1.canIssueRefunds === false, "/api/auth/me reports canIssueRefunds=false", String(me1.canIssueRefunds));

  // ── 3. Grant it → must now pass the gate and fail on the missing record ────
  await setPermission(true);
  const allowed = await attemptRefund(cookie);
  ok(
    allowed.status === 404,
    "WITH permission the gate is passed (404 = reached the handler, no such registration)",
    `got ${allowed.status}`,
  );
  ok(
    !/permission/i.test(allowed.body),
    "the 404 is a not-found, not a permission error",
    allowed.body.slice(0, 90),
  );

  const me2 = await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })).json();
  ok(me2.canIssueRefunds === true, "/api/auth/me reports canIssueRefunds=true after grant", String(me2.canIssueRefunds));

  // ── 4. Revoke → the SAME live session must lose access immediately ─────────
  // This is the point of re-reading the user per request instead of trusting
  // the session: a revoke has to bite now, not at their next logout.
  await setPermission(false);
  const revoked = await attemptRefund(cookie);
  ok(revoked.status === 403, "revoke takes effect on the existing session immediately", `got ${revoked.status}`);
} finally {
  if (userId) {
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    console.log(`\nThrowaway user #${userId} deleted.`);
  }
  const leftovers = await pool.query(`SELECT count(*)::int n FROM users WHERE email = $1`, [EMAIL]);
  console.log(`Leftover probe accounts: ${leftovers.rows[0].n} (must be 0)`);
  await pool.end();
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
