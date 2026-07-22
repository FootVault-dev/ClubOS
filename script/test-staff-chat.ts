// Self-asserting tests for shared/staff-chat.ts (pure logic only — routes are
// smoke-tested against prod post-deploy). Run: npx tsx script/test-staff-chat.ts
import {
  dmKeyFor, normalizeChannelName, hasChannelMention, excerpt, dmDisplayName,
  isQuietHoursNZ, nzHour, isAway, emailDebounced, classifyUpload, extensionFor,
} from "../shared/staff-chat";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${name}`); }
}

// dmKeyFor — order-independent, deduped
ok(dmKeyFor([17, 4]) === "4:17", "dmKeyFor sorts");
ok(dmKeyFor([4, 17, 4]) === "4:17", "dmKeyFor dedupes");
ok(dmKeyFor([23, 4, 17]) === "4:17:23", "dmKeyFor group");

// normalizeChannelName — slack style
ok(normalizeChannelName("Match Day Ops") === "match-day-ops", "name spaces→dashes");
ok(normalizeChannelName("#general!") === "general", "name strips # and punctuation");
ok(normalizeChannelName("  Coaches__U13  ") === "coaches-u13", "name underscores collapse");
ok(normalizeChannelName("тренеры") === "тренеры", "name keeps cyrillic");
ok(normalizeChannelName("---") === "", "name all-dashes → empty");
ok(normalizeChannelName("a".repeat(60)).length === 40, "name capped at 40");

// hasChannelMention
ok(hasChannelMention("@channel please read"), "@channel at start");
ok(hasChannelMention("heads up @everyone now"), "@everyone mid-text");
ok(hasChannelMention("(@all) meeting"), "@all after paren");
ok(!hasChannelMention("email me@channel.com"), "no match inside email");
ok(!hasChannelMention("the channel is open"), "no bare word match");

// excerpt
ok(excerpt("hello   world\n\nnew  line") === "hello world new line", "excerpt flattens whitespace");
ok(excerpt("x".repeat(300), 140).length <= 140, "excerpt caps length");
ok(excerpt("x".repeat(300), 140).endsWith("…"), "excerpt ellipsis");

// dmDisplayName
const names = [
  { userId: 1, name: "Daniel Meyn" },
  { userId: 2, name: "Ryan Edwards" },
  { userId: 3, name: "Riley Grounds" },
];
ok(dmDisplayName(names, 1) === "Ryan Edwards, Riley Grounds", "dm name from viewer 1");
ok(dmDisplayName(names, 2) === "Daniel Meyn, Riley Grounds", "dm name from viewer 2");
ok(dmDisplayName([{ userId: 1, name: "Daniel Meyn" }], 1) === "Just you", "dm self only");

// Quiet hours — July = NZST (UTC+12). 21:00 NZ = 09:00 UTC; 09:00 NZ = 21:00 UTC prev day.
ok(nzHour(new Date("2026-07-22T09:00:00Z")) === 21, "nzHour 09:00Z → 21 NZ");
ok(isQuietHoursNZ(new Date("2026-07-22T09:00:00Z")) === true, "21:00 NZ is quiet");
ok(isQuietHoursNZ(new Date("2026-07-22T19:30:00Z")) === true, "07:30 NZ is quiet");
ok(isQuietHoursNZ(new Date("2026-07-22T21:00:00Z")) === false, "09:00 NZ is not quiet");
ok(isQuietHoursNZ(new Date("2026-07-22T02:00:00Z")) === false, "14:00 NZ is not quiet");
// January = NZDT (UTC+13). 07:00Z = 20:00 NZDT → quiet starts exactly at 20.
ok(isQuietHoursNZ(new Date("2026-01-15T07:00:00Z")) === true, "20:00 NZDT (summer) is quiet");
ok(isQuietHoursNZ(new Date("2026-01-15T06:59:00Z")) === false, "19:59 NZDT (summer) not quiet");

// Away + debounce
const now = new Date("2026-07-22T04:00:00Z");
ok(isAway(null, now), "never-seen is away");
ok(isAway(new Date(now.getTime() - 6 * 60_000), now), "6 min silent is away");
ok(!isAway(new Date(now.getTime() - 2 * 60_000), now), "2 min silent is active");
ok(!emailDebounced(null, now), "never-emailed not debounced");
ok(emailDebounced(new Date(now.getTime() - 5 * 60_000), now), "5 min ago debounced");
ok(!emailDebounced(new Date(now.getTime() - 20 * 60_000), now), "20 min ago not debounced");

// Upload classification
ok(classifyUpload("image/png") === "image", "png is image");
ok(classifyUpload("image/heic") === "image", "heic is image");
ok(classifyUpload("audio/webm;codecs=opus") === "voice", "webm opus is voice");
ok(classifyUpload("audio/mp4") === "voice", "m4a is voice");
ok(classifyUpload("application/pdf") === "file", "pdf is file");
ok(classifyUpload("video/mp4") === "file", "mp4 video is file");
ok(classifyUpload("application/x-msdownload") === null, "exe rejected");
ok(classifyUpload("text/html") === null, "html rejected");
ok(extensionFor("audio/mp4") === "m4a", "audio/mp4 → m4a");
ok(extensionFor("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") === "xlsx", "xlsx ext");
ok(extensionFor("application/unknown") === "bin", "unknown → bin");

console.log(`\n${failed === 0 ? "✅" : "❌"} staff-chat shared tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
