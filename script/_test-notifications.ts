/**
 * Notification logic — unit tests. No database, no network.
 *
 *   npx tsx script/_test-notifications.ts
 *
 * These cover the decisions that are invisible until they are wrong: a quiet-
 * hours window that wraps midnight, a digest sweep that must not double-send,
 * and the delivery ladder that decides whose phone buzzes. All of it is silent
 * failure territory — nobody reports "I didn't get a notification I wasn't
 * expecting", so it has to be proven rather than eyeballed.
 */
import {
  DEFAULT_PREFERENCES,
  type NotificationPreferences,
  decideDelivery,
  isQuietHours,
  nzHour,
  nzWeekday,
  nzDateKey,
  dailyDigestDue,
  weeklyDigestDue,
  planChatDelivery,
  chatPushPresentation,
  truncateForPush,
  normalizePreferences,
} from "../shared/notifications";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `expected ${e}, got ${a}`);
}

const prefs = (over: Partial<NotificationPreferences> = {}): NotificationPreferences => ({
  ...DEFAULT_PREFERENCES,
  ...over,
});

// NZ is UTC+12 (NZST) / UTC+13 (NZDT). August = NZST, so UTC+12.
const nz = (isoUtc: string) => new Date(isoUtc);

console.log("\n── Timezone helpers ──");
// 2026-08-07T09:00:00Z = 21:00 NZST on the 7th.
eq("nzHour: 09:00 UTC → 21 NZ", nzHour(nz("2026-08-07T09:00:00Z")), 21);
// 2026-08-07T20:00:00Z = 08:00 NZST on the 8th — the date rolls over.
eq("nzHour: 20:00 UTC → 8 NZ", nzHour(nz("2026-08-07T20:00:00Z")), 8);
eq(
  "nzDateKey rolls to next NZ day at 12:00 UTC",
  nzDateKey(nz("2026-08-07T20:00:00Z")),
  "2026-08-08",
);
eq("nzDateKey same NZ day before rollover", nzDateKey(nz("2026-08-07T09:00:00Z")), "2026-08-07");
// 2026-08-07 is a Friday NZ.
eq("nzWeekday: Friday → 5", nzWeekday(nz("2026-08-07T09:00:00Z")), 5);

console.log("── Quiet hours ──");
const qh = prefs({ quietHoursStart: 20, quietHoursEnd: 8 });
check("21:00 NZ is inside 20→8", isQuietHours(qh, nz("2026-08-07T09:00:00Z")));
check("08:00 NZ is OUTSIDE (end is exclusive)", !isQuietHours(qh, nz("2026-08-07T20:00:00Z")));
// 2026-08-07T14:00:00Z = 02:00 NZ on the 8th — after midnight, still quiet.
check("02:00 NZ is inside the overnight wrap", isQuietHours(qh, nz("2026-08-07T14:00:00Z")));
// 2026-08-07T02:00:00Z = 14:00 NZ — the middle of the working day.
check("14:00 NZ is not quiet", !isQuietHours(qh, nz("2026-08-07T02:00:00Z")));
check(
  "disabled quiet hours are never quiet",
  !isQuietHours(prefs({ quietHoursEnabled: false }), nz("2026-08-07T09:00:00Z")),
);
// A same-value window would otherwise silence someone permanently with no way
// to tell why — it must read as "no quiet hours", not "always quiet".
check(
  "start === end means NO quiet hours, never silent-forever",
  !isQuietHours(prefs({ quietHoursStart: 9, quietHoursEnd: 9 }), nz("2026-08-07T09:00:00Z")),
);
// A same-day (non-wrapping) window.
const daytimeQuiet = prefs({ quietHoursStart: 9, quietHoursEnd: 17 });
check("same-day window: 14:00 inside 9→17", isQuietHours(daytimeQuiet, nz("2026-08-07T02:00:00Z")));
check("same-day window: 21:00 outside 9→17", !isQuietHours(daytimeQuiet, nz("2026-08-07T09:00:00Z")));

