/**
 * Seed the Mini Football Leagues job adverts into `hiring_jobs`.
 *
 * Brand is a namespace, not an owner: these rows are MANAGED by the United
 * Sports Group workspace (that is where the Hiring tab lives) and ADVERTISED
 * under the public brand key `mfl`, which minifootball.co.nz reads from
 * /api/public/hiring/mfl/jobs. No migration and no deploy is needed for either
 * of these — the tables and routes are already on prod.
 *
 * Unlike the commentator advert, the MFL site does NOT bundle a copy of this
 * content. It fetches it. So this file is the ONLY source of the copy, and
 * editing a job later happens in ClubOS → Hiring, not in a redeploy.
 *
 * Two jobs:
 *   referee         — real pay ($23.95+ per game, from the signed contractor
 *                     agreement template), real intake (Mon 20 Jul 2026).
 *                     Seeded OPEN when --open is passed.
 *   content-creator — ALWAYS seeded draft. There is no rate on file for it and
 *                     this script will not invent one. A draft is unreachable
 *                     from the public endpoints even by guessing the slug.
 *                     Daniel sets pay_label in the Hiring tab, then opens it.
 *
 * The referee copy is deliberately worded to match the contractor agreement's
 * gateway test (Employment Relations Amendment Act 2026, in force 21 Feb 2026):
 * refs may decline games, have no set times or days, and are free to work for
 * others. An advert promising fixed shifts would undercut the contract the club
 * has already had drafted. Do not "tighten" that language.
 *
 * closes_at is NULL on both: `jobIsOpen` treats a null deadline as open, so the
 * roles stay live until Daniel closes them. We do not invent a deadline.
 *
 * Idempotent: upserts on (brand, slug). Re-running never duplicates a job and
 * never touches applications (they hang off job_id, which the update preserves).
 *
 * Usage:
 *   npx tsx --env-file=.env script/seed-hiring-mfl.ts                 # dry run
 *   npx tsx --env-file=.env script/seed-hiring-mfl.ts --write         # apply (both draft)
 *   npx tsx --env-file=.env script/seed-hiring-mfl.ts --write --open  # referee goes live
 */
import { Pool } from "pg";

const WRITE = process.argv.includes("--write");
const OPEN = process.argv.includes("--open");

const ORG_SLUG = "united-sports-group";
const BRAND = "mfl";
const NOTIFY_EMAIL = "info@minifootball.co.nz";
const SITE = "https://minifootball.co.nz";

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
  accept?: string;
};

type Job = {
  slug: string;
  title: string;
  tagline: string;
  description: string;
  employmentType: string;
  positions: number;
  /** Free text, never a number. null when the club has not set a rate. */
  payLabel: string | null;
  location: string;
  /** null = open until closed by a human. */
  closesAt: string | null;
  status: "draft" | "open";
  questions: Question[];
};

// ── Referee ──────────────────────────────────────────────────────────────────
// Rate and start date come from the signed contractor agreement template
// (esign_templates `mfl-referee-agreement`): rates $25.00 / $23.95 GST-inclusive,
// default start 20 Jul 2026 — which is a Monday, and the Term 3 intake.
const REFEREE: Job = {
  slug: "referee",
  title: "Mini Football Referee",
  tagline: "Referee social football at the United Sports Centre. Paid per game, and you choose the games you take.",
  employmentType: "Independent contractor — paid per game",
  payLabel: "From $23.95 per game (GST incl.)",
  location: "United Sports Centre, Christchurch",
  positions: 1,
  closesAt: null,
  status: OPEN ? "open" : "draft",
  description: [
    "Mini Football Leagues runs social 5-a-side and 7-a-side football at the United Sports Centre. We're recruiting referees for the Term 3 intake, starting Monday 20 July.",
    "You referee as an independent contractor, not an employee. You pick the games you take, you can turn a game down without giving a reason, and you're free to referee for anyone else. There is no fixed roster and no set shifts.",
    "Pay starts at $23.95 per game, GST inclusive, for each game you referee.",
    "Games run in the evenings at the United Sports Centre, 466 Yaldhurst Rd, Russley. League nights are filmed for the Mini Football content vault.",
    "Having refereed before helps, but it matters less than knowing the game and being able to keep a lid on things when adults get competitive.",
    "If you're under 18, a parent or guardian needs to co-sign your contractor agreement before you can referee.",
  ].join("\n\n"),
  questions: [
    {
      id: "scenario",
      label: "Two players square up after a late tackle, and the sidelines are getting loud. Walk us through exactly what you do.",
      type: "textarea",
      required: true,
      minLength: 100,
      maxLength: 1200,
      help: "There's no single right answer. We're reading how you think, not what you've memorised.",
    },
    {
      id: "availability",
      label: "Which evenings are you generally free?",
      type: "textarea",
      required: true,
      minLength: 10,
      maxLength: 600,
      help: "This isn't a roster — you can decline any individual game. It just helps us know which nights to offer you.",
      placeholder: "e.g. Most Mondays and Wednesdays, some Thursdays",
    },
    {
      id: "transport",
      label: "How would you get to the United Sports Centre?",
      type: "select",
      required: true,
      options: ["I have my own transport", "I'd use public transport", "I'd need to arrange a lift"],
    },
    {
      id: "qualification",
      label: "Do you hold a refereeing qualification?",
      type: "select",
      options: [
        "No qualification",
        "NZF qualification — in progress",
        "NZF qualification — completed",
        "Qualified overseas",
      ],
      help: "Not required for this role.",
    },
    {
      id: "experience",
      label: "Have you refereed before?",
      type: "textarea",
      maxLength: 800,
      help: "Where, what level, and for how long. Leave it blank if you haven't — it's not a dealbreaker.",
    },
    {
      id: "football_background",
      label: "What's your football background?",
      type: "textarea",
      maxLength: 800,
      help: "Playing, coaching, watching. Anything that means you know the game.",
    },
    { id: "links", label: "Anything we should look at?", type: "url", help: "Optional. A profile, a clip, anything." },
  ],
};

