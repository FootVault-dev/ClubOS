/**
 * Prove the Fines tab works on PRODUCTION, end to end, and that only the right
 * people can reach it.
 *
 *   npx tsx --env-file=.env script/_verify-fines-live.ts
 *
 * Drives the real lifecycle over HTTP — log a fine, attach the notice, mark it
 * paid, attach the receipt, download both through the signed-URL redirect — and
 * proves the three invariants the database enforces actually surface as useful
 * errors rather than 500s. Throwaway accounts mirror the membership shapes that
 * matter and are deleted afterwards; every fine it creates is deleted too.
 */
import pg from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const BASE = "https://app.usg.co.nz";
const WS = "united-sports-group";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); };

const made: number[] = [];
const madeFines: number[] = [];

async function mkUser(globalRole: string, wsRole: string, tabs: string[] | null, unlocked: string[] | null) {
  const email = `fineprobe-${crypto.randomBytes(5).toString("hex")}@example.com`;
  const password = crypto.randomBytes(16).toString("base64url");
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Fine','Probe',$2,$3,true) RETURNING id`, [email, hash, globalRole]);
  const id = r.rows[0].id; made.push(id);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs, unlocked_tabs)
     VALUES ($1, 7, $2, $3::jsonb, $4::jsonb)`,
    [id, wsRole, tabs === null ? null : JSON.stringify(tabs), unlocked === null ? null : JSON.stringify(unlocked)]);
  return { id, email, password };
}

async function login(email: string, password: string) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(`login failed ${r.status}`);
  return (r.headers.get("set-cookie") || "").split(";")[0];
}

const call = (cookie: string, method: string, path: string, body?: any) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, "X-Workspace-Slug": WS, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

try {
  // ── Who can reach it ───────────────────────────────────────────────────────
  const granted = await mkUser("team_member", "team_member", ["calendar"], ["fines"]);
  const noGrant = await mkUser("team_member", "admin", null, null);
  const vehiclesOnly = await mkUser("team_member", "admin", null, ["vehicles"]);

  const cG = await login(granted.email, granted.password);
  const cN = await login(noGrant.email, noGrant.password);
  const cV = await login(vehiclesOnly.email, vehiclesOnly.password);

  ok("a granted team_member reaches Fines", (await call(cG, "GET", "/api/admin/fines")).status === 200);
  ok("🔴 a USG admin with no grant is refused", (await call(cN, "GET", "/api/admin/fines")).status === 403);
  ok("🔴 a Vehicles grant does NOT open Fines", (await call(cV, "GET", "/api/admin/fines")).status === 403);
  ok("…and that same person still reaches Vehicles", (await call(cV, "GET", "/api/admin/vehicles")).status === 200);

  // ── The lifecycle ──────────────────────────────────────────────────────────
  const ref = `PROBE-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const created = await call(cG, "POST", "/api/admin/fines", {
    direction: "club_owes", category: "parking", counterparty: "Probe Council",
    reference: ref, amountCents: 4000, offenceOn: "2026-08-01",
    issuedOn: "2026-08-05", dueOn: "2026-09-02", description: "Verification probe",
  });
  ok("a fine can be logged", created.status === 201, `HTTP ${created.status}`);
  const fine = (await created.json())?.fine;
  if (fine?.id) madeFines.push(fine.id);
  ok("it comes back unpaid, not overdue", fine?.status === "open", String(fine?.status));
  ok("money is stored in cents", fine?.amountCents === 4000, String(fine?.amountCents));

  // The duplicate a postal + emailed copy of the same notice would produce.
  const dupe = await call(cG, "POST", "/api/admin/fines", {
    direction: "club_owes", category: "parking", counterparty: "Probe Council",
    reference: ref.toLowerCase(), amountCents: 4000,
  });
  const dupeMsg = (await dupe.json().catch(() => ({})))?.message ?? "";
  ok("🔴 the same notice number twice is refused, in English",
     dupe.status === 400 && /already logged/i.test(dupeMsg), `${dupe.status} ${dupeMsg}`);

  // ── Attachments ────────────────────────────────────────────────────────────
  const attach = async (kind: string, filename: string, content: string) => {
    const body = new FormData();
    body.append("file", new Blob([content], { type: "application/pdf" }), filename);
    body.append("kind", kind);
    return fetch(`${BASE}/api/admin/fines/${fine.id}/attachments`, {
      method: "POST", headers: { cookie: cG, "X-Workspace-Slug": WS }, body,
    });
  };

  const noticeRes = await attach("notice", "infringement.pdf", "%PDF-1.4 probe notice");
  ok("the fine notice attaches", noticeRes.status === 201, `HTTP ${noticeRes.status}`);
  const noticeId = (await noticeRes.json())?.attachment?.id;

  const paid = await call(cG, "PATCH", `/api/admin/fines/${fine.id}`, {
    paidOn: "2026-08-20", paidReference: "PROBE-PAY-1",
  });
  ok("it can be marked paid", paid.status === 200);
  ok("…and then reads as paid", (await paid.json())?.fine?.status === "paid");

  const receiptRes = await attach("payment_confirmation", "receipt.pdf", "%PDF-1.4 probe receipt");
  ok("the payment confirmation attaches", receiptRes.status === 201);
  const receiptId = (await receiptRes.json())?.attachment?.id;

  const withBoth = await (await call(cG, "GET", `/api/admin/fines/${fine.id}`)).json();
  const kinds = (withBoth?.fine?.attachments ?? []).map((a: any) => a.kind).sort();
  ok("🔴 the notice and the receipt stay distinguishable",
     kinds.join(",") === "notice,payment_confirmation", kinds.join(","));

  // ── Files come back, privately ─────────────────────────────────────────────
  const dl = await fetch(`${BASE}/api/admin/fines/${fine.id}/attachments/${noticeId}`, {
    headers: { cookie: cG, "X-Workspace-Slug": WS }, redirect: "manual",
  });
  ok("a download 302s to a signed URL", dl.status === 302, `HTTP ${dl.status}`);
  const signed = dl.headers.get("location") ?? "";
  ok("…and the URL is time-limited, not a public link",
     /token=|X-Amz-|Expires|se=/i.test(signed), signed.slice(0, 60));
  if (signed) {
    const bytes = await fetch(signed);
    ok("…and it actually serves the file", bytes.ok && (await bytes.text()).includes("probe notice"));
  }

  // Someone without the tab must not be able to pull a file by guessing an id.
  const stolen = await fetch(`${BASE}/api/admin/fines/${fine.id}/attachments/${noticeId}`, {
    headers: { cookie: cN, "X-Workspace-Slug": WS }, redirect: "manual",
  });
  ok("🔴 a person without the tab cannot fetch the file", stolen.status === 403, `HTTP ${stolen.status}`);

  // ── A paid fine with paperwork is a record, not a scratch note ─────────────
  const del = await call(cG, "DELETE", `/api/admin/fines/${fine.id}`);
  const delMsg = (await del.json().catch(() => ({})))?.message ?? "";
  ok("🔴 a paid fine cannot be deleted", del.status === 400 && /paid/i.test(delMsg), delMsg);

  await call(cG, "PATCH", `/api/admin/fines/${fine.id}`, { paidOn: null, paidReference: null });
  const del2 = await call(cG, "DELETE", `/api/admin/fines/${fine.id}`);
  const del2Msg = (await del2.json().catch(() => ({})))?.message ?? "";
  ok("🔴 …and nor can one that still has its paperwork",
     del2.status === 400 && /attachment/i.test(del2Msg), del2Msg);

  // ── Totals are split by direction, never netted ────────────────────────────
  const owed = await call(cG, "POST", "/api/admin/fines", {
    direction: "owed_to_club", category: "disciplinary", counterparty: "Probe player",
    amountCents: 2500, dueOn: "2026-09-30",
  });
  const owedFine = (await owed.json())?.fine;
  if (owedFine?.id) madeFines.push(owedFine.id);
  const list = await (await call(cG, "GET", "/api/admin/fines")).json();
  ok("🔴 the two directions total separately",
     list?.totals?.club_owes?.outstandingCents === 4000 && list?.totals?.owed_to_club?.outstandingCents === 2500,
     `we owe ${list?.totals?.club_owes?.outstandingCents}, owed ${list?.totals?.owed_to_club?.outstandingCents}`);

  ok("the server sends NZ today", typeof list?.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(list.today), list?.today);

  // Cleanup of the files, then the fines, happens in `finally`.
  await fetch(`${BASE}/api/admin/fines/${fine.id}/attachments/${noticeId}`, { method: "DELETE", headers: { cookie: cG, "X-Workspace-Slug": WS } });
  await fetch(`${BASE}/api/admin/fines/${fine.id}/attachments/${receiptId}`, { method: "DELETE", headers: { cookie: cG, "X-Workspace-Slug": WS } });
  const del3 = await call(cG, "DELETE", `/api/admin/fines/${fine.id}`);
  ok("…but once the paperwork is gone, a mistaken entry can be removed", del3.status === 200);
  if (del3.status === 200) madeFines.splice(madeFines.indexOf(fine.id), 1);
} finally {
  for (const id of madeFines) {
    await pool.query(`DELETE FROM fine_attachments WHERE fine_id = $1`, [id]);
    await pool.query(`DELETE FROM fines WHERE id = $1`, [id]);
  }
  for (const id of made) {
    await pool.query(`DELETE FROM user_organizations WHERE user_id=$1`, [id]);
    await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
  }
  const left = await pool.query(`SELECT count(*)::int n FROM fines WHERE organization_id = 7`);
  console.log(`  cleaned up ${made.length} accounts, ${madeFines.length} fines · ${left.rows[0].n} real fines remain`);
  await pool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
