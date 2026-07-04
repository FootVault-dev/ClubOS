// Seed / update the CIC Food & Beverage Vendor Agreement native e-Sign template.
// Idempotent: upserts on (organization_id, slug). Re-run any time the wording
// changes — already-sent documents keep their own snapshot (sourcePdf + hash),
// so edits here never rewrite history.
//
// Content = the reviewed CIC food-vendor "Licence to Occupy — Event" (clauses
// 1–20 + schedule), ported from outputs/cic-food-vendor-agreement/build_agreement.py
// (which mirrors the lawyer-touched Birria Boss licence) into the text-only
// native renderer. Commercial terms for 2026: 15% of Gross Revenue, $20+GST
// power/day, $5+GST waste/day, trading window a sender-set variable.
//
// Usage (from apps/clubos):  npx tsx --env-file=.env script/seed-cic-food-vendor-template.ts

import { Pool } from "pg";

const ORG_SLUG = "christchurch-international-cup";
const SLUG = "cic-food-vendor-agreement";

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
  { key: "trading_period", label: "Trading period (Event dates)", type: "text", default: "5–16 July 2026", required: true },
];

export const form = [
  { key: "signatory_name", label: "Full name of the person signing", type: "text", required: true, placeholder: "e.g. Jane Smith" },
  { key: "signatory_role", label: "Your role", type: "text", required: true, placeholder: "e.g. Owner / Director" },
  { key: "business_legal_name", label: "Full legal / company name", type: "text", required: true, placeholder: "As registered" },
  { key: "trading_name", label: "Trading name (what customers see)", type: "text", required: true },
  { key: "nzbn", label: "NZBN (13-digit) — if you have one", type: "text", required: false },
  { key: "gst_number", label: "GST registered? Yes / No + GST number", type: "text", required: true },
  { key: "phone", label: "Best contact phone", type: "phone", required: true },
  { key: "food_category", label: "What you'll be selling (e.g. burgers / Thai / coffee)", type: "text", required: true },
  { key: "set_up", label: "Your set-up time each day", type: "text", required: true, placeholder: "e.g. 7:00am" },
  { key: "pack_up", label: "Your pack-up time on your last day", type: "text", required: true, placeholder: "e.g. 6:00pm" },
  { key: "food_reg", label: "Food Control Plan / National Programme registration number", type: "text", required: true, help: "Required under the Food Act 2014." },
  { key: "gas_cert", label: "Gas cert / EWOF number + expiry (if you use gas)", type: "text", required: false },
  { key: "council_permit", label: "Council trading permit number (if you have one)", type: "text", required: false },
];

export const settings = {
  guardianUnder18: false,
  counterSignerRole: "The Club",
  primarySignerRole: "The Vendor",
  detailsHeading: "Vendor Details",
  adviceNotice:
    "Take your time reviewing this agreement. You're welcome to seek independent advice before signing — this page will still be here when you're ready.",
};

