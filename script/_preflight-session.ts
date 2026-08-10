// Mint (or destroy) a throwaway super-admin session against prod so the
// login-gated Registrations page can be screenshotted by ui_preflight.
//
//   npx tsx --env-file=.env script/_preflight-session.ts create   → prints cookie
//   npx tsx --env-file=.env script/_preflight-session.ts destroy
//
// The account exists for the length of one screenshot run and is deleted after.
import "dotenv/config";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

const BASE = "https://app.usg.co.nz";
const EMAIL = "ui-preflight-probe@example.com"; // RFC 2606, undeliverable
const PASSWORD = "Pf-" + Buffer.from(EMAIL).toString("base64url") + "-2026";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const mode = process.argv[2];

if (mode === "destroy") {
  const r = await pool.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
  console.error(`deleted ${r.rowCount} probe account(s)`);
  await pool.end();
  process.exit(0);
}

await pool.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
const hash = await bcrypt.hash(PASSWORD, 10);
await pool.query(
  `INSERT INTO users (email, first_name, last_name, password, role, active, can_issue_refunds)
   VALUES ($1,'UI','Preflight',$2,'super_admin',true,true)`,
  [EMAIL, hash],
);

const res = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const cookie = res.headers.get("set-cookie")?.split(";")[0];
if (!res.ok || !cookie) {
  console.error(`login failed: ${res.status}`);
  await pool.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
  await pool.end();
  process.exit(1);
}
console.error("probe session created");
process.stdout.write(cookie); // stdout = the cookie only, for $( ) capture
await pool.end();
