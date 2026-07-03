/**
 * SINGLE SOURCE OF TRUTH — which real domain each ClubOS workspace uses for
 * transactional email (verified in Resend) and its public "join" landing host.
 *
 * When you add a NEW workspace: add an entry below, then from apps/clubos run
 *   node scripts/setup_workspace_domain.mjs email <emailDomain>
 *   node scripts/setup_workspace_domain.mjs join  <joinHost> <orgId>
 * (that script provisions Resend + GoDaddy DNS + the Fly cert + the custom_domains row).
 *
 * Email domains here are verified sending domains. Platform / system emails that are
 * org-agnostic (ClubOS auth, calendar invites, security alerts, the Football Institute
 * academy sub-brand) intentionally keep sending from cufc.co.nz.
 */

export interface WorkspaceDomain {
  slug: string;
  orgId: number;
  name: string;
  /** Verified Resend sending domain for this workspace. */
  emailDomain: string;
  /** Display name shown in the email "from". */
  fromName: string;
  /** Public landing-page host (camps / booking funnels), if the workspace has one. */
  joinHost?: string;
}

export const WORKSPACE_DOMAINS: WorkspaceDomain[] = [
  { slug: "christchurch-united",           orgId: 1, name: "Christchurch United",             emailDomain: "cufc.co.nz",             fromName: "Christchurch United",                 joinHost: "join.cufc.co.nz" },
  { slug: "south-island-united",           orgId: 2, name: "South Island United",             emailDomain: "southislandunited.com",  fromName: "South Island United",                 joinHost: "join.southislandunited.com" },
  { slug: "mini-football-leagues",         orgId: 3, name: "Mini Football Leagues",           emailDomain: "minifootball.co.nz",     fromName: "Mini Football Leagues",               joinHost: "join.minifootball.co.nz" },
  { slug: "united-sports-centre",          orgId: 4, name: "United Sports Centre",            emailDomain: "unitedsportscentre.com", fromName: "United Sports Centre",                joinHost: "book.unitedsportscentre.com" },
  { slug: "christchurch-international-cup", orgId: 5, name: "Christchurch International Cup",  emailDomain: "cicyouth.com",           fromName: "Christchurch International Cup",       joinHost: "join.cicyouth.com" },
  { slug: "united-gymnastics",             orgId: 6, name: "United Gymnastics",               emailDomain: "cugc.co.nz",             fromName: "Christchurch United Gymnastics Club", joinHost: "join.cugc.co.nz" },
  { slug: "united-sports-group",           orgId: 7, name: "United Sports Group",             emailDomain: "cufc.co.nz",             fromName: "United Sports Group" },
  { slug: "united-prints",                 orgId: 8, name: "United Prints",                   emailDomain: "unitedprints.co.nz",     fromName: "United Prints",                       joinHost: "join.unitedprints.co.nz" },
];

export function workspaceDomainByOrgId(orgId?: number | null): WorkspaceDomain | undefined {
  return orgId == null ? undefined : WORKSPACE_DOMAINS.find((w) => w.orgId === orgId);
}

export function workspaceDomainBySlug(slug?: string | null): WorkspaceDomain | undefined {
  return slug == null ? undefined : WORKSPACE_DOMAINS.find((w) => w.slug === slug);
}

/**
 * Build a transactional "from" for a workspace's camp/holiday emails, branded to
 * that workspace's own verified domain. Falls back to CUFC for unknown orgs.
 */
export function campFromForOrg(orgId?: number | null, suffix = "Camps"): string {
  const w = workspaceDomainByOrgId(orgId);
  if (!w) return "CUFC Camps <noreply@cufc.co.nz>";
  const label = suffix ? `${w.fromName} ${suffix}` : w.fromName;
  return `${label} <noreply@${w.emailDomain}>`;
}
