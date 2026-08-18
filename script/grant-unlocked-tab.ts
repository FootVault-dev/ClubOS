// Let a NAMED person into a locked tab (SUPER_ADMIN_ONLY_TABS), or take it away.
//
//   npx tsx --env-file=.env script/grant-unlocked-tab.ts --list
//   npx tsx --env-file=.env script/grant-unlocked-tab.ts <email> <tab> <workspace-slug>
//   npx tsx --env-file=.env script/grant-unlocked-tab.ts <email> <tab> <workspace-slug> --commit
//   npx tsx --env-file=.env script/grant-unlocked-tab.ts <email> <tab> <workspace-slug> --revoke --commit
//
//   e.g. script/grant-unlocked-tab.ts ryan@cufc.co.nz vehicles united-sports-group --commit
//
// Why this exists rather than deleting a line from SUPER_ADMIN_ONLY_TABS: that
// would open the tab to every admin and manager of the workspace, because
// `canAccessTab` never consults the tabs whitelist for those roles. Half the
// locked tabs hold salary, tenancy, child or staff-personal data, so "let one
// person in" and "let the leadership team in" must not be the same action.
//
// Dry run by default. Refuses a tab that isn't locked (use the Team page for
// those), and refuses a tab that doesn't exist in that workspace — a grant that
// names a tab the workspace never renders is a grant nobody can use, and it
// would read as access that had been given.
import pg from "pg";
import { SUPER_ADMIN_ONLY_TABS, tabsForOrgSlug } from "../shared/tabs";

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const REVOKE = args.includes("--revoke");
const LIST = args.includes("--list");
const positional = args.filter((a) => !a.startsWith("--"));

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    if (LIST) {
      const { rows } = await client.query(
        `select u.email, u.first_name || ' ' || coalesce(u.last_name,'') as name,
                o.slug as workspace, uo.role, uo.unlocked_tabs
           from user_organizations uo
           join users u on u.id = uo.user_id
           join organizations o on o.id = uo.organization_id
          where uo.unlocked_tabs is not null and jsonb_array_length(uo.unlocked_tabs) > 0
          order by o.slug, u.email`,
      );
      console.log(`\n  Locked-tab grants (${rows.length}):\n`);
      for (const r of rows) {
        console.log(`  ${String(r.name).padEnd(20)} ${String(r.email).padEnd(28)} ${r.workspace}  →  ${(r.unlocked_tabs as string[]).join(", ")}`);
      }
      console.log(
        `\n  Everyone else reaches a locked tab only by being a global super admin.\n`,
      );
      return;
    }

    const [email, tab, workspace] = positional;
    if (!email || !tab || !workspace) {
      console.error("\n  usage: grant-unlocked-tab.ts <email> <tab> <workspace-slug> [--revoke] [--commit]");
      console.error("         grant-unlocked-tab.ts --list\n");
      process.exit(1);
    }

    if (!SUPER_ADMIN_ONLY_TABS.has(tab)) {
      console.error(
        `\n  "${tab}" is not a locked tab, so this column is the wrong tool for it.\n` +
          `  Grant it the normal way: /admin/team → the member → tick the tab.\n`,
      );
      process.exit(1);
    }
    if (!tabsForOrgSlug(workspace).some((t) => t.slug === tab)) {
      console.error(
        `\n  The "${tab}" tab does not exist in the "${workspace}" workspace, so a grant\n` +
          `  there would look like access without being any. Pick the workspace the tab\n` +
          `  actually lives in.\n`,
      );
      process.exit(1);
    }

    console.log(`\n  ${REVOKE ? "REVOKE" : "GRANT"} "${tab}" ${REVOKE ? "from" : "to"} ${email} in ${workspace}`);
    console.log(`  ${COMMIT ? "COMMIT" : "DRY RUN (rolled back)"}\n`);

    await client.query("BEGIN");
    const { rows } = await client.query(
      `select uo.id, uo.unlocked_tabs, uo.role, u.id as user_id,
              u.first_name || ' ' || coalesce(u.last_name,'') as name, u.role as global_role
         from user_organizations uo
         join users u on u.id = uo.user_id
         join organizations o on o.id = uo.organization_id
        where lower(u.email) = lower($1) and o.slug = $2`,
      [email, workspace],
    );
    if (!rows.length) {
      throw new Error(`${email} is not a member of the "${workspace}" workspace — add them in /admin/team first`);
    }
    const m = rows[0];
    const current: string[] = Array.isArray(m.unlocked_tabs) ? m.unlocked_tabs : [];
    const next = REVOKE ? current.filter((t) => t !== tab) : Array.from(new Set([...current, tab]));

    console.log(`  ${m.name} (user ${m.user_id}, ${m.global_role}, ${m.role} in this workspace)`);
    console.log(`  before: ${current.length ? current.join(", ") : "(none)"}`);
    console.log(`  after:  ${next.length ? next.join(", ") : "(none)"}`);

    await client.query(`update user_organizations set unlocked_tabs = $1::jsonb where id = $2`, [
      JSON.stringify(next),
      m.id,
    ]);

    const check = await client.query(`select unlocked_tabs from user_organizations where id = $1`, [m.id]);
    const saved: string[] = (check.rows[0].unlocked_tabs as string[]) ?? [];
    const held = saved.includes(tab);
    if (held === REVOKE) throw new Error("verification failed — the grant did not change as expected");
    console.log(`  ✓ ${REVOKE ? "revoked" : "granted"}`);

    if (COMMIT) {
      await client.query("COMMIT");
      console.log(`\n  Committed. Takes effect on their next request — no deploy, no re-login.\n`);
    } else {
      await client.query("ROLLBACK");
      console.log("\n  Rolled back (dry run). Re-run with --commit.\n");
    }
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\n  FAILED: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
