// Marketing Suite — SMS encoding + cost engine (Phase F part 1).
//
// The money-saver: SMS is billed per segment, and encoding decides segment size.
// See outputs/deep-research/2026-07-09-clubos-marketing-suite/04-sms-marketing-nz.md
// Finding 7: a single emoji or smart-quote/em-dash flips the WHOLE message from
// GSM-7 to UCS-2, dropping the per-segment budget from 160/153 chars to 70/67 —
// tripling cost on an otherwise-ordinary 160-char message. This module computes
// encoding/segments/cost before send and gives a sanitiser to avoid the trap.

import type { SmsEncoding } from "./types";

// ---------------------------------------------------------------------------
// GSM 03.38 default alphabet.
// ---------------------------------------------------------------------------

/** Basic set — 1 septet (billed as 1 char) each. 127 characters (128 minus the ESC slot). */
const GSM7_BASIC_CHARS = [
  "@", "£", "$", "¥", "è", "é", "ù", "ì", "ò", "Ç", "\n", "Ø", "ø", "\r", "Å", "å",
  "Δ", "_", "Φ", "Γ", "Λ", "Ω", "Π", "Ψ", "Σ", "Θ", "Ξ", "Æ", "æ", "ß", "É",
  " ", "!", "\"", "#", "¤", "%", "&", "'", "(", ")", "*", "+", ",", "-", ".", "/",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ":", ";", "<", "=", ">", "?",
  "¡", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O",
  "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "Ä", "Ö", "Ñ", "Ü", "§",
  "¿", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o",
  "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "ä", "ö", "ñ", "ü", "à",
];

/**
 * Extension table — reached via the ESC (0x1B) escape, so each costs 2 septets
 * (billed as 2 chars) in a GSM-7 message. Printable characters only (the extension
 * table's form-feed control char is omitted — it's never typed into an SMS body).
 */
const GSM7_EXTENDED_CHARS = ["^", "{", "}", "\\", "[", "~", "]", "|", "€"];

const GSM7_BASIC_SET = new Set(GSM7_BASIC_CHARS);
const GSM7_EXTENDED_SET = new Set(GSM7_EXTENDED_CHARS);

// ---------------------------------------------------------------------------
// analyzeSms
// ---------------------------------------------------------------------------

export interface SmsAnalysis {
  encoding: SmsEncoding;
  /**
   * The unit count segment math runs on: GSM-7 septets (basic chars = 1,
   * extension chars = 2) for encoding='gsm7', or UTF-16 code units for
   * encoding='ucs2' (a non-BMP emoji surrogate pair correctly costs 2).
   */
  chars: number;
  /** 160 (gsm7 single) / 153 (gsm7 concatenated) / 70 (ucs2 single) / 67 (ucs2 concatenated). */
  segmentLength: number;
  segments: number;
  /** Unique non-GSM-7 characters found, in first-seen order. Empty unless encoding='ucs2'. */
  offendingChars: string[];
}

export function analyzeSms(body: string): SmsAnalysis {
  let septets = 0;
  let codeUnits = 0;
  let isGsm7 = true;
  const offending: string[] = [];
  const offendingSeen = new Set<string>();

  // Iterate by Unicode code point (for-of on a string yields whole code points,
  // so a non-BMP emoji surrogate pair is one iteration step) — but still count
  // UTF-16 code units via ch.length for accurate UCS-2 billing math.
  for (const ch of body) {
    codeUnits += ch.length;
    if (GSM7_BASIC_SET.has(ch)) {
      septets += 1;
    } else if (GSM7_EXTENDED_SET.has(ch)) {
      septets += 2;
    } else {
      isGsm7 = false;
      if (!offendingSeen.has(ch)) {
        offendingSeen.add(ch);
        offending.push(ch);
      }
    }
  }

  const encoding: SmsEncoding = isGsm7 ? "gsm7" : "ucs2";
  const chars = encoding === "gsm7" ? septets : codeUnits;

  let segmentLength: number;
  let segments: number;
  if (encoding === "gsm7") {
    if (chars <= 160) {
      segmentLength = 160;
      segments = chars === 0 ? 0 : 1;
    } else {
      segmentLength = 153;
      segments = Math.ceil(chars / 153);
    }
  } else {
    if (chars <= 70) {
      segmentLength = 70;
      segments = chars === 0 ? 0 : 1;
    } else {
      segmentLength = 67;
      segments = Math.ceil(chars / 67);
    }
  }

  return {
    encoding,
    chars,
    segmentLength,
    segments,
    offendingChars: encoding === "ucs2" ? offending : [],
  };
}

// ---------------------------------------------------------------------------
// sanitizeToGsm7
// ---------------------------------------------------------------------------

/**
 * Common "looks like ASCII but isn't" punctuation that copy-paste (Word, iOS
 * smart-quotes, em-dash autocorrect) silently injects. Fixed BEFORE the strip
 * pass so these become normal GSM-7 chars instead of being reported as removed.
 */
const SANITIZE_MAP: Record<string, string> = {
  "‘": "'", // ‘ left single quote
  "’": "'", // ’ right single quote / apostrophe
  "‚": "'", // ‚ single low-9 quote
  "‛": "'", // ‛ single high-reversed-9 quote
  "“": "\"", // “ left double quote
  "”": "\"", // ” right double quote
  "„": "\"", // „ double low-9 quote
  "–": "-", // – en dash
  "—": "-", // — em dash
  "−": "-", // − minus sign
  "…": "...", // … ellipsis
  " ": " ", // non-breaking space
};

export interface SanitizeResult {
  sanitized: string;
  /** Unique characters that were dropped entirely (typically emoji), first-seen order. */
  removed: string[];
}

/**
 * Normalises smart punctuation to plain GSM-7 equivalents, then strips any
 * character still outside the GSM-7 alphabet (emoji, most non-Latin scripts,
 * etc.) so the result is guaranteed GSM-7 (single-segment-friendly, no UCS-2
 * cost trap). Does NOT truncate length or add the opt-out suffix — call
 * analyzeSms() on the result to size/cost the final message.
 */
export function sanitizeToGsm7(body: string): SanitizeResult {
  let mapped = "";
  for (const ch of body) {
    mapped += SANITIZE_MAP[ch] ?? ch;
  }

  let sanitized = "";
  const removed: string[] = [];
  const removedSeen = new Set<string>();

  for (const ch of mapped) {
    if (GSM7_BASIC_SET.has(ch) || GSM7_EXTENDED_SET.has(ch)) {
      sanitized += ch;
    } else if (!removedSeen.has(ch)) {
      removedSeen.add(ch);
      removed.push(ch);
    }
  }

  return { sanitized, removed };
}

// ---------------------------------------------------------------------------
// estimateCost
// ---------------------------------------------------------------------------

/**
 * segments × recipients × centsPerSegment, in whole NZD cents (ex-GST — see
 * README.md for the worked example: 2,000 recipients × 1 segment @ 10c = $200 + GST).
 */
export function estimateCost(segments: number, recipients: number, centsPerSegment: number): number {
  return Math.round(segments * recipients * centsPerSegment);
}
