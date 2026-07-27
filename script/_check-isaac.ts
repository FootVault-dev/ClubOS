// Throwaway read-only probe: Isaac Living's ClubOS user + memberships, USG org,
// and the brands currently in use on hiring_jobs. Delete after use.
import "dotenv/config";
import { pool } from "../server/db";

async function main() {
  const q = async (label: string, text: string, params: any[] = []) => {
    const r = await pool.query(text, params);
    console.log(`\n=== ${label} ===`);
    console.table(r.rows);
  };

  await q("users matching isaac", `select id, email, first_name, last_name, role, active from users where lower(first_name) like '%isaac%' or lower(last_name) like '%living%' or lower(email) like '%isaac%'`);
  await q("organizations", `select id, slug, name, active from organizations order by id`);
  await q("hiring jobs by brand", `select brand, organization_id, count(*) as jobs, sum(case when status='open' then 1 else 0 end) as open from hiring_jobs group by brand, organization_id order by brand`);
  await q("applications by brand", `select j.brand, count(a.*) as applications from hiring_applications a join hiring_jobs j on j.id = a.job_id group by j.brand order by j.brand`);

  const isaac = await pool.query(`select id from users where lower(first_name) like '%isaac%' or lower(email) like '%isaac%'`);
  for (const row of isaac.rows) {
    await q(`memberships for user ${row.id}`, `select uo.id, uo.organization_id, o.slug, uo.role, uo.tabs from user_organizations uo join organizations o on o.id = uo.organization_id where uo.user_id = $1 order by uo.organization_id`, [row.id]);
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
