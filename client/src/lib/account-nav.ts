/**
 * Where the account menu's destinations live.
 *
 * The Settings page is mounted on a DIFFERENT path per workspace type
 * (/admin/settings, /admin/venue-settings, /admin/league-settings…) — a legacy
 * of each workspace having its own route Switch in App.tsx. Team and Domains
 * are shared. That mapping used to be duplicated across eight per-workspace
 * arrays in app-sidebar.tsx; the account menu reads it from here instead, so
 * there is one place to change when a workspace's settings route moves.
 *
 * Every item still carries its `tab` slug, because the account menu applies
 * exactly the same `canAccessTab` check the sidebar did. Moving an item out of
 * the sidebar must never widen who can reach it.
 */

// Keep in step with the workspace predicates in app-sidebar.tsx.
const SETTINGS_URL_BY_SLUG: Record<string, string> = {
  "united-sports-centre": "/admin/venue-settings",
  "mini-football-leagues": "/admin/league-settings",
  "christchurch-international-cup": "/admin/tournament-settings",
  "united-gymnastics": "/admin/gymnastics-settings",
};

export function settingsUrlFor(slug: string | undefined): string {
  return (slug && SETTINGS_URL_BY_SLUG[slug]) || "/admin/settings";
}

export type AccountNavItem = {
  /** null = no tab gate; the route is requireAuth-only and personal. */
  tab: string | null;
  title: string;
  url: string;
};

/**
 * Personal items — these belong to the SIGNED-IN PERSON, not to a workspace,
 * so they carry no tab gate and appear for everyone.
 */
export const ACCOUNT_PERSONAL_ITEMS: AccountNavItem[] = [
  { tab: null, title: "Profile", url: "/admin/profile" },
  { tab: null, title: "Notifications", url: "/admin/notification-settings" },
];

/**
 * Admin items — workspace configuration. Each is gated by its tab slug exactly
 * as it was in the sidebar.
 */
export function accountAdminItems(slug: string | undefined): AccountNavItem[] {
  return [
    { tab: "settings", title: "Settings", url: settingsUrlFor(slug) },
    { tab: "team", title: "Team", url: "/admin/team" },
    { tab: "domains", title: "Domains", url: "/admin/domains" },
  ];
}