console.log("── Delivery decision ──");
const noon = nz("2026-08-07T00:00:00Z"); // 12:00 NZ — well outside quiet hours
eq("default DM → both channels", decideDelivery(prefs(), "chat_dm", noon), { push: true, email: true });
eq(
  "master push switch off kills push, keeps email",
  decideDelivery(prefs({ pushEnabled: false }), "chat_dm", noon),
  { push: false, email: true },
);
eq(
  "master email switch off kills email, keeps push",
  decideDelivery(prefs({ emailEnabled: false }), "chat_dm", noon),
  { push: true, email: false },
);
eq(
  "event set to none → nothing, whatever the masters say",
  decideDelivery(prefs({ chatDm: "none" }), "chat_dm", noon),
  { push: false, email: false, reason: "event set to none" },
);
eq(
  "quiet hours suppress both",
  decideDelivery(prefs(), "chat_dm", nz("2026-08-07T09:00:00Z")),
  { push: false, email: false, reason: "quiet hours" },
);
eq(
  "urgent overrides quiet hours",
  decideDelivery(prefs(), "chat_dm", nz("2026-08-07T09:00:00Z"), { urgent: true }),
  { push: true, email: true },
);
// The one thing urgency must NOT override: an explicit "never tell me".
eq(
  "urgent does NOT override an explicit 'none'",
  decideDelivery(prefs({ chatDm: "none" }), "chat_dm", nz("2026-08-07T09:00:00Z"), { urgent: true }),
  { push: false, email: false, reason: "event set to none" },
);
eq("channel default is push-only", decideDelivery(prefs(), "chat_channel", noon), {
  push: true,
  email: false,
});
eq("task_due default is email-only", decideDelivery(prefs(), "task_due", noon), {
  push: false,
  email: true,
});

console.log("── Chat delivery ladder ──");
const P = new Map<number, NotificationPreferences>([
  [1, prefs()],
  [2, prefs()],
  [3, prefs()],
  [4, prefs()],
]);
const rcpt = (over: Partial<Parameters<typeof planChatDelivery>[0][0]> = {}) => ({
  userId: 1,
  mentioned: false,
  notifyLevel: "mentions",
  away: false,
  emailDebounced: false,
  email: "a@b.com",
  ...over,
});

eq(
  "channel + level 'mentions' + not mentioned → nothing",
  planChatDelivery([rcpt()], P, false, noon).length,
  0,
);
eq(
  "channel + mentioned → notified",
  planChatDelivery([rcpt({ mentioned: true })], P, false, noon).map((p) => p.event),
  ["chat_mention"],
);
eq(
  "channel + level 'all' → notified without a mention",
  planChatDelivery([rcpt({ notifyLevel: "all" })], P, false, noon).map((p) => p.event),
  ["chat_channel"],
);
// Muting a room is not the same as refusing a direct question.
eq(
  "a MENTION cuts through a muted channel",
  planChatDelivery([rcpt({ notifyLevel: "muted", mentioned: true })], P, false, noon).length,
  1,
);
eq(
  "plain traffic does NOT cut through a muted channel",
  planChatDelivery([rcpt({ notifyLevel: "muted" })], P, false, noon).length,
  0,
);
eq(
  "DM reaches you at level 'mentions'",
  planChatDelivery([rcpt()], P, true, noon).map((p) => p.event),
  ["chat_dm"],
);
eq("a MUTED dm stays muted", planChatDelivery([rcpt({ notifyLevel: "muted" })], P, true, noon).length, 0);

console.log("── Email is the away-escalation only ──");
eq(
  "present user: push yes, email no",
  planChatDelivery([rcpt({ away: false })], P, true, noon).map((p) => [p.push, p.email]),
  [[true, false]],
);
eq(
  "away user: push AND email",
  planChatDelivery([rcpt({ away: true })], P, true, noon).map((p) => [p.push, p.email]),
  [[true, true]],
);
eq(
  "away but debounced: push only",
  planChatDelivery([rcpt({ away: true, emailDebounced: true })], P, true, noon).map((p) => [p.push, p.email]),
  [[true, false]],
);
// The old code skipped these people entirely, because email was the only channel.
eq(
  "no email address still gets PUSH",
  planChatDelivery([rcpt({ away: true, email: null })], P, true, noon).map((p) => [p.push, p.email]),
  [[true, false]],
);
// Someone with push off and email off (via quiet hours) drops out entirely
// rather than appearing in the plan with both flags false.
eq(
  "nobody is planned when both channels are off",
  planChatDelivery([rcpt({ away: true })], new Map([[1, prefs({ pushEnabled: false, emailEnabled: false })]]), true, noon).length,
  0,
);
// A person with no stored row must still be notified — on day one that is
// everybody, and omitting them would look exactly like "push is broken".
eq(
  "a recipient with NO preferences row gets the defaults",
  planChatDelivery([rcpt({ userId: 99 })], new Map(), true, noon).length,
  1,
);

