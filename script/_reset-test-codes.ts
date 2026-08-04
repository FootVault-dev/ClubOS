// Test hygiene only: clear login codes for the reserved test address and for
// loopback requests, so the E2E suite can be run repeatedly without tripping
// the (correctly working) rate limiter. Never touches a real family's rows —
// no real parent signs in from 127.0.0.1.
import 'dotenv/config';
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const r = await pool.query(`
  DELETE FROM parent_login_codes
  WHERE email IN ('test@example.com', 'nobody-at-all-9f3@example.com')
     OR request_ip IN ('127.0.0.1', '::1', '::ffff:127.0.0.1')`);
console.log(`cleared ${r.rowCount} test login code(s)`);
await pool.end();
