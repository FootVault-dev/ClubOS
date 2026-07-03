// Seed / update the MFL Referee Contractor Agreement native e-Sign template.
// Idempotent: upserts on (organization_id, slug). Re-run any time the wording
// changes — already-sent documents keep their own snapshot (sourcePdf + hash),
// so edits here never rewrite history.
//
// Wording = Daniel's proofread V1 contracts + the additions approved 2026-07-03:
//   • Employment Relations Amendment Act 2026 "gateway test" bullets (§2)
//   • Code of Conduct incorporated as Appendix A (§3.9)
//   • GST-inclusive fee line + game-cancellation clarity (§5)
//   • Independent Advice clause (§12)
//   • Under-18 parent/guardian co-signature (handled by the signing flow)
//   • "ongoing bases" typo → "ongoing basis"
//   • Rate + start date are sender-set variables (one template, any rate)
//
// Usage: npx tsx --env-file=.env script/seed-mfl-referee-template.ts

import { Pool } from "pg";

const ORG_SLUG = "mini-football-leagues";
const SLUG = "mfl-referee-agreement";

export const brand = {
  orgLabel: "Mini Football Leagues",
  logoUrl: "/logos/mini-football-leagues.png",
  bg: "#0a0a0a",
  panel: "#141414",
  border: "#2a2a2a",
  accent: "#d1b96e",
  accentDeep: "#a8915a",
  paper: "#faf8f2",
  ink: "#17150e",
};

export const variables = [
  { key: "rate", label: "Game fee", type: "select", options: ["$25.00", "$23.95"], allowCustom: true, required: true },
  { key: "start_date", label: "Start date", type: "date", default: "2026-07-20", required: true },
];

export const form = [
  { key: "referee_name", label: "Full legal name", type: "text", required: true, placeholder: "As shown on your ID" },
  { key: "dob", label: "Date of birth", type: "dob", required: true, help: "Under 18? A parent or guardian co-signs — the form handles it automatically." },
  { key: "phone", label: "Mobile number", type: "phone", required: true },
  { key: "address", label: "Home address", type: "address", required: true },
  { key: "bank_account", label: "Bank account for game fees", type: "bank", required: true, help: "e.g. 12-3456-7890123-00" },
];

export const settings = {
  guardianUnder18: true,
  counterSignerRole: "The League",
  primarySignerRole: "The Referee",
  adviceNotice:
    "Take your time. You're welcome to seek independent advice before signing — this page will still be here when you're ready.",
};

