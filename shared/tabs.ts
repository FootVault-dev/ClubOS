/**
 * Canonical tab registry for ClubOS workspaces.
 *
 * Every tab a user can see in the sidebar has a slug here. The slug is what
 * gets stored in `userOrganizations.tabs` to grant access. Slugs are unique
 * per workspace type — the same slug means different things in Venue vs Group.
 *
 * Used by:
 *  - `client/src/components/app-sidebar.tsx` — to filter rendered nav
 *  - `client/src/pages/admin-team.tsx` — to render tab checkboxes per workspace
 *  - `server/middleware/require-tab.ts` — to enforce server-side
 */

export type WorkspaceType =
  | "camps"
  | "venue"
  | "league"
  | "tournament"
  | "gymnastics"
  | "group"
  | "prints"
  | "sandbox";

export interface TabDef {
  slug: string;
  title: string;
  url: string;
  /** Admin-area tab (Team, Domains, Settings). Useful for default permission presets. */
  secondary?: boolean;
}

/** Map an org slug to its workspace type. Default fallback is "camps". */
export const WORKSPACE_TYPE_BY_SLUG: Record<string, WorkspaceType> = {
  "christchurch-united": "camps",
  "south-island-united": "camps",
  "united-sports-centre": "venue",
  "mini-football-leagues": "league",
  "christchurch-international-cup": "tournament",
  "united-gymnastics": "gymnastics",
  "united-sports-group": "group",
  "united-prints": "prints",
  "sandbox": "sandbox",
};

export function workspaceTypeFor(orgSlug: string | undefined | null): WorkspaceType {
  if (!orgSlug) return "camps";
  return WORKSPACE_TYPE_BY_SLUG[orgSlug] || "camps";
}

const campsTabs: TabDef[] = [
  { slug: "dashboard", title: "Dashboard", url: "/admin" },
  { slug: "links", title: "Links", url: "/admin/links" },
  { slug: "attribution", title: "Attribution", url: "/admin/attribution" },
  { slug: "behavior", title: "Behavior", url: "/admin/behavior" },
  { slug: "camps", title: "Camps", url: "/admin/camps" },
  { slug: "academy", title: "Academy", url: "/admin/academy" },
  { slug: "squads", title: "Squads", url: "/admin/squads" },
  { slug: "registrations", title: "Registrations", url: "/admin/registrations" },
  { slug: "contacts", title: "Contacts", url: "/admin/contacts" },
  { slug: "volunteers", title: "Volunteers", url: "/admin/volunteers" },
  { slug: "mailer", title: "Mailer", url: "/admin/mailer" },
  // CUFC newsletter mailer (Play Predictor entrants + guardian contacts) —
  // distinct from the camps-segment "mailer" wizard above.
  { slug: "cufc-mailer", title: "Mailer", url: "/admin/cufc-mailer" },
  // Play Predictor — first-team score predictions, leaderboards + prizes.
  { slug: "predictor", title: "Play Predictor", url: "/admin/predictor" },
  // 10 years of Friendly Manager registrations + payments, imported 2026-07-14.
  { slug: "fm-history", title: "History", url: "/admin/fm-history" },
  // 11 years of FM tournaments + social leagues (imported 2026-07-17).
  { slug: "fm-competitions", title: "Competitions", url: "/admin/fm-competitions" },
  // Free open-training requests from cufc.co.nz — the invite-only funnel for
  // U9–U20 (2026-07-21). CUFC-only: filtered out of SIU's sidebar like
  // fm-history; the routes are org-scoped to CUFC regardless.
  { slug: "open-trainings", title: "Open Trainings", url: "/admin/open-trainings" },
  // Ticketed club events — the club dinner, and whatever comes next. Not
  // "events": that slug is SIU's Community Events.
  { slug: "club-events", title: "Events", url: "/admin/club-events" },
  // Sporty / NZ Football NRS — push confirmed registrations into the national
  // register (the Friendly Manager / Club Hub pathway, NZF-approved 2026-07-20).
  { slug: "sporty", title: "Sporty NRS", url: "/admin/sporty" },
  { slug: "football-institute", title: "Football Institute", url: "/admin/football-institute" },
  { slug: "analytics", title: "Analytics", url: "/admin/analytics" },
  { slug: "discounts", title: "Discounts", url: "/admin/discounts" },
  // Marketing Suite — email/SMS marketing, launched dark (SUPER_ADMIN_ONLY_TABS below).
  { slug: "marketing", title: "Marketing", url: "/admin/marketing" },
  { slug: "studio", title: "Studio", url: "/admin/studio", secondary: true },
  { slug: "esign", title: "E-Sign", url: "/admin/esign", secondary: true },
  { slug: "team", title: "Team", url: "/admin/team", secondary: true },
  { slug: "domains", title: "Domains", url: "/admin/domains", secondary: true },
  { slug: "settings", title: "Settings", url: "/admin/settings", secondary: true },
];

