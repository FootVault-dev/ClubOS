// Marketing Suite — SMS lib entrypoint (Phase F part 1).
//
// Provider factory + the NZ compliance constants from the deep-research BUILD SPEC
// (outputs/deep-research/2026-07-09-clubos-marketing-suite/04-sms-marketing-nz.md
// §4 "Compliance checklist" and synthesis.md §(d)). Wiring these into routes.ts /
// worker.ts / webhook.ts is a parallel agent's job — this file only exports the
// building blocks: nothing here touches the DB or Express.

import type { SmsProvider } from "./types";
import { DryRunSmsProvider } from "./providers/dryrun";
import { TnzSmsProvider } from "./providers/tnz";
import { WebSmsProvider } from "./providers/websms";

export * from "./types";
export * from "./encoding";
export { DryRunSmsProvider } from "./providers/dryrun";
export { TnzSmsProvider } from "./providers/tnz";
export { WebSmsProvider } from "./providers/websms";

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Picks the SMS adapter from `SMS_PROVIDER` env ('dryrun' default | 'tnz' | 'websms').
 * Defaulting to dryrun is intentional and load-bearing: no real SMS provider
 * account is open yet (see README.md "Provider setup"), so an unset env var must
 * never accidentally hit a live carrier.
 */
export function getSmsProvider(): SmsProvider {
  const raw = (process.env.SMS_PROVIDER || "dryrun").trim().toLowerCase();
  switch (raw) {
    case "tnz":
      return new TnzSmsProvider();
    case "websms":
      return new WebSmsProvider();
    case "dryrun":
      return new DryRunSmsProvider();
    default:
      console.warn(`[sms] Unknown SMS_PROVIDER="${raw}" — falling back to dryrun (no real sends).`);
      return new DryRunSmsProvider();
  }
}

// ---------------------------------------------------------------------------
// Quiet hours — UEMA best-practice window (Finding 8): block marketing sends
// outside 08:00–20:00 Pacific/Auckland, queue to next 08:00 NZ.
// ---------------------------------------------------------------------------

export const QUIET_HOURS = {
  start: "20:00",
  end: "08:00",
  tz: "Pacific/Auckland",
} as const;

interface NzWallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
}

/** Reads the Pacific/Auckland wall-clock (DST-correct) for a given instant, via Intl only — no date library. */
function getNzWallClock(date: Date): NzWallClock {
  const parts = new Intl.DateTimeFormat("en-NZ", {
    timeZone: QUIET_HOURS.tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

/**
 * Converts a "wall clock" date/time in a given IANA time zone to the correct
 * UTC instant, DST-safe, using only Intl (fixed-point iteration — no new deps).
 * Standard technique: guess treating the wall time as UTC, see what that guess
 * actually reads as in the target zone, and correct by the difference. Converges
 * in 1-2 iterations since NZ's UTC offset only ever takes two values (+12/+13).
 */
function zonedWallClockToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): Date {
  let guessMs = Date.UTC(y, m - 1, d, hh, mm, 0);
  const wantMs = guessMs;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guessMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
    const asUtcMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const diff = wantMs - asUtcMs;
    if (diff === 0) break;
    guessMs += diff;
  }
  return new Date(guessMs);
}

/**
 * True if `date` falls inside the NZ quiet-hours window (20:00–08:00 Pacific/Auckland,
 * i.e. sendable window is [08:00, 20:00) local). DST-safe: reads the actual local
 * wall-clock hour/minute for that instant via Intl, so NZST/NZDT is handled for free.
 */
export function isQuietHours(date: Date = new Date()): boolean {
  const { hour, minute } = getNzWallClock(date);
  const minutesOfDay = hour * 60 + minute;
  const startMinutes = 20 * 60; // 20:00
  const endMinutes = 8 * 60; // 08:00
  return minutesOfDay >= startMinutes || minutesOfDay < endMinutes;
}

/**
 * If `date` is sendable, returns it unchanged. If it's in quiet hours, rolls
 * forward to the next 08:00 Pacific/Auckland instant — same NZ calendar day if
 * we're in the pre-dawn window (00:00–07:59), the next NZ calendar day if we're
 * in the evening window (20:00–23:59). DST-safe via zonedWallClockToUtc.
 */
export function nextSendableTime(date: Date): Date {
  if (!isQuietHours(date)) return date;

  const { year, month, day, hour } = getNzWallClock(date);
  const daysToAdd = hour < 8 ? 0 : 1;

  // Add calendar days on the NZ Y-M-D triple (UTC-anchored day arithmetic avoids
  // any local-timezone DST edge case in the day-increment step itself).
  const dayBase = new Date(Date.UTC(year, month - 1, day));
  dayBase.setUTCDate(dayBase.getUTCDate() + daysToAdd);

  return zonedWallClockToUtc(
    dayBase.getUTCFullYear(),
    dayBase.getUTCMonth() + 1,
    dayBase.getUTCDate(),
    8,
    0,
    QUIET_HOURS.tz,
  );
}

// ---------------------------------------------------------------------------
// STOP / HELP keyword matching (UEMA s11 — functional unsubscribe)
// ---------------------------------------------------------------------------

export const STOP_KEYWORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "END", "QUIT", "CANCEL"] as const;
export const HELP_KEYWORDS = ["HELP", "INFO"] as const;

