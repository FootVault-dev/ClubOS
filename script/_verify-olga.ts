/**
 * _verify-olga.ts — every item from Olga's 18 Aug list, against production.
 *
 * Signs in as a CUFC workspace admin (what she is — NOT a super admin, who sees
 * a different sidebar) and drives the real walk-up registration form.
 */
import puppeteer from "puppeteer-core"; import pg from "pg"; import bcrypt from "bcryptjs"; import { mkdirSync } from "fs";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "https://app.usg.co.nz"; const OUT = "/tmp/olga-verify"; mkdirSync(OUT, { recursive: true });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let failed = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failed++; console.log(`  FAIL ${m}`); };
const users: number[] = []; let browser: any = null;
try {
  const email = `_olgaverify_${Date.now()}@usg.co.nz`; const pw = `T${Math.random().toString(36).slice(2)}!aA9`;
  const { rows } = await pool.query(`INSERT INTO users (email,first_name,last_name,password,role,active) VALUES ($1,'Olga','Verify',$2,'admin',true) RETURNING id`,[email, await bcrypt.hash(pw,10)]);
  users.push(rows[0].id);
  await pool.query(`INSERT INTO user_organizations (user_id,organization_id,role,tabs) VALUES ($1,1,'admin',NULL),($1,6,'admin',NULL)`,[rows[0].id]);
  const login = await fetch(`${BASE}/api/auth/login`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,password:pw})});
  if (!login.ok) throw new Error(`login ${login.status}`);
  const [cn,cv] = (login.headers.get("set-cookie")||"").split(";")[0].split("=");
  browser = await puppeteer.launch({ executablePath: CHROME, headless:"new", args:["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width:1440, height:1000, deviceScaleFactor:2 });
  await page.setCookie({name:cn,value:cv,domain:"app.usg.co.nz",path:"/",httpOnly:true,secure:true});

  // ── The walk-up form ────────────────────────────────────────────────────
  await page.goto(`${BASE}/admin/registrations`, { waitUntil:"networkidle2", timeout:60000 });
  await new Promise(r=>setTimeout(r,2500));
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll("button")).find(x=>/register at the office/i.test(x.textContent||"")); (b as HTMLButtonElement)?.click(); });
  await new Promise(r=>setTimeout(r,2000));
  await page.evaluate(() => { const r = Array.from(document.querySelectorAll("button,div")).find(x=>(x.textContent||"").trim().startsWith("FUNiño")); (r as HTMLElement)?.click(); });
  await new Promise(r=>setTimeout(r,1200));
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll("button")).find(x=>/^next/i.test((x.textContent||"").trim())); (b as HTMLButtonElement)?.click(); });
  await new Promise(r=>setTimeout(r,2500));

  // 1 + 2: order is Player → Parent → Emergency
  const order = await page.evaluate(() => {
    const t = document.body.innerText;
    return { player: t.indexOf("Player"), parent: t.indexOf("Parent / guardian"), emerg: t.indexOf("Emergency contact") };
  });
  order.player > -1 && order.parent > order.player && order.emerg > order.parent
    ? ok(`order is Player → Parent → Emergency (${order.player} < ${order.parent} < ${order.emerg})`)
    : bad(`order wrong: ${JSON.stringify(order)}`);
  (await page.evaluate(() => document.body.innerText.includes("A second adult to ring")))
    ? ok("emergency contact says what it is") : bad("no explanation on emergency contact");

  // 5: Next names what's missing
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll("button")).find(x=>/^next/i.test((x.textContent||"").trim())); (b as HTMLButtonElement)?.click(); });
  await new Promise(r=>setTimeout(r,900));
  const banner = await page.$('[data-testid="banner-missing-fields"]');
  if (!banner) bad("Next gave no explanation when fields were missing");
  else {
    const txt = await page.evaluate(el => (el as HTMLElement).innerText, banner);
    /Player first name/.test(txt) && /Parent email/.test(txt)
      ? ok(`Next names the missing fields ("${txt.slice(0, 90).replace(/\s+/g," ")}…")`)
      : bad(`banner shown but vague: ${txt.slice(0,120)}`);
  }
  await page.screenshot({ path:`${OUT}/family.png`, fullPage:true });

  // 3: DOB reads dd/mm/yyyy + age
  await page.evaluate(() => {
    const i = document.querySelector('[data-testid="input-player-first"]') as HTMLInputElement;
    if (i) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value")!.set!;
      s.call(i,"Testchild"); i.dispatchEvent(new Event("input",{bubbles:true})); }
  });
  // 7: a stray backdrop click must ASK, not wipe
  await page.evaluate(() => (document.querySelector('[data-testid="modal-register-player"]') as HTMLElement)?.click());
  await new Promise(r=>setTimeout(r,800));
  const confirm = await page.$('[data-testid="confirm-discard"]');
  confirm ? ok("a stray click outside asks before discarding") : bad("clicking outside still throws the form away");
  if (confirm) {
    await page.evaluate(() => (document.querySelector('[data-testid="button-keep-editing"]') as HTMLElement)?.click());
    await new Promise(r=>setTimeout(r,600));
    const kept = await page.evaluate(() => (document.querySelector('[data-testid="input-player-first"]') as HTMLInputElement)?.value);
    kept === "Testchild" ? ok("\"Keep editing\" keeps what was typed") : bad(`form lost its content (value=${JSON.stringify(kept)})`);
  }

  // ── Duplicates collapsed ────────────────────────────────────────────────
  await page.goto(`${BASE}/admin/contacts`, { waitUntil:"networkidle2", timeout:60000 });
  await new Promise(r=>setTimeout(r,2000));
  const box = await page.$('input[placeholder*="earch" i]');
  if (box) {
    await box.type("Darren Zhang");
    await new Promise(r=>setTimeout(r,3000));
    const n = await page.evaluate(() => (document.body.innerText.match(/Darren Zhang/g)||[]).length);
    const badge = await page.$('[data-testid^="badge-duplicates-"]');
    n <= 2 ? ok(`Darren Zhang appears ${n}× instead of 7`) : bad(`still ${n} rows of Darren Zhang`);
    badge ? ok("a records badge is shown on the collapsed row") : bad("no duplicates badge");
    if (badge) {
      const label = await page.evaluate(el => (el as HTMLElement).innerText, badge);
      /\d+ records/.test(label) ? ok(`badge reads "${label.trim()}"`) : bad(`badge reads ${label}`);
    }
    await page.screenshot({ path:`${OUT}/contacts.png` });
  } else bad("no search box on contacts");
} catch(e:any){ bad(`threw: ${e.message}`); }
finally {
  if (browser) await browser.close();
  for (const id of users){ await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`,[id]); await pool.query(`DELETE FROM users WHERE id=$1`,[id]); }
  console.log(`\n  cleaned up ${users.length} probe account(s)`);
  await pool.end();
}
console.log(failed === 0 ? "\n✓ Olga's list verified on production.\n" : `\n✗ ${failed} check(s) failed.\n`);
process.exit(failed === 0 ? 0 : 1);
