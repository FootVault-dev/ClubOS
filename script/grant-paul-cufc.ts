/**
 * Grant Paul Holocher scoped access to the CUFC workspace.
 *
 *   npx tsx --env-file=.env script/grant-paul-cufc.ts            # dry run (rolls back)
 *   npx tsx --env-file=.env script/grant-paul-cufc.ts --commit   # writes
 *
 * Why scoped and not admin: `canAccessTab` returns true for EVERY tab when the
 * membership role is `admin`/`manager`, AND when `tabs` is null. Either one
 * turns "see the academy" into "see Sponsorship, Proposals, Grants, Hiring and
 * Content too". So this writes role=team_member with an explicit, non-null
 * array — the only combination that actually scopes anything.
 *
 * There is no unique constraint on (user_id, organization_id), so a second run
 * would happily create a duplicate membership. This refuses instead.
 */
import { Pool } from "pg";
import { tabsForOrgSlug, SUPER_ADMIN_ONLY_TABS, canAccessTab } from "../shared/tabs";

const USER_ID = 4;          // Paul Holocher
const ORG_SLUG = "christchurch-united";

/** What an Academy Director needs, and nothing else. */
const GRANT = [
  "dashboard",       // the workspace landing page
  "academy",         // programmes, term timetable, session rolls, coach roster
  "registrations",   // who has registered and paid
  "squads",          // the club's teams and who is in them
  "open-trainings",  // the invite-only funnel he is personally named on
  "contacts",        // look up a player or call a guardian
];

const commit = process.argv.includes("--commit");

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    const u = (await c.query(
      `select id,email,first_name,last_name,role,active from users where id=$1`, [USER_ID])).rows[0];
    if (!u) throw new Error(`user ${USER_ID} not found`);
    if (`${u.first_name} ${u.last_name}` !== "Paul Holocher")
      throw new Error(`user ${USER_ID} is ${u.first_name} ${u.last_name}, not Paul Holocher — refusing`);
    if (!u.active) throw new Error("account is inactive");

    const org = (await c.query(
      `select id,slug,name from organizations where slug=$1`, [ORG_SLUG])).rows[0];
    if (!org) throw new Error(`org ${ORG_SLUG} not found`);

    const existing = await c.query(
      `select id,role,tabs from user_organizations where user_id=$1 and organization_id=$2`,
      [USER_ID, org.id]);
    if (existing.rowCount) {
      throw new Error(
        `Paul ALREADY has a membership in ${org.slug} ` +
        `(role=${existing.rows[0].role}, tabs=${JSON.stringify(existing.rows[0].tabs)}). ` +
        `No unique constraint exists, so inserting would duplicate it. Update that row instead.`);
    }

    // Every slug must really exist in THIS workspace type, or it grants nothing silently.
    const valid = new Set(tabsForOrgSlug(ORG_SLUG).map(t => t.slug));
    const unknown = GRANT.filter(s => !valid.has(s));
    if (unknown.length) throw new Error(`not tabs in this workspace: ${unknown.join(", ")}`);
    const locked = GRANT.filter(s => SUPER_ADMIN_ONLY_TABS.has(s));
    if (locked.length) throw new Error(`super-admin-only, cannot be granted: ${locked.join(", ")}`);

    await c.query(
      `insert into user_organizations (user_id, organization_id, role, tabs)
       values ($1,$2,'team_member',$3::jsonb)`,
      [USER_ID, org.id, JSON.stringify(GRANT)]);

    const row = (await c.query(
      `select role, tabs from user_organizations where user_id=$1 and organization_id=$2`,
      [USER_ID, org.id])).rows[0];

    // Prove the effect rather than assume it: ask the real function, tab by tab.
    console.log(`\n${u.first_name} ${u.last_name} <${u.email}>  →  ${org.name}`);
    console.log(`role=${row.role}  tabs=${JSON.stringify(row.tabs)}\n`);
    const all = tabsForOrgSlug(ORG_SLUG);
    const can = (slug: string) => canAccessTab({
      globalRole: u.role, membershipRole: row.role, membershipTabs: row.tabs, tabSlug: slug });
    console.log("  CAN SEE:");
    all.filter(t => can(t.slug)).forEach(t => console.log(`     ✅ ${t.title}  (${t.slug})`));
    console.log("  CANNOT SEE:");
    all.filter(t => !can(t.slug)).forEach(t => console.log(`     ·  ${t.title}  (${t.slug})`));

    const granted = all.filter(t => can(t.slug)).map(t => t.slug).sort();
    if (JSON.stringify(granted) !== JSON.stringify([...GRANT].sort()))
      throw new Error(`effective access ${JSON.stringify(granted)} != intended — refusing`);

    if (commit) { await c.query("COMMIT"); console.log("\n✅ COMMITTED"); }
    else { await c.query("ROLLBACK"); console.log("\n🔄 DRY RUN — rolled back. Re-run with --commit"); }
  } catch (e: any) {
    await c.query("ROLLBACK");
    console.error("\n🔴 ROLLED BACK:", e.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}
main();
