// SMS provider library self-test — plain tsx + node assert (same pattern as
// script/test-predictor-scoring.ts). No DB, no network — exercises encoding.ts,
// index.ts's compliance constants, and the DryRunSmsProvider round trip.
//
// Run: npx tsx script/test-sms-lib.ts
import assert from "node:assert";
import {
  analyzeSms,
  sanitizeToGsm7,
  estimateCost,
  isQuietHours,
  nextSendableTime,
  matchStopKeyword,
  matchHelpKeyword,
  appendOptOutSuffix,
  DryRunSmsProvider,
} from "../server/marketing/sms";

let passed = 0;
/** Promises from async test bodies, awaited before the final tally so a rejected assertion still fails the run (see bottom of file). */
const pending: Promise<void>[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === "function") {
      pending.push(
        (result as Promise<void>)
          .then(() => {
            passed++;
            console.log(`  ✓ ${name}`);
          })
          .catch((e: any) => {
            console.error(`  ✗ ${name}`);
            console.error(`    ${e.message}`);
            process.exitCode = 1;
          }),
      );
    } else {
      passed++;
      console.log(`  ✓ ${name}`);
    }
  } catch (e: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Encoding: GSM-7 vs UCS-2 detection
// ---------------------------------------------------------------------------
console.log("encoding — GSM-7 vs UCS-2 detection");

test("plain ASCII body is gsm7", () => {
  const a = analyzeSms("Training moved to 6pm tonight, same field.");
  assert.strictEqual(a.encoding, "gsm7");
  assert.strictEqual(a.offendingChars.length, 0);
});

test("a single emoji flips the WHOLE message to ucs2", () => {
  const withoutEmoji = analyzeSms("Great game today");
  const withEmoji = analyzeSms("Great game today \u{1F44B}"); // 👋
  assert.strictEqual(withoutEmoji.encoding, "gsm7");
  assert.strictEqual(withEmoji.encoding, "ucs2");
});

test("a non-BMP emoji counts as 2 UTF-16 code units (surrogate pair)", () => {
  const a = analyzeSms("\u{1F44B}"); // 👋 alone
  assert.strictEqual(a.encoding, "ucs2");
  assert.strictEqual(a.chars, 2);
});

test("GSM-7 extension-table chars (e.g. { } [ ] € ~) each cost 2 septets", () => {
  const a = analyzeSms("[]{}"); // 4 extension chars
  assert.strictEqual(a.encoding, "gsm7");
  assert.strictEqual(a.chars, 8); // 4 chars x 2 septets each
});

test("a single extension char (€) costs 2, not 1", () => {
  const a = analyzeSms("€"); // €
  assert.strictEqual(a.encoding, "gsm7");
  assert.strictEqual(a.chars, 2);
});

test("basic GSM-7 chars cost 1 septet each", () => {
  const a = analyzeSms("Hi!");
  assert.strictEqual(a.chars, 3);
});

// ---------------------------------------------------------------------------
// Segment boundaries
// ---------------------------------------------------------------------------
console.log("\nencoding — segment boundaries");

test("gsm7: 160 chars = 1 segment @ 160/segment", () => {
  const a = analyzeSms("A".repeat(160));
  assert.strictEqual(a.segments, 1);
  assert.strictEqual(a.segmentLength, 160);
});

test("gsm7: 161 chars tips into 2 segments @ 153/segment", () => {
  const a = analyzeSms("A".repeat(161));
  assert.strictEqual(a.segments, 2);
  assert.strictEqual(a.segmentLength, 153);
});

test("gsm7: 306 chars (2x153) is still exactly 2 segments", () => {
  const a = analyzeSms("A".repeat(306));
  assert.strictEqual(a.segments, 2);
});

test("gsm7: 307 chars tips into 3 segments", () => {
  const a = analyzeSms("A".repeat(307));
  assert.strictEqual(a.segments, 3);
});

test("ucs2: 70 chars = 1 segment @ 70/segment", () => {
  // 'α' (Greek small alpha) is NOT in the GSM-7 basic/extension tables (only
  // capital Greek letters are), so this forces ucs2 with clean 1-code-unit math.
  const a = analyzeSms("α" + "A".repeat(69));
  assert.strictEqual(a.encoding, "ucs2");
  assert.strictEqual(a.chars, 70);
  assert.strictEqual(a.segments, 1);
  assert.strictEqual(a.segmentLength, 70);
});

test("ucs2: 71 chars tips into 2 segments @ 67/segment", () => {
  const a = analyzeSms("α" + "A".repeat(70));
  assert.strictEqual(a.chars, 71);
  assert.strictEqual(a.segments, 2);
  assert.strictEqual(a.segmentLength, 67);
});

test("empty body = 0 segments", () => {
  assert.strictEqual(analyzeSms("").segments, 0);
});

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------
console.log("\nencoding — sanitizeToGsm7");

test("smart quotes, apostrophe, and em-dash are mapped to plain GSM-7 equivalents", () => {
  // Curly apostrophe/quotes + em dash + ellipsis — the classic Word/iOS paste trap.
  const input = "It’s a “nice” day—right…";
  const { sanitized, removed } = sanitizeToGsm7(input);
  assert.ok(sanitized.includes("It's"), `expected plain apostrophe, got: ${sanitized}`);
  assert.ok(sanitized.includes('"nice"'), `expected plain quotes, got: ${sanitized}`);
  assert.ok(sanitized.includes("day-right"), `expected plain dash, got: ${sanitized}`);
  assert.ok(sanitized.includes("..."), `expected plain ellipsis, got: ${sanitized}`);
  assert.strictEqual(removed.length, 0, "nothing should be REMOVED for mapped punctuation");
  assert.strictEqual(analyzeSms(sanitized).encoding, "gsm7");
});

test("emoji are stripped and reported in `removed`, not silently kept", () => {
  const input = "See you at training \u{1F44B} 6pm!";
  const { sanitized, removed } = sanitizeToGsm7(input);
  assert.ok(!sanitized.includes("\u{1F44B}"));
  assert.ok(removed.includes("\u{1F44B}"));
  assert.strictEqual(analyzeSms(sanitized).encoding, "gsm7", "sanitized output must be guaranteed gsm7");
});

test("sanitizing an already-clean gsm7 body is a no-op (nothing removed)", () => {
  const { sanitized, removed } = sanitizeToGsm7("Plain and simple.");
  assert.strictEqual(sanitized, "Plain and simple.");
  assert.strictEqual(removed.length, 0);
});

// ---------------------------------------------------------------------------
// Cost engine
// ---------------------------------------------------------------------------
console.log("\nencoding — estimateCost");

test("2,000 recipients x 1 segment @ 10c = $200.00 (20,000 cents) ex-GST", () => {
  assert.strictEqual(estimateCost(1, 2000, 10), 20000);
});

test("multi-segment sends multiply correctly (3 segments x 500 recipients @ 10c)", () => {
  assert.strictEqual(estimateCost(3, 500, 10), 15000);
});

// ---------------------------------------------------------------------------
// Quiet hours (Pacific/Auckland, DST-safe)
// ---------------------------------------------------------------------------
console.log("\nindex — quiet hours (NZ 08:00-20:00 sendable window)");

/**
 * Deep-NZST (June, UTC+12) and deep-NZDT (December, UTC+13) instants, picked
 * well away from any DST transition so the expected UTC offset is a fact we
 * can compute by hand — an independent check on isQuietHours' own
 * Intl-based wall-clock reconstruction (see index.ts's getNzWallClock).
 */
test("19:59 NZST (winter, UTC+12) is sendable", () => {
  assert.strictEqual(isQuietHours(new Date(Date.UTC(2026, 5, 15, 7, 59))), false);
});
test("20:00 NZST (winter, UTC+12) is blocked", () => {
  assert.strictEqual(isQuietHours(new Date(Date.UTC(2026, 5, 15, 8, 0))), true);
});
test("07:59 NZST (winter, UTC+12) is blocked", () => {
  assert.strictEqual(isQuietHours(new Date(Date.UTC(2026, 5, 14, 19, 59))), true);
});
test("08:00 NZST (winter, UTC+12) is sendable", () => {
  assert.strictEqual(isQuietHours(new Date(Date.UTC(2026, 5, 14, 20, 0))), false);
});

test("19:59 NZDT (summer, UTC+13) is sendable", () => {
  assert.strictEqual(isQuietHours(new Date(Date.UTC(2026, 11, 15, 6, 59))), false);
});
test("20:00 NZDT (summer, UTC+13) is blocked", () => {
  assert.strictEqual(isQuietHours(new Date(Date.UTC(2026, 11, 15, 7, 0))), true);
});
test("07:59 NZDT (summer, UTC+13) is blocked", () => {
  assert.strictEqual(isQuietHours(new Date(Date.UTC(2026, 11, 14, 18, 59))), true);
});
test("08:00 NZDT (summer, UTC+13) is sendable", () => {
  assert.strictEqual(isQuietHours(new Date(Date.UTC(2026, 11, 14, 19, 0))), false);
});

// --- DST boundary -----------------------------------------------------------
// NZ DST: clocks spring forward (NZST -> NZDT) at 2am on the LAST Sunday of
// September; fall back (NZDT -> NZST) at 3am on the FIRST Sunday of April.
// Computed at runtime (not hardcoded) so this stays correct if the rule or
// year assumptions ever drift.
function lastSundayOfMonth(year: number, month1based: number): Date {
  const lastDay = new Date(Date.UTC(year, month1based, 0)); // day 0 of next month = last day of this one
  lastDay.setUTCDate(lastDay.getUTCDate() - lastDay.getUTCDay());
  return lastDay;
}
function nzOffsetMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", timeZoneName: "shortOffset" }).formatToParts(
    date,
  );
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = tzName.match(/GMT([+-]\d+)/);
  return m ? Number(m[1]) * 60 : 0;
}