console.log("── Digest scheduling (idempotency) ──");
const dp = prefs({ dailyDigest: true, dailyDigestHour: 8 });
const at8 = nz("2026-08-07T20:00:00Z"); // 08:00 NZ on the 8th
const at7 = nz("2026-08-07T19:00:00Z"); // 07:00 NZ on the 8th
check("not due before the chosen hour", !dailyDigestDue(dp, null, at7));
check("due at the chosen hour, never sent", dailyDigestDue(dp, null, at8));
check("NOT due again the same NZ day", !dailyDigestDue(dp, at8, nz("2026-08-07T21:00:00Z")));
// A late sweep (deploy, restart) must still send rather than skip the day.
check(
  "a LATE sweep still sends the same day",
  dailyDigestDue(dp, nz("2026-08-06T20:00:00Z"), nz("2026-08-07T23:00:00Z")),
);
check("off means never", !dailyDigestDue(prefs({ dailyDigest: false }), null, at8));

const wp = prefs({ weeklyDigest: true, weeklyDigestDay: 6, weeklyDigestHour: 8 });
// 2026-08-07T20:00:00Z = Saturday 8 Aug 08:00 NZ → weekday 6.
check("weekly due on the chosen weekday at the hour", weeklyDigestDue(wp, null, at8));
check(
  "weekly NOT due on another weekday",
  !weeklyDigestDue(wp, null, nz("2026-08-06T20:00:00Z")),
);
check("weekly not repeated the same day", !weeklyDigestDue(wp, at8, nz("2026-08-07T21:00:00Z")));

console.log("── Push presentation ──");
const chan = chatPushPresentation({
  senderName: "Zach Bennett",
  channelKind: "channel",
  channelName: "general",
  channelId: 12,
  body: "Can someone cover Saturday?",
  showPreview: true,
  mentioned: false,
});
eq("title is the sender", chan.title, "Zach Bennett");
eq("subtitle is the channel", chan.subtitle, "#general");
eq("body is the message", chan.body, "Can someone cover Saturday?");
eq("iOS groups by channel", chan.threadId, "chat-12");
eq("android channel for a channel message", chan.androidChannelId, "chat");

const mention = chatPushPresentation({
  senderName: "Travis Graham",
  channelKind: "channel",
  channelName: "ops",
  channelId: 3,
  body: "@Daniel can you confirm",
  showPreview: true,
  mentioned: true,
});
eq("a mention says so in the subtitle", mention.subtitle, "#ops · mentioned you");

const dm = chatPushPresentation({
  senderName: "Zach Bennett",
  channelKind: "dm",
  channelName: null,
  channelId: 7,
  body: "hey",
  showPreview: true,
  mentioned: false,
});
eq("DM subtitle does not repeat the name", dm.subtitle, "Direct message");
eq("DMs use the max-importance android channel", dm.androidChannelId, "chat-dm");

const hidden = chatPushPresentation({
  senderName: "Zach Bennett",
  channelKind: "dm",
  channelName: null,
  channelId: 7,
  body: "Aria's medical form is attached",
  showPreview: false,
  mentioned: false,
});
eq("preview off hides the body", hidden.body, "New message");
eq("preview off still says WHO", hidden.title, "Zach Bennett");
eq("preview off still says WHERE", hidden.subtitle, "Direct message");

console.log("── Truncation ──");
eq("short bodies pass through", truncateForPush("hello"), "hello");
check("long bodies are cut with an ellipsis", truncateForPush("x".repeat(500)).endsWith("…"));
check("long bodies stay under the cap", truncateForPush("x".repeat(500)).length <= 178);
eq("an empty body is never blank on screen", truncateForPush("   "), "New message");
eq("whitespace is flattened", truncateForPush("a\n\n  b"), "a b");

console.log("── Normalisation (anything off the wire) ──");
eq("garbage mode falls back to the default", normalizePreferences({ chatDm: "carrier-pigeon" as any }).chatDm, "both");
eq("hour above range is clamped", normalizePreferences({ quietHoursStart: 99 }).quietHoursStart, 23);
eq("negative hour is clamped", normalizePreferences({ quietHoursEnd: -5 }).quietHoursEnd, 0);
eq("NaN hour becomes 0", normalizePreferences({ dailyDigestHour: NaN }).dailyDigestHour, 0);
eq("weekday 0 is invalid → Monday", normalizePreferences({ weeklyDigestDay: 0 }).weeklyDigestDay, 1);
eq("weekday 8 is invalid → Monday", normalizePreferences({ weeklyDigestDay: 8 }).weeklyDigestDay, 1);
eq("null input yields the defaults", normalizePreferences(null).chatDm, DEFAULT_PREFERENCES.chatDm);
eq("truthy non-boolean coerces", normalizePreferences({ pushEnabled: 1 as any }).pushEnabled, true);

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
