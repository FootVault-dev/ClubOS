/**
 * The Registrations filter bar on the live site: it must offer every programme,
 * hide the camp-only day/session filters until a camp is picked, and let the
 * office find refunds.
 */
import pg from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";
import { join } from "path";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "https://app.usg.co.nz";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); };
let uid: number | null = null, browser: any = null;
try {
  const email = `regfilter-${crypto.randomBytes(5).toString("hex")}@example.com`;
  const pw = crypto.randomBytes(16).toString("base64url");
  const r = await pool.query(`INSERT INTO users (email,first_name,last_name,password,role,active)
    VALUES ($1,'Reg','Probe',$2,'admin',true) RETURNING id`, [email, await bcrypt.hash(pw,10)]);
  uid = r.rows[0].id;
  await pool.query(`INSERT INTO user_organizations (user_id,organization_id,role,tabs) VALUES ($1,1,'admin',NULL)`,[uid]);
  const lr = await fetch(`${BASE}/api/auth/login`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,password:pw})});
  const [cn,cv]=(lr.headers.get("set-cookie")||"").split(";")[0].split("=");

  const outDir = join(process.cwd(), "..", "..", "outputs", "ui-preflight", "clubos-registrations");
  mkdirSync(outDir, { recursive: true });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args:["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.setCookie({ name: cn, value: cv, domain: "app.usg.co.nz", path: "/", httpOnly: true, secure: true });
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.evaluate(() => localStorage.setItem("clubos_workspace","christchurch-united"));
  await page.goto(`${BASE}/admin/registrations`, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise(r=>setTimeout(r,3500));

  const bar = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="select-camp-filter"]') as HTMLSelectElement|null;
    const groups = sel ? Array.from(sel.querySelectorAll("optgroup")).map(g=>({
      label:(g as HTMLOptGroupElement).label,
      items:Array.from(g.querySelectorAll("option")).map(o=>o.textContent||"")})) : [];
    return {
      firstOption: sel?.options?.[0]?.textContent || "",
      groups,
      dayVisible: !!document.querySelector('[data-testid="select-day-filter"]'),
      sessionVisible: !!document.querySelector('[data-testid="select-session-filter"]'),
      refundVisible: !!document.querySelector('[data-testid="select-refund-filter"]'),
    };
  });
  ok("the filter says 'All programmes', not 'All Camps'", /all programmes/i.test(bar.firstOption), bar.firstOption);
  const labels = bar.groups.map(g=>g.label);
  ok("programmes are grouped by type", labels.length >= 2, labels.join(" · "));
  const all = bar.groups.flatMap(g=>g.items).join(" | ");
  ok("academy programmes are offered", /FUNi|Technification|Pre-Academy/.test(all));
  ok("holiday camps are still offered", /Holiday Camp/.test(all));
  ok("duplicate camp names are told apart by date",
     (all.match(/FUNdamentals Holiday Camp/g)||[]).length < 2 || /FUNdamentals Holiday Camp · \w+ \d{4}/.test(all));
  ok("🔴 day + session filters are hidden until a camp is picked", !bar.dayVisible && !bar.sessionVisible);
  ok("a refunded filter is available", bar.refundVisible);
  await page.screenshot({ path: join(outDir,"filters-all-programmes.png"), clip:{x:330,y:60,width:1110,height:220} });

  // Pick a holiday camp → the camp-only filters should appear.
  const campVal = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="select-camp-filter"]') as HTMLSelectElement;
    const opt = Array.from(sel.querySelectorAll("option")).find(o=>/Holiday Camp/.test(o.textContent||""));
    if (!opt) return null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,"value")!.set!;
    setter.call(sel, (opt as HTMLOptionElement).value);
    sel.dispatchEvent(new Event("change",{bubbles:true}));
    return (opt as HTMLOptionElement).value;
  });
  await new Promise(r=>setTimeout(r,2500));
  const afterCamp = await page.evaluate(()=>({
    day: !!document.querySelector('[data-testid="select-day-filter"]'),
    session: !!document.querySelector('[data-testid="select-session-filter"]'),
  }));
  ok("picking a camp brings the day + session filters back", !!campVal && afterCamp.day && afterCamp.session);
  await page.screenshot({ path: join(outDir,"filters-camp-selected.png"), clip:{x:330,y:60,width:1110,height:220} });
  // ── 🔴 The refund filter must actually filter ──────────────────────────────
  // It shipped inert: the filter logic was written but `filterRefund` was left
  // out of the useMemo dependency array, so the list never recomputed and every
  // confirmed booking stayed on screen under "Refunded". React does not warn.
  const pick = async (testid: string, match: RegExp) => page.evaluate(({ testid, src }: any) => {
    const sel = document.querySelector(`[data-testid="${testid}"]`) as HTMLSelectElement;
    const re = new RegExp(src, "i");
    const opt = Array.from(sel.querySelectorAll("option")).find(o => re.test(o.textContent || ""));
    if (!opt) return null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
    setter.call(sel, (opt as HTMLOptionElement).value);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return (opt as HTMLOptionElement).value;
  }, { testid, src: match.source });

  const rowIds = () => page.evaluate(() =>
    Array.from(document.body.innerText.matchAll(/#(\d+) — /g)).map(m => Number(m[1])));

  await pick("select-camp-filter", /^All programmes$/);
  await new Promise(r => setTimeout(r, 2500));
  await pick("select-refund-filter", /^Refunded$/);
  await new Promise(r => setTimeout(r, 2500));
  const refunded = await rowIds();
  // The nine CUFC registrations carrying refunded money.
  const expected = [53, 93, 258, 281, 288, 392, 401, 419, 432];
  ok("🔴 'Refunded' shows only refunded bookings",
     refunded.length > 0 && refunded.every(id => expected.includes(id)),
     `${refunded.length} rows: ${refunded.slice(0, 12).join(", ")}`);
  ok("and finds the ones that are only PARTLY refunded",
     refunded.includes(53) || refunded.includes(93),
     "partial refunds keep status 'confirmed'-ish and must not be missed");

  await pick("select-refund-filter", /^Not refunded$/);
  await new Promise(r => setTimeout(r, 2500));
  const notRefunded = await rowIds();
  ok("'Not refunded' excludes every refunded booking",
     notRefunded.length > 0 && !notRefunded.some(id => expected.includes(id)),
     `${notRefunded.length} rows`);

  // Daniel's exact combination: Technification + Refunded → nothing is refunded
  // in that programme, so the list must be empty, not full.
  await pick("select-refund-filter", /^Refunded$/);
  await pick("select-camp-filter", /Technification/);
  await new Promise(r => setTimeout(r, 3000));
  const tech = await rowIds();
  ok("🔴 Technification + Refunded shows NOTHING (nothing in it was refunded)",
     tech.length === 0, `${tech.length} rows`);
  await page.screenshot({ path: join(outDir, "filters-refunded-empty.png"), clip: { x: 330, y: 60, width: 1110, height: 320 } });

  console.log(`\nscreenshots → outputs/ui-preflight/clubos-registrations/`);
} finally {
  if (browser) await browser.close();
  if (uid) { await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`,[uid]); await pool.query(`DELETE FROM users WHERE id=$1`,[uid]); }
  await pool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
