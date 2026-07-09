import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import {
  LayoutDashboard,
  Tent,
  ClipboardCheck,
  ListChecks,
  Users,
  Mail,
  Settings,
  LogOut,
  ChevronDown,
  Check,
  Building2,
  Calendar,
  BarChart3,
  Shield,
  Puzzle,
  CreditCard,
  Trophy,
  UsersRound,
  Award,
  Crown,
  Dumbbell,
  Tag,
  Globe,
  Handshake,
  HeartHandshake,
  Landmark,
  GraduationCap,
  Printer,
  ShoppingCart,
  FolderKanban,
  FileText,
  FileSignature,
  Sparkles,
  Send,
  ExternalLink,
  Sun,
  Moon,
  Zap,
  Truck,
  UtensilsCrossed,
  Inbox,
  School,
  BellRing,
  CalendarCheck,
  Waves,
  Clapperboard,
  MessageCircle,
  Radio,
  FlaskConical,
  Fingerprint,
  Telescope,
  MessageSquarePlus,
  Link2,
  Target,
} from "lucide-react";

// Universal "Feedback" tab — shown in EVERY workspace's System section so any
// staff member can report a bug / request a feature from wherever they are.
// Access is gated server-side by requireAuth (not a per-workspace tab grant),
// so it's appended directly to secondaryNav below, bypassing the tab whitelist.
const feedbackSecondary = { tab: "feedback", title: "Feedback", url: "/admin/feedback", icon: MessageSquarePlus };
import { useTheme } from "@/lib/theme-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useWorkspace } from "@/lib/workspace-context";
import { canAccessTab } from "@shared/tabs";

type Org = {
  id: number;
  name: string;
  slug: string;
  logoUrl: string | null;
  active: boolean;
  userRole: string;
  userTabs: string[] | null;
};

// Each nav item carries a `tab` slug matching shared/tabs.ts. The sidebar
// filters items at render time based on the user's userTabs whitelist.
const campsNav = [
  { tab: "dashboard", title: "Dashboard", url: "/admin", icon: LayoutDashboard },
  { tab: "links", title: "Links", url: "/admin/links", icon: Link2 },
  { tab: "attribution", title: "Attribution", url: "/admin/attribution", icon: Target },
  { tab: "camps", title: "Camps", url: "/admin/camps", icon: Tent },
  { tab: "academy", title: "Academy", url: "/admin/academy", icon: GraduationCap },
  { tab: "squads", title: "Squads", url: "/admin/squads", icon: Shield },
  // Terms intentionally NOT in the sidebar — it's reachable as a sub-tab
  // from the Academy page (Programs / Term Dates), matching the gymnastics
  // workspace's All Programs / Term Dates pattern.
  { tab: "registrations", title: "Registrations", url: "/admin/registrations", icon: ClipboardCheck },
  { tab: "contacts", title: "Contacts", url: "/admin/contacts", icon: Users },
  { tab: "volunteers", title: "Volunteers", url: "/admin/volunteers", icon: HeartHandshake },
  { tab: "mailer", title: "Mailer", url: "/admin/mailer", icon: Mail },
  // CUFC newsletter mailer (tabs.ts slug "cufc-mailer") — titled "Newsletters"
  // here so it doesn't collide with the camps "Mailer" item (nav keys by title).
  { tab: "cufc-mailer", title: "Newsletters", url: "/admin/cufc-mailer", icon: Send },
  { tab: "predictor", title: "Play Predictor", url: "/admin/predictor", icon: Trophy },
  { tab: "football-institute", title: "Football Institute", url: "/admin/football-institute", icon: School },
  { tab: "analytics", title: "Analytics", url: "/admin/analytics", icon: BarChart3 },
  { tab: "discounts", title: "Discounts", url: "/admin/discounts", icon: Tag },
];

// South Island United shares the camps workspace type with CUFC but adds its own
// club-building tools (must NOT show for CUFC).
const siuNav = [
  ...campsNav,
  { tab: "licensing", title: "OFC Licensing", url: "/admin/licensing", icon: Award },
  { tab: "declarations", title: "Declarations", url: "/admin/declarations", icon: FileSignature },
  { tab: "events", title: "Community Events", url: "/admin/events", icon: Calendar },
  { tab: "membership", title: "Membership", url: "/admin/membership", icon: Crown },
];

