// USG Studio — "Signal" analytics pure logic (single source of truth).
//
// The reading-vs-skimming maths from the gold-standard spec
// (outputs/deep-research/2026-07-04-usg-studio-brand-ai-platform/06-proposal-analytics.md).
// Kept as a pure, dependency-free module so it is shared by the server aggregation
// (server/storage.ts) and unit-tested deterministically (script/test-studio-signal.ts).
//
// The heuristic (06 §b):
//   expectedRead = word_count / (225/60)            // seconds at 225 wpm
//   readRatio    = engaged_dwell_ms / (expectedRead * 1000)
//   READ     if readRatio >= 0.5   (spec also wants max_ratio>=0.75 & >=1 pause —
//                                    those richer client signals are not stored in
//                                    v1, so we classify on readRatio + reached only)
//   SKIMMED  if 0.1 <= readRatio < 0.5
//   SKIPPED  if readRatio < 0.1  OR the block was never reached (>=50% visible)
//
// Word counts are FREE here: USG Studio authored the page, so every block's text is
// in the stored PageDoc — no need to measure client-side.

import type { Block } from "./studio-blocks";

/** Average adult on-screen reading speed (06 §3.2 — Medium ~265, we use 225). */
export const READING_WPM = 225;

// Keys on a block that are references / structural, never human-readable prose.
const NON_TEXT_KEYS = new Set(["id", "type", "kind", "ref", "imageRef", "logoRefs"]);

/** Recursively gather the human-readable strings from a block (skips *Ref keys). */
export function collectBlockStrings(node: unknown): string[] {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap((v) => collectBlockStrings(v));
  if (typeof node === "object") {
    const out: string[] = [];
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (NON_TEXT_KEYS.has(k) || k.endsWith("Ref")) continue;
      out.push(...collectBlockStrings(v));
    }
    return out;
  }
  return [];
}

/** Count words in a string, tolerating the safe-subset markdown used in bodyMd. */
export function countWords(text: string): number {
  if (!text) return 0;
  const cleaned = text
    .replace(/\]\([^)]*\)/g, "]") // markdown links: keep the label, drop the (url)
    .replace(/[#*_>`~[\]|]/g, " ") // strip markdown punctuation
    .replace(/https?:\/\/\S+/g, " ") // drop bare urls
    .trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).filter(Boolean).length;
}

/** Total readable word count of one content block. */
export function blockWordCount(block: Block): number {
  return countWords(collectBlockStrings(block).join(" "));
}

/** Expected engaged read time for a block, in milliseconds, at READING_WPM. */
export function expectedReadMs(wordCount: number, wpm: number = READING_WPM): number {
  if (wordCount <= 0) return 0;
  return Math.round((wordCount / (wpm / 60)) * 1000);
}

/**
 * readRatio = engaged dwell / expected read time. Null when the block has no words
 * to read (a purely visual block — logo wall / image), so callers show it neutrally
 * rather than pretending it was "skipped".
 */
export function readRatio(engagedDwellMs: number, wordCount: number): number | null {
  const exp = expectedReadMs(wordCount);
  if (exp <= 0) return null; // nothing to read
  return engagedDwellMs / exp;
}

export type ReadClass = "read" | "skimmed" | "skipped";

/**
 * Classify a section as READ / SKIMMED / SKIPPED (06 §b thresholds).
 * @param ratio      readRatio (or null for a visual block with no text)
 * @param reachedPct % of sessions that reached the block (>=50% visible)
 */
export function classifyRead(ratio: number | null, reachedPct: number): ReadClass {
  if (reachedPct <= 0) return "skipped"; // never reached => skipped, per spec
  if (ratio == null) return "skimmed"; // visual block that WAS reached — neutral
  if (ratio >= 0.5) return "read";
  if (ratio >= 0.1) return "skimmed";
  return "skipped";
}

/**
 * Qwilr-style engagement bucket for a single session (drives the hot-list sort &
 * the per-session badge). Two inputs — engaged time + scroll depth — same shape as
 * Qwilr's page-views + minutes model (06 §1.2).
 */
export type EngagementLevel = "highly-engaged" | "engaged" | "neutral" | "disengaged";

export function engagementLevel(engagedMs: number, maxScrollPct: number): EngagementLevel {
  const sec = engagedMs / 1000;
  // OR-based: a lot of engaged time OR deep scroll each earns the level. Someone
  // who reads the top intently (high time, shallow scroll) is still engaged.
  if ((sec >= 60 && maxScrollPct >= 60) || sec >= 120) return "highly-engaged";
  if (sec >= 25 || maxScrollPct >= 60) return "engaged";
  if (sec >= 8 || maxScrollPct >= 25) return "neutral";
  return "disengaged";
}

/** Median of a numeric list (linear-interpolated), 0 for empty. */
export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
