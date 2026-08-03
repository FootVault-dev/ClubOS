/**
 * Pure-logic tests for the Task Tracker.
 *
 *   npx tsx script/test-task-tracker.ts
 *
 * No database, no network. These cover the maths that quietly goes wrong:
 * date handling across the NZ/UTC boundary, derived overdue/stale state,
 * progress rollups, week bucketing, and the access rules.
 */
import {
  nzToday, daysBetween, addDays, isoWeekday,
  isOverdue, isDueToday, isDone, isStale, dueBucket,
  progressOf, compareTasks, cleanDate, cleanKeyList, cleanText,
  isPriority, isStatusKind, isProjectKind,
  canEditTask, canDeleteTask, canEditStructure,
  brandKeyForOrgSlug, STALE_AFTER_DAYS,
} from "../shared/task-tracker";

let pass = 0, fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log(`  ✗ ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
};
const section = (s: string) => console.log(`\n${s}`);

// ── Dates ────────────────────────────────────────────────────────────────────
section("Dates");

// The trap this whole codebase keeps hitting: midnight UTC is the PREVIOUS day
// in New Zealand. nzToday must return the NZ calendar date, not the UTC one.
t("nzToday at 11:00 UTC → next NZ day", nzToday(new Date("2026-08-02T11:00:00Z")), "2026-08-02");
t("nzToday at 13:00 UTC → NZ has ticked over", nzToday(new Date("2026-08-02T13:00:00Z")), "2026-08-03");
t("nzToday at 23:59 UTC", nzToday(new Date("2026-08-02T23:59:00Z")), "2026-08-03");

t("daysBetween same day", daysBetween("2026-08-03", "2026-08-03"), 0);
t("daysBetween forward", daysBetween("2026-08-03", "2026-08-10"), 7);
t("daysBetween backward", daysBetween("2026-08-10", "2026-08-03"), -7);
t("daysBetween across month end", daysBetween("2026-07-31", "2026-08-01"), 1);
t("daysBetween across year end", daysBetween("2026-12-31", "2027-01-01"), 1);
t("daysBetween across a leap day", daysBetween("2028-02-28", "2028-03-01"), 2);

t("addDays simple", addDays("2026-08-03", 5), "2026-08-08");
t("addDays over month end", addDays("2026-08-30", 3), "2026-09-02");
t("addDays negative", addDays("2026-08-01", -1), "2026-07-31");

// Monday = 1 … Sunday = 7. 2026-08-03 is a Monday.
t("isoWeekday Monday", isoWeekday("2026-08-03"), 1);
t("isoWeekday Sunday", isoWeekday("2026-08-09"), 7);
t("isoWeekday Saturday", isoWeekday("2026-08-08"), 6);

// ── Derived state ────────────────────────────────────────────────────────────
section("Overdue / done");

const TODAY = "2026-08-05"; // a Wednesday

t("overdue when due yesterday and not done",
  isOverdue({ dueDate: "2026-08-04", statusKind: "active" }, TODAY), true);
t("not overdue when due today",
  isOverdue({ dueDate: TODAY, statusKind: "active" }, TODAY), false);
t("not overdue when due tomorrow",
  isOverdue({ dueDate: "2026-08-06", statusKind: "active" }, TODAY), false);
t("a DONE task is never overdue, however late",
  isOverdue({ dueDate: "2026-01-01", statusKind: "done" }, TODAY), false);
t("no due date is never overdue",
  isOverdue({ dueDate: null, statusKind: "active" }, TODAY), false);
t("a BLOCKED task still goes overdue — blocked is not an excuse",
  isOverdue({ dueDate: "2026-08-01", statusKind: "blocked" }, TODAY), true);

t("isDueToday", isDueToday({ dueDate: TODAY, statusKind: "todo" }, TODAY), true);
t("isDueToday ignores done", isDueToday({ dueDate: TODAY, statusKind: "done" }, TODAY), false);
t("isDone keys on kind not label", isDone("done"), true);
t("isDone false for blocked", isDone("blocked"), false);

section("Due buckets");
// Week runs to Sunday. From Wednesday 5 Aug, "this week" reaches Sunday 9 Aug.
t("overdue bucket", dueBucket({ dueDate: "2026-08-01", statusKind: "active" }, TODAY), "overdue");
t("today bucket", dueBucket({ dueDate: TODAY, statusKind: "active" }, TODAY), "today");
t("Friday is this week", dueBucket({ dueDate: "2026-08-07", statusKind: "active" }, TODAY), "this_week");
t("Sunday is still this week", dueBucket({ dueDate: "2026-08-09", statusKind: "active" }, TODAY), "this_week");
t("Monday is upcoming, not this week", dueBucket({ dueDate: "2026-08-10", statusKind: "active" }, TODAY), "upcoming");
t("no date → someday", dueBucket({ dueDate: null, statusKind: "active" }, TODAY), "someday");

section("Staleness");
const daysAgo = (n: number) => addDays(TODAY, -n);
t("fresh active task is not stale",
  isStale({ statusKind: "active", updatedAt: daysAgo(2) }, TODAY), false);
t(`active and untouched for ${STALE_AFTER_DAYS} days IS stale`,
  isStale({ statusKind: "active", updatedAt: daysAgo(STALE_AFTER_DAYS) }, TODAY), true);
t("blocked and untouched is stale too",
  isStale({ statusKind: "blocked", updatedAt: daysAgo(30) }, TODAY), true);
t("a DONE task is never stale",
  isStale({ statusKind: "done", updatedAt: daysAgo(90) }, TODAY), false);
t("a TODO task is not stale — it has not been started, that is different",
  isStale({ statusKind: "todo", updatedAt: daysAgo(90) }, TODAY), false);

// ── Progress ─────────────────────────────────────────────────────────────────
section("Progress");
t("empty project is 0/0 and NOT complete",
  progressOf([]), { done: 0, total: 0, percent: 0, complete: false });
t("half done is not complete",
  progressOf([{ statusKind: "done" }, { statusKind: "todo" }]),
  { done: 1, total: 2, percent: 50, complete: false });
t("all done is complete",
  progressOf([{ statusKind: "done" }, { statusKind: "done" }]),
  { done: 2, total: 2, percent: 100, complete: true });
t("blocked counts as not done",
  progressOf([{ statusKind: "blocked" }, { statusKind: "done" }]),
  { done: 1, total: 2, percent: 50, complete: false });
t("rounds to a whole percent",
  progressOf([{ statusKind: "done" }, { statusKind: "todo" }, { statusKind: "todo" }]).percent, 33);

// ── Sorting ──────────────────────────────────────────────────────────────────
section("Sorting");
const sorted = [
  { title: "no date low", dueDate: null, priority: "low", sortOrder: 0 },
  { title: "later", dueDate: "2026-08-20", priority: "urgent", sortOrder: 0 },
  { title: "soonest", dueDate: "2026-08-04", priority: "low", sortOrder: 0 },
].sort(compareTasks).map((x: any) => x.title);
t("dated before undated, earliest first", sorted, ["soonest", "later", "no date low"]);

const byPriority = [
  { title: "low", dueDate: "2026-08-10", priority: "low", sortOrder: 0 },
  { title: "urgent", dueDate: "2026-08-10", priority: "urgent", sortOrder: 0 },
].sort(compareTasks).map((x: any) => x.title);
t("same date falls back to priority", byPriority, ["urgent", "low"]);

// ── Validators ───────────────────────────────────────────────────────────────
section("Validators");
t("cleanDate accepts a bare date", cleanDate("2026-08-03"), "2026-08-03");
t("cleanDate REFUSES a timestamp rather than truncating", cleanDate("2026-08-03T12:00:00Z"), null);
t("cleanDate empty → null", cleanDate(""), null);
t("cleanDate rubbish → null", cleanDate("tomorrow"), null);
t("cleanText trims", cleanText("  hi  "), "hi");
t("cleanText blank → null", cleanText("   "), null);
t("cleanKeyList dedupes and trims", cleanKeyList([" a", "a", "b"]), ["a", "b"]);
t("cleanKeyList drops non-strings", cleanKeyList(["a", 3, null]), ["a"]);
t("cleanKeyList enforces an allow-list", cleanKeyList(["cufc", "nope"], ["cufc", "siu"]), ["cufc"]);
t("cleanKeyList on a non-array", cleanKeyList("cufc"), []);
t("isPriority", [isPriority("urgent"), isPriority("later")], [true, false]);
t("isStatusKind includes blocked", isStatusKind("blocked"), true);
t("isProjectKind", [isProjectKind("goal"), isProjectKind("epic")], [true, false]);

// ── Access ───────────────────────────────────────────────────────────────────
section("Access");
const staff = { userId: 7, isManager: false };
const manager = { userId: 99, isManager: true };

t("owner can edit their task", canEditTask(staff, { ownerId: 7 }), true);
t("helper can edit", canEditTask(staff, { ownerId: 1, assigneeIds: [7] }), true);
t("creator can edit", canEditTask(staff, { ownerId: 1, createdBy: 7 }), true);
t("an unrelated staff member cannot edit", canEditTask(staff, { ownerId: 1, createdBy: 2 }), false);
t("a manager can edit anything", canEditTask(manager, { ownerId: 1, createdBy: 2 }), true);

t("owner alone cannot DELETE — deleting is narrower", canDeleteTask(staff, { ownerId: 7, createdBy: 2 }), false);
t("creator can delete", canDeleteTask(staff, { createdBy: 7 }), true);
t("manager can delete", canDeleteTask(manager, { createdBy: 2 }), true);

t("structure is managers only", [canEditStructure(staff), canEditStructure(manager)], [false, true]);

// ── Brand mapping ────────────────────────────────────────────────────────────
section("Brand mapping");
t("CUFC workspace → cufc", brandKeyForOrgSlug("christchurch-united"), "cufc");
t("prints workspace → prints", brandKeyForOrgSlug("united-prints"), "prints");
t("group workspace has no single brand", brandKeyForOrgSlug("united-sports-group"), null);
t("unknown slug → null", brandKeyForOrgSlug("nope"), null);
t("null slug → null", brandKeyForOrgSlug(null), null);

// ── Result ───────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
