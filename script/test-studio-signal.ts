// Pure-logic tests for the Studio "Signal" reading heuristic.
// Run: npx tsx script/test-studio-signal.ts  (exits non-zero on failure)
import assert from "node:assert";
import type { Block } from "../shared/studio-blocks";
import {
  blockWordCount,
  countWords,
  expectedReadMs,
  readRatio,
  classifyRead,
  engagementLevel,
  median,
  READING_WPM,
} from "../shared/studio-signal";

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed++;
  console.log("  ✓", name);
}

console.log("studio-signal pure logic");

ok("countWords ignores markdown punctuation + urls", () => {
  assert.strictEqual(countWords("## Hello **world** now"), 3);
  assert.strictEqual(countWords("See [our site](https://x.co) today"), 4); // See, our, site, today
  assert.strictEqual(countWords(""), 0);
  assert.strictEqual(countWords("   "), 0);
});

ok("blockWordCount gathers all prose fields, skips refs/id/type", () => {
  const hero: Block = {
    type: "hero",
    id: "b1",
    eyebrow: "For Go Rentals",
    headline: "Reach ten thousand fans",
    subhead: "Every home game, on every shirt",
    imageRef: "asset:hero-should-not-count",
  };
  // eyebrow(3) + headline(4) + subhead(6) = 13; imageRef excluded
  assert.strictEqual(blockWordCount(hero), 13);

  const section: Block = {
    type: "section",
    id: "b2",
    heading: "The opportunity",
    bodyMd: "One two three four five six seven eight nine ten.",
  };
  assert.strictEqual(blockWordCount(section), 12); // 2 + 10
});

ok("expectedReadMs matches 225 wpm", () => {
  // 225 words = 60_000ms exactly at 225 wpm
  assert.strictEqual(expectedReadMs(READING_WPM), 60_000);
  assert.strictEqual(expectedReadMs(0), 0);
  // ~45 words ~= 12s
  assert.strictEqual(expectedReadMs(45), 12_000);
});

ok("readRatio null for zero-word (visual) block", () => {
  assert.strictEqual(readRatio(5000, 0), null);
  // 45 words => 12s expected; 6s dwell => 0.5 ratio
  assert.strictEqual(readRatio(6000, 45), 0.5);
});

ok("classifyRead thresholds (READ/SKIMMED/SKIPPED)", () => {
  // reachedPct = % of sessions that reached the block
  assert.strictEqual(classifyRead(0.8, 100), "read");
  assert.strictEqual(classifyRead(0.5, 100), "read"); // boundary inclusive
  assert.strictEqual(classifyRead(0.3, 100), "skimmed");
  assert.strictEqual(classifyRead(0.1, 100), "skimmed"); // boundary inclusive
  assert.strictEqual(classifyRead(0.05, 100), "skipped");
  assert.strictEqual(classifyRead(0.9, 0), "skipped"); // never reached => skipped
  assert.strictEqual(classifyRead(null, 100), "skimmed"); // visual, reached
  assert.strictEqual(classifyRead(null, 0), "skipped"); // visual, not reached
});

ok("engagementLevel buckets", () => {
  assert.strictEqual(engagementLevel(90_000, 90), "highly-engaged");
  assert.strictEqual(engagementLevel(30_000, 50), "engaged");
  assert.strictEqual(engagementLevel(10_000, 20), "neutral");
  assert.strictEqual(engagementLevel(2_000, 10), "disengaged");
  // high time but shallow scroll => not highly-engaged
  assert.strictEqual(engagementLevel(90_000, 30), "engaged");
});

ok("median", () => {
  assert.strictEqual(median([]), 0);
  assert.strictEqual(median([5]), 5);
  assert.strictEqual(median([1, 2, 3]), 2);
  assert.strictEqual(median([1, 2, 3, 4]), 2.5);
});

console.log(`\nAll ${passed} studio-signal tests passed.`);
