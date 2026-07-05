// Email a copy of an e-Sign document's UNSIGNED source PDF to an address.
// Used to give the Club counter-signer (Daniel) an immediate preview before
// their sequential turn arrives. Reads source_pdf (base64) off esign_documents
// and sends via Resend from the org's own domain — same branding as the invite.
//
// Usage (from apps/clubos):
//   npx tsx --env-file=.env script/email-signer-copy.ts \
//     --doc 27 --to daniel@footvault.com --subject "..." --note "..."

import { Pool } from "pg";
import { fromForOrg } from "../shared/org-domains";

function arg(f: string): string | undefined {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const docId = Number(arg("--doc"));
  const to = arg("--to")?.trim().toLowerCase();
  const subject = arg("--subject")?.trim() || "Your copy";
  const note = arg("--note") ?? "";
  if (!docId || !to || !/.+@.+\..+/.test(to)) throw new Error("--doc <id> --to <email> required");
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY not set");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT d.title, d.source_pdf, d.organization_id, o.name AS org_name
         FROM esign_documents d JOIN organizations o ON o.id = d.organization_id
        WHERE d.id = $1`,
      [docId],
    );
    if (!r.rows.length) throw new Error(`doc ${docId} not found`);
    const { title, source_pdf, organization_id, org_name } = r.rows[0] as any;
    if (!source_pdf) throw new Error(`doc ${docId} has no source_pdf`);
    const from = fromForOrg(organization_id, org_name);
    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
        <div style="height:6px;background:linear-gradient(90deg,#937224,#C9A43E,#E4C56A)"></div>
        <div style="padding:28px 24px">
          <p style="font-size:15px;line-height:1.6">${note}</p>
          <p style="font-size:13px;color:#888;margin-top:18px">Document: <strong>${title}</strong> — attached as a PDF.</p>
        </div>
      </div>`;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to, subject, html,
        attachments: [{ filename: `${title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}.pdf`, content: source_pdf }],
      }),
    });
    if (!res.ok) throw new Error(`Resend failed (${res.status}): ${await res.text()}`);
    console.log(`✉️  Copy emailed from ${from} → ${to} (doc #${docId})`);
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
