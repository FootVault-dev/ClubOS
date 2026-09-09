// One-time: connect ClubOS to Xero with the scopes the payout poster needs.
//
//   npx tsx --env-file=../../.env script/connect-xero.ts
//
// Opens Xero's consent screen, captures the callback on localhost, and writes
// the tokens into `org_integrations` in exactly the shape `handleCallback` uses —
// so `getXeroForOrg()` picks it up with no code change and no deploy.
//
// 🔴 The refresh token ROTATES on every use. This writes it to the DATABASE, not
// to .env, so ClubOS owns its own chain and the DataOS collector's token in .env
// is left alone. Two chains, neither rotating the other's.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { Client } from "pg";

// 🔴 The two halves of this script live in DIFFERENT .env files: the Xero app
// credentials are the workspace's, the database is ClubOS's. Passing one
// --env-file got the consent all the way through and then lost the tokens on the
// database write — and an auth code is single-use, so that costs another trip to
// the browser. Read both, explicitly, and never depend on which one was passed.
function envFrom(file: string, keys: string[]) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i < 1 || line.startsWith("#")) continue;
    const k = line.slice(0, i).trim();
    if (keys.includes(k) && !process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}
const HERE = process.cwd();
envFrom(path.resolve(HERE, "../../.env"), ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET"]);
envFrom(path.resolve(HERE, ".env"), ["DATABASE_URL"]);

const CLIENT_ID = (process.env.XERO_CLIENT_ID || "").trim();
const CLIENT_SECRET = (process.env.XERO_CLIENT_SECRET || "").trim();
const REDIRECT_URI = "http://localhost:8080/callback";
const PORT = 8080;

// 🔴 This Xero app uses Xero's GRANULAR scopes, so the broad ones are REFUSED —
// `accounting.transactions`, `accounting.transactions.read`, `accounting.reports.read`
// and `accounting.journals.read` all come back `invalid_scope` at the consent
// screen (which is what ClubOS's own xero.ts still asks for, so its built-in
// connect flow cannot work as written). Each was probed one at a time against
// the live authorize endpoint rather than guessed.
//
// `accounting.banktransactions` is the write scope a Receive Money needs — the
// granular replacement for `accounting.transactions`.
const SCOPES = [
  "openid", "profile", "email", "offline_access",
  "accounting.banktransactions",              // WRITE — the payout's Receive Money
  "accounting.settings.read",                 // chart of accounts, tracking, tax rates
  "accounting.contacts",                      // the "Stripe" contact on the document
  "accounting.reports.profitandloss.read",    // keeps the P&L readable
  "accounting.invoices.read",
  "accounting.payments.read",
  "accounting.manualjournals",                // term-fee deferrals, later
].join(" ");

const basic = () => Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

(async () => {
  // 🔴 Check EVERYTHING the script needs BEFORE opening the browser. The whole
  // point is that a human's click is the expensive part; discovering a missing
  // variable after they have clicked wastes it.
  if (!CLIENT_ID || !CLIENT_SECRET) { console.error("XERO_CLIENT_ID / XERO_CLIENT_SECRET not found in ../../.env"); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not found in ./.env — run this from apps/clubos"); process.exit(1); }
  {
    const probe = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try { await probe.connect(); await probe.query("SELECT 1"); await probe.end(); }
    catch (e: any) { console.error("cannot reach the database, so the tokens would be lost:", e?.message); process.exit(1); }
    console.log("database reachable ✓");
  }

  const state = Math.random().toString(36).slice(2);
  const authUrl = `https://login.xero.com/identity/connect/authorize?` + new URLSearchParams({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPES, state,
  }).toString();

  const code: string = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url!, `http://localhost:${PORT}`);
      if (!u.pathname.startsWith("/callback")) { res.writeHead(404).end(); return; }
      const err = u.searchParams.get("error");
      const got = u.searchParams.get("code");
      // 🔴 Says "received", never "connected". The tokens are not stored yet and
      // the storing step can fail — on the first run it did, and this page had
      // already told Daniel it was connected, which sent him looking in the
      // wrong place. A browser page must never report on work still to come.
      res.writeHead(err || !got ? 400 : 200, { "Content-Type": "text/html" });
      res.end(`<html><body style="font-family:system-ui;padding:48px;text-align:center">
        <h2>${err || !got ? "Not connected" : "Xero sent us back — finishing in the terminal"}</h2>
        <p>${err ?? "You can close this tab. The terminal will confirm."}</p></body></html>`);
      server.close();
      if (u.searchParams.get("state") !== state) return reject(new Error("state mismatch — do not trust this callback"));
      if (err || !got) return reject(new Error(err ?? "no code returned"));
      resolve(got);
    });
    server.listen(PORT, () => {
      console.log("\nOpening Xero's consent screen in your browser…");
      console.log("If it does not open, paste this:\n\n" + authUrl + "\n");
      exec(`open "${authUrl}"`);
      console.log("Waiting for you to press Allow…");
    });
    server.on("error", reject);
  });

  // --- exchange -----------------------------------------------------------
  const tokRes = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
  });
  const tok: any = await tokRes.json();
  if (!tok.access_token) { console.error("token exchange failed:", JSON.stringify(tok)); process.exit(1); }
  console.log("\ngranted scopes:", tok.scope);

  const conns: any = await (await fetch("https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" },
  })).json();
  if (!Array.isArray(conns) || conns.length === 0) { console.error("no Xero organisation granted"); process.exit(1); }
  console.log("organisations granted:", conns.map((c: any) => c.tenantName).join(", "));
  const tenant = conns[0];

  // --- store, in handleCallback's exact shape -----------------------------
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const org = (await c.query(`SELECT id, name FROM organizations WHERE slug='christchurch-united' OR name ILIKE '%Christchurch United%' ORDER BY id LIMIT 1`)).rows[0];
  const expires = new Date(Date.now() + (tok.expires_in ?? 1800) * 1000);
  await c.query(`
    INSERT INTO org_integrations (organization_id, provider, is_active, access_token, refresh_token, token_expires_at, external_id, external_name, config_json, connected_at, created_at, updated_at)
    VALUES ($1,'xero',true,$2,$3,$4,$5,$6,$7,now(),now(),now())
    ON CONFLICT (organization_id, provider) DO UPDATE SET
      is_active=true, access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token,
      token_expires_at=EXCLUDED.token_expires_at, external_id=EXCLUDED.external_id,
      external_name=EXCLUDED.external_name, connected_at=now(), updated_at=now()`,
    [org.id, tok.access_token, tok.refresh_token, expires, tenant.tenantId, tenant.tenantName, JSON.stringify({ tenantType: tenant.tenantType, scope: tok.scope })]);
  await c.end();

  console.log(`\n🟢 ClubOS org ${org.id} (${org.name}) → Xero "${tenant.tenantName}"`);
  console.log("   stored in org_integrations; the refresh token lives in the DB and rotates there.");
  process.exit(0);
})().catch(e => { console.error("\nFAILED:", e?.message ?? e); process.exit(1); });
