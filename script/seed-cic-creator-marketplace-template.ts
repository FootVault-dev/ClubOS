// Seed / update the CUFC Content Marketplace Creator Agreement native e-Sign template.
// Idempotent: upserts on (organization_id, slug). Re-run any time the wording
// changes — already-sent documents keep their own snapshot, so edits never
// rewrite history.
//
// WHY THIS DOCUMENT EXISTS
//   Max Comrie already has a signed Contractor Work Agreement with CUFC Inc
//   (DocuSign envelope B235C1BE-F29F-4CC0-A56D-8DE0A4C2A6C5, dated 12 Jan 2026).
//   Clause 10 of that agreement ALREADY assigns the Club exclusive ownership of
//   every photo and video he creates — so this document does not need to buy
//   copyright. Clause 5.3 of that agreement already provides for paid
//   "Additional Services" at tournaments and high-volume capture periods.
//
//   This template therefore sits ON TOP of the existing agreement. It is
//   supplemental by design: it prices one event and adds a revenue share, and
//   it deliberately does NOT restate, vary or replace his weekly fee, his
//   hours, or his engagement status. Do not add those terms here.
//
// LEGAL ENTITY vs WORKSPACE — these are deliberately different.
//   The contracting party is Christchurch United Football Club Incorporated.
//   "Christchurch International Cup" is a brand/event of that entity, not a
//   separate legal person, so it cannot be a party to a contract. The parties
//   block therefore names CUFC Inc — matching the Existing Agreement exactly,
//   which is what keeps the supplemental link airtight.
//   The TEMPLATE is seeded to the CIC workspace (org 5) so it lives in the CIC
//   e-Sign tab and sends from cicyouth.com, and it carries CIC branding.
//
// PAY IS NOT WIRED IN THIS FILE. The share % is a sender-set variable, chosen
// at send time. Nobody's pay is hard-coded in the repo.
//
// There is deliberately NO event fee: the revenue share is the creator's ONLY
// payment for this work (Daniel's call, 2026-07-10). Their weekly fee under the
// Existing Agreement continues untouched — that, not this, is their floor.
//
// CAUTION: a native document's signing PAGE renders from the CURRENT template
// row, while its hashed sourcePdf is a snapshot from send time. Re-seeding this
// file while a document is out for signature changes what the signer reads but
// not what was hashed. Void and re-send instead of editing mid-flight.
//
// Usage: npx tsx --env-file=.env script/seed-cic-creator-marketplace-template.ts

import { Pool } from "pg";

const ORG_SLUG = "christchurch-international-cup";
const SLUG = "content-marketplace-creator-agreement";

export const brand = {
  orgLabel: "Christchurch International Cup",
  logoUrl: "/logos/christchurch-international-cup.png",
  bg: "#141511",
  panel: "#1c1d18",
  border: "#2c2d26",
  accent: "#C9A43E",
  accentDeep: "#a8862c",
  paper: "#faf8f2",
  ink: "#141511",
};

export const variables = [
  {
    key: "event_name",
    label: "Event",
    type: "text",
    default: "the Christchurch International Cup, 5–16 July 2026",
    required: true,
  },
  {
    key: "share_pct",
    label: "Revenue share",
    type: "select",
    options: ["30%", "25%", "20%"],
    allowCustom: true,
    default: "30%",
    required: true,
  },
];

export const form = [
  { key: "creator_name", label: "Full legal name", type: "text", required: true, placeholder: "As shown on your ID" },
  { key: "dob", label: "Date of birth", type: "dob", required: true, help: "Under 18? A parent or guardian co-signs — the form handles it automatically." },
  { key: "phone", label: "Mobile number", type: "phone", required: true },
  { key: "address", label: "Home address", type: "address", required: true },
  { key: "bank_account", label: "Bank account for payment", type: "bank", required: true, help: "e.g. 06-0793-0309744-01" },
  { key: "ird_number", label: "IRD number", type: "text", required: true, help: "You pay your own tax on this income." },
];

export const settings = {
  // The Club signs first. Max opens a document we have already signed, and his
  // signature completes it. Standing rule — see memory feedback_esign_signing_order.
  clubSignsFirst: true,
  guardianUnder18: true,
  detailsHeading: "Your details",
  counterSignerRole: "The Club",
  primarySignerRole: "The Creator",
  adviceNotice:
    "There's no rush. You're welcome to take this away, think about it, or get independent advice before you sign — this page will still be here when you're ready.",
};