const venueTabs: TabDef[] = [
  { slug: "dashboard", title: "Dashboard", url: "/admin" },
  { slug: "links", title: "Links", url: "/admin/links" },
  { slug: "attribution", title: "Attribution", url: "/admin/attribution" },
  { slug: "behavior", title: "Behavior", url: "/admin/behavior" },
  { slug: "calendar", title: "Bookings Calendar", url: "/admin/calendar" },
  { slug: "bookings", title: "Bookings", url: "/admin/bookings" },
  { slug: "booking-requests", title: "Booking Requests", url: "/admin/booking-requests" },
  { slug: "website", title: "Website", url: "/admin/website" },
  { slug: "analytics", title: "Analytics", url: "/admin/analytics" },
  { slug: "facilities", title: "Facilities", url: "/admin/facilities" },
  { slug: "addons", title: "Add-ons", url: "/admin/addons" },
  // Cleaning/consumable supplies + machines & equipment. NOT super-admin-only —
  // Riley (grounds staff) needs it once ticked for him in Team.
  { slug: "maintenance", title: "Maintenance", url: "/admin/maintenance" },
  { slug: "people", title: "People & Access", url: "/admin/people" },
  { slug: "payments", title: "Payments", url: "/admin/payments" },
  { slug: "marketing", title: "Marketing", url: "/admin/marketing" },
  { slug: "studio", title: "Studio", url: "/admin/studio", secondary: true },
  { slug: "esign", title: "E-Sign", url: "/admin/esign", secondary: true },
  { slug: "team", title: "Team", url: "/admin/team", secondary: true },
  { slug: "domains", title: "Domains", url: "/admin/domains", secondary: true },
  { slug: "settings", title: "Settings", url: "/admin/venue-settings", secondary: true },
];

