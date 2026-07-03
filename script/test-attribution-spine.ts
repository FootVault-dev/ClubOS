// Standalone proof of the AttributionOS cookie/param spine (T4). No DB / network / Express.
//   npx tsx script/test-attribution-spine.ts
//
// Covers the pure cookie + click-id logic behind server/attribution-cookies.ts:
//   - Cookie header parsing (quoting, url-encoding, malformed pairs)
//   - Visitor / click id validation (url-safe charset, illegal-id blocklist, macros)
//   - decideAttributionCookies: mint-when-absent, reuse-when-present (sliding window),
//     ?ci= seeds/overrides usg_cid, invalid ?ci= falls back to the existing cookie,
//     no click id → no usg_cid cookie, header-injection ids rejected
//   - serializeSetCookie: attributes present, HttpOnly ABSENT, Secure toggle, encoding

import {
  parseCookieHeader,
  isValidVisitorId,
  isValidClickId,
  decideAttributionCookies,
  serializeSetCookie,
  VID_COOKIE,
  CID_COOKIE,
  VID_MAX_AGE_SECONDS,
  CID_MAX_AGE_SECONDS,
  type SetCookieSpec,
} from "../server/attribution-cookies";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    if (fails.length < 40) fails.push(msg);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  check(actual === expected, `${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// A fixed generator so the decision output is deterministic in tests.
const MINT = "11111111-2222-4333-8444-555555555555";
const mint = () => MINT;

// ── parseCookieHeader ────────────────────────────────────────────────────────
{
  const c = parseCookieHeader("usg_vid=abc123def456; usg_cid=CLICKid_-9; other=x");
  eq(c[VID_COOKIE], "abc123def456", "parse: reads usg_vid");
  eq(c[CID_COOKIE], "CLICKid_-9", "parse: reads usg_cid");
  eq(c["other"], "x", "parse: reads unrelated cookie");
}
eq(Object.keys(parseCookieHeader(undefined)).length, 0, "parse: undefined → empty map");
eq(Object.keys(parseCookieHeader("")).length, 0, "parse: empty string → empty map");
eq(Object.keys(parseCookieHeader("garbagewithoutequals")).length, 0, "parse: malformed pair skipped");
{
  // url-encoded value is decoded; surrounding quotes stripped; whitespace trimmed
  const c = parseCookieHeader('  a=%20sp%20 ; b="quoted"');
  eq(c["a"], " sp ", "parse: decodes %20");
  eq(c["b"], "quoted", "parse: strips surrounding quotes");
}
{
  // an invalid percent-encoding must not throw — raw value kept
  const c = parseCookieHeader("x=%E0%A4%A");
  check(typeof c["x"] === "string", "parse: bad %-encoding kept raw, no throw");
}

// ── isValidVisitorId ─────────────────────────────────────────────────────────
check(isValidVisitorId(MINT), "vid: a real uuid is valid");
check(isValidVisitorId("abc123def456"), "vid: url-safe 12-char id valid");
check(!isValidVisitorId(""), "vid: empty invalid");
check(!isValidVisitorId("short"), "vid: <8 chars invalid");
check(!isValidVisitorId("undefined"), "vid: illegal id 'undefined' invalid");
check(!isValidVisitorId("null"), "vid: illegal id 'null' invalid");
check(!isValidVisitorId("has space here"), "vid: whitespace invalid");
check(!isValidVisitorId("evil;Path=/;x"), "vid: semicolons (header injection) invalid");
check(!isValidVisitorId("{{visitor}}"), "vid: unreplaced macro invalid");
check(!isValidVisitorId("a".repeat(65)), "vid: >64 chars invalid");
check(!isValidVisitorId(12345 as unknown), "vid: non-string invalid");

// ── isValidClickId ───────────────────────────────────────────────────────────
check(isValidClickId("Ab12_-Cd34ef"), "cid: url-safe base64 valid");
check(isValidClickId("x"), "cid: single char valid (min length 1)");
check(!isValidClickId(""), "cid: empty invalid");
check(!isValidClickId("guest"), "cid: illegal id 'guest' invalid");
check(!isValidClickId("a,b"), "cid: comma (Set-Cookie separator) invalid");
check(!isValidClickId("a\nb"), "cid: newline (header injection) invalid");
check(!isValidClickId("has space"), "cid: space invalid");
check(!isValidClickId("{{click}}"), "cid: macro invalid");

// ── decideAttributionCookies: mint when absent ───────────────────────────────
{
  const d = decideAttributionCookies({ cookies: {}, mintVisitorId: mint });
  eq(d.visitorId, MINT, "decide: mints a new vid when none present");
  eq(d.clickId, null, "decide: no click id when none present");
  eq(d.setCookies.length, 1, "decide: only the vid cookie is set (no cid)");
  const vid = d.setCookies.find((c) => c.name === VID_COOKIE)!;
  eq(vid.value, MINT, "decide: vid cookie carries the minted id");
  eq(vid.maxAgeSeconds, VID_MAX_AGE_SECONDS, "decide: vid cookie has 2y max-age");
}

// ── decideAttributionCookies: reuse existing vid (sliding window) ─────────────
{
  const d = decideAttributionCookies({ cookies: { [VID_COOKIE]: "existingVid123" }, mintVisitorId: mint });
  eq(d.visitorId, "existingVid123", "decide: reuses a valid existing vid");
  const vid = d.setCookies.find((c) => c.name === VID_COOKIE)!;
  eq(vid.value, "existingVid123", "decide: re-issues the existing vid to slide the window");
}

// ── decideAttributionCookies: corrupt existing vid → mint fresh ──────────────
{
  const d = decideAttributionCookies({ cookies: { [VID_COOKIE]: "undefined" }, mintVisitorId: mint });
  eq(d.visitorId, MINT, "decide: illegal existing vid is replaced with a fresh one");
}

// ── decideAttributionCookies: ?ci= seeds usg_cid ─────────────────────────────
{
  const d = decideAttributionCookies({ cookies: {}, ciParam: "Click_ABC-123", mintVisitorId: mint });
  eq(d.clickId, "Click_ABC-123", "decide: ?ci= becomes the click id");
  const cid = d.setCookies.find((c) => c.name === CID_COOKIE)!;
  eq(cid.value, "Click_ABC-123", "decide: cid cookie carries ?ci=");
  eq(cid.maxAgeSeconds, CID_MAX_AGE_SECONDS, "decide: cid cookie has 90d max-age");
}

// ── decideAttributionCookies: ?ci= OVERRIDES an existing cid cookie ──────────
{
  const d = decideAttributionCookies({
    cookies: { [CID_COOKIE]: "oldClick" },
    ciParam: "newClick",
    mintVisitorId: mint,
  });
  eq(d.clickId, "newClick", "decide: fresh ?ci= overrides the stored click id");
}

// ── decideAttributionCookies: invalid ?ci= falls back to existing cid ────────
{
  const d = decideAttributionCookies({
    cookies: { [CID_COOKIE]: "keptClick" },
    ciParam: "{{ad.id}}",
    mintVisitorId: mint,
  });
  eq(d.clickId, "keptClick", "decide: macro ?ci= ignored, existing cid kept");
}

// ── decideAttributionCookies: injection ?ci= rejected entirely ───────────────
{
  const d = decideAttributionCookies({ cookies: {}, ciParam: "evil;Domain=evil.com", mintVisitorId: mint });
  eq(d.clickId, null, "decide: header-injection ?ci= rejected, no cid set");
  check(!d.setCookies.some((c) => c.name === CID_COOKIE), "decide: no cid cookie for injection attempt");
}

// ── serializeSetCookie ───────────────────────────────────────────────────────
{
  const spec: SetCookieSpec = { name: VID_COOKIE, value: MINT, maxAgeSeconds: VID_MAX_AGE_SECONDS };
  const secure = serializeSetCookie(spec, { secure: true });
  check(secure.startsWith(`${VID_COOKIE}=${MINT}`), "serialize: name=value first");
  check(secure.includes("Path=/"), "serialize: Path=/ present");
  check(secure.includes(`Max-Age=${VID_MAX_AGE_SECONDS}`), "serialize: Max-Age present");
  check(secure.includes("SameSite=Lax"), "serialize: SameSite=Lax present");
  check(secure.includes("Secure"), "serialize: Secure present when secure=true");
  check(!/httponly/i.test(secure), "serialize: HttpOnly ABSENT (client must read it)");

  const insecure = serializeSetCookie(spec, { secure: false });
  check(!insecure.includes("Secure"), "serialize: Secure omitted when secure=false");

  const dflt = serializeSetCookie(spec);
  check(dflt.includes("Secure"), "serialize: Secure on by default");
}
{
  // a value with a special char is percent-encoded (defence-in-depth even though
  // validation already restricts the charset)
  const s = serializeSetCookie({ name: CID_COOKIE, value: "a b", maxAgeSeconds: 10 });
  check(s.includes("a%20b"), "serialize: value is url-encoded");
}

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\nattribution-spine: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFailures:");
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log("✓ all attribution-spine assertions passed");
