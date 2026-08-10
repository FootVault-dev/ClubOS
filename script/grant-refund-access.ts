/**
 * Who may issue refunds.
 *
 *   npx tsx --env-file=.env script/grant-refund-access.ts                 # show who holds it
 *   npx tsx --env-file=.env script/grant-refund-access.ts --grant a@b.nz  # dry run
 *   npx tsx --env-file=.env script/grant-refund-access.ts --grant a@b.nz --commit
 *   npx tsx --env-file=.env script/grant-refund-access.ts --revoke a@b.nz --commit
 *
 * Grants by EMAIL, never by name — two people can share a name, and the failure
 * mode is handing the club's Stripe balance to the wrong person. An address that
 * matches no user is reported and skipped, never created.
 *
 * This script is a convenience for the initial grant. Day to day the toggle
 * lives in /admin/team → member → Refunds, so nobody needs a terminal.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../server/db";

const argv = process.argv.slice(2);
const COMMIT = argv.includes("--commit");
const collect = (flag: string) =>
  argv.reduce<string[]>((acc, a, i) => (argv[i - 1] === flag ? [...acc, a] : acc), []);
const toGrant = collect("--grant").map((e) => e.toLowerCase());
const toRevoke = collect("--revoke").map((e) => e.toLowerCase());

async function show() {
  const { rows } = (await db.execute(sql`
    SELECT id, email, first_name, last_name, role, active, can_issue_refunds
      FROM users ORDER BY can_issue_refunds DESC, id
  `)) as any;
  const granted = rows.filter((r: any) => r.can_issue_refunds);
  console.log(`\n=== Can issue refunds (${granted.length} of ${rows.length} users) ===`);
  if (!granted.length) console.log("  (nobody)");
  for (const r of granted) {
    console.log(
      `  ✅ #${r.id} ${r.first_name} ${r.last_name} <${r.email}> role=${r.role}` +
      (r.active ? "" : "  ⚠️ INACTIVE"),
    );
  }
}

async function main() {
  if (!toGrant.length && !toRevoke.length) {
    await show();
    console.log("\nPass --grant <email> / --revoke <email> to change it.\n");
    process.exit(0);
  }

  console.log(`\n${COMMIT ? "🔴 APPLYING FOR REAL" : "🧪 DRY RUN (will roll back)"}\n`);

  await db.transaction(async (tx) => {
    for (const [emails, value, verb] of [
      [toGrant, true, "GRANT"],
      [toRevoke, false, "REVOKE"],
    ] as const) {
      for (const email of emails) {
        const { rows } = (await tx.execute(sql`
          SELECT id, email, first_name, last_name, active, can_issue_refunds
            FROM users WHERE lower(email) = ${email}
        `)) as any;
        if (!rows.length) {
          console.log(`  ⚠️  ${verb} ${email} — NO SUCH USER, skipped (nothing created)`);
          continue;
        }
        const u = rows[0];
        if (u.can_issue_refunds === value) {
          console.log(`  ·  ${verb} ${email} — already ${value ? "granted" : "revoked"}, no change`);
          continue;
        }
        await tx.execute(sql`UPDATE users SET can_issue_refunds = ${value} WHERE id = ${u.id}`);
        console.log(
          `  ${value ? "✅" : "🚫"} ${verb} #${u.id} ${u.first_name} ${u.last_name} <${u.email}>` +
          (u.active ? "" : "  ⚠️ this account is INACTIVE"),
        );
      }
    }

    if (!COMMIT) throw new Error("__ROLLBACK__");
  }).catch((e: any) => {
    if (e?.message !== "__ROLLBACK__") throw e;
    console.log("\n🧪 Rolled back (dry run).");
  });

  await show();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
