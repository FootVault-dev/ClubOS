import { readFileSync } from "node:fs";
import pg from "pg";
const DRY = process.argv.includes("--dry-run");
const sql = readFileSync("migrations/2026-07-28_nzf_identity_deferral.sql", "utf8");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const c = await pool.connect();
let bad = false;
try {
  const before = (await c.query("SELECT count(*)::int n FROM contacts")).rows[0].n;
  await c.query("BEGIN");
  await c.query(sql);
  for (const [col, type] of [["identity_deferred_at","timestamp with time zone"],["identity_deferred_reason","text"],["identity_deferred_by_user_id","integer"]] as [string,string][]) {
    const r = await c.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='contacts' AND column_name=$1`,[col]);
    if (!r.rowCount) { console.error(`✗ ${col} missing`); bad = true; continue; }
    const row = r.rows[0];
    if (row.data_type !== type || row.is_nullable !== "YES" || row.column_default !== null) { console.error(`✗ ${col} wrong shape`, row); bad = true; continue; }
    console.log(`✓ contacts.${col} — ${type}, nullable, no default`);
  }
  const fk = await c.query(`SELECT confdeltype FROM pg_constraint WHERE conname='contacts_identity_deferred_by_user_id_fkey'`);
  if (fk.rows[0]?.confdeltype === "r") console.log("✓ deferred_by FK is ON DELETE RESTRICT (who decided is never erased)");
  else { console.error("✗ FK missing or not RESTRICT", fk.rows); bad = true; }
  const idx = await c.query(`SELECT indexdef FROM pg_indexes WHERE tablename='contacts' AND indexname='contacts_identity_deferred_idx'`);
  if (idx.rowCount && /WHERE/i.test(idx.rows[0].indexdef)) console.log("✓ follow-up index present and partial");
  else { console.error("✗ follow-up index missing/not partial"); bad = true; }
  const after = (await c.query("SELECT count(*)::int n FROM contacts")).rows[0].n;
  if (after === before) console.log(`✓ contacts row count unchanged (${before})`); else { console.error("✗ row count changed"); bad = true; }
  const filled = (await c.query("SELECT count(*)::int n FROM contacts WHERE identity_deferred_at IS NOT NULL")).rows[0].n;
  if (filled === 0) console.log("✓ nothing back-filled — no deferral invented"); else { console.error(`✗ ${filled} rows pre-filled`); bad = true; }
  await c.query(sql);
  console.log("✓ idempotent (applied twice cleanly)");
  if (DRY || bad) { await c.query("ROLLBACK"); console.log(`\n${bad ? "❌" : "✅"} ${DRY ? "DRY RUN" : "FAILED"} — rolled back, database unchanged.`); }
  else { await c.query("COMMIT"); console.log("\n✅ APPLIED to the database."); }
} catch (e) { await c.query("ROLLBACK").catch(()=>{}); console.error("\n❌ rolled back\n", e); bad = true; }
finally { c.release(); await pool.end(); }
process.exit(bad ? 1 : 0);
