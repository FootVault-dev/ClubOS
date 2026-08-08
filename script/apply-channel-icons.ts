/**
 * Apply migrations/2026-08-07_chat_channel_icons.sql.
 *   npx tsx script/apply-channel-icons.ts            # DRY RUN — rolls back
 *   npx tsx script/apply-channel-icons.ts --commit
 * Same pattern as apply-notifications.ts: no local Postgres, so the dry run IS
 * the rehearsal — real migration, real schema, invariants asserted, rolled back.
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { sql } from "drizzle-orm";
import { db } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const FILE = join(import.meta.dirname, "..", "migrations", "2026-08-07_chat_channel_icons.sql");

async function main() {
  const body = readFileSync(FILE, "utf8").replace(/^\s*BEGIN;\s*$/gim, "").replace(/^\s*COMMIT;\s*$/gim, "");
  console.log(`\n${COMMIT ? "🔴 APPLYING FOR REAL" : "🧪 DRY RUN (will roll back)"}\n`);

  const before = (await db.execute(sql`SELECT count(*)::int AS n FROM staff_channels`) as any).rows[0];
  console.log("channels before:", before.n);

  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(body));
    const checks: Array<[string, boolean, string]> = [];

    const cols = (await tx.execute(sql`
      SELECT column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'staff_channels' AND column_name IN ('icon_emoji','icon_url')
    `) as any).rows;
    checks.push(["both columns exist", cols.length === 2, `${cols.length}`]);
    checks.push(["both NULLABLE (no channel forced to carry an icon)",
      cols.every((c: any) => c.is_nullable === "YES"), JSON.stringify(cols.map((c: any) => c.is_nullable))]);
    checks.push(["no DEFAULT (a default would invent an icon for every channel)",
      cols.every((c: any) => c.column_default === null), JSON.stringify(cols.map((c: any) => c.column_default))]);

    const after = (await tx.execute(sql`
      SELECT count(*)::int AS n,
             count(icon_emoji)::int AS with_emoji,
             count(icon_url)::int AS with_url FROM staff_channels`) as any).rows[0];
    checks.push(["no channel added or lost", Number(after.n) === Number(before.n), `${before.n} → ${after.n}`]);
    checks.push(["no existing channel got an icon",
      Number(after.with_emoji) === 0 && Number(after.with_url) === 0,
      `emoji=${after.with_emoji} url=${after.with_url}`]);

    // A ZWJ family emoji must survive the round trip — this is the case a
    // naive char-length validator or a latin1 column would mangle.
    await tx.execute(sql`SAVEPOINT probe_emoji`);
    const [chan] = (await tx.execute(sql`SELECT id FROM staff_channels LIMIT 1`) as any).rows;
    if (chan) {
      await tx.execute(sql`UPDATE staff_channels SET icon_emoji = '👨‍👩‍👧‍👦' WHERE id = ${chan.id}`);
      const [back] = (await tx.execute(sql`SELECT icon_emoji FROM staff_channels WHERE id = ${chan.id}`) as any).rows;
      checks.push(["ZWJ family emoji round-trips intact", back?.icon_emoji === "👨‍👩‍👧‍👦", JSON.stringify(back?.icon_emoji)]);
    }
    await tx.execute(sql`ROLLBACK TO SAVEPOINT probe_emoji`);

    let failed = 0;
    console.log("");
    for (const [n, ok, d] of checks) { console.log(`  ${ok ? "✓" : "✗"} ${n}${ok ? "" : `  — ${d}`}`); if (!ok) failed++; }
    console.log("");
    if (failed) throw new Error(`${failed} invariant(s) failed`);
    if (!COMMIT) throw new Error("__DRY_RUN_ROLLBACK__");
  }).catch((e) => {
    if (e?.message === "__DRY_RUN_ROLLBACK__") {
      console.log("🧪 Dry run complete — invariants held, ROLLED BACK.\n"); return;
    }
    throw e;
  });
  if (COMMIT) console.log("✅ Applied.\n");
  process.exit(0);
}
main().catch((e) => { console.error("\n❌", e.message, "\n"); process.exit(1); });
