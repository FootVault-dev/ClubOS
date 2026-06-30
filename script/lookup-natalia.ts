import 'dotenv/config';
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query(
    `SELECT id, email, first_name, last_name, role, active, google_id IS NOT NULL AS has_google, apple_id IS NOT NULL AS has_apple, created_at
       FROM users
      WHERE LOWER(email) = 'info@cugc.co.nz'
         OR LOWER(first_name) LIKE '%natal%'
         OR LOWER(last_name) LIKE '%meyn%'
      ORDER BY id`
  );
  console.log('MATCHES:', JSON.stringify(rows, null, 2));

  // Show workspace memberships for any matched user
  for (const r of rows) {
    const { rows: orgs } = await pool.query(
      `SELECT o.id, o.name, o.slug, uo.role AS membership_role, uo.tabs
         FROM user_organizations uo
         JOIN organizations o ON o.id = uo.organization_id
        WHERE uo.user_id = $1`,
      [r.id]
    );
    console.log(`\nUSER ${r.id} (${r.email}) memberships:`, JSON.stringify(orgs, null, 2));
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
