// SMS CAMPAIGN pure-logic unit tests — plain tsx + node assert (same pattern
// as script/test-flows-graph.ts / script/test-sms-lib.ts). No DB, no network:
// exercises only server/marketing/campaign-sms.ts — the body-compose pipeline,
// the whole-campaign quiet-hours reschedule decision, and the cost math the
// campaign wizard's live preview + the send worker both rely on.
// Run: npx tsx script/test-sms-campaign.ts
import assert from "node:assert";
import {
  composeCampaignSmsBody, estimateCampaignSmsCostCents, campaignSmsCentsPerSegment,
  quietHoursDecision, getCampaignAllowUnicode, withCampaignAllowUnicode,
} from "../server/marketing/campaign-sms";
import { isQuietHours } from "../server/marketing/sms";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const ctx = { first_name: "Sam", last_name: "Jones", email: "sam@example.com", unsubscribe_url: "", preferences_url: "" };

console.log("campaign-sms — composeCampaignSmsBody");

test("marketing body gets the opt-out suffix appended", () => {
  const { finalBody } = composeCampaignSmsBody("Training moved to 6pm tonight.", ctx, { isMarketing: true, allowUnicode: false });
  assert.ok(finalBody.includes("Reply STOP to opt out"), finalBody);
});

test("transactional (isMarketing=false) body does NOT get the opt-out suffix", () => {
  const { finalBody } = composeCampaignSmsBody("Your order has shipped.", ctx, { isMarketing: false, allowUnicode: false });
  assert.ok(!finalBody.includes("Reply STOP to opt out"), finalBody);
});

test("merge tags render before sanitize/suffix", () => {
  const { finalBody } = composeCampaignSmsBody("Hi {{first_name}}, training moved!", ctx, { isMarketing: false, allowUnicode: false });
  assert.ok(finalBody.startsWith("Hi Sam, training moved!"), finalBody);
});

test("default (allowUnicode=false) sanitizes smart quotes/em-dash to plain GSM-7 equivalents", () => {
  const { finalBody, analysis, sanitizedRemoved } = composeCampaignSmsBody("It’s a “great” day—right?", ctx, { isMarketing: false, allowUnicode: false });
  assert.ok(finalBody.includes("It's"), finalBody);
  assert.strictEqual(analysis.encoding, "gsm7");
  assert.strictEqual(sanitizedRemoved.length, 0, "nothing should be REMOVED for mapped punctuation, only re-mapped");
});

test("default (allowUnicode=false) STRIPS an emoji and reports it in sanitizedRemoved", () => {
  const { finalBody, analysis, sanitizedRemoved } = composeCampaignSmsBody("See you at training \u{1F44B} 6pm!", ctx, { isMarketing: false, allowUnicode: false });
  assert.ok(!finalBody.includes("\u{1F44B}"), finalBody);
  assert.ok(sanitizedRemoved.includes("\u{1F44B}"));
  assert.strictEqual(analysis.encoding, "gsm7", "sanitized output must be guaranteed gsm7");
});

test("allowUnicode=true KEEPS the emoji and flips encoding to ucs2 (the cost trade-off is explicit, not accidental)", () => {
  const { finalBody, analysis, sanitizedRemoved } = composeCampaignSmsBody("See you at training \u{1F44B} 6pm!", ctx, { isMarketing: false, allowUnicode: true });
  assert.ok(finalBody.includes("\u{1F44B}"), finalBody);
  assert.strictEqual(analysis.encoding, "ucs2");
  assert.strictEqual(sanitizedRemoved.length, 0, "allowUnicode=true never sanitizes, so nothing is reported removed");
});

// ---------------------------------------------------------------------------
console.log("\ncampaign-sms — cost math");

test("estimateCampaignSmsCostCents matches segments x recipients x rate (2,040 recipients, 1 segment, 10c = $204.00)", () => {
  const prevEnv = process.env.SMS_COST_CENTS_PER_SEGMENT;
  delete process.env.SMS_COST_CENTS_PER_SEGMENT;
  delete process.env.SMS_CENTS_PER_SEGMENT;
  try {
    assert.strictEqual(campaignSmsCentsPerSegment(), 10, "default is 10c/segment");
    assert.strictEqual(estimateCampaignSmsCostCents(1, 2040), 20400);
  } finally {
    if (prevEnv !== undefined) process.env.SMS_COST_CENTS_PER_SEGMENT = prevEnv;
  }
});

test("campaignSmsCentsPerSegment reads SMS_COST_CENTS_PER_SEGMENT (the name every provider adapter actually reads)", () => {
  const prev = process.env.SMS_COST_CENTS_PER_SEGMENT;
  process.env.SMS_COST_CENTS_PER_SEGMENT = "15";
  try { assert.strictEqual(campaignSmsCentsPerSegment(), 15); }
  finally { if (prev === undefined) delete process.env.SMS_COST_CENTS_PER_SEGMENT; else process.env.SMS_COST_CENTS_PER_SEGMENT = prev; }
});