const venueNav = [
  { tab: "dashboard", title: "Dashboard", url: "/admin", icon: LayoutDashboard },
  { tab: "links", title: "Links", url: "/admin/links", icon: Link2 },
  { tab: "attribution", title: "Attribution", url: "/admin/attribution", icon: Target },
  { tab: "calendar", title: "Bookings Calendar", url: "/admin/calendar", icon: Calendar },
  { tab: "bookings", title: "Bookings", url: "/admin/bookings", icon: ListChecks },
  { tab: "booking-requests", title: "Booking Requests", url: "/admin/booking-requests", icon: ClipboardCheck },
  { tab: "website", title: "Website", url: "/admin/website", icon: Globe },
  { tab: "analytics", title: "Analytics", url: "/admin/analytics", icon: BarChart3 },
  { tab: "facilities", title: "Facilities", url: "/admin/facilities", icon: Shield },
  { tab: "addons", title: "Add-ons", url: "/admin/addons", icon: Puzzle },
  { tab: "people", title: "People & Access", url: "/admin/people", icon: Users },
  { tab: "payments", title: "Payments", url: "/admin/payments", icon: CreditCard },
];

const campsSecondary = [
  { tab: "studio", title: "Studio", url: "/admin/studio", icon: Sparkles },
  { tab: "esign", title: "E-Sign", url: "/admin/esign", icon: FileSignature },
  { tab: "team", title: "Team", url: "/admin/team", icon: Users },
  { tab: "domains", title: "Domains", url: "/admin/domains", icon: Globe },
  { tab: "settings", title: "Settings", url: "/admin/settings", icon: Settings },
];

const leagueNav = [
  { tab: "dashboard", title: "Dashboard", url: "/admin", icon: LayoutDashboard },
  { tab: "links", title: "Links", url: "/admin/links", icon: Link2 },
  { tab: "attribution", title: "Attribution", url: "/admin/attribution", icon: Target },
  { tab: "competitions", title: "Terms", url: "/admin/competitions", icon: Trophy },
  { tab: "teams", title: "Teams", url: "/admin/teams", icon: UsersRound },
  { tab: "payments", title: "Payments", url: "/admin/payments", icon: CreditCard },
  { tab: "discounts", title: "Discounts", url: "/admin/discounts", icon: Tag },
  { tab: "mailer", title: "Mailer", url: "/admin/mailer", icon: Mail },
  { tab: "inbox", title: "Inbox", url: "/admin/inbox", icon: Inbox },
  { tab: "mfl-livechat", title: "Live Chat", url: "/admin/mfl-livechat", icon: MessageCircle },
  { tab: "rewards", title: "Rewards", url: "/admin/rewards", icon: Award },
  { tab: "loyalty", title: "Loyalty", url: "/admin/loyalty", icon: Crown },
  { tab: "analytics", title: "Analytics", url: "/admin/analytics", icon: BarChart3 },
  { tab: "business-plan", title: "Business Plan", url: "/admin/business-plan", icon: FileText },
];

const venueSecondary = [
  { tab: "studio", title: "Studio", url: "/admin/studio", icon: Sparkles },
  { tab: "esign", title: "E-Sign", url: "/admin/esign", icon: FileSignature },
  { tab: "team", title: "Team", url: "/admin/team", icon: Users },
  { tab: "domains", title: "Domains", url: "/admin/domains", icon: Globe },
  { tab: "settings", title: "Settings", url: "/admin/venue-settings", icon: Settings },
];

const leagueSecondary = [
  { tab: "studio", title: "Studio", url: "/admin/studio", icon: Sparkles },
  { tab: "esign", title: "E-Sign", url: "/admin/esign", icon: FileSignature },
  { tab: "team", title: "Team", url: "/admin/team", icon: Users },
  { tab: "domains", title: "Domains", url: "/admin/domains", icon: Globe },
  { tab: "settings", title: "Settings", url: "/admin/league-settings", icon: Settings },
];