const leagueTabs: TabDef[] = [
  { slug: "dashboard", title: "Dashboard", url: "/admin" },
  { slug: "links", title: "Links", url: "/admin/links" },
  { slug: "attribution", title: "Attribution", url: "/admin/attribution" },
  { slug: "behavior", title: "Behavior", url: "/admin/behavior" },
  { slug: "competitions", title: "Terms", url: "/admin/competitions" },
  { slug: "teams", title: "Teams", url: "/admin/teams" },
  // Individual-signup youth leagues (Ballers). Titled "Youth Leagues" because
  // "Academy" means nothing in this workspace — the slug has to stay `academy`
  // because that is what the route and the permission check key on.
  { slug: "academy", title: "Ballers Youth League", url: "/admin/academy" },
  { slug: "registrations", title: "Registrations", url: "/admin/registrations" },
  // Referee scoring app (mobile) + admin approvals/assignments/live feed.
  // Isaac (the MFL coordinator) needs both, so neither is super-admin-only.
  { slug: "mfl-referees", title: "Referees", url: "/admin/mfl-referees" },
  { slug: "mfl-game-feed", title: "Game Feed", url: "/admin/mfl-game-feed" },
  { slug: "mfl-media", title: "Photos", url: "/admin/mfl-media" },
  // Recruiting referees sits next to managing them. This tab is a BRAND view:
  // it shows only jobs advertised under the "mfl" brand, wherever they are
  // owned (see HIRING_WORKSPACE_BRAND in shared/hiring.ts). The same tab in the
  // group workspace shows every brand.
  { slug: "hiring", title: "Hiring", url: "/admin/hiring" },
  { slug: "payments", title: "Payments", url: "/admin/payments" },
  { slug: "discounts", title: "Discounts", url: "/admin/discounts" },
  { slug: "mailer", title: "Mailer", url: "/admin/mailer" },
  { slug: "inbox", title: "Inbox", url: "/admin/inbox" },
  { slug: "mfl-livechat", title: "Live Chat", url: "/admin/mfl-livechat" },
  { slug: "rewards", title: "Rewards", url: "/admin/rewards" },
  { slug: "loyalty", title: "Loyalty", url: "/admin/loyalty" },
  { slug: "analytics", title: "Analytics", url: "/admin/analytics" },
  { slug: "business-plan", title: "Business Plan", url: "/admin/business-plan" },
  { slug: "store", title: "Store", url: "/admin/store" },
  { slug: "marketing", title: "Marketing", url: "/admin/marketing" },
  { slug: "studio", title: "Studio", url: "/admin/studio", secondary: true },
  { slug: "esign", title: "E-Sign", url: "/admin/esign", secondary: true },
  { slug: "team", title: "Team", url: "/admin/team", secondary: true },
  { slug: "domains", title: "Domains", url: "/admin/domains", secondary: true },
  { slug: "settings", title: "Settings", url: "/admin/league-settings", secondary: true },
];

const tournamentTabs: TabDef[] = [
  { slug: "dashboard", title: "Dashboard", url: "/admin" },
  { slug: "links", title: "Links", url: "/admin/links" },
  { slug: "attribution", title: "Attribution", url: "/admin/attribution" },
  { slug: "behavior", title: "Behavior", url: "/admin/behavior" },
  { slug: "tournaments", title: "Tournaments", url: "/admin/tournaments" },
  { slug: "clubs", title: "Clubs", url: "/admin/clubs" },
  { slug: "skills-challenge", title: "Skills Challenge", url: "/admin/skills-challenge" },
  { slug: "food-truck", title: "Food Truck", url: "/admin/food-truck" },
  { slug: "vendors", title: "Vendors", url: "/admin/vendors" },
  { slug: "volunteers", title: "Volunteers", url: "/admin/volunteers" },
  { slug: "cic-registrations", title: "Registrations", url: "/admin/cic-registrations" },
  { slug: "cic-livechat", title: "Live Chat", url: "/admin/cic-livechat" },
  { slug: "cic-mailer", title: "Mailer", url: "/admin/cic-mailer" },
  { slug: "cic-push", title: "Notifications", url: "/admin/cic-push" },
  { slug: "cic-logo-consents", title: "Logo Consents", url: "/admin/cic-logo-consents" },
  { slug: "cic-watch", title: "Watch", url: "/admin/cic-watch" },
  // Content Marketplace — live sales + engagement analytics for the CIC photo
  // store (content.cicyouth.com). Read-only dashboard; data in usg-meet.
  { slug: "cic-content-marketplace", title: "Content Marketplace", url: "/admin/cic-content-marketplace" },
  // Referees — approve referee sign-ups + assign them to games. NOT super-admin
  // locked: CIC tournament staff approve refs during the event.
  { slug: "cic-referees", title: "Referees", url: "/admin/cic-referees" },
  // CIC 7's sub-view (toggled via the Youth/7's switcher in the sidebar).
  { slug: "cic7s-registrations", title: "CIC 7's Registrations", url: "/admin/cic7s-registrations" },
  { slug: "ethnic-cup-registrations", title: "Ethnic Cup Registrations", url: "/admin/ethnic-cup-registrations" },
  // Team Pay — entered teams, their squads, who has paid, and the fill-in pool.
  // NOT super-admin locked: Isaac runs the tournaments and this is his board.
  { slug: "team-entries", title: "Team Entries", url: "/admin/team-entries" },
  { slug: "store", title: "Store", url: "/admin/store" },
  { slug: "media", title: "Media", url: "/admin/media" },
  { slug: "marketing", title: "Marketing", url: "/admin/marketing" },
  { slug: "studio", title: "Studio", url: "/admin/studio", secondary: true },
  { slug: "esign", title: "E-Sign", url: "/admin/esign", secondary: true },
  { slug: "team", title: "Team", url: "/admin/team", secondary: true },
  { slug: "domains", title: "Domains", url: "/admin/domains", secondary: true },
  { slug: "settings", title: "Settings", url: "/admin/tournament-settings", secondary: true },
];

