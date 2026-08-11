// Mint (or destroy) a throwaway super-admin session so a login-gated ClubOS
// page can be screenshotted by ui_preflight.
//
//   npx tsx --env-file=.env script/_preflight-session.ts create   → prints cookie
//   npx tsx --env-file=.env script/_preflight-session.ts destroy
//
//   PREFLIGHT_BASE=http://localhost:5099 …            → drive a local server
//
// The account exists for the length of one screenshot run and is deleted after.
//
// 🔴 It is given a real user_organizations row as well as the super_admin role.
// The SPA's workspace switcher is fed from the server, and with no membership
// `currentOrg` stays null — so every workspace-scoped route (the whole
// Warehouse, Prints, MFL and CIC sections) renders a tidy 404 that screenshots
// as a routing bug rather than a missing precondition. Cost a debugging cycle
// on 2026-08-10.
//
// Pair with UI_PREFLIGHT_LOCALSTORAGE='{"clubos_workspace":"<slug>"}' so the
// client sends the matching X-Workspace-Slug header.
import "dotenv/config";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

const BASE = process.env.PREFLIGHT_BASE || "https://app.usg.co.nz";
const EMAIL = "ui-preflight-probe@example.com"; // RFC 2606, undeliverable
const PASSWORD = "Pf-" + Buffer.from(EMAIL).toString("base64url") + "-2026";
// Which workspaces the probe belongs to. United Prints (8) carries Warehouse;
// CUFC (1) carries Registrations. Membership is cheap and the account is
// deleted straight after, so cover both rather than making the caller choose.
const ORG_IDS = (process.env.PREFLIGHT_ORG_IDS ?? "8,1")
  .split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const mode = process.argv[2];

/** Memberships cascade off the user row in some environments and not others —
 *  clear them explicitly so a re-run never trips the (user, org) unique index. */
async function purge() {
  await pool.query(
    `DELETE FROM user_organizations WHERE user_id IN (SELECT id FROM users WHERE email = $1)`, [EMAIL]);
  return pool.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
}

if (mode === "destroy") {
  const r = await purge();
  console.error(`deleted ${r.rowCount} probe account(s)`);
  await pool.end();
  process.exit(0);
}

await purge();
const hash = await bcrypt.hash(PASSWORD, 10);
const created = await pool.query(
  `INSERT INTO users (email, first_name, last_name, password, role, active, can_issue_refunds)
   VALUES ($1,'UI','Preflight',$2,'super_admin',true,true) RETURNING id`,
  [EMAIL, hash],
);
const userId = created.rows[0].id;
for (const orgId of ORG_IDS) {
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'admin')`,
    [userId, orgId],
  );
}

const res = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const cookie = res.headers.get("set-cookie")?.split(";")[0];
if (!res.ok || !cookie) {
  console.error(`login failed: ${res.status}`);
  await purge();
  await pool.end();
  process.exit(1);
}
console.error(`probe session created (orgs ${ORG_IDS.join(", ")}) against ${BASE}`);
process.stdout.write(cookie); // stdout = the cookie only, for $( ) capture
await pool.end();
