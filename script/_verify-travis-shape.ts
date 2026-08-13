/**
 * Reproduces Travis's exact account shape and clicks through the CRM the way he
 * describes: open Contacts, click a person, see what follows.
 *
 * His shape matters — he is a full admin (tabs NULL) in four workspaces but a
 * team_member with a narrow tab list in two others, so "does it work" has a
 * different answer depending on which workspace he is standing in.
 */
import "dotenv/config";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const BASE = "https://app.usg.co.nz";
const EMAIL = "travis-shape-probe@example.com";
const PASSWORD = crypto.randomBytes(24).toString("base64url");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;
const ok = (c: boolean, l: string, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "ok  " : "FAIL"} ${l}${d ? ` — ${d}` : ""}`); };

let userId: number | null = null;
try {
  // Copy Travis's memberships verbatim rather than approximating them.
  const shape = await pool.query(
    `SELECT organization_id, role, tabs, hiring_brands FROM user_organizations
     WHERE user_id = (SELECT id FROM users WHERE email='travis@cufc.co.nz') ORDER BY organization_id`);
  const hash = await bcrypt.hash(PASSWORD, 10);
  const ins = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Travis','Shape Probe',$2,'admin',true) RETURNING id`, [EMAIL, hash]);
  userId = ins.rows[0].id;
  for (const m of shape.rows) {
    // tabs/hiring_brands are jsonb — node-pg would serialise a JS array as a
    // Postgres array literal, so hand them over as JSON text and cast.
    await pool.query(
      `INSERT INTO user_organizations (user_id, organization_id, role, tabs, hiring_brands)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`,
      [userId, m.organization_id, m.role,
       m.tabs === null ? null : JSON.stringify(m.tabs),
       m.hiring_brands === null ? null : JSON.stringify(m.hiring_brands)]);
  }
  console.log(`\nthrowaway #${userId} with Travis's ${shape.rows.length} memberships\n`);

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  ok(login.ok, "signs in");
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const get = async (path: string, slug: string) => {
    const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie, "X-Workspace-Slug": slug } });
    return { status: r.status, body: await r.text().catch(() => "") };
  };

  // Every workspace he belongs to, against both CRM endpoints.
  for (const m of shape.rows) {
    const slugRow = await pool.query(`SELECT slug FROM organizations WHERE id=$1`, [m.organization_id]);
    const slug = slugRow.rows[0].slug;
    const list = await get("/api/admin/people?q=&filter=all&limit=5", slug);
    const detail = await get("/api/admin/people/contact-32753", slug);
    const admin = m.role === "admin" || m.role === "manager";
    const tabAllowed = admin || (Array.isArray(m.tabs) && m.tabs.includes("contacts"));
    const label = `${slug} (${m.role}, tabs=${JSON.stringify(m.tabs)})`;
    if (tabAllowed) {
      ok(list.status === 200 && detail.status === 200,
         `${label} — CRM list + detail both load`, `list ${list.status}, detail ${detail.status}`);
      if (detail.status === 200) {
        const j = JSON.parse(detail.body);
        ok(!!j.person && !!j.history, `${label} — detail carries person + history`,
           `${j.history?.programmes?.length ?? 0} programmes`);
      }
    } else {
      ok(detail.status === 403, `${label} — correctly has no CRM access`, `HTTP ${detail.status}`);
    }
  }
} finally {
  if (userId) {
    await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id=$1`, [userId]);
    console.log(`\ncleaned up throwaway #${userId}`);
  }
  await pool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
