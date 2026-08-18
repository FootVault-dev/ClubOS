// Live end-to-end verification of the Accommodation tab against production.
//   npx tsx --env-file=.env script/_verify-accommodation-live.ts
//
// Hits the deployed API with a real session and asserts the numbers the club
// will act on — not that a route answers, but that it answers correctly.
//
// The two that matter most:
//   * the tab is SEALED to an ordinary staff member (it carries door codes,
//     what each occupant owes, and unverified legal names);
//   * every figure it shows is derived, so the reported May–Sep total is
//     $7,668.57 to the cent and the Jan–May variance is the real one.
//
// Creates two throwaway users and deletes them at the end.
import { Pool, types as pgTypes } from "pg";
import bcrypt from "bcryptjs";

pgTypes.setTypeParser(pgTypes.builtins.DATE, (v) => v);

const BASE = process.env.VERIFY_BASE ?? "https://app.usg.co.nz";
const WS = "united-sports-group";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let pass = 0, fail = 0;
const ok = (cond: boolean, label: string, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(` FAIL  ${label}${extra ? `  — ${extra}` : ""}`); }
};
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

const made: number[] = [];
async function makeUser(role: string) {
  const email = `verify-accom-${role}-${Date.now()}@example.invalid`;
  const password = `T${Math.random().toString(36).slice(2)}!aA9`;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Verify','Accom',$2,$3,true) RETURNING id`,
    [email, await bcrypt.hash(password, 10), role]);
  made.push(u.id);
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login failed for ${role}: HTTP ${login.status}`);
  const cookie = (login.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
  return { userId: u.id as number, cookie };
}

const get = async (cookie: string, path: string) => {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie, "X-Workspace-Slug": WS } });
  return { status: r.status, body: r.status === 200 ? await r.json() : null as any };
};

try {
  console.log(`\nAccommodation — live verification against ${BASE}\n`);

  const admin = await makeUser("super_admin");
  const staff = await makeUser("coach");
  // The ordinary staffer needs a membership, or they would be refused for
  // having no workspace at all rather than for the tab being locked.
  const { rows: [org] } = await pool.query(`SELECT id FROM organizations WHERE slug = $1`, [WS]);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs)
     VALUES ($1,$2,'team_member',$3)`,
    [staff.userId, org.id, JSON.stringify(["housing"])]);

  // ── The lock ───────────────────────────────────────────────────────────────
  console.log("Access");
  // 🔴 The tab is in SUPER_ADMIN_ONLY_TABS, and a role never opens a locked tab.
  // Naming it in the member's own tab whitelist must NOT be enough — that is
  // exactly the hole `unlocked_tabs` exists to keep closed.
  for (const p of ["/api/admin/housing/overview", "/api/admin/housing/invoicing",
                   "/api/admin/housing/roster", "/api/admin/housing/actions"]) {
    const r = await get(staff.cookie, p);
    ok(r.status === 403, `an ordinary staff member is refused ${p}`, `got ${r.status}`);
  }
  const noWs = await fetch(`${BASE}/api/admin/housing/overview`, { headers: { cookie: admin.cookie } });
  ok(noWs.status === 400, "a request with no workspace header is refused, never answered unscoped", `got ${noWs.status}`);

  // ── Overview ───────────────────────────────────────────────────────────────
  console.log("\nOverview");
  const ov = await get(admin.cookie, "/api/admin/housing/overview");
  ok(ov.status === 200, "overview loads for a super admin", `got ${ov.status}`);
  const o = ov.body;
  ok(o.occupancy.rooms === 11, `11 lettable rooms (13 total, 2 reserve held aside)`, `got ${o.occupancy.rooms}`);
  ok(o.occupancy.reserveRooms === 2, "2 reserve beds counted separately", `got ${o.occupancy.reserveRooms}`);
  ok(o.houses.length === 5, "5 properties", `got ${o.houses.length}`);
  ok(o.compliance.roomUnconfirmed === 4, "4 stays flagged with an unconfirmed room", `got ${o.compliance.roomUnconfirmed}`);
  ok(o.compliance.legalNameUnverified === 27, "27 legal names not yet checked", `got ${o.compliance.legalNameUnverified}`);
  // 23, not 27: four of these people already existed in ClubOS and some of
  // those records carry a phone. The source documents themselves contain none.
  ok(o.compliance.missingPhone === 23, "23 people with no phone number anywhere", `got ${o.compliance.missingPhone}`);
  ok(o.compliance.personOverlaps > 0, "the one person recorded in two rooms at once is flagged", `got ${o.compliance.personOverlaps}`);
  ok(o.actions.open >= 18, "the compliance list and the data conflicts are both present", `got ${o.actions.open}`);
  ok(o.variance.rows === 2, "2 stays price differently from the club's own record", `got ${o.variance.rows}`);

  // ── The money ──────────────────────────────────────────────────────────────
  console.log("\nInvoicing");
  const inv = await get(admin.cookie, "/api/admin/housing/invoicing");
  ok(inv.status === 200, "the invoicing matrix loads", `got ${inv.status}`);
  const t = inv.body.totals;
  ok(inv.body.lines.length === 25, "25 stays (24 from the run sheet + the second Tiny House room)", `got ${inv.body.lines.length}`);
  ok(t.computedCents === 4637000, `everything recomputes to ${money(4637000)}`, `got ${money(t.computedCents)}`);

  const periods = await get(admin.cookie, "/api/admin/housing/periods");
  const maySep = (periods.body ?? []).find((p: any) => p.name.startsWith("May"));
  const janMay = (periods.body ?? []).find((p: any) => p.name.startsWith("Jan"));
  ok(!!maySep && maySep.computedCents === 766857,
    `May–Sep recomputes to $7,668.57 — the run sheet's own subtotal, to the cent`, `got ${maySep ? money(maySep.computedCents) : "no period"}`);
  ok(!!maySep && maySep.paidCents === 0, "nothing settled on May–Sep yet, as the run sheet says", `got ${maySep ? money(maySep.paidCents) : "?"}`);
  ok(!!janMay && janMay.computedCents === 3870143,
    `Jan–May recomputes to $38,701.43 against a stated $36,850.00`, `got ${janMay ? money(janMay.computedCents) : "no period"}`);
  ok(!!janMay && janMay.outstandingCents === 230000,
    `the $2,300 the two rate-change segments were never billed shows as outstanding`, `got ${janMay ? money(janMay.outstandingCents) : "?"}`);

  // 🔴 A room somebody is not in must never be asserted.
  const unconfirmed = inv.body.lines.filter((l: any) => !l.roomConfirmed);
  ok(unconfirmed.length === 4, "4 lines say the room is unconfirmed rather than naming one", `got ${unconfirmed.length}`);
  ok(unconfirmed.every((l: any) => l.location === "Room not confirmed"),
    "and none of them display a room they might not have been in");

  // A remuneration stay must not read as somebody paying nothing.
  const remun = inv.body.lines.filter((l: any) => l.isRemuneration);
  ok(remun.length === 9, "9 stays are a room inside a playing contract", `got ${remun.length}`);
  // 🔴 The same $30 power contribution was stored as RENT in the Jan–May rows
  // and as POWER in the May–Sep ones, because the source's single
  // "Rent p/w & Power" column cannot say which it is. One arrangement, two
  // shapes — so the tab would have said Ryan Feutz pays $30 rent when his rent
  // is in his playing contract. Both terms now record rent nil, power $30.
  ok(remun.every((l: any) => l.weeklyRentCents === 0),
    "every one of them shows NO rent — the room is in the contract",
    remun.filter((l: any) => l.weeklyRentCents !== 0).map((l: any) => l.sourceRef).join(", "));
  ok(remun.every((l: any) => l.weeklyUtilitiesCents === 3000 && l.computedCents > 0),
    "and each still owes $30/wk power — not zero owing");

  // ── Roster ─────────────────────────────────────────────────────────────────
  console.log("\nRoster");
  const roster = await get(admin.cookie, "/api/admin/housing/roster");
  ok(roster.status === 200, "the roster loads", `got ${roster.status}`);
  ok(roster.body.length === 27, "27 people", `got ${roster.body.length}`);
  ok(roster.body.filter((r: any) => r.status === "non_resident").length === 11,
    "11 squad players living off site are visible — they have no tenancy at all",
    `got ${roster.body.filter((r: any) => r.status === "non_resident").length}`);
  // Seven of the nine May–Sep stays are still running today; Owen Moyo left on
  // 3 July and Nori Yuki on 12 June, and both correctly read as former.
  ok(roster.body.filter((r: any) => r.status === "resident").length === 7,
    "7 people are living on site today, derived from live tenancies",
    `got ${roster.body.filter((r: any) => r.status === "resident").length}`);

  // ── Actions ────────────────────────────────────────────────────────────────
  console.log("\nActions and conflicts");
  const acts = await get(admin.cookie, "/api/admin/housing/actions");
  ok(acts.status === 200, "the action list loads", `got ${acts.status}`);
  const items = acts.body.items;
  ok(items.filter((i: any) => i.kind === "action").length === 7, "7 compliance actions", `got ${items.filter((i: any) => i.kind === "action").length}`);
  ok(items.filter((i: any) => i.kind === "conflict").length === 12, "12 recorded data conflicts", `got ${items.filter((i: any) => i.kind === "conflict").length}`);
  ok(items.some((i: any) => i.ref === "CONF-002" && i.open),
    "the $1,150-each billing gap is on the list and still open");
  ok(items.some((i: any) => i.ref === "ACT-002" && !i.open),
    "the action the club already completed is not shown as outstanding");

  // ── The rule that everything rests on ──────────────────────────────────────
  console.log("\nDerivation");
  const line = inv.body.lines.find((l: any) => l.sourceRef === "MS-04");
  ok(!!line && line.computedCents === 124857,
    "Owen Moyo's 38-day stay prices at $1,248.57 — from days, not from the sheet's rounded 5.3 weeks",
    `got ${line ? money(line.computedCents) : "not found"}`);
  const holiday = inv.body.lines.find((l: any) => l.sourceRef === "JM-02");
  ok(!!holiday && holiday.holidayWeeks === 2 && holiday.computedCents === 63000,
    "Ryan Feutz's 23 calendar weeks bill as 21 — the Christmas deduction is applied",
    `got ${holiday ? `${holiday.holidayWeeks}wk / ${money(holiday.computedCents)}` : "not found"}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
} catch (e: any) {
  console.error("\nVerification threw:", e?.message || e);
  fail++;
} finally {
  for (const id of made) {
    await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
  }
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}
