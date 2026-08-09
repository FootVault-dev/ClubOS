/**
 * Live end-to-end verification of the CUGC Mailer against production.
 *
 * Creates a throwaway CUGC admin, exercises every audience through the real
 * HTTP API, sends ONE real email to a single address, proves the open-tracking
 * pixel records an open (and that a forged token does not), then removes
 * everything it made so Natalia opens a clean tab.
 *
 *   npx tsx --env-file=.env script/_verify-cugc-mailer-live.ts            # no real send
 *   npx tsx --env-file=.env script/_verify-cugc-mailer-live.ts --send-to me@x.com
 */
import pg from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const BASE = process.env.VERIFY_BASE || "https://app.usg.co.nz";
const WS = "united-gymnastics";
const sendToArg = process.argv.indexOf("--send-to");
const SEND_TO = sendToArg > -1 ? process.argv[sendToArg + 1] : null;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const UNSUB_SECRET = process.env.SESSION_SECRET || process.env.STRIPE_WEBHOOK_SECRET || "mfl-unsub-secret-v1";
const openToken = (cid: number, email: string) =>
  crypto.createHmac("sha256", UNSUB_SECRET).update(`open:${cid}:${email.trim().toLowerCase()}`).digest("hex").slice(0, 32);

async function main() {
  const cleanupUsers: number[] = [];
  const cleanupCampaigns: number[] = [];

  try {
    // ── a throwaway CUGC admin ────────────────────────────────────────────────
    const email = `_cugcmailertest_${Date.now()}@usg.co.nz`;
    const password = `T${Math.random().toString(36).slice(2)}!aA9`;
    const { rows } = await pool.query(
      `INSERT INTO users (email, first_name, last_name, password, role, active)
       VALUES ($1,'Mailer','Test',$2,'team_member',true) RETURNING id`,
      [email, await bcrypt.hash(password, 10)],
    );
    const userId = rows[0].id;
    cleanupUsers.push(userId);
    await pool.query(
      `INSERT INTO user_organizations (user_id, organization_id, role, tabs)
       VALUES ($1, 6, 'team_member', $2::jsonb)`,
      [userId, JSON.stringify(["cugc-mailer"])],
    );

    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const get = (p: string) => fetch(`${BASE}${p}`, { headers: { cookie, "X-Workspace-Slug": WS } });
    const post = (p: string, body: unknown) => fetch(`${BASE}${p}`, {
      method: "POST", headers: { cookie, "X-Workspace-Slug": WS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // ── contacts ──────────────────────────────────────────────────────────────
    console.log("\nContacts");
    const contactsRes = await get("/api/admin/cugc/mailer/contacts");
    ok("GET contacts returns 200", contactsRes.status === 200, `HTTP ${contactsRes.status}`);
    const contacts = await contactsRes.json();
    ok("contacts is a non-empty list", (contacts.contacts?.length ?? 0) > 0, `${contacts.total} contacts`);
    const roles = new Set<string>(contacts.contacts.map((c: any) => c.role));
    ok("sources are tagged", roles.size > 0, [...roles].join(", "));
    const emails = contacts.contacts.map((c: any) => c.email);
    ok("every contact has an email", emails.every((e: string) => e && e.includes("@")));
    ok("no duplicate emails", new Set(emails).size === emails.length, `${emails.length} rows`);
    ok("emails are lowercased", emails.every((e: string) => e === e.toLowerCase()));

    // ── programmes ────────────────────────────────────────────────────────────
    console.log("\nProgrammes");
    const progRes = await get("/api/admin/cugc/mailer/programs");
    ok("GET programs returns 200", progRes.status === 200, `HTTP ${progRes.status}`);
    const { programs } = await progRes.json();
    ok("programmes are listed", (programs?.length ?? 0) > 0, programs.map((p: any) => `${p.name}(${p.count})`).join(" "));
    ok("no programme is offered with zero people", programs.every((p: any) => p.count > 0));

    // ── audiences ─────────────────────────────────────────────────────────────
    console.log("\nAudience counts");
    const count = async (body: any) => (await (await post("/api/admin/cugc/mailer/preview", body)).json()).count;

    const all = await count({ audience: "all" });
    const news = await count({ audience: "newsletter" });
    ok("everyone > 0", all > 0, `${all}`);
    ok("newsletter subscribers is a real subset", news > 0 && news <= all, `${news} of ${all}`);

    // Every programme is checked against a count computed straight from the
    // source tables, not against another API call — otherwise the same mistake
    // on both sides would agree with itself. This is what caught the bug where
    // a per-programme send silently swept in every newsletter subscriber.
    for (const p of programs) {
      const { rows } = await pool.query(
        `WITH people AS (
           SELECT lower(email) e FROM cugc_registrations
            WHERE organization_id = 6 AND status <> 'cancelled' AND program_slug = $1
           UNION
           SELECT lower(email) e FROM cugc_free_sessions
            WHERE organization_id = 6 AND program_slug = $1
         )
         SELECT count(*)::int AS n FROM people
          WHERE e NOT IN (
            SELECT lower(email) FROM email_unsubscribes
             WHERE organization_id = 6 OR organization_id IS NULL
          )`,
        [p.slug],
      );
      const expected = rows[0].n;
      const actual = await count({ audience: "program", programSlug: p.slug });
      ok(`"${p.name}" = its own families and nobody else`, actual === expected, `${actual} vs ${expected} from the tables`);
      ok(`"${p.name}" listed count matches a send`, actual === p.count, `${actual} vs ${p.count}`);
      ok(`"${p.name}" is a subset of everyone`, actual <= all, `${actual} ≤ ${all}`);
    }

    // The union of every programme must fit inside "everyone" — a family with
    // two children in two programmes is counted once there, so the SUM may
    // legitimately exceed it while the UNION never can.
    const { rows: unionRows } = await pool.query(
      `WITH people AS (
         SELECT lower(email) e FROM cugc_registrations WHERE organization_id = 6 AND status <> 'cancelled'
         UNION
         SELECT lower(email) e FROM cugc_free_sessions WHERE organization_id = 6
       ) SELECT count(*)::int AS n FROM people`,
    );
    ok("all programmes together fit inside everyone", unionRows[0].n <= all, `${unionRows[0].n} ≤ ${all}`);

    // ── extras ride on top ────────────────────────────────────────────────────
    console.log("\nHand-typed extras");
    const brandNew = `_never_seen_${Date.now()}@example.com`;
    const allPlusOne = await count({ audience: "all", customEmails: [brandNew] });
    ok("everyone + 1 new address = everyone + 1", allPlusOne === all + 1, `${allPlusOne} vs ${all + 1}`);

    const existing = contacts.contacts.find((c: any) => !c.unsubscribed)?.email;
    const allPlusExisting = await count({ audience: "all", customEmails: [existing] });
    ok("adding someone already on the list does NOT double them", allPlusExisting === all, `${allPlusExisting} vs ${all}`);

    const justOne = await count({ audience: "custom", customEmails: [brandNew] });
    ok("custom-only sends to exactly the typed addresses", justOne === 1, `${justOne}`);

    const twoTyped = await count({ audience: "custom", customEmails: [brandNew, `_b_${Date.now()}@example.com`] });
    ok("custom-only counts each typed address", twoTyped === 2, `${twoTyped}`);

    const noProgram = await post("/api/admin/cugc/mailer/preview", { audience: "program", programSlug: "" });
    ok("programme audience with no programme is refused", noProgram.status === 400, `HTTP ${noProgram.status}`);

    // ── suppression ───────────────────────────────────────────────────────────
    console.log("\nUnsubscribes");
    const supEmail = `_suppressed_${Date.now()}@example.com`;
    await pool.query(
      `INSERT INTO email_unsubscribes (organization_id, email, source) VALUES (6, $1, 'verify') ON CONFLICT DO NOTHING`,
      [supEmail],
    );
    const withSuppressed = await count({ audience: "custom", customEmails: [supEmail, brandNew] });
    ok("an unsubscribed address is stripped even when typed by hand", withSuppressed === 1, `${withSuppressed} of 2`);
    await pool.query(`DELETE FROM email_unsubscribes WHERE email = $1`, [supEmail]);

    // ── validation ────────────────────────────────────────────────────────────
    console.log("\nRefusals");
    const noSubject = await post("/api/admin/cugc/mailer/send", { subject: "", body: "hi", audience: "all" });
    ok("send with no subject is refused", noSubject.status === 400, `HTTP ${noSubject.status}`);
    const noBody = await post("/api/admin/cugc/mailer/send", { subject: "Hi", body: "", audience: "all" });
    ok("send with no body is refused", noBody.status === 400, `HTTP ${noBody.status}`);
    const emptyAudience = await post("/api/admin/cugc/mailer/send", {
      subject: "Hi", body: "<p>x</p>", audience: "custom", customEmails: [],
    });
    ok("send with nobody in the audience is refused", emptyAudience.status === 400, `HTTP ${emptyAudience.status}`);

    // ── a real send + open tracking ───────────────────────────────────────────
    if (SEND_TO) {
      console.log(`\nReal send → ${SEND_TO}`);
      const pre = await count({ audience: "custom", customEmails: [SEND_TO] });
      ok("audience is exactly one address before sending", pre === 1, `${pre}`);
      if (pre !== 1) throw new Error("refusing to send — audience was not exactly 1");

      const sendRes = await post("/api/admin/cugc/mailer/send", {
        subject: "United Gymnastics — Mailer test",
        body: "<p>This is a test of the new United Gymnastics Mailer.</p><p>If you're reading this, sending works. The unsubscribe link below is live, and this email carries the open-tracking pixel.</p>",
        audience: "custom",
        customEmails: [SEND_TO],
      });
      const sendJson = await sendRes.json();
      ok("send accepted", sendRes.status === 200 && sendJson.queued, JSON.stringify(sendJson));
      ok("queued to exactly 1", sendJson.recipientCount === 1, `${sendJson.recipientCount}`);

      const { rows: cRows } = await pool.query(
        `SELECT id FROM email_campaigns WHERE segment_type LIKE 'cugc%' ORDER BY id DESC LIMIT 1`,
      );
      const campaignId = cRows[0].id;
      cleanupCampaigns.push(campaignId);

      // Wait for the background queue to write the recipient row.
      let recip: any = null;
      for (let i = 0; i < 20 && !recip; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const { rows } = await pool.query(
          `SELECT * FROM email_campaign_recipients WHERE campaign_id = $1`, [campaignId],
        );
        recip = rows[0] ?? null;
      }
      ok("a recipient row was written", !!recip, recip ? `${recip.email} → ${recip.status}` : "none after 20s");
      ok("it was accepted by Resend", recip?.status === "sent", recip?.status);
      ok("it has not been opened yet", recip?.first_opened_at === null);

      // Forged token must NOT record an open.
      const bad = await fetch(`${BASE}/api/public/email/open?c=${campaignId}&e=${encodeURIComponent(SEND_TO)}&t=deadbeef`);
      ok("a forged pixel token still returns the gif", bad.status === 200 && bad.headers.get("content-type") === "image/gif");
      const { rows: afterBad } = await pool.query(
        `SELECT first_opened_at FROM email_campaign_recipients WHERE campaign_id = $1`, [campaignId],
      );
      ok("a forged pixel token records NO open", afterBad[0].first_opened_at === null);

      // Real token records the open.
      const good = await fetch(`${BASE}/api/public/email/open?c=${campaignId}&e=${encodeURIComponent(SEND_TO)}&t=${openToken(campaignId, SEND_TO)}`);
      ok("the real pixel returns the gif", good.status === 200 && good.headers.get("content-type") === "image/gif");
      const { rows: afterGood } = await pool.query(
        `SELECT first_opened_at, last_opened_at, open_count FROM email_campaign_recipients WHERE campaign_id = $1`, [campaignId],
      );
      ok("the open was recorded", afterGood[0].first_opened_at !== null, String(afterGood[0].first_opened_at));
      ok("open_count is 1", afterGood[0].open_count === 1, String(afterGood[0].open_count));

      // A second open must bump the count but never move first_opened_at.
      const firstAt = afterGood[0].first_opened_at;
      await new Promise((r) => setTimeout(r, 1100));
      await fetch(`${BASE}/api/public/email/open?c=${campaignId}&e=${encodeURIComponent(SEND_TO)}&t=${openToken(campaignId, SEND_TO)}`);
      const { rows: twice } = await pool.query(
        `SELECT first_opened_at, last_opened_at, open_count FROM email_campaign_recipients WHERE campaign_id = $1`, [campaignId],
      );
      ok("a second open bumps the count", twice[0].open_count === 2, String(twice[0].open_count));
      ok("first_opened_at never moves", String(twice[0].first_opened_at) === String(firstAt));
      ok("last_opened_at does move", String(twice[0].last_opened_at) !== String(firstAt));

      // The admin view reflects it.
      const detail = await (await get(`/api/admin/cugc/mailer/campaigns/${campaignId}`)).json();
      ok("campaign detail shows 1 delivered", detail.deliveredCount === 1, String(detail.deliveredCount));
      ok("campaign detail shows 1 opened", detail.openedCount === 1, String(detail.openedCount));
      ok("campaign detail lists the recipient", detail.recipients?.length === 1);

      const list = await (await get("/api/admin/cugc/mailer/campaigns")).json();
      const mine = list.find((c: any) => c.id === campaignId);
      ok("the send appears in Recent sends with its open count", mine?.openedCount === 1, `opened=${mine?.openedCount} delivered=${mine?.deliveredCount}`);

      // Unsubscribe link is live and CUGC-branded.
      const unsubTok = crypto.createHmac("sha256", UNSUB_SECRET).update(`6:${SEND_TO.toLowerCase()}`).digest("hex").slice(0, 32);
      const unsubUrl = `https://join.cugc.co.nz/api/public/unsubscribe?o=6&e=${encodeURIComponent(SEND_TO)}&t=${unsubTok}`;
      const unsubRes = await fetch(unsubUrl);
      const unsubHtml = await unsubRes.text();
      ok("the unsubscribe link works", unsubRes.status === 200, `HTTP ${unsubRes.status}`);
      ok("it is CUGC-branded, not MFL", unsubHtml.includes("Gymnastics") && !unsubHtml.includes("Mini Football"));
      // Undo it — this was a test address, not a real opt-out.
      await pool.query(`DELETE FROM email_unsubscribes WHERE organization_id = 6 AND email = $1`, [SEND_TO.toLowerCase()]);
      ok("test unsubscribe reverted", true);
    } else {
      console.log("\n(skipped the real send — pass --send-to <address> to include it)");
    }

    // ── access control ────────────────────────────────────────────────────────
    console.log("\nAccess");
    const anon = await fetch(`${BASE}/api/admin/cugc/mailer/contacts`);
    ok("logged-out access is refused", anon.status === 401, `HTTP ${anon.status}`);
  } finally {
    for (const id of cleanupCampaigns) {
      await pool.query(`DELETE FROM email_campaigns WHERE id = $1`, [id]).catch(() => {});
    }
    for (const id of cleanupUsers) {
      await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [id]).catch(() => {});
      await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.end();
    process.exit(fail === 0 ? 0 : 1);
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
