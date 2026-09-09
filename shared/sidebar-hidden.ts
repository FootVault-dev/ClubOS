/**
 * Which tabs the sidebar does not draw, regardless of permissions.
 *
 * Lifted out of app-sidebar.tsx on 2026-09-03. A tab has to clear TWO gates to
 * be visible: `canAccessTab` (may this person reach it?) and these lists (do we
 * draw it at all?). Keeping the second gate inside a React component meant no
 * script could see it — `script/access-review.ts` reported Studio as newly
 * visible to nine people on the day it was hidden from every sidebar.
 *
 * Permission tooling and the sidebar now read the SAME source.
 */
// The AttributionOS trio and MarketingOS live in all seven workspace navs
// because they were copied outward from the CUFC one; Daniel's rule is that a
// tab which only transferred across gets hidden with its original.
export const HIDDEN_GLOBAL: string[] = [
  "studio",             // AI page-brief tool — unfinished, rarely used
  "esign",              // e-signature — works, but not day-to-day for anyone
  "feedback",           // superseded by Chat: staff report bugs in the chat now
  "links",              // AttributionOS — same page in all 7 workspaces
  "attribution",        // AttributionOS
  "behavior",           // AttributionOS
  "marketing",          // MarketingOS — same page in all 7, still unfinished
  "sporty",             // Sporty NRS — inert until NZF UAT keys arrive
  "drive",              // Club Drive — not finished yet
  // Now Academy → Football Institute (programme 58). Sean Jovens Barquio is on
  // it, and the live apply form at footballinstitute.co.nz mirrors every new
  // application onto the programme, so hiding this strands nobody.
  "football-institute",
  // ✅ Safe to hide: every FM registration and payment still renders on the
  // person's own profile (/admin/people/:key → resolvePeopleHistory reads
  // fm_registration_history + fm_payment_history directly), which is reachable
  // from Contacts and global search — and by MORE people than this tab was,
  // since the tab is super-admin-only and Contacts is not.
  "fm-history",
  //
  // 🔴 NOT hidden: "fm-competitions". Verified 2026-09-02 — NOTHING else in
  // ClubOS reads fm_competition_*. MFL's Competitions page reads the live
  // `league_competitions` table and CIC's reads `tournaments`; neither touches
  // the archive. Hiding this tab would make 41 competitions, 695 teams, 2,508
  // games, 248 placings and the CIC club-loyalty ledger unreachable in the UI.
  // It stays until that history is surfaced in the MFL and CIC workspaces.
  //
  // ✅ "cufc-mailer" (Newsletters) is GONE from this workspace entirely
  // (Daniel, 2026-09-09) — removed from tabs.ts, the sidebar and App.tsx
  // rather than hidden. The 2026-09-02 note here argued against it because
  // Newsletters reached Play Predictor entrants that Mailer's guardian-only
  // "all" segment misses. Measured before removal: 7 entrants have ever given
  // marketing consent and 2 are already guardians, so the real loss was FIVE
  // addresses, against a live risk of picking the wrong one of two boxes both
  // labelled "email the families". Mailer had sent every real campaign;
  // Newsletters had sent none in two months. If Play Predictor ever grows,
  // give Mailer a "predictor" segment — do not bring back a second sender.
];

// 🔴 Hidden in SOME workspaces only, because the same tab slug renders a
// DIFFERENT page depending on where you are standing.
//
// `/admin/analytics` is CampAnalytics in CUFC, but LeagueAnalytics in MFL and
// VenueAnalytics at the Centre. Hiding it globally would have deleted two real
// tools to remove one dead one. Same shape for Volunteers: CUFC's is dormant,
// the Cup's runs the July tournament.
export const HIDDEN_BY_WORKSPACE: Record<string, string[]> = {
  "christchurch-united": [
    "analytics",  // CampAnalytics — holiday-camp era, superseded by the dashboard
    "volunteers",      // dormant here; the Cup's is live and stays
    // Camps are now a "Holiday Camps" section on the Academy page, beside Core
    // and Additional — same `programs` table, so they belong together. Every
    // camp route still works; ProgramTable routes each row by type.
    "camps",
    // Its one row is the 2021 Queen's Birthday Festival with 0 teams and 0
    // games. The 35 MFL seasons and 5 CIC editions now live in those
    // workspaces, which is where somebody would look for them.
    "fm-competitions",
  ],
};

