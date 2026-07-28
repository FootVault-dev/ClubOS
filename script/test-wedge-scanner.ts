// Tests for the keyboard-wedge barcode-scanner detector.
// Run: npx tsx script/test-wedge-scanner.ts   (exits non-zero on failure)
//
// The whole feature rests on one judgement — is this burst of keystrokes a
// scanner or a person? Get it wrong in one direction and Dima's scanner does
// nothing; get it wrong in the other and the page eats what someone typed.

import assert from "node:assert/strict";
import {
  feedWedgeKey, shouldIgnoreWedgeTarget, EMPTY_WEDGE, MAX_KEY_GAP_MS, MIN_CODE_LENGTH,
  type WedgeState,
} from "../client/src/lib/wedge-scanner";

let passed = 0;
function ok(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e: any) { console.error(`FAIL: ${name}\n  ${e.stack || e.message}`); process.exitCode = 1; }
}

/** Types a string at a fixed inter-key gap and returns the final result. */
function type(code: string, gapMs: number, opts: { enter?: boolean; enterGapMs?: number } = {}) {
  let state: WedgeState = EMPTY_WEDGE;
  let at = 1_000_000;
  let last: ReturnType<typeof feedWedgeKey> = { kind: "buffering", state };
  for (const ch of code) {
    at += gapMs;
    last = feedWedgeKey(state, { key: ch, at });
    state = last.state;
  }
  if (opts.enter !== false) {
    at += opts.enterGapMs ?? gapMs;
    last = feedWedgeKey(state, { key: "Enter", at });
  }
  return last;
}

// ── The scanner case ─────────────────────────────────────────────────────────

ok("a fast burst ending in Enter is a scan", () => {
  const r = type("9421023610112", 8);
  assert.equal(r.kind, "scan");
  if (r.kind === "scan") assert.equal(r.code, "9421023610112");
});

ok("a scan resets the buffer so the next one starts clean", () => {
  const r = type("MFL-SHIRT-BLU-M", 10);
  assert.equal(r.kind, "scan");
  assert.deepEqual(r.state, EMPTY_WEDGE);
});

ok("our own SKU and asset-tag formats scan", () => {
  for (const code of ["MFL-SHIRT-BLU-M", "AST:UP-PRESS-A3-001", "LOC:A-01-2", "UP-PRESS-A3-001"]) {
    const r = type(code, 12);
    assert.equal(r.kind, "scan", `${code} should scan`);
    if (r.kind === "scan") assert.equal(r.code, code);
  }
});

ok("a slow Bluetooth scanner still counts, right up to the gap limit", () => {
  const r = type("5012345678900", MAX_KEY_GAP_MS);
  assert.equal(r.kind, "scan");
});

// ── The human case — must NEVER be swallowed ─────────────────────────────────

ok("normal typing is NOT a scan", () => {
  // ~120ms between keys is comfortable human typing.
  const r = type("hello", 120);
  assert.equal(r.kind, "discard");
});

ok("typing fast but pausing before Enter is NOT a scan", () => {
  // The classic false positive: someone types quickly, then thinks, then hits
  // Enter. The final gap is what gives them away.
  const r = type("A1B2C3", 20, { enterGapMs: 900 });
  assert.equal(r.kind, "discard", "a considered Enter means a human");
});

ok("a bare Enter on an empty buffer is discarded, not treated as a scan", () => {
  const r = feedWedgeKey(EMPTY_WEDGE, { key: "Enter", at: 1000 });
  assert.equal(r.kind, "discard");
});

ok("something too short to be a barcode is discarded", () => {
  const r = type("ab", 10);
  assert.equal(r.kind, "discard");
  assert.ok(MIN_CODE_LENGTH === 3);
});

ok("a long pause mid-burst restarts rather than gluing two codes together", () => {
  let state: WedgeState = EMPTY_WEDGE;
  let at = 1000;
  for (const ch of "ABC") { at += 10; state = feedWedgeKey(state, { key: ch, at }).state; }
  at += 5000;                                    // walked away
  for (const ch of "XYZ") { at += 10; state = feedWedgeKey(state, { key: ch, at }).state; }
  at += 10;
  const r = feedWedgeKey(state, { key: "Enter", at });
  assert.equal(r.kind, "scan");
  if (r.kind === "scan") assert.equal(r.code, "XYZ", "must not read ABCXYZ");
});

ok("non-character keys end the burst instead of corrupting the code", () => {
  for (const key of ["Shift", "Tab", "Backspace", "ArrowLeft", "Escape"]) {
    let state: WedgeState = EMPTY_WEDGE;
    let at = 1000;
    for (const ch of "ABC") { at += 10; state = feedWedgeKey(state, { key: ch, at }).state; }
    at += 10;
    const r = feedWedgeKey(state, { key, at });
    assert.equal(r.kind, "discard", `${key} should end the burst`);
    assert.deepEqual(r.state, EMPTY_WEDGE);
  }
});

// ── Focus rules — the other half of "never eat what someone typed" ───────────

ok("the listener stands down whenever an editable element has focus", () => {
  for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
    assert.equal(shouldIgnoreWedgeTarget({ tagName: tag } as any), true, `${tag} must be left alone`);
  }
  assert.equal(shouldIgnoreWedgeTarget({ tagName: "DIV", isContentEditable: true } as any), true);
});

ok("it does listen when focus is on the page body or a plain element", () => {
  assert.equal(shouldIgnoreWedgeTarget({ tagName: "BODY" } as any), false);
  assert.equal(shouldIgnoreWedgeTarget({ tagName: "DIV", isContentEditable: false } as any), false);
  assert.equal(shouldIgnoreWedgeTarget(null), false);
});

if (process.exitCode) console.error(`\n${passed} passed, at least one FAILED.`);
else console.log(`✅ wedge scanner: ${passed} test groups passed.`);
