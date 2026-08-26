// Verify the Coding Budget against LIVE production.
//
//   npx tsx --env-file=.env script/_verify-coding-budget-live.ts
//
// Two halves, and the first matters more than the second.
//
//   1. THE GATE. The tab carries the club's payroll — eleven roles named
//      against a salary each. So the checks that matter are the ones that prove
//      a person who should not see it cannot: signed out, and signed in as a
//      workspace admin who is not a super admin. `canAccessTab` grants every
//      tab to an admin/manager membership, and the ONLY thing standing between
//      that and the salary list is the slug's presence in SUPER_ADMIN_ONLY_TABS.
//      That is worth asserting against the live server, not assuming.
//
//   2. THE DATA. The seed ran against this same database, so this re-reads it
//      the way the API does and checks the invariants survived: reserved codes
//      refuse transactions, NULL budgets did not become zeros, and the tree has
//      no orphans.
//
// Uses curl rather than fetch: node's outbound networking is broken on this
// machine (see the note in script/preflight-deploy.ts).
import { execFileSync } from "child_process";
import pg from "pg";

const PROD = process.env.VERIFY_ORIGIN || "https://app.usg.co.nz";
const ORG_ID = 7;

let pass = 0;
const fails: string[] = [];

function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fails.push(`${label}${detail ? " — " + detail : ""}`); console.log(`  ✗ ${label} ${detail}`); }
}

function status(path: string, method = "GET", headers: string[] = []): number {
  const args = ["-so", "/dev/null", "-w", "%{http_code}", "--max-time", "20", "-X", method];
  for (const h of headers) args.push("-H", h);
  args.push(PROD + path);
  try { return Number(execFileSync("curl", args).toString().trim()); }
  catch { return 0; }
}

function body(path: string, headers: string[] = []): string {
  const args = ["-s", "--max-time", "20"];
  for (const h of headers) args.push("-H", h);
  args.push(PROD + path);
  try { return execFileSync("curl", args).toString(); } catch { return ""; }
}