const gymnasticsTabs: TabDef[] = [
  { slug: "dashboard", title: "Dashboard", url: "/admin" },
  { slug: "links", title: "Links", url: "/admin/links" },
  { slug: "attribution", title: "Attribution", url: "/admin/attribution" },
  { slug: "behavior", title: "Behavior", url: "/admin/behavior" },
  { slug: "programs", title: "Programs", url: "/admin/programs" },
  { slug: "cugc-registrations", title: "Registrations", url: "/admin/cugc-registrations" },
  { slug: "cugc-free-sessions", title: "Free Sessions", url: "/admin/cugc-free-sessions" },
  { slug: "cugc-analytics", title: "Analytics", url: "/admin/cugc-analytics" },
  { slug: "cugc-inbox", title: "Inbox", url: "/admin/cugc-inbox" },
  { slug: "cugc-livechat", title: "Live Chat", url: "/admin/cugc-livechat" },
  { slug: "cugc-mailer", title: "Mailer", url: "/admin/cugc-mailer" },
  { slug: "marketing", title: "Marketing", url: "/admin/marketing" },
  { slug: "studio", title: "Studio", url: "/admin/studio", secondary: true },
  { slug: "esign", title: "E-Sign", url: "/admin/esign", secondary: true },
  { slug: "team", title: "Team", url: "/admin/team", secondary: true },
  { slug: "domains", title: "Domains", url: "/admin/domains", secondary: true },
  { slug: "settings", title: "Settings", url: "/admin/gymnastics-settings", secondary: true },
];

