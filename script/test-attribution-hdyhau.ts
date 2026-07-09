// T17 — HDYHAU capture: prove the success-screen option vocabulary stays aligned
// with the classifier. Run: `npx tsx script/test-attribution-hdyhau.ts` (exits
// non-zero on failure). No DB / network — pure logic only.
import assert from "node:assert";
import { HDYHAU_OPTIONS, mapHdyhauToChannel, normalizeHdyhauAnswer } from "../shared/attribution";

let count = 0;
function check(name: string, fn: () => void) {
  fn();
  count++;
}

// Every option id must resolve to its declared canonical channel — this is the
// contract the reporting waterfall (T18) relies on. If someone renames an option
// id in the UI, this fails.
for (const opt of HDYHAU_OPTIONS) {
  check(`option ${opt.id} → ${opt.channel}`, () => {
    assert.strictEqual(
      mapHdyhauToChannel(opt.id),
      opt.channel,
      `HDYHAU option "${opt.id}" should map to channel "${opt.channel}" but got "${mapHdyhauToChannel(opt.id)}"`,
    );
  });
}

// The 8 required T17 options are all present, in a stable set.
check("all 8 required options present", () => {
  const ids = HDYHAU_OPTIONS.map((o) => o.id).sort();
  assert.deepStrictEqual(ids, [
    "email", "facebook", "friend_teammate", "google", "instagram", "other", "poster_qr", "whatsapp",
  ].sort());
});

// Labels are non-empty (rendered directly in the UI).
check("labels are non-empty", () => {
  for (const o of HDYHAU_OPTIONS) assert.ok(o.label && o.label.length > 0, `${o.id} needs a label`);
});

// normalizeHdyhauAnswer rejects junk the endpoint must not write.
check("normalize rejects empty / whitespace", () => {
  assert.strictEqual(normalizeHdyhauAnswer(""), null);
  assert.strictEqual(normalizeHdyhauAnswer("   "), null);
  assert.strictEqual(normalizeHdyhauAnswer(null), null);
  assert.strictEqual(normalizeHdyhauAnswer(undefined), null);
  assert.strictEqual(normalizeHdyhauAnswer(123 as unknown), null);
});
// Strict whitelist (verifier MAJOR-2 fix): free text NEVER passes — only exact
// HDYHAU_OPTIONS ids survive (case-insensitively). The public endpoint must not
// persist arbitrary strings.
check("normalize rejects all free text", () => {
  assert.strictEqual(normalizeHdyhauAnswer("x".repeat(201)), null);
  assert.strictEqual(normalizeHdyhauAnswer("x".repeat(200)), null);
  assert.strictEqual(normalizeHdyhauAnswer("my mate told me"), null);
  assert.strictEqual(normalizeHdyhauAnswer("<script>alert(1)</script>"), null);
});
check("normalize accepts every option id, trimmed + case-insensitive", () => {
  assert.strictEqual(normalizeHdyhauAnswer("  friend_teammate  "), "friend_teammate");
  assert.strictEqual(normalizeHdyhauAnswer("FACEBOOK"), "facebook");
  for (const opt of HDYHAU_OPTIONS) {
    assert.strictEqual(normalizeHdyhauAnswer(opt.id), opt.id);
  }
});

// Free-text "Other: ..." still classifies as other (parents may type anything).
check("free-text other classifies to other", () => {
  assert.strictEqual(mapHdyhauToChannel("Other: saw the van"), "other");
  assert.strictEqual(mapHdyhauToChannel("my nephew plays"), "other");
});

console.log(`\n✅ HDYHAU capture: ${count} assertions passed`);
