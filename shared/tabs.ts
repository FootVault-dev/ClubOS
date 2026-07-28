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
  // The residency houses: rooms, tenants, rent and the power/wifi bills.
  { slug: "housing", title: "Housing", url: "/admin/housing" },
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
  { slug: "cashflow", title: "Cashflow", url: "/admin/cashflow" },
  { slug: "vehicles", title: "Vehicles", url: "/admin/vehicles" },
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
  { slug: "quotes", title: "Quotes", url: "/admin/print-quotes" },
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
];

export function tabsForOrgSlug(orgSlug: string | undefined | null): TabDef[] {
  const base = TABS_BY_WORKSPACE_TYPE[workspaceTypeFor(orgSlug)];
  if (orgSlug === "south-island-united") {
    const main = base.filter((t) => !t.secondary);
    const secondary = base.filter((t) => t.secondary);
    return [...main, ...siuExtraTabs, ...secondary];
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
  "budget", // Phase 1 construction — staff salaries visible. Daniel only.
  // Sporty / NZF NRS push: sends children's identity data to a national
  // register, and a mis-click during UAT could create real NRS records.
  // Daniel-only until the integration passes UAT and the deeds are signed.
  "sporty",
  "cashflow", // Club-wide cashflow insight (Xero patterns, wage-level data). Daniel only.
  "projects", // Work Management System v1 — launched dark while Daniel shapes it. Remove to open to admins/managers.
  "studio", // USG Studio v1 — soft-launched to Daniel while it's shaped. Remove to open to admins/managers.
  "business-plan", // MFL business plan + who-opened-it access log — Daniel only for privacy. Remove to open to admins/managers.
  "cic-watch", // OTT streaming platform control (watch.cicyouth.com) — launched dark to Daniel. Remove to open to Isaac/managers.
  "club-dossier", // Sandbox — first-party people intelligence (PII across all programs). Daniel only.
  "market-research", // Sandbox — competitor & category intelligence. Daniel only while it's shaped.
  "store", // MFL Store (native e-commerce, Shopify replacement pilot) — dark launch, Daniel only. Remove to open to admins/managers.
  "media", // CIC Media Library — dark launch while Daniel shapes it with Max. Remove to open to Max (admin/manager).
  "invoices", // Tracked invoices — carries bank details. Daniel only while it's shaped.
  // "payouts" UNLOCKED 2026-07-23 (Daniel): the tab now follows the normal
  // permission system — workspace role + the per-member tabs whitelist set in
  // Team (first grant: Olga, USG team_member with tabs:["payouts"]).
  "vehicles", // Fleet — names a staff member against an insurance policy and an FBT private-use position. Daniel only. Remove to open to admins/managers.
  // The United Print prospect database + sales pipeline: 400+ researched
  // companies with contact details, call notes and deal values. Daniel's
  // sales-training ground — launched dark while he shapes it. Remove this
  // line to open Sales to the Print workspace's admins/managers.
  "sales",
  // Residency housing: tenants' names, phone numbers, rent arrears and bond.
  // Without this lock, every *admin* of the venue workspace (socials@, info@cugc,
  // grassroots@, support@) would see it — the tabs whitelist does not restrain a
  // workspace admin. Same class of data as budget/cashflow. Remove this line to
  // open Housing to venue admins and managers.
  "housing",
  // Sponsor Traffic — launched dark while Daniel shapes it, matching how
  // vehicles/housing/market-research were launched. Remove this line to open
  // it to the Group workspace's admins/managers.
  "sponsor-traffic",
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
 *   - Locked tabs (SUPER_ADMIN_ONLY_TABS) → only super_admin
 *   - super_admin always sees everything
 *   - admin or manager role → all tabs (full access regardless of tabs column)
 *   - tabs == null → all tabs (legacy default; treat as full access)
 *   - tabs is array → whitelist match
 */
export function canAccessTab({
  globalRole,
  membershipRole,
  membershipTabs,
  tabSlug,
}: {
  globalRole?: string | null;
  membershipRole?: string | null;
  membershipTabs?: string[] | null;
  tabSlug: string;
}): boolean {
  if (SUPER_ADMIN_ONLY_TABS.has(tabSlug)) return globalRole === "super_admin";
  if (globalRole === "super_admin") return true;
  if (membershipRole === "admin" || membershipRole === "manager") return true;
  if (membershipTabs == null) return true;
  return membershipTabs.includes(tabSlug);
}
