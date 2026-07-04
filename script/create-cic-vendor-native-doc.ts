// Create (and optionally send) a NATIVE e-Sign document from a CIC vendor
// template — the web-page agreement flow (e-Sign v2). Faithfully mirrors the
// POST /api/admin/esign/from-template endpoint so it behaves identically to a
// send from the e-Sign tab, but scriptable for batch vendor sends.
//
// Signing order (sequential): recipient (the Vendor) signs first + fills their
// details, then the Club counter-signs. The recipient gets the invite on send.
//
// Usage (from apps/clubos):
//   npx tsx --env-file=.env script/create-cic-vendor-native-doc.ts \
//     --template cic-food-vendor-agreement \
//     --name "Rollicious" --email hello@rollicious.co.nz [--send]
//   (omit --send to leave it as a DRAFT for Daniel to send from the e-Sign tab)
//   optional: --trading-period "5–16 July 2026"  --message "..."  --title "..."
//             --counter-name "Daniel Meyn"  --counter-email danielmeyn963@gmail.com
//
// Templates: cic-food-vendor-agreement | cic-popup-vendor-agreement  (org: CIC = 5)

import { Pool } from "pg";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { renderNativePdf } from "../server/esign-native-pdf";
import { fromForOrg } from "../shared/org-domains";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORG_SLUG = "christchurch-international-cup";
const APP_BASE = (process.env.APP_URL || "https://app.usg.co.nz").replace(/\/+$/, "");
const LOGO_PATH = path.join(__dirname, "../client/public/logos/christchurch-international-cup.png");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

// Exact copy of routes.ts esignInviteHtml (CIC gold gradient).
const inviteHtml = (p: { signerName: string; title: string; message: string | null; link: string; fromName: string }) => `
    <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
      <div style="height:6px;background:linear-gradient(90deg,#937224,#C9A43E,#E4C56A)"></div>
      <div style="padding:28px 24px">
        <p style="font-size:15px">Kia ora ${p.signerName},</p>
        <p style="font-size:15px;line-height:1.6">${p.fromName} has sent you a document to review and sign electronically:</p>
        <p style="font-size:17px;font-weight:700;margin:16px 0">${p.title}</p>
        ${p.message ? `<p style="font-size:14px;color:#555;font-style:italic;border-left:3px solid #C9A43E;padding-left:12px">${p.message}</p>` : ""}
        <p style="margin:26px 0"><a href="${p.link}" style="background:#C9A43E;color:#1a1a1a;font-weight:700;text-decoration:none;padding:13px 26px;border-radius:10px;display:inline-block">Review &amp; sign</a></p>
        <p style="font-size:12px;color:#888;line-height:1.6">Or paste this link into your browser:<br>${p.link}</p>
        <p style="font-size:11px;color:#aaa;margin-top:24px">You're receiving this because ${p.fromName} requested your signature. Signing is electronic and legally valid under the Contract and Commercial Law Act 2017 (NZ).</p>
      </div>
    </div>`;

