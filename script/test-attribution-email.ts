// T14 — email link instrumentation tests. Pure logic, no DB, no network.
// Run: npx tsx script/test-attribution-email.ts   (exits non-zero on failure)

import assert from "node:assert";
import {
  instrumentUrl,
  instrumentEmailHtml,
  slugifyEmailCampaign,
  EMAIL_CI_PREFIX,
} from "../shared/email-attribution";

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
}
function eq(a: unknown, b: unknown, msg: string) {
  assert.strictEqual(a, b, `${msg}\n  got:      ${a}\n  expected: ${b}`);
  passed++;
}

const T = { source: "email", medium: "transactional" as const, campaign: "mfl-league-confirmation" };
const B = { source: "email", medium: "broadcast" as const, campaign: "42", ci: `${EMAIL_CI_PREFIX}Ab_cD-1234567890` };

// ── instrumentUrl: our domains get stamped ──────────────────────────────────
{
  const out = instrumentUrl("https://join.minifootball.co.nz/league", T);
  ok(out.includes("utm_source=email"), "adds utm_source");
  ok(out.includes("utm_medium=transactional"), "adds utm_medium");
  ok(out.includes("utm_campaign=mfl-league-confirmation"), "adds utm_campaign");
  ok(out.startsWith("https://join.minifootball.co.nz/league?"), "query starts with ?");
  ok(!out.includes("ci="), "no ci when not supplied (transactional)");
}

// ── ci is appended for broadcasts ───────────────────────────────────────────
{
  const out = instrumentUrl("https://cicyouth.com/register", B);
  ok(out.includes(`ci=${EMAIL_CI_PREFIX}Ab_cD-1234567890`), "broadcast ci appended verbatim (url-safe token)");
  ok(out.includes("utm_medium=broadcast"), "broadcast medium");
  ok(out.includes("utm_campaign=42"), "campaign id as-is");
}

// ── external / non-http links untouched ─────────────────────────────────────
eq(instrumentUrl("https://www.instagram.com/unitedgymnasticsnz/", B),
   "https://www.instagram.com/unitedgymnasticsnz/", "external host untouched");
eq(instrumentUrl("https://evil.com/minifootball.co.nz", B),
   "https://evil.com/minifootball.co.nz", "look-alike host untouched");
eq(instrumentUrl("mailto:info@cufc.co.nz", B), "mailto:info@cufc.co.nz", "mailto untouched");
eq(instrumentUrl("tel:+6421535005", B), "tel:+6421535005", "tel untouched");
eq(instrumentUrl("#top", B), "#top", "anchor untouched");
eq(instrumentUrl("/relative/path", B), "/relative/path", "relative untouched");

// ── /api links (unsubscribe etc.) are left alone ────────────────────────────
{
  const unsub = "https://join.minifootball.co.nz/api/public/unsubscribe?o=3&e=a%40b.co&t=abc123";
  eq(instrumentUrl(unsub, B), unsub, "/api/* link (unsubscribe) untouched");
}

// ── all our root brands recognised ──────────────────────────────────────────
for (const host of ["cugc.co.nz", "app.usg.co.nz", "christchurchunited.co.nz", "footballinstitute.co.nz", "unitedprints.co.nz", "southislandunited.com"]) {
  ok(instrumentUrl(`https://${host}/x`, T).includes("utm_source=email"), `stamps ${host}`);
}

// ── idempotency: running twice adds nothing new ─────────────────────────────
{
  const once = instrumentUrl("https://join.minifootball.co.nz/league", B);
  const twice = instrumentUrl(once, B);
  eq(twice, once, "instrumentUrl is idempotent");
  // count occurrences of utm_source — must be exactly one
  eq((twice.match(/utm_source=/g) || []).length, 1, "no duplicate utm_source");
  eq((twice.match(/ci=/g) || []).length, 1, "no duplicate ci");
}

// ── existing query params preserved, ours appended after ────────────────────
{
  const out = instrumentUrl("https://join.minifootball.co.nz/league?team=Lions&night=Tue", T);
  ok(out.includes("team=Lions"), "keeps existing param team");
  ok(out.includes("night=Tue"), "keeps existing param night");
  ok(out.includes("&utm_source=email"), "appends with & after existing query");
}

