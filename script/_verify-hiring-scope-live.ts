// E2E proof that the brand scope is enforced by the DEPLOYED app, not just by
// the code as read. Creates a throwaway user carrying Isaac's exact scope, logs
// in to https://app.usg.co.nz for real, and checks what comes back — then
// deletes the user again, whatever happened.
//
//   npx tsx --env-file=.env script/_verify-hiring-scope-live.ts
//
// Uses a temporary account rather than Isaac's own because his password is his,
// and because a super admin (Daniel) bypasses the scope by design and so cannot
// test it.
import { Pool } from "pg";
import bcrypt from "bcryptjs";

const BASE = "https://app.usg.co.nz";
const ORG_SLUG = "united-sports-group";
const EMAIL = `_scopetest_${Date.now()}@usg.co.nz`;
const PASSWORD = `T${Math.random().toString(36).slice(2)}!aA9`;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let userId: number | null = null;
let failures = 0;

const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok " : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

try {
  const { rows: orgs } = await pool.query("SELECT id FROM organizations WHERE slug = $1", [ORG_SLUG]);
  const orgId = orgs[0].id;

  const { rows: created } = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Scope','Test',$2,'team_member',true) RETURNING id`,
    [EMAIL, await bcrypt.hash(PASSWORD, 10)],
  );
  userId = created[0].id;
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs, hiring_brands)
     VALUES ($1,$2,'team_member','["hiring"]'::jsonb,'["mfl","cic"]'::jsonb)`,
    [userId, orgId],
  );
  console.log(`\nThrowaway user #${userId} created with tabs=["hiring"], hiring_brands=["mfl","cic"]\n`);

  // ── log in against the live app ───────────────────────────────────────────
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  check("logs in to app.usg.co.nz", login.ok, `HTTP ${login.status}`);
  const cookie = (login.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("No session cookie returned — cannot continue.");

  const get = (path: string) =>
    fetch(`${BASE}${path}`, { headers: { cookie, "X-Workspace-Slug": ORG_SLUG }, redirect: "manual" });

  // ── jobs ──────────────────────────────────────────────────────────────────
  const jobsRes = await get("/api/admin/hiring/jobs");
  const jobsBody = await jobsRes.json();
  const jobBrands: string[] = [...new Set((jobsBody.jobs ?? []).map((j: any) => j.brand))] as string[];
  check("GET /hiring/jobs succeeds", jobsRes.ok, `HTTP ${jobsRes.status}`);
  check("only mfl/cic jobs returned", jobBrands.every(b => ["mfl", "cic"].includes(b)), `saw [${jobBrands}]`);
  check("no cufc job leaked", !jobBrands.includes("cufc"), `${(jobsBody.jobs ?? []).length} jobs visible`);
  check("allowedBrands echoed for the UI", JSON.stringify(jobsBody.allowedBrands) === '["mfl","cic"]', JSON.stringify(jobsBody.allowedBrands));

  // ── applications: the unfiltered list is the real test ────────────────────
  const appsRes = await get("/api/admin/hiring/applications");
  const appsBody = await appsRes.json();
  const apps = appsBody.applications ?? [];
  const { rows: cufcApps } = await pool.query(
    `SELECT a.id FROM hiring_applications a JOIN hiring_jobs j ON j.id = a.job_id WHERE j.brand = 'cufc'`,
  );
  const cufcIds = new Set(cufcApps.map(r => r.id));
  check("GET /hiring/applications succeeds", appsRes.ok, `HTTP ${appsRes.status}`);
  check("no cufc applicant in the unfiltered list", !apps.some((a: any) => cufcIds.has(a.id)),
    `${apps.length} visible, ${cufcIds.size} cufc applicants exist`);

  // ── asking for a CUFC job's applicants by id must not work either ─────────
  const { rows: cufcJobs } = await pool.query(`SELECT id, title FROM hiring_jobs WHERE brand = 'cufc' LIMIT 1`);
  const byJob = await get(`/api/admin/hiring/applications?jobId=${cufcJobs[0].id}`);
  const byJobBody = await byJob.json();
  check(`?jobId=<cufc "${cufcJobs[0].title}"> returns nothing`, (byJobBody.applications ?? []).length === 0,
    `${(byJobBody.applications ?? []).length} rows`);

  // ── and neither must a direct hit on a CUFC applicant, or their file ──────
  const target = cufcApps[0]?.id;
  if (target) {
    const one = await fetch(`${BASE}/api/admin/hiring/applications/${target}`, {
      method: "PATCH",
      headers: { cookie, "X-Workspace-Slug": ORG_SLUG, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "reviewing" }),
    });
    check(`PATCH a cufc application (#${target}) is refused`, one.status === 404, `HTTP ${one.status}`);

    const aud = await get(`/api/admin/hiring/applications/${target}/audition`);
    check(`audition file for a cufc application is refused`, aud.status === 404, `HTTP ${aud.status}`);
    check("no signed URL handed out", !(aud.headers.get("location") ?? "").includes("http"),
      aud.headers.get("location") ?? "no redirect");
  }

  // ── posting under someone else's brand ────────────────────────────────────
  const post = await fetch(`${BASE}/api/admin/hiring/jobs`, {
    method: "POST",
    headers: { cookie, "X-Workspace-Slug": ORG_SLUG, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "scope test", brand: "cufc", slug: `scope-test-${Date.now()}` }),
  });
  check("cannot post a job under the cufc brand", post.status === 403, `HTTP ${post.status}`);

  // ── the tab whitelist still holds for everything else ─────────────────────
  const other = await get("/api/admin/proposals");
  check("still locked out of Proposals (tab whitelist intact)", other.status === 403, `HTTP ${other.status}`);

  console.log(failures ? `\n✗ ${failures} check(s) FAILED\n` : "\n✓ All checks passed against the live app.\n");
} catch (e) {
  console.error("\nERROR:\n", e);
  failures++;
} finally {
  if (userId) {
    await pool.query("DELETE FROM user_organizations WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM users WHERE id = $1", [userId]);
    console.log(`Throwaway user #${userId} deleted (rows remaining: ${rows[0].n}).`);
  }
  await pool.end();
  process.exit(failures ? 1 : 0);
}
