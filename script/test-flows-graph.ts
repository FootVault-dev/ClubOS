// Flow-graph unit tests — plain tsx + node assert (same pattern as
// script/test-predictor-scoring.ts). No DB: exercises only the pure graph-walk /
// delay / quiet-hours / merge-tag / re-entry logic in server/marketing/flow-graph.ts.
// Run: npx tsx script/test-flows-graph.ts
import assert from "node:assert";
// The runtime (flows.ts) imports the DB; its pure decision logic is factored into
// flow-graph.ts precisely so it can be unit-tested with no database or env.
import {
  normalizeGraph, entryStepId, getStep, isMessageStep, resolveNext,
  delayToMs, scheduleForStep, renderMergeTags, reEntryPolicy,
  type FlowStep, type FlowGraph,
} from "../server/marketing/flow-graph";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const step = (id: string, type: any, extra: Partial<FlowStep> = {}): FlowStep => ({ id, type, config: {}, next: null, ...extra });

const graph: FlowGraph = {
  entry: "a",
  steps: [
    step("a", "delay", { config: { value: 1, unit: "hours" }, next: "b" }),
    step("b", "email", { config: { subject: "hi" }, next: "c" }),
    step("c", "condition", { next: "d", nextIfFalse: null }),
    step("d", "exit"),
  ],
};

console.log("flows-graph");

// ── normalizeGraph ──
test("normalizeGraph tolerates garbage", () => {
  const g = normalizeGraph(null as any);
  assert.deepStrictEqual(g.steps, []);
  assert.strictEqual(g.entry, null);
});
test("normalizeGraph defaults entry to first step", () => {
  const g = normalizeGraph({ steps: [{ id: "x", type: "delay", config: {}, next: null }] });
  assert.strictEqual(g.entry, "x");
});
test("normalizeGraph drops non-object / id-less steps", () => {
  const g = normalizeGraph({ steps: [null, { type: "email" }, { id: "ok", type: "email", config: {}, next: null }] });
  assert.strictEqual(g.steps.length, 1);
  assert.strictEqual(g.steps[0].id, "ok");
});

// ── entryStepId / getStep ──
test("entryStepId honours explicit entry", () => assert.strictEqual(entryStepId(graph), "a"));
test("entryStepId falls back to first step", () => assert.strictEqual(entryStepId({ steps: graph.steps }), "a"));
test("entryStepId null on empty graph", () => assert.strictEqual(entryStepId({ steps: [] }), null));
test("getStep finds by id", () => assert.strictEqual(getStep(graph, "b")?.type, "email"));
test("getStep undefined for missing", () => assert.strictEqual(getStep(graph, "zzz"), undefined));

// ── isMessageStep ──
test("email + sms are message steps", () => {
  assert.strictEqual(isMessageStep(step("m", "email")), true);
  assert.strictEqual(isMessageStep(step("m", "sms")), true);
});
test("delay / undefined are not message steps", () => {
  assert.strictEqual(isMessageStep(step("m", "delay")), false);
  assert.strictEqual(isMessageStep(undefined), false);
});

// ── resolveNext (branching) ──
test("non-condition step ignores branch", () => {
  assert.strictEqual(resolveNext(step("x", "email", { next: "y" }), false), "y");
  assert.strictEqual(resolveNext(step("x", "email", { next: "y" }), true), "y");
});
test("condition true → next", () => assert.strictEqual(resolveNext(getStep(graph, "c")!, true), "d"));
test("condition false with explicit null → exit (null)", () => assert.strictEqual(resolveNext(getStep(graph, "c")!, false), null));
test("condition false WITHOUT nextIfFalse falls back to next", () => {
  const s: FlowStep = { id: "c2", type: "condition", config: {}, next: "z" }; // no nextIfFalse key
  assert.strictEqual(resolveNext(s, false), "z");
});
test("condition false with a real false branch", () => {
  const s: FlowStep = { id: "c3", type: "condition", config: {}, next: "t", nextIfFalse: "f" };
  assert.strictEqual(resolveNext(s, false), "f");
});

// ── delayToMs ──
test("delay minutes/hours/days", () => {
  assert.strictEqual(delayToMs({ value: 30, unit: "minutes" }), 30 * 60_000);
  assert.strictEqual(delayToMs({ value: 2, unit: "hours" }), 2 * 3_600_000);
  assert.strictEqual(delayToMs({ value: 1, unit: "days" }), 86_400_000);
});
test("delay unknown unit → hours; negative/garbage → 0", () => {
  assert.strictEqual(delayToMs({ value: 1, unit: "weeks" as any }), 3_600_000);
  assert.strictEqual(delayToMs({ value: -5, unit: "hours" }), 0);
  assert.strictEqual(delayToMs(undefined), 0);
});

// ── scheduleForStep (quiet hours 20:00–08:00 NZ, DST-safe) ──
// July = NZST (UTC+12, no DST). 09:00Z = 21:00 NZ (quiet) → next 08:00 NZ = 20:00Z.
const evening = new Date("2026-07-15T09:00:00.000Z");
const predawn = new Date("2026-07-15T18:00:00.000Z"); // 06:00 NZ next day (quiet)
const daytime = new Date("2026-07-15T02:00:00.000Z"); // 14:00 NZ (sendable)
test("message in evening quiet hours bumps to next 08:00 NZ", () => {
  assert.strictEqual(scheduleForStep(evening, true).toISOString(), "2026-07-15T20:00:00.000Z");
});
test("message in pre-dawn quiet hours bumps to 08:00 NZ same day", () => {
  assert.strictEqual(scheduleForStep(predawn, true).toISOString(), "2026-07-15T20:00:00.000Z");
});
test("message in daytime is unchanged", () => {
  assert.strictEqual(scheduleForStep(daytime, true).getTime(), daytime.getTime());
});
test("non-message step never deferred, even in quiet hours", () => {
  assert.strictEqual(scheduleForStep(evening, false).getTime(), evening.getTime());
});

// ── renderMergeTags ──
test("renders known tags, blanks unknown, case-insensitive", () => {
  const ctx = { first_name: "Sam", last_name: "Lee", email: "s@x.com", unsubscribe_url: "U", preferences_url: "P" };
  assert.strictEqual(renderMergeTags("Hi {{first_name}} {{ LAST_NAME }} {{mystery}}!", ctx), "Hi Sam Lee !");
  assert.strictEqual(renderMergeTags(null, ctx), "");
});

// ── reEntryPolicy ──
test("reEntryPolicy reads trigger_config override", () => {
  assert.strictEqual(reEntryPolicy({ reEntry: false, triggerConfig: { reEntry: "after_exit" } }), "after_exit");
  assert.strictEqual(reEntryPolicy({ reEntry: false, triggerConfig: { reEntry: "always" } }), "always");
});
test("reEntryPolicy falls back to boolean column", () => {
  assert.strictEqual(reEntryPolicy({ reEntry: true, triggerConfig: {} }), "always");
  assert.strictEqual(reEntryPolicy({ reEntry: false, triggerConfig: {} }), "never");
  assert.strictEqual(reEntryPolicy({}), "never");
});

console.log(`\n${passed} passed`);