const groupTabs: TabDef[] = [
  { slug: "dashboard", title: "Dashboard", url: "/admin" },
  { slug: "links", title: "Links", url: "/admin/links" },
  { slug: "attribution", title: "Attribution", url: "/admin/attribution" },
  { slug: "behavior", title: "Behavior", url: "/admin/behavior" },
  { slug: "calendar", title: "Calendar", url: "/admin/calendar" },
  { slug: "projects", title: "Projects", url: "/admin/projects" },
  { slug: "content", title: "Content", url: "/admin/content" },
  { slug: "hiring", title: "Hiring", url: "/admin/hiring" },
  { slug: "sponsorship", title: "Sponsorship", url: "/admin/sponsorship" },
  { slug: "proposals", title: "Proposals", url: "/admin/proposals" },
  { slug: "grants", title: "Grants", url: "/admin/grants" },
  { slug: "invoices", title: "Invoices", url: "/admin/invoices" },
  // Stripe bulk payouts decoded — which programmes, players and parents are
  // inside each bank deposit. Read-only over the Stripe API + existing rows.
  { slug: "payouts", title: "Payouts", url: "/admin/payouts" },
  { slug: "budget", title: "Budget", url: "/admin/budget" },
  // The club's chart of accounts — Victor Zoubkov's FY2026 coding structure,
  // 882 codes across thirty streams (income 01–20, expenses 21–30). This is the
  // categorisation Xero is being matched to and every transaction mapped
  // against. Locked like Budget: code 21 names eleven staff against their
  // salaries. Victor gets in by name via unlocked_tabs, not by removing the
  // lock — see SUPER_ADMIN_ONLY_TABS.
  { slug: "coding-budget", title: "Coding Budget", url: "/admin/coding-budget" },
  { slug: "cashflow", title: "Cashflow", url: "/admin/cashflow" },
  { slug: "vehicles", title: "Vehicles", url: "/admin/vehicles" },
  // Equipment Register — one responsible person per team, the gear they hold,
  // and the termly count. Locked like Vehicles (see SUPER_ADMIN_ONLY_TABS) and
  // opened to Ryan and Travis individually.
  { slug: "equipment", title: "Equipment", url: "/admin/equipment" },
  // Fines the club owes (parking, traffic, federation) and fines owed to the
  // club (disciplinary), with the notice and the payment confirmation attached
  // to each. Locked like Vehicles — it names people against money — and opened
  // to Travis individually; Daniel reaches it as a super admin.
  { slug: "fines", title: "Fines", url: "/admin/fines" },
  // The residency at 482A Yaldhurst Rd: rooms, who lives in each, what they owe,
  // and the compliance actions still open on it. Moved here from the venue
  // workspace on 2026-08-18 — these are the club's houses, not the sports
  // centre's hireable facilities, and the group workspace is where the other
  // asset registers (vehicles, invoices, budget) already live.
  //
  // 🔴 The slug stays `housing`. It is what requireTab(), the deploy canary and
  // any per-person unlocked_tabs grant key on; renaming a slug to match a UI
  // label silently revokes access. The URL and the title are the parts a human
  // reads, so those are what changed.
  { slug: "housing", title: "Accommodation", url: "/admin/accommodation" },
  // How much website traffic we send sponsors via tracked /s/{code} redirects,
  // plus a sponsor-site health check. Launched dark (SUPER_ADMIN_ONLY_TABS)
  // while Daniel shapes it.
  { slug: "sponsor-traffic", title: "Sponsor Traffic", url: "/admin/sponsor-traffic" },
  // The in-house Loom: record screen/camera in the browser, share at /v/{token}.
  // NOT super-admin-locked — the whole point is any staff member recording
  // tutorials; grant the tab per-member in Team as usual.
  { slug: "videos", title: "Videos", url: "/admin/videos" },
  { slug: "marketing", title: "Marketing", url: "/admin/marketing" },
  { slug: "studio", title: "Studio", url: "/admin/studio", secondary: true },
  { slug: "esign", title: "E-Sign", url: "/admin/esign", secondary: true },
  { slug: "team", title: "Team", url: "/admin/team", secondary: true },
  { slug: "domains", title: "Domains", url: "/admin/domains", secondary: true },
  { slug: "settings", title: "Settings", url: "/admin/settings", secondary: true },
];

