// Apply the Staff Chat migration (2026-07-22_staff_chat.sql).
//
// House ritual: rehearse first inside a rolled-back transaction, then --apply.
//   Dry run (default):  npx tsx --env-file=.env script/apply-staff-chat-schema.ts
//   For real:           npx tsx --env-file=.env script/apply-staff-chat-schema.ts --apply
//
// The migration is additive-only + idempotent (IF NOT EXISTS everywhere), so
// re-running with --apply is always safe.
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");

const SQL = readFileSync(join(__dirname, "..", "migrations", "2026-07-22_staff_chat.sql"), "utf8");

const TABLES = [
  "staff_channels",
  "staff_channel_members",
  "staff_messages",
  "staff_message_mentions",
  "staff_message_reactions",
  "staff_message_acks",
  "staff_chat_presence",
];

(async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(SQL);

    // Verify inside the transaction: tables exist, defaults seeded, indexes on.
    for (const t of TABLES) {
      const r = await client.query(
        "SELECT count(*)::int AS cols FROM information_schema.columns WHERE table_name = $1",
        [t],
      );
      if (r.rows[0].cols === 0) throw new Error(`table ${t} missing after migration`);
      console.log(`  ✓ ${t} (${r.rows[0].cols} cols)`);
    }
    const seeded = await client.query(
      "SELECT name, is_default, post_policy FROM staff_channels WHERE kind='channel' AND archived_at IS NULL ORDER BY name",
    );
    console.log(`  ✓ default channels: ${seeded.rows.map((r) => `#${r.name}(${r.post_policy})`).join(" ")}`);
    const idx = await client.query(
      "SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = ANY($1) AND indexname LIKE 'staff_%'",
      [TABLES],
    );
    console.log(`  ✓ ${idx.rows[0].n} staff_* indexes present`);

    if (APPLY) {
      await client.query("COMMIT");
      console.log("✅ APPLIED — staff chat schema is live.");
    } else {
      await client.query("ROLLBACK");
      console.log("🧪 DRY RUN OK — rolled back. Re-run with --apply to make it real.");
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("❌ migration failed (rolled back):", e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
