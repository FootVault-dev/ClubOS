import { Switch, Route, useRoute, useLocation, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
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
import AdminContactDetail from "@/pages/admin-contact-detail";
import AdminMailer from "@/pages/admin-mailer";
import FootballInstitute from "@/pages/football-institute";
import AdminSettings from "@/pages/admin-settings";
import AdminEditPage from "@/pages/admin-edit-page";
import CampPage from "@/pages/camp-page";
import TermsPage from "@/pages/terms";
import PrivacyPage from "@/pages/privacy";
import BookingPage from "@/pages/booking-page";
import ClassBookingPage from "@/pages/class-booking-page";
import BookingSuccess from "@/pages/booking-success";
import AttributionSurvey from "@/pages/attribution-survey";
import BookingCancel from "@/pages/booking-cancel";
import CheckoutPage from "@/pages/checkout-page";
import MflLandingPage from "@/pages/mfl-landing-page";
import MflRegisterPage from "@/pages/mfl-register-page";
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
import GroupProjects from "@/pages/group-projects";
import GroupBudget from "@/pages/group-budget";
import GroupBudgetXero from "@/pages/group-budget-xero";
import GroupBudgetCostCentre from "@/pages/group-budget-cost-centre";
import AdminAcademy from "@/pages/admin-academy";
import VenueFacilities from "@/pages/venue-facilities";
import VenueAddons from "@/pages/venue-addons";
import VenuePeople from "@/pages/venue-people";
import VenuePayments from "@/pages/venue-payments";
import VenueSettings from "@/pages/venue-settings";
import VenueWebsite from "@/pages/venue-website";
import VenueBookPage from "@/pages/venue-book";
import VenueSplitPage from "@/pages/venue-split-page";
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
import LeagueAnalytics from "@/pages/league-analytics";
import LeagueInbox from "@/pages/league-inbox";
import CicInbox from "@/pages/cic-inbox";
import CicLogoConsents from "@/pages/cic-logo-consents";
import CicMailer from "@/pages/cic-mailer";
import CugcInbox from "@/pages/cugc-inbox";
import CugcRegistrations from "@/pages/cugc-registrations";
import CugcAnalytics from "@/pages/cugc-analytics";
import LeagueBuilderPage from "@/pages/league-builder-page";
import LeagueSettings from "@/pages/league-settings";
import GymnasticsDashboard from "@/pages/gymnastics-dashboard";
import GymnasticsPrograms from "@/pages/gymnastics-programs";
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
import ESign from "@/pages/esign";
import SignPage from "@/pages/sign";
import Cic7sRegistrations from "@/pages/cic7s-registrations";
import CicSkillsLandingPage from "@/pages/cic-skills-landing";
import PrintsDashboard from "@/pages/prints-dashboard";
import PrintsCRM from "@/pages/prints-crm";
import PrintsOrders from "@/pages/prints-orders";
import PrintsProjects from "@/pages/prints-projects";
import PrintsAnalytics from "@/pages/prints-analytics";
import PrintsLanding from "@/pages/prints-landing";
import PrintsEmail from "@/pages/prints-email";
import PrintsJobs from "@/pages/prints-jobs";
import PrintsOrderDetail from "@/pages/prints-order-detail";
import PrintsMaterials from "@/pages/prints-materials";
import PrintsIntegrations from "@/pages/prints-integrations";
import PrintHub from "@/pages/print-hub";
import PrintConfigure from "@/pages/print-configure";
import PrintCheckout from "@/pages/print-checkout";
import PrintOrderStatus from "@/pages/print-order-status";
import PrintUpload from "@/pages/print-upload";
import { Search, Bell } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkspaceProvider, useWorkspace } from "@/lib/workspace-context";

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
  const isVenue = currentOrg?.slug === "united-sports-centre";
  const isLeague = currentOrg?.slug === "mini-football-leagues";
  const isTournament = currentOrg?.slug === "christchurch-international-cup";
  const isGymnastics = currentOrg?.slug === "united-gymnastics";
  const isGroup = currentOrg?.slug === "united-sports-group";
  const isPrints = currentOrg?.slug === "united-prints";

  if (isPrints) {
    return (
      <Switch>
        <Route path="/admin" component={PrintsDashboard} />
        <Route path="/admin/print-jobs" component={PrintsJobs} />
        <Route path="/admin/print-orders/:id" component={PrintsOrderDetail} />
        <Route path="/admin/print-orders" component={PrintsOrders} />
        <Route path="/admin/print-materials" component={PrintsMaterials} />
        <Route path="/admin/print-crm" component={PrintsCRM} />
        <Route path="/admin/print-projects" component={PrintsProjects} />
        <Route path="/admin/print-analytics" component={PrintsAnalytics} />
        <Route path="/admin/print-landing" component={PrintsLanding} />
        <Route path="/admin/print-email" component={PrintsEmail} />
        <Route path="/admin/integrations" component={PrintsIntegrations} />
        <Route path="/admin/esign" component={ESign} />
        <Route path="/admin/domains" component={AdminDomainSettings} />
        <Route path="/admin/settings" component={AdminSettings} />
        <Route path="/admin/team" component={AdminTeam} />
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
        <Route path="/admin/sponsorship" component={GroupSponsorship} />
        <Route path="/admin/budget/cost-centres/:slug" component={GroupBudgetCostCentre} />
        <Route path="/admin/budget/xero" component={GroupBudgetXero} />
        <Route path="/admin/budget" component={GroupBudget} />
        <Route path="/admin/esign" component={ESign} />
        <Route path="/admin/domains" component={AdminDomainSettings} />
        <Route path="/admin/team" component={AdminTeam} />
        <Route component={NotFound} />
      </Switch>
    );
  }

  if (isGymnastics) {
    return (
      <Switch>
        <Route path="/admin" component={GymnasticsDashboard} />
        <Route path="/admin/programs" component={GymnasticsPrograms} />
        <Route path="/admin/cugc-registrations" component={CugcRegistrations} />
        <Route path="/admin/cugc-analytics" component={CugcAnalytics} />
        <Route path="/admin/cugc-inbox" component={CugcInbox} />
        <Route path="/admin/terms" component={GymnasticsTerms} />
        {/* Reuse the camps detail + landing-page editor — they take a
            program id and don't care what type the program is. */}
        <Route path="/admin/camps/:id/edit-page" component={AdminEditPage} />
        <Route path="/admin/camps/:id" component={AdminCampDetail} />
        <Route path="/admin/camps/:campId/session/:dateId/:sessionType" component={AdminSessionRoll} />
        <Route path="/admin/esign" component={ESign} />
        <Route path="/admin/domains" component={AdminDomainSettings} />
        <Route path="/admin/team" component={AdminTeam} />
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
        <Route path="/admin/cic7s-registrations" component={Cic7sRegistrations} />
        <Route path="/admin/cic-registrations" component={CicInbox} />
        <Route path="/admin/cic-mailer" component={CicMailer} />
        <Route path="/admin/cic-logo-consents" component={CicLogoConsents} />
        <Route path="/admin/esign" component={ESign} />
        <Route path="/admin/domains" component={AdminDomainSettings} />
        <Route path="/admin/team" component={AdminTeam} />
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
        <Route path="/admin/payments" component={LeaguePayments} />
        <Route path="/admin/mailer" component={LeagueMailer} />
        <Route path="/admin/rewards" component={LeagueRewards} />
        <Route path="/admin/analytics" component={LeagueAnalytics} />
        <Route path="/admin/inbox" component={LeagueInbox} />
        <Route path="/admin/discounts/new" component={AdminDiscountDetail} />
        <Route path="/admin/discounts/:id" component={AdminDiscountDetail} />
        <Route path="/admin/discounts" component={AdminDiscounts} />
        <Route path="/admin/league-settings" component={LeagueSettings} />
        <Route path="/admin/esign" component={ESign} />
        <Route path="/admin/domains" component={AdminDomainSettings} />
        <Route path="/admin/team" component={AdminTeam} />
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
        <Route path="/admin/people" component={VenuePeople} />
        <Route path="/admin/payments" component={VenuePayments} />
        <Route path="/admin/venue-settings" component={VenueSettings} />
        <Route path="/admin/website" component={VenueWebsite} />
        <Route path="/admin/esign" component={ESign} />
        <Route path="/admin/domains" component={AdminDomainSettings} />
        <Route path="/admin/team" component={AdminTeam} />
        <Route component={NotFound} />
      </Switch>
    );
  }

  return (
    <Switch>
      <Route path="/admin" component={AdminDashboard} />
      <Route path="/admin/camps" component={AdminCamps} />
      <Route path="/admin/camps/:id/edit-page" component={AdminEditPage} />
      <Route path="/admin/camps/:id" component={AdminCampDetail} />
      <Route path="/admin/camps/:campId/session/:dateId/:sessionType" component={AdminSessionRoll} />
      <Route path="/admin/academy" component={AdminAcademy} />
      <Route path="/admin/terms" component={GymnasticsTerms} />
      <Route path="/admin/registrations" component={AdminRegistrations} />
      <Route path="/admin/contacts" component={AdminContacts} />
      <Route path="/admin/contacts/parent/:id" component={AdminContactDetail} />
      <Route path="/admin/contacts/player/:id" component={AdminContactDetail} />
      <Route path="/admin/mailer" component={AdminMailer} />
      <Route path="/admin/football-institute" component={FootballInstitute} />
      <Route path="/admin/analytics" component={CampAnalytics} />
      <Route path="/admin/discounts/new" component={AdminDiscountDetail} />
      <Route path="/admin/discounts/:id" component={AdminDiscountDetail} />
      <Route path="/admin/discounts" component={AdminDiscounts} />
      <Route path="/admin/domains" component={AdminDomainSettings} />
      <Route path="/admin/settings" component={AdminSettings} />
      <Route path="/admin/team" component={AdminTeam} />
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
              <div className="relative max-w-md flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-blue-400/30" />
                <Input
                  placeholder="Search..."
                  className="pl-9 h-9 text-[13px] premium-input text-white/80 rounded-xl"
                  data-testid="input-global-search"
                />
              </div>
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
      </SidebarProvider>
    </AuthGuard>
  );
}

function App() {
  const [isAdminLogin] = useRoute("/admin/login");
  const [isAdminEditPage] = useRoute("/admin/camps/:id/edit-page");
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
                const isCicHost = host.includes("cicyouth");
                if (isVenueHost) return <VenueBookPage />;
                if (isPrintHost) return <PrintHub />;
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
            <Route path="/book" component={VenueBookPage} />
            <Route path="/book/success" component={VenueBookSuccess} />
            <Route path="/book/split/:code" component={VenueSplitPage} />
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
      </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
