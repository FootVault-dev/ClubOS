// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Base — the club's vault, and the scope rules Rambo answers under.
//
// Two things live here because they must never drift apart:
//
//  1. The BRANDS a piece of knowledge can belong to (United Prints, CUFC, CIC…).
//  2. The ONE decider for whether a person may see a given piece of information —
//     used by the article reader, by Rambo's tool list, and by every stat tool's
//     own re-check. Three call sites, one function.
//
// 🔴 The whole point of the tab-based model: Rambo is not a new permission
// system. A person can learn through Rambo exactly what they could have learned
// by clicking around ClubOS themselves, and nothing else. If the Budget tab is
// closed to them, the budget is closed to them here — no matter how the question
// is phrased.
// ─────────────────────────────────────────────────────────────────────────────
import { canAccessTab, SUPER_ADMIN_ONLY_TABS, tabsForOrgSlug } from "./tabs";

// ── Brands ───────────────────────────────────────────────────────────────────
// A brand is the FILTER a reader picks ("show me United Prints knowledge"), not
// a permission. Knowledge about how we print a banner is not secret; the stats
// behind a tab are. Keep those two ideas apart.
export interface KbBrand {
  key: string;
  label: string;
  short: string;
  /** The ClubOS workspace this brand maps to, where one exists. */
  orgSlug?: string;
}

export const KB_BRANDS: KbBrand[] = [
  { key: "usg", label: "United Sports Group", short: "USG", orgSlug: "united-sports-group" },
  { key: "cufc", label: "Christchurch United FC", short: "CUFC", orgSlug: "christchurch-united" },
  { key: "siu", label: "South Island United", short: "SIU", orgSlug: "south-island-united" },
  { key: "mfl", label: "Mini Football Leagues", short: "MFL", orgSlug: "mini-football-leagues" },
  { key: "cic", label: "Christchurch International Cup", short: "CIC", orgSlug: "christchurch-international-cup" },
  { key: "cugc", label: "United Gymnastics", short: "Gymnastics", orgSlug: "united-gymnastics" },
  { key: "prints", label: "United Prints", short: "Prints", orgSlug: "united-prints" },
  { key: "usc", label: "United Sports Centre", short: "USC", orgSlug: "united-sports-centre" },
];

export const KB_BRAND_KEYS = KB_BRANDS.map((b) => b.key);

export function kbBrandLabel(key: string | null | undefined): string {
  if (!key || key === "all") return "All brands";
  return KB_BRANDS.find((b) => b.key === key)?.label ?? key;
}

export function isKbBrand(key: unknown): key is string {
  return typeof key === "string" && (key === "all" || KB_BRAND_KEYS.includes(key));
}

/** Article lifecycle. Only `published` is searchable by other staff or Rambo. */
export const KB_STATUSES = ["draft", "published", "archived"] as const;
export type KbStatus = (typeof KB_STATUSES)[number];

// Categories are a starting vocabulary, not a closed enum — the column is free
// text so a team can name its own. These seed the dropdown.
export const KB_CATEGORY_SUGGESTIONS = [
  "Print specifications",
  "Design specs",
  "File formats",
  "Placement & sizing",
  "Pricing & quoting",
  "How-to",
  "Policy",
  "Process",
  "Suppliers & contacts",
  "Troubleshooting",
  "Onboarding",
];

// ── The viewer ───────────────────────────────────────────────────────────────
// Built SERVER-SIDE from the live database on every request. Never accepted
// from the client, never cached in the session: revoking someone's access has
// to bite on their next message, not on their next login.
export interface ViewerMembership {
  orgSlug: string;
  orgName: string;
  /** Membership role in this workspace: admin | manager | team_member | coach … */
  role: string | null;
  /** Per-member tab whitelist. null = every tab in the workspace (legacy default). */
  tabs: string[] | null;
  /** Locked tabs (SUPER_ADMIN_ONLY_TABS) granted to this person by name.
   *  null/[] = none. A role never puts a slug in here. */
  unlockedTabs?: string[] | null;
}

export interface Viewer {
  userId: number;
  name: string;
  /** Global role — only "super_admin" is special. */
  globalRole: string | null;
  memberships: ViewerMembership[];
}