async function sendViaResend(from: string, to: string, subject: string, html: string) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY not set — cannot send");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
  const slug = arg("--template");
  const name = arg("--name")?.trim();
  const email = arg("--email")?.trim().toLowerCase();
  if (!slug || !name || !email || !/.+@.+\..+/.test(email)) {
    throw new Error('Usage: --template <slug> --name "Vendor" --email x@y.nz [--send] [--trading-period "..."] [--message "..."]');
  }
  const doSend = has("--send");
  const counterName = arg("--counter-name")?.trim() || "Daniel Meyn";
  const counterEmail = arg("--counter-email")?.trim().toLowerCase() || "danielmeyn963@gmail.com";
  const overridePeriod = arg("--trading-period");
  const message = arg("--message") ?? null;

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const org = await client.query(`SELECT id, name FROM organizations WHERE slug = $1`, [ORG_SLUG]);
    if (!org.rows.length) throw new Error(`Organization '${ORG_SLUG}' not found`);
    const orgId = org.rows[0].id as number;
    const orgName = org.rows[0].name as string;

    const tres = await client.query(
      `SELECT id, name, brand, content, variables, form, settings FROM esign_templates
       WHERE organization_id = $1 AND slug = $2 AND active = true`,
      [orgId, slug],
    );
    if (!tres.rows.length) throw new Error(`Template '${slug}' not found for org ${orgId} — seed it first`);
    const tpl = tres.rows[0];
    const tplVars: any[] = tpl.variables ?? [];
    const tplForm: any[] = tpl.form ?? [];
    const tplSettings: Record<string, any> = tpl.settings ?? {};

    // Build sender-set variable values (defaults + trading_period override).
    const templateData: Record<string, string> = {};
    for (const v of tplVars) {
      let raw = "";
      if (v.key === "trading_period" && overridePeriod) raw = overridePeriod;
      if (!raw && v.default) raw = String(v.default);
      if (v.required !== false && !raw) throw new Error(`Variable '${v.label || v.key}' is required`);
      templateData[v.key] = raw.slice(0, 200);
    }

    const createdByRes = await client.query(`SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [counterEmail]);
    const createdBy = createdByRes.rows[0]?.id ?? null;

    const title = (arg("--title")?.trim() || `${tpl.name} — ${name}`).slice(0, 160);

    await client.query("BEGIN");
    // Native doc: source_pdf/doc_hash filled after we typeset (below). Start blank.
    const dres = await client.query(
      `INSERT INTO esign_documents
         (organization_id, title, message, status, sequential, doc_type, template_id, template_data, source_file_name, source_pdf, doc_hash, created_by)
       VALUES ($1, $2, $3, 'draft', true, 'native', $4, $5, NULL, '', '', $6) RETURNING id`,
      [orgId, title, message, tpl.id, JSON.stringify(templateData), createdBy],
    );
    const docId = dres.rows[0].id as number;

    // Signers: order 0 = recipient (Vendor, signs first), order 1 = Club counter-sign.
    const tokens: Record<number, string> = {};
    const signers = [
      { name, email, order: 0 },
      { name: counterName, email: counterEmail, order: 1 },
    ];
    for (const s of signers) {
      const token = crypto.randomBytes(24).toString("hex");
      tokens[s.order] = token;
      await client.query(
        `INSERT INTO esign_signers (document_id, organization_id, name, email, signing_order, status, token)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
        [docId, orgId, s.name, s.email, s.order, token],
      );
    }

    // Typeset the UNSIGNED agreement (blank details) — this exact render is hashed
    // as the "what was sent" record, matching esignRenderNativeDoc(doc, tpl, false).
    let logoBytes: Uint8Array | null = null;
    try { logoBytes = new Uint8Array(fs.readFileSync(LOGO_PATH)); } catch { logoBytes = null; }
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(templateData)) values[k] = String(v);
    const parties = [
      { role: String(tplSettings.counterSignerRole || "The Club"), name: null, signatureImage: null, signedAt: null },
      { role: String(tplSettings.primarySignerRole || "The Vendor"), name: null, signatureImage: null, signedAt: null },
    ];
    const sourceBytes = await renderNativePdf({
      brand: tpl.brand,
      settings: tplSettings,
      content: tpl.content,
      values,
      formSpec: tplForm.map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required })),
      formData: null,
      refereeEmail: email,
      parties,
      guardian: null,
      logoBytes,
      envelopeId: docId,
    });
    const buf = Buffer.from(sourceBytes);
    const docHash = crypto.createHash("sha256").update(buf).digest("hex");
    await client.query(`UPDATE esign_documents SET source_pdf = $1, doc_hash = $2 WHERE id = $3`, [buf.toString("base64"), docHash, docId]);

    await client.query(
      `INSERT INTO esign_events (document_id, type, actor_email, meta) VALUES ($1, 'created', $2, $3)`,
      [docId, counterEmail, JSON.stringify({ template: slug, signers: 2, source: "create-cic-vendor-native-doc" })],
    );

    if (doSend) {
      await client.query(`UPDATE esign_documents SET status = 'sent', sent_at = now() WHERE id = $1`, [docId]);
      await client.query(`INSERT INTO esign_events (document_id, type, actor_email) VALUES ($1, 'sent', $2)`, [docId, counterEmail]);
    }
    await client.query("COMMIT");

    const signUrl = `${APP_BASE}/sign/${tokens[0]}`;
    console.log(`\n${doSend ? "SENT" : "DRAFT"}: native e-Sign doc #${docId} — "${title}"`);
    console.log(`  Recipient (signs first): ${name} <${email}>`);
    console.log(`  Counter-sign (Club):     ${counterName} <${counterEmail}>`);
    console.log(`  Recipient sign URL:      ${signUrl}`);
    console.log(`  doc_hash: ${docHash}`);

    if (doSend) {
      const from = fromForOrg(orgId, orgName); // Christchurch International Cup <noreply@cicyouth.com>
      await sendViaResend(from, email, `Please sign: ${title}`, inviteHtml({
        signerName: name, title, message, link: signUrl, fromName: orgName,
      }));
      console.log(`  ✉️  Invite emailed from ${from} → ${email}`);
    } else {
      console.log(`  (not sent — press Send in the CIC e-Sign tab, or re-run with --send)`);
    }
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error("❌", e.message ?? e); process.exit(1); });
