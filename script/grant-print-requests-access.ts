// Gives a staff member the United Prints "Requests" tab — and nothing else in
// that workspace.
//
//   npx tsx --env-file=.env script/grant-print-requests-access.ts                 (dry run, lists everyone)
//   npx tsx --env-file=.env script/grant-print-requests-access.ts travis@cufc.co.nz --commit
//   npx tsx --env-file=.env script/grant-print-requests-access.ts travis@cufc.co.nz --revoke --commit
//
// 🔴 The role MUST be `team_member`. canAccessTab() grants EVERY tab to a member
// whose workspace role is admin or manager, so making someone an admin of
// United Prints to "let them see Requests" actually hands them Sales (458
// prospects), Materials (the live public price list), Orders, Warehouse, the
// CRM and the print P&L. team_member + tabs:["requests"] is the only shape that
// means what it says.
//
// Approving/declining is a separate check (canDecide in print-request-routes.ts)
// on the same workspace role — so a team_member can submit and read, never
// decide, and that holds server-side no matter what the browser sends.

import "dotenv/config";
import pg from "pg";

const UNITED_PRINTS_ORG_ID = 8;
const TAB = "requests";

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const REVOKE = args.includes("--revoke");
const email = args.find((a) => a.includes("@"))?.toLowerCase();

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;

  const current = await q(
    `select u.id, u.email, u.first_name, u.last_name, u.role as global_role, uo.role, uo.tabs
       from user_organizations uo join users u on u.id = uo.user_id
      where uo.organization_id = $1 order by u.id`,
    [UNITED_PRINTS_ORG_ID],
  );

  console.log(`United Prints workspace (org ${UNITED_PRINTS_ORG_ID}) — ${current.length} member(s):\n`);
  for (const m of current) {
    const tabs = m.tabs === null ? "ALL TABS" : (Array.isArray(m.tabs) && m.tabs.length ? m.tabs.join(", ") : "none");
    const decides = m.global_role === "super_admin" || m.role === "admin" || m.role === "manager";
    console.log(`  #${m.id} ${m.email}`);
    console.log(`      ${m.role} · tabs: ${tabs} · ${decides ? "CAN approve/decline requests" : "can submit only"}`);
  }

  if (!email) {
    console.log(`\nPass an email to grant or revoke. Nothing changed.`);
    await pool.end();
    return;
  }

  const [user] = await q(`select id, email, first_name, last_name, role from users where lower(email) = $1`, [email]);
  if (!user) {
    // Never create a login to make a grant succeed — that is a person, not a row.
    console.error(`\n✗ No ClubOS account for ${email}. Create the account first.`);
    await pool.end();
    process.exit(1);
  }

  const existing = current.find((m: any) => m.id === user.id);
  const who = `#${user.id} ${[user.first_name, user.last_name].filter(Boolean).join(" ")} <${user.email}>`;

  if (REVOKE) {
    if (!existing) {
      console.log(`\n${who} isn't in this workspace. Nothing to revoke.`);
      await pool.end();
      return;
    }
    console.log(`\n${COMMIT ? "REVOKING" : "WOULD REVOKE"} United Prints access from ${who}`);
    if (COMMIT) {
      await q(`delete from user_organizations where user_id = $1 and organization_id = $2`, [user.id, UNITED_PRINTS_ORG_ID]);
      console.log(`✓ removed`);
    } else {
      console.log(`(dry run — add --commit)`);
    }
    await pool.end();
    return;
  }

  if (existing) {
    // 🔴 Never silently widen or narrow someone who is already a member. An
    // existing admin has that role for a reason, and dropping them to
    // team_member here would strip access they use every day.
    if (existing.role === "admin" || existing.role === "manager") {
      console.log(`\n⚠️  ${who} is already ${existing.role} of United Prints — they can already see Requests`);
      console.log(`    AND approve them. Left untouched; narrowing that is a deliberate decision, not a side effect.`);
      await pool.end();
      return;
    }
    const tabs: string[] = Array.isArray(existing.tabs) ? existing.tabs : [];
    if (existing.tabs === null) {
      console.log(`\n⚠️  ${who} has tabs: null (every tab) in United Prints. Left untouched.`);
      await pool.end();
      return;
    }
    if (tabs.includes(TAB)) {
      console.log(`\n✓ ${who} already has the Requests tab. Nothing to do.`);
      await pool.end();
      return;
    }
    const next = [...tabs, TAB];
    console.log(`\n${COMMIT ? "GRANTING" : "WOULD GRANT"} the Requests tab to ${who}`);
    console.log(`    tabs: [${tabs.join(", ")}] → [${next.join(", ")}]  (role stays ${existing.role})`);
    if (COMMIT) {
      await q(`update user_organizations set tabs = $3 where user_id = $1 and organization_id = $2`,
        [user.id, UNITED_PRINTS_ORG_ID, JSON.stringify(next)]);
    }
  } else {
    console.log(`\n${COMMIT ? "ADDING" : "WOULD ADD"} ${who} to United Prints`);
    console.log(`    role: team_member · tabs: ["${TAB}"]`);
    console.log(`    → can submit + track requests. CANNOT approve, and cannot see Sales, Materials,`);
    console.log(`      Orders, Warehouse, CRM or anything else in the workspace.`);
    if (COMMIT) {
      await q(`insert into user_organizations (user_id, organization_id, role, tabs) values ($1, $2, 'team_member', $3)`,
        [user.id, UNITED_PRINTS_ORG_ID, JSON.stringify([TAB])]);
    }
  }

  if (!COMMIT) {
    console.log(`\n(dry run — re-run with --commit)`);
    await pool.end();
    return;
  }

  // Verify by re-reading, not by trusting the write.
  const [after] = await q(
    `select uo.role, uo.tabs from user_organizations uo where uo.user_id = $1 and uo.organization_id = $2`,
    [user.id, UNITED_PRINTS_ORG_ID],
  );
  const okRole = after?.role === "team_member";
  const okTabs = Array.isArray(after?.tabs) && after.tabs.includes(TAB);
  console.log(`\n${okRole && okTabs ? "✓" : "✗"} now: role ${after?.role} · tabs ${JSON.stringify(after?.tabs)}`);
  if (!okRole) console.log(`  ⚠️  role is not team_member — they may see more than Requests.`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