const printsTabs: TabDef[] = [
  { slug: "dashboard", title: "Dashboard", url: "/admin" },
  // The planning workspace (projects/board/table/calendar/Gantt) — the
  // Monday-style layer ABOVE the production pipeline (Jobs). NOT
  // super-admin-locked: grant to Dima via Team like Quotes/Maintenance.
  { slug: "management", title: "Management", url: "/admin/print-management" },
  { slug: "links", title: "Links", url: "/admin/links" },
  { slug: "attribution", title: "Attribution", url: "/admin/attribution" },
  { slug: "behavior", title: "Behavior", url: "/admin/behavior" },
  { slug: "jobs", title: "Jobs", url: "/admin/print-jobs" },
  // Internal print requests from club staff → Dima approves into a job.
  // Deliberately NOT super-admin-locked: the point is that other staff (Travis
  // first) get this tab and nothing else in the workspace. Approving is gated
  // separately on the workspace role, not on the tab.
  { slug: "requests", title: "Requests", url: "/admin/print-requests" },
  { slug: "quotes", title: "Quotes", url: "/admin/print-quotes" },
  // The FAQs on unitedprints.co.nz + inside the live-chat widget. Not
  // super-admin-locked — Dima owns this content.
  { slug: "faqs", title: "FAQs", url: "/admin/print-faqs" },
  // Every purchase the print shop makes, with its invoice PDF attached.
  { slug: "expenses", title: "Expenses", url: "/admin/print-expenses" },
  { slug: "orders", title: "Orders", url: "/admin/print-orders" },
  { slug: "materials", title: "Materials", url: "/admin/print-materials" },
  { slug: "crm", title: "CRM", url: "/admin/print-crm" },
  { slug: "sales", title: "Sales", url: "/admin/print-sales" },
  { slug: "print-livechat", title: "Live Chat", url: "/admin/print-livechat" },
  { slug: "projects", title: "Projects", url: "/admin/print-projects" },
  { slug: "analytics", title: "Analytics", url: "/admin/print-analytics" },
  { slug: "landing", title: "Landing Pages", url: "/admin/print-landing" },
  { slug: "email", title: "Email Sender", url: "/admin/print-email" },
  { slug: "warehouse", title: "Warehouse", url: "/admin/warehouse" },
  { slug: "marketing", title: "Marketing", url: "/admin/marketing" },
  { slug: "integrations", title: "Integrations", url: "/admin/integrations", secondary: true },
  { slug: "studio", title: "Studio", url: "/admin/studio", secondary: true },
  { slug: "esign", title: "E-Sign", url: "/admin/esign", secondary: true },
  { slug: "team", title: "Team", url: "/admin/team", secondary: true },
  { slug: "domains", title: "Domains", url: "/admin/domains", secondary: true },
  { slug: "settings", title: "Settings", url: "/admin/settings", secondary: true },
];

// Sandbox — private super-admin experimentation workspace (Daniel only). New
// features get trialled here before they touch a real workspace. First project:
// the Club Dossier. Keep this tab set minimal; add tabs as experiments land.
const sandboxTabs: TabDef[] = [
  { slug: "club-dossier", title: "Club Dossier", url: "/admin/club-dossier" },
  { slug: "market-research", title: "Market Research", url: "/admin/market-research" },
  { slug: "team", title: "Team", url: "/admin/team", secondary: true },
];

export const TABS_BY_WORKSPACE_TYPE: Record<WorkspaceType, TabDef[]> = {
  camps: campsTabs,
  venue: venueTabs,
  league: leagueTabs,
  tournament: tournamentTabs,
  gymnastics: gymnasticsTabs,
  group: groupTabs,
  prints: printsTabs,
  sandbox: sandboxTabs,
};

// SIU shares the "camps" workspace type with CUFC, but has its own club-building
// tools that must NOT appear for CUFC. Appended to SIU's tab set by slug.
const siuExtraTabs: TabDef[] = [
  { slug: "licensing", title: "OFC Licensing", url: "/admin/licensing" },
  { slug: "declarations", title: "Declarations", url: "/admin/declarations" },
  { slug: "events", title: "Community Events", url: "/admin/events" },
  { slug: "membership", title: "Membership", url: "/admin/membership" },
  // SIU's native retail shop (2026-09) — the fourth brand on the shop_*
  // engine after MFL, CIC and CUFC. campsTabs itself carries no "store" slug
  // (see cufcExtraTabs above for CUFC's own copy of this same tab).
  { slug: "store", title: "Store", url: "/admin/store" },
];

// CUFC's native retail shop (2026-09) — the third brand on the shop_* engine
// after MFL and CIC. CUFC-only: SIU shares the "camps" workspace type but
// must NOT gain this tab (nor must United Gymnastics, a different workspace
// type entirely).
const cufcExtraTabs: TabDef[] = [
  { slug: "store", title: "Store", url: "/admin/store" },
];

