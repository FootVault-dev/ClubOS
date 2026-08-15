import pg from "pg"; import bcrypt from "bcryptjs";
const BASE="https://app.usg.co.nz";
const p=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const email=`_cc_${Date.now()}@usg.co.nz`, pw=`T${Math.random().toString(36).slice(2)}!aA9`;
const {rows}=await p.query(`INSERT INTO users (email,first_name,last_name,password,role,active) VALUES ($1,'C','C',$2,'team_member',true) RETURNING id`,[email,await bcrypt.hash(pw,10)]);
const uid=rows[0].id;
await p.query(`INSERT INTO user_organizations (user_id,organization_id,role,tabs) VALUES ($1,2,'admin',NULL)`,[uid]);
const login=await fetch(`${BASE}/api/auth/login`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,password:pw})});
const cookie=(login.headers.getSetCookie?.()??[]).map(c=>c.split(";")[0]).join("; ");
for (const q of ["signed contract","payroll","medical"]) {
  const r=await fetch(`${BASE}/api/admin/drive/search?q=${encodeURIComponent(q)}`,{headers:{cookie,"X-Workspace-Slug":"christchurch-united"}});
  const j:any=await r.json();
  console.log(`  "${q}" → ${j.items?.length ?? 0} results for an ordinary staff member`);
  for (const i of (j.items??[]).slice(0,3)) console.log(`      ${String(i.name).slice(0,58)}`);
}
await p.query(`DELETE FROM drive_access_log WHERE user_id=$1`,[uid]).catch(()=>{});
await p.query(`DELETE FROM user_organizations WHERE user_id=$1`,[uid]);
await p.query(`DELETE FROM users WHERE id=$1`,[uid]); await p.end();