export const content = {
  docTitle: "Content Marketplace Creator Agreement",
  partiesIntro: [
    "This Agreement is made between:",
    "Christchurch United Football Club Incorporated, which operates the Christchurch International Cup (“the Club”)",
    "and",
    "{{creator_name}} (“the Creator”).",
    "It is supplemental to the Contractor Work Agreement between the Parties dated 12 January 2026 (“the Existing Agreement”).",
  ],
  sections: [
    {
      heading: "1. Purpose",
      items: [
        { kind: "p", text: "The Club is launching a Content Marketplace, beginning at the Christchurch International Cup, where families can buy photographs and video of their own child taken at Club events. This Agreement sets out how the Creator is paid for capturing, editing, organising and delivering that content, and how the Creator shares in the revenue it earns." },
        { kind: "p", text: "This is Additional Services work under clause 5.3 of the Existing Agreement. It is offered to the Creator, not required of them." },
      ],
    },
    {
      heading: "2. Relationship to the Existing Agreement",
      items: [
        { kind: "bullet", text: "The Existing Agreement continues in full force and is unchanged." },
        { kind: "bullet", text: "This Agreement does not vary the Creator’s fees, hours, working arrangements or engagement status under the Existing Agreement, and nothing in it should be read as doing so." },
        { kind: "bullet", text: "If the two documents conflict, the Existing Agreement prevails — except on the subject of Marketplace revenue share, which is governed only by this Agreement." },
        { kind: "bullet", text: "Nothing in this Agreement creates any entitlement to Additional Services work in future." },
      ],
    },
    {
      heading: "3. Covered Content",
      items: [
        { kind: "bullet", text: "“Covered Content” means photographs and video captured by the Creator at {{event_name}} and delivered to the Club’s content system." },
        { kind: "bullet", text: "For the avoidance of doubt, Covered Content includes content captured before the date this Agreement is signed." },
        { kind: "bullet", text: "The Club may extend this Agreement to further events by written notice. Each extension is optional for the Creator to accept, and takes effect only once accepted in writing." },
      ],
    },
    {
      heading: "4. Payment for this work",
      items: [
        { kind: "bullet", text: "The Creator’s only payment under this Agreement is the Revenue Share in clause 5. No separate fee is payable." },
        { kind: "bullet", text: "The Revenue Share covers all of the Creator’s work on Covered Content — shooting, editing, categorising, organising by team, uploading and delivering it." },
        { kind: "bullet", text: "This is the separate payment contemplated by clause 5.3 of the Existing Agreement for Additional Services." },
        { kind: "bullet", text: "The Creator’s weekly fee and non-cash benefits under the Existing Agreement continue unchanged, and are not affected, reduced or replaced by this Agreement." },
        { kind: "bullet", text: "The Creator understands that if no Covered Content sells, no Revenue Share is payable. The Club gives no guarantee of sales (see clause 7)." },
        { kind: "bullet", text: "All amounts are inclusive of GST (if any). The Creator is responsible for their own tax obligations, including IRD and any ACC levies." },
      ],
    },
    {
      heading: "5. Revenue Share",
      items: [
        { kind: "bullet", text: "The Club will pay the Creator {{share_pct}} of the Net Revenue from every Marketplace sale of Covered Content that the Creator captured." },
        { kind: "bullet", text: "“Net Revenue” means the amount the Club actually receives for a sale, less the payment-processing fees charged by the Club’s payment provider on that sale, and less GST. It does not include any other deduction." },
        { kind: "bullet", text: "A sale is attributed to the Creator where the Covered Content sold was delivered to the Club’s content system under the Creator’s own account." },
        { kind: "bullet", text: "Where a single purchase contains content captured by more than one creator, the Net Revenue for that purchase is apportioned between them in proportion to the number of items each supplied." },
        { kind: "bullet", text: "No Revenue Share is payable on a sale that is refunded, reversed or charged back. Where it has already been paid, the Club may set it off against the next statement." },
        { kind: "bullet", text: "The Revenue Share is not reduced by any fee, cost or deduction other than those stated in the definition of Net Revenue above." },
        { kind: "bullet", text: "Bespoke content commissioned by a customer (for example, a highlight edit ordered for one player) is not offered in this phase. If the Club introduces it, the Parties will agree the Creator’s fee for that work in writing before it goes on sale." },
      ],
    },
    {
      heading: "6. Statements and payment",
      items: [
        { kind: "bullet", text: "Within 20 working days of the end of each calendar month, the Club will give the Creator a statement showing the items sold, gross sales, the deductions taken, and the resulting Net Revenue and Revenue Share." },
        { kind: "bullet", text: "The Club will pay the Revenue Share to the Creator’s nominated bank account within 10 working days of that statement." },
        { kind: "bullet", text: "The Creator may ask to see the underlying sales records supporting a statement, once per quarter, on reasonable notice." },
        { kind: "bullet", text: "If the Club and the Creator disagree about a statement, they will try in good faith to resolve it before either takes any other step." },
      ],
    },
    {
      heading: "7. What the Club decides",
      items: [
        { kind: "bullet", text: "The Club decides which content is published for sale, at what price, and for how long." },
        { kind: "bullet", text: "The Club may decline to publish, or may remove or delist, any content at any time and for any reason — including at the request of a parent or guardian." },
        { kind: "bullet", text: "The Club is under no obligation to sell any content, and gives no guarantee, forecast or promise of any level of sales or revenue." },
      ],
    },
    {
      heading: "8. Children, consent and safeguarding",
      items: [
        { kind: "p", text: "This content is of children. The following are conditions of this Agreement, not guidance." },
        { kind: "bullet", text: "No Covered Content will be offered for sale unless the Club holds a current, recorded consent from that child’s parent or guardian permitting their child’s images to be offered for sale to their family." },
        { kind: "bullet", text: "Where that consent has not been given, or is withdrawn, the content is not published and no Revenue Share arises on it." },
        { kind: "bullet", text: "The Creator must comply at all times with the Club’s child-protection, privacy and media-accreditation requirements, and with the Privacy Act 2020." },
        { kind: "bullet", text: "The Creator must not publish, post, share, sell or supply Covered Content to anyone other than the Club, and must not keep it outside the Club’s systems once it has been delivered — except as clause 10 allows." },
        { kind: "bullet", text: "The Creator must report any safeguarding or privacy concern to the Club immediately." },
        { kind: "bullet", text: "A breach of this clause is a serious breach of this Agreement and of the Existing Agreement." },
      ],
    },
    {
      heading: "9. Ownership of the content",
      items: [
        { kind: "bullet", text: "Clause 10 of the Existing Agreement continues to apply: all content the Creator creates in the course of providing services, including all Covered Content, is the exclusive property of the Club." },
        { kind: "bullet", text: "The Revenue Share is payment for services. It gives the Creator no ownership interest, no licence, and no continuing right in the Covered Content or in the Marketplace itself." },
        { kind: "bullet", text: "To the extent that any right in Covered Content would otherwise belong to the Creator, the Creator assigns it to the Club absolutely, both now and in the future, including all copyright." },
        { kind: "bullet", text: "The Creator waives their moral rights in the Covered Content so far as those rights may be waived under the Copyright Act 1994. The Club will credit the Creator as the author wherever it is reasonably practicable to do so." },
      ],
    },
    {
      heading: "10. Portfolio use",
      items: [
        { kind: "bullet", text: "The Club grants the Creator a personal, non-exclusive, royalty-free licence to show Covered Content in their own professional portfolio and on their personal social media, to showcase their own work." },
        { kind: "bullet", text: "That licence does not permit the Creator to sell, licence, or otherwise commercially exploit the content." },
        { kind: "bullet", text: "It does not extend to any content the Club has withdrawn, or any content where a parent or guardian has withdrawn consent. The Creator must take such content down promptly on request." },
      ],
    },
    {
      heading: "11. Term and termination",
      items: [
        { kind: "bullet", text: "This Agreement begins on the date of the last signature below and applies to Covered Content as defined in clause 3." },
        { kind: "bullet", text: "Either Party may end this Agreement by giving 14 days’ written notice." },
        { kind: "bullet", text: "The Club may end it immediately for a breach of clause 8." },
        { kind: "bullet", text: "Ending this Agreement does not end the Existing Agreement." },
        { kind: "bullet", text: "The Revenue Share continues to be payable on sales of Covered Content made while that content remains published, including after this Agreement ends. Clauses 8, 9, 10 and 12 survive termination." },
      ],
    },
    {
      heading: "12. Confidentiality",
      items: [
        { kind: "p", text: "The Creator agrees to keep confidential all non-public information about the Club, including sales figures, customer details, commercial arrangements and the terms of this Agreement. This obligation continues after this Agreement ends." },
      ],
    },
    {
      heading: "13. General",
      items: [
        { kind: "bullet", text: "Nothing in this Agreement changes the Creator’s engagement status under the Existing Agreement." },
        { kind: "bullet", text: "This Agreement may only be varied in writing, signed by both Parties." },
        { kind: "bullet", text: "This Agreement is governed by the laws of New Zealand." },
      ],
    },
    {
      heading: "14. Independent advice",
      items: [
        { kind: "p", text: "The Creator confirms they have had a reasonable opportunity to seek independent advice about this Agreement before signing, and that they enter into it freely." },
      ],
    },
  ],
  signAck:
    "By signing, each Party acknowledges they have read and understood this Agreement, including the Delivery Standards in Appendix A, and agree to it. The Creator’s existing Contractor Work Agreement is unchanged. If the Creator is under 18, a parent or legal guardian co-signs to confirm their consent.",
  appendix: {
    title: "Appendix A — Delivery Standards",
    intro: "So that content can be published quickly while families are still at the tournament, the Creator agrees to the following standards for Covered Content:",
    sections: [
      {
        heading: "Capture",
        items: [
          { kind: "bullet", text: "Shoot in the highest quality the camera allows; do not deliver cropped, filtered or heavily stylised images for gallery sale." },
          { kind: "bullet", text: "Aim to photograph every team scheduled for the day, not only the strongest teams or the most photogenic moments." },
          { kind: "bullet", text: "Frame so that a child’s shirt number is visible where possible — galleries are organised by team and number, never by a child’s name." },
          { kind: "bullet", text: "Wear the accreditation provided and remain identifiable as Club media at all times." },
        ],
      },
      {
        heading: "Delivery",
        items: [
          { kind: "bullet", text: "Upload each day’s content to the Club’s content system by the end of the following day." },
          { kind: "bullet", text: "Upload under your own account, so that sales can be attributed to you." },
          { kind: "bullet", text: "Tag each gallery with the correct team and match." },
          { kind: "bullet", text: "Do not upload images of a child who is visibly distressed, injured, or in a state of undress." },
        ],
      },
      {
        heading: "After delivery",
        items: [
          { kind: "bullet", text: "Delete local and personal-device copies of Covered Content once delivery is confirmed, other than any images used under the portfolio licence in clause 10." },
          { kind: "bullet", text: "Never share raw files with any third party, including other creators, without the Club’s written approval." },
        ],
      },
    ],
  },
};

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const org = await client.query(`SELECT id, name FROM organizations WHERE slug = $1`, [ORG_SLUG]);
    if (!org.rows.length) throw new Error(`Organization '${ORG_SLUG}' not found`);
    const orgId = org.rows[0].id;

    const res = await client.query(
      `INSERT INTO esign_templates (organization_id, slug, name, description, brand, content, variables, form, settings, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
       ON CONFLICT (organization_id, slug) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description, brand = EXCLUDED.brand,
         content = EXCLUDED.content, variables = EXCLUDED.variables, form = EXCLUDED.form,
         settings = EXCLUDED.settings, active = true
       RETURNING id`,
      [
        orgId,
        SLUG,
        "Content Marketplace Creator Agreement",
        "Revenue-share agreement for content creators whose photos and video are sold to families through the Club's Content Marketplace. Supplemental to an existing contractor agreement — does not vary base pay or status. The revenue share is the creator's only payment for this work; the % is set per creator at send time.",
        JSON.stringify(brand),
        JSON.stringify(content),
        JSON.stringify(variables),
        JSON.stringify(form),
        JSON.stringify(settings),
      ],
    );
    console.log(`✅ Template '${SLUG}' upserted (id ${res.rows[0].id}) for ${org.rows[0].name} (org ${orgId})`);
  } finally {
    client.release();
    await pool.end();
  }
}

// Only run when invoked directly (the proof renderer imports the content).
if (process.argv[1]?.includes("seed-cic-creator-marketplace-template")) {
  main().catch((err) => { console.error("❌ Seed failed:", err); process.exit(1); });
}