const tournamentNav = [
  { tab: "dashboard", title: "Dashboard", url: "/admin", icon: LayoutDashboard },
  { tab: "links", title: "Links", url: "/admin/links", icon: Link2 },
  { tab: "attribution", title: "Attribution", url: "/admin/attribution", icon: Target },
  { tab: "tournaments", title: "Tournaments", url: "/admin/tournaments", icon: Award },
  { tab: "clubs", title: "Clubs", url: "/admin/clubs", icon: Shield },
  { tab: "skills-challenge", title: "Skills Challenge", url: "/admin/skills-challenge", icon: Zap },
  { tab: "food-truck", title: "Food Truck", url: "/admin/food-truck", icon: Truck },
  { tab: "vendors", title: "Vendors", url: "/admin/vendors", icon: UtensilsCrossed },
  { tab: "volunteers", title: "Volunteers", url: "/admin/volunteers", icon: HeartHandshake },
  { tab: "cic-registrations", title: "Registrations", url: "/admin/cic-registrations", icon: Inbox },
  { tab: "cic-livechat", title: "Live Chat", url: "/admin/cic-livechat", icon: MessageCircle },
  { tab: "cic-mailer", title: "Mailer", url: "/admin/cic-mailer", icon: Mail },
  { tab: "cic-push", title: "Notifications", url: "/admin/cic-push", icon: BellRing },
  { tab: "cic-logo-consents", title: "Logo Consents", url: "/admin/cic-logo-consents", icon: ClipboardCheck },
  { tab: "cic-watch", title: "Watch", url: "/admin/cic-watch", icon: Radio },
  { tab: "cic-content-marketplace", title: "Content Marketplace", url: "/admin/cic-content-marketplace", icon: BarChart3 },
];

const tournamentSecondary = [
  { tab: "studio", title: "Studio", url: "/admin/studio", icon: Sparkles },
  { tab: "esign", title: "E-Sign", url: "/admin/esign", icon: FileSignature },
  { tab: "team", title: "Team", url: "/admin/team", icon: Users },
  { tab: "domains", title: "Domains", url: "/admin/domains", icon: Globe },
  { tab: "settings", title: "Settings", url: "/admin/tournament-settings", icon: Settings },
];

// CIC 7's view (toggled from the youth tournament via the Youth/7's switcher).
const tournament7sNav = [
  { tab: "cic7s-registrations", title: "Registrations", url: "/admin/cic7s-registrations", icon: ClipboardCheck },
  { tab: "cic-mailer", title: "Mailer", url: "/admin/cic-mailer", icon: Mail },
];

const gymnasticsNav = [
  { tab: "dashboard", title: "Dashboard", url: "/admin", icon: LayoutDashboard },
  { tab: "links", title: "Links", url: "/admin/links", icon: Link2 },
  { tab: "attribution", title: "Attribution", url: "/admin/attribution", icon: Target },
  { tab: "programs", title: "Programs", url: "/admin/programs", icon: GraduationCap },
  { tab: "cugc-registrations", title: "Registrations", url: "/admin/cugc-registrations", icon: ClipboardCheck },
  { tab: "cugc-free-sessions", title: "Free Sessions", url: "/admin/cugc-free-sessions", icon: CalendarCheck },
  { tab: "cugc-analytics", title: "Analytics", url: "/admin/cugc-analytics", icon: BarChart3 },
  { tab: "cugc-inbox", title: "Inbox", url: "/admin/cugc-inbox", icon: Inbox },
  { tab: "cugc-livechat", title: "Live Chat", url: "/admin/cugc-livechat", icon: MessageCircle },
];

const gymnasticsSecondary = [
  { tab: "studio", title: "Studio", url: "/admin/studio", icon: Sparkles },
  { tab: "esign", title: "E-Sign", url: "/admin/esign", icon: FileSignature },
  { tab: "team", title: "Team", url: "/admin/team", icon: Users },
  { tab: "domains", title: "Domains", url: "/admin/domains", icon: Globe },
  { tab: "settings", title: "Settings", url: "/admin/gymnastics-settings", icon: Settings },
];

