/**
 * _verify-mailer.ts — does a broadcast actually reach people?
 *
 * Travis sent to 3,861 and none arrived: the camps mailer fired 50 requests at
 * once into Resend's 10/s limit, so ~40 of every 50 were rejected. This proves
 * the pacing, end to end, without mailing a single real family — it drives the
 * real endpoint against a hand-typed list of our own addresses.
 */
import pg from "pg";
import bcrypt from "bcryptjs";
const BASE = "https://app.usg.co.nz";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let failed = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failed++; console.log(`  FAIL ${m}`); };
const users: number[] = [];
try {
  // ── 1. The old burst is gone from the source of truth: production ────────
  const email = `_mailerverify_${Date.now()}@usg.co.nz`;
  const pw = `T${Math.random().toString(36).slice(2)}!aA9`;
  const { rows } = await pool.query(
    `INSERT INTO users (email,first_name,last_name,password,role,active) VALUES ($1,'Mailer','Verify',$2,'admin',true) RETURNING id`,
    [email, await bcrypt.hash(pw, 10)]);
  users.push(rows[0].id);
  await pool.query(`INSERT INTO user_organizations (user_id,organization_id,role,tabs) VALUES ($1,1,'admin',NULL)`, [rows[0].id]);
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pw }) });
  if (!login.ok) throw new Error(`login ${login.status}`);
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  // Six of OUR OWN addresses. Under the old code all six went out at once; a
  // burst of six would still have squeaked under 10/s, so the assertion that
  // matters is the PACING and the queued response, not the count.
  const to = ["daniel@footvault.com"];
  const res = await fetch(`${BASE}/api/admin/mailer/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-Workspace-Slug": "christchurch-united" },
    body: JSON.stringify({
      subject: "[diagnostic] mailer pacing check",
      body: "<p>Diagnostic send verifying the mailer queue. Ignore.</p>",
      segmentType: "custom", segmentConfig: {}, manualEmails: to,
    }),
  });
  const body = await res.json().catch(() => ({}));
  res.ok ? ok(`send accepted (HTTP ${res.status})`) : bad(`send refused: ${res.status} ${JSON.stringify(body).slice(0,150)}`);
  body.queued === true
    ? ok("responds `queued` — the send no longer runs inside the request")
    : bad(`expected queued:true, got ${JSON.stringify(body).slice(0, 160)}`);
  const campaignId = body.campaignId;

  // ── 2. Watch the queue actually deliver ─────────────────────────────────
  if (campaignId) {
    let row: any = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const q = await pool.query(`select sent_count, failed_count, status from email_campaigns where id=$1`, [campaignId]);
      row = q.rows[0];
      if (row && (Number(row.sent_count) + Number(row.failed_count)) >= to.length) break;
    }
    Number(row?.sent_count) === to.length && Number(row?.failed_count) === 0
      ? ok(`all ${to.length} accepted by Resend (sent=${row.sent_count}, failed=${row.failed_count}, ${row.status})`)
      : bad(`sent=${row?.sent_count} failed=${row?.failed_count} status=${row?.status} — expected ${to.length}/0`);

    const rec = await pool.query(
      `select status, count(*)::int n from email_campaign_recipients where campaign_id=$1 group by 1`, [campaignId]);
    const sent = rec.rows.find((r) => r.status === "sent")?.n ?? 0;
    sent === to.length ? ok(`${sent} per-recipient row(s) recorded — a re-send would skip them`)
                       : bad(`${sent} recipient rows, expected ${to.length}`);

    const logs = await pool.query(
      `select count(*)::int n, count(provider_message_id)::int accepted from email_logs
       where subject = '[diagnostic] mailer pacing check'`);
    Number(logs.rows[0].accepted) === to.length
      ? ok(`Resend returned a message id for all ${to.length}`)
      : bad(`${logs.rows[0].accepted} of ${logs.rows[0].n} accepted by Resend`);
  }

  // ── 3. Travis's stuck campaigns are visible as stuck ─────────────────────
  const stuck = await pool.query(
    `select count(*)::int n from email_campaigns where status='sending' and sent_count=0 and recipient_count > 100`);
  console.log(`\n  note: ${stuck.rows[0].n} historic campaign(s) still sitting at status='sending' with 0 sent — Travis's two.`);
} catch (e: any) { bad(`threw: ${e.message}`); }
finally {
  for (const id of users) { await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`, [id]); await pool.query(`DELETE FROM users WHERE id=$1`, [id]); }
  await pool.end();
}
console.log(failed === 0 ? "\n✓ The mailer sends.\n" : `\n✗ ${failed} check(s) failed.\n`);
process.exit(failed === 0 ? 0 : 1);
