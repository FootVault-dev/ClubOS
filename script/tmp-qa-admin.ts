// Create or delete a temp QA super_admin for logged-in UI verification.
// Usage: npx tsx --env-file=.env script/tmp-qa-admin.ts create|delete
import { Pool } from "pg";
import crypto from "crypto";
const QA_EMAIL = "danielmeyn963+esignqa@gmail.com";
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  const mode = process.argv[2];
  if (mode === "create") {
    const pw = crypto.randomBytes(18).toString("hex");
    const bcrypt = await import("bcryptjs");
    const hash = await bcrypt.hash(pw, 10);
    await c.query(`INSERT INTO users (email, password, first_name, last_name, role, active) VALUES ($1,$2,'QA','ESign','super_admin',true) ON CONFLICT (email) DO UPDATE SET password=EXCLUDED.password, role='super_admin', active=true`, [QA_EMAIL, hash]);
    console.log(`QA_EMAIL=${QA_EMAIL}`);
    console.log(`QA_PASSWORD=${pw}`);
  } else {
    const del = await c.query(`DELETE FROM users WHERE email=$1 RETURNING id`, [QA_EMAIL]);
    console.log(`deleted: ${del.rows.length}`);
  }
  c.release(); await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
