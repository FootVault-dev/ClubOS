/**
 * Database-invariant tests for the Task Tracker.
 *
 *   npx tsx script/test-task-tracker-db.ts
 *
 * Runs against the REAL database inside a transaction that is always ROLLED
 * BACK — there is no local Postgres on this Mac, and these invariants are
 * meaningless anywhere but the real schema. Nothing is left behind.
 *
 * These check the promises the SQL makes, not the ones the app makes: that
 * deleting a project cannot destroy tasks, that a status column in use cannot
 * be deleted out from under them, that a person cannot be added to a task
 * twice, and that RLS is on.
 */
import "dotenv/config";
import pg from "pg";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, detail = "") => {
  if (ok) pass++;
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("BEGIN");

  try {
    const one = async (q: string, p: any[] = []) => (await c.query(q, p)).rows[0];

    // A real user to hang ownership off — whoever exists.
    const user = await one(`SELECT id FROM users ORDER BY id LIMIT 1`);
    const statusTodo = await one(`SELECT id FROM tt_task_statuses WHERE kind='todo' LIMIT 1`);
    const statusDone = await one(`SELECT id FROM tt_task_statuses WHERE kind='done' LIMIT 1`);
    const pStatus = await one(`SELECT id FROM tt_project_statuses ORDER BY sort_order LIMIT 1`);

    t("seed: a todo task status exists", !!statusTodo);
    t("seed: a done task status exists", !!statusDone);
    t("seed: a project status exists", !!pStatus);

    const project = await one(
      `INSERT INTO tt_projects (name, status_id, owner_id, areas, brands)
       VALUES ('TEST project', $1, $2, ARRAY['marketing'], ARRAY['mfl']) RETURNING id`,
      [pStatus.id, user.id],
    );
    const task = await one(
      `INSERT INTO tt_tasks (project_id, status_id, title, owner_id, due_date)
       VALUES ($1, $2, 'TEST task', $3, '2026-08-01') RETURNING id, status_changed_at, completed_at`,
      [project.id, statusTodo.id, user.id],
    );

    t("a new task has no completed_at", task.completed_at === null);
    t("a new task has a status_changed_at stamp", !!task.status_changed_at);

    // ── Arrays round-trip ────────────────────────────────────────────────────
    const arr = await one(`SELECT areas, brands FROM tt_projects WHERE id=$1`, [project.id]);
    t("areas array round-trips", JSON.stringify(arr.areas) === JSON.stringify(["marketing"]));
    t("brands array round-trips", JSON.stringify(arr.brands) === JSON.stringify(["mfl"]));

    // ── Dates come back as bare dates, never shifted ─────────────────────────
    const d = await one(`SELECT due_date::text AS due FROM tt_tasks WHERE id=$1`, [task.id]);
    t("due_date stays 2026-08-01 (no timezone shift)", d.due === "2026-08-01", `got ${d.due}`);

    // ── A helper cannot be added twice ───────────────────────────────────────
    await c.query(`INSERT INTO tt_task_assignees (task_id, user_id) VALUES ($1,$2)`, [task.id, user.id]);
    let dupBlocked = false;
    await c.query("SAVEPOINT sp1");
    try {
      await c.query(`INSERT INTO tt_task_assignees (task_id, user_id) VALUES ($1,$2)`, [task.id, user.id]);
      await c.query("RELEASE SAVEPOINT sp1");
    } catch {
      dupBlocked = true;
      await c.query("ROLLBACK TO SAVEPOINT sp1");
    }
    t("the same person cannot be added to a task twice", dupBlocked);

    // ── A status column in use cannot be deleted ─────────────────────────────
    let statusProtected = false;
    await c.query("SAVEPOINT sp2");
    try {
      await c.query(`DELETE FROM tt_task_statuses WHERE id=$1`, [statusTodo.id]);
      await c.query("RELEASE SAVEPOINT sp2");
    } catch {
      statusProtected = true;
      await c.query("ROLLBACK TO SAVEPOINT sp2");
    }
    t("a status column still holding tasks cannot be deleted (RESTRICT)", statusProtected);

    // ── 🔴 The big one: deleting a project must NOT destroy tasks ────────────
    await c.query(`DELETE FROM tt_projects WHERE id=$1`, [project.id]);
    const survivor = await one(`SELECT id, project_id FROM tt_tasks WHERE id=$1`, [task.id]);
    t("deleting a project does NOT delete its tasks", !!survivor);
    t("the orphaned task falls to project_id NULL, not oblivion", survivor?.project_id === null);

    // ── Checklist + comments cascade WITH their task (they are part of it) ───
    const t2 = await one(
      `INSERT INTO tt_tasks (status_id, title) VALUES ($1,'TEST cascade') RETURNING id`, [statusTodo.id]);
    await c.query(`INSERT INTO tt_checklist_items (task_id, title) VALUES ($1,'step')`, [t2.id]);
    await c.query(`INSERT INTO tt_comments (task_id, body) VALUES ($1,'note')`, [t2.id]);
    await c.query(`DELETE FROM tt_tasks WHERE id=$1`, [t2.id]);
    const leftovers = await one(
      `SELECT (SELECT count(*) FROM tt_checklist_items WHERE task_id=$1)
            + (SELECT count(*) FROM tt_comments WHERE task_id=$1) AS n`, [t2.id]);
    t("a deleted task takes its checklist and comments with it", Number(leftovers.n) === 0);

    // ── RLS is on for every table ────────────────────────────────────────────
    const { rows: rls } = await c.query(
      // relkind='r' = ordinary TABLES only. Without it this also sweeps up
      // every index and sequence, none of which carry RLS, and the check
      // fails for a reason that has nothing to do with security.
      `SELECT c.relname, c.relrowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'tt\\_%'`);
    t(`RLS is ON for all ${rls.length} tt_ tables`,
      rls.length === 8 && rls.every((r: any) => r.relrowsecurity),
      rls.filter((r: any) => !r.relrowsecurity).map((r: any) => r.relname).join(", "));

    // ── The unique area key only applies to LIVE areas ───────────────────────
    await c.query(`UPDATE tt_areas SET archived=true WHERE key='marketing'`);
    const reuse = await c.query(
      `INSERT INTO tt_areas (key,label) VALUES ('marketing','Marketing again') RETURNING id`);
    t("an archived area's key can be reused by a new live one", reuse.rowCount === 1);
  } catch (err) {
    fail++;
    console.log("  ✗ threw:", (err as Error).message);
  } finally {
    await c.query("ROLLBACK");
    await c.end();
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed  (all changes rolled back)`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