export const content = {
  docTitle: "Food & Beverage Vendor Agreement",
  partiesIntro: [
    "This Agreement is a Licence to Occupy for the Christchurch International Cup 2026. It is made between:",
    "Christchurch United Football Club Incorporated, operator of the Christchurch International Cup (“the Club”), of 466 Yaldhurst Road, Christchurch 7676;",
    "and",
    "{{business_legal_name}}, trading as {{trading_name}} (“the Vendor”).",
  ],
  sections: [
    {
      heading: "The Deal at a Glance",
      items: [
        { kind: "bullet", text: "Event: Christchurch International Cup 2026 — the July youth tournament at the United Sports Centre, 466 Yaldhurst Road, Christchurch." },
        { kind: "bullet", text: "Trading period: {{trading_period}} — the tournament window. You trade the days you're rostered within it, so a shift change never needs a new contract." },
        { kind: "bullet", text: "Commission (Event Fee): 15% of your Gross Revenue over the trading period, plus GST (clause 4)." },
        { kind: "bullet", text: "Power contribution: $20 + GST per trading day (clause 5)." },
        { kind: "bullet", text: "Waste-management contribution: $5 + GST per trading day (clause 6)." },
        { kind: "bullet", text: "Payment: commission due within 5 business days of the Event ending, against your sales report (clause 4)." },
        { kind: "bullet", text: "Insurance: current public liability and product liability cover of at least $2,000,000 each, certificates given to the Club before you trade (clause 13)." },
        { kind: "bullet", text: "This is a non-exclusive licence to occupy — not a lease. The Club may bring in other vendors (clause 2)." },
      ],
    },
    {
      heading: "1. Definitions",
      items: [
        { kind: "p", text: "In this Agreement, unless the context otherwise requires:" },
        { kind: "p", text: "“Agreement” means this agreement, including the deal terms above and any annexures." },
        { kind: "p", text: "“Club” / “Licensor” means Christchurch United Football Club Incorporated, operator of the Christchurch International Cup." },
        { kind: "p", text: "“Designated Bay” means the area within the Premises allocated to the Vendor for its Food Truck and trading, as marked out and allocated by the Club on site." },
        { kind: "p", text: "“Event” means the Christchurch International Cup 2026 tournament held at the Premises, including any associated tournament days, finals, and ancillary activities designated by the Club." },
        { kind: "p", text: "“Food Control Plan” means a food safety programme (Food Control Plan or National Programme) registered under the Food Act 2014." },
        { kind: "p", text: "“Food Truck” means the Vendor's mobile food vehicle, trailer, cart, or stall used to prepare and sell the Permitted Goods." },
        { kind: "p", text: "“Gross Revenue” means the total of all sales and takings (cash, EFTPOS, card, voucher, app, and any other tender) received by the Vendor from trading at the Event during the trading period, before deduction of any costs, but excluding GST." },
        { kind: "p", text: "“GST” means goods and services tax under the Goods and Services Tax Act 1985." },
        { kind: "p", text: "“Permitted Goods” means the food and beverage items in the category specified by the Vendor in its details." },
        { kind: "p", text: "“Premises” means the United Sports Centre at 466 Yaldhurst Road, Christchurch 7676, and any grounds used for the Event." },
        { kind: "p", text: "“Trading Hours” means the operating hours set by the Club, aligned to the match schedule (clause 8)." },
        { kind: "p", text: "“Trading period” means the Event dates set out above during which the Vendor is licensed to trade." },
      ],
    },
    {
      heading: "2. Grant of Licence",
      items: [
        { kind: "p", text: "2.1  The Club grants the Vendor a non-exclusive right to occupy the Designated Bay for the sole purpose of operating the Food Truck and selling the Permitted Goods at the Event, on the terms of this Agreement." },
        { kind: "p", text: "2.2  This Agreement is a licence only. It does not create a lease, tenancy, or any estate or interest in the Premises, and does not grant exclusive possession of the Premises or the Designated Bay. The Club may access, use, and pass through the Designated Bay at any time." },
        { kind: "p", text: "2.3  The licence is personal to the Vendor. The Vendor may not assign, transfer, sublicense, or share its rights under this Agreement without the prior written consent of the Club." },
        { kind: "p", text: "2.4  The Club may permit any number of other food, beverage, or other operators to trade at the Premises and at the Event at any time, without restriction and without compensation to the Vendor. The Vendor acknowledges it has no exclusivity of any kind." },
      ],
    },
    {
      heading: "3. Term",
      items: [
        { kind: "p", text: "3.1  This Agreement applies for the trading period specified above, together with the set-up and pack-up times the Vendor provides in its details." },
        { kind: "p", text: "3.2  The Vendor must not occupy the Designated Bay before its set-up time or remain after its pack-up time without the Club's prior written approval. There is no right to hold over." },
        { kind: "p", text: "3.3  This Agreement does not create any expectation, option, or right of renewal for any future Event. Participation in any future Event is at the Club's sole discretion and on terms to be agreed." },
      ],
    },
    {
      heading: "4. Fees — Commission, Reporting & Audit",
      items: [
        { kind: "p", text: "4.1  In consideration of the licence, the Vendor must pay the Club a commission (the Event Fee) equal to 15% of Gross Revenue generated by the Vendor at the Event over the trading period, plus GST." },
        { kind: "p", text: "4.2  The power contribution (clause 5) and waste-management contribution (clause 6) are payable in addition to the commission." },
        { kind: "p", text: "4.3  The Vendor must:" },
        { kind: "bullet", text: "maintain accurate, complete daily sales records for every day of the Event, reconciling all tender types;" },
        { kind: "bullet", text: "provide the Club with a written, itemised sales report within 48 hours of the Event ending; and" },
        { kind: "bullet", text: "pay the commission, and any other amounts then owing, within 5 business days of the Event ending." },
        { kind: "p", text: "4.4  The Club may, on reasonable notice, audit or inspect the Vendor's sales records, point-of-sale system, and banking for the trading period. If an audit reveals an understatement of Gross Revenue of more than 5%, the Vendor must pay the shortfall plus the Club's reasonable cost of the audit." },
        { kind: "p", text: "4.5  If any amount payable under this Agreement is unpaid for more than 7 days after its due date, interest accrues on the overdue amount at 12% per annum, calculated daily, until paid." },
        { kind: "p", text: "4.6  All amounts are exclusive of GST unless stated otherwise. The Club will issue a GST tax invoice for amounts payable to it." },
      ],
    },
    {
      heading: "5. Power & Electrical Safety",
      items: [
        { kind: "p", text: "5.1  The Club will provide access to a power connection point reasonably near the Designated Bay. The Vendor must pay the power contribution of $20 + GST for each of its trading days at the Event." },
        { kind: "p", text: "5.2  The Vendor must supply its own RCD-protected leads and equipment, all of which must be current “tested and tagged” to AS/NZS 3760, and must not exceed the electrical capacity made available by the Club." },
        { kind: "p", text: "5.3  All electrical equipment must comply with New Zealand electrical safety regulations and be certified where required." },
        { kind: "p", text: "5.4  The Vendor must not use a generator at the Premises without the Club's prior written consent." },
      ],
    },
    {
      heading: "6. Waste Management",
      items: [
        { kind: "p", text: "6.1  The Vendor must pay the waste-management contribution of $5 + GST for each of its trading days at the Event." },
        { kind: "p", text: "6.2  The Vendor must:" },
        { kind: "bullet", text: "manage and remove all of its own waste responsibly, and leave the Designated Bay clean at the end of each trading day;" },
        { kind: "bullet", text: "not dispose of oils, fats, or food waste into any drain, gully, or stormwater system;" },
        { kind: "bullet", text: "dispose of wastewater (including grey water) lawfully and off-site;" },
        { kind: "bullet", text: "use a drip tray / ground protection under any cooking or fryer equipment; and" },
        { kind: "bullet", text: "remove all of its waste from the Premises at the end of the Event." },
        { kind: "p", text: "6.3  The Club may recover from the Vendor any additional cleaning or waste-disposal costs caused by the Vendor, including any costs of remediating spills or staining." },
      ],
    },
    {
      heading: "7. Permitted Use & Club Partners",
      items: [
        { kind: "p", text: "7.1  The Vendor must use the Designated Bay solely to sell the Permitted Goods it has specified, and must not sell any other goods or services without the Club's prior written consent." },
        { kind: "p", text: "7.2  The Event is a sponsored tournament. The Vendor must not sell, sample, brand, or promote any product that conflicts with an official sponsor, partner, or exclusive supplier of the Club or the Event where the Club has notified the Vendor in writing of that exclusivity (for example, a designated beverage or energy-drink partner)." },
        { kind: "p", text: "7.3  The Vendor must not sell alcohol unless it holds all licences and consents required under the Sale and Supply of Alcohol Act 2012 and has the Club's prior written consent." },
        { kind: "p", text: "7.4  The Vendor must not display advertising, signage, or branding beyond the Designated Bay, and must not conduct roaming sales, sampling, or promotion around the Premises without consent." },
      ],
    },
    {
      heading: "8. Trading Hours & Obligations",
      items: [
        { kind: "p", text: "8.1  The Vendor must be set up, stocked, and ready to trade at the start of Trading Hours on each day it is rostered, and must trade continuously throughout Trading Hours on every such day." },
        { kind: "p", text: "8.2  The Vendor must not close early, pack down, or cease trading before the end of Trading Hours on any day without the Club's prior approval, except where required for genuine health-and-safety reasons." },
        { kind: "p", text: "8.3  The Vendor must operate with sufficient stock and trained staff to serve expected demand, and must keep service queues and customer flow clear of pitches, walkways, and emergency access routes." },
        { kind: "p", text: "8.4  The Club may direct the Vendor to vary or cease trading temporarily for safety, operational, broadcast, ceremony, or weather reasons; no fee reduction or compensation is payable for such directions." },
      ],
    },
    {
      heading: "9. Site, Bay Allocation & Relocation",
      items: [
        { kind: "p", text: "9.1  The Club allocates the Designated Bay and may, acting reasonably, relocate the Vendor to an alternative bay of broadly comparable position before or during the Event for operational, safety, or layout reasons." },
        { kind: "p", text: "9.2  The Vendor must keep the Food Truck and all equipment, cabling, and signage within the Designated Bay and must not expand, encroach, or store items outside it." },
        { kind: "p", text: "9.3  The Vendor must position and secure the Food Truck safely, including wheel chocks, stabilisers, and tidy, matted, or covered leads, to avoid trip and vehicle hazards." },
      ],
    },
    {
      heading: "10. Presentation & Standards",
      items: [
        { kind: "p", text: "10.1  The Vendor must maintain a clean, tidy, safe, and professional presentation at all times, consistent with a family-focused youth tournament." },
        { kind: "p", text: "10.2  All food and beverages must be of good quality and fit for sale, and the Vendor must serve customers courteously." },
        { kind: "p", text: "10.3  The Vendor must comply with all reasonable directions of the Club regarding presentation, pricing display, conduct, noise, and amplified sound." },
        { kind: "p", text: "10.4  The Vendor's staff must behave appropriately around children and families at all times; the Club may require the immediate removal of any person from the Premises for unsafe or inappropriate conduct." },
      ],
    },
    {
      heading: "11. Compliance with Laws & Permits",
      items: [
        { kind: "p", text: "11.1  The Vendor must, at its own cost, comply with all laws applicable to its operations, including (without limitation): the Food Act 2014 and the Food Regulations; the Health and Safety at Work Act 2015; the Resource Management Act 1991; electricity, gas, and fire-safety regulations; the Sale and Supply of Alcohol Act 2012 (if applicable); employment law; and Christchurch City Council bylaws and any required trading permits." },
        { kind: "p", text: "11.2  The Vendor must obtain and keep current all permits and registrations required for its operations, including its Food Control Plan / National Programme registration, any trading permit, and vehicle compliance, and must provide copies to the Club on request and before trading." },
        { kind: "p", text: "11.3  The Vendor is solely responsible for its staff, their employment, training, and supervision." },
      ],
    },
    {
      heading: "12. Gas, Fire & Equipment Safety",
      items: [
        { kind: "p", text: "12.1  Any LPG / gas equipment must be installed, connected, and certified by a suitably qualified person, with current certification available on request." },
        { kind: "p", text: "12.2  The Vendor must keep within the Food Truck, in date and readily accessible, at least one appropriate fire extinguisher and a fire blanket, and its staff must be trained in their use." },
        { kind: "p", text: "12.3  The Vendor must operate cooking equipment safely, manage hot oil and ignition sources responsibly, and keep gas bottles secured, ventilated, and away from the public." },
        { kind: "p", text: "12.4  All Vendor equipment must be in safe working order. The Club may inspect the Food Truck and equipment before and during the Event and may direct that unsafe equipment not be used." },
      ],
    },
    {
      heading: "13. Insurance",
      items: [
        { kind: "p", text: "13.1  The Vendor must take out and maintain, with a reputable insurer, for the duration of this Agreement:" },
        { kind: "bullet", text: "public liability insurance of at least $2,000,000 per claim;" },
        { kind: "bullet", text: "product liability insurance of at least $2,000,000; and" },
        { kind: "bullet", text: "motor-vehicle insurance for the Food Truck." },
        { kind: "p", text: "13.2  The Vendor must provide current certificates of insurance to the Club before trading, and must not trade until it has done so." },
        { kind: "p", text: "13.3  The Vendor's insurance is primary, and the Vendor must not do anything that could prejudice any insurance held by the Club." },
      ],
    },
    {
      heading: "14. Health & Safety",
      items: [
        { kind: "p", text: "14.1  Both parties are PCBUs under the Health and Safety at Work Act 2015 and must consult, co-operate, and co-ordinate activities so far as is reasonably practicable." },
        { kind: "p", text: "14.2  The Vendor must:" },
        { kind: "bullet", text: "maintain and follow a health-and-safety plan for its operations;" },
        { kind: "bullet", text: "comply with the Club's site safety rules and directions;" },
        { kind: "bullet", text: "report any incident, injury, or near-miss to the Club as soon as practicable; and" },
        { kind: "bullet", text: "safely manage all hazardous substances, including LPG and hot oil." },
        { kind: "p", text: "14.3  The Club will provide site safety information and use reasonable care to maintain a safe Premises, but is not responsible for the Vendor's own operations, equipment, or staff." },
      ],
    },
    {
      heading: "15. Damage, Cleaning & Repair",
      items: [
        { kind: "p", text: "15.1  The Vendor must not damage the Premises, turf, surfaces, or services, and must leave the Designated Bay clean and undamaged at the end of each trading day and on pack-up." },
        { kind: "p", text: "15.2  If the Vendor causes any damage, staining, or extraordinary cleaning or waste-removal need, the Vendor must make good or pay the Club's full costs of cleaning, repair, remediation, or replacement, within 14 days of the Club's written demand with reasonable supporting detail." },
        { kind: "p", text: "15.3  Amounts payable under this clause are recoverable as a debt due to the Club, in addition to the Club's other rights and remedies under this Agreement or at law." },
      ],
    },
    {
      heading: "16. Indemnity & Liability",
      items: [
        { kind: "p", text: "16.1  The Vendor indemnifies the Club against all claims, losses, costs, and liabilities arising from or in connection with: (a) the Vendor's operations and goods; (b) any breach of this Agreement by the Vendor; and (c) any act or omission of the Vendor, its staff, or contractors." },
        { kind: "p", text: "16.2  To the maximum extent permitted by law, the Club is not liable to the Vendor for any loss of profit, loss of revenue, business interruption, or indirect or consequential loss." },
        { kind: "p", text: "16.3  The Club does not warrant or guarantee any level of attendance, customer volume, foot traffic, or revenue at the Event. Trade depends on many factors outside the Club's control." },
      ],
    },
    {
      heading: "17. Event Changes, Postponement & Cancellation",
      items: [
        { kind: "p", text: "17.1  The Club may change the Event programme, dates, layout, or hours, and may postpone, shorten, or cancel the Event or any part of it, including for weather, ground conditions, safety, or any cause beyond its reasonable control (force majeure)." },
        { kind: "p", text: "17.2  If the Event is shortened, postponed, or cancelled, the Club is not liable to the Vendor for any loss, and any fixed contributions already paid will be refunded on a fair, pro-rata basis for the portion of the trading period not held. Commission is only ever payable on actual Gross Revenue." },
      ],
    },
    {
      heading: "18. Termination & Removal",
      items: [
        { kind: "p", text: "18.1  The Club may terminate this Agreement, and require the Vendor to cease trading and leave the Premises immediately, if:" },
        { kind: "bullet", text: "any required permit, registration, or insurance lapses or is not produced on request;" },
        { kind: "bullet", text: "a food-safety, health-and-safety, or fire-safety breach or serious risk occurs;" },
        { kind: "bullet", text: "the Vendor or its staff behave in an unsafe, dishonest, or inappropriate manner;" },
        { kind: "bullet", text: "the Vendor materially breaches this Agreement and does not remedy it promptly on request; or" },
        { kind: "bullet", text: "the Vendor becomes insolvent." },
        { kind: "p", text: "18.2  Either party may otherwise terminate this Agreement before the trading period by giving written notice; once the Event has begun, clause 18.1 governs." },
        { kind: "p", text: "18.3  On termination or at the end of the Event the Vendor must, by its pack-up time: cease trading; remove the Food Truck, all equipment, and all waste; leave the Designated Bay clean and undamaged; and pay all amounts owing. The Club may remove and store, at the Vendor's cost and risk, anything left behind." },
      ],
    },
    {
      heading: "19. Dispute Resolution",
      items: [
        { kind: "p", text: "19.1  The parties will first try in good faith to resolve any dispute by negotiation between their representatives." },
        { kind: "p", text: "19.2  If a dispute is not resolved within 14 days, either party may refer it to mediation before commencing court proceedings. Nothing in this clause prevents a party from seeking urgent interim relief." },
      ],
    },
    {
      heading: "20. General",
      items: [
        { kind: "p", text: "20.1  This Agreement (including the deal terms above) is the entire agreement between the parties and supersedes all prior discussions and representations." },
        { kind: "p", text: "20.2  Any variation must be in writing and signed by both parties." },
        { kind: "p", text: "20.3  A failure or delay by the Club to enforce a right is not a waiver of that right." },
        { kind: "p", text: "20.4  If any provision is invalid or unenforceable, it is severed and the rest of the Agreement continues in force." },
        { kind: "p", text: "20.5  Notices must be in writing and sent to the contact details provided by the parties." },
        { kind: "p", text: "20.6  The Vendor consents to the Club collecting and using its information for the purposes of this Agreement and the Event, consistent with the Privacy Act 2020." },
        { kind: "p", text: "20.7  This Agreement is governed by, and is to be interpreted in accordance with, New Zealand law, and the parties submit to the jurisdiction of the New Zealand courts." },
        { kind: "p", text: "20.8  This Agreement may be signed in counterparts, including by electronic signature, each of which is an original and which together form one agreement." },
      ],
    },
  ],
  signAck:
    "By signing below, each party agrees to be bound by this Agreement — the deal terms and the standard terms (clauses 1–20). Please complete your details above before signing. This is a licence to occupy prepared for the Christchurch International Cup 2026.",
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
        "CIC Food & Beverage Vendor Agreement",
        "Licence to Occupy for food/beverage vendors at the Christchurch International Cup, signed on a branded web page. 15% of Gross Revenue + power/waste contributions; vendor fills their own business + compliance details when signing.",
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

// Only run when invoked directly (other scripts may import the content).
if (process.argv[1]?.includes("seed-cic-food-vendor-template")) {
  main().catch((err) => { console.error("❌ Seed failed:", err); process.exit(1); });
}
