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
  { slug: "football-institute", title: "Football Institute", url: "/admin/football-institute" },
  { slug: "analytics", title: "Analytics", url: "/admin/analytics" },
  { slug: "discounts", title: "Discounts", url: "/admin/discounts" },
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
  { slug: "calendar", title: "Bookings Calendar", url: "/admin/calendar" },
  { slug: "bookings", title: "Bookings", url: "/admin/bookings" },
  { slug: "booking-requests", title: "Booking Requests", url: "/admin/booking-requests" },
  { slug: "website", title: "Website", url: "/admin/website" },
  { slug: "analytics", title: "Analytics", url: "/admin/analytics" },
  { slug: "facilities", title: "Facilities", url: "/admin/facilities" },
  { slug: "addons", title: "Add-ons", url: "/admin/addons" },
  { slug: "people", title: "People & Access", url: "/admin/people" },
  { slug: "payments", title: "Payments", url: "/admin/payments" },
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
  { slug: "competitions", title: "Terms", url: "/admin/competitions" },
  { slug: "teams", title: "Teams", url: "/admin/teams" },
  { slug: "payments", title: "Payments", url: "/admin/payments" },
  { slug: "discounts", title: "Discounts", url: "/admin/discounts" },
  { slug: "mailer", title: "Mailer", url: "/admin/mailer" },
  { slug: "inbox", title: "Inbox", url: "/admin/inbox" },
  { slug: "mfl-livechat", title: "Live Chat", url: "/admin/mfl-livechat" },
  { slug: "rewards", title: "Rewards", url: "/admin/rewards" },
  { slug: "loyalty", title: "Loyalty", url: "/admin/loyalty" },
  { slug: "analytics", title: "Analytics", url: "/admin/analytics" },
  { slug: "business-plan", title: "Business Plan", url: "/admin/business-plan" },
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
  // CIC 7's sub-view (toggled via the Youth/7's switcher in the sidebar).
  { slug: "cic7s-registrations", title: "CIC 7's Registrations", url: "/admin/cic7s-registrations" },
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
  { slug: "programs", title: "Programs", url: "/admin/programs" },
  { slug: "cugc-registrations", title: "Registrations", url: "/admin/cugc-registrations" },
  { slug: "cugc-free-sessions", title: "Free Sessions", url: "/admin/cugc-free-sessions" },
  { slug: "cugc-analytics", title: "Analytics", url: "/admin/cugc-analytics" },
  { slug: "cugc-inbox", title: "Inbox", url: "/admin/cugc-inbox" },
  { slug: "cugc-livechat", title: "Live Chat", url: "/admin/cugc-livechat" },
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
  { slug: "calendar", title: "Calendar", url: "/admin/calendar" },
  { slug: "projects", title: "Projects", url: "/admin/projects" },
  { slug: "content", title: "Content", url: "/admin/content" },
  { slug: "hiring", title: "Hiring", url: "/admin/hiring" },
  { slug: "sponsorship", title: "Sponsorship", url: "/admin/sponsorship" },
  { slug: "proposals", title: "Proposals", url: "/admin/proposals" },
  { slug: "grants", title: "Grants", url: "/admin/grants" },
  { slug: "budget", title: "Budget", url: "/admin/budget" },
  { slug: "cashflow", title: "Cashflow", url: "/admin/cashflow" },
  { slug: "vehicles", title: "Vehicles", url: "/admin/vehicles" },
  { slug: "studio", title: "Studio", url: "/admin/studio", secondary: true },
  { slug: "esign", title: "E-Sign", url: "/admin/esign", secondary: true },
  { slug: "team", title: "Team", url: "/admin/team", secondary: true },
  { slug: "domains", title: "Domains", url: "/admin/domains", secondary: true },
  { slug: "settings", title: "Settings", url: "/admin/settings", secondary: true },
];

const printsTabs: TabDef[] = [
  { slug: "dashboard", title: "Dashboard", url: "/admin" },
  { slug: "links", title: "Links", url: "/admin/links" },
  { slug: "attribution", title: "Attribution", url: "/admin/attribution" },
  { slug: "jobs", title: "Jobs", url: "/admin/print-jobs" },
  { slug: "orders", title: "Orders", url: "/admin/print-orders" },
  { slug: "materials", title: "Materials", url: "/admin/print-materials" },
  { slug: "crm", title: "CRM", url: "/admin/print-crm" },
  { slug: "print-livechat", title: "Live Chat", url: "/admin/print-livechat" },
  { slug: "projects", title: "Projects", url: "/admin/print-projects" },
  { slug: "analytics", title: "Analytics", url: "/admin/print-analytics" },
  { slug: "landing", title: "Landing Pages", url: "/admin/print-landing" },
  { slug: "email", title: "Email Sender", url: "/admin/print-email" },
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
  "cashflow", // Club-wide cashflow insight (Xero patterns, wage-level data). Daniel only.
  "projects", // Work Management System v1 — launched dark while Daniel shapes it. Remove to open to admins/managers.
  "studio", // USG Studio v1 — soft-launched to Daniel while it's shaped. Remove to open to admins/managers.
  "business-plan", // MFL business plan + who-opened-it access log — Daniel only for privacy. Remove to open to admins/managers.
  "cic-watch", // OTT streaming platform control (watch.cicyouth.com) — launched dark to Daniel. Remove to open to Isaac/managers.
  "club-dossier", // Sandbox — first-party people intelligence (PII across all programs). Daniel only.
  "market-research", // Sandbox — competitor & category intelligence. Daniel only while it's shaped.
  "vehicles", // Fleet — names a staff member against an insurance policy and an FBT private-use position. Daniel only. Remove to open to admins/managers.
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
