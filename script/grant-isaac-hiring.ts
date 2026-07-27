// Give Isaac Living the Hiring tab in the United Sports Group workspace, scoped
// to the MFL and CIC brands only.
//
//   Rehearse:  npx tsx --env-file=.env script/grant-isaac-hiring.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/grant-isaac-hiring.ts
//
// Idempotent: re-running reconciles the membership to the intended state rather
// than adding a second one.
//
// The trap this script exists to avoid: role. `canAccessTab` returns true for
// EVERY tab when the membership role is admin or manager — the tab whitelist is
// not consulted at all. Isaac is admin of MFL and CIC, so the obvious move
// (mirror that role here) would hand him Sponsorship, Proposals, Invoices,
// Payouts, Budget and Cashflow in the group workspace. The role here must be
// team_member for the whitelist to mean anything.
import { Pool } from "pg";

const DRY_RUN = process.argv.includes("--dry-run");

const EMAIL = "info@minifootball.co.nz";       // Isaac Living
const ORG_SLUG = "united-sports-group";
const TABS = ["hiring"];
const HIRING_BRANDS = ["mfl", "cic"];          // NOT cufc — Marketing Manager etc. stay private
const ROLE = "team_member";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  console.log(DRY_RUN ? "\nDRY RUN — rolled back at the end.\n" : "\nAPPLYING.\n");
  await pool.query("BEGIN");

  const { rows: users } = await pool.query(
    "SELECT id, first_name, last_name, role FROM users WHERE lower(email) = lower($1)",
    [EMAIL],
  );
  if (users.length !== 1) throw new Error(`Expected exactly 1 user for ${EMAIL}, found ${users.length}`);
  const user = users[0];

  const { rows: orgs } = await pool.query("SELECT id, name FROM organizations WHERE slug = $1", [ORG_SLUG]);
  if (orgs.length !== 1) throw new Error(`Workspace ${ORG_SLUG} not found`);
  const org = orgs[0];

  console.log(`  user   ${user.first_name} ${user.last_name} (#${user.id}, global role ${user.role})`);
  console.log(`  org    ${org.name} (#${org.id})`);

  // A global role of super_admin would bypass the brand scope entirely. Isaac's
  // is team_member; assert rather than assume, because this is the whole point.
  if (user.role === "super_admin") {
    throw new Error("This user is a super admin — brand scoping does not apply to them. Aborting.");
  }

  const { rows: existing } = await pool.query(
    "SELECT id, role, tabs, hiring_brands FROM user_organizations WHERE user_id = $1 AND organization_id = $2",
    [user.id, org.id],
  );

  if (existing.length === 0) {
    await pool.query(
      `INSERT INTO user_organizations (user_id, organization_id, role, tabs, hiring_brands)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
      [user.id, org.id, ROLE, JSON.stringify(TABS), JSON.stringify(HIRING_BRANDS)],
    );
    console.log("  created membership");
  } else {
    await pool.query(
      `UPDATE user_organizations SET role = $3, tabs = $4::jsonb, hiring_brands = $5::jsonb
        WHERE user_id = $1 AND organization_id = $2`,
      [user.id, org.id, ROLE, JSON.stringify(TABS), JSON.stringify(HIRING_BRANDS)],
    );
    console.log(`  updated existing membership (was role=${existing[0].role}, tabs=${JSON.stringify(existing[0].tabs)})`);
  }

  // ── Verify against the real rows, not against what we just intended ────────
  const { rows: after } = await pool.query(
    `SELECT uo.role, uo.tabs, uo.hiring_brands, o.slug
       FROM user_organizations uo JOIN organizations o ON o.id = uo.organization_id
      WHERE uo.user_id = $1 ORDER BY o.slug`,
    [user.id],
  );
  const usg = after.find(r => r.slug === ORG_SLUG);

  const checks: [string, boolean][] = [
    ["USG membership exists", !!usg],
    ["role is team_member (so the tab whitelist is actually consulted)", usg?.role === ROLE],
    ["tabs are exactly ['hiring']", JSON.stringify(usg?.tabs) === JSON.stringify(TABS)],
    ["hiring brands are exactly ['mfl','cic']", JSON.stringify(usg?.hiring_brands) === JSON.stringify(HIRING_BRANDS)],
    ["cufc is NOT in his brand scope", !(usg?.hiring_brands ?? []).includes("cufc")],
    ["his other workspaces are untouched", after.filter(r => r.slug !== ORG_SLUG).length === 3],
  ];
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed++;
    console.log(`${ok ? "  ok " : " FAIL"}  ${label}`);
  }

  console.log("\n  Isaac's workspaces after this change:");
  for (const r of after) {
    console.log(`    ${r.slug.padEnd(34)} role=${String(r.role).padEnd(12)} tabs=${JSON.stringify(r.tabs)} hiring=${JSON.stringify(r.hiring_brands)}`);
  }

  // What he would actually see in the Hiring tab, computed the way the server does.
  const { rows: visible } = await pool.query(
    `SELECT brand, count(*)::int AS jobs FROM hiring_jobs
      WHERE organization_id = $1 AND brand = ANY($2::text[]) GROUP BY brand ORDER BY brand`,
    [org.id, HIRING_BRANDS],
  );
  const { rows: hidden } = await pool.query(
    `SELECT brand, count(*)::int AS jobs FROM hiring_jobs
      WHERE organization_id = $1 AND NOT (brand = ANY($2::text[])) GROUP BY brand ORDER BY brand`,
    [org.id, HIRING_BRANDS],
  );
  console.log(`\n  He will see:   ${visible.map(r => `${r.brand} (${r.jobs} jobs)`).join(", ") || "nothing yet"}`);
  console.log(`  Hidden from him: ${hidden.map(r => `${r.brand} (${r.jobs} jobs)`).join(", ") || "nothing"}`);

  if (failed) {
    await pool.query("ROLLBACK");
    console.error(`\n${failed} check(s) failed — rolled back.`);
    process.exit(1);
  }
  if (DRY_RUN) {
    await pool.query("ROLLBACK");
    console.log("\n✓ Valid. Rolled back — database unchanged.\n");
  } else {
    await pool.query("COMMIT");
    console.log("\n✓ Committed.\n");
  }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  console.error("\nFAILED — rolled back:\n", e);
  process.exit(1);
} finally {
  await pool.end();
}
