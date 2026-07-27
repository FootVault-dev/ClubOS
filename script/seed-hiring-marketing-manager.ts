/**
 * Seed the Marketing Manager advert into `hiring_jobs`.
 *
 * Source: "Marketing Manager Advertisement.pdf" (Ryan, 2026-07). Every fact in
 * the copy below comes from that document; nothing is invented.
 *
 * WHY THIS IS A SEPARATE SCRIPT, not a fifth job in seed-hiring-cufc.ts:
 * that script upserts all four evergreen adverts on every run, so running it
 * again would overwrite any pay rate or copy Daniel has since edited in the
 * Hiring tab. This script touches exactly one row — (cufc, marketing-manager).
 *
 * Managed by the United Sports Group workspace (org 7, where the Hiring tab
 * lives); advertised under the public brand key `cufc`, which cufc.co.nz/careers
 * reads from /api/public/hiring/cufc/jobs. No migration, no deploy.
 *
 * ── THREE THINGS A HUMAN MUST DECIDE (all editable in the Hiring tab, no deploy)
 *
 * 1. CLOSING DATE. The source PDF carries two, and both are in the past: page 4
 *    says "Applications close 1 July 2025" (a stale typo) and page 6 says
 *    "1 July 2026". Today is later than both. This script will NOT invent a
 *    third date, so `closesAt` is null — the advert reads as open until filled,
 *    which `jobIsOpen` treats as open. Set a real date in the Hiring tab.
 *
 * 2. SALARY. The PDF states none, so `payLabel` is "Discussed at interview".
 *    That is the honest default, but for a full-time senior role advertised
 *    internationally a published band materially lifts applications.
 *
 * 3. WORK RIGHTS. The PDF says applications are open globally. The advert
 *    therefore invites international applicants and says work rights and
 *    relocation get discussed early — it does NOT promise visa sponsorship,
 *    which would require the club to hold Accredited Employer status.
 *
 * ── WHY EVERY DOCUMENT IS A LINK, NOT AN UPLOAD
 * The hiring form accepts ONE file per application (multer `files: 1`) and
 * mime-filters it to audio/* and video/* (AUDITION_MIME_PREFIXES) — it was
 * built for commentator auditions. A CV or a slide deck would be rejected at
 * the server. So the CV and marketing plan are `url` questions, the cover
 * letter is a textarea, and the advert names info@cufc.co.nz as the route for
 * anyone who would rather send files.
 *
 * Idempotent: upserts on (brand, slug). Re-running never duplicates the job and
 * never orphans an application (they hang off job_id, which the update keeps).
 *
 * Usage:
 *   npx tsx --env-file=.env script/seed-hiring-marketing-manager.ts                 # dry run
 *   npx tsx --env-file=.env script/seed-hiring-marketing-manager.ts --write         # apply (draft)
 *   npx tsx --env-file=.env script/seed-hiring-marketing-manager.ts --write --open  # go live
 */
import { Pool } from "pg";

const WRITE = process.argv.includes("--write");
const OPEN = process.argv.includes("--open");

const ORG_SLUG = "united-sports-group";
const BRAND = "cufc";
const SLUG = "marketing-manager";
const NOTIFY_EMAIL = "info@cufc.co.nz";
const SITE = "https://cufc.co.nz";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set. Run with --env-file=.env");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type QuestionType = "text" | "textarea" | "select" | "url" | "checkbox" | "file-or-url";
type Question = {
  id: string;
  label: string;
  type: QuestionType;
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: string[];
  minLength?: number;
  maxLength?: number;
};

const TITLE = "Marketing Manager";

const TAGLINE =
  "Build the marketing function for two clubs — a professional side in the OFC Pro League and one of New Zealand's most successful football clubs.";