const groupNav = [
  { tab: "dashboard", title: "Dashboard", url: "/admin", icon: LayoutDashboard },
  { tab: "links", title: "Links", url: "/admin/links", icon: Link2 },
  { tab: "attribution", title: "Attribution", url: "/admin/attribution", icon: Target },
  { tab: "calendar", title: "Calendar", url: "/admin/calendar", icon: Calendar },
  { tab: "projects", title: "Projects", url: "/admin/projects", icon: ClipboardCheck },
  { tab: "content", title: "Content", url: "/admin/content", icon: Clapperboard },
  { tab: "sponsorship", title: "Sponsorship", url: "/admin/sponsorship", icon: Handshake },
  { tab: "proposals", title: "Proposals", url: "/admin/proposals", icon: Send },
  { tab: "grants", title: "Grants", url: "/admin/grants", icon: Landmark },
  { tab: "budget", title: "Budget", url: "/admin/budget", icon: CreditCard },
  { tab: "cashflow", title: "Cashflow", url: "/admin/cashflow", icon: Waves },
];

const groupSecondary = [
  { tab: "studio", title: "Studio", url: "/admin/studio", icon: Sparkles },
  { tab: "esign", title: "E-Sign", url: "/admin/esign", icon: FileSignature },
  { tab: "team", title: "Team", url: "/admin/team", icon: Users },
  { tab: "domains", title: "Domains", url: "/admin/domains", icon: Globe },
  { tab: "settings", title: "Settings", url: "/admin/settings", icon: Settings },
];

const printsNav = [
  { tab: "dashboard", title: "Dashboard", url: "/admin", icon: LayoutDashboard },
  { tab: "links", title: "Links", url: "/admin/links", icon: Link2 },
  { tab: "attribution", title: "Attribution", url: "/admin/attribution", icon: Target },
  { tab: "jobs", title: "Jobs", url: "/admin/print-jobs", icon: FolderKanban },
  { tab: "orders", title: "Orders", url: "/admin/print-orders", icon: ShoppingCart },
  { tab: "materials", title: "Materials", url: "/admin/print-materials", icon: FileText },
  { tab: "crm", title: "CRM", url: "/admin/print-crm", icon: Users },
  { tab: "print-livechat", title: "Live Chat", url: "/admin/print-livechat", icon: MessageCircle },
  { tab: "projects", title: "Projects", url: "/admin/print-projects", icon: FolderKanban },
  { tab: "analytics", title: "Analytics", url: "/admin/print-analytics", icon: BarChart3 },
  { tab: "landing", title: "Landing Pages", url: "/admin/print-landing", icon: FileText },
  { tab: "email", title: "Email Sender", url: "/admin/print-email", icon: Send },
];

const printsSecondary = [
  { tab: "integrations", title: "Integrations", url: "/admin/integrations", icon: Globe },
  { tab: "studio", title: "Studio", url: "/admin/studio", icon: Sparkles },
  { tab: "esign", title: "E-Sign", url: "/admin/esign", icon: FileSignature },
  { tab: "team", title: "Team", url: "/admin/team", icon: Users },
  { tab: "domains", title: "Domains", url: "/admin/domains", icon: Globe },
  { tab: "settings", title: "Settings", url: "/admin/settings", icon: Settings },
];

// Sandbox — private super-admin experimentation workspace (Daniel only).
const sandboxNav = [
  { tab: "club-dossier", title: "Club Dossier", url: "/admin/club-dossier", icon: Fingerprint },
  { tab: "market-research", title: "Market Research", url: "/admin/market-research", icon: Telescope },
];

const sandboxSecondary = [
  { tab: "team", title: "Team", url: "/admin/team", icon: Users },
];

