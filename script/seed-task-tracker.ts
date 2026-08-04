/**
 * Seed the Task Tracker with the club's REAL strategic priorities.
 *
 *   npx tsx script/seed-task-tracker.ts             # dry run
 *   npx tsx script/seed-task-tracker.ts --apply
 *
 * GROUNDING RULE: everything seeded here is transcribed from the workspace's
 * own strategy documents (context/strategy.md, context/business-info.md). No
 * owner is assigned and almost no date is set, because who owns a priority and
 * when it is due are Travis's and Daniel's decisions — not something to infer
 * from a document. Inventing either would put a fake commitment in front of
 * staff on day one, which is exactly how a tracker loses credibility.
 *
 * The one exception is the "Get the Task Tracker running" project: those tasks
 * are the real rollout steps, and they exist so the tool is not an empty room
 * the first time anyone opens it.
 *
 * Refuses to run over a tracker that already has projects.
 */
import "dotenv/config";
import pg from "pg";

const APPLY = process.argv.includes("--apply");

/** Strategic priorities, verbatim in substance from context/strategy.md. */
const GOALS: Array<{ name: string; emoji: string; target: string; areas: string[]; brands: string[] }> = [
  {
    name: "Cut the annual deficit",
    emoji: "📉",
    target: "$700k → $350k by end of 2027, break even 2028",
    areas: ["finance", "commercial"],
    brands: ["usg"],
  },
];

const PROJECTS: Array<{
  name: string; emoji: string; description: string; areas: string[]; brands: string[]; status: string;
}> = [
  {
    name: "Build the sponsorship machine",
    emoji: "🤝",
    description:
      "A clear, repeatable sponsorship process: who we target, how we approach them, what we offer. Shift the mix toward cash deals — contra has value but does not close a budget gap.",
    areas: ["commercial"], brands: ["cufc", "siu", "usg"], status: "Planning",
  },
  {
    name: "Mini Football Leagues to 100+ teams",
    emoji: "⚽",
    description:
      "Currently around 50 teams across 4 leagues, with physical capacity for 150–200. Marketing and registration systems to drive team acquisition, plus retention so teams re-register each term.",
    areas: ["marketing", "football"], brands: ["mfl"], status: "Planning",
  },
  {
    name: "Protect and grow the CIC tournament",
    emoji: "🏆",
    description:
      "The July tournament in its 11th year, under growing pressure from copycat events. Execute at the highest level and differentiate on heritage, production quality and experience.",
    areas: ["events"], brands: ["cic"], status: "Planning",
  },
  {
    name: "Academy pricing review",
    emoji: "🎓",
    description:
      "Model the optimal price points across all age bands, sensitive to cost-of-living pressure on families. Losing players to other clubs over price is a real risk.",
    areas: ["football", "finance"], brands: ["cufc"], status: "Backlog",
  },
  {
    name: "Holiday Camps to $100k a year",
    emoji: "⛺",
    description:
      "Across the four camp periods (January, April, October, December). Improve early registration conversion and optimise the funnel for each camp.",
    areas: ["events", "marketing"], brands: ["cufc"], status: "Planning",
  },
  {
    name: "Establish the South Island United brand",
    emoji: "🌟",
    description:
      "No home games in Season 1 means no traditional fan touchpoints, so brand building is community and digital first. Goal: a credible, exciting professional brand by the end of Season 1.",
    areas: ["marketing"], brands: ["siu"], status: "Planning",
  },
  {
    name: "Design and launch the membership programme",
    emoji: "🎟️",
    description:
      "Unlaunched for both clubs. Traditional membership is built around ticketing and home games — neither applies yet — so the direction is an access-and-experience model. Target: a founding-members beta before the end of 2026.",
    areas: ["commercial", "marketing"], brands: ["cufc", "siu"], status: "Backlog",
  },
  {
    name: "United Print — $100k external revenue",
    emoji: "🖨️",
    description:
      "Equipment and a full-time manager are in place; what is missing is external revenue. Needs a clear point of difference in a competitive Christchurch market, inbound lead generation and an outbound system.",
    areas: ["commercial"], brands: ["prints"], status: "Planning",
  },
];

/** The real rollout steps — so the tracker is not an empty room on day one. */
const ROLLOUT_TASKS = [
  "Add every staff member's current work as tasks, so nothing lives only in WhatsApp",
  "Set an owner and a due date on everything already in here",
  "Agree the weekly meeting slot and run it off the This Week view",
  "Name the date WhatsApp stops being where work is assigned",
  "Check each person can see the tab and knows how to add a task",
];

async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("BEGIN");

  try {
    const { rows: existing } = await c.query(`SELECT count(*)::int AS n FROM tt_projects`);
    if (existing[0].n > 0) {
      console.log(`\n⚠️  The tracker already holds ${existing[0].n} project(s) — refusing to seed over real work.`);
      await c.query("ROLLBACK");
      await c.end();
      return;
    }

    const { rows: statuses } = await c.query(`SELECT id, label FROM tt_project_statuses`);
    const statusId = (label: string) =>
      statuses.find((s: any) => s.label === label)?.id ?? statuses[0].id;

    let n = 0;
    for (const g of GOALS) {
      await c.query(
        `INSERT INTO tt_projects (name, emoji, kind, status_id, areas, brands, target_note)
         VALUES ($1,$2,'goal',$3,$4,$5,$6)`,
        [g.name, g.emoji, statusId("In progress"), g.areas, g.brands, g.target],
      );
      n++;
    }

    for (const p of PROJECTS) {
      await c.query(
        `INSERT INTO tt_projects (name, emoji, description, kind, status_id, areas, brands)
         VALUES ($1,$2,$3,'project',$4,$5,$6)`,
        [p.name, p.emoji, p.description, statusId(p.status), p.areas, p.brands],
      );
      n++;
    }

    const { rows: roll } = await c.query(
      `INSERT INTO tt_projects (name, emoji, description, kind, status_id, areas, brands)
       VALUES ('Get the Task Tracker running','🚀',
               'The steps that decide whether this sticks. A tracker fails when it runs alongside the old way instead of replacing it.',
               'project',$1,ARRAY['operations'],ARRAY['usg']) RETURNING id`,
      [statusId("In progress")],
    );
    n++;

    const { rows: todo } = await c.query(`SELECT id FROM tt_task_statuses WHERE kind='todo' LIMIT 1`);
    let taskCount = 0;
    for (const [i, title] of ROLLOUT_TASKS.entries()) {
      await c.query(
        `INSERT INTO tt_tasks (project_id, status_id, title, sort_order) VALUES ($1,$2,$3,$4)`,
        [roll[0].id, todo[0].id, title, i],
      );
      taskCount++;
    }

    console.log(`\n${n} projects (1 goal, ${PROJECTS.length} priorities, 1 rollout) + ${taskCount} rollout tasks`);
    console.log("No owners and no due dates set — those are Travis's calls, not something to infer.");

    if (APPLY) {
      await c.query("COMMIT");
      console.log("\n✅ Seeded.");
    } else {
      await c.query("ROLLBACK");
      console.log("\n↩️  Dry run — rolled back. Re-run with --apply.");
    }
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    console.error("\n❌ Failed, rolled back:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
