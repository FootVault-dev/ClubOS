// Proof that the Hiring brand scope is enforced by the DEPLOYED app, not just by
// the code as read. Two halves:
//
//   1. Pure assertions on hiringBrandFilter — including the rule that a BRAND
//      workspace never widens, not even for a super admin. Tested here rather
//      than live because proving it live would mean creating a super-admin
//      account on production, and a pure function proves it exactly as well.
//   2. Live checks: throwaway users are stood up carrying real shapes, they log
//      in to app.usg.co.nz for real, and the answers are checked — then the
//      users are deleted in a finally, whatever happened.
//
//   npx tsx --env-file=.env script/_verify-hiring-scope-live.ts
//
// Throwaway accounts are used because a super admin bypasses the group scope by
// design and so cannot test it, and because Isaac's password is his.
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import { hiringBrandFilter } from "../shared/hiring";

const BASE = "https://app.usg.co.nz";
const USG = "united-sports-group";
const MFL = "mini-football-leagues";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const created: number[] = [];
let failures = 0;

const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok " : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Create a throwaway user + membership, log in, return a fetch bound to it. */
async function actor(opts: { orgId: number; role: string; tabs: string[] | null; brands: string[] | null }) {
  const email = `_scopetest_${Date.now()}_${created.length}@usg.co.nz`;
  const password = `T${Math.random().toString(36).slice(2)}!aA9`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Scope','Test',$2,'team_member',true) RETURNING id`,
    [email, await bcrypt.hash(password, 10)],
  );
  const id = rows[0].id;
  created.push(id);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs, hiring_brands)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`,
    [id, opts.orgId, opts.role, opts.tabs === null ? null : JSON.stringify(opts.tabs),
     opts.brands === null ? null : JSON.stringify(opts.brands)],
  );
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
  const cookie = (login.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("no session cookie");
  return {
    id,
    get: (path: string, ws: string) =>
      fetch(`${BASE}${path}`, { headers: { cookie, "X-Workspace-Slug": ws }, redirect: "manual" }),
    send: (method: string, path: string, ws: string, body?: unknown) =>
      fetch(`${BASE}${path}`, {
        method,
        headers: { cookie, "X-Workspace-Slug": ws, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}

try {
  // ══ 1. hiringBrandFilter, in isolation ═══════════════════════════════════
  console.log("\n── hiringBrandFilter ──");
  check("group workspace, unrestricted member → all brands", hiringBrandFilter(USG, null, false) === null);
  check("group workspace, member scoped to mfl+cic → mfl+cic", eq(hiringBrandFilter(USG, ["mfl", "cic"], false), ["mfl", "cic"]));
  check("group workspace, super admin → all brands", hiringBrandFilter(USG, null, true) === null);
  check("BRAND workspace pins to its brand", eq(hiringBrandFilter(MFL, null, false), ["mfl"]));
  check("BRAND workspace does not widen for a super admin", eq(hiringBrandFilter(MFL, null, true), ["mfl"]));
  check("BRAND workspace intersects a narrower member scope", eq(hiringBrandFilter(MFL, ["mfl", "cic"], false), ["mfl"]));
  check("member without that brand sees nothing there", eq(hiringBrandFilter(MFL, ["cufc"], false), []));
  check("a workspace that is neither group nor brand-bound fails CLOSED", eq(hiringBrandFilter("united-prints", null, false), []));

  // Facts from the database that the live checks are measured against.
  const { rows: cufcApps } = await pool.query(
    `SELECT a.id FROM hiring_applications a JOIN hiring_jobs j ON j.id = a.job_id WHERE j.brand = 'cufc'`);
  const { rows: mflApps } = await pool.query(
    `SELECT a.id FROM hiring_applications a JOIN hiring_jobs j ON j.id = a.job_id WHERE j.brand = 'mfl'`);
  const { rows: cufcJobs } = await pool.query(`SELECT id, title FROM hiring_jobs WHERE brand = 'cufc' LIMIT 1`);
  const cufcIds = new Set(cufcApps.map(r => r.id));
  console.log(`\n  (prod today: ${cufcApps.length} cufc applicants, ${mflApps.length} mfl applicants)`);

  // ══ 2. Isaac's shape in the GROUP workspace ══════════════════════════════
  console.log("\n── United Sports Group workspace (team_member, tabs=[hiring], brands=[mfl,cic]) ──");
  {
    const a = await actor({ orgId: 7, role: "team_member", tabs: ["hiring"], brands: ["mfl", "cic"] });
    const jobs = await (await a.get("/api/admin/hiring/jobs", USG)).json();
    const brands = [...new Set((jobs.jobs ?? []).map((j: any) => j.brand))];
    check("sees mfl jobs", (jobs.jobs ?? []).length > 0, `${(jobs.jobs ?? []).length} jobs`);
    check("no cufc job leaked", !brands.includes("cufc"), `brands [${brands}]`);

    const apps = await (await a.get("/api/admin/hiring/applications", USG)).json();
    check("unfiltered applications carry no cufc applicant",
      !(apps.applications ?? []).some((x: any) => cufcIds.has(x.id)),
      `${(apps.applications ?? []).length} visible`);
    check("sees all mfl applicants", (apps.applications ?? []).length === mflApps.length,
      `${(apps.applications ?? []).length} vs ${mflApps.length}`);
  }

  // ══ 3. Isaac's shape in the MFL workspace — role admin, NO brand scope ═══
  // This is the shape that matters most: an admin of the workspace with
  // hiring_brands NULL. The role bypasses the tab whitelist and the null scope
  // means "all brands" — so ONLY the workspace's own brand binding stops CUFC
  // applicants appearing. If that binding failed, this is where it would show.
  console.log("\n── Mini Football Leagues workspace (admin, tabs=null, brands=null) ──");
  {
    const a = await actor({ orgId: 3, role: "admin", tabs: null, brands: null });

    const jobsRes = await a.get("/api/admin/hiring/jobs", MFL);
    const jobs = await jobsRes.json();
    const brands = [...new Set((jobs.jobs ?? []).map((j: any) => j.brand))];
    check("Hiring tab reachable in the MFL workspace", jobsRes.ok, `HTTP ${jobsRes.status}`);
    check("tab is NOT empty (jobs are owned by the group org)", (jobs.jobs ?? []).length > 0,
      `${(jobs.jobs ?? []).length} jobs`);
    check("only mfl jobs", eq(brands, ["mfl"]), `brands [${brands}]`);
    check("allowedBrands pinned to mfl for the UI", eq(jobs.allowedBrands, ["mfl"]), JSON.stringify(jobs.allowedBrands));

    const apps = await (await a.get("/api/admin/hiring/applications", MFL)).json();
    check("sees every mfl applicant", (apps.applications ?? []).length === mflApps.length,
      `${(apps.applications ?? []).length} vs ${mflApps.length}`);
    check("no cufc applicant, despite admin role + null brand scope",
      !(apps.applications ?? []).some((x: any) => cufcIds.has(x.id)));

    const byJob = await (await a.get(`/api/admin/hiring/applications?jobId=${cufcJobs[0].id}`, MFL)).json();
    check(`?jobId=<cufc "${cufcJobs[0].title}"> returns nothing`, (byJob.applications ?? []).length === 0);

    const target = cufcApps[0]?.id;
    if (target) {
      const patch = await a.send("PATCH", `/api/admin/hiring/applications/${target}`, MFL, { status: "reviewing" });
      check(`PATCH a cufc applicant (#${target}) refused`, patch.status === 404, `HTTP ${patch.status}`);
      const aud = await a.get(`/api/admin/hiring/applications/${target}/audition`, MFL);
      check("cufc audition file refused", aud.status === 404, `HTTP ${aud.status}`);
      check("no signed URL handed out", !(aud.headers.get("location") ?? "").includes("http"));
    }
    const patchJob = await a.send("PATCH", `/api/admin/hiring/jobs/${cufcJobs[0].id}`, MFL, { title: "nope" });
    check("editing a cufc job refused", patchJob.status === 404, `HTTP ${patchJob.status}`);

    // A job posted from the MFL tab lands under mfl even if the body says cufc.
    const slug = `scope-test-${Date.now()}`;
    const post = await a.send("POST", "/api/admin/hiring/jobs", MFL, { title: "Scope test", brand: "cufc", slug });
    const posted = await post.json().catch(() => ({}));
    check("can post a job from the MFL tab", post.ok, `HTTP ${post.status}`);
    if (post.ok) {
      const { rows } = await pool.query("SELECT brand, organization_id FROM hiring_jobs WHERE id = $1", [posted.id]);
      check('brand forced to "mfl" despite body saying cufc', rows[0]?.brand === "mfl", `stored "${rows[0]?.brand}"`);
      await pool.query("DELETE FROM hiring_jobs WHERE id = $1", [posted.id]);
      console.log(`  (test job #${posted.id} deleted)`);
    }

    // The MFL workspace's other tabs must be unaffected by any of this.
    const teams = await a.get("/api/admin/league/teams", MFL);
    check("other MFL tabs still work", teams.status !== 403, `HTTP ${teams.status}`);
  }

  console.log(failures ? `\n✗ ${failures} check(s) FAILED\n` : "\n✓ All checks passed against the live app.\n");
} catch (e) {
  console.error("\nERROR:\n", e);
  failures++;
} finally {
  for (const id of created) {
    await pool.query("DELETE FROM user_organizations WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM users WHERE id = $1", [id]);
  }
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM users WHERE email LIKE '\\_scopetest\\_%'");
  console.log(`Throwaway users deleted (${created.length} created, ${rows[0].n} matching rows left).`);
  await pool.end();
  process.exit(failures ? 1 : 0);
}