function PreviewPublicSiteLink({ orgId, orgSlug }: { orgId: number; orgSlug: string }) {
  const { data: domains } = useQuery<Array<{ domain: string; verified: boolean; isPrimary: boolean; status: string }>>({
    queryKey: ["/api/admin/domains", { organizationId: orgId }],
  });
  const primary = domains?.find(d => d.isPrimary && d.verified)
    ?? domains?.find(d => d.verified)
    ?? null;
  const href = primary ? `https://${primary.domain}/` : `/book?slug=${orgSlug}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-between gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-[11px] font-medium text-blue-300 hover:bg-blue-500/10 hover:text-blue-200 transition-colors"
      data-testid="link-preview-public-site"
    >
      <span className="flex items-center gap-2 min-w-0">
        <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
        <span className="truncate">{primary ? primary.domain : "View public site"}</span>
      </span>
      <span className="text-[9px] text-blue-300/40 uppercase tracking-wider flex-shrink-0">open</span>
    </a>
  );
}

function WorkspaceSwitcher() {
  const { currentOrg, setCurrentOrg, organizations, setOrganizations } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [, setLocation] = useLocation();
  const { data: user } = useQuery<{ organizations?: Org[] }>({ queryKey: ["/api/auth/me"] });

  useEffect(() => {
    if (user?.organizations && user.organizations.length > 0) {
      setOrganizations(user.organizations);
    }
  }, [user?.organizations, setOrganizations]);

  if (!currentOrg || organizations.length === 0) return null;

  const handleSwitch = (org: Org) => {
    setCurrentOrg(org);
    setOpen(false);
    setLocation("/admin");
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.03] transition-all cursor-pointer group"
        data-testid="button-workspace-switcher"
      >
        <div className="w-8 h-8 rounded-lg overflow-hidden flex-shrink-0 bg-white/[0.06] border border-white/[0.08] flex items-center justify-center">
          {currentOrg.logoUrl ? (
            <img src={currentOrg.logoUrl} alt={currentOrg.name} className="w-full h-full object-cover" />
          ) : (
            <Building2 className="w-4 h-4 text-white/30" />
          )}
        </div>
        <div className="flex-1 min-w-0 text-left">
          <p className="text-[12px] font-medium text-white/80 truncate" data-testid="text-workspace-name">{currentOrg.name}</p>
          <p className="text-[9px] text-blue-400/30 uppercase tracking-wider">Workspace</p>
        </div>
        <ChevronDown className={`w-3.5 h-3.5 text-white/20 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-2 right-2 top-full mt-1 z-50 rounded-xl border border-blue-500/15 bg-[#0a0e1a] shadow-2xl shadow-black/50 overflow-hidden" data-testid="dropdown-workspace">
            <div className="px-3 py-2 border-b border-white/[0.04]">
              <p className="text-[9px] text-blue-300/25 uppercase tracking-wider font-semibold">Switch Workspace</p>
            </div>
            <div className="py-1 max-h-[280px] overflow-y-auto">
              {organizations.map(org => (
                <button
                  key={org.id}
                  onClick={() => handleSwitch(org)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 transition-all cursor-pointer ${
                    currentOrg.id === org.id ? "bg-blue-500/10" : "hover:bg-white/[0.03]"
                  }`}
                  data-testid={`button-workspace-${org.slug}`}
                >
                  <div className="w-7 h-7 rounded-lg overflow-hidden flex-shrink-0 bg-white/[0.06] border border-white/[0.06] flex items-center justify-center">
                    {org.logoUrl ? (
                      <img src={org.logoUrl} alt={org.name} className="w-full h-full object-cover" />
                    ) : (
                      <Building2 className="w-3.5 h-3.5 text-white/25" />
                    )}
                  </div>
                  <span className={`flex-1 text-left text-[12px] truncate ${
                    currentOrg.id === org.id ? "text-blue-400 font-medium" : "text-white/60"
                  }`}>{org.name}</span>
                  {currentOrg.id === org.id && (
                    <Check className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Youth ⇄ CIC 7's sub-view toggle — only shown inside the CIC (tournament)
// workspace. Switching also navigates so the page matches the selected view.
function CicViewToggle() {
  const { cicView, setCicView } = useWorkspace();
  const [, setLocation] = useLocation();
  const select = (v: "youth" | "7s") => {
    setCicView(v);
    setLocation(v === "7s" ? "/admin/cic7s-registrations" : "/admin");
  };
  return (
    <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.06]" data-testid="toggle-cic-view">
      {(["youth", "7s"] as const).map((v) => (
        <button
          key={v}
          onClick={() => select(v)}
          className={`flex-1 text-[11px] font-semibold uppercase tracking-wider py-1.5 rounded-lg transition-all cursor-pointer ${
            cicView === v ? "bg-blue-500/15 text-blue-300 border border-blue-500/25" : "text-white/40 hover:text-white/60"
          }`}
          data-testid={`button-cic-view-${v}`}
        >
          {v === "youth" ? "CIC Youth" : "CIC 7's"}
        </button>
      ))}
    </div>
  );
}

function isVenueWorkspace(slug: string | undefined) {
  return slug === "united-sports-centre";
}

function isLeagueWorkspace(slug: string | undefined) {
  return slug === "mini-football-leagues";
}

function isTournamentWorkspace(slug: string | undefined) {
  return slug === "christchurch-international-cup";
}

function isGymnasticsWorkspace(slug: string | undefined) {
  return slug === "united-gymnastics";
}

function isGroupWorkspace(slug: string | undefined) {
  return slug === "united-sports-group";
}

function isPrintsWorkspace(slug: string | undefined) {
  return slug === "united-prints";
}

function isSandboxWorkspace(slug: string | undefined) {
  return slug === "sandbox";
}

function getWorkspaceLabel(slug: string | undefined) {
  if (isVenueWorkspace(slug)) return "Venue";
  if (isLeagueWorkspace(slug)) return "Leagues";
  if (isTournamentWorkspace(slug)) return "Tournaments";
  if (isGymnasticsWorkspace(slug)) return "Gymnastics";
  if (isGroupWorkspace(slug)) return "Group";
  if (isPrintsWorkspace(slug)) return "Print Studio";
  if (isSandboxWorkspace(slug)) return "Sandbox";
  return "Management";
}

function getWorkspaceInitials(slug: string | undefined) {
  if (isVenueWorkspace(slug)) return "US";
  if (isLeagueWorkspace(slug)) return "ML";
  if (isTournamentWorkspace(slug)) return "CI";
  if (isGymnasticsWorkspace(slug)) return "UG";
  if (isGroupWorkspace(slug)) return "SG";
  if (isPrintsWorkspace(slug)) return "UP";
  if (isSandboxWorkspace(slug)) return "SB";
  return "CU";
}

export function AppSidebar() {
  const [location] = useLocation();
  const { currentOrg, cicView } = useWorkspace();
  const { resolved: themeResolved, toggle: toggleTheme } = useTheme();
  const { data: user } = useQuery<{ firstName: string; lastName: string; role: string }>({ queryKey: ["/api/auth/me"] });

  const isVenue = isVenueWorkspace(currentOrg?.slug);
  const isLeague = isLeagueWorkspace(currentOrg?.slug);
  const isTournament = isTournamentWorkspace(currentOrg?.slug);
  const isGymnastics = isGymnasticsWorkspace(currentOrg?.slug);
  const isGroup = isGroupWorkspace(currentOrg?.slug);
  const isPrints = isPrintsWorkspace(currentOrg?.slug);
  const isSandbox = isSandboxWorkspace(currentOrg?.slug);
  const isSiu = currentOrg?.slug === "south-island-united";
  const tournamentMainNav = cicView === "7s" ? tournament7sNav : tournamentNav;
  const allMainNav = isSandbox ? sandboxNav : isPrints ? printsNav : isGroup ? groupNav : isGymnastics ? gymnasticsNav : isTournament ? tournamentMainNav : isLeague ? leagueNav : isVenue ? venueNav : isSiu ? siuNav : campsNav;
  const allSecondaryNav = isSandbox ? sandboxSecondary : isPrints ? printsSecondary : isGroup ? groupSecondary : isGymnastics ? gymnasticsSecondary : isTournament ? tournamentSecondary : isLeague ? leagueSecondary : isVenue ? venueSecondary : campsSecondary;

  // Filter nav by the user's tab whitelist for this workspace.
  // canAccessTab handles the bypass cases (super_admin, admin/manager role,
  // null tabs = full access for legacy memberships).
  const navFilter = (item: { tab: string }) => canAccessTab({
    globalRole: user?.role,
    membershipRole: currentOrg?.userRole,
    membershipTabs: currentOrg?.userTabs,
    tabSlug: item.tab,
  });
  const mainNav = allMainNav.filter(navFilter);
  // Feedback is universal — always show it (no tab-whitelist filtering), for
  // every staff member in every workspace.
  const secondaryNav = [...allSecondaryNav.filter(navFilter), feedbackSecondary];

  const logoutMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/logout"),
    onSuccess: () => {
      queryClient.clear();
      window.location.href = "/admin/login";
    },
  });

  return (
    <Sidebar className="sidebar-gradient">
      <SidebarHeader className="px-3 py-4 border-b border-blue-500/[0.08] space-y-3">
        <div className="flex items-center gap-3 px-1">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shadow-lg shadow-blue-500/25 animate-pulse-glow">
            <span className="text-white font-bold text-xs tracking-tight">{getWorkspaceInitials(currentOrg?.slug)}</span>
          </div>
          <div className="flex flex-col min-w-0">
            <span className="font-semibold text-[13px] text-white/90 tracking-tight truncate" data-testid="text-club-name">
              ClubOS
            </span>
            <span className="text-[10px] text-blue-400/40 tracking-wider uppercase">{getWorkspaceLabel(currentOrg?.slug)}</span>
          </div>
        </div>
        <WorkspaceSwitcher />
        {isTournament && <CicViewToggle />}
        {isVenue && currentOrg?.slug && (
          <PreviewPublicSiteLink orgId={currentOrg.id} orgSlug={currentOrg.slug} />
        )}
      </SidebarHeader>
      <SidebarContent className="px-3 py-4">
        <SidebarGroup>
          <SidebarGroupLabel className="text-[9px] uppercase tracking-[0.2em] text-blue-300/20 font-semibold mb-2 px-2">
            Navigation
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="space-y-0.5">
              {mainNav.map((item) => {
                const isActive = item.url === "/admin"
                  ? location === "/admin"
                  : location.startsWith(item.url);
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      data-active={isActive}
                      className={`rounded-xl h-9 transition-all duration-300 ${
                        isActive
                          ? "bg-gradient-to-r from-blue-500/15 to-blue-500/5 text-blue-400 border border-blue-500/25 shadow-[0_0_12px_rgba(3,86,197,0.1)]"
                          : "text-white/40 border border-transparent hover:text-white/60 hover:bg-white/[0.03]"
                      }`}
                    >
                      <Link href={item.url} data-testid={`link-nav-${item.title.toLowerCase().replace(/[\s&]/g, '-')}`}>
                        <item.icon className="w-4 h-4" />
                        <span className="text-[13px] font-medium truncate">{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto">
          <SidebarGroupLabel className="text-[9px] uppercase tracking-[0.2em] text-blue-300/20 font-semibold mb-2 px-2">
            System
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="space-y-0.5">
              {secondaryNav.map((item) => {
                const isActive = location.startsWith(item.url);
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      data-active={isActive}
                      className={`rounded-xl h-9 transition-all duration-300 ${
                        isActive
                          ? "bg-gradient-to-r from-blue-500/15 to-blue-500/5 text-blue-400 border border-blue-500/25 shadow-[0_0_12px_rgba(3,86,197,0.1)]"
                          : "text-white/40 border border-transparent hover:text-white/60 hover:bg-white/[0.03]"
                      }`}
                    >
                      <Link href={item.url} data-testid={`link-nav-${item.title.toLowerCase()}`}>
                        <item.icon className="w-4 h-4" />
                        <span className="text-[13px] font-medium truncate">{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-3 border-t border-blue-500/[0.08]">
        <div className="flex items-center gap-3 px-1">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-gradient-to-br from-blue-500 to-blue-700 text-white text-[11px] font-semibold shadow-lg shadow-blue-500/20">
              {user ? `${user.firstName[0]}${user.lastName[0]}` : "?"}
            </AvatarFallback>
          </Avatar>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[13px] font-medium text-white/75 truncate" data-testid="text-user-name">
              {user ? `${user.firstName} ${user.lastName}` : "..."}
            </span>
            <span className="text-[10px] text-blue-400/30 capitalize">{user?.role?.replace(/_/g, " ") || ""}</span>
          </div>
          <button
            onClick={toggleTheme}
            className="w-7 h-7 rounded-lg bg-white/[0.03] border border-white/[0.06] flex items-center justify-center hover:bg-blue-500/10 hover:border-blue-500/20 transition-all cursor-pointer"
            data-testid="button-toggle-theme"
            title={themeResolved === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label="Toggle theme"
          >
            {themeResolved === "dark" ? (
              <Sun className="w-3.5 h-3.5 text-amber-300" />
            ) : (
              <Moon className="w-3.5 h-3.5 text-blue-600" />
            )}
          </button>
          <button
            onClick={() => logoutMutation.mutate()}
            className="w-7 h-7 rounded-lg bg-white/[0.03] border border-white/[0.06] flex items-center justify-center hover:bg-red-500/10 hover:border-red-500/20 transition-all cursor-pointer"
            data-testid="button-logout"
            title="Logout"
          >
            <LogOut className="w-3.5 h-3.5 text-white/30" />
          </button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
