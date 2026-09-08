/**
 * _verify-unpaid-hidden-live.ts — "if you ain't paid you ain't registered".
 *
 * Daniel, 2026-09-08: "parents and players should only appear in ClubOS if
 * they've paid and confirmed — don't mix pending up." This proves, against
 * production and as an ordinary CUFC workspace admin, that an unfinished
 * online checkout reaches no staff screen: not the programme Players tab or
 * its tiles, not People, not Contacts, not a person's card, not search — while
 * a paid family is still everywhere it should be.
 *
 *   npx tsx --env-file=.env script/_verify-unpaid-hidden-live.ts [--no-browser]
 */
import pg from "pg";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import fs from "node:fs";

const BASE = process.env.RENDER_CHECK_BASE || "https://app.usg.co.nz";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const NO_BROWSER = process.argv.includes("--no-browser");
const SHOTS = "/Users/danielmeyn/Desktop/AIOS/DanielMeynOS/outputs/clubos/2026-09-08-unpaid-hidden";
const PROG = 4; // FUNiño U4–U8, the screen Daniel was looking at
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = async (s: string, p: any[] = []) => (await pool.query(s, p)).rows;

let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); };
const users: number[] = [];
let browser: any = null;
const REAL = `('confirmed','refunded','partially_refunded')`;

