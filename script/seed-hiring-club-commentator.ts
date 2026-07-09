/**
 * Seed the first Hiring posting: Christchurch United's Club Commentator.
 *
 *   Two paid seats behind the microphone for the home match against Cashmere
 *   Technical — Southern League Round 15, Saturday 1 August 2026, 5:00pm at the
 *   United Sports Centre. Fixture verified against the club website's own
 *   verified fixture list (apps/cufc-website/src/lib/fixtures.ts, round 15).
 *
 * The posting is MANAGED by the United Sports Group workspace (so it appears in
 * USG → Hiring) and ADVERTISED under the public brand key "cufc", which is what
 * footballinstitute.co.nz posts to. Brand is a namespace, not an owner.
 *
 * The `questions` array here must stay identical to the one the advert renders
 * in apps/football-institute/src/careers.ts. The site bundles a copy so the page
 * still renders if the API is unreachable; this row is what the SERVER validates
 * against, and the server always wins.
 *
 * Seeds as status='draft' on purpose. A draft is unreachable from the public
 * endpoints even by guessing the slug, so applying the migration and deploying
 * cannot accidentally put a live job advert on the internet. Open it with one
 * click in USG → Hiring, or pass --open.
 *
 * Idempotent: upserts on (brand, slug). Re-running never duplicates the job and
 * never touches applications.
 *
 * Usage:
 *   npx tsx --env-file=.env script/seed-hiring-club-commentator.ts           # dry run
 *   npx tsx --env-file=.env script/seed-hiring-club-commentator.ts --write   # apply (draft)
 *   npx tsx --env-file=.env script/seed-hiring-club-commentator.ts --write --open
 */

import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const WRITE = process.argv.includes("--write");
const OPEN = process.argv.includes("--open");

const ORG_SLUG = "united-sports-group";
const BRAND = "cufc";
const SLUG = "club-commentator";

// Applications close at 23:59 NZ on Sunday 19 July — thirteen days before
// kickoff, which leaves a week for the shortlist, the live trial, and the
// briefing pack. NZST is UTC+12 in August.
const CLOSES_AT = "2026-07-19T23:59:00+12:00";

const QUESTIONS = [
  {
    id: "preferred_role",
    label: "Which seat do you want?",
    type: "select",
    required: true,
    options: [
      "Lead commentator — I want to call the play",
      "Co-commentator — I want to analyse and add context",
      "Either — put me where I'm most useful",
    ],
  },
  {
    id: "availability_confirm",
    label:
      "I am available at the United Sports Centre on Saturday 1 August 2026, from roughly 90 minutes before the 5:00pm kickoff until about 7:15pm.",
    type: "checkbox",
    required: true,
  },
  {
    id: "audition",
    label: "Your audition — 60 to 90 seconds, one take, unedited",
    type: "file-or-url",
    required: true,
    accept: "audio/*,video/*",
    help: "Paste a link (unlisted YouTube, Google Drive, Dropbox — check we can open it), or upload the file directly.",
  },
  {
    id: "kickoff_opening",
    label: "Your kickoff opening — about 120 words",
    type: "textarea",
    required: true,
    minLength: 200,
    maxLength: 1200,
    placeholder: "The camera is live. The teams are in the tunnel. Write exactly what you would say…",
  },
  {
    id: "research_opposition",
    label: "Three things about Cashmere Technical the audience should know — and where you found each one",
    type: "textarea",
    required: true,
    minLength: 100,
    maxLength: 1500,
    help: "We are testing whether you look things up. Cite your sources, even if it's just a link.",
  },
  {
    id: "why_you",
    label: "Why you?",
    type: "textarea",
    required: true,
    maxLength: 800,
    placeholder: "What you'd bring to the booth, in your own words.",
  },
  {
    id: "experience",
    label: "Commentary, broadcast, podcast or public-speaking experience",
    type: "textarea",
    required: false,
    maxLength: 800,
    help: "None is genuinely fine. We are hiring on the audition, not the CV.",
  },
  {
    id: "football_background",
    label: "Your football background",
    type: "textarea",
    required: false,
    maxLength: 800,
    placeholder:
      "Playing, coaching, refereeing, writing, or simply the team you've watched every week since you were six.",
  },
  {
    id: "links",
    label: "A link to your work, if you have one",
    type: "url",
    required: false,
    placeholder: "Showreel, podcast, socials — optional",
  },
];

const JOB = {
  title: "Club Commentator",
  tagline:
    "Two paid seats behind the microphone for Christchurch United's home match against Cashmere Technical.",
  employmentType: "Paid casual — one fixture, with more to follow",
  positions: 2,
  payLabel: "$50 per commentator",
  location: "United Sports Centre, 466 Yaldhurst Road, Christchurch",
  advertUrl: "https://footballinstitute.co.nz/careers/club-commentator",
  notifyEmail: "info@cufc.co.nz",
  description:
    "Christchurch United v Cashmere Technical — Southern League, Round 15. Saturday 1 August 2026, 5:00pm kickoff at the United Sports Centre. We are hiring two commentators for the club's matchday broadcast: one to call the play, one to analyse it. Paid, $50 each. Selection is by audition, not CV.",
};

(async () => {
  const { rows: orgs } = await pool.query("SELECT id, name FROM organizations WHERE slug = $1", [ORG_SLUG]);
  if (orgs.length !== 1) throw new Error(`Expected exactly one org with slug "${ORG_SLUG}", found ${orgs.length}`);
  const org = orgs[0];

  const { rows: existing } = await pool.query(
    "SELECT id, status FROM hiring_jobs WHERE brand = $1 AND slug = $2",
    [BRAND, SLUG],
  );
  const status = OPEN ? "open" : existing[0]?.status ?? "draft";

  console.log(`\nOrg:        ${org.name} (id ${org.id})`);
  console.log(`Brand/slug: ${BRAND}/${SLUG}`);
  console.log(`Job:        ${JOB.title} — ${JOB.positions} positions, ${JOB.payLabel}`);
  console.log(`Closes:     ${CLOSES_AT}`);
  console.log(`Status:     ${status}${OPEN ? "  (--open given)" : ""}`);
  console.log(`Questions:  ${QUESTIONS.length} (${QUESTIONS.filter((q) => q.required).length} required)`);
  console.log(existing.length ? `Existing:   job id ${existing[0].id} — will UPDATE` : "Existing:   none — will INSERT");

  if (!WRITE) {
    console.log("\n🔍 Dry run. Nothing written. Re-run with --write to apply.\n");
    await pool.end();
    return;
  }

  // Upsert on the (brand, slug) unique index. Applications are untouched: they
  // hang off job_id, and the id is preserved by the update.
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
      org.id, BRAND, SLUG, JOB.title, JOB.tagline, JOB.description, JOB.employmentType,
      JOB.positions, JOB.payLabel, JOB.location, status, CLOSES_AT, JOB.advertUrl,
      JOB.notifyEmail, JSON.stringify(QUESTIONS),
    ],
  );

  const job = rows[0];
  console.log(`\n✅ Seeded hiring_jobs id ${job.id}, status "${job.status}".`);
  if (job.status !== "open") {
    console.log("   It is NOT public yet. Open it in ClubOS → United Sports Group → Hiring,");
    console.log("   or re-run this script with --write --open.");
  }
  await pool.end();
})().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
