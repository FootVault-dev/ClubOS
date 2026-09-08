/**
 * _verify-venue-manual-size-live.ts — can staff enter a HALF or QUARTER pitch
 * booking in the USC calendar, and does it land the way the public site sells it?
 *
 * Travis, 2026-09-08: no ½ or ¼ option when entering a booking manually. The
 * public site sold half (front|back) and quarter (Q1–Q4) on S1–S4, but the admin
 * New Booking form never offered a size and the admin create route never read
 * one — so every staff-entered booking blocked the whole pitch.
 *
 * API half (against production, as an ordinary USC workspace admin):
 *   half front / quarter q3 stored · full stores NULL · a half on the meeting
 *   room is refused · a half with no side is refused · size rides the primary
 *   facility only · PATCH validates too · the public availability feed shows the
 *   stored size (which is what lets a parent book the other half).
 * Browser half: open /admin/calendar as that user, click New Booking, choose S1,
 *   and assert the Field size picker is on screen at phone and desktop widths.
 *
 *   npx tsx --env-file=.env script/_verify-venue-manual-size-live.ts [--no-browser]
 */
import pg from "pg";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import fs from "node:fs";
import { cellsOverlap } from "../shared/field-cells";

const BASE = process.env.RENDER_CHECK_BASE || "https://app.usg.co.nz";
const ORG = 4; // United Sports Centre
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const NO_BROWSER = process.argv.includes("--no-browser");
const SHOTS = "/Users/danielmeyn/Desktop/AIOS/DanielMeynOS/outputs/venue/2026-09-08-manual-field-size";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); };
const users: number[] = [];
const bookingIds: number[] = [];
const PROBE = `PROBE-size-${crypto.randomBytes(3).toString("hex")}`;
const DATE = "2027-03-15"; // a Monday far out; USC's advance window is unlimited
let browser: any = null;

async function mkUser() {
  const email = `${PROBE.toLowerCase()}@example.com`;
  const password = crypto.randomBytes(16).toString("base64url");
  const r = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Size','Probe',$2,'admin',true) RETURNING id`, [email, await bcrypt.hash(password, 10)]);
  users.push(r.rows[0].id);
  // Exactly Zach's / Isaac's USC shape: workspace admin, three tabs.
  await pool.query(`INSERT INTO user_organizations (user_id, organization_id, role, tabs)
                    VALUES ($1, $2, 'admin', '["calendar","dashboard","booking-requests"]'::jsonb)`, [r.rows[0].id, ORG]);
  return { email, password };
}
async function login(email: string, password: string) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(`login failed ${r.status}`);
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
const call = async (cookie: string, method: string, path: string, body?: any) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { cookie, "X-Workspace-Slug": "united-sports-centre", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json: any = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
};
const base = (facilityId: number, start: string, end: string, extra: any = {}) => ({
  organizationId: ORG, facilityId, customerName: PROBE, customerEmail: `${PROBE.toLowerCase()}@example.com`,
  bookingDate: DATE, startTime: start, endTime: end, totalAmount: "0", ...extra,
});
const remember = (j: any) => { if (j?.id) bookingIds.push(j.id); if (Array.isArray(j?.bookings)) for (const b of j.bookings) bookingIds.push(b.id); };

