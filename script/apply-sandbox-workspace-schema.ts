// Apply the Sandbox workspace migration to the live Supabase DB.
// ADDITIVE ONLY — never db:push (prod schema drift).
// Usage: npx tsx --env-file=.env script/apply-sandbox-workspace-schema.ts
import { readFileSync } from "fs";
import pg from "pg";

const sql = readFileSync("migrations/2026-07-06_sandbox_workspace.sql", "utf8");

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");

    const org = await client.query(
      `SELECT id, name, slug, active FROM organizations WHERE slug = 'sandbox'`,
    );
    const members = await client.query(
      `SELECT uo.user_id, u.email, uo.role
         FROM user_organizations uo
         JOIN organizations o ON o.id = uo.organization_id
         JOIN users u ON u.id = uo.user_id
        WHERE o.slug = 'sandbox'`,
    );
    console.log("Sandbox org:", org.rows);
    console.log("Members (should be Daniel only):", members.rows);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main()
  .then(() => {
    console.log("✓ sandbox workspace applied");
    process.exit(0);
  })
  .catch((e) => {
    console.error("✗ failed:", e.message);
    process.exit(1);
  });
