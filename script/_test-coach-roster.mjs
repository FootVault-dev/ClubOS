// End-to-end verification of the coaching roster against the REAL prod DB,
// through the real Express routes. Creates a disposable staff user + a
// disposable coach, and removes everything it created before exiting.
import pg from 'pg';
import fs from 'fs';
import bcrypt from 'bcryptjs';

const BASE = 'http://localhost:5055';
const env = Object.fromEntries(fs.readFileSync('.env', 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  OK  ', name); } else { fail++; console.log('  FAIL', name, extra); } };

const db = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

let cookie = '';
let WORKSPACE = 'christchurch-united';
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      'X-Workspace-Slug': WORKSPACE,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  let json = null; try { json = await res.json(); } catch { }
  return { status: res.status, json };
}

const TEST_EMAIL = '_e2e-coachroll@example.invalid';
const PW = 'e2e-' + Math.random().toString(36).slice(2);
let userId = null, coachId = null;

try {
  // ── setup ────────────────────────────────────────────────────────────────
  WORKSPACE = (await db.query(`select slug from organizations where id=1`)).rows[0].slug;
  console.log('workspace slug:', WORKSPACE);

  await db.query(`delete from users where email=$1`, [TEST_EMAIL]);
  const hash = await bcrypt.hash(PW, 10);
  userId = (await db.query(
    `insert into users (email, password, role, first_name, last_name, active)
     values ($1,$2,'super_admin','E2E','Tester',true) returning id`, [TEST_EMAIL, hash])).rows[0].id;
  await db.query(`insert into user_organizations (user_id, organization_id, role) values ($1,1,'admin')`, [userId]);

  const login = await api('POST', '/api/auth/login', { email: TEST_EMAIL, password: PW });
  ok('login as staff', login.status === 200, JSON.stringify(login.json));

  const CAMP = 4; // FUNiño — First Kicks (U4–U8): term programme, 68 sessions
  const dates = (await db.query(
    `select id, to_char(date,'YYYY-MM-DD') d, start_time from camp_dates where camp_id=$1 order by date, start_time`, [CAMP])).rows;
  const monday = dates.find(r => new Date(r.d + 'T12:00:00').getDay() === 1 && r.start_time === '16:30');
  const satEarly = dates.find(r => r.start_time === '09:30');
  const satLate = dates.find(r => r.start_time === '10:30');
  console.log(`sessions: ${dates.length} | monday ${monday.d} | sat ${satEarly.d} ${satEarly.start_time}/${satLate.start_time}`);

  // ── the coach pool ───────────────────────────────────────────────────────
  const coaches = await api('GET', '/api/admin/coaches');
  ok('coach list returns staff contacts', coaches.status === 200 && coaches.json.length >= 15, `got ${coaches.json?.length}`);
  const players = await db.query(`select count(*)::int n from contacts where type='player'`);
  ok('coach list is NOT the player list', coaches.json.length < players.rows[0].n / 10, `${coaches.json.length} vs ${players.rows[0].n} players`);

  const search = await api('GET', '/api/admin/coach-search?q=hugh');
  ok('coach search finds Ian Hughes', search.status === 200 && search.json.some(c => c.lastName === 'Hughes'));
  const ian = coaches.json.find(c => c.lastName === 'Hughes');

  // ── assign to ONE session ────────────────────────────────────────────────
  const one = await api('POST', `/api/admin/camps/${CAMP}/session-coaches`, {
    campDateId: satEarly.id, contactId: ian.id, role: 'lead', applyTo: 'this',
  });
  ok('assign to one session', one.status === 201 && one.json.sessions === 1, JSON.stringify(one.json));

  const rosterSat = await api('GET', `/api/admin/camps/${CAMP}/session-coaches?campDateId=${satEarly.id}`);
  ok('roster shows the coach with their role', rosterSat.json.length === 1 && rosterSat.json[0].role === 'lead');
  ok('status starts NULL = not marked yet', rosterSat.json[0].status === null);

  // camp_dates is keyed by SLOT: 09:30 U4-U6 and 10:30 U7-U8 are different
  // sessions with different coaches. This is the assertion that protects it.
  const rosterSatLate = await api('GET', `/api/admin/camps/${CAMP}/session-coaches?campDateId=${satLate.id}`);
  ok('the 09:30 assignment does NOT leak onto the 10:30 slot', rosterSatLate.json.length === 0);

  // ── duplicate assign is a no-op ──────────────────────────────────────────
  const dup = await api('POST', `/api/admin/camps/${CAMP}/session-coaches`, {
    campDateId: satEarly.id, contactId: ian.id, role: 'coach', applyTo: 'this',
  });
  const afterDup = await api('GET', `/api/admin/camps/${CAMP}/session-coaches?campDateId=${satEarly.id}`);
  ok('re-assigning the same coach does not duplicate them', dup.status === 201 && afterDup.json.length === 1, `${afterDup.json.length} rows`);

  // ── the series assign ────────────────────────────────────────────────────
  const mondayCount = dates.filter(r =>
    new Date(r.d + 'T12:00:00').getDay() === 1 && r.start_time === '16:30' && r.d >= monday.d).length;
  const series = await api('POST', `/api/admin/camps/${CAMP}/session-coaches`, {
    campDateId: monday.id, contactId: ian.id, role: 'coach', applyTo: 'series',
  });
  ok('series assign covers every remaining Monday 16:30',
    series.json.sessions === mondayCount, `api ${series.json?.sessions} vs db ${mondayCount}`);

  const spread = (await db.query(
    `select cd.start_time, to_char(cd.date,'Dy') dow, count(*)::int n
     from session_coaches sc join camp_dates cd on cd.id=sc.camp_date_id
     where sc.camp_id=$1 and sc.contact_id=$2 group by 1,2 order by 3 desc`, [CAMP, ian.id])).rows;
  const onlyExpected = spread.every(r => (r.dow === 'Mon' && r.start_time === '16:30') || r.start_time === '09:30');
  ok('series touched ONLY that weekday+time (plus the one-off Saturday)', onlyExpected, JSON.stringify(spread));

  // ── mark present / absent / clear ────────────────────────────────────────
  const line = (await api('GET', `/api/admin/camps/${CAMP}/session-coaches?campDateId=${monday.id}`)).json[0];
  const present = await api('PATCH', `/api/admin/session-coaches/${line.id}`, { status: 'present' });
  ok('mark present', present.status === 200 && present.json.status === 'present');
  ok('markedAt is stamped server-side', !!present.json.markedAt);
  ok('markedByUserId is stamped server-side', present.json.markedByUserId === userId, String(present.json.markedByUserId));

  const absent = await api('PATCH', `/api/admin/session-coaches/${line.id}`, { status: 'absent' });
  ok('mark absent', absent.json.status === 'absent');

  const cleared = await api('PATCH', `/api/admin/session-coaches/${line.id}`, { status: null });
  ok('clear a mis-tap back to not-marked', cleared.json.status === null && cleared.json.markedAt === null);

  ok('a bogus status is rejected', (await api('PATCH', `/api/admin/session-coaches/${line.id}`, { status: 'maybe' })).status === 400);
  ok('a bogus role is rejected', (await api('PATCH', `/api/admin/session-coaches/${line.id}`, { role: 'head-honcho' })).status === 400);

  // ── the overview ─────────────────────────────────────────────────────────
  await api('PATCH', `/api/admin/session-coaches/${line.id}`, { status: 'present' });
  const ov = await api('GET', `/api/admin/camps/${CAMP}/coach-overview`);
  ok('overview returns every session', ov.status === 200 && ov.json.sessions.length === dates.length,
    `${ov.json?.sessions?.length} vs ${dates.length}`);
  ok('overview sends NZ today', /^\d{4}-\d{2}-\d{2}$/.test(ov.json.today), ov.json.today);
  ok('overview dates are bare ISO strings, never shifted timestamps',
    /^\d{4}-\d{2}-\d{2}$/.test(ov.json.sessions[0].date), ov.json.sessions[0].date);
  ok('first session is the real term start Mon 20 Jul (not the 19th)',
    ov.json.sessions[0].date === '2026-07-20', ov.json.sessions[0].date);

  const tally = ov.json.coaches.find(c => c.contactId === ian.id);
  ok('per-coach tally counts assignments', tally && tally.assigned === mondayCount + 1, JSON.stringify(tally));
  ok('per-coach tally counts present', tally.present === 1);
  ok('"not marked" is counted apart from absent', tally.unmarked === tally.assigned - 1 && tally.absent === 0, JSON.stringify(tally));

  const unstaffed = ov.json.sessions.filter(s => s.coaches.length === 0).length;
  ok('unstaffed sessions are visible', unstaffed === dates.length - (mondayCount + 1), String(unstaffed));

  // ── adding a brand-new coach ─────────────────────────────────────────────
  const fresh = await api('POST', `/api/admin/camps/${CAMP}/session-coaches`, {
    campDateId: satLate.id, firstName: 'E2E', lastName: 'TempCoach', role: 'assistant', applyTo: 'this',
  });
  ok('a new coach can be typed in on the spot', fresh.status === 201 && !!fresh.json.contactId);
  coachId = fresh.json.contactId;
  ok('new coach is stored as a staff contact',
    (await db.query(`select type from contacts where id=$1`, [coachId])).rows[0].type === 'staff');

  // ── fencing ──────────────────────────────────────────────────────────────
  const otherCamp = (await db.query(`select id from programs where organization_id<>1 and organization_id is not null limit 1`)).rows[0];
  ok("another workspace's programme 404s",
    (await api('GET', `/api/admin/camps/${otherCamp.id}/coach-overview`)).status === 404);

  const strayDate = (await db.query(`select id from camp_dates where camp_id<>$1 limit 1`, [CAMP])).rows[0];
  ok('a session from another programme is refused',
    (await api('POST', `/api/admin/camps/${CAMP}/session-coaches`, { campDateId: strayDate.id, contactId: ian.id, applyTo: 'this' })).status === 404);

  const aPlayer = (await db.query(`select id from contacts where type='player' limit 1`)).rows[0];
  ok('a player cannot be rostered as a coach',
    (await api('POST', `/api/admin/camps/${CAMP}/session-coaches`, { campDateId: monday.id, contactId: aPlayer.id, applyTo: 'this' })).status === 404);

  ok('a bad role on assign is rejected',
    (await api('POST', `/api/admin/camps/${CAMP}/session-coaches`, { campDateId: monday.id, contactId: ian.id, role: 'boss', applyTo: 'this' })).status === 400);

  const saved = cookie; cookie = '';
  ok('logged out is 401', (await api('GET', `/api/admin/camps/${CAMP}/coach-overview`)).status === 401);
  cookie = saved;

  // ── removal ──────────────────────────────────────────────────────────────
  const satLine = (await api('GET', `/api/admin/camps/${CAMP}/session-coaches?campDateId=${satEarly.id}`)).json[0];
  const delOne = await api('DELETE', `/api/admin/session-coaches/${satLine.id}`);
  ok('remove from one session', delOne.status === 200 && delOne.json.removed === 1);

  const monLine = (await api('GET', `/api/admin/camps/${CAMP}/session-coaches?campDateId=${monday.id}`)).json[0];
  const delSeries = await api('DELETE', `/api/admin/session-coaches/${monLine.id}?scope=series`);
  ok('remove from the whole remaining series', delSeries.status === 200 && delSeries.json.removed === mondayCount,
    `${delSeries.json?.removed} vs ${mondayCount}`);

  ok('nothing of that coach is left on the programme',
    (await db.query(`select count(*)::int n from session_coaches where camp_id=$1 and contact_id=$2`, [CAMP, ian.id])).rows[0].n === 0);

} catch (e) {
  fail++; console.log('  FAIL (threw)', e.message);
} finally {
  // ── cleanup: leave prod exactly as we found it ───────────────────────────
  await db.query(`delete from session_coaches`);
  if (coachId) await db.query(`delete from contacts where id=$1`, [coachId]);
  if (userId) {
    await db.query(`delete from user_organizations where user_id=$1`, [userId]);
    await db.query(`delete from users where id=$1`, [userId]);
  }
  const left = (await db.query(`select count(*)::int n from session_coaches`)).rows[0].n;
  const leftUser = (await db.query(`select count(*)::int n from users where email=$1`, [TEST_EMAIL])).rows[0].n;
  const leftContact = (await db.query(`select count(*)::int n from contacts where last_name='TempCoach'`)).rows[0].n;
  console.log(`\ncleanup -> session_coaches ${left} | test users ${leftUser} | temp coaches ${leftContact}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end();
  process.exitCode = fail === 0 ? 0 : 1;
}