// ── an existing utm_source is NOT overwritten (idempotent per-param) ─────────
{
  const out = instrumentUrl("https://join.minifootball.co.nz/league?utm_source=poster", T);
  ok(out.includes("utm_source=poster"), "pre-set utm_source kept");
  ok(!out.includes("utm_source=email"), "does not add a second utm_source");
  ok(out.includes("utm_medium=transactional"), "still adds the missing utm_medium");
}

// ── &amp;-encoded existing query is treated as one query (idempotency holds) ─
{
  const withAmp = "https://join.minifootball.co.nz/l?a=1&amp;utm_source=x";
  const out = instrumentUrl(withAmp, T);
  ok(!/utm_source=email/.test(out), "&amp;utm_source recognised — not duplicated");
}

// ── fragment is preserved at the end ────────────────────────────────────────
{
  const out = instrumentUrl("https://cugc.co.nz/enrol#form", T);
  ok(out.endsWith("#form"), "fragment stays at the end");
  ok(out.includes("utm_source=email"), "params inserted before fragment");
  ok(out.indexOf("#form") > out.indexOf("utm_source"), "params before hash");
}

// ── instrumentEmailHtml rewrites hrefs, leaves the rest ─────────────────────
{
  const html = `
    <a href="https://join.minifootball.co.nz/league">Play</a>
    <a href='https://www.facebook.com/chchunitedRG/'>FB</a>
    <img src="https://join.minifootball.co.nz/logo.png" />
    <a href="https://join.minifootball.co.nz/api/public/unsubscribe?o=3&e=x&t=y">Unsub</a>`;
  const out = instrumentEmailHtml(html, B);
  eq((out.match(/utm_source=email/g) || []).length, 1, "only the one ours-landing href rewritten");
  ok(out.includes('href="https://join.minifootball.co.nz/league?'), "double-quoted href rewritten");
  ok(out.includes("https://www.facebook.com/chchunitedRG/"), "external href unchanged");
  ok(out.includes('src="https://join.minifootball.co.nz/logo.png"'), "img src NOT touched");
  ok(out.includes("/api/public/unsubscribe?o=3&e=x&t=y"), "unsub href unchanged");
}

// ── single-quoted hrefs handled ─────────────────────────────────────────────
{
  const out = instrumentEmailHtml(`<a href='https://cugc.co.nz/x'>x</a>`, T);
  ok(out.includes("utm_source=email"), "single-quoted href rewritten");
  ok(/href='https:\/\/cugc\.co\.nz\/x\?/.test(out), "single quotes preserved");
}

// ── whole-html idempotency ──────────────────────────────────────────────────
{
  const html = `<a href="https://join.minifootball.co.nz/league">go</a>`;
  const once = instrumentEmailHtml(html, B);
  const twice = instrumentEmailHtml(once, B);
  eq(twice, once, "instrumentEmailHtml idempotent");
}

// ── empty / missing campaign omits utm_campaign ─────────────────────────────
{
  const out = instrumentUrl("https://cugc.co.nz/x", { source: "email", medium: "transactional", campaign: "" });
  ok(out.includes("utm_source=email"), "still stamps source");
  ok(!out.includes("utm_campaign"), "empty campaign omitted");
}

// ── campaign value with spaces/odd chars is url-encoded ─────────────────────
{
  const out = instrumentUrl("https://cugc.co.nz/x", { source: "email", medium: "transactional", campaign: "term 3 & camps" });
  ok(!out.includes("term 3 & camps"), "raw spaces/ampersand not left in query");
  ok(out.includes("utm_campaign=term%203%20%26%20camps"), "campaign url-encoded");
}

// ── slugifyEmailCampaign ────────────────────────────────────────────────────
eq(slugifyEmailCampaign("Term 3 — MFL!"), "term-3-mfl", "slugify collapses punctuation");
eq(slugifyEmailCampaign("  Hello  World  "), "hello-world", "slugify trims + dashes");
eq(slugifyEmailCampaign(""), "", "slugify empty");
eq(slugifyEmailCampaign(null), "", "slugify null");

// ── non-string / empty html guards ──────────────────────────────────────────
eq(instrumentEmailHtml("", B), "", "empty html returns empty");
eq(instrumentEmailHtml(null as any, B), null, "null html passes through");
eq(instrumentUrl(null as any, B), null, "null url passes through");

console.log(`\n✓ email instrumentation: ${passed} assertions passed`);
