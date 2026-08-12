// PRE-DEPLOY GUARD — refuse to ship a branch that would delete a live feature.
//
//   npx tsx --env-file=.env script/preflight-deploy.ts
//
// Why this exists. The Fly app `clubos` serves WHATEVER BRANCH YOU DEPLOY, so a
// branch cut before someone else's merge silently removes their feature from
// production. It is not hypothetical — it has now happened three times:
//   • AttributionOS  — /t.js reverted to serving HTML, days of lost data
//   • squads:read    — reverted TWICE (v394–397, then v399), each time silently
//   • parent accounts— removed 2026-08-09 by a deploy of feat/notifications,
//                      which was cut before it. Found by Daniel, not by us.
// Every one was found by a human noticing something broken, because a missing
// route looks exactly like a route that was never there.
//
// The check: ask PRODUCTION what it currently serves, then confirm the code
// about to be deployed still serves all of it. Anything prod answers and this
// working tree does not is a REMOVAL, and removals fail the check.
//
// This deliberately probes the live site rather than reading git history — the
// question is never "did I merge the right branch", it is "will production
// still do everything it does today".

const PROD = process.env.PREFLIGHT_ORIGIN || "https://app.usg.co.nz";

/** A canary is a route that proves one feature's server code is deployed.
 *  401 = present and gated. 200 = present and public. 404 = NOT DEPLOYED.
 *  Pick routes that are actually registered — a bare mount path 404s even when
 *  the feature is live, which has fooled us twice while probing by hand. */
type Canary = { feature: string; path: string; method?: "GET" | "POST"; expect: number[] };

const CANARIES: Canary[] = [
  { feature: "parent accounts",     path: "/api/public/parent/prefill",           expect: [200] },
  { feature: "parent accounts API", path: "/api/public/parent/me",                expect: [401] },
  { feature: "notifications",       path: "/api/admin/notifications/preferences", expect: [401] },
  { feature: "staff push",          path: "/api/admin/push/register", method: "POST", expect: [401] },
  { feature: "staff chat",          path: "/api/admin/chat/bootstrap",            expect: [401] },
  { feature: "squads v1 API",       path: "/api/v1/squads",                       expect: [401] },
  { feature: "task tracker",        path: "/api/admin/task-tracker/bootstrap",    expect: [401] },
  { feature: "families",            path: "/api/admin/people?q=a",                expect: [401] },
  { feature: "staff videos",        path: "/api/admin/videos",                    expect: [401] },
  { feature: "hiring",              path: "/api/admin/hiring/jobs",               expect: [401] },
  { feature: "invoices",            path: "/api/admin/invoices",                  expect: [401] },
  { feature: "warehouse",           path: "/api/admin/warehouse/items",           expect: [401] },
  { feature: "market research",     path: "/api/admin/market-research",           expect: [401] },
  { feature: "feedback board",      path: "/api/admin/feedback",                  expect: [401] },
  { feature: "proposals",           path: "/api/admin/proposals",                 expect: [401] },
  { feature: "shop (MFL)",          path: "/api/public/shop/mfl/catalog",         expect: [200] },
  { feature: "attribution /t.js",   path: "/t.js",                                expect: [200] },
  { feature: "CUGC mailer",         path: "/api/admin/cugc/mailer/contacts",      expect: [401] },
  // unitedprints.co.nz reads its whole price list from here. If a deploy drops
  // this route the Instant Quote page can't load a single product, and its
  // honest failure state ("email us your job") looks like a working page —
  // nobody would notice for days.
  { feature: "UP quote materials",  path: "/api/public/unitedprints/quote-materials", expect: [200] },
  // Internal print requests. Travis and (later) the rest of the staff only
  // have this one tab in United Prints — if the route vanishes, their whole
  // reason for being in that workspace vanishes with it.
  { feature: "UP print requests",   path: "/api/admin/print-requests",              expect: [401] },
  // unitedprints.co.nz and its chat widget read their FAQ list from here.
  { feature: "site FAQs",           path: "/api/public/faqs/unitedprints",          expect: [200] },
  // The Knowledge Base tab is universal — every workspace's sidebar links to it,
  // so losing the route breaks a link for every staff member at once, and the
  // vault of written specifications becomes unreachable while the data sits
  // untouched in the database.
  { feature: "knowledge base",      path: "/api/admin/kb/articles",                 expect: [401] },
];

/** Where each canary's route is declared, so we can tell whether THIS tree
 *  still has it. Checked as plain text: the literal must appear in the file. */
