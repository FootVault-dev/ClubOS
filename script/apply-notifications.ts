/**
 * Apply migrations/2026-08-07_notifications.sql.
 *
 *   npx tsx script/apply-notifications.ts            # DRY RUN — rolls back
 *   npx tsx script/apply-notifications.ts --commit   # for real
 *
 * There is no local Postgres, so the dry run IS the rehearsal: it executes the
 * real migration inside a transaction against the real schema, asserts the
 * invariants, then ROLLS BACK. That is how a migration gets proven before it
 * touches prod (the pattern from script/apply-fleet-vehicles.ts).
 *
 * Idempotent either way — every statement is IF NOT EXISTS / DROP-then-ADD, so
 * a re-run after a partial failure is safe.
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { sql } from "drizzle-orm";
import { db } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const MIGRATION = join(import.meta.dirname, "..", "migrations", "2026-08-07_notifications.sql");

async function main() {
  const ddl = readFileSync(MIGRATION, "utf8");
  console.log(`\n${COMMIT ? "🔴 APPLYING FOR REAL" : "🧪 DRY RUN (will roll back)"}\n`);

  // The file carries its own BEGIN/COMMIT so it is runnable by hand in psql.
  // Strip them here — we control the transaction so a dry run can roll back.
  const body = ddl.replace(/^\s*BEGIN;\s*$/gim, "").replace(/^\s*COMMIT;\s*$/gim, "");

  const before = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM information_schema.tables
        WHERE table_name = 'notification_preferences') AS prefs_table,
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_name = 'device_push_tokens' AND column_name = 'user_id') AS token_user_col,
      (SELECT count(*)::int FROM device_push_tokens) AS existing_tokens,
      (SELECT count(*)::int FROM device_push_tokens WHERE app = 'cic-youth') AS cic_tokens
  `);
  console.log("Before:", (before as any).rows[0]);

  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(body));
    console.log("✓ migration executed");

    // ── Invariants. Each one has bitten this codebase before. ───────────────
    const checks: Array<[string, boolean, string]> = [];

    const cols = await tx.execute(sql`
      SELECT column_name, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_name = 'notification_preferences'
       ORDER BY ordinal_position
    `);
    const colRows = (cols as any).rows as Array<{ column_name: string; is_nullable: string; column_default: string | null }>;
    checks.push(["notification_preferences exists", colRows.length > 0, `${colRows.length} columns`]);

    // Defaults must match shared/notifications.ts DEFAULT_PREFERENCES, or a row
    // created by the DB disagrees with a row created by the app.
    const defaultOf = (c: string) => colRows.find((r) => r.column_name === c)?.column_default ?? "";
    checks.push(["chat_dm defaults 'both'", defaultOf("chat_dm").includes("both"), defaultOf("chat_dm")]);
    checks.push(["chat_channel defaults 'push'", defaultOf("chat_channel").includes("push"), defaultOf("chat_channel")]);
    checks.push(["task_due defaults 'email'", defaultOf("task_due").includes("email"), defaultOf("task_due")]);
    checks.push(["quiet_hours_start defaults 20", defaultOf("quiet_hours_start").startsWith("20"), defaultOf("quiet_hours_start")]);
    checks.push(["daily_digest defaults false", defaultOf("daily_digest").includes("false"), defaultOf("daily_digest")]);

    // 🔴 The push-token column MUST be nullable: every existing CIC fan row has
    // no owner, and a NOT NULL would require inventing one for each of them.
    const tokCol = await tx.execute(sql`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'device_push_tokens' AND column_name = 'user_id'
    `);
    const nullable = (tokCol as any).rows[0]?.is_nullable;
    checks.push(["device_push_tokens.user_id is NULLABLE", nullable === "YES", `is_nullable=${nullable}`]);

    // Existing CIC rows must be untouched — this migration must not disturb the
    // live fan-broadcast path in any way.
    const after = await tx.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE app = 'cic-youth')::int AS cic,
             count(*) FILTER (WHERE user_id IS NOT NULL)::int AS owned
        FROM device_push_tokens
    `);
    const a = (after as any).rows[0];
    const b = (before as any).rows[0];
    checks.push(["no push tokens added or lost", Number(a.total) === Number(b.existing_tokens), `${b.existing_tokens} → ${a.total}`]);
    checks.push(["CIC token count unchanged", Number(a.cic) === Number(b.cic_tokens), `${b.cic_tokens} → ${a.cic}`]);
    checks.push(["no existing token got an owner", Number(a.owned) === 0, `${a.owned} owned`]);

    // The hour CHECK must actually bite — a constraint that accepts anything is
    // decoration. A failing statement poisons the whole transaction in Postgres,
    // so the probe runs inside a SAVEPOINT and rolls back to it.
    let hourCheckBites = false;
    await tx.execute(sql`SAVEPOINT probe_hour_check`);
    try {
      await tx.execute(sql`
        INSERT INTO notification_preferences (user_id, quiet_hours_start)
        SELECT id, 99 FROM users LIMIT 1
      `);
      await tx.execute(sql`ROLLBACK TO SAVEPOINT probe_hour_check`);
    } catch {
      hourCheckBites = true;
      await tx.execute(sql`ROLLBACK TO SAVEPOINT probe_hour_check`);
    }
    checks.push(["hour CHECK rejects 99", hourCheckBites, "constraint did not fire"]);

    // And a valid row must insert cleanly, with the right defaults applied.
    // Inside its own SAVEPOINT so the probe row is discarded even on --commit:
    // a verification artifact must never survive into real data. (It did once —
    // a defaults row for user 1 had to be deleted by hand afterwards.)
    const [u] = (await tx.execute(sql`SELECT id FROM users ORDER BY id LIMIT 1`) as any).rows;
    if (u) {
      await tx.execute(sql`SAVEPOINT probe_defaults`);
      await tx.execute(sql`INSERT INTO notification_preferences (user_id) VALUES (${u.id})
                           ON CONFLICT (user_id) DO NOTHING`);
      const [row] = (await tx.execute(sql`
        SELECT chat_dm, chat_channel, task_due, quiet_hours_start, quiet_hours_end,
               push_enabled, email_enabled, show_preview, daily_digest, weekly_digest_day
          FROM notification_preferences WHERE user_id = ${u.id}
      `) as any).rows;
      checks.push(["a bare INSERT lands on the right defaults",
        row?.chat_dm === "both" && row?.chat_channel === "push" && row?.task_due === "email" &&
        Number(row?.quiet_hours_start) === 20 && Number(row?.quiet_hours_end) === 8 &&
        row?.push_enabled === true && row?.email_enabled === true && row?.show_preview === true &&
        row?.daily_digest === false && Number(row?.weekly_digest_day) === 1,
        JSON.stringify(row)]);
      await tx.execute(sql`ROLLBACK TO SAVEPOINT probe_defaults`);
    }

    // RLS on (scripts/security/rls_guard.mjs would fail the build otherwise).
    const [rls] = (await tx.execute(sql`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'notification_preferences'
    `) as any).rows;
    checks.push(["RLS enabled", rls?.relrowsecurity === true, `${rls?.relrowsecurity}`]);

    // The partial index the staff-push hot path relies on.
    const [idx] = (await tx.execute(sql`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'device_push_tokens_user_idx'
    `) as any).rows;
    checks.push(["staff-push index exists and is partial",
      !!idx?.indexdef && String(idx.indexdef).includes("disabled = false"),
      String(idx?.indexdef ?? "missing")]);

    let failed = 0;
    console.log("");
    for (const [name, ok, detail] of checks) {
      console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  — ${detail}`}`);
      if (!ok) failed++;
    }
    console.log("");

    if (failed > 0) throw new Error(`${failed} invariant(s) failed — aborting`);

    if (!COMMIT) {
      throw new Error("__DRY_RUN_ROLLBACK__");
    }
  }).catch((e) => {
    if (e?.message === "__DRY_RUN_ROLLBACK__") {
      console.log("🧪 Dry run complete — all invariants held, transaction ROLLED BACK.");
      console.log("   Re-run with --commit to apply.\n");
      return;
    }
    throw e;
  });

  if (COMMIT) console.log("✅ Applied.\n");
  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌", e.message, "\n");
  process.exit(1);
});