// ── WRITTEN TO DEGRADE GRACEFULLY — do not "upgrade" this to `##`/`**` ────────
// This row can go live before apps/cufc-website ships its JobDescription
// renderer, and the currently-deployed job page prints `description` verbatim
// inside `whitespace-pre-line`. Markdown markers would therefore show up as
// literal "## " and "**" on cufc.co.nz.
//
// So the structure here uses only what reads correctly BOTH ways: CAPS section
// headings and `•` bullets. Plain text today, styled headings and gold bullets
// once JobDescription.tsx is deployed. Same string, no broken window.
const DESCRIPTION = `
We're looking for a Marketing Manager to lead the brand and commercial growth of both of our clubs — South Island United, which plays professionally in the OFC Pro League, and Christchurch United, one of the most successful clubs in New Zealand football.

This is a build, not a handover. There is no marketing function here to inherit — you would be the person who creates it, with the freedom and the responsibility that comes with that. It is a rare thing in football to get a blank page and a professional platform at the same time.

You would work directly with club leadership across sponsorship activation, digital content, community engagement, matchday experience and partner communications.

WHAT YOU'D BE DOING

• Lead the marketing strategy across digital, social, community and partner channels
• Drive commercial revenue through sponsorship, merchandise and event marketing
• Develop and run content strategies that grow both clubs locally and internationally
• Manage partner and sponsor relationships — value delivery, reporting and communication
• Support the OFC Pro League's media and marketing compliance obligations
• Work with the academy, events and operations teams on campaigns that cross all of them
• Build and hold relationships with media partners, including NZME and broadcaster contacts
• Write and maintain the brand guidelines that keep both clubs consistent everywhere they appear

WHAT WE'RE LOOKING FOR

• At least 3 years in marketing, ideally with a sports, entertainment or lifestyle brand
• Strong digital and social capability — content creation, and the analytics behind it
• Commercial instinct, and experience working with sponsors or commercial partners
• Excellent written and verbal communication, across cultures and contexts
• A self-starter who works independently and can hold several priorities at once
• A real interest in football, and in what sport can do commercially and for a community
• Experience in or around a professional sports club is a strong advantage, not a requirement

TWO CLUBS, ONE ROOF

South Island United is New Zealand's only South Island-based professional club. The team competes internationally in the OFC Pro League — the premier club competition in the Oceania Football Confederation, and Oceania's route through to the FIFA Intercontinental Cup and the FIFA Club World Cup. It is a genuinely new thing for football in the South Island and across the Pacific.

Christchurch United is one of New Zealand's most historic and successful clubs, competing through the Southern League and into the National League, the country's Tier 1 competition. Six National League titles. Seven Chatham Cups. The club has been a benchmark in New Zealand football for a long time.

Both clubs run out of the United Sports Centre in Christchurch, alongside a youth academy from U4 through U20, social leagues, holiday programmes and one of the country's largest youth tournaments. The commercial side — sponsorship, events, merchandise and a growing partner ecosystem — is expanding fast, which is why this role exists.

WHY CHRISTCHURCH

Christchurch is New Zealand's second-largest city — around 400,000 people, in a region of roughly 700,000 — and the gateway to the South Island. It is modern and liveable, with a serious sport culture and a football community that punches above its weight.

• Affordable cost of living relative to Auckland and Wellington
• World-class access to skiing, hiking, surf and the Southern Alps
• A strong international community and a growing tech and creative sector
• Excellent schools, healthcare and family amenities
• Two to three hours from some of New Zealand's most iconic landscapes

HOW TO APPLY

We welcome applications from anywhere in the world. Great marketing minds exist in every city and every culture, and we intend to find the best person for this role regardless of geography. If you're applying from outside New Zealand, tell us — we'd rather talk through work rights and relocation early than late.

There are three parts to an application:

1. Your CV — your experience, qualifications and the achievements that matter.
2. A cover letter — a page at most. Why you're the right person, and what interests you about SIU and New Zealand football.
3. A marketing plan for South Island United — the key requirement. The brief is below.

A note on files. Our form takes links rather than attachments, so put your CV and marketing plan somewhere we can open them — Google Drive, Dropbox, OneDrive, your own site — and paste the links in. Check the sharing is set so we can actually view them. If you'd rather send files, email the lot to info@cufc.co.nz with the subject line "Marketing Manager Application — [Your Name]".

THE MARKETING PLAN

This is the part that matters most, and it's why we ask for it up front. It isn't a test with one right answer. It's an invitation to show us how you think, what you'd prioritise, and how you'd approach building a football brand in an unusual market.

Research the club, New Zealand football and the wider Pacific context before you write it. The depth of that research shows in the work, and it matters to us.

CONTEXT WORTH KNOWING

• SIU competes in the OFC Pro League, the only South Island-based club at that level.
• Our vision is to become a sports tourism destination for international travellers and sports fans, to lift the game across the South Island, and to represent South Island grassroots football.
• We want to tell raw stories about our people — honest, real and informative. Real stories about our fans, staff and players, about the club and about the region.
• Our home base is Christchurch, a city of roughly 400,000 with a strong community sport culture.
• Alongside the elite campaign we run a growing youth academy, social leagues and a range of community football programmes.
• Commercial operations include sponsorship, events, merchandise and a developing partner ecosystem.
• New Zealand is a sport-passionate nation and football is its largest participation sport — but the professional space here, and in the South Island especially, has long been dominated by rugby, netball and cricket.

WHAT YOUR PLAN SHOULD COVER

Your plan doesn't need to be exhaustive. We're looking for strategic clarity and creative thinking.

• Brand positioning — how should SIU position itself in New Zealand football, and to a Pacific and global audience? What story should the club be telling?
• Audience and community — who are the key audiences, local, national and international, and how should the club engage each of them?
• Digital and social — what platforms, formats and publishing cadence would you prioritise? What does success look like?
• Commercial marketing — how would you support the club's commercial objectives across sponsors, merchandise and events?
• Matchday and fan experience — how would you grow the supporter base and build a matchday culture worth turning up for?
• Key priorities — if you started on day one, what would your first 90 days look like?

FORMAT

• Recommended length 6 to 12 pages — a document or a presentation, either is fine
• Any format: PDF, PowerPoint, Word or equivalent
• Supporting visuals, data references or case studies from comparable clubs are welcome
• No budget constraint is implied. Be ambitious, but be realistic about what matters most

WHAT MAKES A STRONG PLAN

• Evidence of genuine research into SIU, CUFC and the New Zealand football context
• Original thinking, rather than a generic sports marketing template
• Clear priorities — we don't expect everything, we expect good judgement
• Honesty about the challenges and the opportunities specific to a South Island club
• An understanding of the commercial pressure alongside the community mission

WHAT HAPPENS NEXT

Shortlisted candidates are invited to a video interview with club leadership. We read every application and every marketing plan ourselves, and the quality and ambition of your plan weighs heavily in who we shortlist.

We review applications as they arrive and will close the role once we've found the right person, so applying early genuinely helps.
`.trim();

