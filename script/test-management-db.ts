// DB-invariant tests for the plan_* tables — run against the real database
// INSIDE one transaction that is always rolled back, so nothing persists.
// Complements script/test-management.ts (pure logic): this file proves the
// constraints the schema claims to enforce actually fire on the live DB.
//
//   npx tsx script/test-management-db.ts
import "dotenv/config";
import assert from "node:assert/strict";
import pg from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  let passed = 0;
  const ok = (name: string) => { passed++; console.log(`  ok  ${name}`); };
  const fail = (name: string, e: any) => { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; };

  // Savepoint helper: expected-to-fail statements must not poison the outer tx.
  async function expectReject(name: string, sql: string, params: any[] = []) {
    await client.query("SAVEPOINT sp");
    try {
      await client.query(sql, params);
      fail(name, new Error("statement was ACCEPTED but must be rejected"));
    } catch {
      ok(name);
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT sp");
    }
  }

  try {
    await client.query("BEGIN");

    // Use the real United Prints org so the FK is honest, but everything is
    // rolled back at the end.
    const orgRes = await client.query("SELECT id FROM organizations WHERE slug = 'united-prints'");
    assert.equal(orgRes.rows.length, 1, "united-prints org exists");
    const org = orgRes.rows[0].id;
    ok(`united-prints org resolved (id ${org})`);

    // project + default columns
    const proj = (await client.query(
      "INSERT INTO plan_projects (organization_id, name, color) VALUES ($1, '__test project', '#6366f1') RETURNING id", [org])).rows[0].id;
    const stTodo = (await client.query(
      "INSERT INTO plan_statuses (organization_id, project_id, label, kind, sort_order) VALUES ($1,$2,'To do','todo',0) RETURNING id", [org, proj])).rows[0].id;
    const stDone = (await client.query(
      "INSERT INTO plan_statuses (organization_id, project_id, label, kind, sort_order) VALUES ($1,$2,'Done','done',2) RETURNING id", [org, proj])).rows[0].id;
    ok("project + status columns insert");

    // task
    const task = (await client.query(
      "INSERT INTO plan_tasks (organization_id, project_id, status_id, title, start_date, due_date) VALUES ($1,$2,$3,'__test task','2026-08-01','2026-08-05') RETURNING id", [org, proj, stTodo])).rows[0].id;
    const task2 = (await client.query(
      "INSERT INTO plan_tasks (organization_id, project_id, status_id, title) VALUES ($1,$2,$3,'__test task 2') RETURNING id", [org, proj, stTodo])).rows[0].id;
    ok("tasks insert (dated + undated)");

    // date columns round-trip as bare dates
    const dates = (await client.query("SELECT start_date::text AS s, due_date::text AS d FROM plan_tasks WHERE id = $1", [task])).rows[0];
    assert.equal(dates.s, "2026-08-01"); assert.equal(dates.d, "2026-08-05");
    ok("date columns round-trip as YYYY-MM-DD text");

    // progress guard
    await expectReject("progress > 100 rejected",
      "UPDATE plan_tasks SET progress = 101 WHERE id = $1", [task]);
    await expectReject("negative progress rejected",
      "UPDATE plan_tasks SET progress = -1 WHERE id = $1", [task]);
    await client.query("UPDATE plan_tasks SET progress = 55 WHERE id = $1", [task]);
    ok("valid progress accepted");

    // dependency guards
    await client.query("INSERT INTO plan_task_deps (organization_id, predecessor_id, successor_id) VALUES ($1,$2,$3)", [org, task, task2]);
    ok("dependency edge inserts");
    await expectReject("self-dependency rejected by CHECK",
      "INSERT INTO plan_task_deps (organization_id, predecessor_id, successor_id) VALUES ($1,$2,$2)", [org, task]);
    await expectReject("duplicate edge rejected by UNIQUE",
      "INSERT INTO plan_task_deps (organization_id, predecessor_id, successor_id) VALUES ($1,$2,$3)", [org, task, task2]);

    // a column with tasks cannot be deleted out from under them
    await expectReject("status with tasks is RESTRICTed from deletion",
      "DELETE FROM plan_statuses WHERE id = $1", [stTodo]);

    // checklist + comment cascade with the task
    await client.query("INSERT INTO plan_checklist_items (organization_id, task_id, title) VALUES ($1,$2,'__step')", [org, task]);
    await client.query("INSERT INTO plan_comments (organization_id, task_id, body) VALUES ($1,$2,'__note')", [org, task]);
    await client.query("DELETE FROM plan_tasks WHERE id = $1", [task]);
    const orphans = await client.query(
      "SELECT (SELECT count(*) FROM plan_checklist_items WHERE task_id = $1) AS c, (SELECT count(*) FROM plan_comments WHERE task_id = $1) AS m, (SELECT count(*) FROM plan_task_deps WHERE predecessor_id = $1 OR successor_id = $1) AS d", [task]);
    assert.equal(Number(orphans.rows[0].c), 0);
    assert.equal(Number(orphans.rows[0].m), 0);
    assert.equal(Number(orphans.rows[0].d), 0);
    ok("deleting a task cascades checklist, comments and dep edges");

    // deleting the project cascades statuses + remaining tasks
    await client.query("DELETE FROM plan_projects WHERE id = $1", [proj]);
    const left = await client.query(
      "SELECT (SELECT count(*) FROM plan_statuses WHERE project_id = $1) AS s, (SELECT count(*) FROM plan_tasks WHERE project_id = $1) AS t", [proj]);
    assert.equal(Number(left.rows[0].s), 0);
    assert.equal(Number(left.rows[0].t), 0);
    ok("deleting a project cascades its columns and tasks");
  } catch (e: any) {
    fail("unexpected", e);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }

  console.log(`\n${passed} passed${process.exitCode ? " — WITH FAILURES" : ", 0 failed"} (all rolled back — DB unchanged)`);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
