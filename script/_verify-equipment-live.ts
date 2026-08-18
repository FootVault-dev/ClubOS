// Prove the Equipment Register behaves — against LIVE rows and LIVE production.
//
//   npx tsx --env-file=.env script/_verify-equipment-live.ts
//
// Two halves, because the feature has two very different surfaces:
//
//  1. The GATE, over every real United Sports Group membership. The thing worth
//     asserting is not "Ryan can see Equipment" — it is "and the six other USG
//     admins still cannot", which is the half a change like this gets wrong.
//
//  2. The HOLDER LINK, over real HTTP against app.usg.co.nz. This is the new
//     and riskier surface: an unauthenticated endpoint that edits club data.
//     So it is exercised for real — a token reaching another team's items, a
//     retired holder's token, a rotated link, and the null-is-not-zero rule
//     that the whole audit rests on.
//
// Everything it creates is deleted at the end, youngest row first.
import pg from "pg";
import { canAccessTab } from "../shared/tabs";
import { makeHolderToken } from "../server/equipment-routes";
import { variance, auditStatus } from "../shared/equipment";

const BASE = process.env.VERIFY_BASE || "https://app.usg.co.nz";
const MARK = "verify-equipment@example.invalid";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const call = async (token: string, path: string, method = "GET", body?: unknown) => {
  const res = await fetch(`${BASE}/api/public/equipment${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
};

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // ── 1. The gate ───────────────────────────────────────────────────────────
  console.log("\nThe gate — every real United Sports Group membership\n");
  const { rows: members } = await client.query(
    `select u.id, u.email, u.role as global_role, uo.role as ws_role, uo.tabs, uo.unlocked_tabs
       from user_organizations uo
       join users u on u.id = uo.user_id
       join organizations o on o.id = uo.organization_id
      where o.slug = 'united-sports-group' order by u.id`,
  );
  const reach = (r: any, tab: string) =>
    canAccessTab({
      globalRole: r.global_role,
      membershipRole: r.ws_role,
      membershipTabs: Array.isArray(r.tabs) ? r.tabs : null,
      membershipUnlockedTabs: Array.isArray(r.unlocked_tabs) ? r.unlocked_tabs : null,
      tabSlug: tab,
    });

  const ryan = members.find(m => m.email === "ryan@cufc.co.nz");
  const travis = members.find(m => m.email === "travis@cufc.co.nz");
  ok("Ryan reaches Equipment", !!ryan && reach(ryan, "equipment"));
  ok("Travis reaches Equipment", !!travis && reach(travis, "equipment"));

  const others = members.filter(
    m => m.global_role !== "super_admin" && !["ryan@cufc.co.nz", "travis@cufc.co.nz"].includes(m.email),
  );
  const leaked = others.filter(m => reach(m, "equipment")).map(m => m.email);
  ok(`the other ${others.length} USG members still cannot`, leaked.length === 0, leaked.join(", "));

  // The grant must be surgical: it must not have opened anything else.
  const alsoBudget = [ryan, travis].filter(m => m && reach(m, "budget")).map(m => m!.email);
  ok("neither gained Budget", alsoBudget.length === 0, alsoBudget.join(", "));
  const alsoHousing = [ryan, travis].filter(m => m && reach(m, "housing")).map(m => m!.email);
  ok("neither gained Housing", alsoHousing.length === 0, alsoHousing.join(", "));
  ok("Travis is a team_member, so his tabs whitelist still bounds the unlocked ones",
    travis?.ws_role === "team_member");

  // ── 2. The holder link, over real HTTP ────────────────────────────────────
  console.log("\nThe holder link — live HTTP against " + BASE + "\n");
  const [{ id: orgId }] = (await client.query("select id from organizations where slug='united-sports-group'")).rows;

  const mk = async (team: string) =>
    (await client.query(
      `insert into equipment_holders (organization_id, team_name, person_name, email)
       values ($1,$2,'Verify Person',$3) returning id, link_version`,
      [orgId, team, MARK],
    )).rows[0];

  const a = await mk("VERIFY TEAM A");
  const b = await mk("VERIFY TEAM B");
  const tokenA = makeHolderToken(a.id, a.link_version).token;
  const tokenB = makeHolderToken(b.id, b.link_version).token;

  const me = await call(tokenA, "/me");
  ok("a valid link opens its own team", me.status === 200 && me.json?.holder?.teamName === "VERIFY TEAM A");

  ok("a garbage token is refused", (await call("eqh:1.1.9999999999999.deadbeef", "/me")).status === 401);
  ok("no token is refused", (await call("", "/me")).status === 401);

  const added = await call(tokenA, "/me/items", "POST", { name: "Verify balls", category: "balls", quantity: 22 });
  ok("the holder can add to their own list", added.status === 201, `HTTP ${added.status}`);
  const itemA = added.json?.item?.id;

  // The whole point of a per-holder token: it must not reach anybody else.
  const cross = await call(tokenB, `/me/items/${itemA}`, "PATCH", { quantity: 1 });
  ok("team B's link cannot touch team A's item", cross.status === 404, `HTTP ${cross.status}`);

  // ── The audit, and the rule the feature turns on ──────────────────────────
  const round = (await client.query(
    `insert into equipment_audit_rounds (organization_id, year, term_number, label, due_on)
     values ($1, 2999, 1, 'VERIFY ROUND', '2999-01-31') returning id`,
    [orgId],
  )).rows[0];

  const second = await call(tokenA, "/me/items", "POST", { name: "Verify bibs", category: "bibs", quantity: 24 });
  const itemB = second.json?.item?.id;

  // One line counted short, one line deliberately LEFT BLANK.
  const sub = await call(tokenA, "/me/audit", "POST", {
    counts: [{ itemId: itemA, counted: 18 }, { itemId: itemB, counted: null }],
    notes: "verification",
  });
  ok("the audit submits", sub.status === 200 && sub.json?.ok === true, `HTTP ${sub.status}`);

  const counts = (await client.query(
    `select c.item_name, c.quantity_before, c.counted_quantity
       from equipment_audit_counts c
       join equipment_audit_returns r on r.id = c.return_id
      where r.round_id = $1 order by c.item_name`,
    [round.id],
  )).rows;
  const bibs = counts.find(c => c.item_name === "Verify bibs");
  const balls = counts.find(c => c.item_name === "Verify balls");

  ok("an uncounted line is stored as NULL, not 0", bibs?.counted_quantity === null,
    `stored ${JSON.stringify(bibs?.counted_quantity)}`);
  ok("…and reads as 'not counted', never as a shortfall",
    variance({ expected: bibs?.quantity_before ?? null, counted: bibs?.counted_quantity ?? null }).kind === "not_counted");
  ok("a counted line freezes what the register said", balls?.quantity_before === 22);
  ok("…and reports the real shortfall",
    variance({ expected: balls.quantity_before, counted: balls.counted_quantity }).delta === -4);

  const afterA = (await client.query("select quantity from equipment_items where id=$1", [itemA])).rows[0];
  const afterB = (await client.query("select quantity from equipment_items where id=$1", [itemB])).rows[0];
  ok("a counted line updates the register", afterA?.quantity === 18);
  ok("an uncounted line leaves the register alone", afterB?.quantity === 24, `now ${afterB?.quantity}`);

  // Re-submitting must not erase the variance by moving the goalposts.
  await call(tokenA, "/me/audit", "POST", { counts: [{ itemId: itemA, counted: 19 }] });
  const reBalls = (await client.query(
    `select c.quantity_before, c.counted_quantity from equipment_audit_counts c
       join equipment_audit_returns r on r.id = c.return_id
      where r.round_id = $1 and c.item_name = 'Verify balls'`, [round.id],
  )).rows[0];
  ok("a correction keeps the ORIGINAL expected figure", reBalls?.quantity_before === 22,
    `quantity_before is ${reBalls?.quantity_before}`);
  ok("…and records the corrected count", reBalls?.counted_quantity === 19);

  ok("a submitted return reads as submitted, not overdue, even past its due date",
    auditStatus({ submittedAt: new Date().toISOString(), dueOn: "2020-01-01", todayIso: "2026-08-18" }) === "submitted");

  // ── Revocation bites on the next request, not on token expiry ─────────────
  await client.query("update equipment_holders set link_version = link_version + 1 where id=$1", [a.id]);
  ok("rotating the link kills the old one immediately", (await call(tokenA, "/me")).status === 401);

  await client.query("update equipment_holders set status='inactive' where id=$1", [b.id]);
  ok("a retired holder's link stops working", (await call(tokenB, "/me")).status === 403);

  // ── Cleanup, youngest first (returns→holders is RESTRICT) ─────────────────
  await client.query(
    `delete from equipment_audit_counts where return_id in
       (select id from equipment_audit_returns where round_id=$1)`, [round.id]);
  await client.query("delete from equipment_audit_returns where round_id=$1", [round.id]);
  await client.query("delete from equipment_audit_reminders where round_id=$1", [round.id]);
  await client.query("delete from equipment_audit_rounds where id=$1", [round.id]);
  await client.query("delete from equipment_items where holder_id = any($1::int[])", [[a.id, b.id]]);
  await client.query("delete from equipment_holders where email=$1", [MARK]);
  const left = (await client.query("select count(*)::int n from equipment_holders where email=$1", [MARK])).rows[0].n;
  ok("verification rows cleaned up", left === 0);

  await client.end();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