/**
 * Can this person reach `tabSlug`, and if so through which workspace?
 *
 * 🔴 THE TRAP THIS EXISTS TO CLOSE. `canAccessTab` returns true for ANY slug
 * when the member's role is admin or manager — it assumes the caller already
 * knows the tab belongs to that workspace, because the sidebar only ever asks
 * about tabs it is already rendering. Ask it cold, and Dima (an admin of United
 * Prints) "can access" the Budget tab, which only exists in USG. Rambo asks
 * cold. So the tab must be proven to EXIST in the workspace before the role is
 * allowed to answer for it.
 *
 * Everything else defers to canAccessTab so this can never drift from what the
 * sidebar shows and requireTab enforces.
 */
export function viewerCanReachTab(
  viewer: Viewer,
  tabSlug: string,
  orgSlug?: string,
): { allowed: boolean; via?: ViewerMembership } {
  // Super-admin-only tabs (budget, cashflow, housing, vehicles…): the global
  // role is the only key, or an explicit per-person grant on the membership.
  // No workspace ROLE opens these, by design — which is why this checks
  // `unlockedTabs` and never `tabs`.
  if (SUPER_ADMIN_ONLY_TABS.has(tabSlug)) {
    if (viewer.globalRole === "super_admin") return { allowed: true };
    const candidates = orgSlug
      ? viewer.memberships.filter((m) => m.orgSlug === orgSlug)
      : viewer.memberships;
    // The tab must still LIVE in the workspace granting it — the same cold-ask
    // trap this function exists to close applies to a grant as much as a role.
    const via = candidates.find(
      (m) =>
        Array.isArray(m.unlockedTabs) &&
        m.unlockedTabs.includes(tabSlug) &&
        tabsForOrgSlug(m.orgSlug).some((t) => t.slug === tabSlug),
    );
    return via ? { allowed: true, via } : { allowed: false };
  }
  if (viewer.globalRole === "super_admin") return { allowed: true };

  const candidates = orgSlug
    ? viewer.memberships.filter((m) => m.orgSlug === orgSlug)
    : viewer.memberships;

  for (const m of candidates) {
    const tabLivesHere = tabsForOrgSlug(m.orgSlug).some((t) => t.slug === tabSlug);
    if (!tabLivesHere) continue;
    const ok = canAccessTab({
      globalRole: viewer.globalRole,
      membershipRole: m.role,
      membershipTabs: m.tabs,
      tabSlug,
    });
    if (ok) return { allowed: true, via: m };
  }
  return { allowed: false };
}

/**
 * May this person read an article? An article with no `requiredTab` is open to
 * every staff member — that is the normal case and the point of the vault.
 */
export function viewerCanReadArticle(
  viewer: Viewer,
  article: { requiredTab?: string | null; requiredWorkspace?: string | null },
): boolean {
  if (!article.requiredTab) return true;
  return viewerCanReachTab(viewer, article.requiredTab, article.requiredWorkspace ?? undefined).allowed;
}

// ── Rambo's tools ────────────────────────────────────────────────────────────
// A closed catalogue. Rambo cannot write SQL, cannot pick a table, and cannot
// widen its own reach: each tool is a hand-written, parameter-bounded query,
// and the list handed to the model is filtered per request by the rules above.
//
// 🔴 Tools a person cannot use are NEVER SENT TO THE MODEL. Not sent-and-
// refused, not sent-with-a-warning — absent. A model cannot leak, be talked
// into, or hallucinate its way past a capability it was never given, and no
// prompt-injection in an article body can conjure one. Restricted data must
// never enter the context in the first place.
export interface RamboToolDef {
  name: string;
  /** Shown to the human in "what Rambo can see for you". */
  title: string;
  /** Shown to the model. */
  description: string;
  /** The ClubOS tab this data lives behind. null = open to all staff. */
  requiredTab: string | null;
  /** Judge the tab in this workspace specifically. Omit for "any of theirs". */
  workspaceSlug?: string;
  inputSchema: Record<string, unknown>;
}