const QUESTIONS: Question[] = [
  {
    id: "cv",
    // `url`, not `file-or-url`: uploads are mime-filtered to audio/video, so a
    // CV in any normal format would be rejected by the server.
    label: "Link to your CV",
    type: "url",
    required: true,
    help: "Google Drive, Dropbox, OneDrive, LinkedIn or your own site — anywhere we can open it. Check the sharing is set so we can view it.",
  },
  {
    id: "cover_letter",
    label: "Your cover letter",
    type: "textarea",
    required: true,
    minLength: 200,
    maxLength: 4000,
    help: "A page at most. Why you're the right person for this role, and what interests you about SIU and New Zealand football. Paste it straight in.",
  },
  {
    id: "marketing_plan",
    label: "Link to your marketing plan for South Island United",
    type: "url",
    required: true,
    help: "6 to 12 pages, any format. Share a Drive, Dropbox or OneDrive link, or a link to a deck. This is the part we weigh most heavily.",
  },
  {
    id: "experience_years",
    label: "How long have you worked in marketing?",
    type: "select",
    required: true,
    options: [
      "Less than 3 years",
      "3 to 5 years",
      "5 to 10 years",
      "More than 10 years",
    ],
  },
  {
    id: "sector_experience",
    label: "Tell us about your commercial and sector experience.",
    type: "textarea",
    required: true,
    minLength: 50,
    maxLength: 2000,
    help: "Sport, entertainment or lifestyle brands especially — and any work you've done with sponsors or commercial partners. If you've worked in or around a professional club, say so.",
  },
  {
    id: "based",
    label: "Where are you based?",
    type: "select",
    required: true,
    options: [
      "Christchurch",
      "Elsewhere in New Zealand",
      "Australia",
      "Elsewhere overseas",
    ],
    help: "We welcome applications from anywhere. This just tells us whether relocation is part of the conversation.",
  },
  {
    id: "start",
    label: "When could you start?",
    type: "text",
    required: true,
    maxLength: 200,
    placeholder: "e.g. immediately, or four weeks' notice",
  },
  {
    id: "links",
    label: "Anything else we should look at?",
    type: "url",
    help: "Optional. A portfolio, a campaign you're proud of, LinkedIn.",
  },
];