console.log("\nindex — DST boundary (September spring-forward, computed at runtime)");

test("the computed September transition Sunday actually changes NZ's UTC offset (+12 -> +13)", () => {
  const transitionSunday = lastSundayOfMonth(2026, 9);
  const dayBefore = new Date(Date.UTC(transitionSunday.getUTCFullYear(), transitionSunday.getUTCMonth(), transitionSunday.getUTCDate() - 1, 12));
  const dayAfter = new Date(Date.UTC(transitionSunday.getUTCFullYear(), transitionSunday.getUTCMonth(), transitionSunday.getUTCDate() + 1, 12));
  assert.strictEqual(nzOffsetMinutes(dayBefore), 12 * 60, "day before should read NZST (+12)");
  assert.strictEqual(nzOffsetMinutes(dayAfter), 13 * 60, "day after should read NZDT (+13)");
});

test("nextSendableTime rolls correctly to 08:00 NZ across the DST transition night", () => {
  const transitionSunday = lastSundayOfMonth(2026, 9);
  // 22:00 NZST the evening BEFORE the transition Sunday (still +12) — well inside
  // quiet hours. nextSendableTime must roll forward to 08:00 NZ on transition day
  // itself, which by then is governed by the NEW (+13) offset.
  const eveningBeforeUtc = Date.UTC(
    transitionSunday.getUTCFullYear(),
    transitionSunday.getUTCMonth(),
    transitionSunday.getUTCDate() - 1,
    10, // 22:00 NZST = 10:00 UTC
    0,
  );
  const result = nextSendableTime(new Date(eveningBeforeUtc));
  assert.strictEqual(isQuietHours(result), false, "the rolled-forward time must itself be sendable");

  const parts = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(result);
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  assert.strictEqual(get("hour"), "08", `expected NZ 08:00, got ${get("hour")}:${get("minute")}`);
  assert.strictEqual(get("minute"), "00");
  assert.strictEqual(get("day"), String(transitionSunday.getUTCDate()).padStart(2, "0"), "should land on the transition Sunday itself");
});

