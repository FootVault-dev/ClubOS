/**
 * _verify-checkout-live.ts — does PRODUCTION still have a working card checkout?
 *
 * Why this exists (2026-09-03). Vite inlines VITE_* at BUILD time, so the Stripe
 * publishable key is baked into the client bundle. A deploy that does not pass
 * `--build-arg VITE_STRIPE_PUBLISHABLE_KEY` compiles
 *
 *     loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "")
 *
 * down to `loadStripe("")`. Stripe never initialises, the Payment Element never
 * mounts, and the checkout step renders and simply sits there. Every card
 * checkout in ClubOS — camps, academy, membership, shop, venue, team pay — dies
 * at once, and it is INVISIBLE to a route probe: every endpoint still answers
 * 200, the booking row is still written, the PaymentIntent is still created.
 * The only symptom is that no human can ever reach a card field, which surfaces
 * as parents emailing the office days later.
 *
 * deploy.sh already refused to ship without the key in .env. That guards the
 * INPUT. Nothing asserted the OUTPUT, and the build args were dropped by a
 * deploy that went around the script. This asserts the output.
 *
 *   npx tsx --env-file=.env script/_verify-checkout-live.ts
 *   npx tsx --env-file=.env script/_verify-checkout-live.ts https://app.usg.co.nz
 */
const HOSTS = process.argv[2]
  ? [process.argv[2]]
  : ["https://app.usg.co.nz", "https://join.cufc.co.nz"];

const expected = (process.env.VITE_STRIPE_PUBLISHABLE_KEY || "").trim();
let failed = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failed++; console.log(`  FAIL ${m}`); };

for (const host of HOSTS) {
  console.log(`\n${host}`);
  let html: string;
  try {
    const r = await fetch(host, { redirect: "follow" });
    if (!r.ok) { bad(`${host} answered ${r.status}`); continue; }
    html = await r.text();
  } catch (e: any) { bad(`could not reach ${host}: ${e.message}`); continue; }

  const asset = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
  if (!asset) { bad("no /assets/index-*.js referenced by the page"); continue; }
  ok(`bundle ${asset}`);

  let js: string;
  try { js = await (await fetch(host + asset)).text(); }
  catch (e: any) { bad(`could not fetch the bundle: ${e.message}`); continue; }

  // 1. A real publishable key must be present.
  const keys = [...new Set(js.match(/pk_live_[A-Za-z0-9]{20,}/g) || [])];
  if (keys.length === 0) bad("NO Stripe publishable key in the shipped bundle — every card checkout is dead");
  else ok(`Stripe key present (${keys[0].slice(0, 11)}…, ${keys.length} distinct)`);

  // 2. It must be OUR key, not some other account's.
  if (expected && keys.length && !keys.includes(expected)) {
    bad(`shipped key does not match .env — prod would take money into the wrong Stripe account`);
  } else if (expected && keys.length) ok("shipped key matches .env");

  // 3. No checkout may be constructed with an empty key. `loadStripe` is
  //    minified to a short alias, so match the call shape: <ident>("") assigned
  //    to a module constant right where the Stripe promise is built.
  const emptyInits = js.match(/=\s*[A-Za-z_$][\w$]*\(""\)\s*[,;]/g) || [];
  if (emptyInits.length && keys.length === 0) {
    bad(`${emptyInits.length} checkout(s) initialised with an empty key`);
  } else if (emptyInits.length) {
    ok(`${emptyInits.length} empty-arg init(s) present but a real key ships too (verify if this grows)`);
  } else ok("no empty-key initialisation");
}

console.log(
  failed === 0
    ? "\n✓ Card checkout can mount on production.\n"
    : `\n✗ ${failed} check(s) failed — production cannot take a card payment.\n`,
);
process.exit(failed === 0 ? 0 : 1);
