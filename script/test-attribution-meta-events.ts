// T15 — deterministic Meta Purchase event ids.
// Run: npx tsx script/test-attribution-meta-events.ts   (exits non-zero on failure)
import assert from "node:assert";
import { purchaseEventId, venuePurchaseEventId } from "../shared/meta-events";

let n = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  n++;
}
function eq(a: unknown, b: unknown, msg: string) {
  assert.strictEqual(a, b, `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
  n++;
}

// --- Deterministic: same input → same id, no timestamp/randomness ---------
eq(purchaseEventId(123), "purchase_123", "registrations numeric id");
eq(purchaseEventId("123"), "purchase_123", "registrations string id normalises identically");
eq(purchaseEventId(123), purchaseEventId(123), "repeat call is stable");
ok(!/\d{10,}/.test(purchaseEventId(1)), "no unix-timestamp baked into the id");
ok(!purchaseEventId(1).includes("_", "purchase_1".length), "no extra random suffix segment");

// Browser and server derive the SAME id from the same registrationId — the
// whole point of dedup. Simulate both sides computing it independently.
const regId = 987;
eq(purchaseEventId(regId), purchaseEventId(String(regId)), "browser(string) == server(number)");

// --- Venue: namespaced, deterministic ------------------------------------
eq(venuePurchaseEventId("grp_abc"), "purchase_venue_grp_abc", "venue group id");
eq(venuePurchaseEventId("grp_abc"), venuePurchaseEventId("grp_abc"), "venue repeat is stable");

// --- Cross-table collision guard -----------------------------------------
// A registrations row #100 and a venue booking-group "100" must NOT share an id.
ok(purchaseEventId(100) !== venuePurchaseEventId("100"), "registration 100 != venue group 100");
eq(purchaseEventId(100), "purchase_100", "registration 100");
eq(venuePurchaseEventId("100"), "purchase_venue_100", "venue group 100 is namespaced");

// Two different registrations never collide; two venue groups never collide.
ok(purchaseEventId(1) !== purchaseEventId(2), "distinct registrations → distinct ids");
ok(venuePurchaseEventId("a") !== venuePurchaseEventId("b"), "distinct venue groups → distinct ids");

console.log(`✓ meta-events: ${n} assertions passed`);
