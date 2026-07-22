/**
 * Seed the United Prints Management tab with its starter projects.
 *
 *   npx tsx script/seed-up-management.ts           # dry run — prints the plan
 *   npx tsx script/seed-up-management.ts --apply   # writes (only into an EMPTY workspace)
 *
 * Grounding (outputs/deep-research/2026-07-22-up-management-platform/D):
 * research says a seeded workspace beats a blank canvas for first-action
 * rate, and gives four evidence-grounded project shapes for a print shop.
 * Rules honoured here:
 *   - No invented prices, suppliers, or event dates. Undated tasks stay
 *     undated (the unscheduled tray exists precisely so nothing needs a
 *     fake date).
 *   - "Instant Quote pricing refresh" is REAL, not hypothetical — the live
 *     quote page runs placeholder per-m² rates pending Dima's numbers.
 *   - The corflute campaign is scheduled against the researched NZ
 *     real-estate spring-listing window (Sept–Nov).
 *   - Refuses to run if org 8 already has ANY plan_projects row — this
 *     seeds a first launch, it never merges into a live workspace.
 */
import "dotenv/config";
import pg from "pg";

const APPLY = process.argv.includes("--apply");

const DEFAULT_STATUSES = [
  { label: "To do", color: "#64748b", kind: "todo", sort: 0 },
  { label: "In progress", color: "#f59e0b", kind: "active", sort: 1 },
  { label: "Done", color: "#22c55e", kind: "done", sort: 2 },
];

interface SeedTask {
  title: string; description?: string; priority?: string;
  startDate?: string; dueDate?: string; milestone?: boolean;
  tags?: string[]; dependsOnPrev?: boolean;
}
interface SeedProject {
  name: string; description: string; color: string;
  startDate?: string; targetDate?: string;
  tasks: SeedTask[];
}

