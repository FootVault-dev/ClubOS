/**
 * Seed the first USG Invoice: CUFC-2026-002, The Drifter partnership rebate.
 *
 * Values are copied VERBATIM from apps/invoices/src/data/drifter.ts — the
 * public payable page's own local seed record (used as its graceful fallback
 * before this ClubOS row exists). If the two ever disagree, that file is
 * wrong; this script is the one writing to the system of record.
 *
 *   12,844.15 + 4,972.32 = 17,816.47   and   17,816.47 × 5% = 890.82
 *
 * Nothing here is inferred — every figure traces back to that file's own
 * comment, which in turn traces to The Drifter's own eligible-spend summary
 * (relayed by Ryan Edwards, 2026-07-10).
 *
 * Seeds token="dr-9f4c2a7e6b1d84035ec7", number="CUFC-2026-002", org
 * "united-sports-group", isDraft=true, cardEnabled=false, status="draft" —
 * matching the source record exactly, including its four unresolved
 * draftReasons (GST treatment unconfirmed, invoice-number sequence
 * unconfirmed, no postal address on file, card payments off).
 *
 * Idempotent: upserts on the unique `token`. Re-running never duplicates the
 * row and never touches usg_invoice_events beyond one 'created' row on first
 * insert.
 *
 * Usage:
 *   npx tsx --env-file=.env script/seed-usg-invoices.ts            # dry run
 *   npx tsx --env-file=.env script/seed-usg-invoices.ts --commit   # apply
 */

import { Pool } from "pg";
import { invoiceUrl } from "../shared/invoice-types";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const COMMIT = process.argv.includes("--commit");

const ORG_SLUG = "united-sports-group";

const BRAND = "siu" as const;
const TOKEN = "dr-9f4c2a7e6b1d84035ec7";
const NUMBER = "CUFC-2026-002";

// Confirmed by Daniel 2026-07-10 (thedrifter.com 403s automated clients).
const RECIPIENT_ADDRESS = [
  "96 Lichfield Street",
  "Christchurch Central City",
  "Christchurch 8011",
  "New Zealand",
];

// ── Figures, verbatim from apps/invoices/src/data/drifter.ts ────────────────
const accommodationCents = 1_284_415; // "12,844.15"
const foodBeverageCents = 497_232; // "4,972.32"
const eligibleSpendCents = accommodationCents + foodBeverageCents; // 1,781,647
const rebateCents = Math.round(eligibleSpendCents * 0.05); // 89,082

// GST-inclusive breakdown — mirrors shared/invoice-money.ts
// (gstContentOfInclusive / exclusiveOfInclusive) so this script has no
// dependency on the app's path aliases. 15% inclusive => amount * 3/23.
const gstCents = Math.round((rebateCents * 3) / 23); // 11,619
const subtotalCents = rebateCents - gstCents; // 77,463
const totalCents = rebateCents; // 89,082 — GST-inclusive total is the line total

// Daniel cleared the draft banner on 2026-07-10. The open questions did not go
// away, they moved into outputs/invoices/2026-07-10-drifter-rebate/00-READ-FIRST.md:
// (1) is this a taxable supply from us at all, or a rebate The Drifter credit-notes,
// and (2) GST-inclusive vs plus-GST. Victor's call before this is sent.
const DRAFT_REASONS: string[] = [];

const SPEND_SUMMARY = {
  label: "Eligible spend",
  rows: [
    { label: "Direct accommodation bookings", amountCents: accommodationCents },
    { label: "Rambler food & beverage spend", amountCents: foodBeverageCents },
  ],
  totalLabel: "Total eligible spend",
};

const LINES = [
  {
    description: "Partnership rebate",
    detail: "5% of total eligible spend",
    amountCents: rebateCents,
  },
];

const NOTES = [
  "This rebate relates to eligible spend to 10 July 2026.",
  "Bank transfer is the fastest way to settle and carries no fee.",
];

