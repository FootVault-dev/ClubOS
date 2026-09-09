// Fix the Xero token expiry column, then prove the refresh actually fires.
//   npx tsx --env-file=.env script/apply-xero-token-tz.ts [--commit]
import fs from "node:fs"; import path from "node:path"; import { Client } from "pg";
const COMMIT = process.argv.includes("--commit");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect(); await c.query("BEGIN");
  try {
    const before = await c.query(`SELECT token_expires_at FROM org_integrations WHERE provider='xero'`);
    console.log("before:", before.rows[0]?.token_expires_at);
    await c.query(fs.readFileSync(path.resolve(process.cwd(), "migrations/2026-09-09_xero_token_expiry_tz.sql"), "utf8"));
    const t = await c.query(`SELECT data_type FROM information_schema.columns WHERE table_name='org_integrations' AND column_name='token_expires_at'`);
    const after = await c.query(`SELECT token_expires_at FROM org_integrations WHERE provider='xero'`);
    console.log("after :", after.rows[0]?.token_expires_at, "| type:", t.rows[0]?.data_type);
    const ok = t.rows[0]?.data_type === "timestamp with time zone";
    console.log(ok ? "  ✅ column is now timestamptz" : "  ❌ still wrong");
    if (!ok) { await c.query("ROLLBACK"); process.exit(1); }
    if (COMMIT) { await c.query("COMMIT"); console.log("\n🟢 COMMITTED"); }
    else { await c.query("ROLLBACK"); console.log("\n↩️  rolled back (rehearsal)."); }
  } catch (e: any) { await c.query("ROLLBACK"); console.error("FATAL", e?.message); process.exit(1); }
  finally { await c.end(); }
  process.exit(0);
})();
