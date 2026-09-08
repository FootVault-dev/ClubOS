/**
 * _verify-registrations-scope-live.ts — can a staff login see another club's
 * registrations on production?
 *
 * 2026-09-09: an admin whose only membership was Mini Football fetched 567
 * registrations across CUFC and MFL with no X-Workspace-Slug header, and all
 * 524 CUFC rows by naming CUFC in the header. A registration carries a child's
 * name, DOB and medical notes. This creates a throwaway org-3-only admin, logs
 * in like the app does, and asserts the four registration routes fail CLOSED.
 *
 *   npx tsx --env-file=.env script/_verify-registrations-scope-live.ts
 */
import pg from "pg";
import bcrypt from "bcryptjs";

const BASE = process.env.SCOPE_CHECK_BASE || "https://app.usg.co.nz";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const email = `zzscope-${Date.now()}@example.com`, pw = `Probe-${Date.now()}!x`;
let uid = 0, failed = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failed++; console.log(`  FAIL ${m}`); };
const orgsOf = (list: any[]) => [...new Set(list.map((x) => x.program?.organizationId ?? null))].join(",");

try {
  const { rows } = await pool.query(`INSERT INTO users (email,first_name,last_name,password,role,active) VALUES ($1,'Scope','Probe',$2,'admin',true) RETURNING id`, [email, await bcrypt.hash(pw, 10)]);
  uid = rows[0].id;
  await pool.query(`INSERT INTO user_organizations (user_id,organization_id,role,tabs) VALUES ($1,3,'admin',NULL)`, [uid]);
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pw }) });
  if (!login.ok) throw new Error(`login ${login.status}`);
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const get = async (path: string, hdr: Record<string, string> = {}) => {
    const r = await fetch(`${BASE}${path}`, { headers: { cookie, ...hdr } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // 1. No header → only the caller's own workspace(s).
  let r = await get("/api/admin/registrations");
  const list0 = Array.isArray(r.body) ? r.body : [];
  list0.every((x: any) => x.program?.organizationId === 3) ? ok(`no header: ${list0.length} rows, all org 3`) : bad(`no header: ${list0.length} rows across orgs ${orgsOf(list0)}`);

  // 2. Own workspace named → own rows.
  r = await get("/api/admin/registrations", { "x-workspace-slug": "mini-football-leagues" });
  const list1 = Array.isArray(r.body) ? r.body : [];
  list1.every((x: any) => x.program?.organizationId === 3) ? ok(`MFL header: ${list1.length} rows, all org 3`) : bad(`MFL header leaked orgs ${orgsOf(list1)}`);

  // 3. Another club named → nothing.
  r = await get("/api/admin/registrations", { "x-workspace-slug": "christchurch-united" });
  const list2 = Array.isArray(r.body) ? r.body : [];
  list2.length === 0 ? ok("CUFC header as a non-member: 0 rows") : bad(`CUFC header as a non-member returned ${list2.length} rows`);

  // 4. A CUFC registration by id → 404 (and never 200 with a child inside).
  const { rows: cufc } = await pool.query(`select r.id from registrations r join programs p on p.id=r.program_id where p.organization_id=1 order by r.id desc limit 1`);
  if (cufc[0]) {
    r = await get(`/api/admin/registrations/${cufc[0].id}`, { "x-workspace-slug": "mini-football-leagues" });
    r.status === 404 ? ok(`CUFC registration #${cufc[0].id} by id → 404`) : bad(`CUFC registration #${cufc[0].id} by id → ${r.status}`);
    r = await get(`/api/admin/registrations/${cufc[0].id}`);
    r.status === 404 ? ok(`…and 404 with no header`) : bad(`…but ${r.status} with no header`);
  }
  // 4b. Programme lists fail closed the same way.
  for (const path of ["/api/admin/academy", "/api/admin/camps", "/api/admin/programs"]) {
    const a = await get(path); const la = Array.isArray(a.body) ? a.body : [];
    la.every((x: any) => x.organizationId === 3) ? ok(`${path} no header: ${la.length} rows, all org 3`) : bad(`${path} no header leaked orgs ${[...new Set(la.map((x: any) => x.organizationId))].join(",")}`);
    const b = await get(path, { "x-workspace-slug": "christchurch-united" }); const lb = Array.isArray(b.body) ? b.body : [];
    lb.length === 0 ? ok(`${path} CUFC header as a non-member: 0 rows`) : bad(`${path} CUFC header as a non-member returned ${lb.length} rows`);
  }
  // 5. An MFL registration by id → 200 (the scope must not block a member).
  const { rows: mfl } = await pool.query(`select r.id from registrations r join programs p on p.id=r.program_id where p.organization_id=3 order by r.id desc limit 1`);
  if (mfl[0]) {
    r = await get(`/api/admin/registrations/${mfl[0].id}`, { "x-workspace-slug": "mini-football-leagues" });
    r.status === 200 ? ok(`MFL registration #${mfl[0].id} by id → 200`) : bad(`MFL registration #${mfl[0].id} by id → ${r.status}`);
  }
} catch (e: any) { bad(e.message); } finally {
  if (uid) { await pool.query(`delete from user_organizations where user_id=$1`, [uid]); await pool.query(`delete from users where id=$1`, [uid]); }
  await pool.end();
}
console.log(failed ? `\n✗ ${failed} check(s) failed.\n` : "\n✓ Registrations are scoped to the caller's workspaces on production.\n");
process.exit(failed ? 1 : 0);