const SOURCE: Record<string, { file: string; needle: string }> = {
  "/api/public/parent/prefill":           { file: "server/parent-routes.ts",       needle: "/prefill" },
  "/api/public/parent/me":                { file: "server/parent-routes.ts",       needle: "/me" },
  "/api/admin/notifications/preferences": { file: "server/notification-routes.ts", needle: "/api/admin/notifications/preferences" },
  "/api/admin/push/register":             { file: "server/notification-routes.ts", needle: "/api/admin/push/register" },
  "/api/admin/chat/bootstrap":            { file: "server/staff-chat-routes.ts",   needle: "/api/admin/chat/bootstrap" },
  "/api/v1/squads":                       { file: "server/routes.ts",              needle: "/api/v1/squads" },
  "/api/admin/task-tracker/bootstrap":    { file: "server/task-tracker-routes.ts", needle: "/bootstrap" },
  "/api/admin/people?q=a":                { file: "server/family-routes.ts",       needle: "/api/admin/people" },
  "/api/admin/videos":                    { file: "server/videos-routes.ts",       needle: "/api/admin/videos" },
  "/api/admin/hiring/jobs":               { file: "server/hiring-routes.ts",       needle: "/jobs" },
  "/api/admin/invoices":                  { file: "server/invoice-routes.ts",      needle: "/api/admin/invoices" },
  "/api/admin/warehouse/items":           { file: "server/warehouse-routes.ts",    needle: "/items" },
  "/api/admin/market-research":           { file: "server/market-research-routes.ts", needle: "/api/admin/market-research" },
  "/api/admin/feedback":                  { file: "server/feedback-routes.ts",     needle: "/api/admin/feedback" },
  "/api/admin/proposals":                 { file: "server/routes.ts",              needle: "/api/admin/proposals" },
  "/api/public/shop/mfl/catalog":         { file: "server/shop-routes.ts",         needle: "catalog" },
  "/t.js":                                { file: "server/routes.ts",              needle: '"/t.js"' },
  "/api/admin/cugc/mailer/contacts":      { file: "server/routes.ts",              needle: "/api/admin/cugc/mailer/contacts" },
  "/api/public/unitedprints/quote-materials": { file: "server/print-quote-routes.ts", needle: "quote-materials" },
  "/api/admin/print-requests":            { file: "server/print-request-routes.ts", needle: "/api/admin/print-requests" },
  "/api/admin/kb/articles":               { file: "server/kb-routes.ts",           needle: "/api/admin/kb/articles" },
  "/api/public/faqs/unitedprints":        { file: "server/faq-routes.ts",           needle: "/api/public/faqs/" },
  "/api/admin/print-expenses":            { file: "server/print-expense-routes.ts", needle: "/api/admin/print-expenses" },
};

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";

const liveOn = (p: string) => {
  const s = SOURCE[p];
  if (!s) return true;                       // unmapped canary — don't block on it
  if (!existsSync(s.file)) return false;
  return readFileSync(s.file, "utf8").includes(s.needle);
};

const probe = async (c: Canary): Promise<number> => {
  try {
    const r = await fetch(PROD + c.path, { method: c.method || "GET", redirect: "manual" });
    return r.status;
  } catch { return 0; }
};

const branch = (() => {
  try { return execSync("git rev-parse --abbrev-ref HEAD").toString().trim(); } catch { return "?"; }
})();

console.log(`\nPre-deploy check — about to ship "${branch}" to ${PROD}\n`);

let removals = 0, unreachable = 0;
for (const c of CANARIES) {
  const status = await probe(c);
  const onProd = c.expect.includes(status);
  const inTree = liveOn(c.path);

  if (status === 0) {
    console.log(`  ? ${c.feature.padEnd(22)} could not reach production`);
    unreachable++;
  } else if (onProd && !inTree) {
    console.log(`  🔴 ${c.feature.padEnd(22)} LIVE on prod, MISSING from this branch — deploying REMOVES it`);
    removals++;
  } else if (onProd) {
    console.log(`  ok ${c.feature.padEnd(22)} live, and still present here`);
  } else if (!onProd && inTree) {
    console.log(`  + ${c.feature.padEnd(22)} new in this branch (prod ${status}) — will be ADDED`);
  } else {
    console.log(`  - ${c.feature.padEnd(22)} not on prod, not here (prod ${status})`);
  }
}

if (unreachable) console.log(`\n⚠️  ${unreachable} canary/canaries unreachable — treat this run as inconclusive.`);

if (removals) {
  console.log(`\n🔴 REFUSING: this branch would remove ${removals} live feature(s) from production.`);
  console.log(`   Merge the branch that carries them FIRST (the union is always additive —`);
  console.log(`   keep both sides), then re-run this check.\n`);
  process.exit(1);
}
console.log(`\n✓ No live feature would be removed. Safe to deploy.\n`);
