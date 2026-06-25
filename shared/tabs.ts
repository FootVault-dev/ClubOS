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
  | "prints";

export interface TabDef {
  slug: string;
  title: string;
  url: string;
  /** Admin-area tab (Team, Domains, Settings). Useful for default permission presets. */
  secondary?: boolean;
}

/** Map an org slug to its workspace type. Default fallback is "camps". */
export const WORKSPACE_TYPE_BY_SLUG: Record<string, WorkspaceType> = {
  "united-sports-centre": "venue",
  "mini-football-leagues": "league",
  "christchurch-international-cup": "tournament",
  "united-gymnastics": "gymnastics",
  "united-sports-group": "group",
  "united-prints": "prints",
};

export function workspaceTypeFor(orgSlug: string | undefined | null): WorkspaceType {
  if (!orgSlug) return "camps";
  return WORKSPACE_TYPE_BY_SLUG[orgSlug] || "camps";
}

const campsTabs: TabDef[] = [
  { slug: "dashboard", title: "Dashboard", url: "/admin" },
  { slug: "camps", title: "Camps", url: "/admin/camps" },
  { slug: "academy", title: "Academy", url: "/admin/academy" },
  { slug: "registrations", title: "Registrations", url: "/admin/registrations" },
  { slug: "contacts", title: "Contacts", url: "/admin/contacts" },
  { slug: "mailer", title: "Mailer", url: "/admin/mailer" },
  { slug: "analytics", title: "Analytics", url: "/admin/analytics" },
  { slug: "discounts", title: "Discounts", url: "/admin/discounts" },
  { slug: "team", title: "Team", url: "/admin/team", secondary: true },
  { slug: "domains", title: "Domains", url: "/admin/domains", secondary: true },
  { slug: "settings", title: "Settings", url: "/admin/settings", secondary: true },
];

const venueTabs: TabDef[] = [
  { slug: "dashboard", title: "Dashboard", url: "/admin" },
  { slug: "calendar", title: "Bookings Calendar", url: "/admin/calendar" },
  { slug: "booking-requests", title: "Booking Requests", url: "/admin/booking-requests" },
  { slug: "website", title: "Website", url: "/admin/website" },
  { slug: "analytics", title: "Analytics", url: "/admin/analytics" },
  { slug: "facilities", title: "Facilities", url: "/admin/facilities" },
  { slug: "addons", title: "Add-ons", url: "/admin/addons" },
  { slug: "people", title: "People & Access", url: "/admin/people" },
  { slug: "payments", title: "Payments", url: "/admin/payments" },
  { slug: "team", title: "Team", url: "/admin/team", secondary: true },
  { slug: "domains", title: "Domains", url: "/admin/domains", secondary: true },
  { slug: "settings", title: "Settings", url: "/admin/venue-settings", secondary: true },
];

const leagueTabs: TabDef[] = [
  { slug: "dashboard", title: "Dashboard", url: "/admin" },
  { slug: "competitions", title: "Competitions", url: "/admin/competitions" },
  { slug: "teams", title: "Teams", url: "/admin/teams" },
  { slug: "discounts", title: "Discounts", url: "/admin/discounts" },
  { slug: "team", title: "Team", url: "/admin/team", secondary: true },
  { slug: "domains", title: "Domains", url: "/admin/domains", secondary: true },
  { slug: "settings", title: "Settings", url: "/admin/league-settings", secondary: true },
];

const tournamentTabs: TabDef[] = [
  { slug: "dashboard", title: "Dashboard", url: "/admin" },
  { slug: "tournaments", title: "Tournaments", url: "/admin/tournaments" },
  { slug: "clubs", title: "Clubs", url: "/admin/clubs" },
  { slug: "skills-challenge", title: "Skills Challenge", url: "/admin/skills-challenge" },
  { slug: "team", title: "Team", url: "/admin/team", secondary: true },
  { slug: "domains", title: "Domains", url: "/admin/domains", secondary: true },
  { slug: "settings", title: "Settings", url: "/admin/tournament-settings", secondary: true },
];

const gymnasticsTabs: TabDef[] = [
  { slug: "dashboard", title: "Dashboard", url: "/admin" },
  { slug: "programs", title: "Programs", url: "/admin/programs" },
  { slug: "team", title: "Team", url: "/admin/team", secondary: true },
  { slug: "domains", title: "Domains", url: "/admin/domains", secondary: true },
  { slug: "settings", title: "Settings", url: "/admin/gymnastics-settings", secondary: true },
];

const groupTabs: TabDef[] = [
  { slug: "dashboard", title: "Dashboard", url: "/admin" },
  { slug: "calendar", title: "Calendar", url: "/admin/calendar" },
  { slug: "projects", title: "Projects", url: "/admin/projects" },
  { slug: "sponsorship", title: "Sponsorship", url: "/admin/sponsorship" },
  { slug: "budget", title: "Budget", url: "/admin/budget" },
  { slug: "team", title: "Team", url: "/admin/team", secondary: true },
  { slug: "domains", title: "Domains", url: "/admin/domains", secondary: true },
  { slug: "settings", title: "Settings", url: "/admin/settings", secondary: true },
];

const printsTabs: TabDef[] = [
  { slug: "dashboard", title: "Dashboard", url: "/admin" },
  { slug: "jobs", title: "Jobs", url: "/admin/print-jobs" },
  { slug: "orders", title: "Orders", url: "/admin/print-orders" },
  { slug: "materials", title: "Materials", url: "/admin/print-materials" },
  { slug: "crm", title: "CRM", url: "/admin/print-crm" },
  { slug: "projects", title: "Projects", url: "/admin/print-projects" },
  { slug: "analytics", title: "Analytics", url: "/admin/print-analytics" },
  { slug: "landing", title: "Landing Pages", url: "/admin/print-landing" },
  { slug: "email", title: "Email Sender", url: "/admin/print-email" },
  { slug: "integrations", title: "Integrations", url: "/admin/integrations", secondary: true },
  { slug: "team", title: "Team", url: "/admin/team", secondary: true },
  { slug: "domains", title: "Domains", url: "/admin/domains", secondary: true },
  { slug: "settings", title: "Settings", url: "/admin/settings", secondary: true },
];

export const TABS_BY_WORKSPACE_TYPE: Record<WorkspaceType, TabDef[]> = {
  camps: campsTabs,
  venue: venueTabs,
  league: leagueTabs,
  tournament: tournamentTabs,
  gymnastics: gymnasticsTabs,
  group: groupTabs,
  prints: printsTabs,
};

export function tabsForOrgSlug(orgSlug: string | undefined | null): TabDef[] {
  return TABS_BY_WORKSPACE_TYPE[workspaceTypeFor(orgSlug)];
}

/**
 * Tabs that are locked to super_admin ONLY while the feature is under
 * construction. Bypasses the usual admin/manager/tabs-array escalations.
 * When ready to open up, remove the slug here — the rest of the permission
 * system (workspace role + tabs whitelist) takes over.
 */
export const SUPER_ADMIN_ONLY_TABS: ReadonlySet<string> = new Set([
  "budget", // Phase 1 construction — staff salaries visible. Daniel only.
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