// ── Content creator ──────────────────────────────────────────────────────────
// ALWAYS draft. No rate exists on file for this role and this script will not
// invent one — pay_label stays null until a human sets it.
const CONTENT_CREATOR: Job = {
  slug: "content-creator",
  title: "Content Creator — Photo & Video",
  tagline: "Shoot league nights at the United Sports Centre. Stills and short-form video for Mini Football's channels.",
  employmentType: "Independent contractor",
  payLabel: null,
  location: "United Sports Centre, Christchurch",
  positions: 1,
  closesAt: null,
  status: "draft",
  description: [
    "Mini Football Leagues runs social football at the United Sports Centre most weeknights. We're looking for someone to shoot it — stills and short-form video — for our social channels and the Mini Football content vault.",
    "You'd work as an independent contractor and choose the nights you take. There is no fixed roster.",
    "Bring your own camera gear. We'll tell you what we need from a night; how you shoot it is up to you.",
    "If you're under 18, a parent or guardian needs to co-sign your contractor agreement.",
  ].join("\n\n"),
  questions: [
    {
      id: "portfolio",
      label: "Your work",
      type: "file-or-url",
      required: true,
      // The server mime-filters uploads to audio/* and video/* — an image or PDF
      // upload is rejected before it reaches storage. Photographers paste a link.
      accept: "video/*",
      help: "Paste a link (Instagram, website, Drive, YouTube) — or upload a showreel. Uploads must be video, under 60MB. For photo work, paste a link.",
    },
    {
      id: "gear",
      label: "What do you shoot on?",
      type: "textarea",
      required: true,
      minLength: 10,
      maxLength: 600,
      placeholder: "Camera bodies, lenses, lighting, audio",
    },
    { id: "edit_software", label: "What do you edit in?", type: "text", maxLength: 120 },
    {
      id: "availability",
      label: "Which evenings are you generally free?",
      type: "textarea",
      required: true,
      minLength: 10,
      maxLength: 600,
      help: "This isn't a roster — you can decline any individual night.",
    },
    { id: "why_you", label: "Why this one?", type: "textarea", maxLength: 600 },
    { id: "links", label: "Anything else we should look at?", type: "url" },
  ],
};

const JOBS = [REFEREE, CONTENT_CREATOR];

(async () => {
  const { rows: orgs } = await pool.query("SELECT id, name FROM organizations WHERE slug = $1", [ORG_SLUG]);
  if (orgs.length !== 1) throw new Error(`Expected exactly one org with slug "${ORG_SLUG}", found ${orgs.length}`);
  const org = orgs[0];

  console.log(`\nOrg:   ${org.name} (id ${org.id})`);
  console.log(`Brand: ${BRAND}   → https://app.usg.co.nz/api/public/hiring/${BRAND}/jobs\n`);

  for (const job of JOBS) {
    const { rows: existing } = await pool.query(
      "SELECT id, status FROM hiring_jobs WHERE brand = $1 AND slug = $2",
      [BRAND, job.slug],
    );
    const required = job.questions.filter((q) => q.required).length;
    console.log(`  ${job.slug}`);
    console.log(`    title:     ${job.title}`);
    console.log(`    pay:       ${job.payLabel ?? "(none — a human must set this before it goes live)"}`);
    console.log(`    closes:    ${job.closesAt ?? "(no deadline — open until closed)"}`);
    console.log(`    status:    ${job.status}`);
    console.log(`    questions: ${job.questions.length} (${required} required)`);
    console.log(`    existing:  ${existing.length ? `job id ${existing[0].id} (${existing[0].status}) — will UPDATE` : "none — will INSERT"}`);
    console.log("");
  }

  if (!WRITE) {
    console.log("🔍 Dry run. Nothing written. Re-run with --write to apply.\n");
    await pool.end();
    return;
  }

  for (const job of JOBS) {
    // Upsert on the (brand, slug) unique index. Applications hang off job_id and
    // the id survives the update, so re-seeding never orphans an application.
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
        org.id, BRAND, job.slug, job.title, job.tagline, job.description, job.employmentType,
        job.positions, job.payLabel, job.location, job.status, job.closesAt,
        `${SITE}/careers/${job.slug}`, NOTIFY_EMAIL, JSON.stringify(job.questions),
      ],
    );
    const row = rows[0];
    const live = row.status === "open";
    console.log(`${live ? "🟢" : "⚪️"} ${job.slug} → hiring_jobs id ${row.id}, status "${row.status}"${live ? `  ${SITE}/careers/${job.slug}` : "  (not public)"}`);
  }

  console.log("\nDrafts are invisible to the public endpoints. Open them in ClubOS → United Sports Group → Hiring.\n");
  await pool.end();
})().catch((e) => {
  console.error("\n❌ Seed failed:", e.message, "\n");
  process.exit(1);
});
