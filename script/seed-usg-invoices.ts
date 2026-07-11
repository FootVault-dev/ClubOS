/**
 * Seed USG Invoices — CUFC-2026-002 (The Drifter partnership rebate) and
 * TEST-CARD-001 (a $1 card-path test artefact).
 *
 * Values are copied VERBATIM from apps/invoices/src/data/{drifter,cardTest}.ts
 * — the public payable page's own local seed records (used as its graceful
 * fallback before a ClubOS row exists for a given token). If the two ever
 * disagree, those files are wrong; this script is the one writing to the
 * system of record.
 *
 * 🔴 DELETE THE TEST-CARD-001 ROW once card payments are signed off. A live
 * $1 test artefact left lying around is exactly the mistake the
 * CUGC-TEST-2741 discount code was — see apps/invoices/src/data/cardTest.ts.
 *
 * Both invoices are seeded from the INVOICES array below — add a new invoice
 * by adding another entry, not by copy-pasting the insert logic.
 *
 * Idempotent: upserts on the unique `token` per row. Re-running never
 * duplicates a row and never touches usg_invoice_events beyond one 'created'
 * row per invoice, on that invoice's first insert.
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

// GST-inclusive breakdown — mirrors shared/invoice-money.ts
// (gstContentOfInclusive / exclusiveOfInclusive) so this script has no
// dependency on the app's path aliases. 15% inclusive => amount * 3/23.
function gstBreakdown(totalCents: number) {
  const gstCents = Math.round((totalCents * 3) / 23);
  const subtotalCents = totalCents - gstCents;
  return { subtotalCents, gstCents, totalCents };
}

interface SeedSpendSummary {
  label: string;
  totalLabel: string;
  rows: { label: string; amountCents: number }[];
}

interface SeedLine {
  description: string;
  detail?: string;
  amountCents: number;
}

interface SeedInvoice {
  token: string;
  number: string;
  brand: "siu" | "cufc";
  status: "draft" | "sent" | "paid" | "void";
  isDraft: boolean;
  draftReasons: string[];
  cardEnabled: boolean;
  recipientName: string;
  recipientEmail: string | null;
  recipientAddress: string[];
  title: string;
  intro: string | null;
  spendSummary: SeedSpendSummary | null;
  lines: SeedLine[];
  notes: string[] | null;
  gstTreatment: "inclusive" | "exclusive";
  totals: { subtotalCents: number; gstCents: number; totalCents: number };
  issuedOn: string;
  dueOn: string;
  termsLabel: string;
  bankAccountName: string;
  bankAccountNumber: string;
  bankReference: string;
  bankParticulars: string | null;
  bankCode: string | null;
}

// ── CUFC-2026-002 — The Drifter partnership rebate ──────────────────────────
// Figures verbatim from apps/invoices/src/data/drifter.ts.
//   12,844.15 + 4,972.32 = 17,816.47   and   17,816.47 × 5% = 890.82
// Nothing here is inferred — every figure traces to The Drifter's own
// eligible-spend summary (relayed by Ryan Edwards, 2026-07-10).
const accommodationCents = 1_284_415; // "12,844.15"
const foodBeverageCents = 497_232; // "4,972.32"
const eligibleSpendCents = accommodationCents + foodBeverageCents; // 1,781,647
const rebateCents = Math.round(eligibleSpendCents * 0.05); // 89,082

const drifter: SeedInvoice = {
  token: "dr-9f4c2a7e6b1d84035ec7",
  number: "CUFC-2026-002",
  brand: "siu",
  status: "draft",
  // Daniel cleared the draft banner on 2026-07-10. The two open questions did
  // not go away, they moved: whether this is a taxable supply from us at all
  // (vs a rebate The Drifter credit-notes), and GST-inclusive vs plus-GST.
  // Both recorded in outputs/invoices/2026-07-10-drifter-rebate/00-READ-FIRST.md
  // — Victor's call before this is sent.
  isDraft: false,
  draftReasons: [],
  // Card is on. Bank transfer stays free and pre-selected; a payer who wants
  // the convenience of a card carries its cost, so the club banks the
  // invoice total either way. See server/invoice-routes.ts pay-intent route.
  cardEnabled: true,
  recipientName: "The Drifter",
  recipientEmail: "nicky.m@thedrifter.com",
  // Confirmed by Daniel 2026-07-10, independently matched by three listings
  // carrying schema.org streetAddress data (thedrifter.com itself 403s every
  // automated client, so the site could not be used as the primary source).
  recipientAddress: [
    "96 Lichfield Street",
    "Christchurch Central City",
    "Christchurch 8011",
    "New Zealand",
  ],
  title: "Partnership rebate",
  intro:
    "Covering South Island United's accommodation and hospitality spend with The Drifter, rebated at the agreed 5% of eligible spend.",
  spendSummary: {
    label: "Eligible spend",
    rows: [
      { label: "Direct accommodation bookings", amountCents: accommodationCents },
      { label: "Rambler food & beverage spend", amountCents: foodBeverageCents },
    ],
    totalLabel: "Total eligible spend",
  },
  lines: [
    { description: "Partnership rebate", detail: "5% of total eligible spend", amountCents: rebateCents },
  ],
  notes: [
    "This rebate relates to eligible spend to 10 July 2026.",
    "Bank transfer is the fastest way to settle and carries no fee.",
  ],
  gstTreatment: "inclusive",
  totals: gstBreakdown(rebateCents), // subtotal 77,463 / gst 11,619 / total 89,082
  issuedOn: "2026-07-10",
  dueOn: "2026-07-17",
  termsLabel: "Payment due within 7 days of invoice date",
  bankAccountName: "Christchurch United Football Club Incorporated",
  bankAccountNumber: "01-0635-0374823-00",
  bankReference: "CUFC-2026-002",
  bankParticulars: "The Drifter",
  bankCode: "Rebate",
};

// ── TEST-CARD-001 — card path verification ──────────────────────────────────
// Figures verbatim from apps/invoices/src/data/cardTest.ts. A $1.00 invoice
// that exists ONLY to prove the card path end-to-end with a real card on the
// club's live Stripe account.
//
// 🔴 DELETE THIS RECORD once the card path is signed off. A live $1 test
// artefact left lying around is exactly the mistake the CUGC-TEST-2741
// discount code was.
const testTotalCents = 100; // "One dollar"

const cardTest: SeedInvoice = {
  token: "test-card-4e1b7a92c0d63f85",
  number: "TEST-CARD-001",
  brand: "siu",
  status: "draft",
  isDraft: true,
  draftReasons: [
    "Internal test invoice. It exists only to verify the card payment path on the club's live Stripe account. Not for issue to anyone. Delete once card payments are signed off.",
  ],
  cardEnabled: true,
  recipientName: "Card path test",
  recipientEmail: null,
  recipientAddress: ["Internal — do not send"],
  title: "Card payment test",
  intro:
    "A $1.00 charge used to verify that card payments work end to end, and that the processing fee is carried by the payer rather than the club.",
  spendSummary: null,
  lines: [{ description: "Card path verification", detail: "One dollar", amountCents: testTotalCents }],
  notes: null,
  gstTreatment: "inclusive",
  totals: gstBreakdown(testTotalCents), // subtotal 87 / gst 13 / total 100
  issuedOn: "2026-07-10",
  dueOn: "2026-07-17",
  termsLabel: "Internal test — not a real invoice",
  bankAccountName: "Christchurch United Football Club Incorporated",
  bankAccountNumber: "01-0635-0374823-00",
  bankReference: "TEST-CARD-001",
  bankParticulars: "Card test",
  bankCode: null,
};

const INVOICES: SeedInvoice[] = [drifter, cardTest];

(async () => {
  const { rows: orgs } = await pool.query("SELECT id, name FROM organizations WHERE slug = $1", [ORG_SLUG]);
  if (orgs.length !== 1) throw new Error(`Expected exactly one org with slug "${ORG_SLUG}", found ${orgs.length}`);
  const org = orgs[0];

  console.log(`\nOrg: ${org.name} (id ${org.id})`);

  for (const inv of INVOICES) {
    const { rows: existing } = await pool.query("SELECT id FROM usg_invoices WHERE token = $1", [inv.token]);

    console.log(`\n── ${inv.number} ─────────────────────────────────────────`);
    console.log(`Token:    ${inv.token}`);
    console.log(`Title:    ${inv.title}`);
    console.log(
      `Total:    $${(inv.totals.totalCents / 100).toFixed(2)}  (subtotal $${(inv.totals.subtotalCents / 100).toFixed(2)} + GST $${(inv.totals.gstCents / 100).toFixed(2)})`,
    );
    console.log(`Status:   ${inv.status} (isDraft=${inv.isDraft}, cardEnabled=${inv.cardEnabled})`);
    console.log(existing.length ? `Existing: id ${existing[0].id} — will UPDATE` : "Existing: none — will INSERT");

    if (!COMMIT) continue;

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
        org.id, inv.token, inv.number, inv.status, inv.brand,
        inv.recipientName, inv.recipientEmail, JSON.stringify(inv.recipientAddress),
        inv.title, inv.intro,
        inv.spendSummary ? JSON.stringify(inv.spendSummary) : null,
        JSON.stringify(inv.lines),
        inv.notes ? JSON.stringify(inv.notes) : null,
        inv.gstTreatment, inv.totals.subtotalCents, inv.totals.gstCents, inv.totals.totalCents,
        inv.issuedOn, inv.dueOn, inv.termsLabel, inv.cardEnabled,
        inv.isDraft, JSON.stringify(inv.draftReasons),
        inv.bankAccountName, inv.bankAccountNumber, inv.bankReference, inv.bankParticulars, inv.bankCode,
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

    console.log(`✅ Seeded usg_invoices id ${invoiceId}.`);
    console.log(`   Tracked link: ${invoiceUrl(inv.brand, inv.token)}`);
  }

  if (!COMMIT) {
    console.log("\n🔍 Dry run. Nothing written. Re-run with --commit to apply.\n");
  } else {
    console.log("\nBoth rows are DRAFT — review in ClubOS → United Sports Group → Invoices.");
    console.log("🔴 Remember to delete TEST-CARD-001 once card payments are signed off.\n");
  }

  await pool.end();
})().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
