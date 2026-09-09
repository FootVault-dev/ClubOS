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
  // CUFC — the third brand on the shop_* engine, added 2026-09-09. Not yet on
  // prod: this line will print "+ new in this branch" (not a removal) until
  // the deploy that carries it lands, then behaves like the MFL/CIC canaries.
  { feature: "shop (CUFC)",         path: "/api/public/shop/cufc/catalog",        expect: [200] },
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
  // Club Drive. Added after it was silently removed from prod within a day of
  // shipping — the FOURTH feature lost this way. The tables and every uploaded
  // file survive a bad deploy untouched; what disappears is the route, and a
  // missing route is indistinguishable from one that never existed.
  { feature: "club drive",          path: "/api/admin/drive/bootstrap",             expect: [401] },
  // Equipment Register (2026-08-18). Both halves are canaried, because they can
  // be lost independently: the staff tab is an admin route, while the holders'
  // own page is a PUBLIC one, and a coach standing in a shed with a dead link
  // is the failure nobody here would notice.
  { feature: "equipment register",  path: "/api/admin/equipment/overview",          expect: [401] },
  // Fines (2026-08-21). 🔴 A warning this list cannot give itself: the guard
  // ships INSIDE the tree being deployed, so a branch that lacks a feature also
  // lacks its canary and passes clean. Equipment was live on production and
  // absent from feat/staff-voice on 2026-08-21, and this file on that branch
  // had no equipment line to notice it. Probe by hand for anything added since
  // the branch you are shipping was cut.
  { feature: "fines",               path: "/api/admin/fines",                       expect: [401] },
  { feature: "pos register",        path: "/api/admin/pos/bootstrap",               expect: [401] },
  { feature: "pos receipt (public)",path: "/api/public/pos/receipt/00000000-0000-0000-0000-000000000000", expect: [404] },
  { feature: "equipment holders",   path: "/api/public/equipment/me",               expect: [401] },
  // Coding Budget — the club's chart of accounts (882 codes) and the
  // transactions mapped to it. Canaried because the DATA survives a bad deploy
  // untouched while the route does not, which is exactly what made the previous
  // five silent deletions invisible: a missing route is indistinguishable from
  // one that never existed, and Victor would simply find the tab gone.
  { feature: "coding budget",       path: "/api/admin/coding-budget",              expect: [401] },
  // Accommodation — the residency at 482A Yaldhurst Rd. `/overview` has been
  // live since July; `/invoicing` only exists in the 2026-08-18 build, so the
  // pair distinguishes "the tab is there" from "the tab is there but the money
  // view has been deployed away from under it".
  { feature: "accommodation",       path: "/api/admin/housing/overview",            expect: [401] },
  { feature: "accommodation money", path: "/api/admin/housing/invoicing",           expect: [401] },
  // Ethnic Cup — the admin board AND the public form the brand site posts to.
  // The public one matters most: if it goes, ethniccup.com keeps accepting
  // registrations into a 404 and nobody finds out until a team asks why they
  // never heard back.
  { feature: "ethnic cup admin",    path: "/api/admin/ethnic-cup/registrations",   expect: [401] },
  // OPTIONS, not GET: the route is POST-only, so a GET 404s and the canary
  // would sit at "absent" forever — protecting nothing while looking green.
  { feature: "ethnic cup form",     path: "/api/public/ethnic-cup/register-interest", method: "OPTIONS", expect: [204] },
  // Team Pay. The public canary is the one that matters: a manager's dashboard
  // link and a player's payment link are both sitting in people's inboxes, and
  // a deploy that removed these routes would turn every one of them into a 404
  // with nothing to tell us. 200 because the competition is public information;
  // a bad slug 404s.
  { feature: "team pay competition", path: "/api/public/teampay/competition/ethnic-cup-2026", expect: [200] },
  { feature: "team pay admin",       path: "/api/admin/teampay/overview",                     expect: [401] },
  // CIC 7's (2026-09-08): cic7s.com's register-interest form hands back a token
  // and its sales page spends it here to create a paid Team Pay entry. If a
  // deploy drops either, every paid ad click dead-ends after the form.
  { feature: "cic 7s team pay (open)",   path: "/api/public/teampay/competition/cic-summer-7s-2027-open",   expect: [200] },
  { feature: "cic 7s team pay (social)", path: "/api/public/teampay/competition/cic-summer-7s-2027-social", expect: [200] },
  { feature: "cic 7s enter bridge",  path: "/api/public/cic7s/register-interest/probe/enter", method: "OPTIONS", expect: [204] },
  // The rebuilt dashboard's only endpoint. Silent if it goes: the page falls
  // back to nothing and every workspace's revenue simply stops appearing,
  // which is indistinguishable from a quiet month.
  { feature: "dashboard revenue",    path: "/api/admin/dashboard/revenue",                    expect: [401] },
  // Club Events (2026-09-08): the club dinner's ticket page is linked from
  // cufc.co.nz/dinner and the S1 board. A deploy that dropped it would 404 in
  // front of every parent who tapped it. 200: the event is public information.
  { feature: "club events (dinner)", path: "/api/public/club-events/club-dinner-2026", expect: [200] },
  { feature: "club events admin",    path: "/api/admin/club-events",                    expect: [401] },
];

