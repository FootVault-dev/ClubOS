// Mint a throwaway logged-in session for ui-preflight against the LOCAL server.
// 🔴 Needs a real user_organizations row: the SPA's workspace switcher is fed
// from the server, and with no membership every workspace-scoped route renders
// 404 — which screenshots as a routing bug rather than a missing precondition.
import pg from "pg"; import bcrypt from "bcryptjs";
const BASE = process.env.VERIFY_BASE || "http://localhost:5099";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const email = `preflight-${Date.now()}@example.invalid`, pw = "Pre!12345";
const u = await p.query(
  `INSERT INTO users (email,password,first_name,last_name,role,active)
   VALUES ($1,$2,'Pre','Flight','super_admin',true) RETURNING id`,
  [email, await bcrypt.hash(pw, 10)],
);
const userId = u.rows[0].id;
// United Prints (org 8) — where the Warehouse tab lives.
await p.query(`INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, 8, 'admin')`, [userId]);
const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password: pw }),
});
console.log(JSON.stringify({ cookie: (login.headers.get("set-cookie") ?? "").split(";")[0], userId }));
await p.end();
