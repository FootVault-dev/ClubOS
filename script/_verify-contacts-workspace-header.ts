// Prove why Olga and Travis see an empty Contacts tab — on LIVE PRODUCTION.
//
// The theory: /api/admin/people is gated by requireTab("contacts"), which 400s
// when the X-Workspace-Slug header is absent. A super_admin never reaches that
// check (auth.ts returns at the role test one line earlier), so the page works
// perfectly for Daniel and is blank for everyone else. The Contacts page calls
// the endpoint with a hand-rolled fetch() that never sends the header.
//
// Creates a throwaway account with Olga's EXACT membership shape — global role
// 'admin', member of christchurch-united as 'admin' with tabs NULL — signs in
// against app.usg.co.nz, and calls the endpoint both ways. Read-only: every
// request is a GET, and the account is deleted in a finally block so a crash
// cannot leave a live login behind.
import "dotenv/config";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const BASE = "https://app.usg.co.nz";
const EMAIL = "contacts-header-probe@example.com"; // RFC 2606, undeliverable
const PASSWORD = crypto.randomBytes(24).toString("base64url");
const WORKSPACE = "christchurch-united";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;
const ok = (c: boolean, label: string, extra = "") => {
  console.log(`${c ? "  ok  " : " FAIL "} ${label}${extra ? " — " + extra : ""}`);
  c ? pass++ : fail++;
};

let userId: number | null = null;

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

async function getPeople(cookie: string, withHeader: boolean) {
  const res = await fetch(`${BASE}/api/admin/people?q=&filter=all&limit=5`, {
    headers: {
      Cookie: cookie,
      ...(withHeader ? { "X-Workspace-Slug": WORKSPACE } : {}),
    },
  });
  const text = await res.text().catch(() => "");
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body, text: text.slice(0, 200) };
}

try {
  // ── A throwaway account shaped exactly like Olga's ─────────────────────────
  const hash = await bcrypt.hash(PASSWORD, 10);
  const ins = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Contacts','Header Probe',$2,'admin',true) RETURNING id`,
    [EMAIL, hash],
  );
  userId = ins.rows[0].id;

  const org = await pool.query(`SELECT id FROM organizations WHERE slug = $1`, [WORKSPACE]);
  if (!org.rows.length) throw new Error(`workspace ${WORKSPACE} not found`);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs)
     VALUES ($1, $2, 'admin', NULL)`,
    [userId, org.rows[0].id],
  );
  console.log(`\nthrowaway user #${userId} — global 'admin', ${WORKSPACE} 'admin', tabs NULL (Olga's shape)\n`);

  const cookie = await login();
  ok(!!cookie, "signs in to production");
  if (!cookie) throw new Error("login failed — cannot probe");

  // ── The bug ────────────────────────────────────────────────────────────────
  const without = await getPeople(cookie, false);
  console.log(`\n  no X-Workspace-Slug  → HTTP ${without.status}  ${without.text}`);
  ok(without.status !== 200, "WITHOUT the header the endpoint refuses (this is the blank page)");

  // ── The fix ────────────────────────────────────────────────────────────────
  const withH = await getPeople(cookie, true);
  const n = withH.body?.people?.length ?? 0;
  const total = withH.body?.total ?? 0;
  console.log(`  with X-Workspace-Slug → HTTP ${withH.status}  ${n} people, total ${total}\n`);
  ok(withH.status === 200, "WITH the header the same account is allowed through");
  ok(n > 0 && total > 0, "and it returns real people", `${total} total`);

  // Distinguish a header problem from a permissions problem. If the account is
  // genuinely allowed once the header is present, Olga's access was never the
  // issue and nothing about her permissions needs changing.
  ok(
    without.status !== 200 && withH.status === 200,
    "→ the ONLY difference is the header, so this is a client bug, not her access",
  );
} finally {
  if (userId) {
    await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    console.log(`cleaned up throwaway user #${userId}`);
  }
  await pool.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
