/**
 * Apply migrations/2026-08-10_refund_permission.sql.
 *   npx tsx script/apply-refund-permission.ts            # DRY RUN — rolls back
 *   npx tsx script/apply-refund-permission.ts --commit
 *
 * There is no local Postgres, so the dry run IS the rehearsal: the real
 * migration against the real schema, invariants asserted, then rolled back.
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { sql } from "drizzle-orm";
import { db } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const FILE = join(import.meta.dirname, "..", "migrations", "2026-08-10_refund_permission.sql");

async function main() {
  const body = readFileSync(FILE, "utf8")
    .replace(/^\s*BEGIN;\s*$/gim, "")
    .replace(/^\s*COMMIT;\s*$/gim, "");
  console.log(`\n${COMMIT ? "🔴 APPLYING FOR REAL" : "🧪 DRY RUN (will roll back)"}\n`);

  const before = (await db.execute(sql`SELECT count(*)::int AS n FROM users`) as any).rows[0];
  console.log("users before:", before.n);

  let ok = true;
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(body));
    const checks: Array<[string, boolean, string]> = [];

    const [col] = (await tx.execute(sql`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'can_issue_refunds'
    `) as any).rows;
    checks.push(["column exists", !!col, col ? "yes" : "MISSING"]);
    checks.push(["boolean", col?.data_type === "boolean", String(col?.data_type)]);
    checks.push(["NOT NULL", col?.is_nullable === "NO", String(col?.is_nullable)]);
    checks.push([
      "defaults FALSE (nobody gains refund power by existing)",
      String(col?.column_default).includes("false"),
      String(col?.column_default),
    ]);

    const after = (await tx.execute(sql`
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE can_issue_refunds)::int AS granted
        FROM users`) as any).rows[0];
    checks.push(["no user added or lost", Number(after.n) === Number(before.n), `${before.n} → ${after.n}`]);
    checks.push([
      "ZERO users hold the permission after migration",
      Number(after.granted) === 0,
      `${after.granted} granted`,
    ]);

    for (const [name, pass, detail] of checks) {
      console.log(`  ${pass ? "✅" : "❌"} ${name}  (${detail})`);
      if (!pass) ok = false;
    }

    if (!COMMIT) {
      throw new Error("__ROLLBACK__");
    }
  }).catch((e: any) => {
    if (e?.message !== "__ROLLBACK__") throw e;
    console.log("\n🧪 Rolled back (dry run).");
  });

  if (!ok) {
    console.error("\n❌ Invariants failed — do NOT commit this migration.");
    process.exit(1);
  }
  console.log(COMMIT ? "\n✅ Applied." : "\n✅ Rehearsal clean. Re-run with --commit to apply.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