test("campaignSmsCentsPerSegment falls back to the legacy SMS_CENTS_PER_SEGMENT name when the primary is unset", () => {
  const prevA = process.env.SMS_COST_CENTS_PER_SEGMENT;
  const prevB = process.env.SMS_CENTS_PER_SEGMENT;
  delete process.env.SMS_COST_CENTS_PER_SEGMENT;
  process.env.SMS_CENTS_PER_SEGMENT = "12";
  try { assert.strictEqual(campaignSmsCentsPerSegment(), 12); }
  finally {
    if (prevA !== undefined) process.env.SMS_COST_CENTS_PER_SEGMENT = prevA;
    if (prevB === undefined) delete process.env.SMS_CENTS_PER_SEGMENT; else process.env.SMS_CENTS_PER_SEGMENT = prevB;
  }
});

test("multi-segment sends multiply correctly (3 segments x 500 recipients @ default 10c = $150.00)", () => {
  const prevA = process.env.SMS_COST_CENTS_PER_SEGMENT;
  const prevB = process.env.SMS_CENTS_PER_SEGMENT;
  delete process.env.SMS_COST_CENTS_PER_SEGMENT;
  delete process.env.SMS_CENTS_PER_SEGMENT;
  try { assert.strictEqual(estimateCampaignSmsCostCents(3, 500), 15000); }
  finally {
    if (prevA !== undefined) process.env.SMS_COST_CENTS_PER_SEGMENT = prevA;
    if (prevB !== undefined) process.env.SMS_CENTS_PER_SEGMENT = prevB;
  }
});

// ---------------------------------------------------------------------------
console.log("\ncampaign-sms — quietHoursDecision (whole-campaign reschedule)");

test("a daytime NZ instant (14:00 NZST, winter) is NOT rescheduled", () => {
  const daytime = new Date(Date.UTC(2026, 5, 15, 2, 0)); // 14:00 NZST (UTC+12)
  assert.strictEqual(isQuietHours(daytime), false);
  const d = quietHoursDecision(daytime);
  assert.strictEqual(d.reschedule, false);
  assert.strictEqual(d.runAt.getTime(), daytime.getTime());
});

test("an evening NZ instant (22:00 NZST, winter) IS rescheduled to the next sendable (08:00 NZ) instant", () => {
  const evening = new Date(Date.UTC(2026, 5, 15, 10, 0)); // 22:00 NZST (UTC+12)
  assert.strictEqual(isQuietHours(evening), true);
  const d = quietHoursDecision(evening);
  assert.strictEqual(d.reschedule, true);
  assert.strictEqual(isQuietHours(d.runAt), false, "the rescheduled time must itself be sendable");
  assert.ok(d.runAt.getTime() > evening.getTime());
});

test("a pre-dawn NZ instant (03:00 NZST, winter) is rescheduled to 08:00 the SAME NZ calendar day", () => {
  const predawn = new Date(Date.UTC(2026, 5, 14, 15, 0)); // 03:00 NZST next day (UTC+12)
  const d = quietHoursDecision(predawn);
  assert.strictEqual(d.reschedule, true);
  const parts = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(d.runAt);
  const hour = parts.find((p) => p.type === "hour")?.value;
  assert.strictEqual(hour, "08");
});

// ---------------------------------------------------------------------------
console.log("\ncampaign-sms — allowUnicode read/write on the audience jsonb");

test("getCampaignAllowUnicode defaults false for an empty/missing audience object", () => {
  assert.strictEqual(getCampaignAllowUnicode(undefined), false);
  assert.strictEqual(getCampaignAllowUnicode({}), false);
  assert.strictEqual(getCampaignAllowUnicode({ include: [{ type: "all" }] }), false);
});

test("withCampaignAllowUnicode merges smsOptions without disturbing include/exclude", () => {
  const original = { include: [{ type: "all" }], exclude: [{ type: "list", id: 5 }] };
  const merged = withCampaignAllowUnicode(original, true);
  assert.deepStrictEqual((merged as any).include, original.include);
  assert.deepStrictEqual((merged as any).exclude, original.exclude);
  assert.strictEqual(getCampaignAllowUnicode(merged), true);
});

test("round trip: write true, read true; write false, read false", () => {
  const a = withCampaignAllowUnicode({}, true);
  assert.strictEqual(getCampaignAllowUnicode(a), true);
  const b = withCampaignAllowUnicode(a, false);
  assert.strictEqual(getCampaignAllowUnicode(b), false);
});

// ---------------------------------------------------------------------------
if (process.exitCode) {
  console.error("\n✗ sms-campaign tests FAILED");
} else {
  console.log(`\n✓ all ${passed} sms-campaign tests passed`);
}