const PROJECTS: SeedProject[] = [
  {
    name: "Instant Quote pricing refresh",
    description:
      "The live unitedprints.co.nz Instant Quote page is running placeholder per-m² rates behind the " +
      "'indicative' banner. Get Dima's real rates in so quotes stop underselling or overselling the shop.",
    color: "#ef4444",
    tasks: [
      { title: "Confirm real per-m² rates with Dima (vinyl, corflute, ACM, mesh, banner)", priority: "urgent", dueDate: "2026-07-29", tags: ["pricing"] },
      { title: "Update QUOTE_MATERIALS in the website + redeploy", priority: "high", dueDate: "2026-07-31", tags: ["website"], dependsOnPrev: true },
      { title: "Re-test the quote flow end-to-end with a real job's numbers", priority: "high", dueDate: "2026-08-01", tags: ["website"], dependsOnPrev: true },
      { title: "Review the first live quotes against what Dima would have quoted", priority: "medium", tags: ["pricing"] },
    ],
  },
  {
    name: "Corflute spring campaign",
    description:
      "Real-estate spring listing season (Sept–Nov) is the researched corflute demand window in NZ — " +
      "listings spike ~42% and every listing wants signage. Land the offer before September.",
    color: "#f59e0b",
    startDate: "2026-08-17",
    targetDate: "2026-11-30",
    tasks: [
      { title: "Confirm corflute pricing + the offer (agency bundle vs one-off)", priority: "high", startDate: "2026-08-17", dueDate: "2026-08-21", tags: ["pricing", "campaign"] },
      { title: "Update the landing page / quote flow for the offer", priority: "medium", startDate: "2026-08-24", dueDate: "2026-08-28", tags: ["website", "campaign"], dependsOnPrev: true },
      { title: "Outreach push to real-estate offices (call list from Sales tab)", priority: "high", startDate: "2026-08-31", dueDate: "2026-09-11", tags: ["sales", "campaign"], dependsOnPrev: true },
      { title: "Follow-up sweep on resulting quotes (log outcomes in Sales)", priority: "medium", startDate: "2026-09-14", dueDate: "2026-09-18", tags: ["sales"], dependsOnPrev: true },
    ],
  },
  {
    name: "New printer purchase & install",
    description:
      "The researched equipment playbook: shortlist → site prep (power/space/climate) → order → " +
      "delivery & install → commissioning & training → old unit disposal. Date it when it's real.",
    color: "#06b6d4",
    tasks: [
      { title: "Research & shortlist (incl. add-on/peripheral + consumable costs)", priority: "medium", tags: ["equipment"] },
      { title: "Site prep — power, space, away from sunlight/moisture, network point", priority: "medium", tags: ["equipment"], dependsOnPrev: true },
      { title: "Order placed", milestone: true, tags: ["equipment"], dependsOnPrev: true },
      { title: "Delivery & install (cables, cartridges, drivers, connectivity)", priority: "medium", tags: ["equipment"], dependsOnPrev: true },
      { title: "Commissioning + staff training", priority: "medium", tags: ["equipment"], dependsOnPrev: true },
      { title: "Old unit disposal / trade-in", priority: "low", tags: ["equipment"], dependsOnPrev: true },
    ],
  },
  {
    name: "Trade show prep",
    description:
      "The researched expo checklist, ready for when a show is confirmed (e.g. NZ Sign + Print Expo — " +
      "confirm dates with PrintNZ first). Captured leads land in the Sales tab afterwards, not a new list.",
    color: "#8b5cf6",
    tasks: [
      { title: "Confirm booth + power allocation with organisers", priority: "medium", tags: ["expo"] },
      { title: "Pick the demo machine (compact, transportable)", priority: "medium", tags: ["expo"] },
      { title: "Curate 5–6 samples per product category", priority: "medium", tags: ["expo"] },
      { title: "Over-order consumables for live demos", priority: "medium", tags: ["expo"] },
      { title: "Build the lead-capture form (what to ask on the stand)", priority: "medium", tags: ["expo", "sales"] },
      { title: "Roster two staff — one demoing, one greeting/capturing", priority: "medium", tags: ["expo"] },
      { title: "Arrange hand-carried transport for demo gear", priority: "low", tags: ["expo"] },
      { title: "Post-show: enter captured leads into the Sales pipeline", priority: "high", tags: ["sales"] },
    ],
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const orgRes = await client.query("SELECT id FROM organizations WHERE slug = 'united-prints'");
    if (orgRes.rows.length !== 1) throw new Error("united-prints org not found");
    const org = orgRes.rows[0].id;

    const existing = await client.query("SELECT count(*)::int AS n FROM plan_projects WHERE organization_id = $1", [org]);
    if (existing.rows[0].n > 0) {
      console.log(`org ${org} already has ${existing.rows[0].n} project(s) — refusing to seed over a live workspace.`);
      return;
    }

    console.log(`${APPLY ? "SEEDING" : "DRY RUN"} — org ${org} (united-prints), ${PROJECTS.length} projects\n`);
    for (const p of PROJECTS) {
      console.log(`■ ${p.name}  (${p.tasks.length} tasks${p.targetDate ? `, target ${p.targetDate}` : ""})`);
      for (const t of p.tasks) console.log(`   - ${t.milestone ? "◆ " : ""}${t.title}${t.dueDate ? `  [due ${t.dueDate}]` : ""}${t.dependsOnPrev ? "  ← waits on previous" : ""}`);
    }
    if (!APPLY) { console.log("\nDry run only. Re-run with --apply to write."); return; }

    await client.query("BEGIN");
    let sortOrder = 0;
    for (const p of PROJECTS) {
      const proj = (await client.query(
        `INSERT INTO plan_projects (organization_id, name, description, color, start_date, target_date, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [org, p.name, p.description, p.color, p.startDate ?? null, p.targetDate ?? null, sortOrder++])).rows[0].id;

      const statusIds: Record<string, number> = {};
      for (const st of DEFAULT_STATUSES) {
        statusIds[st.kind] = (await client.query(
          `INSERT INTO plan_statuses (organization_id, project_id, label, color, kind, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [org, proj, st.label, st.color, st.kind, st.sort])).rows[0].id;
      }

      let prevTaskId: number | null = null;
      let taskSort = 0;
      for (const t of p.tasks) {
        const taskId = (await client.query(
          `INSERT INTO plan_tasks (organization_id, project_id, status_id, title, description, priority, start_date, due_date, milestone, tags, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [org, proj, statusIds.todo, t.title, t.description ?? null, t.priority ?? "medium",
           t.startDate ?? null, t.dueDate ?? null, !!t.milestone, t.tags ?? [], taskSort++])).rows[0].id;
        if (t.dependsOnPrev && prevTaskId) {
          await client.query(
            "INSERT INTO plan_task_deps (organization_id, predecessor_id, successor_id) VALUES ($1,$2,$3)",
            [org, prevTaskId, taskId]);
        }
        prevTaskId = taskId;
      }
    }
    await client.query("COMMIT");
    console.log("\n✅ Seeded. Every date and priority is a draft for Daniel/Dima to edit in the tab.");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
