// Applies migrations/2026-08-15_staff_chat_threads.sql, then verifies + backfills links.
import "dotenv/config";
import { Pool } from "pg";
import { readFileSync } from "fs";
const dry = process.argv.includes("--dry-run");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const c = await pool.connect();
// Same extractor the server uses — keep in step with shared/staff-chat.ts.
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
try {
  await c.query("BEGIN");
  await c.query(readFileSync("migrations/2026-08-15_staff_chat_threads.sql","utf8"));

  const cols = await c.query(`SELECT column_name FROM information_schema.columns
    WHERE table_name='staff_messages' AND column_name IN ('parent_message_id','forwarded_from_message_id')`);
  console.log("new columns:", cols.rows.map((r:any)=>r.column_name).join(", "));
  const fk = await c.query(`SELECT conname, confdeltype FROM pg_constraint
    WHERE conrelid='staff_messages'::regclass AND contype='f'
      AND conname LIKE '%parent%' OR conname LIKE '%forwarded%'`);
  for (const r of fk.rows) console.log(`  ${r.conname} = ${r.confdeltype} (c=cascade, n=set null)`);

  // Backfill links from existing message bodies, once.
  const msgs = await c.query(`SELECT id, channel_id, author_id, body, created_at
    FROM staff_messages WHERE body ~* 'https?://' AND deleted_at IS NULL`);
  let links = 0;
  for (const m of msgs.rows as any[]) {
    const seen = new Set<string>();
    for (const raw of String(m.body).match(URL_RE) || []) {
      const url = raw.replace(/[.,;:!?]+$/, "");
      if (seen.has(url)) continue;
      seen.add(url);
      let host: string | null = null;
      try { host = new URL(url).host; } catch { host = null; }
      await c.query(`INSERT INTO staff_message_links (message_id, channel_id, author_id, url, host, created_at)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (message_id, url) DO NOTHING`,
        [m.id, m.channel_id, m.author_id, url.slice(0,2000), host, m.created_at]);
      links++;
    }
  }
  console.log(`backfilled ${links} links from ${msgs.rows.length} messages`);
  const rls = await c.query(`SELECT relrowsecurity FROM pg_class WHERE relname='staff_message_links'`);
  console.log("links RLS on:", rls.rows[0]?.relrowsecurity);

  if (dry) { await c.query("ROLLBACK"); console.log("\n--dry-run → rolled back"); }
  else { await c.query("COMMIT"); console.log("\n✓ committed"); }
} catch(e:any){ await c.query("ROLLBACK"); console.error("rolled back:", e.message); process.exit(1); }
finally { c.release(); await pool.end(); }
