// Throwaway read-only probe: who would gain the Hiring tab if it were added to
// the MFL workspace's tab list, and where hiring jobs/applications actually live.
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = async (label: string, text: string, params: any[] = []) => {
  const r = await pool.query(text, params);
  console.log(`\n=== ${label} ===`);
  console.table(r.rows);
};

await q("everyone in the MFL workspace (org 3)", `
  select u.id, u.email, u.first_name, u.last_name, u.role as global_role,
         uo.role as ws_role, uo.tabs,
         case when u.role='super_admin' then 'YES (super admin)'
              when uo.role in ('admin','manager') then 'YES — role bypasses the tab list'
              when uo.tabs is null then 'YES — legacy null tabs = all'
              else 'only if "hiring" is ticked' end as would_get_hiring
    from user_organizations uo join users u on u.id = uo.user_id
   where uo.organization_id = 3 order by u.id`);

await q("hiring jobs: owning org x brand", `
  select j.organization_id, o.slug as owner_workspace, j.brand, count(*)::int as jobs
    from hiring_jobs j join organizations o on o.id = j.organization_id
   group by 1,2,3 order by 3`);

await q("hiring applications: owning org x brand", `
  select a.organization_id, j.brand, count(*)::int as applications
    from hiring_applications a join hiring_jobs j on j.id = a.job_id
   group by 1,2 order by 2`);

await pool.end();
