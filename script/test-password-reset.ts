// End-to-end test for the self-service password-reset flow.
// Requires the server running locally (PORT 5050). Creates a throwaway user,
// exercises every endpoint + edge case, then deletes the user.
//   PORT 5050 server up, then: npx tsx script/test-password-reset.ts
import "dotenv/config";
import { Pool } from "pg";
import crypto from "crypto";

const BASE = "http://localhost:5050";
const TEST_EMAIL = `pwreset-test-${Date.now()}@example.invalid`;
const OLD_PW = "oldpass-aaa-111";
const NEW_PW = "brandnewpass-9";
const sha256Hex = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const J = { "Content-Type": "application/json" };

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const results: Array<[string, boolean, string]> = [];
  const check = (name: string, pass: boolean, detail = "") => {
    results.push([name, pass, detail]);
    console.log(`${pass ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  };

  let userId: number | null = null;
  try {
    const bcrypt = (await import("bcryptjs")).default;
    const oldHash = await bcrypt.hash(OLD_PW, 10);
    const ins = await pool.query(
      `INSERT INTO users (email, first_name, last_name, password, role, active)
       VALUES ($1,'Test','Reset',$2,'team_member',true) RETURNING id`,
      [TEST_EMAIL, oldHash]
    );
    userId = ins.rows[0].id;
    console.log("→ test user", userId, TEST_EMAIL, "\n");

    // 1. unknown email → generic 200, never reveals non-existence
    const r1 = await fetch(`${BASE}/api/auth/forgot-password`, { method: "POST", headers: J, body: JSON.stringify({ email: `nobody-${Date.now()}@example.invalid` }) });
    check("forgot-password unknown email → 200 (no enumeration)", r1.status === 200, `status=${r1.status}`);

    // 2. real email → 200 + exactly one usable token row
    const r2 = await fetch(`${BASE}/api/auth/forgot-password`, { method: "POST", headers: J, body: JSON.stringify({ email: TEST_EMAIL }) });
    const t2 = await pool.query(`SELECT id, expires_at, used_at FROM password_reset_tokens WHERE user_id=$1`, [userId]);
    check("forgot-password known email → 200", r2.status === 200, `status=${r2.status}`);
    check("created exactly one token row", t2.rows.length === 1, `rows=${t2.rows.length}`);
    check("token unused + future expiry", t2.rows.length === 1 && !t2.rows[0].used_at && new Date(t2.rows[0].expires_at) > new Date());

    // 3. throttle — immediate second request makes no new token
    const r3 = await fetch(`${BASE}/api/auth/forgot-password`, { method: "POST", headers: J, body: JSON.stringify({ email: TEST_EMAIL }) });
    const t3 = await pool.query(`SELECT count(*)::int n FROM password_reset_tokens WHERE user_id=$1`, [userId]);
    check("throttle: rapid 2nd request adds no token", r3.status === 200 && t3.rows[0].n === 1, `count=${t3.rows[0].n}`);

    // 4. consume path — self-mint a valid token (same scheme as the server)
    const raw = crypto.randomBytes(32).toString("base64url");
    await pool.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`, [userId, sha256Hex(raw), new Date(Date.now() + 3600_000)]);

    const g1 = await fetch(`${BASE}/api/auth/reset-password/${encodeURIComponent(raw)}`);
    const gj = await g1.json();
    check("validate token → valid + greets correct user", g1.status === 200 && gj.valid === true && gj.email === TEST_EMAIL, JSON.stringify(gj));

    const p1 = await fetch(`${BASE}/api/auth/reset-password`, { method: "POST", headers: J, body: JSON.stringify({ token: raw, password: NEW_PW }) });
    const pj = await p1.json();
    check("reset-password → 200, ok, sets session cookie", p1.status === 200 && pj.ok === true && !!p1.headers.get("set-cookie"), `status=${p1.status}`);

    const l1 = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: J, body: JSON.stringify({ email: TEST_EMAIL, password: NEW_PW }) });
    check("login with NEW password works", l1.status === 200, `status=${l1.status}`);

    const l2 = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: J, body: JSON.stringify({ email: TEST_EMAIL, password: OLD_PW }) });
    check("login with OLD password rejected", l2.status === 401, `status=${l2.status}`);

    const g2 = await fetch(`${BASE}/api/auth/reset-password/${encodeURIComponent(raw)}`);
    check("used token no longer validates", g2.status === 400, `status=${g2.status}`);

    const p2 = await fetch(`${BASE}/api/auth/reset-password`, { method: "POST", headers: J, body: JSON.stringify({ token: raw, password: "anotherpw123" }) });
    check("used token cannot be replayed", p2.status === 400, `status=${p2.status}`);

    const t5 = await pool.query(`SELECT count(*)::int n FROM password_reset_tokens WHERE user_id=$1 AND used_at IS NULL`, [userId]);
    check("reset invalidated ALL outstanding tokens", t5.rows[0].n === 0, `still-unused=${t5.rows[0].n}`);

    // 5. expired token rejected
    const rawE = crypto.randomBytes(32).toString("base64url");
    await pool.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`, [userId, sha256Hex(rawE), new Date(Date.now() - 1000)]);
    const g3 = await fetch(`${BASE}/api/auth/reset-password/${encodeURIComponent(rawE)}`);
    check("expired token rejected", g3.status === 400, `status=${g3.status}`);

    // 6. short password rejected (fresh valid token)
    const rawS = crypto.randomBytes(32).toString("base64url");
    await pool.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`, [userId, sha256Hex(rawS), new Date(Date.now() + 3600_000)]);
    const p3 = await fetch(`${BASE}/api/auth/reset-password`, { method: "POST", headers: J, body: JSON.stringify({ token: rawS, password: "short" }) });
    check("password < 8 chars rejected", p3.status === 400, `status=${p3.status}`);

    // 7. garbage token rejected
    const g4 = await fetch(`${BASE}/api/auth/reset-password/${"x".repeat(43)}`);
    check("garbage token rejected", g4.status === 400, `status=${g4.status}`);

    // 8. SPA serves both public routes
    const s1 = await fetch(`${BASE}/forgot-password`);
    const s1t = await s1.text();
    check("SPA serves /forgot-password", s1.status === 200 && s1t.includes('id="root"'), `status=${s1.status}`);
    const s2 = await fetch(`${BASE}/reset-password?token=abc`);
    check("SPA serves /reset-password", s2.status === 200, `status=${s2.status}`);
  } finally {
    if (userId) {
      await pool.query(`DELETE FROM users WHERE id=$1`, [userId]); // cascade removes tokens
      console.log("\n→ cleaned up test user", userId);
    }
    await pool.end();
  }

  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log("FAILED:", failed.map((f) => f[0])); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
