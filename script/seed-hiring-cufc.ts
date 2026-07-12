/**
 * Seed the Christchurch United job adverts into `hiring_jobs`.
 *
 * Brand is a namespace, not an owner: these rows are MANAGED by the United
 * Sports Group workspace (where the Hiring tab lives) and ADVERTISED under the
 * public brand key `cufc`, which cufc.co.nz/careers reads from
 * /api/public/hiring/cufc/jobs. No migration and no deploy is needed — the
 * tables and routes are already on prod, and cufc.co.nz is already in
 * HIRING_HOSTS.
 *
 * NOTE: brand `cufc` already carries `club-commentator` (seeded by
 * seed-hiring-club-commentator.ts, served on footballinstitute.co.nz). This
 * script never touches that slug; the careers page lists it automatically.
 *
 * Three evergreen roles (Daniel, 2026-07-13: "we always need academy coaches
 * U4–U20, we're always looking for photographers, and content creators"):
 *   academy-coach   — paid role (the club employs 20–25 part-time coaches);
 *                     no per-age rate exists on file, so the advert says the
 *                     rate depends on age group + experience. Daniel can put a
 *                     real figure in pay_label via the Hiring tab any time.
 *   photographer    — pay deliberately "Discussed at interview". No rate on
 *                     file and this script will not invent one.
 *   content-creator — same. (Distinct from MFL's draft content-creator job —
 *                     different brand, different advert.)
 *
 * closes_at is NULL on all three: these are standing adverts. `jobIsOpen`
 * treats a null deadline as open, so they stay live until a human closes them.
 *
 * The photographer portfolio question is type `url`, NOT `file-or-url`: the
 * server mime-filters uploads to audio/* and video/*, so an image or PDF
 * portfolio upload would be rejected. Photographers paste a link.
 *
 * Idempotent: upserts on (brand, slug). Re-running never duplicates a job and
 * never touches applications (they hang off job_id, which the update preserves).
 *
 * Usage:
 *   npx tsx --env-file=.env script/seed-hiring-cufc.ts                 # dry run
 *   npx tsx --env-file=.env script/seed-hiring-cufc.ts --write         # apply (draft)
 *   npx tsx --env-file=.env script/seed-hiring-cufc.ts --write --open  # go live
 */
import { Pool } from "pg";

const WRITE = process.argv.includes("--write");
const OPEN = process.argv.includes("--open");

const ORG_SLUG = "united-sports-group";
const BRAND = "cufc";
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

// ── Academy Coach ────────────────────────────────────────────────────────────
// The one standing shortage. Paid: the club runs 20–25 part-time coaches, but
// no per-age-group rate is on file, so the advert commits to "paid" and leaves
// the number for the interview.
const ACADEMY_COACH: Job = {
  slug: "academy-coach",
  title: "Academy Coach",
  tagline: "Coach at Christchurch United's academy — age groups from first kicks at U4 through to U20.",
  employmentType: "Part-time — school terms",
  payLabel: "Paid — rate depends on age group and experience",
  location: "United Sports Centre, Christchurch",
  positions: 1,
  closesAt: null,
  status: OPEN ? "open" : "draft",
  description: [
    "Christchurch United's academy runs age groups from U4 right through to U20, across four school terms a year, at the United Sports Centre in Russley.",
    "We're always looking for good coaches. Some of ours arrive with badges and years on the grass; others start as players who know the game and learn the coaching craft here. What matters is that you're reliable, you care about kids getting better, and you can hold a session together.",
    "Most sessions run on weekday afternoons and evenings during term. Tell us which age groups you'd want and when you're free, and we'll fit you where you'll do your best work.",
    "It's a paid role. The rate depends on the age group you take and the experience you bring — we'll talk it through at interview.",
    "You'd be working with children, so shortlisted applicants go through the club's safeguarding checks, including police vetting.",
  ].join("\n\n"),
  questions: [
    {
      id: "age_groups",
      label: "Which age groups would you want to coach?",
      type: "textarea",
      required: true,
      minLength: 5,
      maxLength: 300,
      placeholder: "e.g. U6–U8, or anywhere from U9 to U13",
      help: "U4 to U20 — first kicks through to youth football. A range is fine.",
    },
    {
      id: "experience",
      label: "Where have you coached, and what did you coach?",
      type: "textarea",
      required: true,
      minLength: 20,
      maxLength: 1500,
      help: "Clubs, schools, holiday programmes, rep teams — or nothing yet. If you haven't coached before, tell us about your playing instead.",
    },
    {
      id: "qualification",
      label: "Do you hold a coaching qualification?",
      type: "select",
      options: [
        "No qualification",
        "NZF community coaching course",
        "OFC / NZF C Licence",
        "OFC / NZF B Licence or higher",
        "Qualified overseas",
      ],
      help: "Not required to apply.",
    },
    {
      id: "scenario",
      label: "One kid in your session is miles ahead of the rest and getting bored. What do you do with them?",
      type: "textarea",
      required: true,
      minLength: 80,
      maxLength: 1200,
      help: "There's no single right answer. We're reading how you think about coaching, not what you've memorised.",
    },
    {
      id: "availability",
      label: "Which afternoons and evenings are you generally free during term?",
      type: "textarea",
      required: true,
      minLength: 10,
      maxLength: 600,
      placeholder: "e.g. Monday and Wednesday afternoons, most evenings",
    },
    {
      id: "links",
      label: "Anything we should look at?",
      type: "url",
      help: "Optional. A coaching CV, a session clip, a LinkedIn.",
    },
  ],
};