export const RAMBO_TOOLS: RamboToolDef[] = [
  {
    name: "search_knowledge_base",
    title: "The knowledge base",
    description:
      "Search the club's knowledge base for written articles, specifications and procedures. " +
      "ALWAYS use this before answering any question about how the club does something. " +
      "Returns article titles, categories and their full text.",
    requiredTab: null,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search for, e.g. 'banner roll width' or 'file format for corflute'." },
        brand: {
          type: "string",
          description:
            "Optional brand filter. One of: " + KB_BRAND_KEYS.join(", ") + ". Omit to search every brand.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "print_materials",
    title: "United Prints materials & rates",
    description:
      "The live United Prints product catalogue: every material, its pricing method and rates, its minimum and maximum " +
      "printable size in millimetres, the printer roll width it runs on, turnaround days, and whether it needs a human quote. " +
      "This is the authoritative source for what United Prints can physically produce and what it costs.",
    requiredTab: "materials",
    workspaceSlug: "united-prints",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional name or category filter, e.g. 'corflute' or 'banner'." },
      },
    },
  },
  {
    name: "print_jobs_summary",
    title: "United Prints job pipeline",
    description:
      "How many print jobs sit at each stage of the production pipeline right now, and the most recent jobs. " +
      "Use for questions about print workload, what is in production, or how busy the shop is.",
    requiredTab: "jobs",
    workspaceSlug: "united-prints",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "programme_list",
    title: "Programmes & prices",
    description:
      "The programmes a workspace runs — name, type, whether registration is open, capacity and the term or session price. " +
      "Use for questions about what we offer, what it costs a family, or whether something is open for sign-up.",
    requiredTab: "academy",
    inputSchema: {
      type: "object",
      properties: {
        brand: { type: "string", description: "Brand key: " + KB_BRAND_KEYS.join(", ") },
      },
    },
  },
  {
    name: "registration_counts",
    title: "Registration numbers",
    description:
      "How many registrations exist per programme, broken down by status (confirmed, pending, cancelled). " +
      "Use for questions about how many players or children are signed up.",
    requiredTab: "registrations",
    inputSchema: {
      type: "object",
      properties: {
        brand: { type: "string", description: "Brand key: " + KB_BRAND_KEYS.join(", ") },
      },
    },
  },
  {
    name: "sponsorship_summary",
    title: "Sponsors",
    description:
      "The club's current sponsors by brand and tier, and whether their website is reachable. " +
      "Use for questions about who sponsors us.",
    requiredTab: "sponsorship",
    workspaceSlug: "united-sports-group",
    inputSchema: {
      type: "object",
      properties: {
        brand: { type: "string", description: "Brand key: " + KB_BRAND_KEYS.join(", ") },
      },
    },
  },
  {
    name: "budget_summary",
    title: "Budget",
    description:
      "Budgeted and actual figures by cost centre for a financial year. Financial planning data.",
    // 🔴 "budget" is in SUPER_ADMIN_ONLY_TABS, so viewerCanReachTab resolves this
    // to Daniel alone — including for a workspace admin or manager. This tool is
    // the canary: if it ever appears for anyone else, the gate is broken.
    requiredTab: "budget",
    workspaceSlug: "united-sports-group",
    inputSchema: {
      type: "object",
      properties: {
        year: { type: "number", description: "Financial year, e.g. 2026. Defaults to the current year." },
      },
    },
  },
  {
    name: "search_drive",
    title: "Club Drive files",
    description:
      "Search Club Drive — every document the club stores: contracts, proposals, budgets, policies, plans, " +
      "spreadsheets and PDFs. Searches the CONTENTS of files as well as their names, so use it when someone " +
      "half-remembers a document ('the thing about the gym partnership', 'that sponsorship deck from last year') " +
      "and cannot name it. Returns the file name, where it sits in the folder tree, and a matching extract. " +
      "Always give the person the file name and its folder path so they can go and open it.",
    // 🔴 null on purpose: every staff member may SEARCH the drive. Files are
    // then filtered one by one against that person's real tab access inside the
    // handler — a locked file never reaches the model, not even its name.
    // Gating the whole tool instead would either hide the drive from everyone
    // or expose every contract in it.
    requiredTab: null,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, e.g. 'gym partnership agreement' or 'academy fee schedule'." },
      },
      required: ["query"],
    },
  },
];

/**
 * The tools this person may actually use — the list that gets sent to the model.
 * `search_knowledge_base` is always present; everything else has to be earned.
 */
export function ramboToolsFor(viewer: Viewer): RamboToolDef[] {
  return RAMBO_TOOLS.filter((t) => {
    if (!t.requiredTab) return true;
    return viewerCanReachTab(viewer, t.requiredTab, t.workspaceSlug).allowed;
  });
}

export function ramboToolByName(name: string): RamboToolDef | undefined {
  return RAMBO_TOOLS.find((t) => t.name === name);
}
