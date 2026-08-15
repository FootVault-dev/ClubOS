import pg from "pg"; import bcrypt from "bcryptjs"; import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs"; import { join } from "path";
const BASE="https://app.usg.co.nz";
const CHROME=process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT=join(process.cwd(),"outputs","drive-preflight"); mkdirSync(OUT,{recursive:true});
const p=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const email=`_shot_${Date.now()}@usg.co.nz`, pw=`T${Math.random().toString(36).slice(2)}!aA9`;
const {rows}=await p.query(`INSERT INTO users (email,first_name,last_name,password,role,active) VALUES ($1,'Real','View',$2,'team_member',true) RETURNING id`,[email,await bcrypt.hash(pw,10)]);
const uid=rows[0].id;
await p.query(`INSERT INTO user_organizations (user_id,organization_id,role,tabs) VALUES ($1,2,'admin',NULL)`,[uid]);
const login=await fetch(`${BASE}/api/auth/login`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,password:pw})});
const raw=login.headers.get("set-cookie")||""; const [cn,cv]=raw.split(";")[0].split("=");
// A real folder with real Google Docs in it.
const f=await p.query(`SELECT parent_id FROM drive_nodes WHERE source_url LIKE '%docs.google.com/document/%' AND parent_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM drive_node_gates g WHERE g.id=drive_nodes.id AND g.gates<>'{}') LIMIT 1`);
const folderId=f.rows[0]?.parent_id;
const b=await puppeteer.launch({executablePath:CHROME,headless:"new",args:["--no-sandbox"]});
for (const [label,w,h,mob] of [["real-desktop",1440,900,false],["real-mobile",390,844,true]] as const) {
  const pg2=await b.newPage();
  await pg2.setViewport({width:w,height:h,isMobile:mob,hasTouch:mob,deviceScaleFactor:2});
  if(mob) await pg2.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1");
  await pg2.setCookie({name:cn,value:cv,domain:"app.usg.co.nz",path:"/",httpOnly:true,secure:true});
  await pg2.goto(`${BASE}/admin`,{waitUntil:"domcontentloaded",timeout:60000});
  await pg2.evaluate(()=>localStorage.setItem("clubos_workspace","christchurch-united"));
  await pg2.goto(`${BASE}/admin/drive`,{waitUntil:"networkidle2",timeout:60000});
  await new Promise(r=>setTimeout(r,2000));
  const box=await pg2.$('input[placeholder*="Search names"]');
  if(box){ await box.click(); await pg2.keyboard.type("monthly staff report"); }
  await new Promise(r=>setTimeout(r,3500));
  await pg2.screenshot({path:join(OUT,`${label}.png`)});
  console.log(`  → ${label}.png`);
  await pg2.close();
}
await b.close();
await p.query(`DELETE FROM drive_access_log WHERE user_id=$1`,[uid]).catch(()=>{});
await p.query(`DELETE FROM user_organizations WHERE user_id=$1`,[uid]);
await p.query(`DELETE FROM users WHERE id=$1`,[uid]); await p.end();