// ── Club Photographer ────────────────────────────────────────────────────────
const PHOTOGRAPHER: Job = {
  slug: "photographer",
  title: "Club Photographer",
  tagline: "Shoot matchdays, academy sessions and club events for Christchurch United's channels.",
  employmentType: "Casual / freelance",
  payLabel: "Discussed at interview",
  location: "United Sports Centre, Christchurch",
  positions: 1,
  closesAt: null,
  status: OPEN ? "open" : "draft",
  description: [
    "Christchurch United produces its own media — match coverage, academy stories, club news across our channels. We're always looking for photographers who can catch the game and the feeling around it.",
    "The work spans first-team matchdays, academy sessions, tournaments and club events at the United Sports Centre. Some weeks it's a Saturday game; some weeks it's a nine-year-old lifting their first trophy.",
    "Bring your own camera gear. We'll brief you on what a shoot needs; how you get it is your craft.",
    "Scope and pay depend on what you take on — we'll talk it through at interview.",
  ].join("\n\n"),
  questions: [
    {
      id: "portfolio",
      // Type `url` on purpose: uploads are mime-filtered to audio/video, so a
      // photo portfolio has to be a link.
      label: "Link to your work",
      type: "url",
      required: true,
      help: "Instagram, a website, a Drive or Dropbox folder — anywhere we can see your photos.",
    },
    {
      id: "experience",
      label: "Tell us about your photography.",
      type: "textarea",
      required: true,
      minLength: 20,
      maxLength: 1200,
      help: "What you shoot, how long you've been shooting, and whether you've shot sport before. Football especially — but anything fast-moving counts.",
    },
    {
      id: "gear",
      label: "What do you shoot on?",
      type: "textarea",
      required: true,
      minLength: 10,
      maxLength: 400,
      placeholder: "Bodies, lenses, anything else you'd bring",
    },
    {
      id: "edit_software",
      label: "What do you edit in?",
      type: "text",
      maxLength: 120,
      placeholder: "e.g. Lightroom",
    },
    {
      id: "availability",
      label: "When are you generally available?",
      type: "textarea",
      required: true,
      minLength: 10,
      maxLength: 600,
      help: "First-team matches are mostly Saturdays; the academy runs on weekday afternoons and evenings.",
    },
  ],
};

// ── Content Creator ──────────────────────────────────────────────────────────
const CONTENT_CREATOR: Job = {
  slug: "content-creator",
  title: "Content Creator",
  tagline: "Make video and social content for a club building its own media — matchdays, academy, behind the scenes.",
  employmentType: "Casual / freelance",
  payLabel: "Discussed at interview",
  location: "United Sports Centre, Christchurch",
  positions: 1,
  closesAt: null,
  status: OPEN ? "open" : "draft",
  description: [
    "Christchurch United is building real club media — our own match coverage, our own channels, our own stories — and we can always use more hands that can make things.",
    "We're after people who can shoot and cut short-form video, run a matchday camera, or turn an academy session into something a parent shares. If you're strong on one of those and curious about the rest, that's enough.",
    "You'd work with the club's media team across first-team matchdays, the academy, tournaments and whatever the club is building that month.",
    "Shoot on what you're fast with — phone or camera, we care about the output. Scope and pay depend on what you take on; we'll talk it through at interview.",
  ].join("\n\n"),
  questions: [
    {
      id: "portfolio",
      label: "Show us something you've made",
      type: "file-or-url",
      required: true,
      accept: "video/*",
      help: "Paste a link — TikTok, Instagram, YouTube, a Drive folder — or upload a clip (video only, under 60MB).",
    },
    {
      id: "what_you_make",
      label: "What do you make, and what are you strongest at?",
      type: "textarea",
      required: true,
      minLength: 20,
      maxLength: 1200,
      help: "Filming, editing, motion graphics, photography, ideas — where do you sit?",
    },
    {
      id: "tools",
      label: "What do you shoot and edit with?",
      type: "text",
      maxLength: 200,
      placeholder: "e.g. iPhone + CapCut, Sony + Premiere",
    },
    {
      id: "scenario",
      label: "You've got one hour at an academy session and a phone. What do you come back with?",
      type: "textarea",
      required: true,
      minLength: 50,
      maxLength: 1000,
      help: "Talk us through the idea, not the gear.",
    },
    {
      id: "availability",
      label: "When are you generally free?",
      type: "textarea",
      required: true,
      minLength: 10,
      maxLength: 600,
    },
    { id: "links", label: "Anything else we should look at?", type: "url" },
  ],
};

const JOBS = [ACADEMY_COACH, PHOTOGRAPHER, CONTENT_CREATOR];

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

  console.log("\nEdit copy, set real rates, or close a role any time in ClubOS → United Sports Group → Hiring.\n");
  await pool.end();
})().catch((e) => {
  console.error("\n❌ Seed failed:", e.message, "\n");
  process.exit(1);
});