try {
  const u = await mkUser();
  const cookie = await login(u.email, u.password);
  const facs = (await call(cookie, "GET", `/api/admin/venue/facilities?orgId=${ORG}`)).json as any[];
  const s1 = facs.find((f) => f.id === 1); const s2 = facs.find((f) => f.id === 2); const room = facs.find((f) => f.id === 5);
  ok("facilities loaded as a USC admin", Array.isArray(facs) && !!s1 && !!room, `${facs?.length} facilities`);
  ok("S1 is split (half + quarter)", !!s1?.halfFull && !!s1?.quarterField);
  ok("meeting room is not split", !room?.halfFull && !room?.quarterField);

  // 1. half front
  let r = await call(cookie, "POST", "/api/admin/venue/bookings", base(1, "06:00", "06:45", { halfFull: "half", halfPosition: "front" }));
  remember(r.json);
  ok("POST half/front on S1 → 200", r.status === 200, `${r.status} ${r.json?.message || ""}`);
  ok("stored halfFull=half halfPosition=front", r.json?.halfFull === "half" && r.json?.halfPosition === "front", `${r.json?.halfFull}/${r.json?.halfPosition}`);
  const halfId = r.json?.id;

  // 2. quarter q3
  r = await call(cookie, "POST", "/api/admin/venue/bookings", base(1, "07:00", "07:30", { halfFull: "quarter", halfPosition: "q3" }));
  remember(r.json);
  ok("POST quarter/q3 on S1 → stored", r.status === 200 && r.json?.halfFull === "quarter" && r.json?.halfPosition === "q3", `${r.status} ${r.json?.halfFull}/${r.json?.halfPosition}`);

  // 3. full stores NULL (matches every pre-existing manual row)
  r = await call(cookie, "POST", "/api/admin/venue/bookings", base(1, "08:00", "08:30", { halfFull: "full" }));
  remember(r.json);
  ok("POST full → halfFull stored NULL", r.status === 200 && r.json?.halfFull == null && r.json?.halfPosition == null, `${r.json?.halfFull}/${r.json?.halfPosition}`);

  // 4. refused: half on a pitch that is never split
  r = await call(cookie, "POST", "/api/admin/venue/bookings", base(5, "06:00", "06:30", { halfFull: "half", halfPosition: "front" }));
  remember(r.json);
  ok("POST half on the meeting room → 400 with a reason", r.status === 400 && /half/i.test(r.json?.message || ""), `${r.status} ${r.json?.message || ""}`);

  // 5. refused: half with no side
  r = await call(cookie, "POST", "/api/admin/venue/bookings", base(1, "09:00", "09:30", { halfFull: "half" }));
  remember(r.json);
  ok("POST half with no front/back → 400", r.status === 400, `${r.status} ${r.json?.message || ""}`);

  // 6. size rides the primary facility only
  r = await call(cookie, "POST", "/api/admin/venue/bookings", base(1, "10:00", "10:30", { halfFull: "half", halfPosition: "back", additionalFacilityIds: [2] }));
  remember(r.json);
  const rows: any[] = r.json?.bookings || [];
  const p = rows.find((b) => b.facilityId === 1), x = rows.find((b) => b.facilityId === 2);
  ok("S1 + S2 as half/back: S1 row is half/back, S2 row is whole", r.status === 200 && p?.halfFull === "half" && p?.halfPosition === "back" && x && x.halfFull == null, `${r.status} S1=${p?.halfFull}/${p?.halfPosition} S2=${x?.halfFull}`);

  // 7. PATCH validates against the facility
  r = await call(cookie, "PATCH", `/api/admin/venue/bookings/${halfId}`, { halfFull: "quarter", halfPosition: "q2" });
  ok("PATCH half → quarter/q2 stored", r.status === 200 && r.json?.halfFull === "quarter" && r.json?.halfPosition === "q2", `${r.status} ${r.json?.halfFull}/${r.json?.halfPosition}`);
  r = await call(cookie, "PATCH", `/api/admin/venue/bookings/${halfId}`, { halfFull: "half", halfPosition: "left" });
  ok("PATCH half with a bad side → 400", r.status === 400, `${r.status} ${r.json?.message || ""}`);
  r = await call(cookie, "PATCH", `/api/admin/venue/bookings/${halfId}`, { facilityId: 5, halfFull: "half", halfPosition: "front" });
  ok("PATCH move a half onto the meeting room → 400", r.status === 400, `${r.status} ${r.json?.message || ""}`);
  r = await call(cookie, "PATCH", `/api/admin/venue/bookings/${halfId}`, { halfFull: "half", halfPosition: "front" });
  ok("PATCH back to half/front", r.status === 200 && r.json?.halfFull === "half" && r.json?.halfPosition === "front");

  // 8. what the PUBLIC site sees — the whole point: the other half stays bookable
  const avail = await fetch(`${BASE}/api/public/venue/${ORG}/availability?facilityId=1&dates=${DATE}`).then((x) => x.json()) as any[];
  const mine = avail.find((a) => a.startTime === "06:00" && a.endTime === "06:45");
  ok("public availability carries the size", mine?.halfFull === "half" && mine?.halfPosition === "front", JSON.stringify(mine));
  ok("shared cell model: back half does NOT collide with it", mine ? !cellsOverlap(mine.halfFull, mine.halfPosition, "half", "back") : false);
  ok("shared cell model: front half DOES collide with it", mine ? cellsOverlap(mine.halfFull, mine.halfPosition, "half", "front") : false);
  ok("shared cell model: a full pitch DOES collide with it", mine ? cellsOverlap(mine.halfFull, mine.halfPosition, null, null) : false);

  // ── Browser: is the picker actually on Travis's screen? ─────────────────
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
      try {
        await page.goto(`${BASE}/admin/calendar`, { waitUntil: "networkidle2", timeout: 60000 });
        await new Promise((r) => setTimeout(r, 1500));
        // Open New Booking (button text), pick S1 in the Radix select.
        const opened = await page.evaluate(() => {
          const b = Array.from(document.querySelectorAll("button")).find((x) => /new booking/i.test(x.textContent || ""));
          if (!b) return false; (b as HTMLButtonElement).click(); return true;
        });
        ok(`${label}: New Booking opens`, opened);
        await page.waitForSelector('[data-testid="select-booking-facility"]', { timeout: 10000 });
        await page.click('[data-testid="select-booking-facility"]');
        await page.waitForSelector('[role="option"]', { timeout: 10000 });
        const picked = await page.evaluate((name: string) => {
          const o = Array.from(document.querySelectorAll('[role="option"]')).find((x) => (x.textContent || "").trim() === name);
          if (!o) return false; (o as HTMLElement).click(); return true;
        }, s1.name);
        ok(`${label}: picked ${s1.name}`, picked);
        await new Promise((r) => setTimeout(r, 400));
        const picker = await page.$('[data-testid="booking-field-size"]');
        ok(`${label}: Field size picker is on screen`, !!picker);
        const sizes = await page.$$eval('[data-testid^="button-booking-size-"]', (els) => els.map((e) => e.textContent?.trim()));
        ok(`${label}: Full / ½ Half / ¼ Quarter offered`, sizes.length === 3, sizes.join(" · "));
        const half = await page.$('[data-testid="button-booking-size-half"]'); if (half) await half.click();
        await new Promise((r) => setTimeout(r, 300));
        ok(`${label}: front/back appears after choosing half`, !!(await page.$('[data-testid="button-booking-half-back"]')));
        const quarter = await page.$('[data-testid="button-booking-size-quarter"]'); if (quarter) await quarter.click();
        await new Promise((r) => setTimeout(r, 300));
        const qs = await page.$$('[data-testid^="button-booking-quarter-q"]');
        ok(`${label}: Q1–Q4 appears after choosing quarter`, qs.length === 4, `${qs.length} buttons`);
        // Nothing wider than the viewport (the phone rule).
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        ok(`${label}: no horizontal overflow`, overflow <= 0, `${overflow}px`);
        await page.screenshot({ path: `${SHOTS}/new-booking-quarter-${label}.png` });
        ok(`${label}: no React errors`, errors.length === 0, errors[0] || "");
      } catch (e: any) { ok(`${label}: browser walk`, false, e.message.slice(0, 120)); await page.screenshot({ path: `${SHOTS}/FAILED-${label}.png` }).catch(() => {}); }
      await page.close();
    }
  }
} catch (e: any) { ok("threw", false, e.message); }
finally {
  if (browser) await browser.close().catch(() => {});
  // Clean up every probe row, whether or not a step above kept its id.
  await pool.query(`DELETE FROM facility_bookings WHERE customer_name = $1`, [PROBE]);
  for (const id of users) { await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`, [id]); await pool.query(`DELETE FROM users WHERE id=$1`, [id]); }
  await pool.end();
}
console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed${NO_BROWSER ? " (API only)" : ""}\n`);
process.exit(fail === 0 ? 0 : 1);
