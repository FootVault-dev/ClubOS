import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const q = async (label, sql, params=[]) => {
  try {
    const r = await pool.query(sql, params);
    console.log(`\n=== ${label} (${r.rowCount} rows) ===`);
    console.dir(r.rows, { depth: null, maxArrayLength: null });
  } catch (e) {
    console.log(`\n=== ${label} — ERROR: ${e.message} ===`);
  }
};

await q('QPR league_teams', `
  SELECT lt.id, lt.name, lt.organization_id AS org, lt.competition_id AS comp, lt.division_id AS div,
         ld.name AS division_name, lt.contact_name, lt.contact_email, lt.contact_phone,
         lt.active, lt.registration_id AS reg_id, lt.payment_status, lt.created_at
  FROM league_teams lt
  LEFT JOIN league_divisions ld ON ld.id = lt.division_id
  WHERE lt.name ILIKE '%qpr%'
  ORDER BY lt.created_at`);

await q('QPR-linked registrations (370/371 + group)', `
  SELECT r.id, r.status, r.program_id, r.team_name, r.league_division_id AS div,
         r.registration_group_id AS grp,
         r.amount_paid, r.subtotal_cents, r.discount_cents, r.total_cents, r.deposit_cents,
         r.payment_mode, r.stripe_payment_intent_id AS pi, r.stripe_subscription_id AS sub,
         r.stripe_customer_id AS cust,
         r.weeks_paid, r.weeks_total, r.weekly_amount_cents,
         r.balance_status, r.refunded_at, r.refunded_amount_cents, r.contact_id
  FROM registrations r
  WHERE r.id IN (370, 371)
     OR r.registration_group_id IN (SELECT registration_group_id FROM registrations WHERE id IN (370,371) AND registration_group_id IS NOT NULL)
  ORDER BY r.id`);

await q('contact for these regs', `
  SELECT id, first_name, last_name, email, phone FROM contacts
  WHERE id IN (SELECT contact_id FROM registrations WHERE id IN (370,371))`);

await q('split_sessions for these regs', `
  SELECT * FROM split_sessions WHERE registration_id IN (370,371)`);

await q('registration_items for these regs', `
  SELECT registration_id, product_type, description, quantity, unit_price_cents, total_cents
  FROM registration_items WHERE registration_id IN (370,371) ORDER BY registration_id`);

await q('Thursday 7s division capacity + current teams', `
  SELECT ld.id, ld.name, ld.max_teams,
         (SELECT count(*) FROM league_teams lt WHERE lt.division_id = ld.id AND lt.active) AS active_teams
  FROM league_divisions ld WHERE ld.id IN (9,5)`);

await pool.end();