async function main() {
  console.log(`\n  Coding Budget — live checks against ${PROD}\n`);

  // ── 1. The route exists at all. 401 = deployed and gated; 404 = not shipped.
  console.log("  Deployment");
  const root = status("/api/admin/coding-budget");
  check("GET /api/admin/coding-budget is deployed", root !== 404,
    root === 404 ? "404 — the route is NOT on production" : `(${root})`);

  // ── 2. The gate. Every one of these must be refused.
  console.log("\n  Access — the tab carries the club's payroll");
  check("signed out → 401, not 200", root === 401, `got ${root}`);

  for (const [label, path] of [
    ["the account detail route", "/api/admin/coding-budget/accounts/1"],
    ["the transaction register", "/api/admin/coding-budget/transactions"],
  ]) {
    const s = status(path);
    check(`${label} refuses an anonymous caller`, s === 401, `got ${s}`);
  }

  for (const [label, path, method] of [
    ["creating a transaction", "/api/admin/coding-budget/transactions", "POST"],
    ["editing a code", "/api/admin/coding-budget/accounts/1", "PATCH"],
    ["deleting a transaction", "/api/admin/coding-budget/transactions/1", "DELETE"],
  ] as const) {
    const s = status(path, method);
    check(`${label} refuses an anonymous caller`, s === 401, `got ${s}`);
  }

  // A workspace header alone must not be a credential.
  const withHeader = status("/api/admin/coding-budget", "GET",
    ["X-Workspace-Slug: united-sports-group"]);
  check("a workspace header alone does not open it", withHeader === 401, `got ${withHeader}`);

  // The response must not leak anything before auth.
  const anon = body("/api/admin/coding-budget");
  const leaks = ["Chief Executive", "150000", "Business Development", "salary", "Academy Director"]
    .filter(w => anon.toLowerCase().includes(w.toLowerCase()));
  check("the 401 body leaks no salary data", leaks.length === 0, leaks.join(", "));

  // ── 3. The lock itself, read from the shipped code rather than assumed.
  console.log("\n  The lock");
  const { SUPER_ADMIN_ONLY_TABS, canAccessTab } = await import("@shared/tabs");
  check("`coding-budget` is in SUPER_ADMIN_ONLY_TABS",
    SUPER_ADMIN_ONLY_TABS.has("coding-budget"));

  // 🔴 The trap this exists to catch: a workspace ADMIN bypasses the tabs
  // whitelist entirely. If the slug ever leaves the locked set, this flips to
  // true and every USG admin gets the payroll.
  const adminReach = canAccessTab({
    globalRole: "user", membershipRole: "admin",
    membershipTabs: null, membershipUnlockedTabs: null, tabSlug: "coding-budget",
  } as any);
  check("a workspace ADMIN cannot reach it", adminReach === false);

  const managerReach = canAccessTab({
    globalRole: "user", membershipRole: "manager",
    membershipTabs: null, membershipUnlockedTabs: null, tabSlug: "coding-budget",
  } as any);
  check("a workspace MANAGER cannot reach it", managerReach === false);

  // A stale `tabs` grant must not open a locked tab — Dima's USG membership
  // literally carries tabs:["budget"] from an old grant.
  const whitelistReach = canAccessTab({
    globalRole: "user", membershipRole: "team_member",
    membershipTabs: ["coding-budget"], membershipUnlockedTabs: null, tabSlug: "coding-budget",
  } as any);
  check("the tabs whitelist alone cannot open it", whitelistReach === false);

  // And the two ways in that SHOULD work.
  const superReach = canAccessTab({
    globalRole: "super_admin", membershipRole: "admin",
    membershipTabs: null, membershipUnlockedTabs: null, tabSlug: "coding-budget",
  } as any);
  check("a super admin CAN reach it", superReach === true);

  const namedReach = canAccessTab({
    globalRole: "user", membershipRole: "team_member",
    membershipTabs: null, membershipUnlockedTabs: ["coding-budget"], tabSlug: "coding-budget",
  } as any);
  check("a person named in unlocked_tabs CAN reach it (this is Victor's way in)",
    namedReach === true);

  // ── 4. The data, read the way the API reads it.
  console.log("\n  The chart of accounts");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const n = await client.query(
      `select count(*)::int c from coding_accounts where organization_id = $1 and active`, [ORG_ID]);
    check("882 codes are seeded", n.rows[0].c === 882, `found ${n.rows[0].c}`);

    const tops = await client.query(
      `select count(*)::int c from coding_accounts where organization_id = $1 and depth = 1`, [ORG_ID]);
    check("30 top-level streams", tops.rows[0].c === 30, `found ${tops.rows[0].c}`);

    const orphans = await client.query(
      `select count(*)::int c from coding_accounts
        where organization_id = $1 and depth > 1 and parent_id is null`, [ORG_ID]);
    check("no orphaned codes", orphans.rows[0].c === 0, `${orphans.rows[0].c} orphans`);

    // 🔴 NULL and 0 must still be different things.
    const nulls = await client.query(
      `select count(*)::int c from coding_accounts
        where organization_id = $1 and budget_excl_cents is null`, [ORG_ID]);
    const zeros = await client.query(
      `select count(*)::int c from coding_accounts
        where organization_id = $1 and budget_excl_cents = 0`, [ORG_ID]);
    check("800 lines are unbudgeted (NULL, not zero)", nulls.rows[0].c === 800, `found ${nulls.rows[0].c}`);
    check("35 lines are budgeted at an explicit zero", zeros.rows[0].c === 35, `found ${zeros.rows[0].c}`);

    // The budget reconciles the way the page reports it.
    const b = await client.query(
      `select kind, sum(budget_excl_cents)::bigint ex, sum(budget_incl_cents)::bigint inc
         from coding_accounts where organization_id = $1 and depth = 1 and active
        group by kind`, [ORG_ID]);
    const inc = b.rows.find(r => r.kind === "income");
    const exp = b.rows.find(r => r.kind === "expense");
    check("income excl. GST is $2,762,909", Number(inc?.ex) === 276290900, String(inc?.ex));
    check("expenses excl. GST is $2,786,525", Number(exp?.ex) === 278652500, String(exp?.ex));
    check("the net position is a $23,616 deficit",
      Number(inc?.ex) - Number(exp?.ex) === -2361600,
      String(Number(inc?.ex) - Number(exp?.ex)));
    // The finding, asserted so it cannot quietly change under us.
    check("the workbook's stated income total is still $28,750 adrift",
      Number(inc?.inc) - 298914500 === 2875000, String(Number(inc?.inc) - 298914500));

    // 🔴 The invariant, proven live rather than assumed: money cannot be coded
    //    to a control row. Attempted inside a rolled-back transaction.
    await client.query("BEGIN");
    const [ctl] = (await client.query(
      `select id, code from coding_accounts
        where organization_id = $1 and treatment = 'subtotal' limit 1`, [ORG_ID])).rows;
    let refused = false;
    try {
      await client.query(
        `insert into coding_transactions
           (organization_id, coding_account_id, occurred_on, amount_excl_cents)
         values ($1,$2,'2026-08-26',10000)`, [ORG_ID, ctl.id]);
    } catch { refused = true; }
    await client.query("ROLLBACK");
    check(`production refuses a transaction coded to control row ${ctl.code}`, refused);

    // Reserved income codes 14–20 must equally refuse one.
    await client.query("BEGIN");
    const [rsv] = (await client.query(
      `select id, code from coding_accounts
        where organization_id = $1 and treatment = 'reserved' limit 1`, [ORG_ID])).rows;
    let refusedReserved = false;
    if (rsv) {
      try {
        await client.query(
          `insert into coding_transactions
             (organization_id, coding_account_id, occurred_on, amount_excl_cents)
           values ($1,$2,'2026-08-26',10000)`, [ORG_ID, rsv.id]);
      } catch { refusedReserved = true; }
    }
    await client.query("ROLLBACK");
    check(`production refuses a transaction coded to reserved code ${rsv?.code}`, refusedReserved);

    // RLS is still on.
    const rls = await client.query(
      `select relname, relrowsecurity from pg_class
        where relname in ('coding_accounts','coding_transactions')`);
    check("RLS is enabled on both tables",
      rls.rows.length === 2 && rls.rows.every(r => r.relrowsecurity));
  } finally {
    await client.end();
  }

  console.log(`\n  ${pass} passed, ${fails.length} failed\n`);
  if (fails.length) {
    for (const f of fails) console.log(`    ✗ ${f}`);
    console.log();
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
