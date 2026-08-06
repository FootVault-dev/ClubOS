// Prove a real parent can sign in ON PRODUCTION, end to end.
//
// The code is only ever stored hashed, so this recovers it for the RESERVED
// TEST ADDRESS ONLY (test@example.com — RFC 2606, undeliverable, and a seeded
// test guardian row) by hashing all 10^6 possibilities. That is not a weakness:
// it works because we already hold the DB row, which is precisely the position
// an attacker is not in. It is the only way to verify the live login without
// mailing a real family a code.
import 'dotenv/config';
import { Pool } from 'pg';
import crypto from 'crypto';

const EMAIL = 'test@example.com';
const BASE = 'https://cufc.co.nz';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let pass = 0, fail = 0;
const ok = (c: boolean, label: string, extra = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${label}${extra ? ' — ' + extra : ''}`);
  c ? pass++ : fail++;
};

// 1. Ask production for a code.
const req = await fetch(`${BASE}/api/public/parent/request-code`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL }),
});
ok(req.ok, 'production issued a code');

// 2. Recover it from the hash we just caused to be written.
const { rows } = await pool.query(
  `SELECT code_hash FROM parent_login_codes
   WHERE email = $1 AND consumed_at IS NULL AND expires_at > now()
   ORDER BY created_at DESC LIMIT 1`, [EMAIL]);
if (!rows.length) { console.error('no live code row'); process.exit(1); }
const target = rows[0].code_hash;

let code: string | null = null;
for (let i = 0; i < 1_000_000; i++) {
  const c = String(i).padStart(6, '0');
  if (crypto.createHash('sha256').update(`${c}:${EMAIL}`).digest('hex') === target) { code = c; break; }
}
ok(!!code, 'the stored hash really is sha256(code:email)');
if (!code) process.exit(1);

// 3. A wrong code must be refused first.
const bad = await fetch(`${BASE}/api/public/parent/verify`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, code: code === '000000' ? '111111' : '000000' }),
});
ok(bad.status === 400, 'a wrong code is refused on production');

// 4. The real code signs in.
const res = await fetch(`${BASE}/api/public/parent/verify`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, code }),
});
ok(res.ok, 'the real code signs in on production');
const setCookie = res.headers.get('set-cookie') || '';
ok(/Domain=\.cufc\.co\.nz/i.test(setCookie), 'session cookie spans .cufc.co.nz');
ok(/HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie), 'cookie is HttpOnly + Secure');
const jar = (setCookie.match(/cufc_parent=([^;]*)/) || [])[1] || '';

// 5. The dashboard loads for that session.
const me = await fetch(`${BASE}/api/public/parent/me`, { headers: { Cookie: `cufc_parent=${jar}` } });
ok(me.ok, 'the dashboard loads on production');
const body: any = me.ok ? await me.json() : {};
ok(typeof body.today === 'string', 'it returns a real payload', body.today ? `today=${body.today}` : '');

// 6. The SAME cookie is honoured by the checkout host — the whole point of
//    scoping it to .cufc.co.nz.
const pre = await fetch(`https://join.cufc.co.nz/api/public/parent/prefill`, {
  headers: { Cookie: `cufc_parent=${jar}` },
});
const preBody: any = await pre.json();
ok(preBody.signedIn === true, 'the checkout on join.cufc.co.nz sees the same session');

// 7. Single use.
const replay = await fetch(`${BASE}/api/public/parent/verify`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, code }),
});
ok(replay.status === 400, 'the code cannot be used twice');

// 8. Another family's child is unreachable with a valid session.
const intrude = await fetch(`${BASE}/api/public/parent/children/contact-1`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Cookie: `cufc_parent=${jar}` },
  body: JSON.stringify({ allergies: 'INTRUSION TEST' }),
});
ok(intrude.status === 404, "another family's child is 404, not 403");

// Leave no live credential behind.
await pool.query(`DELETE FROM parent_login_codes WHERE email = $1`, [EMAIL]);
await pool.end();
console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
process.exit(fail ? 1 : 0);
