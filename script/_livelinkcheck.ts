// Prove the deployed API hands back real, editable Google links.
import pg from "pg"; import bcrypt from "bcryptjs";
const BASE = "https://app.usg.co.nz";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const email = `_livelink_${Date.now()}@usg.co.nz`, pw = `T${Math.random().toString(36).slice(2)}!aA9`;
const { rows } = await p.query(`INSERT INTO users (email,first_name,last_name,password,role,active) VALUES ($1,'Live','Test',$2,'team_member',true) RETURNING id`, [email, await bcrypt.hash(pw,10)]);
const uid = rows[0].id;
await p.query(`INSERT INTO user_organizations (user_id,organization_id,role,tabs) VALUES ($1,2,'admin',NULL)`, [uid]);
const login = await fetch(`${BASE}/api/auth/login`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({email,password:pw}) });
const cookie = (login.headers.getSetCookie?.() ?? []).map(c=>c.split(";")[0]).join("; ");
const hdr = { cookie, "X-Workspace-Slug": "christchurch-united" };

// Find a real imported Google Doc that this (ungated) user can see.
const doc = await p.query(`
  SELECT n.id, n.name, n.source_url FROM drive_nodes n
  WHERE n.source_url LIKE '%docs.google.com/document/%' AND n.trashed_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM drive_node_gates g WHERE g.id=n.id AND g.gates <> '{}')
  LIMIT 1`);
let pass=0, fail=0; const ok=(l:string,g:boolean,d="")=>{console.log(`  ${g?"ok  ":"FAIL"} ${l}${d?` — ${d}`:""}`); g?pass++:fail++;};
console.log("\nLive Google links\n");
if (!doc.rows.length) { console.log("  (no ungated Google Doc imported yet)"); }
else {
  const d = doc.rows[0];
  const r = await fetch(`${BASE}/api/admin/drive/node/${d.id}`, { headers: hdr });
  const j: any = await r.json();
  ok("the API returns the node", r.status === 200, `HTTP ${r.status}`);
  ok("it is flagged live-editable", j.liveEditable === true, String(j.liveEditable));
  ok("the label names the right app", j.liveLabel === "Open in Google Docs", String(j.liveLabel));
  ok("the URL is Google's editable doc link", String(j.sourceUrl).includes("docs.google.com/document/"), String(j.sourceUrl).slice(0,60));
  console.log(`\n  ${d.name}\n  ${d.source_url}\n`);
}
const counts = await p.query(`
  SELECT count(*) FILTER (WHERE source_url LIKE '%docs.google.com/document/%')::int docs,
         count(*) FILTER (WHERE source_url LIKE '%docs.google.com/spreadsheets/%')::int sheets,
         count(*) FILTER (WHERE source_url LIKE '%docs.google.com/presentation/%')::int slides
  FROM drive_nodes`);
const c = counts.rows[0];
console.log(`  live editable: ${c.docs} Docs · ${c.sheets} Sheets · ${c.slides} Slides\n`);
await p.query(`DELETE FROM drive_access_log WHERE user_id=$1`,[uid]).catch(()=>{});
await p.query(`DELETE FROM user_organizations WHERE user_id=$1`,[uid]);
await p.query(`DELETE FROM users WHERE id=$1`,[uid]);
await p.end();
process.exit(fail?1:0);