test("a date already sendable is returned unchanged", () => {
  const sendable = new Date(Date.UTC(2026, 5, 15, 7, 59)); // 19:59 NZST
  assert.strictEqual(nextSendableTime(sendable).getTime(), sendable.getTime());
});

// ---------------------------------------------------------------------------
// STOP / HELP keyword matching
// ---------------------------------------------------------------------------
console.log("\nindex — STOP/HELP keyword matching");
console.log(
  "  (documented design: EXACT match on the trimmed, case-insensitive full body — not a\n" +
    "   substring/word search. 'stop it' or 'please stop the 8am ones' must NOT auto-unsubscribe\n" +
    "   someone; see index.ts's matchStopKeyword doc comment for the full rationale.)",
);

test("exact 'STOP' matches", () => {
  assert.strictEqual(matchStopKeyword("STOP"), "STOP");
});
test("case-insensitive 'stop' matches", () => {
  assert.strictEqual(matchStopKeyword("stop"), "STOP");
});
test("whitespace-padded ' Stop ' matches (trimmed)", () => {
  assert.strictEqual(matchStopKeyword("  Stop  "), "STOP");
});
test("'STOPALL' matches (a distinct listed keyword)", () => {
  assert.strictEqual(matchStopKeyword("StopAll"), "STOPALL");
});
test("all documented STOP synonyms match", () => {
  for (const kw of ["UNSUBSCRIBE", "END", "QUIT", "CANCEL"]) {
    assert.strictEqual(matchStopKeyword(kw.toLowerCase()), kw);
  }
});
test("'stop it' does NOT match (substring, not exact body)", () => {
  assert.strictEqual(matchStopKeyword("stop it"), null);
});
test("a sentence merely containing 'stop' does NOT match", () => {
  assert.strictEqual(matchStopKeyword("can you stop sending the 8am ones please"), null);
});
test("empty body does not match", () => {
  assert.strictEqual(matchStopKeyword(""), null);
});
test("'HELP' matches matchHelpKeyword, exact-match same as STOP", () => {
  assert.strictEqual(matchHelpKeyword("help"), "HELP");
  assert.strictEqual(matchHelpKeyword("I need help"), null);
});