export const content = {
  docTitle: "Referee Contractor Agreement",
  partiesIntro: [
    "This Agreement is made between:",
    "Christchurch United Football Club Incorporated, trading as Mini Football Leagues (“the League”)",
    "and",
    "{{referee_name}} (“the Referee”).",
  ],
  sections: [
    {
      heading: "1. Purpose",
      items: [
        { kind: "p", text: "The League engages the Referee to officiate matches in accordance with this Agreement. The Referee agrees to perform their duties fairly, consistently, and to the best of their ability." },
      ],
    },
    {
      heading: "2. Term of Agreement",
      items: [
        { kind: "bullet", text: "This Agreement begins on {{start_date}} and continues on an ongoing basis, unless terminated as outlined below." },
        { kind: "bullet", text: "The Referee is engaged on a contractor basis." },
        { kind: "bullet", text: "The League does not guarantee a minimum number of games per week and will allocate referees to games at the start of each game week." },
        { kind: "bullet", text: "The Referee may accept or decline any game allocated to them." },
        { kind: "bullet", text: "The Referee is not required to be available at specific times or on specific days." },
        { kind: "bullet", text: "The Referee is free to provide services to any other person or organisation, except while actually performing services for the League." },
        { kind: "bullet", text: "This Agreement will not be terminated solely because the Referee declines an offer of games." },
      ],
    },
    {
      heading: "3. Duties and Responsibilities",
      items: [
        { kind: "p", text: "The Referee agrees to:" },
        { kind: "numbered", text: "Officiate matches in line with FIFA Laws of the Game and League Rules, adapted for Mini Football." },
        { kind: "numbered", text: "Arrive at least 10 minutes before the scheduled kickoff time." },
        { kind: "numbered", text: "Conduct themselves in a professional, impartial, and respectful manner at all times." },
        { kind: "numbered", text: "Ensure player safety is prioritised and stop play in unsafe conditions." },
        { kind: "numbered", text: "Submit accurate match results immediately following each game through the Mini Football App." },
        { kind: "numbered", text: "Wear appropriate referee attire provided/approved by the League." },
        { kind: "numbered", text: "Attend referee briefings, meetings or training sessions when required." },
        { kind: "numbered", text: "Inform the League coordinators of any significant incidents that occurred during the games, for example, but not limited to verbal abuse, physical abuse and serious injuries." },
        { kind: "numbered", text: "Comply with the Referee Code of Conduct (Appendix A), which forms part of this Agreement." },
      ],
    },
    {
      heading: "4. Standards of Conduct",
      items: [
        { kind: "p", text: "The Referee must:" },
        { kind: "bullet", text: "Treat all players, coaches, and spectators with respect." },
        { kind: "bullet", text: "Avoid abusive or offensive language." },
        { kind: "bullet", text: "Refrain from any conduct that brings the League into disrepute." },
        { kind: "bullet", text: "Not consume alcohol or drugs before or during officiating duties." },
        { kind: "bullet", text: "Disclose any conflict of interest (e.g., officiating matches involving relatives or their own team)." },
      ],
    },
    {
      heading: "5. Payment and Expenses",
      items: [
        { kind: "bullet", text: "The Referee will be paid {{rate}} per game." },
        { kind: "bullet", text: "All fees are inclusive of GST (if any)." },
        { kind: "bullet", text: "Payment will be made fortnightly on Wednesday as per the League policy." },
        { kind: "bullet", text: "If a game is cancelled after the Referee has arrived at the venue, the game fee for that game remains payable in full. No fee is payable for games cancelled before arrival." },
        { kind: "bullet", text: "No additional expenses will be reimbursed unless approved in writing by the League." },
      ],
    },
    {
      heading: "6. Accountability & Discipline",
      items: [
        { kind: "bullet", text: "The League reserves the right to review referee performance." },
        { kind: "bullet", text: "Complaints from players, coaches, or spectators may result in an investigation." },
        { kind: "bullet", text: "If a referee consistently fails to meet standards (e.g., lateness, poor conduct, repeated errors), the League may issue:" },
        { kind: "numbered", text: "A verbal warning." },
        { kind: "numbered", text: "A written warning." },
        { kind: "numbered", text: "Suspension or termination of this Agreement." },
      ],
    },
    {
      heading: "7. Termination",
      items: [
        { kind: "p", text: "This Agreement may be terminated:" },
        { kind: "bullet", text: "By either party with 14 days’ notice." },
        { kind: "bullet", text: "Immediately by the League in cases of gross misconduct, breach of duties, or unsafe behaviour." },
      ],
    },
    {
      heading: "8. Liability & Insurance",
      items: [
        { kind: "bullet", text: "The Referee acknowledges they are responsible for their own health and safety while officiating." },
        { kind: "bullet", text: "The League will provide a safe playing environment but accepts no liability for personal injury or loss, except where required by law." },
        { kind: "bullet", text: "The Referee must comply with all health and safety requirements set by the League and venue." },
      ],
    },
    {
      heading: "9. Independent Contractor Status",
      items: [
        { kind: "bullet", text: "The Referee is engaged as an independent contractor, not an employee, unless otherwise agreed in writing." },
        { kind: "bullet", text: "The Referee is responsible for their own tax obligations (e.g., IRD)." },
      ],
    },
    {
      heading: "10. Confidentiality",
      items: [
        { kind: "bullet", text: "The Referee agrees not to disclose any private League information, referee assignments, or sensitive incidents to outside parties without approval." },
      ],
    },
    {
      heading: "11. Governing Law",
      items: [
        { kind: "p", text: "This Agreement is governed by the laws of New Zealand." },
      ],
    },
    {
      heading: "12. Independent Advice",
      items: [
        { kind: "p", text: "The Referee confirms they have had a reasonable opportunity to seek independent advice about this Agreement before signing, and enters into it freely." },
      ],
    },
  ],
  signAck:
    "By signing, each party acknowledges they have read, understood and agree to this Agreement, including the Referee Code of Conduct (Appendix A). If the Referee is under 18, a parent or legal guardian co-signs to confirm their consent.",
  appendix: {
    title: "Appendix A — Referee Code of Conduct",
    intro: "As an official of Mini Football Leagues, I agree to uphold the following standards of conduct at all times while officiating:",
    sections: [
      {
        heading: "Professional Standards",
        items: [
          { kind: "bullet", text: "Arrive at least 10 minutes before kickoff prepared and ready." },
          { kind: "bullet", text: "Wear approved referee uniform and present myself in a professional manner." },
          { kind: "bullet", text: "Officiate matches in accordance with the Laws of the Game and League rules." },
          { kind: "bullet", text: "Prioritise player safety and stop play if conditions are unsafe." },
          { kind: "bullet", text: "Make impartial, consistent, and fair decisions to the best of my ability." },
        ],
      },
      {
        heading: "Respect & Behaviour",
        items: [
          { kind: "bullet", text: "Treat all players, coaches, parents, and spectators with respect." },
          { kind: "bullet", text: "Use clear, calm, and respectful language at all times." },
          { kind: "bullet", text: "Refrain from abusive, discriminatory, or offensive behaviour or language." },
          { kind: "bullet", text: "Avoid confrontations — de-escalate tense situations whenever possible." },
          { kind: "bullet", text: "Never favour a team or player due to personal connections or bias." },
        ],
      },
      {
        heading: "Prohibited Conduct",
        items: [
          { kind: "bullet", text: "No alcohol, drugs, or performance-impairing substances before or during officiating." },
          { kind: "bullet", text: "No use of mobile phones or personal devices during matches (except when scoring)." },
          { kind: "bullet", text: "No physical contact with players except when absolutely necessary for safety." },
          { kind: "bullet", text: "Do not gamble on matches or engage in activities that create a conflict of interest." },
        ],
      },
      {
        heading: "Accountability",
        items: [
          { kind: "bullet", text: "Submit accurate match reports immediately after each game." },
          { kind: "bullet", text: "Accept feedback from league management and participate in referee reviews/training." },
          { kind: "bullet", text: "Understand that failure to follow this Code may result in warnings, suspension, or removal from the League." },
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
        "MFL Referee Contractor Agreement",
        "Referee contract + Code of Conduct signed on a branded web page. Rate + start date set per referee; under-18s co-signed by a parent/guardian.",
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

// Only run when invoked directly (the render-proof script imports the content).
if (process.argv[1]?.includes("seed-mfl-referee-template")) {
  main().catch((err) => { console.error("❌ Seed failed:", err); process.exit(1); });
}