export function tabsForOrgSlug(orgSlug: string | undefined | null): TabDef[] {
  const base = TABS_BY_WORKSPACE_TYPE[workspaceTypeFor(orgSlug)];
  if (orgSlug === "south-island-united") {
    const main = base.filter((t) => !t.secondary);
    const secondary = base.filter((t) => t.secondary);
    return [...main, ...siuExtraTabs, ...secondary];
  }
  if (orgSlug === "christchurch-united") {
    const main = base.filter((t) => !t.secondary);
    const secondary = base.filter((t) => t.secondary);
    return [...main, ...cufcExtraTabs, ...secondary];
  }
  return base;
}

/**
 * Tabs that are locked to super_admin ONLY while the feature is under
 * construction. Bypasses the usual admin/manager/tabs-array escalations.
 * When ready to open up, remove the slug here — the rest of the permission
 * system (workspace role + tabs whitelist) takes over.
 */
export const SUPER_ADMIN_ONLY_TABS: ReadonlySet<string> = new Set([
  // ── OPENED 2026-09-03 (Daniel) ──────────────────────────────────────────
  // studio · cic-watch · market-research · store · media · sales ·
  // sponsor-traffic were all "launched dark while Daniel shapes it" and every
  // one of their comments said "remove this line to open it". Nobody ever went
  // back. The result: 21 tabs that only the super admin could see, so Daniel
  // would ship a feature, look at it, and no member of staff ever knew it
  // existed. They now follow the ordinary permission system — workspace role
  // plus the per-member `tabs` whitelist set in /admin/team.
  //
  // 🔴 What is LEFT here is left ON PURPOSE. `canAccessTab` returns true for
  // EVERY tab once a membership role is admin/manager, so deleting a line does
  // not open a tab to one person — it opens it to every admin of that
  // workspace (eight of them in United Sports Group). Everything below names
  // real people against money, an address, a bank account or a child. Grant an
  // individual with `script/grant-unlocked-tab.ts <email> <tab> <workspace>
  // --commit`; it needs no deploy and takes effect on the next request.
  "budget", // Phase 1 construction — staff salaries visible. Daniel only.
  // Coding Budget — the chart of accounts. Same reason as `budget`, and more
  // specific: code 21-01 lists eleven roles by title against a salary each
  // (Chief Executive $150,000, Academy Director $115,000, Business Development
  // Manager $72,000), and 21-04 does the same for eight contractors. Removing
  // this line would hand the club's payroll to every United Sports Group admin,
  // because a workspace admin bypasses the tabs whitelist entirely. Grant
  // Victor — or anyone else — by name with script/grant-unlocked-tab.ts; it
  // takes effect on the next request and needs no deploy.
  "coding-budget",
  // Sporty / NZF NRS push: sends children's identity data to a national
  // register, and a mis-click during UAT could create real NRS records.
  // Daniel-only until the integration passes UAT and the deeds are signed.
  "sporty",
  "cashflow", // Club-wide cashflow insight (Xero patterns, wage-level data). Daniel only.
  "projects", // Work Management System v1 — launched dark while Daniel shapes it. Remove to open to admins/managers.
  "business-plan", // MFL business plan + who-opened-it access log — Daniel only for privacy. Remove to open to admins/managers.
  "club-dossier", // Sandbox — first-party people intelligence (PII across all programs). Daniel only.
  "invoices", // Tracked invoices — carries bank details. Daniel only while it's shaped.
  // "payouts" UNLOCKED 2026-07-23 (Daniel): the tab now follows the normal
  // permission system — workspace role + the per-member tabs whitelist set in
  // Team (first grant: Olga, USG team_member with tabs:["payouts"]).
  // Fleet — names a staff member against a licence number, a home address and
  // an FBT private-use position. STAYS LOCKED. Ryan Edwards and Travis Graham
  // were let in individually (2026-08-18) via user_organizations.unlocked_tabs,
  // because deleting this line would also hand it to the other six United
  // Sports Group admins — a workspace admin bypasses the tabs whitelist.
  // Grant the next person with script/grant-unlocked-tab.ts; no deploy needed.
  "vehicles",
  // Equipment Register — carries every coordinator's name, personal email and
  // mobile, and a per-team judgement of whether gear went missing on their
  // watch. Same reasoning as Vehicles: removing this line would hand it to all
  // eight United Sports Group admins, because a workspace admin bypasses the
  // tabs whitelist. Ryan Edwards and Travis Graham were let in individually
  // (2026-08-18) via user_organizations.unlocked_tabs. Grant the next person
  // with script/grant-unlocked-tab.ts; no deploy needed.
  "equipment",
  // Fines — names a person or a vehicle against money owed, and carries the
  // scanned notice. Same class of data as vehicles/housing. Daniel + Travis
  // only (2026-08-21), by name via user_organizations.unlocked_tabs.
  "fines",
  // Accommodation (slug `housing`): occupants' names and emails, what each owes,
  // bond, key codes for every room, and which players are still unverified.
  // Without this lock every *admin* of the group workspace would see it — the
  // tabs whitelist does not restrain a workspace admin. Same class of data as
  // budget/cashflow, plus door codes. Grant an individual with
  // script/grant-unlocked-tab.ts rather than removing this line.
  "housing",
  // Friendly Manager History — 10 years of children's enrolment records and
  // family payment history (imported 2026-07-14). Daniel-only while he shapes
  // it. Remove this line to open it to CUFC admins/managers.
  "fm-history",
  // Competitions history — carries team-manager phones/emails; Daniel-only.
  "fm-competitions",
]);