/** Where each canary's route is declared, so we can tell whether THIS tree
 *  still has it. Checked as plain text: the literal must appear in the file. */
const SOURCE: Record<string, { file: string; needle: string }> = {
  "/api/admin/dashboard/revenue":        { file: "server/dashboard-routes.ts",    needle: "/api/admin/dashboard/revenue" },
  "/api/admin/drive/bootstrap":           { file: "server/drive-routes.ts",        needle: "/api/admin/drive/bootstrap" },
  "/api/admin/equipment/overview":        { file: "server/equipment-routes.ts",    needle: "/api/admin/equipment/overview" },
  "/api/public/equipment/me":             { file: "server/equipment-routes.ts",    needle: "/api/public/equipment/me" },
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
  "/api/public/shop/cufc/catalog":         { file: "server/shop-routes.ts",         needle: "cufc" },
  "/t.js":                                { file: "server/routes.ts",              needle: '"/t.js"' },
  "/api/admin/cugc/mailer/contacts":      { file: "server/routes.ts",              needle: "/api/admin/cugc/mailer/contacts" },
  "/api/public/unitedprints/quote-materials": { file: "server/print-quote-routes.ts", needle: "quote-materials" },
  "/api/admin/print-requests":            { file: "server/print-request-routes.ts", needle: "/api/admin/print-requests" },
  "/api/admin/kb/articles":               { file: "server/kb-routes.ts",           needle: "/api/admin/kb/articles" },
  "/api/public/faqs/unitedprints":        { file: "server/faq-routes.ts",           needle: "/api/public/faqs/" },
  "/api/admin/print-expenses":            { file: "server/print-expense-routes.ts", needle: "/api/admin/print-expenses" },
  "/api/admin/coding-budget":             { file: "server/coding-budget-routes.ts", needle: "/api/admin/coding-budget" },
  "/api/public/teampay/competition/ethnic-cup-2026": { file: "server/teampay-routes.ts", needle: "/api/public/teampay/competition/:slug" },
  "/api/admin/teampay/overview":          { file: "server/teampay-routes.ts",      needle: "/api/admin/teampay/overview" },
  "/api/public/club-events/club-dinner-2026": { file: "server/club-events-routes.ts", needle: "/api/public/club-events/:slug" },
  "/api/admin/club-events":               { file: "server/club-events-routes.ts",  needle: "/api/admin/club-events" },
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

if (removals) {
  console.log(`\n🔴 REFUSING: this branch would remove ${removals} live feature(s) from production.`);
  console.log(`   Merge the branch that carries them FIRST (the union is always additive —`);
  console.log(`   keep both sides), then re-run this check.\n`);
  process.exit(1);
}

// 🔴 A guard that cannot see production has not cleared anything, and must not
// say so. On 2026-08-26 every one of these came back unreachable — node's
// outbound fetch was broken on that machine while curl worked fine — and the
// script still printed "Safe to deploy" underneath the warning. That is the
// most dangerous state this file can be in: it looks like a pass. It now
// refuses, and names the way to check by hand.
if (unreachable) {
  console.log(`\n🔴 REFUSING: ${unreachable} of ${CANARIES.length} canaries could not reach production.`);
  console.log(`   This run proves NOTHING — an unreachable canary is not a green one.`);
  console.log(`   If node's networking is the problem (curl works, fetch does not), probe by hand:`);
  console.log(`     curl -so/dev/null -w '%{http_code}\\n' ${PROD}/api/admin/proposals   # expect 401`);
  console.log(`   Override only when you have checked another way: PREFLIGHT_ALLOW_UNREACHABLE=1\n`);
  if (process.env.PREFLIGHT_ALLOW_UNREACHABLE !== "1") process.exit(1);
  console.log(`   ...overridden by PREFLIGHT_ALLOW_UNREACHABLE=1.\n`);
}

console.log(`\n✓ No live feature would be removed. Safe to deploy.\n`);