const JOB = {
  slug: SLUG,
  title: TITLE,
  tagline: TAGLINE,
  description: DESCRIPTION,
  employmentType: "Full-time",
  positions: 1,
  // No salary is stated anywhere in the source document, and this script will
  // not invent one. See note 2 in the header.
  payLabel: "Discussed at interview" as string | null,
  location: "United Sports Centre, Christchurch",
  // See note 1 in the header — both dates in the source PDF are in the past.
  closesAt: null as string | null,
  status: OPEN ? "open" : "draft",
  questions: QUESTIONS,
};

(async () => {
  const { rows: orgs } = await pool.query("SELECT id, name FROM organizations WHERE slug = $1", [ORG_SLUG]);
  if (orgs.length !== 1) throw new Error(`Expected exactly one org with slug "${ORG_SLUG}", found ${orgs.length}`);
  const org = orgs[0];

  const { rows: existing } = await pool.query(
    "SELECT id, status FROM hiring_jobs WHERE brand = $1 AND slug = $2",
    [BRAND, SLUG],
  );
  const { rows: apps } = existing.length
    ? await pool.query("SELECT count(*)::int AS n FROM hiring_applications WHERE job_id = $1", [existing[0].id])
    : [{ n: 0 }];

  const required = QUESTIONS.filter((q) => q.required).length;
  const words = DESCRIPTION.split(/\s+/).length;

  console.log(`\nOrg:   ${org.name} (id ${org.id})`);
  console.log(`Brand: ${BRAND}   → https://app.usg.co.nz/api/public/hiring/${BRAND}/jobs\n`);
  console.log(`  ${SLUG}`);
  console.log(`    title:     ${JOB.title}`);
  console.log(`    type:      ${JOB.employmentType}`);
  console.log(`    pay:       ${JOB.payLabel ?? "(none set)"}`);
  console.log(`    closes:    ${JOB.closesAt ?? "(no deadline — open until a human closes it)"}`);
  console.log(`    status:    ${JOB.status}`);
  console.log(`    advert:    ${words} words`);
  console.log(`    questions: ${QUESTIONS.length} (${required} required)`);
  console.log(
    `    existing:  ${existing.length ? `job id ${existing[0].id} (${existing[0].status}), ${apps[0].n} application(s) — will UPDATE` : "none — will INSERT"}`,
  );
  console.log("");

  if (!WRITE) {
    console.log("🔍 Dry run. Nothing written. Re-run with --write to apply.\n");
    await pool.end();
    return;
  }

  const { rows } = await pool.query(
    `INSERT INTO hiring_jobs
       (organization_id, brand, slug, title, tagline, description, employment_type,
        positions, pay_label, location, status, closes_at, advert_url, notify_email, questions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
     ON CONFLICT (brand, slug) DO UPDATE SET
       organization_id = EXCLUDED.organization_id,
       title           = EXCLUDED.title,
       tagline         = EXCLUDED.tagline,
       description     = EXCLUDED.description,
       employment_type = EXCLUDED.employment_type,
       positions       = EXCLUDED.positions,
       pay_label       = EXCLUDED.pay_label,
       location        = EXCLUDED.location,
       status          = EXCLUDED.status,
       closes_at       = EXCLUDED.closes_at,
       advert_url      = EXCLUDED.advert_url,
       notify_email    = EXCLUDED.notify_email,
       questions       = EXCLUDED.questions,
       updated_at      = now()
     RETURNING id, status`,
    [
      org.id, BRAND, JOB.slug, JOB.title, JOB.tagline, JOB.description, JOB.employmentType,
      JOB.positions, JOB.payLabel, JOB.location, JOB.status, JOB.closesAt,
      `${SITE}/careers/${JOB.slug}`, NOTIFY_EMAIL, JSON.stringify(JOB.questions),
    ],
  );
  const row = rows[0];
  const live = row.status === "open";
  console.log(
    `${live ? "🟢" : "⚪️"} ${SLUG} → hiring_jobs id ${row.id}, status "${row.status}"${live ? `  ${SITE}/careers/${SLUG}` : "  (not public)"}`,
  );
  console.log("\nSet a closing date, add a salary band, or close the role in ClubOS → United Sports Group → Hiring.\n");
  await pool.end();
})().catch((e) => {
  console.error("\n❌ Seed failed:", e.message, "\n");
  process.exit(1);
});
