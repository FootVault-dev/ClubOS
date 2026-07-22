// Pure-logic tests for shared/management.ts. Run: npx tsx script/test-management.ts
//
// Covers the traps this build must never fall into: the NZ/UTC day-boundary
// bug (a date-only string round-tripped through a Date reads a day early in
// NZ), the inclusive-end-date rule (a same-day task is ONE day, never zero),
// dependency cycles (a Gantt with a cycle can't be drawn honestly), and
// overdue/due-bucket derivation keyed on status KIND — never on a label.
import assert from "node:assert/strict";
import {
  PROJECT_STATUSES, STATUS_KINDS, TASK_PRIORITIES, DEFAULT_STATUSES, PROJECT_COLORS,
  isProjectStatus, isStatusKind, isTaskPriority,
  isIsoDate, nzTodayIso, addDaysIso, daysBetween,
  taskBarRange, isOverdue, dueBucket, wouldCreateCycle,
} from "../shared/management";

let passed = 0;
function ok(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e: any) { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// ── Vocabularies ─────────────────────────────────────────────────────────────
ok("project statuses", () => assert.deepEqual([...PROJECT_STATUSES], ["active", "completed", "archived"]));
ok("status kinds", () => assert.deepEqual([...STATUS_KINDS], ["todo", "active", "done"]));
ok("priorities", () => assert.deepEqual([...TASK_PRIORITIES], ["low", "medium", "high", "urgent"]));
ok("isProjectStatus", () => { assert.equal(isProjectStatus("active"), true); assert.equal(isProjectStatus("deleted"), false); });
ok("isStatusKind", () => { assert.equal(isStatusKind("done"), true); assert.equal(isStatusKind("finished"), false); });
ok("isTaskPriority", () => { assert.equal(isTaskPriority("urgent"), true); assert.equal(isTaskPriority("critical"), false); });
ok("default statuses seed a full workflow", () => {
  assert.equal(DEFAULT_STATUSES.length, 3);
  assert.deepEqual(DEFAULT_STATUSES.map((d) => d.kind), ["todo", "active", "done"]);
});
ok("project colour wheel is non-empty hexes", () => {
  assert.ok(PROJECT_COLORS.length >= 8);
  for (const c of PROJECT_COLORS) assert.match(c, /^#[0-9a-f]{6}$/i);
});

// ── Dates ────────────────────────────────────────────────────────────────────
ok("isIsoDate accepts a calendar date", () => assert.equal(isIsoDate("2026-07-22"), true));
ok("isIsoDate rejects a timestamp", () => assert.equal(isIsoDate("2026-07-22T00:00:00Z"), false));
ok("isIsoDate rejects an impossible date", () => assert.equal(isIsoDate("2026-02-30"), false));
ok("isIsoDate rejects garbage", () => { assert.equal(isIsoDate("nope"), false); assert.equal(isIsoDate(""), false); });

ok("nzTodayIso reads TOMORROW's NZ date from a late-UTC instant", () =>
  assert.equal(nzTodayIso(new Date("2026-07-17T23:00:00Z")), "2026-07-18"));
ok("nzTodayIso early UTC is still the same NZ day", () =>
  assert.equal(nzTodayIso(new Date("2026-07-17T02:00:00Z")), "2026-07-17"));

ok("addDaysIso forward", () => assert.equal(addDaysIso("2026-07-22", 10), "2026-08-01"));
ok("addDaysIso backward", () => assert.equal(addDaysIso("2026-07-01", -1), "2026-06-30"));
ok("addDaysIso across a leap February", () => assert.equal(addDaysIso("2028-02-28", 1), "2028-02-29"));
ok("addDaysIso across a NZ DST boundary stays whole-day", () =>
  // NZ clocks go back 2026-04-05; UTC-noon anchoring must not produce a dupe/skip.
  assert.equal(addDaysIso("2026-04-04", 2), "2026-04-06"));
ok("daysBetween forward", () => assert.equal(daysBetween("2026-07-01", "2026-07-22"), 21));
ok("daysBetween backward is negative", () => assert.equal(daysBetween("2026-07-22", "2026-07-01"), -21));
ok("daysBetween across DST is exact", () => assert.equal(daysBetween("2026-04-01", "2026-04-10"), 9));

// ── taskBarRange (the Gantt bar) ─────────────────────────────────────────────
ok("both dates → the span", () =>
  assert.deepEqual(taskBarRange({ startDate: "2026-07-01", dueDate: "2026-07-05" }), { start: "2026-07-01", end: "2026-07-05" }));
ok("same-day task is a ONE-day bar, not zero", () => {
  const r = taskBarRange({ startDate: "2026-07-01", dueDate: "2026-07-01" })!;
  assert.equal(daysBetween(r.start, r.end) + 1, 1);
});
ok("due only → one-day bar at due", () =>
  assert.deepEqual(taskBarRange({ startDate: null, dueDate: "2026-07-09" }), { start: "2026-07-09", end: "2026-07-09" }));
ok("start only → one-day bar at start", () =>
  assert.deepEqual(taskBarRange({ startDate: "2026-07-09", dueDate: null }), { start: "2026-07-09", end: "2026-07-09" }));
ok("no dates → no bar (unscheduled tray, never a fake date)", () =>
  assert.equal(taskBarRange({ startDate: null, dueDate: null }), null));
ok("inverted dates normalise rather than render negative", () =>
  assert.deepEqual(taskBarRange({ startDate: "2026-07-05", dueDate: "2026-07-01" }), { start: "2026-07-01", end: "2026-07-05" }));

// ── isOverdue / dueBucket (keyed on KIND, never a label) ─────────────────────
const T = "2026-07-22";
ok("past due + not done = overdue", () =>
  assert.equal(isOverdue({ startDate: null, dueDate: "2026-07-20" }, "active", T), true));
ok("past due + done-kind = NOT overdue (done late is done)", () =>
  assert.equal(isOverdue({ startDate: null, dueDate: "2026-07-20" }, "done", T), false));
ok("due today is not overdue", () =>
  assert.equal(isOverdue({ startDate: null, dueDate: T }, "todo", T), false));
ok("no due date can never be overdue", () =>
  assert.equal(isOverdue({ startDate: "2026-01-01", dueDate: null }, "todo", T), false));

ok("bucket: overdue", () => assert.equal(dueBucket({ startDate: null, dueDate: "2026-07-01" }, "todo", T), "overdue"));
ok("bucket: today", () => assert.equal(dueBucket({ startDate: null, dueDate: T }, "todo", T), "today"));
ok("bucket: this_week covers the next 7 days", () =>
  assert.equal(dueBucket({ startDate: null, dueDate: addDaysIso(T, 7) }, "todo", T), "this_week"));
ok("bucket: later beyond 7 days", () =>
  assert.equal(dueBucket({ startDate: null, dueDate: addDaysIso(T, 8) }, "todo", T), "later"));
ok("bucket: unscheduled", () => assert.equal(dueBucket({ startDate: null, dueDate: null }, "todo", T), "unscheduled"));
ok("bucket: a done task past due is NOT overdue-bucketed", () =>
  assert.notEqual(dueBucket({ startDate: null, dueDate: "2026-07-01" }, "done", T), "overdue"));

// ── wouldCreateCycle ─────────────────────────────────────────────────────────
const E = (p: number, s: number) => ({ predecessorId: p, successorId: s });
ok("self-loop is a cycle", () => assert.equal(wouldCreateCycle([], 1, 1), true));
ok("fresh edge on empty graph is fine", () => assert.equal(wouldCreateCycle([], 1, 2), false));
ok("direct back-edge is a cycle", () => assert.equal(wouldCreateCycle([E(1, 2)], 2, 1), true));
ok("transitive back-edge is a cycle (1→2→3, adding 3→1)", () =>
  assert.equal(wouldCreateCycle([E(1, 2), E(2, 3)], 3, 1), true));
ok("long chain back-edge is a cycle", () =>
  assert.equal(wouldCreateCycle([E(1, 2), E(2, 3), E(3, 4), E(4, 5)], 5, 1), true));
ok("diamond (1→2, 1→3, 2→4, 3→4) is NOT a cycle", () =>
  assert.equal(wouldCreateCycle([E(1, 2), E(1, 3), E(2, 4)], 3, 4), false));
ok("parallel edge direction matters (2→1 exists, adding 2→1 again is not a cycle by this check)", () =>
  assert.equal(wouldCreateCycle([E(2, 1)], 2, 1), false)); // duplicate is stopped by the UNIQUE, not the cycle walk
ok("disconnected components never cycle", () =>
  assert.equal(wouldCreateCycle([E(1, 2), E(3, 4)], 2, 3), false));

console.log(`\n${passed} passed${process.exitCode ? " — WITH FAILURES" : ", 0 failed"}`);
