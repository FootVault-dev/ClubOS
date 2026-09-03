/**
 * _verify-contacts-ux.ts — Back returns to the search, and staff can edit.
 * Drives production as a CUFC workspace admin (what Olga and Travis are).
 */
import puppeteer from "puppeteer-core"; import pg from "pg"; import bcrypt from "bcryptjs"; import { mkdirSync } from "fs";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "https://app.usg.co.nz"; const OUT = "/tmp/contacts-ux"; mkdirSync(OUT, { recursive: true });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let failed = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failed++; console.log(`  FAIL ${m}`); };
const users: number[] = []; let browser: any = null;
try {
  const email = `_uxverify_${Date.now()}@usg.co.nz`; const pw = `T${Math.random().toString(36).slice(2)}!aA9`;
  const { rows } = await pool.query(`INSERT INTO users (email,first_name,last_name,password,role,active) VALUES ($1,'UX','Verify',$2,'admin',true) RETURNING id`,[email, await bcrypt.hash(pw,10)]);
  users.push(rows[0].id);
  await pool.query(`INSERT INTO user_organizations (user_id,organization_id,role,tabs) VALUES ($1,1,'admin',NULL)`,[rows[0].id]);
  const login = await fetch(`${BASE}/api/auth/login`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,password:pw})});
  const [cn,cv] = (login.headers.get("set-cookie")||"").split(";")[0].split("=");
  browser = await puppeteer.launch({ executablePath: CHROME, headless:"new", args:["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width:1440, height:1000, deviceScaleFactor:2 });
  await page.setCookie({name:cn,value:cv,domain:"app.usg.co.nz",path:"/",httpOnly:true,secure:true});

  // ── Search → open → Back ────────────────────────────────────────────────
  await page.goto(`${BASE}/admin/contacts`, { waitUntil:"networkidle2", timeout:60000 });
  await new Promise(r=>setTimeout(r,2000));
  const box = await page.$('input[placeholder*="earch" i]');
  if (!box) throw new Error("no search box");
  await box.type("noothan");
  await new Promise(r=>setTimeout(r,3000));

  const url1 = page.url();
  url1.includes("q=noothan") ? ok(`search is in the URL (${url1.split("/admin")[1]})`) : bad(`URL has no search: ${url1}`);
  await page.screenshot({ path:`${OUT}/1-search.png` });

  const opened = await page.evaluate(() => {
    const r = document.querySelector('[data-testid^="row-person-"]') as HTMLElement | null;
    if (r) { r.click(); return true; } return false;
  });
  opened ? ok("opened a result") : bad("no result row to open");
  await new Promise(r=>setTimeout(r,2500));
  (page.url().includes("from=")) ? ok("the person URL carries ?from= with the search")
                                 : bad(`no ?from= on ${page.url()}`);
  await page.screenshot({ path:`${OUT}/2-person.png` });

  // Browser Back — the thing Daniel actually does.
  await page.goBack({ waitUntil:"networkidle2" });
  await new Promise(r=>setTimeout(r,2500));
  const backUrl = page.url();
  const boxVal = await page.evaluate(() => (document.querySelector('input[placeholder*="earch" i]') as HTMLInputElement)?.value);
  backUrl.includes("q=noothan") ? ok("Back returns to the searched URL") : bad(`Back went to ${backUrl}`);
  boxVal === "noothan" ? ok(`the search box still says "${boxVal}"`) : bad(`search box is ${JSON.stringify(boxVal)}`);
  await page.screenshot({ path:`${OUT}/3-back.png` });

  // ── The edit form ───────────────────────────────────────────────────────
  await page.evaluate(() => (document.querySelector('[data-testid^="row-person-"]') as HTMLElement)?.click());
  await new Promise(r=>setTimeout(r,2500));
  const editBtn = await page.$('[data-testid="button-edit-details"]');
  editBtn ? ok("an Edit button is on the person's page") : bad("no Edit button");
  if (editBtn) {
    await editBtn.click();
    await new Promise(r=>setTimeout(r,900));
    const fields = await page.evaluate(() => ({
      first: !!document.querySelector('[data-testid="input-edit-first"]'),
      last:  !!document.querySelector('[data-testid="input-edit-last"]'),
      save:  !!document.querySelector('[data-testid="button-save-details"]'),
      warn:  document.body.innerText.includes("re-points their whole history"),
    }));
    fields.first && fields.last && fields.save ? ok("the edit form opens with name fields and Save")
                                               : bad(`form incomplete: ${JSON.stringify(fields)}`);
    await page.screenshot({ path:`${OUT}/4-edit.png` });
  }
} catch(e:any){ bad(`threw: ${e.message}`); }
finally {
  if (browser) await browser.close();
  for (const id of users){ await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`,[id]); await pool.query(`DELETE FROM users WHERE id=$1`,[id]); }
  await pool.end();
}
console.log(failed === 0 ? "\n✓ Verified.\n" : `\n✗ ${failed} check(s) failed.\n`);
process.exit(failed === 0 ? 0 : 1);