/**
 * Whether a user should see/access a given tab in a workspace.
 * Rules:
 *   - Locked tabs (SUPER_ADMIN_ONLY_TABS) → super_admin, or a person named in
 *     that membership's `unlockedTabs`. A ROLE never opens a locked tab.
 *   - super_admin always sees everything
 *   - admin or manager role → all tabs (full access regardless of tabs column)
 *   - tabs == null → all tabs (legacy default; treat as full access)
 *   - tabs is array → whitelist match
 *
 * 🔴 `membershipUnlockedTabs` is the ONLY way past the lock other than being a
 * super admin, and it is deliberately a separate column from `membershipTabs`.
 * The whitelist is bypassed entirely for an admin/manager membership (see the
 * third rule), so a locked tab granted through it would be granted to every
 * admin in the workspace — which is the whole thing the lock exists to stop.
 * It also has to be a column no other feature writes: Dima's group membership
 * carries tabs = ["budget"] from an old grant, inert only because "budget" is
 * locked, and honouring `tabs` here would have handed him the salary data.
 *
 * Omitting the argument fails CLOSED — a caller that has not been taught about
 * locked-tab grants denies access rather than leaking one.
 */
export function canAccessTab({
  globalRole,
  membershipRole,
  membershipTabs,
  membershipUnlockedTabs,
  tabSlug,
}: {
  globalRole?: string | null;
  membershipRole?: string | null;
  membershipTabs?: string[] | null;
  membershipUnlockedTabs?: string[] | null;
  tabSlug: string;
}): boolean {
  if (SUPER_ADMIN_ONLY_TABS.has(tabSlug)) {
    if (globalRole === "super_admin") return true;
    return Array.isArray(membershipUnlockedTabs) && membershipUnlockedTabs.includes(tabSlug);
  }
  if (globalRole === "super_admin") return true;
  if (membershipRole === "admin" || membershipRole === "manager") return true;
  if (membershipTabs == null) return true;
  return membershipTabs.includes(tabSlug);
}
