import pg from "pg"; import bcrypt from "bcryptjs";
const BASE="https://app.usg.co.nz";
const p=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const email=`_slive_${Date.now()}@usg.co.nz`, pw=`T${Math.random().toString(36).slice(2)}!aA9`;
const {rows}=await p.query(`INSERT INTO users (email,first_name,last_name,password,role,active) VALUES ($1,'S','L',$2,'team_member',true) RETURNING id`,[email,await bcrypt.hash(pw,10)]);
const uid=rows[0].id;
await p.query(`INSERT INTO user_organizations (user_id,organization_id,role,tabs) VALUES ($1,2,'admin',NULL)`,[uid]);
const login=await fetch(`${BASE}/api/auth/login`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,password:pw})});
const cookie=(login.headers.getSetCookie?.()??[]).map(c=>c.split(";")[0]).join("; ");
for (const q of ["monthly staff report","uniform","gym partnership","budget"]) {
  const t0=Date.now();
  const r=await fetch(`${BASE}/api/admin/drive/search?q=${encodeURIComponent(q)}`,{headers:{cookie,"X-Workspace-Slug":"christchurch-united"}});
  const ms=Date.now()-t0;
  const j:any=await r.json().catch(()=>({items:[]}));
  console.log(`  "${q}".padEnd  →  HTTP ${r.status}  ${String(j.items?.length ?? 0).padStart(3)} results  ${ms}ms`);
  if (j.items?.[0]) console.log(`        top: ${String(j.items[0].name).slice(0,60)}`);
}
await p.query(`DELETE FROM drive_access_log WHERE user_id=$1`,[uid]).catch(()=>{});
await p.query(`DELETE FROM user_organizations WHERE user_id=$1`,[uid]);
await p.query(`DELETE FROM users WHERE id=$1`,[uid]);
await p.end();
