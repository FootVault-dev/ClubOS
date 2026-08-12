import { Switch, Route, useRoute, useLocation, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { ConfirmHost } from "@/components/confirm-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme-provider";
import RsvpPage from "@/pages/rsvp";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import NotFound from "@/pages/not-found";
import AdminLogin from "@/pages/admin-login";
import ForgotPassword from "@/pages/forgot-password";
import ResetPassword from "@/pages/reset-password";
import AdminDashboard from "@/pages/admin-dashboard";
import AdminCamps from "@/pages/admin-camps";
import AdminCampDetail from "@/pages/admin-camp-detail";
import AdminSessionRoll from "@/pages/admin-session-roll";
import AdminRegistrations from "@/pages/admin-registrations";
import AdminContacts from "@/pages/admin-contacts";
import AdminPersonDetail from "@/pages/admin-person-detail";
import AdminMailer from "@/pages/admin-mailer";
import CufcMailer from "@/pages/cufc-mailer";
import Predictor from "@/pages/predictor";
import FootballInstitute from "@/pages/football-institute";
import AdminSettings from "@/pages/admin-settings";
import AdminEditPage from "@/pages/admin-edit-page";
import CampPage from "@/pages/camp-page";
import MembershipPage from "@/pages/membership-page";
import TermsPage from "@/pages/terms";
import PrivacyPage from "@/pages/privacy";
import BookingPage from "@/pages/booking-page";
import ClassBookingPage from "@/pages/class-booking-page";
import AcademyRegisterPage from "@/pages/academy-register-page";
import BookingSuccess from "@/pages/booking-success";
import AttributionSurvey from "@/pages/attribution-survey";
import BookingCancel from "@/pages/booking-cancel";
import CheckoutPage from "@/pages/checkout-page";
import MflLandingPage from "@/pages/mfl-landing-page";
import MflRegisterPage from "@/pages/mfl-register-page";
import MflWaitlistPage from "@/pages/mfl-waitlist-page";
import MflCheckoutPage from "@/pages/mfl-checkout-page";
import MflSuccessPage from "@/pages/mfl-success-page";
import MflSplitPage from "@/pages/mfl-split-page";
import MflLegalPage from "@/pages/mfl-legal-page";
import VenueDashboard from "@/pages/venue-dashboard";
import VenueCalendar from "@/pages/venue-calendar";
import VenueBookings from "@/pages/venue-bookings";
import VenueAnalytics from "@/pages/venue-analytics";
import CampAnalytics from "@/pages/camp-analytics";
import AdminDiscounts from "@/pages/admin-discounts";
import AdminDiscountDetail from "@/pages/admin-discount-detail";
import AdminDomainSettings from "@/pages/admin-domain-settings";
import AdminTeam from "@/pages/admin-team";
import GroupDashboard from "@/pages/group-dashboard";
import GroupCalendar from "@/pages/group-calendar";
import GroupSponsorship from "@/pages/group-sponsorship";
import GroupProposals from "@/pages/group-proposals";
import GroupGrants from "@/pages/group-grants";
import GroupInvoices from "@/pages/invoices";
import GroupPayouts from "@/pages/payouts";
import AdminLicensing from "@/pages/admin-licensing";
import AdminEvents from "@/pages/admin-events";
import AdminMembership from "@/pages/admin-membership";
import AdminDeclarations from "@/pages/admin-declarations";
import GroupProjects from "@/pages/group-projects";
import GroupContent from "@/pages/group-content";
import GroupHiring from "@/pages/group-hiring";
import GroupVehicles from "@/pages/group-vehicles";
import GroupSponsors from "@/pages/group-sponsors";
import GroupVideos from "@/pages/group-videos";
import GroupVideoRecord from "@/pages/group-video-record";
import GroupVideoDetail from "@/pages/group-video-detail";
import VideoShare from "@/pages/video-share";
import GroupBudget from "@/pages/group-budget";
import GroupBudgetXero from "@/pages/group-budget-xero";
import GroupBudgetCostCentre from "@/pages/group-budget-cost-centre";
import GroupCashflow from "@/pages/group-cashflow";
import AdminAcademy from "@/pages/admin-academy";
import AdminSquads from "@/pages/admin-squads";
import LinksPage from "@/pages/links";
import AttributionPage from "@/pages/attribution";
import BehaviorPage from "@/pages/behavior";
import VenueFacilities from "@/pages/venue-facilities";
import VenueAddons from "@/pages/venue-addons";
import VenueHousing from "@/pages/venue-housing";
import VenueMaintenance from "@/pages/venue-maintenance";
import VenuePeople from "@/pages/venue-people";
import VenuePayments from "@/pages/venue-payments";
import VenueSettings from "@/pages/venue-settings";
import VenueWebsite from "@/pages/venue-website";
import VenueBookPage from "@/pages/venue-book";
import VenueSplitPage from "@/pages/venue-split-page";
import VenuePaySharePage from "@/pages/venue-payshare-pay";
import VenueBookSuccess from "@/pages/venue-book-success";
import MemberBookingPage from "@/pages/member-booking";
import VenueBookingRequests from "@/pages/venue-booking-requests";
import LeagueDashboard from "@/pages/league-dashboard";
import LeagueCompetitions from "@/pages/league-competitions";
import LeagueCompetitionDetail, { LeagueDetail } from "@/pages/league-competition-detail";
import LeagueTeams from "@/pages/league-teams";
import LeaguePayments from "@/pages/league-payments";
import LeagueMailer from "@/pages/league-mailer";
import LeagueRewards from "@/pages/league-rewards";
import LeagueLoyalty from "@/pages/league-loyalty";
import FmHistory from "@/pages/fm-history";
import FmCompetitions from "@/pages/fm-competitions";
import CufcOpenTrainings from "@/pages/cufc-open-trainings";
import SportySync from "@/pages/sporty-sync";
import LeagueAnalytics from "@/pages/league-analytics";
import LeagueInbox from "@/pages/league-inbox";
import LeagueBusinessPlan from "@/pages/league-business-plan";
import LeagueStore from "@/pages/league-store";
import CicInbox from "@/pages/cic-inbox";
import CicLiveChat from "@/pages/cic-livechat";
import MflLiveChat from "@/pages/mfl-livechat";
import CugcLiveChat from "@/pages/cugc-livechat";
import PrintLiveChat from "@/pages/print-livechat";
import PrintsRequests from "@/pages/prints-requests";
import PrintsFaqs from "@/pages/prints-faqs";
import CicLogoConsents from "@/pages/cic-logo-consents";
import MediaLibrary from "@/pages/media-library";
import CicMailer from "@/pages/cic-mailer";
import CicPush from "@/pages/cic-push";
import CicWatch from "@/pages/cic-watch";
import ContentMarketplace from "@/pages/content-marketplace";
import CicReferees from "@/pages/cic-referees";
import CicScoreGame from "@/pages/cic-score-game";
import RefHome from "@/pages/ref/RefHome";
import RefSignup from "@/pages/ref/RefSignup";
import RefGameDetail from "@/pages/ref/RefGameDetail";
import MflReferees from "@/pages/mfl-referees";
import MflGameFeedPage from "@/pages/mfl-game-feed";
import MflScoreGame from "@/pages/mfl-score-game";
import MflMedia from "@/pages/mfl-media";
import MflRefHome from "@/pages/mfl-ref/MflRefHome";
import MflRefSignup from "@/pages/mfl-ref/MflRefSignup";
import MflRefGameDetail from "@/pages/mfl-ref/MflRefGameDetail";
import CugcInbox from "@/pages/cugc-inbox";
import CugcRegistrations from "@/pages/cugc-registrations";
import CugcFreeSessions from "@/pages/cugc-free-sessions";
import CugcAnalytics from "@/pages/cugc-analytics";
import CugcMailer from "@/pages/cugc-mailer";
import LeagueBuilderPage from "@/pages/league-builder-page";
import LeagueSettings from "@/pages/league-settings";
import GymnasticsDashboard from "@/pages/gymnastics-dashboard";
import CugcPrograms from "@/pages/cugc-programs";
import GymnasticsTerms from "@/pages/gymnastics-terms";
import TournamentDashboard from "@/pages/tournament-dashboard";
import TournamentList from "@/pages/tournament-list";
import ClubsList from "@/pages/clubs-list";
import ClubDetail from "@/pages/club-detail";
import TournamentDetail from "@/pages/tournament-detail";
import TournamentTeamDetail from "@/pages/tournament-team-detail";
import TournamentSkillsChallenge from "@/pages/tournament-skills-challenge";
import TournamentFoodTruck from "@/pages/tournament-food-truck";
import TournamentVendors from "@/pages/tournament-vendors";
import Volunteers from "@/pages/volunteers";
import ESign from "@/pages/esign";
import SignPage from "@/pages/sign";
import SignDeclaration from "@/pages/sign-declaration";
import StudioPublicPage from "@/pages/studio-public";
import StudioPreviewPage from "@/pages/studio-preview";
import StudioHome from "@/pages/studio/StudioHome";
import StudioNew from "@/pages/studio/StudioNew";
import StudioEditor from "@/pages/studio/StudioEditor";
import StudioAnalytics from "@/pages/studio/StudioAnalytics";
import Cic7sRegistrations from "@/pages/cic7s-registrations";
import CicSkillsLandingPage from "@/pages/cic-skills-landing";
import PrintsDashboard from "@/pages/prints-dashboard";
import PrintsCRM from "@/pages/prints-crm";
import PrintsSales from "@/pages/prints-sales";
import PrintsOrders from "@/pages/prints-orders";
import PrintsProjects from "@/pages/prints-projects";
import PrintsManagement from "@/pages/prints-management";
import PrintsAnalytics from "@/pages/prints-analytics";
import PrintsLanding from "@/pages/prints-landing";
import PrintsEmail from "@/pages/prints-email";
import PrintsJobs from "@/pages/prints-jobs";
import PrintsQuotes from "@/pages/prints-quotes";
import PrintsOrderDetail from "@/pages/prints-order-detail";
import PrintsMaterials from "@/pages/prints-materials";
import PrintsIntegrations from "@/pages/prints-integrations";
import WarehouseDashboard from "@/pages/warehouse-dashboard";
import WarehouseItems from "@/pages/warehouse-items";
import WarehouseLocations from "@/pages/warehouse-locations";
import WarehousePOs from "@/pages/warehouse-pos";
import WarehouseRequisitions from "@/pages/warehouse-requisitions";
import WarehouseLoans from "@/pages/warehouse-loans";
import WarehouseCounts from "@/pages/warehouse-counts";
import WarehouseSync from "@/pages/warehouse-sync";
import WarehouseLedger from "@/pages/warehouse-ledger";
import WarehouseScan from "@/pages/warehouse-scan";
import WarehouseLabels from "@/pages/warehouse-labels";
import WarehouseAssets from "@/pages/warehouse-assets";
import WarehouseFieldTemplates from "@/pages/warehouse-field-templates";
import WarehouseStockTake from "@/pages/warehouse-stock-take";
import PrintHub from "@/pages/print-hub";
import PrintConfigure from "@/pages/print-configure";
import PrintCheckout from "@/pages/print-checkout";
import PrintOrderStatus from "@/pages/print-order-status";
import PrintUpload from "@/pages/print-upload";
import ClubDossier from "@/pages/club-dossier";
import MarketResearch from "@/pages/market-research";
import Feedback from "@/pages/feedback";
import TaskTracker from "@/pages/task-tracker";
import StaffChat from "@/pages/staff-chat";
import NotificationSettings from "@/pages/notification-settings";
import MarketingHome from "@/pages/marketing/Home";
import MarketingCampaignWizard from "@/pages/marketing/CampaignWizard";
import MarketingCampaignDetail from "@/pages/marketing/CampaignDetail";
import MarketingFlowEditor from "@/pages/marketing/FlowEditor";
import { Search, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkspaceProvider, useWorkspace } from "@/lib/workspace-context";
import { CommandPalette } from "@/components/command-palette";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading, error } = useQuery({
    queryKey: ["/api/auth/me"],
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center" style={{ background: '#02060E' }}>
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shadow-lg shadow-blue-500/25 animate-pulse">
            <span className="text-white font-bold text-sm">CU</span>
          </div>
          <Skeleton className="h-4 w-24 bg-blue-500/10" />
        </div>
      </div>
    );
  }

  if (!user || error) {
    return <Redirect to="/admin/login" />;
  }

  return <>{children}</>;
}