(async () => {
  const { rows: orgs } = await pool.query("SELECT id, name FROM organizations WHERE slug = $1", [ORG_SLUG]);
  if (orgs.length !== 1) throw new Error(`Expected exactly one org with slug "${ORG_SLUG}", found ${orgs.length}`);
  const org = orgs[0];

  const { rows: existing } = await pool.query("SELECT id FROM usg_invoices WHERE token = $1", [TOKEN]);

  console.log(`\nOrg:      ${org.name} (id ${org.id})`);
  console.log(`Token:    ${TOKEN}`);
  console.log(`Number:   ${NUMBER}`);
  console.log(`Title:    Partnership rebate — The Drifter`);
  console.log(`Total:    $${(totalCents / 100).toFixed(2)}  (subtotal $${(subtotalCents / 100).toFixed(2)} + GST $${(gstCents / 100).toFixed(2)})`);
  console.log(`Status:   draft (isDraft=true, cardEnabled=false)`);
  console.log(existing.length ? `Existing: id ${existing[0].id} — will UPDATE` : "Existing: none — will INSERT");

  if (!COMMIT) {
    console.log("\n🔍 Dry run. Nothing written. Re-run with --commit to apply.\n");
    await pool.end();
    return;
  }

  const { rows } = await pool.query(
    `INSERT INTO usg_invoices
       (organization_id, token, number, status, brand,
        recipient_name, recipient_email, recipient_address,
        title, intro, spend_summary, lines, notes,
        gst_treatment, subtotal_cents, gst_cents, total_cents,
        issued_on, due_on, terms_label, card_enabled,
        is_draft, draft_reasons,
        bank_account_name, bank_account_number, bank_reference, bank_particulars, bank_code)
     VALUES
       ($1,$2,$3,$4,$5,
        $6,$7,$8::jsonb,
        $9,$10,$11::jsonb,$12::jsonb,$13::jsonb,
        $14,$15,$16,$17,
        $18,$19,$20,$21,
        $22,$23::jsonb,
        $24,$25,$26,$27,$28)
     ON CONFLICT (token) DO UPDATE SET
       organization_id     = EXCLUDED.organization_id,
       number              = EXCLUDED.number,
       brand               = EXCLUDED.brand,
       recipient_name      = EXCLUDED.recipient_name,
       recipient_email     = EXCLUDED.recipient_email,
       recipient_address   = EXCLUDED.recipient_address,
       title               = EXCLUDED.title,
       intro               = EXCLUDED.intro,
       spend_summary       = EXCLUDED.spend_summary,
       lines               = EXCLUDED.lines,
       notes               = EXCLUDED.notes,
       gst_treatment       = EXCLUDED.gst_treatment,
       subtotal_cents      = EXCLUDED.subtotal_cents,
       gst_cents           = EXCLUDED.gst_cents,
       total_cents         = EXCLUDED.total_cents,
       issued_on           = EXCLUDED.issued_on,
       due_on              = EXCLUDED.due_on,
       terms_label         = EXCLUDED.terms_label,
       card_enabled        = EXCLUDED.card_enabled,
       is_draft            = EXCLUDED.is_draft,
       draft_reasons       = EXCLUDED.draft_reasons,
       bank_account_name   = EXCLUDED.bank_account_name,
       bank_account_number = EXCLUDED.bank_account_number,
       bank_reference      = EXCLUDED.bank_reference,
       bank_particulars    = EXCLUDED.bank_particulars,
       bank_code           = EXCLUDED.bank_code,
       updated_at          = now()
     RETURNING id`,
    [
      org.id, TOKEN, NUMBER, "draft", "siu",
      "The Drifter", "nicky.m@thedrifter.com", JSON.stringify(RECIPIENT_ADDRESS),
      "Partnership rebate",
      "Covering South Island United's accommodation and hospitality spend with The Drifter, rebated at the agreed 5% of eligible spend.",
      JSON.stringify(SPEND_SUMMARY), JSON.stringify(LINES), JSON.stringify(NOTES),
      "inclusive", subtotalCents, gstCents, totalCents,
      "2026-07-10", "2026-07-17", "Payment due within 7 days of invoice date", false,
      false, JSON.stringify(DRAFT_REASONS), // is_draft
      "Christchurch United Football Club Incorporated", "01-0635-0374823-00", NUMBER, "The Drifter", "Rebate",
    ],
  );

  const invoiceId = rows[0].id;
  const isNew = existing.length === 0;
  if (isNew) {
    await pool.query(
      `INSERT INTO usg_invoice_events (invoice_id, kind, is_staff) VALUES ($1, 'created', true)`,
      [invoiceId],
    );
  }

  console.log(`\n✅ Seeded usg_invoices id ${invoiceId}.`);
  console.log(`   Tracked link: ${invoiceUrl(BRAND, TOKEN)}`);
  console.log("   It is a DRAFT — not sent, not payable by card. Review in ClubOS → United Sports Group → Invoices.");
  await pool.end();
})().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