try {
  // ── the ground truth, straight from the database ─────────────────────────
  const [{ real, pending }] = await q(`select count(*) filter (where status in ${REAL})::int real, count(*) filter (where status='pending')::int pending from registrations where program_id=$1`, [PROG]);
  const [{ n: realPlayers }] = await q(`select count(distinct r.contact_id)::int n from registrations r join contacts c on c.id=r.contact_id where r.program_id=$1 and r.status in ${REAL} and c.type='player'`, [PROG]);
  ok("fixture: programme has both real and pending rows", real > 0 && pending > 0, `${real} real · ${pending} pending`);
  // a guardian whose ONLY tie is an unfinished checkout, and a paid guardian
  const [hidden] = await q(`select c.id, c.first_name, c.last_name, c.email from contacts c where c.type='guardian' and c.friendly_manager_id is null
    and exists (select 1 from registrations r where (r.contact_id=c.id or r.guardian_id=c.id) and r.status='pending' and r.program_id=$1)
    and not exists (select 1 from registrations r where (r.contact_id=c.id or r.guardian_id=c.id) and r.status in ${REAL}) limit 1`, [PROG]);
  const [paid] = await q(`select c.id, c.first_name, c.last_name from contacts c where c.type='guardian' and exists (select 1 from registrations r where r.guardian_id=c.id and r.status='confirmed' and r.program_id=$1) limit 1`, [PROG]);
  const [pendOrder] = await q(`select order_number from registrations where status='pending' and order_number is not null order by id desc limit 1`);
  ok("fixture: an unpaid-only parent and a paid parent exist", !!hidden && !!paid, `${hidden?.first_name} ${hidden?.last_name} · ${paid?.first_name} ${paid?.last_name}`);

  // ── an ordinary CUFC workspace admin ─────────────────────────────────────
  const email = `unpaidprobe-${crypto.randomBytes(4).toString("hex")}@example.com`;
  const password = crypto.randomBytes(16).toString("base64url");
  const u = await q(`INSERT INTO users (email, first_name, last_name, password, role, active) VALUES ($1,'Unpaid','Probe',$2,'admin',true) RETURNING id`, [email, await bcrypt.hash(password, 10)]);
  users.push(u[0].id);
  await q(`INSERT INTO user_organizations (user_id, organization_id, role, tabs) VALUES ($1, 1, 'admin', NULL)`, [u[0].id]);
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!login.ok) throw new Error(`login ${login.status}`);
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const get = async (path: string) => { const r = await fetch(`${BASE}${path}`, { headers: { cookie, "X-Workspace-Slug": "christchurch-united" } }); let j: any = null; try { j = await r.json(); } catch {} return { status: r.status, json: j }; };

  // Players tab
  const players = await get(`/api/admin/camps/${PROG}/players`);
  const playerRows: any[] = Array.isArray(players.json) ? players.json : [];
  ok("Players tab endpoint answers with a list", Array.isArray(players.json), `${players.status} ${Array.isArray(players.json) ? "" : JSON.stringify(players.json).slice(0, 120)}`);
  const statuses = new Set(playerRows.map((p: any) => p.status));
  ok("Players tab: no pending row", players.status === 200 && !statuses.has("pending") && !statuses.has("cancelled"), `statuses seen: ${[...statuses].join(", ")}`);
  ok("Players tab: every paid player still listed", playerRows.length === realPlayers, `${playerRows.length} listed · ${realPlayers} paid players in DB`);
  // Tiles
  const stats = await get(`/api/admin/camps/${PROG}/stats`);
  ok("Stats tile counts real registrations only", stats.json?.totalRegistrations === real, `tile ${stats.json?.totalRegistrations} · DB real ${real} · pending ${pending} excluded`);
  // People search
  const ppl = await get(`/api/admin/people?q=${encodeURIComponent(hidden.last_name)}&filter=parents`);
  const hitHidden = (ppl.json?.people || []).some((p: any) => p.id === hidden.id);
  ok("People: unpaid-only parent does not appear", ppl.status === 200 && !hitHidden);
  const ppl2 = await get(`/api/admin/people?q=${encodeURIComponent(paid.last_name)}&filter=parents`);
  ok("People: paid parent still appears", (ppl2.json?.people || []).some((p: any) => p.id === paid.id));
  // Contacts list
  const contacts = await get(`/api/admin/contacts`);
  ok("Contacts: unpaid-only parent not in the parents list", contacts.status === 200 && !(contacts.json?.parents || []).some((p: any) => p.id === hidden.id));
  ok("Contacts: paid parent still in the parents list", (contacts.json?.parents || []).some((p: any) => p.id === paid.id));
  // Person card
  const card = await get(`/api/admin/contacts/parent/${hidden.id}`);
  ok("Person card: an unpaid-only parent shows no registrations", card.status === 200 && (card.json?.registrations || []).length === 0, `${(card.json?.registrations || []).length} registrations returned`);
  const fam = await get(`/api/admin/people/contact-${paid.id}`);
  ok("Family view: paid parent's card still lists a real registration", fam.status === 200 && JSON.stringify(fam.json).includes('"status":"confirmed"'));
  // Search
  if (pendOrder?.order_number) {
    const s = await get(`/api/search?q=${encodeURIComponent(String(pendOrder.order_number))}`);
    const hits = JSON.stringify(s.json || "");
    ok("Search: a pending order number returns no registration", s.status === 200 && !hits.includes(`Order #${pendOrder.order_number}`), `order ${pendOrder.order_number}`);
  }

  // ── the actual screen ────────────────────────────────────────────────────
  if (!NO_BROWSER) {
    const puppeteer = (await import("puppeteer-core")).default;
    fs.mkdirSync(SHOTS, { recursive: true });
    browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
    const [cn, cv] = cookie.split("=");
    for (const [w, h, label] of [[390, 844, "phone"], [1440, 900, "desktop"]] as [number, number, string][]) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h });
      await page.setCookie({ name: cn, value: cv, domain: new URL(BASE).hostname, path: "/", httpOnly: true, secure: true });
      const errors: string[] = []; page.on("pageerror", (e: any) => errors.push(e.message));
      await page.goto(`${BASE}/admin/academy/${PROG}`, { waitUntil: "networkidle2", timeout: 60000 });
      await new Promise((r) => setTimeout(r, 2000));
      const text = await page.evaluate(() => document.body.innerText);
      ok(`${label}: no PENDING badge or chip on the programme page`, !/\bPENDING\b/i.test(text) || !/Pending \d+/.test(text) && !/\bPENDING\b/.test(text));
      ok(`${label}: no "Total Registrations" tile`, !/Total Registrations/i.test(text));
      ok(`${label}: no React errors`, errors.length === 0, errors[0] || "");
      await page.screenshot({ path: `${SHOTS}/programme-${PROG}-${label}.png` });
      await page.close();
    }
  }
} catch (e: any) { ok("threw", false, e.message); }
finally {
  if (browser) await browser.close().catch(() => {});
  for (const id of users) { await q(`DELETE FROM user_organizations WHERE user_id=$1`, [id]); await q(`DELETE FROM users WHERE id=$1`, [id]); }
  await pool.end();
}
console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