function AdminRouter() {
  const { currentOrg } = useWorkspace();
  const [location] = useLocation();
  // Feedback (bug reports / feature requests) is a UNIVERSAL tab — any staff
  // member, in whatever workspace they have, can reach it. Handle it before the
  // per-workspace switches so it works everywhere from one place.
  if (location.startsWith("/admin/feedback")) return <Feedback />;
  // Staff Chat (the in-house Slack) is universal for the same reason — one
  // staff-wide chat, reachable from every workspace's System section.
  if (location.startsWith("/admin/chat")) return <StaffChat />;
  // Notification settings belong to the PERSON, not the workspace — same
  // universal pattern again, gated server-side by requireAuth only.
  if (location.startsWith("/admin/notification-settings")) return <NotificationSettings />;
  // Task Tracker — one organisation-wide project/task system, deliberately
  // not workspace-scoped, so it is reachable from every workspace too.
  if (location.startsWith("/admin/task-tracker")) return <TaskTracker />;
  const isVenue = currentOrg?.slug === "united-sports-centre";
  const isLeague = currentOrg?.slug === "mini-football-leagues";
  const isTournament = currentOrg?.slug === "christchurch-international-cup";
  const isGymnastics = currentOrg?.slug === "united-gymnastics";
  const isGroup = currentOrg?.slug === "united-sports-group";
  const isPrints = currentOrg?.slug === "united-prints";
  const isSandbox = currentOrg?.slug === "sandbox";

  if (isSandbox) {
    return (
      <Switch>
        <Route path="/admin"><Redirect to="/admin/club-dossier" /></Route>
        <Route path="/admin/club-dossier" component={ClubDossier} />
        <Route path="/admin/market-research" component={MarketResearch} />
        <Route path="/admin/team" component={AdminTeam} />
        <Route component={NotFound} />
      </Switch>
    );
  }

  if (isPrints) {
    return (
      <Switch>
        <Route path="/admin" component={PrintsDashboard} />
        <Route path="/admin/print-management" component={PrintsManagement} />
        <Route path="/admin/print-jobs" component={PrintsJobs} />
        {/* Internal print requests. In the isPrints Switch, deliberately — a
            tabs.ts entry alone 404s, which is exactly what Live Chat did. */}
        <Route path="/admin/print-requests" component={PrintsRequests} />
        <Route path="/admin/print-quotes" component={PrintsQuotes} />
        <Route path="/admin/print-faqs" component={PrintsFaqs} />
        <Route path="/admin/print-orders/:id" component={PrintsOrderDetail} />
        <Route path="/admin/print-orders" component={PrintsOrders} />
        <Route path="/admin/print-materials" component={PrintsMaterials} />
        {/* The visitor live-chat inbox for unitedprints.co.nz. 🔴 This route was
            only ever listed in the CIC tournament Switch below, so the Live Chat
            tab in THIS workspace fell through to NotFound and 404'd from the day
            it shipped. The United Prints workspace has its own Switch — a
            shared/tabs.ts entry alone is never enough. */}
        <Route path="/admin/print-livechat" component={PrintLiveChat} />
        <Route path="/admin/print-crm" component={PrintsCRM} />
        <Route path="/admin/print-sales" component={PrintsSales} />
        <Route path="/admin/print-projects" component={PrintsProjects} />
        <Route path="/admin/print-analytics" component={PrintsAnalytics} />
        <Route path="/admin/print-landing" component={PrintsLanding} />
        <Route path="/admin/print-email" component={PrintsEmail} />
        <Route path="/admin/integrations" component={PrintsIntegrations} />
        <Route path="/admin/warehouse" component={WarehouseDashboard} />
        <Route path="/admin/warehouse/items" component={WarehouseItems} />
        <Route path="/admin/warehouse/locations" component={WarehouseLocations} />
        <Route path="/admin/warehouse/assets" component={WarehouseAssets} />
        <Route path="/admin/warehouse/fields" component={WarehouseFieldTemplates} />
        <Route path="/admin/warehouse/stock-take" component={WarehouseStockTake} />
        <Route path="/admin/warehouse/pos" component={WarehousePOs} />
        <Route path="/admin/warehouse/requisitions" component={WarehouseRequisitions} />
        <Route path="/admin/warehouse/loans" component={WarehouseLoans} />
        <Route path="/admin/warehouse/counts" component={WarehouseCounts} />
        <Route path="/admin/warehouse/sync" component={WarehouseSync} />
        <Route path="/admin/warehouse/ledger" component={WarehouseLedger} />
        <Route path="/admin/warehouse/scan" component={WarehouseScan} />
        <Route path="/admin/warehouse/labels" component={WarehouseLabels} />
        <Route path="/admin/marketing/campaigns/new" component={MarketingCampaignWizard} />
        <Route path="/admin/marketing/campaigns/:id/edit" component={MarketingCampaignWizard} />
        <Route path="/admin/marketing/campaigns/:id" component={MarketingCampaignDetail} />
        <Route path="/admin/marketing/flows/:id" component={MarketingFlowEditor} />
        <Route path="/admin/marketing" component={MarketingHome} />
        <Route path="/admin/studio/new" component={StudioNew} />
        <Route path="/admin/studio/:id/signal" component={StudioAnalytics} />
        <Route path="/admin/studio/:id" component={StudioEditor} />
        <Route path="/admin/studio" component={StudioHome} />
        <Route path="/admin/esign" component={ESign} />
        <Route path="/admin/domains" component={AdminDomainSettings} />
        <Route path="/admin/settings" component={AdminSettings} />
        <Route path="/admin/team" component={AdminTeam} />
        <Route path="/admin/links" component={LinksPage} />
        <Route path="/admin/attribution" component={AttributionPage} />
        <Route path="/admin/behavior" component={BehaviorPage} />
        <Route component={NotFound} />
      </Switch>
    );
  }

  if (isGroup) {
    return (
      <Switch>
        <Route path="/admin" component={GroupDashboard} />
        <Route path="/admin/calendar" component={GroupCalendar} />
        <Route path="/admin/projects" component={GroupProjects} />
        <Route path="/admin/content" component={GroupContent} />
        <Route path="/admin/hiring" component={GroupHiring} />
        <Route path="/admin/sponsorship" component={GroupSponsorship} />
        <Route path="/admin/proposals" component={GroupProposals} />
        <Route path="/admin/grants" component={GroupGrants} />
        <Route path="/admin/invoices" component={GroupInvoices} />
        <Route path="/admin/payouts" component={GroupPayouts} />
        <Route path="/admin/budget/cost-centres/:slug" component={GroupBudgetCostCentre} />
        <Route path="/admin/budget/xero" component={GroupBudgetXero} />
        <Route path="/admin/budget" component={GroupBudget} />
        <Route path="/admin/cashflow" component={GroupCashflow} />
        <Route path="/admin/vehicles" component={GroupVehicles} />
        <Route path="/admin/sponsor-traffic" component={GroupSponsors} />
        <Route path="/admin/videos/record" component={GroupVideoRecord} />
        <Route path="/admin/videos/:id" component={GroupVideoDetail} />
        <Route path="/admin/videos" component={GroupVideos} />
        <Route path="/admin/marketing/campaigns/new" component={MarketingCampaignWizard} />
        <Route path="/admin/marketing/campaigns/:id/edit" component={MarketingCampaignWizard} />
        <Route path="/admin/marketing/campaigns/:id" component={MarketingCampaignDetail} />
        <Route path="/admin/marketing/flows/:id" component={MarketingFlowEditor} />
        <Route path="/admin/marketing" component={MarketingHome} />
        <Route path="/admin/studio/new" component={StudioNew} />
        <Route path="/admin/studio/:id/signal" component={StudioAnalytics} />
        <Route path="/admin/studio/:id" component={StudioEditor} />
        <Route path="/admin/studio" component={StudioHome} />
        <Route path="/admin/esign" component={ESign} />
        <Route path="/admin/domains" component={AdminDomainSettings} />
        <Route path="/admin/team" component={AdminTeam} />
        <Route path="/admin/links" component={LinksPage} />
        <Route path="/admin/attribution" component={AttributionPage} />
        <Route path="/admin/behavior" component={BehaviorPage} />
        <Route component={NotFound} />
      </Switch>
    );
  }

  if (isGymnastics) {
    return (
      <Switch>
        <Route path="/admin" component={GymnasticsDashboard} />
        {/* The gymnastics Programs tab shows the live cugc.co.nz lineup (not the
            generic camp-style pipeline) — website enrolments land in Registrations. */}
        <Route path="/admin/programs" component={CugcPrograms} />
        <Route path="/admin/cugc-registrations" component={CugcRegistrations} />
        <Route path="/admin/cugc-free-sessions" component={CugcFreeSessions} />
        <Route path="/admin/cugc-analytics" component={CugcAnalytics} />
        <Route path="/admin/cugc-inbox" component={CugcInbox} />
        <Route path="/admin/cugc-mailer" component={CugcMailer} />
        <Route path="/admin/terms" component={GymnasticsTerms} />
        {/* Reuse the camps detail + landing-page editor — they take a
            program id and don't care what type the program is. Gymnastics
            programmes live under /admin/programs so the sidebar highlights
            Programs, not Camps; the /admin/camps aliases stay for old links. */}
        <Route path="/admin/programs/:id/edit-page" component={AdminEditPage} />
        <Route path="/admin/programs/:id/session/:dateId/:sessionType" component={AdminSessionRoll} />
        <Route path="/admin/programs/:id" component={AdminCampDetail} />
        <Route path="/admin/camps/:id/edit-page" component={AdminEditPage} />
        <Route path="/admin/camps/:id/session/:dateId/:sessionType" component={AdminSessionRoll} />
        <Route path="/admin/camps/:id" component={AdminCampDetail} />
        <Route path="/admin/camps/:campId/session/:dateId/:sessionType" component={AdminSessionRoll} />
        <Route path="/admin/marketing/campaigns/new" component={MarketingCampaignWizard} />
        <Route path="/admin/marketing/campaigns/:id/edit" component={MarketingCampaignWizard} />
        <Route path="/admin/marketing/campaigns/:id" component={MarketingCampaignDetail} />
        <Route path="/admin/marketing/flows/:id" component={MarketingFlowEditor} />
        <Route path="/admin/marketing" component={MarketingHome} />
        <Route path="/admin/studio/new" component={StudioNew} />
        <Route path="/admin/studio/:id/signal" component={StudioAnalytics} />
        <Route path="/admin/studio/:id" component={StudioEditor} />
        <Route path="/admin/studio" component={StudioHome} />
        <Route path="/admin/esign" component={ESign} />
        <Route path="/admin/domains" component={AdminDomainSettings} />
        <Route path="/admin/team" component={AdminTeam} />
        <Route path="/admin/links" component={LinksPage} />
        <Route path="/admin/attribution" component={AttributionPage} />
        <Route path="/admin/behavior" component={BehaviorPage} />
        <Route component={NotFound} />
      </Switch>
    );
  }

  if (isTournament) {
    return (
      <Switch>
        <Route path="/admin" component={TournamentDashboard} />
        <Route path="/admin/tournaments/:tournamentId/teams/:teamId" component={TournamentTeamDetail} />
        <Route path="/admin/tournaments/:id" component={TournamentDetail} />
        <Route path="/admin/tournaments" component={TournamentList} />
        <Route path="/admin/clubs/:id" component={ClubDetail} />
        <Route path="/admin/clubs" component={ClubsList} />
        <Route path="/admin/skills-challenge" component={TournamentSkillsChallenge} />
        <Route path="/admin/food-truck" component={TournamentFoodTruck} />
        <Route path="/admin/vendors" component={TournamentVendors} />
        <Route path="/admin/volunteers" component={Volunteers} />
        <Route path="/admin/cic7s-registrations" component={Cic7sRegistrations} />
        <Route path="/admin/cic-registrations" component={CicInbox} />
        <Route path="/admin/cic-livechat" component={CicLiveChat} />
        <Route path="/admin/mfl-livechat" component={MflLiveChat} />
        <Route path="/admin/cugc-livechat" component={CugcLiveChat} />
        <Route path="/admin/print-livechat" component={PrintLiveChat} />
        <Route path="/admin/cic-mailer" component={CicMailer} />
        <Route path="/admin/cic-push" component={CicPush} />
        <Route path="/admin/cic-logo-consents" component={CicLogoConsents} />
        <Route path="/admin/cic-watch" component={CicWatch} />
        <Route path="/admin/media" component={MediaLibrary} />
        <Route path="/admin/cic-content-marketplace" component={ContentMarketplace} />
        <Route path="/admin/cic-referees" component={CicReferees} />
        <Route path="/admin/cic-score/:id" component={CicScoreGame} />
        <Route path="/admin/marketing/campaigns/new" component={MarketingCampaignWizard} />
        <Route path="/admin/marketing/campaigns/:id/edit" component={MarketingCampaignWizard} />
        <Route path="/admin/marketing/campaigns/:id" component={MarketingCampaignDetail} />
        <Route path="/admin/marketing/flows/:id" component={MarketingFlowEditor} />
        <Route path="/admin/marketing" component={MarketingHome} />
        <Route path="/admin/studio/new" component={StudioNew} />
        <Route path="/admin/studio/:id/signal" component={StudioAnalytics} />
        <Route path="/admin/studio/:id" component={StudioEditor} />
        <Route path="/admin/studio" component={StudioHome} />
        <Route path="/admin/esign" component={ESign} />
        <Route path="/admin/domains" component={AdminDomainSettings} />
        <Route path="/admin/team" component={AdminTeam} />
        <Route path="/admin/links" component={LinksPage} />
        <Route path="/admin/attribution" component={AttributionPage} />
        <Route path="/admin/behavior" component={BehaviorPage} />
        <Route component={NotFound} />
      </Switch>
    );
  }

  if (isLeague) {
    return (
      <Switch>
        <Route path="/admin" component={LeagueDashboard} />
        <Route path="/admin/competitions/:id/divisions/:divisionId" component={LeagueDetail} />
        <Route path="/admin/competitions/:id" component={LeagueCompetitionDetail} />
        <Route path="/admin/competitions" component={LeagueCompetitions} />
        <Route path="/admin/teams" component={LeagueTeams} />
        {/* Individual-signup youth leagues (Ballers, Term 4 2026). These run on
            the academy engine — one child, one term, one price — not on the
            league engine, whose unit of sale is a captain buying a team. The
            MFL workspace has its own Switch, so these routes have to be listed
            here as well as in the general block or the tabs 404. */}
        <Route path="/admin/academy" component={AdminAcademy} />
        <Route path="/admin/academy/:id/edit-page" component={AdminEditPage} />
        <Route path="/admin/academy/:id/session/:dateId/:sessionType" component={AdminSessionRoll} />
        <Route path="/admin/academy/:id" component={AdminCampDetail} />
        <Route path="/admin/registrations" component={AdminRegistrations} />
        <Route path="/admin/mfl-referees" component={MflReferees} />
        <Route path="/admin/mfl-game-feed" component={MflGameFeedPage} />
        <Route path="/admin/mfl-score/:id" component={MflScoreGame} />
        <Route path="/admin/mfl-media" component={MflMedia} />
        <Route path="/admin/payments" component={LeaguePayments} />
        <Route path="/admin/mailer" component={LeagueMailer} />
        <Route path="/admin/rewards" component={LeagueRewards} />
        <Route path="/admin/loyalty" component={LeagueLoyalty} />
        <Route path="/admin/analytics" component={LeagueAnalytics} />
        <Route path="/admin/business-plan" component={LeagueBusinessPlan} />
        <Route path="/admin/store" component={LeagueStore} />
        <Route path="/admin/inbox" component={LeagueInbox} />
        <Route path="/admin/discounts/new" component={AdminDiscountDetail} />
        <Route path="/admin/discounts/:id" component={AdminDiscountDetail} />
        <Route path="/admin/discounts" component={AdminDiscounts} />
        <Route path="/admin/league-settings" component={LeagueSettings} />
        <Route path="/admin/marketing/campaigns/new" component={MarketingCampaignWizard} />
        <Route path="/admin/marketing/campaigns/:id/edit" component={MarketingCampaignWizard} />
        <Route path="/admin/marketing/campaigns/:id" component={MarketingCampaignDetail} />
        <Route path="/admin/marketing/flows/:id" component={MarketingFlowEditor} />
        <Route path="/admin/marketing" component={MarketingHome} />
        <Route path="/admin/studio/new" component={StudioNew} />
        <Route path="/admin/studio/:id/signal" component={StudioAnalytics} />
        <Route path="/admin/studio/:id" component={StudioEditor} />
        <Route path="/admin/studio" component={StudioHome} />
        <Route path="/admin/esign" component={ESign} />
        <Route path="/admin/domains" component={AdminDomainSettings} />
        <Route path="/admin/team" component={AdminTeam} />
        <Route path="/admin/links" component={LinksPage} />
        <Route path="/admin/attribution" component={AttributionPage} />
        <Route path="/admin/behavior" component={BehaviorPage} />
        <Route component={NotFound} />
      </Switch>
    );
  }

  if (isVenue) {
    return (
      <Switch>
        <Route path="/admin" component={VenueDashboard} />
        <Route path="/admin/calendar" component={VenueCalendar} />
        <Route path="/admin/bookings" component={VenueBookings} />
        <Route path="/admin/booking-requests" component={VenueBookingRequests} />
        <Route path="/admin/analytics" component={VenueAnalytics} />
        <Route path="/admin/facilities" component={VenueFacilities} />
        <Route path="/admin/addons" component={VenueAddons} />
        <Route path="/admin/housing" component={VenueHousing} />
        <Route path="/admin/maintenance" component={VenueMaintenance} />
        <Route path="/admin/people" component={VenuePeople} />
        <Route path="/admin/payments" component={VenuePayments} />
        <Route path="/admin/venue-settings" component={VenueSettings} />
        <Route path="/admin/website" component={VenueWebsite} />
        <Route path="/admin/marketing/campaigns/new" component={MarketingCampaignWizard} />
        <Route path="/admin/marketing/campaigns/:id/edit" component={MarketingCampaignWizard} />
        <Route path="/admin/marketing/campaigns/:id" component={MarketingCampaignDetail} />
        <Route path="/admin/marketing/flows/:id" component={MarketingFlowEditor} />
        <Route path="/admin/marketing" component={MarketingHome} />
        <Route path="/admin/studio/new" component={StudioNew} />
        <Route path="/admin/studio/:id/signal" component={StudioAnalytics} />
        <Route path="/admin/studio/:id" component={StudioEditor} />
        <Route path="/admin/studio" component={StudioHome} />
        <Route path="/admin/esign" component={ESign} />
        <Route path="/admin/domains" component={AdminDomainSettings} />
        <Route path="/admin/team" component={AdminTeam} />
        <Route path="/admin/links" component={LinksPage} />
        <Route path="/admin/attribution" component={AttributionPage} />
        <Route path="/admin/behavior" component={BehaviorPage} />
        <Route component={NotFound} />
      </Switch>
    );
  }

  return (
    <Switch>
      <Route path="/admin" component={AdminDashboard} />
      <Route path="/admin/camps" component={AdminCamps} />
      <Route path="/admin/camps/:id/edit-page" component={AdminEditPage} />
      <Route path="/admin/camps/:id/session/:dateId/:sessionType" component={AdminSessionRoll} />
      <Route path="/admin/camps/:id" component={AdminCampDetail} />
      <Route path="/admin/academy" component={AdminAcademy} />
      {/* Academy programmes get their own detail URL so the sidebar keeps
          Academy highlighted — same components as camps, different section.
          The /admin/camps/:id aliases above still resolve for old links. */}
      <Route path="/admin/academy/:id/edit-page" component={AdminEditPage} />
      <Route path="/admin/academy/:id/session/:dateId/:sessionType" component={AdminSessionRoll} />
      <Route path="/admin/academy/:id" component={AdminCampDetail} />
      <Route path="/admin/squads" component={AdminSquads} />
      <Route path="/admin/terms" component={GymnasticsTerms} />
      <Route path="/admin/registrations" component={AdminRegistrations} />
      <Route path="/admin/contacts" component={AdminContacts} />
      {/* One person page for both people tables, keyed `contact-{id}` /
          `child-{id}`. The two legacy URLs below redirect into it so existing
          bookmarks and links in old emails keep working. `parent/:id` always
          meant a `contacts` row (it served children too); `player/:id` only
          ever resolved a `children` row — it 404'd on every academy child,
          which is the bug this replaces. */}
      <Route path="/admin/people/:key" component={AdminPersonDetail} />
      <Route path="/admin/contacts/parent/:id">
        {(params: any) => <Redirect to={`/admin/people/contact-${params.id}`} />}
      </Route>
      <Route path="/admin/contacts/player/:id">
        {(params: any) => <Redirect to={`/admin/people/child-${params.id}`} />}
      </Route>
      <Route path="/admin/mailer" component={AdminMailer} />
      <Route path="/admin/cufc-mailer" component={CufcMailer} />
      <Route path="/admin/predictor" component={Predictor} />
      {/* Friendly Manager History — CUFC's 10-year archive (default/camps
          workspace Switch: CUFC has no is* flag, it lands here). */}
      <Route path="/admin/fm-history" component={FmHistory} />
      <Route path="/admin/fm-competitions" component={FmCompetitions} />
      <Route path="/admin/open-trainings" component={CufcOpenTrainings} />
      {/* Sporty / NZ Football NRS push — same default Switch as fm-history
          (CUFC has no is* flag, so it lands here; SIU shares this Switch too
          since it has no dedicated branch above). */}
      <Route path="/admin/sporty" component={SportySync} />
      <Route path="/admin/football-institute" component={FootballInstitute} />
      <Route path="/admin/analytics" component={CampAnalytics} />
      <Route path="/admin/discounts/new" component={AdminDiscountDetail} />
      <Route path="/admin/discounts/:id" component={AdminDiscountDetail} />
      <Route path="/admin/discounts" component={AdminDiscounts} />
      <Route path="/admin/domains" component={AdminDomainSettings} />
      <Route path="/admin/settings" component={AdminSettings} />
      <Route path="/admin/team" component={AdminTeam} />
      <Route path="/admin/links" component={LinksPage} />
      <Route path="/admin/attribution" component={AttributionPage} />
      <Route path="/admin/behavior" component={BehaviorPage} />
      <Route path="/admin/licensing" component={AdminLicensing} />
      <Route path="/admin/declarations" component={AdminDeclarations} />
      <Route path="/admin/events" component={AdminEvents} />
      <Route path="/admin/membership" component={AdminMembership} />
      <Route path="/admin/marketing/campaigns/new" component={MarketingCampaignWizard} />
      <Route path="/admin/marketing/campaigns/:id/edit" component={MarketingCampaignWizard} />
      <Route path="/admin/marketing/campaigns/:id" component={MarketingCampaignDetail} />
      <Route path="/admin/marketing/flows/:id" component={MarketingFlowEditor} />
      <Route path="/admin/marketing" component={MarketingHome} />
      <Route path="/admin/studio/new" component={StudioNew} />
      <Route path="/admin/studio/:id/signal" component={StudioAnalytics} />
      <Route path="/admin/studio/:id" component={StudioEditor} />
      <Route path="/admin/studio" component={StudioHome} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AdminLayout() {
  const style = {
    "--sidebar-width": "15rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <AuthGuard>
      <SidebarProvider style={style as React.CSSProperties}>
        <div className="flex h-screen w-full overflow-hidden bg-background">
          <AppSidebar />
          <div className="flex flex-col flex-1 min-w-0">
            <header className="flex items-center justify-between gap-3 sm:gap-4 px-3 sm:px-6 h-14 border-b border-blue-500/[0.06] flex-shrink-0 backdrop-blur-2xl admin-header">
              <div className="flex items-center gap-3">
                <SidebarTrigger data-testid="button-sidebar-toggle" className="text-white/30 hover:text-white/50 transition-colors duration-300" />
              </div>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new Event("clubos:open-search"))}
                data-testid="input-global-search"
                className="relative max-w-md flex-1 flex items-center h-9 pl-9 pr-2 text-[13px] premium-input text-white/40 rounded-xl text-left hover:text-white/60 transition-colors"
              >
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-blue-400/30" />
                <span className="flex-1 truncate">Search everything…</span>
                <kbd className="hidden sm:inline-flex items-center text-[10px] text-white/30 border border-white/10 rounded px-1.5 py-0.5">⌘K</kbd>
              </button>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" className="text-white/30 hover:text-white/50 relative transition-colors duration-300 rounded-xl">
                  <Bell className="w-4 h-4" />
                </Button>
              </div>
            </header>
            <main className="flex-1 overflow-x-hidden overflow-y-auto gradient-mesh">
              <AdminRouter />
            </main>
          </div>
        </div>
        <CommandPalette />
      </SidebarProvider>
    </AuthGuard>
  );
}

