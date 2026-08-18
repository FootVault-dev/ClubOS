/**
 * Prove the DEPLOYED server honours locked-tab grants — and refuses without one.
 *
 *   npx tsx --env-file=.env script/_verify-unlocked-tabs-live.ts
 *
 * The unit check (script/_verify-unlocked-tabs.ts) proves the decision function
 * is right about real rows. This proves the running production server actually
 * asks it, over HTTP, through requireTab. Two throwaway accounts are built to
 * mirror the exact membership shapes that matter — a USG admin WITHOUT a grant
 * (the six people who must stay out) and a team_member WITH one (Travis) — and
 * are deleted afterwards. Ryan's and Travis's own accounts are never touched.
 */
import pg from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const BASE = "https://app.usg.co.nz";
const WS = "united-sports-group";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); };

const made: number[] = [];

async function mkUser(globalRole: string, wsRole: string, tabs: string[] | null, unlocked: string[] | null) {
  const email = `tabprobe-${crypto.randomBytes(5).toString("hex")}@example.com`;
  const password = crypto.randomBytes(16).toString("base64url");
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Tab','Probe',$2,$3,true) RETURNING id`, [email, hash, globalRole]);
  const id = r.rows[0].id; made.push(id);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs, unlocked_tabs)
     VALUES ($1, 7, $2, $3::jsonb, $4::jsonb)`,
    [id, wsRole, tabs === null ? null : JSON.stringify(tabs), unlocked === null ? null : JSON.stringify(unlocked)]);
  return { id, email, password };
}

async function login(email: string, password: string) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(`login failed ${r.status}`);
  return (r.headers.get("set-cookie") || "").split(";")[0];
}

const status = async (cookie: string, path: string) => {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie, "X-Workspace-Slug": WS } });
  console.log(`      ${path} → ${r.status}`);
  return r.status;
};

try {
  // 1. A workspace ADMIN with no grant — the six real people this protects.
  const noGrant = await mkUser("team_member", "admin", null, null);
  const c1 = await login(noGrant.email, noGrant.password);
  ok("a USG admin with NO grant is refused Vehicles", (await status(c1, "/api/admin/vehicles")) === 403);
  ok("…and still reaches an unlocked tab they should have",
     (await status(c1, "/api/admin/sponsorship/deals?organizationId=7")) === 200);

  // 2. A team_member WITH a grant — Travis's exact shape.
  const granted = await mkUser("team_member", "team_member", ["calendar"], ["vehicles"]);
  const c2 = await login(granted.email, granted.password);
  ok("a team_member WITH the grant reaches Vehicles", (await status(c2, "/api/admin/vehicles")) === 200);
  ok("🔴 …and the grant opened ONE tab, not the locked set",
     (await status(c2, "/api/admin/budget/cost-centres")) === 403);
  ok("…and did not hand them an unrelated unlocked tab",
     (await status(c2, "/api/admin/sponsorship/deals?organizationId=7")) === 403);

  // 3. The stale-grant trap: "budget" sitting in `tabs` must stay inert.
  const stale = await mkUser("team_member", "admin", ["budget"], null);
  const c3 = await login(stale.email, stale.password);
  ok("🔴 a membership carrying tabs:[\"budget\"] still cannot reach Budget",
     (await status(c3, "/api/admin/budget/cost-centres")) === 403, "Dima's shape");

  // 4. Revoking bites on the next request, not the next login.
  await pool.query(`UPDATE user_organizations SET unlocked_tabs = '[]'::jsonb WHERE user_id = $1`, [granted.id]);
  ok("revoking a grant takes effect on the SAME session", (await status(c2, "/api/admin/vehicles")) === 403);

  // 5. The real two, through the database the server reads.
  const real = await pool.query(
    `select u.email, uo.unlocked_tabs from user_organizations uo
       join users u on u.id = uo.user_id join organizations o on o.id = uo.organization_id
      where o.slug = $1 and u.email in ('ryan@cufc.co.nz','travis@cufc.co.nz')`, [WS]);
  ok("Ryan and Travis both hold the live grant", real.rowCount === 2 &&
     real.rows.every((r: any) => (r.unlocked_tabs as string[])?.includes("vehicles")),
     real.rows.map((r: any) => `${r.email}=${JSON.stringify(r.unlocked_tabs)}`).join(" "));

  const total = await pool.query(
    `select count(*)::int n from user_organizations where unlocked_tabs is not null and jsonb_array_length(unlocked_tabs) > 0`);
  ok("no grant exists anywhere beyond those two", total.rows[0].n === 2, `${total.rows[0].n} found`);
} finally {
  for (const id of made) {
    await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`, [id]);
    await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
  }
  console.log(`  cleaned up ${made.length} probe accounts`);
  await pool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
