/**
 * Live check of the Mainland Football result fetcher against real, finished
 * 2026 Southern League matches. Hits their public API — run it when the feed's
 * shape is in doubt. Usage: npx tsx script/test-mainland-football.ts
 */
import assert from "node:assert";
import { fetchMainlandFootballResult, formatPlayerName, tidyTeamName } from "../server/mainland-football";
import { PREDICTOR_OWN_GOAL } from "../shared/predictor-scoring";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  console.log("mainland-football (live API)");

  await test("formatPlayerName tidies the club's inconsistent casing", () => {
    assert.strictEqual(formatPlayerName("Mason", "STEARN"), "Mason Stearn");
    assert.strictEqual(formatPlayerName("Nicolas", "MONTOYA BERRY"), "Nicolas Montoya Berry");
    assert.strictEqual(formatPlayerName("oliver", "grosso"), "Oliver Grosso");
    assert.strictEqual(formatPlayerName("Ry", "Mcleod"), "Ry McLeod");
    assert.strictEqual(formatPlayerName("Ry", "MCLEOD"), "Ry McLeod");
    assert.strictEqual(formatPlayerName("Jamie", "Wildash-Chan"), "Jamie Wildash-Chan");
    assert.strictEqual(formatPlayerName("Samuel", "Mahlamaki"), "Samuel Mahlamaki");
  });

  await test("tidyTeamName strips trailing spaces and 'FC', but keeps 'AFC'", () => {
    assert.strictEqual(tidyTeamName("Coastal Spirit FC "), "Coastal Spirit");
    assert.strictEqual(tidyTeamName("Ferrymead Bays "), "Ferrymead Bays");
    assert.strictEqual(tidyTeamName("Northern AFC"), "Northern AFC");
    assert.strictEqual(tidyTeamName("Nomads United"), "Nomads United");
  });

  // CUFC 4-1 Selwyn United, 20 June 2026. Ernest Boyers hat-trick (30', 37',
  // 48'); Selwyn's only goal was an own goal by a CUFC player on 23'.
  await test("CUFC 4-1 Selwyn: hat-trick read, own goal credited to the opposition", async () => {
    const r = await fetchMainlandFootballResult("6194804");
    assert.ok(r, "expected a published result");
    assert.strictEqual(r!.cufcScore, 4);
    assert.strictEqual(r!.opponentScore, 1);
    assert.strictEqual(r!.opponent, "Selwyn United");
    assert.strictEqual(r!.cufcIsHome, true);
    assert.strictEqual(r!.goalscorers.length, 4, "four United goals");
    assert.strictEqual(r!.goalscorers[0], "Ernest Boyers", "Boyers opened the scoring on 30'");
    assert.strictEqual(r!.goalscorers.filter((g) => g === "Ernest Boyers").length, 3, "a hat-trick");
    assert.ok(!r!.goalscorers.includes(PREDICTOR_OWN_GOAL), "the own goal was Selwyn's, not United's");
    assert.strictEqual(r!.firstGoalMinute, 30);
  });

  // Nomads United 0-0 Christchurch United, 27 June 2026 (CUFC away).
  await test("0-0 draw: no scorers, no first-goal minute", async () => {
    const r = await fetchMainlandFootballResult("6194810");
    assert.ok(r);
    assert.strictEqual(r!.cufcScore, 0);
    assert.strictEqual(r!.opponentScore, 0);
    assert.strictEqual(r!.cufcIsHome, false);
    assert.deepStrictEqual(r!.goalscorers, []);
    assert.strictEqual(r!.firstGoalMinute, null);
  });

  // CUFC 0-2 Coastal Spirit, 23 May 2026 — United kept out at home.
  await test("United kept out: zero scorers, opposition score read correctly", async () => {
    const r = await fetchMainlandFootballResult("6194794");
    assert.ok(r);
    assert.strictEqual(r!.cufcScore, 0);
    assert.strictEqual(r!.opponentScore, 2);
    assert.deepStrictEqual(r!.goalscorers, []);
    assert.strictEqual(r!.firstGoalMinute, null);
  });

  // An unplayed fixture publishes no score.
  await test("an unplayed fixture returns null rather than a fake 0-0", async () => {
    const r = await fetchMainlandFootballResult("6194814"); // Ferrymead Bays, 11 Jul
    assert.strictEqual(r, null);
  });

  console.log(`\n${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