function App() {
  const [isAdminLogin] = useRoute("/admin/login");
  // The landing-page editor renders full-screen, outside the sidebar layout —
  // match it under every programme prefix, not just camps.
  const [isCampsEditPage] = useRoute("/admin/camps/:id/edit-page");
  const [isAcademyEditPage] = useRoute("/admin/academy/:id/edit-page");
  const [isProgramsEditPage] = useRoute("/admin/programs/:id/edit-page");
  const isAdminEditPage = isCampsEditPage || isAcademyEditPage || isProgramsEditPage;
  const [isAdminDeep] = useRoute("/admin/**");
  const [isAdminRoot] = useRoute("/admin");

  const isAdminRoute = isAdminDeep || isAdminRoot;

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
        {isAdminLogin ? (
          <AdminLogin />
        ) : isAdminEditPage ? (
          <WorkspaceProvider><AuthGuard><AdminEditPage /></AuthGuard></WorkspaceProvider>
        ) : isAdminRoute ? (
          <WorkspaceProvider><AdminLayout /></WorkspaceProvider>
        ) : (
          <Switch>
            <Route path="/">
              {(() => {
                // Hostname-based routing for the public root:
                //  - app.* / clubos.fly.dev / localhost → admin login
                //  - book.* (e.g. book.unitedsportscentre.com) → render the
                //    venue booking flow directly (no /book suffix in the URL).
                //  - everything else (parent-facing hosts like join.cufc.co.nz) →
                //    the legacy holiday-camp booking page they used to live at.
                const host = typeof window !== "undefined" ? window.location.hostname : "";
                const isAdminHost =
                  host.startsWith("app.") || host === "clubos.fly.dev" || host === "localhost";
                const isVenueHost = host.startsWith("book.");
                const isPrintHost = host.startsWith("order.") || host.includes("unitedprints.co.nz");
                const isMflHost = host.includes("minifootball");
                // ref.cicyouth.com / ref.minifootball.co.nz = the referee
                // platforms (login/signup/dashboard). MUST come before BOTH
                // the minifootball check and the cicyouth check below —
                // otherwise the "minifootball"/"cicyouth" substring sends a
                // ref.* host to the league landing page / Skills Challenge
                // page instead. join.cicyouth.com stays Skills Challenge;
                // minifootball.co.nz (no "ref." prefix) stays the league page.
                const isRefHost = host.startsWith("ref.");
                const isMflRefHost = isRefHost && isMflHost;
                const isCicHost = host.includes("cicyouth");
                if (isVenueHost) return <VenueBookPage />;
                if (isPrintHost) return <PrintHub />;
                if (isRefHost) return <Redirect to={isMflRefHost ? "/mfl-ref" : "/login"} />;
                if (isMflHost) return <Redirect to="/league" />;
                if (isCicHost) return <Redirect to="/skills" />;
                return <Redirect to={isAdminHost ? "/admin/login" : "/fundamentals-camp"} />;
              })()}
            </Route>
            <Route path="/terms" component={TermsPage} />
            <Route path="/privacy" component={PrivacyPage} />
            {/* Self-service password reset (public, must precede /:slug) */}
            <Route path="/forgot-password" component={ForgotPassword} />
            <Route path="/reset-password" component={ResetPassword} />
            <Route path="/calendar/rsvp/:token" component={RsvpPage} />
            <Route path="/sign/:token" component={SignPage} />
            <Route path="/declaration/:token" component={SignDeclaration} />
            {/* USG Studio — public proposal pages (unlisted, no auth). Must
                precede the 2-segment /:slug/* and 1-segment /:slug routes. */}
            <Route path="/p/:token" component={StudioPublicPage} />
            {/* Staff Videos — the in-house Loom's public share pages. Random
                non-enumerable tokens; visibility enforced by the public API. */}
            <Route path="/v/:token" component={VideoShare} />
            <Route path="/studio-preview" component={StudioPreviewPage} />
            {/* CIC referee scoring — the mobile app referees use to score their
                games. Referee token-auth (never a staff session); same-origin.
                Clean URLs on ref.cicyouth.com (/login, /signup, /game/:id) —
                old /ref* paths kept as redirects since links were already shared.
                ref.minifootball.co.nz shares these SAME clean paths but redirects
                into the /mfl-ref/* namespace below — one URL shape, two brands,
                picked by hostname (cicyouth.com behaviour is untouched). */}
            <Route path="/login">
              {() => {
                const host = typeof window !== "undefined" ? window.location.hostname : "";
                if (host.startsWith("ref.") && host.includes("minifootball")) return <Redirect to="/mfl-ref" />;
                return <RefHome />;
              }}
            </Route>
            <Route path="/signup">
              {() => {
                const host = typeof window !== "undefined" ? window.location.hostname : "";
                if (host.startsWith("ref.") && host.includes("minifootball")) return <Redirect to="/mfl-ref/signup" />;
                return <RefSignup />;
              }}
            </Route>
            <Route path="/game/:id">
              {(params) => {
                const host = typeof window !== "undefined" ? window.location.hostname : "";
                if (host.startsWith("ref.") && host.includes("minifootball")) return <Redirect to={`/mfl-ref/game/${params.id}`} />;
                return <RefGameDetail />;
              }}
            </Route>
            <Route path="/ref/signup"><Redirect to="/signup" /></Route>
            <Route path="/ref/game/:id">{(params) => <Redirect to={`/game/${params.id}`} />}</Route>
            <Route path="/ref"><Redirect to="/login" /></Route>
            {/* MFL referee scoring — separate namespace, own gold-on-black
                brand (client/src/pages/mfl-ref/*). Reached directly at
                /mfl-ref/* on app.usg.co.nz, or via the clean-URL redirect
                above on ref.minifootball.co.nz. */}
            <Route path="/mfl-ref" component={MflRefHome} />
            <Route path="/mfl-ref/signup" component={MflRefSignup} />
            <Route path="/mfl-ref/game/:id" component={MflRefGameDetail} />
            <Route path="/book" component={VenueBookPage} />
            <Route path="/book/success" component={VenueBookSuccess} />
            <Route path="/book/split/:code" component={VenueSplitPage} />
            {/* One participant's share of a PayShare group. The URL PayShare
                sends people to, returned from our create-payment hook. */}
            <Route path="/book/payshare/pay/:token" component={VenuePaySharePage} />
            {/* Member booking requests (book.unitedsportscentre.com/members) */}
            <Route path="/members" component={MemberBookingPage} />
            <Route path="/print" component={PrintHub} />
            <Route path="/print/configure/:slug" component={PrintConfigure} />
            <Route path="/print/checkout" component={PrintCheckout} />
            <Route path="/print/order/:token/upload" component={PrintUpload} />
            <Route path="/print/order/:token" component={PrintOrderStatus} />
            {/* CIC Skills Challenge registration (join.cicyouth.com) */}
            <Route path="/skills" component={CicSkillsLandingPage} />
            {/* MFL team registration funnel (join.minifootball.co.nz) */}
            <Route path="/league/balance/:registrationId">{() => <MflCheckoutPage mode="balance" />}</Route>
            <Route path="/league/:slug/register" component={MflRegisterPage} />
            <Route path="/league/:slug/waitlist" component={MflWaitlistPage} />
            <Route path="/league/:slug/checkout">{() => <MflCheckoutPage mode="deposit" />}</Route>
            <Route path="/league/:slug/success" component={MflSuccessPage} />
            {/* Split Pay hub — captain splits a fixed team fee across the squad.
                3-segment route; must precede the 2-segment /league/:slug. */}
            <Route path="/league/split/:code" component={MflSplitPage} />
            {/* League Builders (referral hub) — must precede /league/:slug. */}
            <Route path="/league/builders/:token" component={LeagueBuilderPage} />
            <Route path="/league/builders" component={LeagueBuilderPage} />
            {/* Literal legal routes must precede /league/:slug (else slug='privacy') */}
            <Route path="/league/privacy">{() => <MflLegalPage kind="privacy" />}</Route>
            <Route path="/league/delete-account">{() => <MflLegalPage kind="delete" />}</Route>
            <Route path="/league/:slug" component={MflLandingPage} />
            <Route path="/league" component={MflLandingPage} />
            <Route path="/membership" component={MembershipPage} />
            {/* CUFC Academy registration (join.cufc.co.nz/academy/:slug) — must
                precede /:slug/book so "academy" isn't swallowed as a venue slug. */}
            <Route path="/academy/:slug" component={AcademyRegisterPage} />
            <Route path="/:slug/book" component={BookingPage} />
            <Route path="/:slug/class-book" component={ClassBookingPage} />
            <Route path="/:slug/checkout" component={CheckoutPage} />
            <Route path="/:slug/feedback" component={AttributionSurvey} />
            <Route path="/:slug/success" component={BookingSuccess} />
            <Route path="/:slug/cancel" component={BookingCancel} />
            <Route path="/:slug" component={CampPage} />
            <Route component={NotFound} />
          </Switch>
        )}
        <Toaster />
        {/* Spec §7 — askConfirm()'s host. Mounted once, next to the toaster,
            for the same reason: both are called imperatively from anywhere. */}
        <ConfirmHost />
      </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