// ---------------------------------------------------------------------------
// Opt-out suffix
// ---------------------------------------------------------------------------
console.log("\nindex — appendOptOutSuffix");

test("appends the opt-out line to a plain marketing body", () => {
  const out = appendOptOutSuffix("Term 3 signups are open!");
  assert.ok(out.includes("Reply STOP to opt out"));
});
test("does not double-append if the body already has an opt-out instruction", () => {
  const body = "Term 3 signups are open! Reply STOP to opt out";
  assert.strictEqual(appendOptOutSuffix(body), body);
});

// ---------------------------------------------------------------------------
// DryRunSmsProvider round trip
// ---------------------------------------------------------------------------
console.log("\nproviders/dryrun — send -> DLR -> inbound STOP round trip");

test("send() returns a fake providerMessageId with real segments/cost", async () => {
  const provider = new DryRunSmsProvider();
  const body = appendOptOutSuffix("Reminder: training moved to 6pm tonight.");
  const result = await provider.send({ to: "+64211234567", body, clientRef: "test-campaign:1" });
  assert.ok(result.providerMessageId.startsWith("dryrun_"), result.providerMessageId);
  assert.strictEqual(result.segments, analyzeSms(body).segments);
  assert.strictEqual(result.costCentsEstimate, estimateCost(analyzeSms(body).segments, 1, 10));
  assert.strictEqual(provider.sent.length, 1);
});

test("delivery-receipt round trip: simulate -> parseDeliveryReceipt", async () => {
  const provider = new DryRunSmsProvider();
  const { providerMessageId } = await provider.send({ to: "+64211234567", body: "Test", clientRef: "rt:1" });

  const fakeReq = provider.simulateDeliveryReceiptRequest(providerMessageId, "delivered");
  const receipt = provider.parseDeliveryReceipt(fakeReq);
  assert.ok(receipt, "expected a parsed delivery receipt, got null");
  assert.strictEqual(receipt!.providerMessageId, providerMessageId);
  assert.strictEqual(receipt!.status, "delivered");
  assert.ok(receipt!.at instanceof Date);
});

test("inbound STOP round trip: simulate -> parseInbound -> matchStopKeyword", async () => {
  const provider = new DryRunSmsProvider();
  const fakeReq = provider.simulateInboundRequest("+64211234567", "STOP");
  const inbound = provider.parseInbound(fakeReq);
  assert.ok(inbound, "expected a parsed inbound message, got null");
  assert.strictEqual(inbound!.from, "+64211234567");
  assert.strictEqual(matchStopKeyword(inbound!.body), "STOP");
});

test("parseDeliveryReceipt/parseInbound return null for a request that isn't theirs", () => {
  const provider = new DryRunSmsProvider();
  const dlrReq = provider.simulateDeliveryReceiptRequest("dryrun_x", "delivered");
  const inboundReq = provider.simulateInboundRequest("+64211234567", "hi");
  assert.strictEqual(provider.parseInbound(dlrReq), null, "a DLR payload must not parse as inbound");
  assert.strictEqual(provider.parseDeliveryReceipt(inboundReq), null, "an inbound payload must not parse as a DLR");
});

test("verifyWebhook always returns true for dry-run (no real signing to check)", () => {
  const provider = new DryRunSmsProvider();
  assert.strictEqual(provider.verifyWebhook({ headers: {}, body: {} }), true);
});

// ---------------------------------------------------------------------------
// Await every async test's settled promise before tallying — otherwise a
// rejected assertion in one of the DryRunSmsProvider tests could resolve
// AFTER the summary below has already printed a false "all passed".
await Promise.all(pending);

if (process.exitCode) {
  console.error("\n✗ sms-lib tests FAILED");
} else {
  console.log(`\n✓ all ${passed} sms-lib tests passed`);
}