/**
 * Matches an inbound SMS body against STOP_KEYWORDS.
 *
 * Decision (documented per the task brief — the deep-research report specifies
 * WHICH keywords count as opt-outs but not whether matching should be exact or
 * substring): this uses an EXACT match on the trimmed, case-insensitive full
 * message body — not a substring/word search. "STOP", " Stop ", "STOPALL" all
 * match; "stop it" does NOT. This mirrors real-world carrier/aggregator practice
 * (US CTIA short-code rules and NZ aggregators alike treat STOP as a dedicated
 * exact-body keyword message, not a word appearing anywhere in a sentence) and
 * avoids false-positive opt-outs from ordinary replies that merely contain the
 * word "stop" (e.g. a parent texting back "can you stop sending the 8am ones,
 * evening only please" is a preference request for a human, not a hard opt-out).
 * A false NEGATIVE (missing a real opt-out) is a compliance risk; a false
 * POSITIVE (silently unsubscribing someone who didn't ask to be) is a support/
 * trust problem — exact-match is the conservative choice for the s11 gate itself,
 * while routes.ts/webhook.ts wiring (not this file) can still surface any inbound
 * reply containing "stop" to a human inbox for review.
 */
export function matchStopKeyword(body: string): string | null {
  const trimmed = body.trim().toUpperCase();
  return (STOP_KEYWORDS as readonly string[]).includes(trimmed) ? trimmed : null;
}

/** Same exact-match contract as matchStopKeyword, for HELP_KEYWORDS. */
export function matchHelpKeyword(body: string): string | null {
  const trimmed = body.trim().toUpperCase();
  return (HELP_KEYWORDS as readonly string[]).includes(trimmed) ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Opt-out suffix (UEMA s11 — every marketing SMS must carry a free opt-out route)
// ---------------------------------------------------------------------------

const OPT_OUT_SUFFIX = " Reply STOP to opt out";

/**
 * Appends " Reply STOP to opt out" to a marketing SMS body, unless the body
 * already contains an opt-out instruction (case-insensitive "reply stop" check)
 * — so re-running this on an already-suffixed template doesn't double it up.
 * Call this BEFORE analyzeSms()/estimateCost() — the suffix counts toward
 * segments like any other text (see 04-sms-marketing-nz.md Finding 7).
 */
export function appendOptOutSuffix(body: string): string {
  if (/reply\s+stop/i.test(body)) return body;
  return `${body}${OPT_OUT_SUFFIX}`;
}
