// Create a DRAFT e-Sign envelope for a CIC food-truck vendor agreement:
// the MASTER blank template + pre-placed fields (vendor signer fills everything
// themselves + club counter-signer), linked to the vendor row so
// contract_status syncs (pending -> sent -> signed).
//
// Creates DRAFTS only — nothing is emailed. Daniel reviews in the e-Sign tab
// (Prepare shows the pre-placed fields) and hits "Send" there.
//
// The single master PDF + fields.json come from the AIOS generator:
//   outputs/cic-food-vendor-agreement/make_vendor_agreement.py
//   -> outputs/cic-food-vendor-agreement/master/
//
// Usage (from apps/clubos):
//   npx tsx --env-file=.env script/create-vendor-esign-drafts.ts \
//     --vendor "Empire Chicken" --email owner@empirechicken.co.nz [--contact "Full Name"]
//
// Repeatable per vendor. Refuses to run if the vendor already has a linked doc.

import { Pool } from "pg";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const MASTER_DIR = path.resolve(
  process.env.VENDOR_AGREEMENTS_DIR ??
    path.join(__dirname, "../../../outputs/cic-food-vendor-agreement/master"),
);
const CLUB_SIGNER = { name: "Daniel Meyn", email: "danielmeyn963@gmail.com" };

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const vendorName = arg("--vendor");
  const email = arg("--email")?.trim().toLowerCase();
  if (!vendorName || !email || !/.+@.+\..+/.test(email)) {
    throw new Error('Usage: --vendor "Empire Chicken" --email owner@example.co.nz [--contact "Full Name"]');
  }
  const contactName = arg("--contact")?.trim() || `${vendorName} (Authorised Signatory)`;

  const meta = JSON.parse(fs.readFileSync(path.join(MASTER_DIR, "fields.json"), "utf8"));
  const pdfBuf = fs.readFileSync(path.join(MASTER_DIR, meta.pdf));
  if (pdfBuf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("Generated file is not a PDF");
  const pdfB64 = pdfBuf.toString("base64");
  const docHash = crypto.createHash("sha256").update(pdfBuf).digest("hex");

  const client = await pool.connect();
  try {
    const vres = await client.query(
      `SELECT id, organization_id, esign_document_id FROM cic_vendors WHERE lower(name) = lower($1)`,
      [vendorName],
    );
    if (!vres.rows.length) throw new Error(`Vendor "${vendorName}" not found in cic_vendors`);
    const vendor = vres.rows[0];
    if (vendor.esign_document_id) {
      throw new Error(`Vendor already linked to e-Sign doc #${vendor.esign_document_id} — void/delete it first if re-issuing`);
    }

    const ures = await client.query(`SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [CLUB_SIGNER.email]);
    const createdBy = ures.rows[0]?.id ?? null;

    await client.query("BEGIN");
    // Sequential: Daniel (club) signs FIRST, then the vendor gets their invite
    // with the club signature already on the document.
    const dres = await client.query(
      `INSERT INTO esign_documents (organization_id, title, message, status, sequential, source_file_name, source_pdf, doc_hash, created_by)
       VALUES ($1, $2, $3, 'draft', true, $4, $5, $6, $7) RETURNING id`,
      [
        vendor.organization_id,
        `CIC 2026 Vendor Agreement — ${vendorName}`,
        `Kia ora — please review and sign the attached Food & Beverage Vendor Agreement for the Christchurch International Cup 2026 (${meta.terms.trading_period}). You'll just need your registration and certificate numbers — no documents to upload. Any questions, reply to this email.`,
        meta.pdf,
        pdfB64,
        docHash,
        createdBy,
      ],
    );
    const docId = dres.rows[0].id;

    const signerIds: Record<string, number> = {};
    const signerList = [
      { name: CLUB_SIGNER.name, email: CLUB_SIGNER.email, owner: "club" },
      { name: contactName, email, owner: "vendor" },
    ];
    for (const [order, s] of signerList.entries()) {
      const token = crypto.randomBytes(24).toString("hex");
      const r = await client.query(
        `INSERT INTO esign_signers (document_id, organization_id, name, email, signing_order, status, token)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING id`,
        [docId, vendor.organization_id, s.name, s.email, order, token],
      );
      signerIds[s.owner] = r.rows[0].id;
    }

    for (const f of meta.fields) {
      await client.query(
        `INSERT INTO esign_fields (document_id, signer_id, page, x, y, w, h, type, required, label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [docId, signerIds[f.owner], f.page, f.x, f.y, f.w, f.h, f.type, f.required, f.label],
      );
    }

    await client.query(
      `INSERT INTO esign_events (document_id, type, actor_email, meta)
       VALUES ($1, 'created', $2, $3)`,
      [docId, CLUB_SIGNER.email, JSON.stringify({ signers: 2, source: "create-vendor-esign-drafts", vendor: vendorName })],
    );

    await client.query(
      `UPDATE cic_vendors SET esign_document_id = $1, contract_status = 'pending', contact_email = COALESCE(contact_email, $2) WHERE id = $3`,
      [docId, email, vendor.id],
    );
    await client.query("COMMIT");

    console.log(`Draft created: e-Sign doc #${docId} — "${vendorName}" (${meta.fields.length} fields, SEQUENTIAL: club signs first, then ${email}).`);
    console.log(`Review + send from the CIC workspace e-Sign tab on app.usg.co.nz — Daniel gets the first signing email on send.`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
