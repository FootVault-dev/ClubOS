import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const { rows } = await pool.query(`
  SELECT r.id, p.slug, r.total_cents,
         (SELECT count(*) FROM registration_items ri WHERE ri.registration_id = r.id) AS items
    FROM registrations r JOIN programs p ON p.id=r.program_id
   WHERE r.program_id IN (16,17) AND r.status='confirmed' AND r.registered_at >= '2026-07-01'
   ORDER BY r.id LIMIT 8`);
console.log("Academy registrations — do they have refundable items?");
for (const r of rows) console.log(`  reg#${r.id} ${r.slug} $${(r.total_cents/100).toFixed(2)} → registration_items = ${r.items}`);

console.log("\n=== USERS: the four Daniel named ===");
const u = await pool.query(`
  SELECT id, email, first_name, last_name, role, active
    FROM users
   WHERE lower(email) LIKE ANY (ARRAY['%olga%','%travis%','%natalia%','%accounts@cufc%','%daniel@cufc%','%daniel@footvault%'])
      OR lower(first_name) IN ('olga','travis','natalia','daniel')
   ORDER BY id`);
for (const r of u.rows) console.log(`  user#${r.id} ${r.first_name} ${r.last_name} <${r.email}> role=${r.role} active=${r.active}`);
await pool.end();
