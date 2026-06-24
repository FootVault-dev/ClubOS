import { db } from "./db";
import { eq, desc, sql, and, ilike, or, inArray, asc, isNull, ne } from "drizzle-orm";
import {
  users, contacts, contactRelationships, programs,
  programSessions, registrations, auditLogs, settings,
  sessionBookings, programDiscounts,
  campPricing, campDates, campSettings,
  children, childMedical, registrationItems,
  attendance, emailLogs, metaEventLogs, emailCampaigns,
  organizations, userOrganizations,
  facilities, facilityPricingRules, facilityBookings, facilityAddons, venueSettings,
  leagueCompetitions, leagueDivisions, leagueTeams, leagueGames, leagueCoupons,
  type InsertUser, type User,
  type UserOrganization,
  type InsertContact, type Contact,
  type InsertRelationship, type ContactRelationship,
  type InsertProgram, type Program,
  programOptions, type InsertProgramOption, type ProgramOption,
  type InsertSession, type ProgramSession,
  type InsertSessionBooking, type SessionBooking,
  type InsertDiscount, type ProgramDiscount,
  type InsertRegistration, type Registration,
  type InsertCampPricing, type CampPricing,
  type InsertCampDate, type CampDate,
  type InsertCampSettings, type CampSettings,
  type InsertChild, type Child,
  type InsertChildMedical, type ChildMedical,
  type InsertRegistrationItem, type RegistrationItem,
  type InsertAttendance, type Attendance,
  type InsertEmailLog, type EmailLog,
  type InsertMetaEventLog, type MetaEventLog,
  type InsertEmailCampaign, type EmailCampaign,
  type InsertAuditLog, type AuditLog,
  type Setting,
  type Organization,
  type InsertFacility, type Facility,
  type InsertFacilityPricingRule, type FacilityPricingRule,
  type InsertFacilityBooking, type FacilityBooking,
  type InsertFacilityAddon, type FacilityAddon,
  type InsertVenueSettings, type VenueSettings,
  type InsertLeagueCompetition, type LeagueCompetition,
  type InsertLeagueDivision, type LeagueDivision,
  type InsertLeagueTeam, type LeagueTeam,
  type InsertLeagueGame, type LeagueGame,
  type InsertLeagueCoupon, type LeagueCoupon,
  discounts, discountUsages,
  type InsertDiscount2, type Discount,
  type InsertDiscountUsage, type DiscountUsage,
  customDomains, type InsertCustomDomain, type CustomDomain,
  calendarEvents, type InsertCalendarEvent, type CalendarEvent,
  calendarCategories, type InsertCalendarCategory, type CalendarCategory,
  printOrders, type InsertPrintOrder, type PrintOrder,
  printProjects, type InsertPrintProject, type PrintProject,
  printContacts, type InsertPrintContact, type PrintContact,
  printLandingPages, type InsertPrintLandingPage, type PrintLandingPage,
  printEmails, type InsertPrintEmail, type PrintEmail,
  printMaterials, type InsertPrintMaterial, type PrintMaterial,
  printOrderItems, type InsertPrintOrderItem, type PrintOrderItem,
  printOrderFiles, type InsertPrintOrderFile, type PrintOrderFile,
  printOrderEvents, type InsertPrintOrderEvent, type PrintOrderEvent,
  tournaments, tournamentGroups, tournamentTeams, tournamentPlayers, tournamentStaff, tournamentGames, tournamentGoals,
  clubs,
  type InsertTournament, type Tournament,
  type InsertTournamentGroup, type TournamentGroup,
  type InsertTournamentTeam, type TournamentTeam,
  type InsertTournamentPlayer, type TournamentPlayer,
  type InsertTournamentStaff, type TournamentStaff,
  type InsertTournamentGame, type TournamentGame,
  type InsertTournamentGoal, type TournamentGoal,
  type InsertClub, type Club,
  terms,
  type InsertTerm, type Term,
} from "@shared/schema";

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getAllUsers(): Promise<User[]>;
  getAllUsersWithMemberships(): Promise<Array<User & { memberships: Array<{ orgId: number; orgName: string; orgSlug: string; role: string; tabs: string[] | null }> }>>;
  addUserToOrganization(userId: number, organizationId: number, role?: string, tabs?: string[] | null): Promise<UserOrganization>;
  updateUserOrgRole(userId: number, organizationId: number, role: string): Promise<UserOrganization | undefined>;
  updateUserOrgTabs(userId: number, organizationId: number, tabs: string[] | null): Promise<UserOrganization | undefined>;
  updateUserOrgMembership(userId: number, organizationId: number, updates: { role?: string; tabs?: string[] | null }): Promise<UserOrganization | undefined>;
  removeUserFromOrganization(userId: number, organizationId: number): Promise<void>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: number, data: Partial<InsertUser>): Promise<User | undefined>;
  deleteUser(id: number): Promise<void>;

  getContacts(): Promise<Contact[]>;
  getContact(id: number): Promise<Contact | undefined>;
  findContactByEmail(email: string): Promise<Contact | undefined>;
  createContact(contact: InsertContact): Promise<Contact>;
  updateContact(id: number, contact: Partial<InsertContact>): Promise<Contact | undefined>;
  deleteContact(id: number): Promise<void>;

  getRelationships(contactId: number): Promise<(ContactRelationship & { guardian?: Contact; player?: Contact })[]>;
  createRelationship(rel: InsertRelationship): Promise<ContactRelationship>;

  getPrograms(): Promise<Program[]>;
  getProgram(id: number): Promise<Program | undefined>;
  getProgramBySlug(slug: string): Promise<Program | undefined>;
  createProgram(program: InsertProgram): Promise<Program>;
  updateProgram(id: number, program: Partial<InsertProgram>): Promise<Program | undefined>;
  deleteProgram(id: number): Promise<void>;

  getSessionsByProgram(programId: number): Promise<ProgramSession[]>;
  getSession(id: number): Promise<ProgramSession | undefined>;
  createSession(session: InsertSession): Promise<ProgramSession>;
  createSessions(sessions: InsertSession[]): Promise<ProgramSession[]>;
  updateSession(id: number, data: Partial<InsertSession>): Promise<ProgramSession | undefined>;
  deleteSession(id: number): Promise<void>;
  deleteSessionsByProgramAndDate(programId: number, date: string): Promise<void>;

  getSessionBookings(sessionId: number): Promise<(SessionBooking & { contact?: Contact })[]>;
  getSessionBookingsByProgram(programId: number): Promise<(SessionBooking & { contact?: Contact; session?: ProgramSession })[]>;
  createSessionBooking(booking: InsertSessionBooking): Promise<SessionBooking>;
  createSessionBookings(bookings: InsertSessionBooking[]): Promise<SessionBooking[]>;
  updateSessionBooking(id: number, data: Partial<InsertSessionBooking>): Promise<SessionBooking | undefined>;
  deleteSessionBooking(id: number): Promise<void>;

  getProgramDiscounts(programId: number): Promise<ProgramDiscount[]>;
  setProgramDiscounts(programId: number, discounts: { minBookings: number; discountPercent: string }[]): Promise<ProgramDiscount[]>;

  getUserOrganizations(userId: number): Promise<(Organization & { userRole: string; userTabs: string[] | null })[]>;

  getFacilities(orgId: number): Promise<Facility[]>;
  getFacility(id: number): Promise<Facility | undefined>;
  createFacility(data: InsertFacility): Promise<Facility>;
  updateFacility(id: number, data: Partial<InsertFacility>): Promise<Facility | undefined>;
  deleteFacility(id: number): Promise<void>;
  getFacilityPricingRules(facilityId: number): Promise<FacilityPricingRule[]>;
  createFacilityPricingRule(data: InsertFacilityPricingRule): Promise<FacilityPricingRule>;
  deleteFacilityPricingRule(id: number): Promise<void>;

  getFacilityBookings(orgId: number): Promise<(FacilityBooking & { facility?: Facility })[]>;
  getFacilityBooking(id: number): Promise<FacilityBooking | undefined>;
  getFacilityPricingRule(id: number): Promise<FacilityPricingRule | undefined>;
  getFacilityAddon(id: number): Promise<FacilityAddon | undefined>;
  createFacilityBooking(data: InsertFacilityBooking): Promise<FacilityBooking>;
  updateFacilityBooking(id: number, data: Partial<InsertFacilityBooking>): Promise<FacilityBooking | undefined>;
  deleteFacilityBooking(id: number): Promise<void>;

  getFacilityAddons(orgId: number): Promise<FacilityAddon[]>;
  createFacilityAddon(data: InsertFacilityAddon): Promise<FacilityAddon>;
  updateFacilityAddon(id: number, data: Partial<InsertFacilityAddon>): Promise<FacilityAddon | undefined>;
  deleteFacilityAddon(id: number): Promise<void>;

  getVenueSettings(orgId: number): Promise<VenueSettings | undefined>;
  upsertVenueSettings(orgId: number, data: Partial<InsertVenueSettings>): Promise<VenueSettings>;
  getPublicFacilities(orgId: number): Promise<(Facility & { addons: FacilityAddon[]; pricingRules: FacilityPricingRule[] })[]>;
  getFacilityBookingsForDates(facilityId: number, dates: string[]): Promise<FacilityBooking[]>;
  createFacilityBookingDrafts(items: InsertFacilityBooking[]): Promise<FacilityBooking[]>;
  confirmFacilityBookingsByPaymentIntent(paymentIntentId: string): Promise<FacilityBooking[]>;
  cancelFacilityBookingsByGroup(groupId: string): Promise<void>;
  cancelPendingFacilityBookingsByGroup(groupId: string): Promise<FacilityBooking[]>;
  getStalePendingFacilityBookings(olderThanMinutes: number): Promise<FacilityBooking[]>;

  getLeagueCompetitions(orgId: number): Promise<LeagueCompetition[]>;
  getLeagueCompetition(id: number): Promise<LeagueCompetition | undefined>;
  createLeagueCompetition(data: InsertLeagueCompetition): Promise<LeagueCompetition>;
  updateLeagueCompetition(id: number, data: Partial<InsertLeagueCompetition>): Promise<LeagueCompetition | undefined>;
  deleteLeagueCompetition(id: number): Promise<void>;

  getLeagueDivisions(competitionId: number): Promise<LeagueDivision[]>;
  getLeagueDivision(id: number): Promise<LeagueDivision | undefined>;
  createLeagueDivision(data: InsertLeagueDivision): Promise<LeagueDivision>;
  updateLeagueDivision(id: number, data: Partial<InsertLeagueDivision>): Promise<LeagueDivision | undefined>;
  deleteLeagueDivision(id: number): Promise<void>;

  getLeagueTeams(orgId: number, competitionId?: number): Promise<(LeagueTeam & { division?: LeagueDivision })[]>;
  getLeagueTeam(id: number): Promise<LeagueTeam | undefined>;
  createLeagueTeam(data: InsertLeagueTeam): Promise<LeagueTeam>;
  updateLeagueTeam(id: number, data: Partial<InsertLeagueTeam>): Promise<LeagueTeam | undefined>;
  deleteLeagueTeam(id: number): Promise<void>;

  getLeagueGames(competitionId: number): Promise<(LeagueGame & { homeTeam?: LeagueTeam; awayTeam?: LeagueTeam; division?: LeagueDivision })[]>;
  getLeagueGame(id: number): Promise<LeagueGame | undefined>;
  createLeagueGame(data: InsertLeagueGame): Promise<LeagueGame>;
  updateLeagueGame(id: number, data: Partial<InsertLeagueGame>): Promise<LeagueGame | undefined>;
  deleteLeagueGame(id: number): Promise<void>;

  getLeagueCoupons(competitionId: number): Promise<LeagueCoupon[]>;
  createLeagueCoupon(data: InsertLeagueCoupon): Promise<LeagueCoupon>;
  updateLeagueCoupon(id: number, data: Partial<InsertLeagueCoupon>): Promise<LeagueCoupon | undefined>;
  deleteLeagueCoupon(id: number): Promise<void>;

  getLeagueStandings(competitionId: number, divisionId?: number): Promise<{ teamId: number; teamName: string; divisionId: number | null; divisionName: string; mp: number; w: number; l: number; d: number; gf: number; ga: number; gd: number; pts: number }[]>;

  getClubs(orgId: number): Promise<Club[]>;
  getClub(id: number): Promise<Club | undefined>;
  createClub(data: InsertClub): Promise<Club>;
  updateClub(id: number, data: Partial<InsertClub>): Promise<Club | undefined>;
  deleteClub(id: number): Promise<void>;
  getClubTeams(clubId: number): Promise<TournamentTeam[]>;

  getTerms(orgId: number): Promise<Term[]>;
  createTerm(data: InsertTerm): Promise<Term>;
  updateTerm(id: number, data: Partial<InsertTerm>): Promise<Term | undefined>;
  deleteTerm(id: number): Promise<void>;

  getTournaments(orgId: number): Promise<Tournament[]>;
  getTournament(id: number): Promise<Tournament | undefined>;
  createTournament(data: InsertTournament): Promise<Tournament>;
  updateTournament(id: number, data: Partial<InsertTournament>): Promise<Tournament | undefined>;
  deleteTournament(id: number): Promise<void>;

  getTournamentGroups(tournamentId: number): Promise<TournamentGroup[]>;
  createTournamentGroup(data: InsertTournamentGroup): Promise<TournamentGroup>;
  updateTournamentGroup(id: number, data: Partial<InsertTournamentGroup>): Promise<TournamentGroup | undefined>;
  deleteTournamentGroup(id: number): Promise<void>;

  getTournamentTeams(tournamentId: number): Promise<(TournamentTeam & { group?: TournamentGroup })[]>;
  getTournamentTeam(id: number): Promise<TournamentTeam | undefined>;
  createTournamentTeam(data: InsertTournamentTeam): Promise<TournamentTeam>;
  updateTournamentTeam(id: number, data: Partial<InsertTournamentTeam>): Promise<TournamentTeam | undefined>;
  deleteTournamentTeam(id: number): Promise<void>;

  getTournamentPlayers(teamId: number): Promise<TournamentPlayer[]>;
  getTournamentPlayer(id: number): Promise<TournamentPlayer | undefined>;
  createTournamentPlayer(data: InsertTournamentPlayer): Promise<TournamentPlayer>;
  updateTournamentPlayer(id: number, data: Partial<InsertTournamentPlayer>): Promise<TournamentPlayer | undefined>;
  deleteTournamentPlayer(id: number): Promise<void>;

  getTournamentGoalsByGame(gameId: number): Promise<TournamentGoal[]>;
  createTournamentGoal(data: InsertTournamentGoal): Promise<TournamentGoal>;
  deleteTournamentGoal(id: number): Promise<void>;
  getTournamentTopScorers(tournamentId: number): Promise<{
    playerId: number; playerName: string; shirtNumber: number | null;
    teamId: number; teamName: string; teamLogoUrl: string | null;
    goals: number;
  }[]>;

  getTournamentStaff(teamId: number): Promise<TournamentStaff[]>;
  createTournamentStaff(data: InsertTournamentStaff): Promise<TournamentStaff>;
  updateTournamentStaff(id: number, data: Partial<InsertTournamentStaff>): Promise<TournamentStaff | undefined>;
  deleteTournamentStaff(id: number): Promise<void>;

  getTournamentGames(tournamentId: number): Promise<(TournamentGame & { homeTeam?: TournamentTeam; awayTeam?: TournamentTeam; group?: TournamentGroup })[]>;
  getTournamentGame(id: number): Promise<TournamentGame | undefined>;
  createTournamentGame(data: InsertTournamentGame): Promise<TournamentGame>;
  updateTournamentGame(id: number, data: Partial<InsertTournamentGame>): Promise<TournamentGame | undefined>;
  deleteTournamentGame(id: number): Promise<void>;

  getTournamentGroupStandings(tournamentId: number): Promise<{ teamId: number; teamName: string; groupId: number | null; groupName: string; mp: number; w: number; l: number; d: number; gf: number; ga: number; gd: number; pts: number }[]>;

  getRegistrations(): Promise<(Registration & { contact?: Contact; program?: Program })[]>;
  getRegistrationsByProgram(programId: number): Promise<(Registration & { contact?: Contact })[]>;
  getRegistration(id: number): Promise<Registration | undefined>;
  createRegistration(reg: InsertRegistration): Promise<Registration>;
  updateRegistration(id: number, data: Partial<InsertRegistration>): Promise<Registration | undefined>;
  updateRegistrationItem(id: number, data: Partial<InsertRegistrationItem>): Promise<RegistrationItem | undefined>;
  assignOrderNumber(id: number): Promise<number>;
  deleteRegistration(id: number): Promise<void>;

  getCampPricing(campId: number): Promise<CampPricing[]>;
  setCampPricing(campId: number, pricing: InsertCampPricing[]): Promise<CampPricing[]>;

  getCampDates(campId: number): Promise<CampDate[]>;
  getCampDate(id: number): Promise<CampDate | undefined>;
  createCampDate(d: InsertCampDate): Promise<CampDate>;
  updateCampDate(id: number, data: Partial<InsertCampDate>): Promise<CampDate | undefined>;
  deleteCampDate(id: number): Promise<void>;

  getCampSettings(campId: number): Promise<CampSettings | undefined>;
  upsertCampSettings(campId: number, data: Partial<InsertCampSettings>): Promise<CampSettings>;

  getSessionsSummary(campId: number): Promise<{ campDateId: number; date: string; productType: string; bookedCount: number; capacity: number }[]>;
  getCampRegistrationStats(campId: number): Promise<{ totalRegistrations: number; confirmedRegistrations: number; totalRevenueCents: number; totalSessions: number }>;
  getCampRegistrationCounts(): Promise<Record<number, number>>;
  getSessionRoll(campId: number, campDateId: number, sessionType: string): Promise<{ child: Child & { medical?: ChildMedical }; parent: Contact; attendance?: Attendance; productType: string }[]>;

  getAllChildren(): Promise<(Child & { medical?: ChildMedical })[]>;
  getChildren(parentId: number): Promise<(Child & { medical?: ChildMedical })[]>;
  getChild(id: number): Promise<Child | undefined>;
  createChild(c: InsertChild): Promise<Child>;
  updateChild(id: number, data: Partial<InsertChild>): Promise<Child | undefined>;

  getChildMedical(childId: number): Promise<ChildMedical | undefined>;
  upsertChildMedical(childId: number, data: Partial<InsertChildMedical>): Promise<ChildMedical>;

  getRegistrationItems(registrationId: number): Promise<(RegistrationItem & { child?: Child; campDate?: CampDate })[]>;
  createRegistrationItems(items: InsertRegistrationItem[]): Promise<RegistrationItem[]>;
  replaceRegistrationItems(registrationId: number, items: InsertRegistrationItem[]): Promise<RegistrationItem[]>;

  getAttendanceByDate(campId: number, campDateId: number): Promise<(Attendance & { child?: Child & { medical?: ChildMedical }; parent?: Contact })[]>;
  createAttendance(a: InsertAttendance): Promise<Attendance>;
  createAttendanceBulk(items: InsertAttendance[]): Promise<Attendance[]>;
  updateAttendance(id: number, data: Partial<InsertAttendance>): Promise<Attendance | undefined>;
  deleteAttendanceIfUnused(campId: number, campDateId: number, childId: number): Promise<void>;

  createEmailLog(log: InsertEmailLog): Promise<EmailLog>;
  getEmailLogByRegistration(registrationId: number): Promise<EmailLog | undefined>;
  createMetaEventLog(log: InsertMetaEventLog): Promise<MetaEventLog>;

  getEmailCampaigns(): Promise<EmailCampaign[]>;
  getEmailCampaign(id: number): Promise<EmailCampaign | undefined>;
  createEmailCampaign(campaign: InsertEmailCampaign): Promise<EmailCampaign>;
  updateEmailCampaign(id: number, data: Partial<InsertEmailCampaign>): Promise<EmailCampaign | undefined>;

  getMailerSegmentEmails(segmentType: string, segmentConfig?: any): Promise<string[]>;

  getAuditLogs(): Promise<AuditLog[]>;
  createAuditLog(log: InsertAuditLog): Promise<AuditLog>;

  getStats(): Promise<{
    totalContacts: number;
    totalPlayers: number;
    totalGuardians: number;
    activePrograms: number;
    totalRegistrations: number;
    pendingRegistrations: number;
  }>;

  getCampStats(): Promise<{
    totalParents: number;
    activeCamps: number;
    totalRegistrations: number;
    paidRegistrations: number;
    totalRevenueCents: number;
  }>;

  getSettings(): Promise<Record<string, string>>;
  getSetting(key: string): Promise<string | null>;
  upsertSettings(entries: { key: string; value: string }[]): Promise<void>;

  getCustomDomainsByOrg(organizationId: number): Promise<CustomDomain[]>;
  getCustomDomainByHostname(hostname: string): Promise<CustomDomain | undefined>;
  createCustomDomain(data: InsertCustomDomain): Promise<CustomDomain>;
  updateCustomDomain(id: number, data: Partial<InsertCustomDomain>): Promise<CustomDomain | undefined>;
  deleteCustomDomain(id: number): Promise<void>;

  getCalendarEvents(filters: { organizationId?: number; startDate?: Date; endDate?: Date; calendarType?: string }): Promise<CalendarEvent[]>;
  getCalendarEvent(id: number): Promise<CalendarEvent | undefined>;
  createCalendarEvent(data: InsertCalendarEvent): Promise<CalendarEvent>;
  updateCalendarEvent(id: number, data: Partial<InsertCalendarEvent>): Promise<CalendarEvent | undefined>;
  deleteCalendarEvent(id: number): Promise<void>;

  getCalendarCategories(orgId: number): Promise<CalendarCategory[]>;
  getCalendarCategory(id: number): Promise<CalendarCategory | undefined>;
  createCalendarCategory(data: InsertCalendarCategory): Promise<CalendarCategory>;
  updateCalendarCategory(id: number, data: Partial<InsertCalendarCategory>): Promise<CalendarCategory | undefined>;
  deleteCalendarCategory(id: number): Promise<void>;
  reassignCalendarEvents(orgId: number, fromSlug: string, toSlug: string): Promise<number>;

  getDiscountsByOrg(organizationId: number): Promise<Discount[]>;
  getDiscount(id: number): Promise<Discount | undefined>;
  getDiscountByCode(code: string, organizationId: number): Promise<Discount | undefined>;
  createDiscount(data: InsertDiscount2): Promise<Discount>;
  updateDiscount(id: number, data: Partial<InsertDiscount2>): Promise<Discount | undefined>;
  deleteDiscount(id: number): Promise<void>;
  incrementDiscountUsage(id: number, discountedCents: number): Promise<void>;

  getPrintOrdersByOrg(orgId: number): Promise<PrintOrder[]>;
  getPrintOrder(id: number): Promise<PrintOrder | undefined>;
  createPrintOrder(data: InsertPrintOrder): Promise<PrintOrder>;
  updatePrintOrder(id: number, data: Partial<InsertPrintOrder>): Promise<PrintOrder | undefined>;
  deletePrintOrder(id: number): Promise<void>;

  getPrintProjectsByOrg(orgId: number): Promise<PrintProject[]>;
  getPrintProject(id: number): Promise<PrintProject | undefined>;
  createPrintProject(data: InsertPrintProject): Promise<PrintProject>;
  updatePrintProject(id: number, data: Partial<InsertPrintProject>): Promise<PrintProject | undefined>;
  deletePrintProject(id: number): Promise<void>;

  getPrintContactsByOrg(orgId: number): Promise<PrintContact[]>;
  getPrintContact(id: number): Promise<PrintContact | undefined>;
  createPrintContact(data: InsertPrintContact): Promise<PrintContact>;
  updatePrintContact(id: number, data: Partial<InsertPrintContact>): Promise<PrintContact | undefined>;
  deletePrintContact(id: number): Promise<void>;

  getPrintLandingPagesByOrg(orgId: number): Promise<PrintLandingPage[]>;
  getPrintLandingPage(id: number): Promise<PrintLandingPage | undefined>;
  createPrintLandingPage(data: InsertPrintLandingPage): Promise<PrintLandingPage>;
  updatePrintLandingPage(id: number, data: Partial<InsertPrintLandingPage>): Promise<PrintLandingPage | undefined>;
  deletePrintLandingPage(id: number): Promise<void>;

  getPrintEmailsByOrg(orgId: number): Promise<PrintEmail[]>;
  createPrintEmail(data: InsertPrintEmail): Promise<PrintEmail>;
  updatePrintEmail(id: number, data: Partial<InsertPrintEmail>): Promise<PrintEmail | undefined>;

  // Print materials catalog (the heart of the pricing engine)
  getPrintMaterials(orgId: number, opts?: { activeOnly?: boolean }): Promise<PrintMaterial[]>;
  getPrintMaterial(id: number): Promise<PrintMaterial | undefined>;
  getPrintMaterialBySlug(slug: string): Promise<PrintMaterial | undefined>;
  createPrintMaterial(data: InsertPrintMaterial): Promise<PrintMaterial>;
  updatePrintMaterial(id: number, data: Partial<InsertPrintMaterial>): Promise<PrintMaterial | undefined>;
  deletePrintMaterial(id: number): Promise<void>;

  // Print order items, files, events
  getPrintOrderItems(orderId: number): Promise<PrintOrderItem[]>;
  createPrintOrderItem(data: InsertPrintOrderItem): Promise<PrintOrderItem>;
  deletePrintOrderItems(orderId: number): Promise<void>;

  getPrintOrderFiles(orderId: number): Promise<PrintOrderFile[]>;
  createPrintOrderFile(data: InsertPrintOrderFile): Promise<PrintOrderFile>;
  deletePrintOrderFile(id: number): Promise<void>;

  getPrintOrderEvents(orderId: number): Promise<PrintOrderEvent[]>;
  createPrintOrderEvent(data: InsertPrintOrderEvent): Promise<PrintOrderEvent>;

  getPrintOrderByMagicLink(token: string): Promise<PrintOrder | undefined>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(sql`LOWER(${users.email}) = LOWER(${email})`);
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return db.select().from(users).orderBy(asc(users.firstName));
  }

  // For the team management page — every user with their per-workspace
  // memberships flattened. One DB round-trip via a left join so we don't
  // N+1 across users.
  async getAllUsersWithMemberships(): Promise<Array<User & { memberships: Array<{ orgId: number; orgName: string; orgSlug: string; role: string; tabs: string[] | null }> }>> {
    const rows = await db.select({
      user: users,
      orgId: organizations.id,
      orgName: organizations.name,
      orgSlug: organizations.slug,
      orgRole: userOrganizations.role,
      orgTabs: userOrganizations.tabs,
    })
      .from(users)
      .leftJoin(userOrganizations, eq(users.id, userOrganizations.userId))
      .leftJoin(organizations, eq(userOrganizations.organizationId, organizations.id))
      .orderBy(asc(users.firstName), asc(users.lastName));

    const map = new Map<number, User & { memberships: Array<{ orgId: number; orgName: string; orgSlug: string; role: string; tabs: string[] | null }> }>();
    for (const row of rows) {
      const u = row.user;
      if (!map.has(u.id)) {
        map.set(u.id, { ...u, memberships: [] });
      }
      if (row.orgId) {
        map.get(u.id)!.memberships.push({
          orgId: row.orgId,
          orgName: row.orgName!,
          orgSlug: row.orgSlug!,
          role: row.orgRole!,
          tabs: row.orgTabs ?? null,
        });
      }
    }
    return Array.from(map.values());
  }

  async addUserToOrganization(userId: number, organizationId: number, role: string = "admin", tabs: string[] | null = null): Promise<UserOrganization> {
    const [created] = await db.insert(userOrganizations).values({ userId, organizationId, role: role as any, tabs }).returning();
    return created;
  }

  async updateUserOrgRole(userId: number, organizationId: number, role: string): Promise<UserOrganization | undefined> {
    const [updated] = await db.update(userOrganizations)
      .set({ role: role as any })
      .where(and(eq(userOrganizations.userId, userId), eq(userOrganizations.organizationId, organizationId)))
      .returning();
    return updated;
  }

  async updateUserOrgTabs(userId: number, organizationId: number, tabs: string[] | null): Promise<UserOrganization | undefined> {
    const [updated] = await db.update(userOrganizations)
      .set({ tabs })
      .where(and(eq(userOrganizations.userId, userId), eq(userOrganizations.organizationId, organizationId)))
      .returning();
    return updated;
  }

  async updateUserOrgMembership(userId: number, organizationId: number, updates: { role?: string; tabs?: string[] | null }): Promise<UserOrganization | undefined> {
    const set: any = {};
    if (updates.role !== undefined) set.role = updates.role;
    if (updates.tabs !== undefined) set.tabs = updates.tabs;
    if (Object.keys(set).length === 0) return undefined;
    const [updated] = await db.update(userOrganizations)
      .set(set)
      .where(and(eq(userOrganizations.userId, userId), eq(userOrganizations.organizationId, organizationId)))
      .returning();
    return updated;
  }

  async removeUserFromOrganization(userId: number, organizationId: number): Promise<void> {
    await db.delete(userOrganizations)
      .where(and(eq(userOrganizations.userId, userId), eq(userOrganizations.organizationId, organizationId)));
  }

  async getUserOrganizations(userId: number): Promise<(Organization & { userRole: string; userTabs: string[] | null })[]> {
    const rows = await db.select({
      org: organizations,
      userRole: userOrganizations.role,
      userTabs: userOrganizations.tabs,
    }).from(userOrganizations)
      .innerJoin(organizations, eq(userOrganizations.organizationId, organizations.id))
      .where(eq(userOrganizations.userId, userId))
      .orderBy(asc(organizations.name));
    return rows.map(r => ({ ...r.org, userRole: r.userRole, userTabs: (r.userTabs as string[] | null) ?? null }));
  }

  async createUser(user: InsertUser): Promise<User> {
    const [created] = await db.insert(users).values(user).returning();
    return created;
  }

  async updateUser(id: number, data: Partial<InsertUser>): Promise<User | undefined> {
    const [updated] = await db.update(users).set(data).where(eq(users.id, id)).returning();
    return updated;
  }

  async deleteUser(id: number): Promise<void> {
    await db.delete(users).where(eq(users.id, id));
  }

  async getContacts(): Promise<Contact[]> {
    return db.select().from(contacts).orderBy(asc(contacts.firstName));
  }

  async getContact(id: number): Promise<Contact | undefined> {
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, id));
    return contact;
  }

  async findContactByEmail(email: string): Promise<Contact | undefined> {
    const [contact] = await db.select().from(contacts).where(eq(contacts.email, email));
    return contact;
  }

  async createContact(contact: InsertContact): Promise<Contact> {
    const [created] = await db.insert(contacts).values(contact).returning();
    return created;
  }

  async updateContact(id: number, data: Partial<InsertContact>): Promise<Contact | undefined> {
    const [updated] = await db.update(contacts).set(data).where(eq(contacts.id, id)).returning();
    return updated;
  }

  async deleteContact(id: number): Promise<void> {
    await db.delete(contacts).where(eq(contacts.id, id));
  }

  async getRelationships(contactId: number): Promise<(ContactRelationship & { guardian?: Contact; player?: Contact })[]> {
    const rels = await db.select().from(contactRelationships)
      .where(or(eq(contactRelationships.guardianId, contactId), eq(contactRelationships.playerId, contactId)));

    const enriched = await Promise.all(rels.map(async (rel) => {
      const [guardian] = await db.select().from(contacts).where(eq(contacts.id, rel.guardianId));
      const [player] = await db.select().from(contacts).where(eq(contacts.id, rel.playerId));
      return { ...rel, guardian, player };
    }));

    return enriched;
  }

  async createRelationship(rel: InsertRelationship): Promise<ContactRelationship> {
    const [created] = await db.insert(contactRelationships).values(rel).returning();
    return created;
  }

  async getPrograms(): Promise<Program[]> {
    return db.select().from(programs).orderBy(desc(programs.createdAt));
  }

  async getProgram(id: number): Promise<Program | undefined> {
    const [program] = await db.select().from(programs).where(eq(programs.id, id));
    return program;
  }

  async getProgramBySlug(slug: string): Promise<Program | undefined> {
    const [program] = await db.select().from(programs).where(eq(programs.slug, slug));
    return program;
  }

  async createProgram(program: InsertProgram): Promise<Program> {
    const [created] = await db.insert(programs).values(program).returning();
    return created;
  }

  async updateProgram(id: number, data: Partial<InsertProgram>): Promise<Program | undefined> {
    const [updated] = await db.update(programs).set(data).where(eq(programs.id, id)).returning();
    return updated;
  }

  // Program options — priced packages on a program (e.g. Beginner Thursday
  // / Beginner Saturday / Beginner Combo). Each row is what the parent
  // picks on the public registration page.
  async getProgramOptions(programId: number, opts: { activeOnly?: boolean } = {}): Promise<ProgramOption[]> {
    const where = opts.activeOnly
      ? and(eq(programOptions.programId, programId), eq(programOptions.isActive, true))
      : eq(programOptions.programId, programId);
    return db.select().from(programOptions).where(where).orderBy(asc(programOptions.displayOrder), asc(programOptions.id));
  }
  async getProgramOption(id: number): Promise<ProgramOption | undefined> {
    const [r] = await db.select().from(programOptions).where(eq(programOptions.id, id));
    return r;
  }
  async createProgramOption(data: InsertProgramOption): Promise<ProgramOption> {
    const [r] = await db.insert(programOptions).values(data).returning();
    return r;
  }
  async updateProgramOption(id: number, data: Partial<InsertProgramOption>): Promise<ProgramOption | undefined> {
    const [r] = await db.update(programOptions).set(data).where(eq(programOptions.id, id)).returning();
    return r;
  }
  async deleteProgramOption(id: number): Promise<void> {
    await db.delete(programOptions).where(eq(programOptions.id, id));
  }

  async deleteProgram(id: number): Promise<void> {
    await db.execute(sql`DELETE FROM attendance WHERE camp_id = ${id}`);
    await db.execute(sql`DELETE FROM email_logs WHERE camp_id = ${id}`);
    await db.execute(sql`DELETE FROM meta_event_logs WHERE camp_id = ${id}`);
    await db.execute(sql`DELETE FROM session_bookings WHERE session_id IN (SELECT id FROM program_sessions WHERE program_id = ${id})`);
    await db.execute(sql`DELETE FROM registration_items WHERE registration_id IN (SELECT id FROM registrations WHERE program_id = ${id})`);
    await db.delete(registrations).where(eq(registrations.programId, id));
    await db.delete(programSessions).where(eq(programSessions.programId, id));
    await db.delete(programDiscounts).where(eq(programDiscounts.programId, id));
    await db.delete(programs).where(eq(programs.id, id));
  }

  async getSessionsByProgram(programId: number): Promise<ProgramSession[]> {
    return db.select().from(programSessions)
      .where(eq(programSessions.programId, programId))
      .orderBy(asc(programSessions.date), asc(programSessions.startTime));
  }

  async getSession(id: number): Promise<ProgramSession | undefined> {
    const [session] = await db.select().from(programSessions).where(eq(programSessions.id, id));
    return session;
  }

  async createSession(session: InsertSession): Promise<ProgramSession> {
    const [created] = await db.insert(programSessions).values(session).returning();
    return created;
  }

  async createSessions(sessions: InsertSession[]): Promise<ProgramSession[]> {
    if (sessions.length === 0) return [];
    return db.insert(programSessions).values(sessions).returning();
  }

  async updateSession(id: number, data: Partial<InsertSession>): Promise<ProgramSession | undefined> {
    const [updated] = await db.update(programSessions).set(data).where(eq(programSessions.id, id)).returning();
    return updated;
  }

  async deleteSession(id: number): Promise<void> {
    await db.delete(programSessions).where(eq(programSessions.id, id));
  }

  async deleteSessionsByProgramAndDate(programId: number, date: string): Promise<void> {
    await db.delete(programSessions)
      .where(and(eq(programSessions.programId, programId), eq(programSessions.date, date)));
  }

  async getSessionBookings(sessionId: number): Promise<(SessionBooking & { contact?: Contact })[]> {
    const bookings = await db.select().from(sessionBookings).where(eq(sessionBookings.sessionId, sessionId));
    return Promise.all(bookings.map(async (b) => {
      const [contact] = await db.select().from(contacts).where(eq(contacts.id, b.contactId));
      return { ...b, contact };
    }));
  }

  async getSessionBookingsByProgram(programId: number): Promise<(SessionBooking & { contact?: Contact; session?: ProgramSession })[]> {
    const sessions = await this.getSessionsByProgram(programId);
    const sessionIds = sessions.map(s => s.id);
    if (sessionIds.length === 0) return [];
    const bookings = await db.select().from(sessionBookings).where(inArray(sessionBookings.sessionId, sessionIds));
    return Promise.all(bookings.map(async (b) => {
      const [contact] = await db.select().from(contacts).where(eq(contacts.id, b.contactId));
      const session = sessions.find(s => s.id === b.sessionId);
      return { ...b, contact, session };
    }));
  }

  async createSessionBooking(booking: InsertSessionBooking): Promise<SessionBooking> {
    const [created] = await db.insert(sessionBookings).values(booking).returning();
    return created;
  }

  async createSessionBookings(bookings: InsertSessionBooking[]): Promise<SessionBooking[]> {
    if (bookings.length === 0) return [];
    return db.insert(sessionBookings).values(bookings).returning();
  }

  async updateSessionBooking(id: number, data: Partial<InsertSessionBooking>): Promise<SessionBooking | undefined> {
    const [updated] = await db.update(sessionBookings).set(data).where(eq(sessionBookings.id, id)).returning();
    return updated;
  }

  async deleteSessionBooking(id: number): Promise<void> {
    await db.delete(sessionBookings).where(eq(sessionBookings.id, id));
  }

  async getProgramDiscounts(programId: number): Promise<ProgramDiscount[]> {
    return db.select().from(programDiscounts)
      .where(eq(programDiscounts.programId, programId))
      .orderBy(asc(programDiscounts.minBookings));
  }

  async setProgramDiscounts(programId: number, discounts: { minBookings: number; discountPercent: string }[]): Promise<ProgramDiscount[]> {
    await db.delete(programDiscounts).where(eq(programDiscounts.programId, programId));
    if (discounts.length === 0) return [];
    return db.insert(programDiscounts).values(discounts.map(d => ({ ...d, programId }))).returning();
  }

  async getRegistrations(): Promise<(Registration & { contact?: Contact; program?: Program })[]> {
    const regs = await db.select().from(registrations).where(sql`${registrations.status} IN ('confirmed', 'refunded', 'partially_refunded')`).orderBy(desc(registrations.orderNumber), desc(registrations.registeredAt));
    return Promise.all(regs.map(async (r) => {
      const [contact] = await db.select().from(contacts).where(eq(contacts.id, r.contactId));
      const [program] = await db.select().from(programs).where(eq(programs.id, r.programId));
      return { ...r, contact, program };
    }));
  }

  async getRegistrationsByProgram(programId: number): Promise<(Registration & { contact?: Contact })[]> {
    const regs = await db.select().from(registrations).where(and(eq(registrations.programId, programId), sql`${registrations.status} IN ('confirmed', 'refunded', 'partially_refunded')`));
    return Promise.all(regs.map(async (r) => {
      const [contact] = await db.select().from(contacts).where(eq(contacts.id, r.contactId));
      return { ...r, contact };
    }));
  }

  async getRegistration(id: number): Promise<Registration | undefined> {
    const [reg] = await db.select().from(registrations).where(eq(registrations.id, id));
    return reg;
  }

  // All registrations that share a single deposit PaymentIntent (a multi-team
  // MFL order). Ordered by id so the lowest id is the deterministic "primary".
  async getRegistrationsByStripePaymentIntent(paymentIntentId: string): Promise<Registration[]> {
    if (!paymentIntentId) return [];
    return db.select().from(registrations)
      .where(eq(registrations.stripePaymentIntentId, paymentIntentId))
      .orderBy(asc(registrations.id));
  }

  // Registrations grouped under one multi-team order id.
  async getRegistrationsByGroup(groupId: string): Promise<Registration[]> {
    if (!groupId) return [];
    return db.select().from(registrations)
      .where(eq(registrations.registrationGroupId, groupId))
      .orderBy(asc(registrations.id));
  }

  async createRegistration(reg: InsertRegistration): Promise<Registration> {
    const [created] = await db.insert(registrations).values(reg).returning();
    return created;
  }

  async updateRegistration(id: number, data: Partial<InsertRegistration>): Promise<Registration | undefined> {
    const [updated] = await db.update(registrations).set(data).where(eq(registrations.id, id)).returning();
    return updated;
  }

  // Atomically flip a pending registration to confirmed. Returns true ONLY for
  // the caller that won the transition, so payment-success side effects (discount
  // usage, confirmation email, Purchase event) fire exactly once even when the
  // Stripe webhook and the client confirm-payment race on the same payment.
  async confirmRegistrationOnce(id: number, amountPaid: string): Promise<boolean> {
    const [row] = await db.update(registrations)
      .set({ status: "confirmed", amountPaid })
      .where(and(eq(registrations.id, id), ne(registrations.status, "confirmed")))
      .returning({ id: registrations.id });
    return !!row;
  }

  async assignOrderNumber(id: number): Promise<number> {
    const result = await db.execute(sql`
      UPDATE registrations 
      SET order_number = (SELECT COALESCE(MAX(order_number), 0) + 1 FROM registrations)
      WHERE id = ${id} AND order_number IS NULL
      RETURNING order_number
    `);
    const rows = result.rows as any[];
    if (rows.length > 0) return rows[0].order_number;
    const [reg] = await db.select({ orderNumber: registrations.orderNumber }).from(registrations).where(eq(registrations.id, id));
    return reg?.orderNumber || 0;
  }

  async deleteRegistration(id: number): Promise<void> {
    await db.execute(sql`DELETE FROM email_logs WHERE registration_id = ${id}`);
    await db.execute(sql`DELETE FROM meta_event_logs WHERE registration_id = ${id}`);
    await db.execute(sql`DELETE FROM registration_items WHERE registration_id = ${id}`);
    await db.delete(registrations).where(eq(registrations.id, id));
  }

  async getCampPricing(campId: number): Promise<CampPricing[]> {
    return db.select().from(campPricing).where(eq(campPricing.campId, campId));
  }

  async setCampPricing(campId: number, pricing: InsertCampPricing[]): Promise<CampPricing[]> {
    await db.delete(campPricing).where(eq(campPricing.campId, campId));
    if (pricing.length === 0) return [];
    return db.insert(campPricing).values(pricing).returning();
  }

  async getCampDates(campId: number): Promise<CampDate[]> {
    return db.select().from(campDates).where(eq(campDates.campId, campId)).orderBy(asc(campDates.date));
  }

  async getCampDate(id: number): Promise<CampDate | undefined> {
    const [d] = await db.select().from(campDates).where(eq(campDates.id, id));
    return d;
  }

  async createCampDate(d: InsertCampDate): Promise<CampDate> {
    const [created] = await db.insert(campDates).values(d).returning();
    return created;
  }

  async updateCampDate(id: number, data: Partial<InsertCampDate>): Promise<CampDate | undefined> {
    const [updated] = await db.update(campDates).set(data).where(eq(campDates.id, id)).returning();
    return updated;
  }

  async deleteCampDate(id: number): Promise<void> {
    await db.execute(sql`DELETE FROM attendance WHERE camp_date_id = ${id}`);
    await db.execute(sql`DELETE FROM registration_items WHERE camp_date_id = ${id}`);
    await db.delete(campDates).where(eq(campDates.id, id));
  }

  async getCampSettings(campId: number): Promise<CampSettings | undefined> {
    const [s] = await db.select().from(campSettings).where(eq(campSettings.campId, campId));
    return s;
  }

  async upsertCampSettings(campId: number, data: Partial<InsertCampSettings>): Promise<CampSettings> {
    const existing = await this.getCampSettings(campId);
    if (existing) {
      const [updated] = await db.update(campSettings).set(data).where(eq(campSettings.campId, campId)).returning();
      return updated;
    }
    const [created] = await db.insert(campSettings).values({ ...data, campId }).returning();
    return created;
  }

  async getAllChildren(): Promise<(Child & { medical?: ChildMedical })[]> {
    const kids = await db.select().from(children).orderBy(asc(children.firstName), asc(children.lastName));
    return Promise.all(kids.map(async (c) => {
      const [med] = await db.select().from(childMedical).where(eq(childMedical.childId, c.id));
      return { ...c, medical: med || undefined };
    }));
  }

  async getChildren(parentId: number): Promise<(Child & { medical?: ChildMedical })[]> {
    const kids = await db.select().from(children).where(eq(children.parentId, parentId));
    return Promise.all(kids.map(async (c) => {
      const [med] = await db.select().from(childMedical).where(eq(childMedical.childId, c.id));
      return { ...c, medical: med || undefined };
    }));
  }

  async getChild(id: number): Promise<Child | undefined> {
    const [c] = await db.select().from(children).where(eq(children.id, id));
    return c;
  }

  async createChild(c: InsertChild): Promise<Child> {
    const [created] = await db.insert(children).values(c).returning();
    return created;
  }

  async updateChild(id: number, data: Partial<InsertChild>): Promise<Child | undefined> {
    const [updated] = await db.update(children).set(data).where(eq(children.id, id)).returning();
    return updated;
  }

  async getChildMedical(childId: number): Promise<ChildMedical | undefined> {
    const [med] = await db.select().from(childMedical).where(eq(childMedical.childId, childId));
    return med;
  }

  async upsertChildMedical(childId: number, data: Partial<InsertChildMedical>): Promise<ChildMedical> {
    const existing = await this.getChildMedical(childId);
    if (existing) {
      const [updated] = await db.update(childMedical).set(data).where(eq(childMedical.childId, childId)).returning();
      return updated;
    }
    const [created] = await db.insert(childMedical).values({ ...data, childId }).returning();
    return created;
  }

  async getSessionsSummary(campId: number): Promise<{ campDateId: number; date: string; productType: string; bookedCount: number; capacity: number; name?: string | null; startTime?: string | null; endTime?: string | null }[]> {
    const dates = await this.getCampDates(campId);
    if (dates.length === 0) return [];

    const program = await this.getProgram(campId);
    const isTermMode = program?.scheduleType === "term";

    const dateIds = dates.map(d => d.id);
    const items = await db.select({
      campDateId: registrationItems.campDateId,
      productType: registrationItems.productType,
      count: sql<number>`count(*)::int`,
    })
    .from(registrationItems)
    .innerJoin(registrations, eq(registrationItems.registrationId, registrations.id))
    .where(and(
      inArray(registrationItems.campDateId, dateIds),
      eq(registrations.programId, campId),
      eq(registrations.status, "confirmed"),
    ))
    .groupBy(registrationItems.campDateId, registrationItems.productType);

    const results: { campDateId: number; date: string; productType: string; bookedCount: number; capacity: number; name?: string | null; startTime?: string | null; endTime?: string | null }[] = [];

    if (isTermMode) {
      // Term-mode: one summary row per camp_date (the slot itself is the
      // session — no MORNING/AFTERNOON split). Capacity is capacityFullDay.
      for (const d of dates) {
        const totalCount = items
          .filter(i => i.campDateId === d.id)
          .reduce((sum, i) => sum + (i.count || 0), 0);
        results.push({
          campDateId: d.id,
          date: d.date,
          productType: "SESSION",
          bookedCount: totalCount,
          capacity: d.capacityFullDay || 0,
          name: d.name,
          startTime: d.startTime,
          endTime: d.endTime,
        });
      }
      return results;
    }

    // Holiday-camp mode (legacy): morning + afternoon rows per date.
    for (const d of dates) {
      const fullDayCount = items.find(i => i.campDateId === d.id && i.productType === "FULL_DAY")?.count || 0;
      for (const pt of ["MORNING", "AFTERNOON"]) {
        const match = items.find(i => i.campDateId === d.id && i.productType === pt);
        const cap = pt === "MORNING" ? (d.capacityMorning || 0) : (d.capacityAfternoon || 0);
        results.push({
          campDateId: d.id,
          date: d.date,
          productType: pt,
          bookedCount: (match?.count || 0) + fullDayCount,
          capacity: cap,
        });
      }
    }
    return results;
  }

  async getCampRegistrationStats(campId: number): Promise<{ totalRegistrations: number; confirmedRegistrations: number; totalRevenueCents: number; totalSessions: number }> {
    const regs = await db.select().from(registrations).where(eq(registrations.programId, campId));
    const totalRegistrations = regs.length;
    const confirmedRegistrations = regs.filter(r => r.status === "confirmed").length;
    const totalRevenueCents = regs.filter(r => r.status === "confirmed").reduce((sum, r) => sum + (r.totalCents || 0), 0);

    const dates = await this.getCampDates(campId);
    const dateIds = dates.map(d => d.id);
    let totalSessions = 0;
    if (dateIds.length > 0) {
      const [result] = await db.select({ count: sql<number>`count(*)::int` })
        .from(registrationItems)
        .innerJoin(registrations, eq(registrationItems.registrationId, registrations.id))
        .where(and(
          inArray(registrationItems.campDateId, dateIds),
          eq(registrations.programId, campId),
          eq(registrations.status, "confirmed"),
        ));
      totalSessions = result?.count || 0;
    }

    return { totalRegistrations, confirmedRegistrations, totalRevenueCents, totalSessions };
  }

  async getSessionRoll(campId: number, campDateId: number, sessionType: string): Promise<{ child: Child & { medical?: ChildMedical }; parent: Contact; attendance?: Attendance; productType: string }[]> {
    // Term-mode programs: each camp_date IS the session, so we don't filter
    // by product type — every registration item attached to this date is
    // on the roll.
    const program = await this.getProgram(campId);
    const isTermMode = program?.scheduleType === "term";

    const baseConditions = [
      eq(registrationItems.campDateId, campDateId),
      eq(registrations.programId, campId),
      eq(registrations.status, "confirmed"),
    ];

    let items;
    if (isTermMode || sessionType === "SESSION") {
      items = await db.select()
        .from(registrationItems)
        .innerJoin(registrations, eq(registrationItems.registrationId, registrations.id))
        .where(and(...baseConditions));
    } else {
      const productTypes = sessionType === "MORNING" ? ["MORNING", "FULL_DAY"] :
                           sessionType === "AFTERNOON" ? ["AFTERNOON", "FULL_DAY"] :
                           [sessionType];
      items = await db.select()
        .from(registrationItems)
        .innerJoin(registrations, eq(registrationItems.registrationId, registrations.id))
        .where(and(
          ...baseConditions,
          inArray(registrationItems.productType, productTypes),
        ));
    }

    const results: { child: Child & { medical?: ChildMedical }; parent: Contact; attendance?: Attendance; productType: string }[] = [];
    const seenChildIds = new Set<number>();

    for (const item of items) {
      const childId = item.registration_items.childId;
      if (seenChildIds.has(childId)) continue;
      seenChildIds.add(childId);

      const [child] = await db.select().from(children).where(eq(children.id, childId));
      if (!child) continue;

      const [parent] = await db.select().from(contacts).where(eq(contacts.id, child.parentId));
      const [med] = await db.select().from(childMedical).where(eq(childMedical.childId, childId));

      let attendanceRecords = await db.select().from(attendance)
        .where(and(
          eq(attendance.campId, campId),
          eq(attendance.campDateId, campDateId),
          eq(attendance.childId, childId),
        ));
      let att = attendanceRecords[0];

      if (!att) {
        try {
          const [created] = await db.insert(attendance).values({ campId, campDateId, childId }).returning();
          att = created;
        } catch (e) {
          // retry fetch in case of race condition
          const [existing] = await db.select().from(attendance).where(and(
            eq(attendance.campId, campId), eq(attendance.campDateId, campDateId), eq(attendance.childId, childId),
          ));
          att = existing;
        }
      }

      results.push({
        child: { ...child, medical: med || undefined },
        parent: parent!,
        attendance: att || undefined,
        productType: item.registration_items.productType,
      });
    }

    return results.sort((a, b) => a.child.lastName.localeCompare(b.child.lastName));
  }

  async getCampRegistrationCounts(): Promise<Record<number, number>> {
    const rows = await db.select({
      programId: registrations.programId,
      count: sql<number>`count(*)::int`,
    }).from(registrations)
      .where(eq(registrations.status, "confirmed"))
      .groupBy(registrations.programId);
    const result: Record<number, number> = {};
    for (const row of rows) {
      result[row.programId] = row.count;
    }
    return result;
  }

  async getRegistrationItems(registrationId: number): Promise<(RegistrationItem & { child?: Child; campDate?: CampDate })[]> {
    const items = await db.select().from(registrationItems).where(eq(registrationItems.registrationId, registrationId));
    return Promise.all(items.map(async (item) => {
      const [child] = await db.select().from(children).where(eq(children.id, item.childId));
      const [campDate] = await db.select().from(campDates).where(eq(campDates.id, item.campDateId));
      return { ...item, child, campDate };
    }));
  }

  async createRegistrationItems(items: InsertRegistrationItem[]): Promise<RegistrationItem[]> {
    if (items.length === 0) return [];
    return db.insert(registrationItems).values(items).returning();
  }

  async updateRegistrationItem(id: number, data: Partial<InsertRegistrationItem>): Promise<RegistrationItem | undefined> {
    const [updated] = await db.update(registrationItems).set(data).where(eq(registrationItems.id, id)).returning();
    return updated;
  }

  async replaceRegistrationItems(registrationId: number, items: InsertRegistrationItem[]): Promise<RegistrationItem[]> {
    return db.transaction(async (tx) => {
      await tx.delete(registrationItems).where(eq(registrationItems.registrationId, registrationId));
      if (items.length === 0) return [];
      return tx.insert(registrationItems).values(items.map(i => ({ ...i, registrationId }))).returning();
    });
  }

  async getAttendanceByDate(campId: number, campDateId: number): Promise<(Attendance & { child?: Child & { medical?: ChildMedical }; parent?: Contact })[]> {
    const records = await db.select().from(attendance)
      .where(and(eq(attendance.campId, campId), eq(attendance.campDateId, campDateId)));

    return Promise.all(records.map(async (a) => {
      const [child] = await db.select().from(children).where(eq(children.id, a.childId));
      let parent: Contact | undefined;
      let med: ChildMedical | undefined;
      if (child) {
        const [p] = await db.select().from(contacts).where(eq(contacts.id, child.parentId));
        parent = p;
        const [m] = await db.select().from(childMedical).where(eq(childMedical.childId, child.id));
        med = m || undefined;
      }
      return { ...a, child: child ? { ...child, medical: med } : undefined, parent };
    }));
  }

  async createAttendance(a: InsertAttendance): Promise<Attendance> {
    const [created] = await db.insert(attendance).values(a).returning();
    return created;
  }

  async createAttendanceBulk(items: InsertAttendance[]): Promise<Attendance[]> {
    if (items.length === 0) return [];
    return db.insert(attendance).values(items).returning();
  }

  async deleteAttendanceIfUnused(campId: number, campDateId: number, childId: number): Promise<void> {
    await db.delete(attendance).where(and(
      eq(attendance.campId, campId),
      eq(attendance.campDateId, campDateId),
      eq(attendance.childId, childId),
      isNull(attendance.checkedInAt),
    ));
  }

  async updateAttendance(id: number, data: Partial<InsertAttendance>): Promise<Attendance | undefined> {
    const [updated] = await db.update(attendance).set(data).where(eq(attendance.id, id)).returning();
    return updated;
  }

  async createEmailLog(log: InsertEmailLog): Promise<EmailLog> {
    const [created] = await db.insert(emailLogs).values(log).returning();
    return created;
  }

  async getEmailLogByRegistration(registrationId: number): Promise<EmailLog | undefined> {
    const [log] = await db.select().from(emailLogs).where(eq(emailLogs.registrationId, registrationId)).limit(1);
    return log;
  }

  async createMetaEventLog(log: InsertMetaEventLog): Promise<MetaEventLog> {
    const [created] = await db.insert(metaEventLogs).values(log).returning();
    return created;
  }

  async getAuditLogs(): Promise<AuditLog[]> {
    return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(200);
  }

  async createAuditLog(log: InsertAuditLog): Promise<AuditLog> {
    const [created] = await db.insert(auditLogs).values(log).returning();
    return created;
  }

  async getStats(): Promise<{
    totalContacts: number;
    totalPlayers: number;
    totalGuardians: number;
    activePrograms: number;
    totalRegistrations: number;
    pendingRegistrations: number;
  }> {
    const [tc] = await db.select({ count: sql<number>`count(*)` }).from(contacts);
    const [tp] = await db.select({ count: sql<number>`count(*)` }).from(contacts).where(eq(contacts.type, "player"));
    const [tg] = await db.select({ count: sql<number>`count(*)` }).from(contacts).where(eq(contacts.type, "guardian"));
    const [ap] = await db.select({ count: sql<number>`count(*)` }).from(programs).where(eq(programs.isActive, true));
    const [tr] = await db.select({ count: sql<number>`count(*)` }).from(registrations);
    const [pr] = await db.select({ count: sql<number>`count(*)` }).from(registrations).where(eq(registrations.status, "pending"));
    return {
      totalContacts: Number(tc.count),
      totalPlayers: Number(tp.count),
      totalGuardians: Number(tg.count),
      activePrograms: Number(ap.count),
      totalRegistrations: Number(tr.count),
      pendingRegistrations: Number(pr.count),
    };
  }

  async getCampStats(): Promise<{
    totalParents: number;
    activeCamps: number;
    totalRegistrations: number;
    paidRegistrations: number;
    totalRevenueCents: number;
  }> {
    const [tp] = await db.select({ count: sql<number>`count(*)` }).from(contacts).where(eq(contacts.type, "guardian"));
    const [ac] = await db.select({ count: sql<number>`count(*)` }).from(programs)
      .where(and(eq(programs.isActive, true), eq(programs.type, "holiday_camp")));
    const campIds = await db.select({ id: programs.id }).from(programs).where(eq(programs.type, "holiday_camp"));
    const ids = campIds.map(c => c.id);
    let totalRegs = 0, paidRegs = 0, totalRev = 0;
    if (ids.length > 0) {
      const [tr] = await db.select({ count: sql<number>`count(*)` }).from(registrations).where(inArray(registrations.programId, ids));
      const [pr] = await db.select({ count: sql<number>`count(*)` }).from(registrations)
        .where(and(inArray(registrations.programId, ids), eq(registrations.status, "confirmed")));
      const [rev] = await db.select({ total: sql<number>`COALESCE(SUM(total_cents), 0)` }).from(registrations)
        .where(and(inArray(registrations.programId, ids), eq(registrations.status, "confirmed")));
      totalRegs = Number(tr.count);
      paidRegs = Number(pr.count);
      totalRev = Number(rev.total);
    }
    return {
      totalParents: Number(tp.count),
      activeCamps: Number(ac.count),
      totalRegistrations: totalRegs,
      paidRegistrations: paidRegs,
      totalRevenueCents: totalRev,
    };
  }

  async getSettings(): Promise<Record<string, string>> {
    const rows = await db.select().from(settings);
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value ?? "";
    }
    return result;
  }

  async getSetting(key: string): Promise<string | null> {
    const [row] = await db.select().from(settings).where(eq(settings.key, key));
    return row?.value ?? null;
  }

  async upsertSettings(entries: { key: string; value: string }[]): Promise<void> {
    for (const entry of entries) {
      await db.insert(settings).values({ key: entry.key, value: entry.value })
        .onConflictDoUpdate({ target: settings.key, set: { value: entry.value, updatedAt: new Date() } });
    }
  }

  async getEmailCampaigns(): Promise<EmailCampaign[]> {
    return db.select().from(emailCampaigns).orderBy(desc(emailCampaigns.createdAt));
  }

  async getEmailCampaign(id: number): Promise<EmailCampaign | undefined> {
    const [row] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, id));
    return row;
  }

  async createEmailCampaign(campaign: InsertEmailCampaign): Promise<EmailCampaign> {
    const [row] = await db.insert(emailCampaigns).values(campaign).returning();
    return row;
  }

  async updateEmailCampaign(id: number, data: Partial<InsertEmailCampaign>): Promise<EmailCampaign | undefined> {
    const [row] = await db.update(emailCampaigns).set(data).where(eq(emailCampaigns.id, id)).returning();
    return row;
  }

  async getMailerSegmentEmails(segmentType: string, segmentConfig?: any): Promise<string[]> {
    const config = segmentConfig ? (typeof segmentConfig === 'string' ? JSON.parse(segmentConfig) : segmentConfig) : {};

    if (segmentType === 'all') {
      const rows = await db.select({ email: contacts.email }).from(contacts)
        .where(and(eq(contacts.type, 'guardian'), sql`${contacts.email} IS NOT NULL AND ${contacts.email} != ''`));
      return [...new Set(rows.map(r => r.email!).filter(Boolean))];
    }

    if (segmentType === 'camp' && config.campId) {
      const regs = await db.select({ contactId: registrations.contactId })
        .from(registrations)
        .where(and(eq(registrations.programId, config.campId), eq(registrations.status, 'confirmed')));
      const contactIds = [...new Set(regs.map(r => r.contactId))];
      if (!contactIds.length) return [];
      const rows = await db.select({ email: contacts.email }).from(contacts)
        .where(and(inArray(contacts.id, contactIds), sql`${contacts.email} IS NOT NULL AND ${contacts.email} != ''`));
      return [...new Set(rows.map(r => r.email!).filter(Boolean))];
    }

    if (segmentType === 'day' && config.campId && config.campDateId) {
      const items = await db.select({ registrationId: registrationItems.registrationId })
        .from(registrationItems)
        .where(eq(registrationItems.campDateId, config.campDateId));
      const regIds = [...new Set(items.map(i => i.registrationId))];
      if (!regIds.length) return [];
      const regs = await db.select({ contactId: registrations.contactId })
        .from(registrations)
        .where(and(inArray(registrations.id, regIds), eq(registrations.status, 'confirmed')));
      const contactIds = [...new Set(regs.map(r => r.contactId))];
      if (!contactIds.length) return [];
      const rows = await db.select({ email: contacts.email }).from(contacts)
        .where(and(inArray(contacts.id, contactIds), sql`${contacts.email} IS NOT NULL AND ${contacts.email} != ''`));
      return [...new Set(rows.map(r => r.email!).filter(Boolean))];
    }

    if (segmentType === 'session' && config.campId && config.campDateId && config.sessionType) {
      const normalizedType = config.sessionType.toUpperCase();
      const items = await db.select({ registrationId: registrationItems.registrationId })
        .from(registrationItems)
        .where(and(
          eq(registrationItems.campDateId, config.campDateId),
          eq(registrationItems.productType, normalizedType)
        ));
      const regIds = [...new Set(items.map(i => i.registrationId))];
      if (!regIds.length) return [];
      const regs = await db.select({ contactId: registrations.contactId })
        .from(registrations)
        .where(and(inArray(registrations.id, regIds), eq(registrations.status, 'confirmed')));
      const contactIds = [...new Set(regs.map(r => r.contactId))];
      if (!contactIds.length) return [];
      const rows = await db.select({ email: contacts.email }).from(contacts)
        .where(and(inArray(contacts.id, contactIds), sql`${contacts.email} IS NOT NULL AND ${contacts.email} != ''`));
      return [...new Set(rows.map(r => r.email!).filter(Boolean))];
    }

    if (segmentType === 'custom' && config.emails) {
      return config.emails;
    }

    return [];
  }

  async getFacilities(orgId: number): Promise<Facility[]> {
    return db.select().from(facilities).where(eq(facilities.organizationId, orgId)).orderBy(asc(facilities.name));
  }

  async getFacility(id: number): Promise<Facility | undefined> {
    const [f] = await db.select().from(facilities).where(eq(facilities.id, id));
    return f;
  }

  async createFacility(data: InsertFacility): Promise<Facility> {
    const [f] = await db.insert(facilities).values(data).returning();
    return f;
  }

  async updateFacility(id: number, data: Partial<InsertFacility>): Promise<Facility | undefined> {
    const [f] = await db.update(facilities).set(data).where(eq(facilities.id, id)).returning();
    return f;
  }

  async deleteFacility(id: number): Promise<void> {
    await db.delete(facilities).where(eq(facilities.id, id));
  }

  async getFacilityPricingRules(facilityId: number): Promise<FacilityPricingRule[]> {
    return db.select().from(facilityPricingRules).where(eq(facilityPricingRules.facilityId, facilityId));
  }

  async getFacilityPricingRule(id: number): Promise<FacilityPricingRule | undefined> {
    const [r] = await db.select().from(facilityPricingRules).where(eq(facilityPricingRules.id, id));
    return r;
  }

  async createFacilityPricingRule(data: InsertFacilityPricingRule): Promise<FacilityPricingRule> {
    const [r] = await db.insert(facilityPricingRules).values(data).returning();
    return r;
  }

  async deleteFacilityPricingRule(id: number): Promise<void> {
    await db.delete(facilityPricingRules).where(eq(facilityPricingRules.id, id));
  }

  async getFacilityBookings(orgId: number): Promise<(FacilityBooking & { facility?: Facility })[]> {
    const rows = await db.select({
      booking: facilityBookings,
      facility: facilities,
    }).from(facilityBookings)
      .leftJoin(facilities, eq(facilityBookings.facilityId, facilities.id))
      .where(eq(facilityBookings.organizationId, orgId))
      .orderBy(desc(facilityBookings.createdAt));
    return rows.map(r => ({ ...r.booking, facility: r.facility || undefined }));
  }

  async getFacilityBooking(id: number): Promise<FacilityBooking | undefined> {
    const [b] = await db.select().from(facilityBookings).where(eq(facilityBookings.id, id));
    return b;
  }

  async createFacilityBooking(data: InsertFacilityBooking): Promise<FacilityBooking> {
    const [b] = await db.insert(facilityBookings).values(data).returning();
    return b;
  }

  async updateFacilityBooking(id: number, data: Partial<InsertFacilityBooking>): Promise<FacilityBooking | undefined> {
    const [b] = await db.update(facilityBookings).set(data).where(eq(facilityBookings.id, id)).returning();
    return b;
  }

  async deleteFacilityBooking(id: number): Promise<void> {
    await db.delete(facilityBookings).where(eq(facilityBookings.id, id));
  }

  async getFacilityAddons(orgId: number): Promise<FacilityAddon[]> {
    return db.select().from(facilityAddons).where(eq(facilityAddons.organizationId, orgId)).orderBy(asc(facilityAddons.name));
  }

  async getFacilityAddon(id: number): Promise<FacilityAddon | undefined> {
    const [a] = await db.select().from(facilityAddons).where(eq(facilityAddons.id, id));
    return a;
  }

  async createFacilityAddon(data: InsertFacilityAddon): Promise<FacilityAddon> {
    const [a] = await db.insert(facilityAddons).values(data).returning();
    return a;
  }

  async updateFacilityAddon(id: number, data: Partial<InsertFacilityAddon>): Promise<FacilityAddon | undefined> {
    const [a] = await db.update(facilityAddons).set(data).where(eq(facilityAddons.id, id)).returning();
    return a;
  }

  async deleteFacilityAddon(id: number): Promise<void> {
    await db.delete(facilityAddons).where(eq(facilityAddons.id, id));
  }

  async getVenueSettings(orgId: number): Promise<VenueSettings | undefined> {
    const [s] = await db.select().from(venueSettings).where(eq(venueSettings.organizationId, orgId));
    return s;
  }

  async upsertVenueSettings(orgId: number, data: Partial<InsertVenueSettings>): Promise<VenueSettings> {
    const existing = await this.getVenueSettings(orgId);
    if (existing) {
      const [s] = await db.update(venueSettings)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(venueSettings.organizationId, orgId))
        .returning();
      return s;
    }
    const [s] = await db.insert(venueSettings)
      .values({ ...data, organizationId: orgId } as InsertVenueSettings)
      .returning();
    return s;
  }

  async getPublicFacilities(orgId: number): Promise<(Facility & { addons: FacilityAddon[]; pricingRules: FacilityPricingRule[] })[]> {
    const facs = await db.select().from(facilities)
      .where(and(eq(facilities.organizationId, orgId), eq(facilities.active, true), eq(facilities.publicVisible, true)))
      .orderBy(asc(facilities.displayOrder), asc(facilities.name));
    if (facs.length === 0) return [];
    const facIds = facs.map(f => f.id);
    const allRules = await db.select().from(facilityPricingRules).where(inArray(facilityPricingRules.facilityId, facIds));
    const allAddons = await db.select().from(facilityAddons)
      .where(and(eq(facilityAddons.organizationId, orgId), eq(facilityAddons.active, true)));
    return facs.map(f => ({
      ...f,
      pricingRules: allRules.filter(r => r.facilityId === f.id),
      addons: allAddons.filter(a => a.appliesToAll),
    }));
  }

  async getFacilityBookingsForDates(facilityId: number, dates: string[]): Promise<FacilityBooking[]> {
    if (dates.length === 0) return [];
    return db.select().from(facilityBookings)
      .where(and(
        eq(facilityBookings.facilityId, facilityId),
        inArray(facilityBookings.bookingDate, dates),
        inArray(facilityBookings.status, ["pending", "confirmed", "paid"]),
      ));
  }

  // Returns ids of pending bookings older than the cutoff (used by the abandoned-cart sweeper)
  async getStalePendingFacilityBookings(olderThanMinutes: number): Promise<FacilityBooking[]> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    return db.select().from(facilityBookings)
      .where(and(
        eq(facilityBookings.status, "pending"),
        sql`${facilityBookings.createdAt} < ${cutoff}`,
      ));
  }

  async createFacilityBookingDrafts(items: InsertFacilityBooking[]): Promise<FacilityBooking[]> {
    if (items.length === 0) return [];
    return db.insert(facilityBookings).values(items).returning();
  }

  async confirmFacilityBookingsByPaymentIntent(paymentIntentId: string): Promise<FacilityBooking[]> {
    // Idempotent: only flip pending → paid; later duplicate webhook deliveries return 0 rows
    return db.update(facilityBookings)
      .set({ status: "paid", paidAt: new Date() })
      .where(and(
        eq(facilityBookings.stripePaymentIntentId, paymentIntentId),
        eq(facilityBookings.status, "pending"),
      ))
      .returning();
  }

  async cancelPendingFacilityBookingsByGroup(groupId: string): Promise<FacilityBooking[]> {
    // Only cancel rows that are still pending — never override a paid/confirmed booking
    return db.update(facilityBookings)
      .set({ status: "cancelled" })
      .where(and(
        eq(facilityBookings.bookingGroupId, groupId),
        eq(facilityBookings.status, "pending"),
      ))
      .returning();
  }

  async cancelFacilityBookingsByGroup(groupId: string): Promise<void> {
    // Used by the payment_intent.payment_failed webhook to fully cancel a group
    await db.update(facilityBookings)
      .set({ status: "cancelled" })
      .where(and(
        eq(facilityBookings.bookingGroupId, groupId),
        eq(facilityBookings.status, "pending"),
      ));
  }

  async getLeagueCompetitions(orgId: number): Promise<LeagueCompetition[]> {
    return db.select().from(leagueCompetitions).where(eq(leagueCompetitions.organizationId, orgId)).orderBy(desc(leagueCompetitions.createdAt));
  }

  async getLeagueCompetition(id: number): Promise<LeagueCompetition | undefined> {
    const [c] = await db.select().from(leagueCompetitions).where(eq(leagueCompetitions.id, id));
    return c;
  }

  async createLeagueCompetition(data: InsertLeagueCompetition): Promise<LeagueCompetition> {
    const [c] = await db.insert(leagueCompetitions).values(data).returning();
    return c;
  }

  async updateLeagueCompetition(id: number, data: Partial<InsertLeagueCompetition>): Promise<LeagueCompetition | undefined> {
    const [c] = await db.update(leagueCompetitions).set(data).where(eq(leagueCompetitions.id, id)).returning();
    return c;
  }

  async deleteLeagueCompetition(id: number): Promise<void> {
    await db.delete(leagueCompetitions).where(eq(leagueCompetitions.id, id));
  }

  async getLeagueDivisions(competitionId: number): Promise<LeagueDivision[]> {
    return db.select().from(leagueDivisions).where(eq(leagueDivisions.competitionId, competitionId)).orderBy(asc(leagueDivisions.sortOrder));
  }

  async getLeagueDivision(id: number): Promise<LeagueDivision | undefined> {
    const [d] = await db.select().from(leagueDivisions).where(eq(leagueDivisions.id, id));
    return d;
  }

  async createLeagueDivision(data: InsertLeagueDivision): Promise<LeagueDivision> {
    const [d] = await db.insert(leagueDivisions).values(data).returning();
    return d;
  }

  async updateLeagueDivision(id: number, data: Partial<InsertLeagueDivision>): Promise<LeagueDivision | undefined> {
    const [d] = await db.update(leagueDivisions).set(data).where(eq(leagueDivisions.id, id)).returning();
    return d;
  }

  async deleteLeagueDivision(id: number): Promise<void> {
    await db.delete(leagueDivisions).where(eq(leagueDivisions.id, id));
  }

  async getLeagueTeams(orgId: number, competitionId?: number): Promise<(LeagueTeam & { division?: LeagueDivision })[]> {
    const conditions = [eq(leagueTeams.organizationId, orgId)];
    if (competitionId) conditions.push(eq(leagueTeams.competitionId, competitionId));
    const rows = await db.select({
      team: leagueTeams,
      division: leagueDivisions,
    }).from(leagueTeams)
      .leftJoin(leagueDivisions, eq(leagueTeams.divisionId, leagueDivisions.id))
      .where(and(...conditions))
      .orderBy(asc(leagueTeams.name));
    return rows.map(r => ({ ...r.team, division: r.division || undefined }));
  }

  async getLeagueTeam(id: number): Promise<LeagueTeam | undefined> {
    const [t] = await db.select().from(leagueTeams).where(eq(leagueTeams.id, id));
    return t;
  }

  async createLeagueTeam(data: InsertLeagueTeam): Promise<LeagueTeam> {
    const [t] = await db.insert(leagueTeams).values(data).returning();
    return t;
  }

  async updateLeagueTeam(id: number, data: Partial<InsertLeagueTeam>): Promise<LeagueTeam | undefined> {
    const [t] = await db.update(leagueTeams).set(data).where(eq(leagueTeams.id, id)).returning();
    return t;
  }

  async deleteLeagueTeam(id: number): Promise<void> {
    await db.delete(leagueTeams).where(eq(leagueTeams.id, id));
  }

  async getLeagueGames(competitionId: number): Promise<(LeagueGame & { homeTeam?: LeagueTeam; awayTeam?: LeagueTeam; division?: LeagueDivision })[]> {
    const allGames = await db.select().from(leagueGames).where(eq(leagueGames.competitionId, competitionId)).orderBy(asc(leagueGames.gameDate), asc(leagueGames.startTime));
    if (allGames.length === 0) return [];
    const teamIds = [...new Set(allGames.flatMap(g => [g.homeTeamId, g.awayTeamId]).filter(Boolean))] as number[];
    const divIds = [...new Set(allGames.map(g => g.divisionId).filter(Boolean))] as number[];
    const teams = teamIds.length > 0 ? await db.select().from(leagueTeams).where(inArray(leagueTeams.id, teamIds)) : [];
    const divs = divIds.length > 0 ? await db.select().from(leagueDivisions).where(inArray(leagueDivisions.id, divIds)) : [];
    const teamMap = Object.fromEntries(teams.map(t => [t.id, t]));
    const divMap = Object.fromEntries(divs.map(d => [d.id, d]));
    return allGames.map(g => ({
      ...g,
      homeTeam: g.homeTeamId ? teamMap[g.homeTeamId] : undefined,
      awayTeam: g.awayTeamId ? teamMap[g.awayTeamId] : undefined,
      division: g.divisionId ? divMap[g.divisionId] : undefined,
    }));
  }

  async getLeagueGame(id: number): Promise<LeagueGame | undefined> {
    const [g] = await db.select().from(leagueGames).where(eq(leagueGames.id, id));
    return g;
  }

  async createLeagueGame(data: InsertLeagueGame): Promise<LeagueGame> {
    const [g] = await db.insert(leagueGames).values(data).returning();
    return g;
  }

  async updateLeagueGame(id: number, data: Partial<InsertLeagueGame>): Promise<LeagueGame | undefined> {
    const [g] = await db.update(leagueGames).set(data).where(eq(leagueGames.id, id)).returning();
    return g;
  }

  async deleteLeagueGame(id: number): Promise<void> {
    await db.delete(leagueGames).where(eq(leagueGames.id, id));
  }

  // The sellable 'league_team' program that wraps a competition's public
  // registration page (deposit/early-bird/upsells live here). One per comp.
  async getLeagueRegistrationProgram(competitionId: number): Promise<Program | undefined> {
    const [p] = await db.select().from(programs)
      .where(and(eq(programs.leagueCompetitionId, competitionId), eq(programs.type, "league_team")));
    return p;
  }

  // Paid/in-progress team registrations for a competition, enriched with the
  // captain contact, division name and team payment status — for the admin
  // Registrations view.
  async getLeagueRegistrations(competitionId: number): Promise<any[]> {
    const progs = await db.select().from(programs)
      .where(and(eq(programs.leagueCompetitionId, competitionId), eq(programs.type, "league_team")));
    const progIds = progs.map(p => p.id);
    if (progIds.length === 0) return [];

    const rows = await db.select({ reg: registrations, captain: contacts, division: leagueDivisions })
      .from(registrations)
      .leftJoin(contacts, eq(registrations.contactId, contacts.id))
      .leftJoin(leagueDivisions, eq(registrations.leagueDivisionId, leagueDivisions.id))
      // Real registrations only — exclude abandoned 'pending' carts and cancelled.
      .where(and(
        inArray(registrations.programId, progIds),
        inArray(registrations.status, ["confirmed", "refunded", "partially_refunded", "waitlisted"]),
      ))
      .orderBy(desc(registrations.registeredAt));

    const regIds = rows.map(r => r.reg.id);
    const teams = regIds.length
      ? await db.select().from(leagueTeams).where(inArray(leagueTeams.registrationId, regIds))
      : [];
    const teamByReg = new Map(teams.map(t => [t.registrationId, t]));

    return rows.map(r => ({
      id: r.reg.id,
      teamName: r.reg.teamName,
      status: r.reg.status,
      divisionName: r.division?.name ?? null,
      captainName: r.captain ? `${r.captain.firstName} ${r.captain.lastName}` : "",
      captainEmail: r.captain?.email ?? null,
      captainPhone: r.captain?.phone ?? null,
      totalCents: r.reg.totalCents,
      amountPaid: r.reg.amountPaid,
      paymentMode: r.reg.paymentMode,
      depositCents: r.reg.depositCents,
      balanceCents: r.reg.balanceCents,
      balanceDueDate: r.reg.balanceDueDate,
      balanceStatus: r.reg.balanceStatus,
      paymentStatus: teamByReg.get(r.reg.id)?.paymentStatus ?? (
        r.reg.status === "confirmed" ? "deposit_paid"
        : (r.reg.status === "refunded" || r.reg.status === "partially_refunded") ? r.reg.status
        : "unpaid"
      ),
      registeredAt: r.reg.registeredAt,
    }));
  }

  async getLeagueCoupons(competitionId: number): Promise<LeagueCoupon[]> {
    return db.select().from(leagueCoupons).where(eq(leagueCoupons.competitionId, competitionId)).orderBy(desc(leagueCoupons.createdAt));
  }

  async createLeagueCoupon(data: InsertLeagueCoupon): Promise<LeagueCoupon> {
    const [c] = await db.insert(leagueCoupons).values(data).returning();
    return c;
  }

  async updateLeagueCoupon(id: number, data: Partial<InsertLeagueCoupon>): Promise<LeagueCoupon | undefined> {
    const [c] = await db.update(leagueCoupons).set(data).where(eq(leagueCoupons.id, id)).returning();
    return c;
  }

  async deleteLeagueCoupon(id: number): Promise<void> {
    await db.delete(leagueCoupons).where(eq(leagueCoupons.id, id));
  }

  async getLeagueStandings(competitionId: number, divisionId?: number): Promise<{ teamId: number; teamName: string; divisionId: number | null; divisionName: string; mp: number; w: number; l: number; d: number; gf: number; ga: number; gd: number; pts: number }[]> {
    const conditions = [eq(leagueGames.competitionId, competitionId), eq(leagueGames.status, "final")];
    if (divisionId) conditions.push(eq(leagueGames.divisionId, divisionId));
    const games = await db.select().from(leagueGames).where(and(...conditions));
    const teamIds = [...new Set(games.flatMap(g => [g.homeTeamId, g.awayTeamId]).filter(Boolean))] as number[];
    if (teamIds.length === 0) return [];
    const teams = await db.select().from(leagueTeams).where(inArray(leagueTeams.id, teamIds));
    const divIds = [...new Set(teams.map(t => t.divisionId).filter(Boolean))] as number[];
    const divs = divIds.length > 0 ? await db.select().from(leagueDivisions).where(inArray(leagueDivisions.id, divIds)) : [];
    const divMap = Object.fromEntries(divs.map(d => [d.id, d.name]));
    const stats: Record<number, { mp: number; w: number; l: number; d: number; gf: number; ga: number }> = {};
    for (const t of teams) stats[t.id] = { mp: 0, w: 0, l: 0, d: 0, gf: 0, ga: 0 };
    for (const g of games) {
      if (g.homeTeamId && stats[g.homeTeamId] && g.homeScore !== null && g.awayScore !== null) {
        stats[g.homeTeamId].mp++;
        stats[g.homeTeamId].gf += g.homeScore;
        stats[g.homeTeamId].ga += g.awayScore;
        if (g.homeScore > g.awayScore) stats[g.homeTeamId].w++;
        else if (g.homeScore < g.awayScore) stats[g.homeTeamId].l++;
        else stats[g.homeTeamId].d++;
      }
      if (g.awayTeamId && stats[g.awayTeamId] && g.homeScore !== null && g.awayScore !== null) {
        stats[g.awayTeamId].mp++;
        stats[g.awayTeamId].gf += g.awayScore;
        stats[g.awayTeamId].ga += g.homeScore;
        if (g.awayScore > g.homeScore) stats[g.awayTeamId].w++;
        else if (g.awayScore < g.homeScore) stats[g.awayTeamId].l++;
        else stats[g.awayTeamId].d++;
      }
    }
    return teams.map(t => {
      const s = stats[t.id] || { mp: 0, w: 0, l: 0, d: 0, gf: 0, ga: 0 };
      return {
        teamId: t.id,
        teamName: t.name,
        divisionId: t.divisionId,
        divisionName: t.divisionId ? (divMap[t.divisionId] || "Unknown") : "Unassigned",
        mp: s.mp, w: s.w, l: s.l, d: s.d,
        gf: s.gf, ga: s.ga, gd: s.gf - s.ga,
        pts: s.w * 3 + s.d,
      };
    }).sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
  }

  async getClubs(orgId: number): Promise<Club[]> {
    return db.select().from(clubs).where(eq(clubs.organizationId, orgId)).orderBy(asc(clubs.name));
  }

  async getClub(id: number): Promise<Club | undefined> {
    const [c] = await db.select().from(clubs).where(eq(clubs.id, id));
    return c;
  }

  async createClub(data: InsertClub): Promise<Club> {
    const [c] = await db.insert(clubs).values(data).returning();
    return c;
  }

  async updateClub(id: number, data: Partial<InsertClub>): Promise<Club | undefined> {
    const [c] = await db.update(clubs).set(data).where(eq(clubs.id, id)).returning();
    return c;
  }

  async deleteClub(id: number): Promise<void> {
    await db.delete(clubs).where(eq(clubs.id, id));
  }

  async getClubTeams(clubId: number): Promise<TournamentTeam[]> {
    return db.select().from(tournamentTeams).where(eq(tournamentTeams.clubId, clubId));
  }

  async getTerms(orgId: number): Promise<Term[]> {
    return db.select().from(terms).where(eq(terms.organizationId, orgId)).orderBy(desc(terms.year), asc(terms.termNumber));
  }

  async createTerm(data: InsertTerm): Promise<Term> {
    const [t] = await db.insert(terms).values(data).returning();
    return t;
  }

  async updateTerm(id: number, data: Partial<InsertTerm>): Promise<Term | undefined> {
    const [t] = await db.update(terms).set(data).where(eq(terms.id, id)).returning();
    return t;
  }

  async deleteTerm(id: number): Promise<void> {
    await db.delete(terms).where(eq(terms.id, id));
  }

  async getTournaments(orgId: number): Promise<Tournament[]> {
    return db.select().from(tournaments).where(eq(tournaments.organizationId, orgId)).orderBy(desc(tournaments.createdAt));
  }

  async getTournament(id: number): Promise<Tournament | undefined> {
    const [t] = await db.select().from(tournaments).where(eq(tournaments.id, id));
    return t;
  }

  async createTournament(data: InsertTournament): Promise<Tournament> {
    const [t] = await db.insert(tournaments).values(data).returning();
    return t;
  }

  async updateTournament(id: number, data: Partial<InsertTournament>): Promise<Tournament | undefined> {
    const [t] = await db.update(tournaments).set(data).where(eq(tournaments.id, id)).returning();
    return t;
  }

  async deleteTournament(id: number): Promise<void> {
    await db.delete(tournaments).where(eq(tournaments.id, id));
  }

  async getTournamentGroups(tournamentId: number): Promise<TournamentGroup[]> {
    return db.select().from(tournamentGroups).where(eq(tournamentGroups.tournamentId, tournamentId)).orderBy(asc(tournamentGroups.sortOrder));
  }

  async createTournamentGroup(data: InsertTournamentGroup): Promise<TournamentGroup> {
    const [g] = await db.insert(tournamentGroups).values(data).returning();
    return g;
  }

  async updateTournamentGroup(id: number, data: Partial<InsertTournamentGroup>): Promise<TournamentGroup | undefined> {
    const [g] = await db.update(tournamentGroups).set(data).where(eq(tournamentGroups.id, id)).returning();
    return g;
  }

  async deleteTournamentGroup(id: number): Promise<void> {
    await db.delete(tournamentGroups).where(eq(tournamentGroups.id, id));
  }

  async getTournamentTeams(tournamentId: number): Promise<(TournamentTeam & { group?: TournamentGroup })[]> {
    const rows = await db.select({ team: tournamentTeams, group: tournamentGroups }).from(tournamentTeams)
      .leftJoin(tournamentGroups, eq(tournamentTeams.groupId, tournamentGroups.id))
      .where(eq(tournamentTeams.tournamentId, tournamentId))
      .orderBy(asc(tournamentTeams.name));
    return rows.map(r => ({ ...r.team, group: r.group || undefined }));
  }

  async getTournamentTeam(id: number): Promise<TournamentTeam | undefined> {
    const [t] = await db.select().from(tournamentTeams).where(eq(tournamentTeams.id, id));
    return t;
  }

  async createTournamentTeam(data: InsertTournamentTeam): Promise<TournamentTeam> {
    const [t] = await db.insert(tournamentTeams).values(data).returning();
    return t;
  }

  async updateTournamentTeam(id: number, data: Partial<InsertTournamentTeam>): Promise<TournamentTeam | undefined> {
    const [t] = await db.update(tournamentTeams).set(data).where(eq(tournamentTeams.id, id)).returning();
    return t;
  }

  async deleteTournamentTeam(id: number): Promise<void> {
    await db.delete(tournamentTeams).where(eq(tournamentTeams.id, id));
  }

  async getTournamentPlayers(teamId: number): Promise<TournamentPlayer[]> {
    return db.select().from(tournamentPlayers).where(eq(tournamentPlayers.teamId, teamId)).orderBy(asc(tournamentPlayers.shirtNumber));
  }

  async getTournamentPlayer(id: number): Promise<TournamentPlayer | undefined> {
    const [p] = await db.select().from(tournamentPlayers).where(eq(tournamentPlayers.id, id));
    return p;
  }

  async createTournamentPlayer(data: InsertTournamentPlayer): Promise<TournamentPlayer> {
    const [p] = await db.insert(tournamentPlayers).values(data).returning();
    return p;
  }

  async updateTournamentPlayer(id: number, data: Partial<InsertTournamentPlayer>): Promise<TournamentPlayer | undefined> {
    const [p] = await db.update(tournamentPlayers).set(data).where(eq(tournamentPlayers.id, id)).returning();
    return p;
  }

  async deleteTournamentPlayer(id: number): Promise<void> {
    await db.delete(tournamentPlayers).where(eq(tournamentPlayers.id, id));
  }

  async getTournamentGoalsByGame(gameId: number): Promise<TournamentGoal[]> {
    return db.select().from(tournamentGoals).where(eq(tournamentGoals.gameId, gameId)).orderBy(asc(tournamentGoals.minute));
  }

  async createTournamentGoal(data: InsertTournamentGoal): Promise<TournamentGoal> {
    const [g] = await db.insert(tournamentGoals).values(data).returning();
    return g;
  }

  async deleteTournamentGoal(id: number): Promise<void> {
    await db.delete(tournamentGoals).where(eq(tournamentGoals.id, id));
  }

  async getTournamentTopScorers(tournamentId: number): Promise<{
    playerId: number; playerName: string; shirtNumber: number | null;
    teamId: number; teamName: string; teamLogoUrl: string | null;
    goals: number;
  }[]> {
    // Aggregate goals per player for one tournament. Own goals don't count
    // toward the scorer's tally — that's the convention for "golden boot"
    // listings everywhere. Joins through games to filter by tournament.
    const rows = await db.execute(sql`
      SELECT
        p.id          AS player_id,
        (p.first_name || ' ' || p.last_name) AS player_name,
        p.shirt_number AS shirt_number,
        t.id          AS team_id,
        t.name        AS team_name,
        COALESCE(t.logo_url, c.logo_url) AS team_logo_url,
        COUNT(*)::int AS goals
      FROM tournament_goals g
      JOIN tournament_games games ON games.id = g.game_id
      JOIN tournament_players p   ON p.id = g.player_id
      JOIN tournament_teams t     ON t.id = g.team_id
      LEFT JOIN clubs c           ON c.id = t.club_id
      WHERE games.tournament_id = ${tournamentId}
        AND g.is_own_goal = FALSE
      GROUP BY p.id, p.first_name, p.last_name, p.shirt_number,
               t.id, t.name, t.logo_url, c.logo_url
      ORDER BY goals DESC, p.last_name ASC, p.first_name ASC
    `);
    return (rows as any).rows.map((r: any) => ({
      playerId: r.player_id,
      playerName: r.player_name,
      shirtNumber: r.shirt_number,
      teamId: r.team_id,
      teamName: r.team_name,
      teamLogoUrl: r.team_logo_url,
      goals: r.goals,
    }));
  }

  async getTournamentStaff(teamId: number): Promise<TournamentStaff[]> {
    return db.select().from(tournamentStaff).where(eq(tournamentStaff.teamId, teamId)).orderBy(asc(tournamentStaff.role));
  }

  async createTournamentStaff(data: InsertTournamentStaff): Promise<TournamentStaff> {
    const [s] = await db.insert(tournamentStaff).values(data).returning();
    return s;
  }

  async updateTournamentStaff(id: number, data: Partial<InsertTournamentStaff>): Promise<TournamentStaff | undefined> {
    const [s] = await db.update(tournamentStaff).set(data).where(eq(tournamentStaff.id, id)).returning();
    return s;
  }

  async deleteTournamentStaff(id: number): Promise<void> {
    await db.delete(tournamentStaff).where(eq(tournamentStaff.id, id));
  }

  async getTournamentGames(tournamentId: number): Promise<(TournamentGame & { homeTeam?: TournamentTeam; awayTeam?: TournamentTeam; group?: TournamentGroup })[]> {
    const allGames = await db.select().from(tournamentGames).where(eq(tournamentGames.tournamentId, tournamentId)).orderBy(asc(tournamentGames.gameNumber));
    if (allGames.length === 0) return [];
    const teamIds = [...new Set(allGames.flatMap(g => [g.homeTeamId, g.awayTeamId]).filter(Boolean))] as number[];
    const groupIds = [...new Set(allGames.map(g => g.groupId).filter(Boolean))] as number[];
    const teams = teamIds.length > 0 ? await db.select().from(tournamentTeams).where(inArray(tournamentTeams.id, teamIds)) : [];
    const groups = groupIds.length > 0 ? await db.select().from(tournamentGroups).where(inArray(tournamentGroups.id, groupIds)) : [];
    const teamMap = Object.fromEntries(teams.map(t => [t.id, t]));
    const groupMap = Object.fromEntries(groups.map(g => [g.id, g]));
    return allGames.map(g => ({
      ...g,
      homeTeam: g.homeTeamId ? teamMap[g.homeTeamId] : undefined,
      awayTeam: g.awayTeamId ? teamMap[g.awayTeamId] : undefined,
      group: g.groupId ? groupMap[g.groupId] : undefined,
    }));
  }

  async getTournamentGame(id: number): Promise<TournamentGame | undefined> {
    const [g] = await db.select().from(tournamentGames).where(eq(tournamentGames.id, id));
    return g;
  }

  async createTournamentGame(data: InsertTournamentGame): Promise<TournamentGame> {
    const [g] = await db.insert(tournamentGames).values(data).returning();
    return g;
  }

  async updateTournamentGame(id: number, data: Partial<InsertTournamentGame>): Promise<TournamentGame | undefined> {
    const [g] = await db.update(tournamentGames).set(data).where(eq(tournamentGames.id, id)).returning();
    return g;
  }

  async deleteTournamentGame(id: number): Promise<void> {
    await db.delete(tournamentGames).where(eq(tournamentGames.id, id));
  }

  async getTournamentGroupStandings(tournamentId: number): Promise<{ teamId: number; teamName: string; groupId: number | null; groupName: string; mp: number; w: number; l: number; d: number; gf: number; ga: number; gd: number; pts: number }[]> {
    const tournament = await this.getTournament(tournamentId);
    const ptsWin = tournament?.pointsForWin ?? 3;
    const ptsDraw = tournament?.pointsForDraw ?? 1;
    const games = await db.select().from(tournamentGames).where(and(eq(tournamentGames.tournamentId, tournamentId), eq(tournamentGames.stage, "group"), eq(tournamentGames.status, "final")));
    const teamIds = [...new Set(games.flatMap(g => [g.homeTeamId, g.awayTeamId]).filter(Boolean))] as number[];
    if (teamIds.length === 0) {
      const allTeams = await this.getTournamentTeams(tournamentId);
      const groups = await this.getTournamentGroups(tournamentId);
      const groupMap = Object.fromEntries(groups.map(g => [g.id, g.name]));
      return allTeams.map(t => ({
        teamId: t.id, teamName: t.name, groupId: t.groupId, groupName: t.groupId ? (groupMap[t.groupId] || "Unassigned") : "Unassigned",
        mp: 0, w: 0, l: 0, d: 0, gf: 0, ga: 0, gd: 0, pts: 0,
      }));
    }
    const teams = await db.select().from(tournamentTeams).where(inArray(tournamentTeams.id, teamIds));
    const groupIds = [...new Set(teams.map(t => t.groupId).filter(Boolean))] as number[];
    const groups = groupIds.length > 0 ? await db.select().from(tournamentGroups).where(inArray(tournamentGroups.id, groupIds)) : [];
    const groupMap = Object.fromEntries(groups.map(g => [g.id, g.name]));
    const stats: Record<number, { mp: number; w: number; l: number; d: number; gf: number; ga: number }> = {};
    for (const t of teams) stats[t.id] = { mp: 0, w: 0, l: 0, d: 0, gf: 0, ga: 0 };
    for (const g of games) {
      if (g.homeTeamId && stats[g.homeTeamId] && g.homeScore !== null && g.awayScore !== null) {
        stats[g.homeTeamId].mp++;
        stats[g.homeTeamId].gf += g.homeScore;
        stats[g.homeTeamId].ga += g.awayScore;
        if (g.homeScore > g.awayScore) stats[g.homeTeamId].w++;
        else if (g.homeScore < g.awayScore) stats[g.homeTeamId].l++;
        else stats[g.homeTeamId].d++;
      }
      if (g.awayTeamId && stats[g.awayTeamId] && g.homeScore !== null && g.awayScore !== null) {
        stats[g.awayTeamId].mp++;
        stats[g.awayTeamId].gf += g.awayScore;
        stats[g.awayTeamId].ga += g.homeScore;
        if (g.awayScore > g.homeScore) stats[g.awayTeamId].w++;
        else if (g.awayScore < g.homeScore) stats[g.awayTeamId].l++;
        else stats[g.awayTeamId].d++;
      }
    }
    return teams.map(t => {
      const s = stats[t.id] || { mp: 0, w: 0, l: 0, d: 0, gf: 0, ga: 0 };
      return {
        teamId: t.id, teamName: t.name, groupId: t.groupId,
        groupName: t.groupId ? (groupMap[t.groupId] || "Unknown") : "Unassigned",
        mp: s.mp, w: s.w, l: s.l, d: s.d, gf: s.gf, ga: s.ga, gd: s.gf - s.ga,
        pts: s.w * ptsWin + s.d * ptsDraw,
      };
    }).sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
  }
  async getDiscountsByOrg(organizationId: number): Promise<Discount[]> {
    return db.select().from(discounts).where(eq(discounts.organizationId, organizationId)).orderBy(desc(discounts.createdAt));
  }

  async getDiscount(id: number): Promise<Discount | undefined> {
    const [d] = await db.select().from(discounts).where(eq(discounts.id, id));
    return d;
  }

  async createDiscount(data: InsertDiscount2): Promise<Discount> {
    const [d] = await db.insert(discounts).values(data).returning();
    return d;
  }

  async updateDiscount(id: number, data: Partial<InsertDiscount2>): Promise<Discount | undefined> {
    const [d] = await db.update(discounts).set({ ...data, updatedAt: new Date() }).where(eq(discounts.id, id)).returning();
    return d;
  }

  async getCustomDomainsByOrg(organizationId: number): Promise<CustomDomain[]> {
    return db.select().from(customDomains).where(eq(customDomains.organizationId, organizationId)).orderBy(desc(customDomains.createdAt));
  }

  async getCustomDomainByHostname(hostname: string): Promise<CustomDomain | undefined> {
    const [d] = await db.select().from(customDomains).where(eq(customDomains.domain, hostname.toLowerCase()));
    return d;
  }

  async createCustomDomain(data: InsertCustomDomain): Promise<CustomDomain> {
    const [d] = await db.insert(customDomains).values({ ...data, domain: data.domain.toLowerCase() }).returning();
    return d;
  }

  async updateCustomDomain(id: number, data: Partial<InsertCustomDomain>): Promise<CustomDomain | undefined> {
    const [d] = await db.update(customDomains).set(data).where(eq(customDomains.id, id)).returning();
    return d;
  }

  async deleteCustomDomain(id: number): Promise<void> {
    await db.delete(customDomains).where(eq(customDomains.id, id));
  }

  async getDiscountByCode(code: string, organizationId: number): Promise<Discount | undefined> {
    const [d] = await db.select().from(discounts)
      .where(and(
        sql`lower(${discounts.code}) = lower(${code})`,
        eq(discounts.organizationId, organizationId)
      ));
    return d;
  }

  async deleteDiscount(id: number): Promise<void> {
    await db.delete(discounts).where(eq(discounts.id, id));
  }

  async incrementDiscountUsage(id: number, discountedCents: number): Promise<void> {
    await db.update(discounts).set({
      timesUsed: sql`${discounts.timesUsed} + 1`,
      totalDiscountedCents: sql`${discounts.totalDiscountedCents} + ${discountedCents}`,
      updatedAt: new Date(),
    }).where(eq(discounts.id, id));
  }

  async getCalendarEvents(filters: { organizationId?: number; startDate?: Date; endDate?: Date; calendarType?: string }): Promise<CalendarEvent[]> {
    const conditions = [];
    if (filters.organizationId) conditions.push(eq(calendarEvents.organizationId, filters.organizationId));
    if (filters.calendarType) conditions.push(eq(calendarEvents.calendarType, filters.calendarType));
    if (filters.startDate) conditions.push(sql`${calendarEvents.endTime} >= ${filters.startDate}`);
    if (filters.endDate) conditions.push(sql`${calendarEvents.startTime} <= ${filters.endDate}`);
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    return db.select().from(calendarEvents).where(where).orderBy(asc(calendarEvents.startTime));
  }

  async getCalendarEvent(id: number): Promise<CalendarEvent | undefined> {
    const [event] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id));
    return event;
  }

  async createCalendarEvent(data: InsertCalendarEvent): Promise<CalendarEvent> {
    const [event] = await db.insert(calendarEvents).values(data).returning();
    return event;
  }

  async updateCalendarEvent(id: number, data: Partial<InsertCalendarEvent>): Promise<CalendarEvent | undefined> {
    const [event] = await db.update(calendarEvents).set({ ...data, updatedAt: new Date() }).where(eq(calendarEvents.id, id)).returning();
    return event;
  }

  async deleteCalendarEvent(id: number): Promise<void> {
    await db.delete(calendarEvents).where(eq(calendarEvents.id, id));
  }

  // Calendar categories (sub-calendars). Lazily seeds the 8 historical defaults the first
  // time an org's list is requested, so existing workspaces continue to behave identically.
  async getCalendarCategories(orgId: number): Promise<CalendarCategory[]> {
    const existing = await db.select().from(calendarCategories)
      .where(eq(calendarCategories.organizationId, orgId))
      .orderBy(asc(calendarCategories.displayOrder), asc(calendarCategories.id));
    if (existing.length > 0) return existing;

    const defaults: Array<Omit<InsertCalendarCategory, "organizationId">> = [
      { slug: "general", label: "General", color: "#3b82f6", displayOrder: 0, isSystem: true },
      { slug: "united", label: "United Events", color: "#6366f1", displayOrder: 1, isSystem: true },
      { slug: "south-island", label: "South Island United", color: "#8b5cf6", displayOrder: 2, isSystem: true },
      { slug: "gymnastics", label: "United Gymnastics", color: "#ec4899", displayOrder: 3, isSystem: true },
      { slug: "payments", label: "Payments & Finance", color: "#f59e0b", displayOrder: 4, isSystem: true },
      { slug: "training", label: "Training", color: "#22c55e", displayOrder: 5, isSystem: true },
      { slug: "meetings", label: "Meetings", color: "#06b6d4", displayOrder: 6, isSystem: true },
      { slug: "personal", label: "Personal", color: "#ef4444", displayOrder: 7, isSystem: true },
    ];
    // Use ON CONFLICT so concurrent first-loads don't crash on the unique constraint.
    await db.insert(calendarCategories)
      .values(defaults.map(d => ({ ...d, organizationId: orgId })))
      .onConflictDoNothing({ target: [calendarCategories.organizationId, calendarCategories.slug] });
    return db.select().from(calendarCategories)
      .where(eq(calendarCategories.organizationId, orgId))
      .orderBy(asc(calendarCategories.displayOrder), asc(calendarCategories.id));
  }

  async getCalendarCategory(id: number): Promise<CalendarCategory | undefined> {
    const [c] = await db.select().from(calendarCategories).where(eq(calendarCategories.id, id));
    return c;
  }

  async createCalendarCategory(data: InsertCalendarCategory): Promise<CalendarCategory> {
    const [c] = await db.insert(calendarCategories).values(data).returning();
    return c;
  }

  async updateCalendarCategory(id: number, data: Partial<InsertCalendarCategory>): Promise<CalendarCategory | undefined> {
    const [c] = await db.update(calendarCategories).set(data).where(eq(calendarCategories.id, id)).returning();
    return c;
  }

  async deleteCalendarCategory(id: number): Promise<void> {
    await db.delete(calendarCategories).where(eq(calendarCategories.id, id));
  }

  // Reassign all events for an org currently using one calendarType slug to another.
  // Used when a category is deleted, so events don't disappear from the sidebar filter.
  async reassignCalendarEvents(orgId: number, fromSlug: string, toSlug: string): Promise<number> {
    const result = await db.update(calendarEvents)
      .set({ calendarType: toSlug, updatedAt: new Date() })
      .where(and(eq(calendarEvents.organizationId, orgId), eq(calendarEvents.calendarType, fromSlug)));
    return (result as any).rowCount ?? 0;
  }

  // Atomic: reassign all events from a category's slug to `toSlug`, then delete the category,
  // inside a single DB transaction so we can never leave events orphaned if one half fails.
  async deleteCalendarCategoryWithReassign(id: number, orgId: number, fromSlug: string, toSlug: string): Promise<number> {
    return await db.transaction(async (tx) => {
      const updated = await tx.update(calendarEvents)
        .set({ calendarType: toSlug, updatedAt: new Date() })
        .where(and(eq(calendarEvents.organizationId, orgId), eq(calendarEvents.calendarType, fromSlug)));
      await tx.delete(calendarCategories).where(eq(calendarCategories.id, id));
      return (updated as any).rowCount ?? 0;
    });
  }

  async getPrintOrdersByOrg(orgId: number): Promise<PrintOrder[]> {
    return db.select().from(printOrders).where(eq(printOrders.organizationId, orgId)).orderBy(desc(printOrders.createdAt));
  }
  async getPrintOrder(id: number): Promise<PrintOrder | undefined> {
    const [r] = await db.select().from(printOrders).where(eq(printOrders.id, id)); return r;
  }
  async createPrintOrder(data: InsertPrintOrder): Promise<PrintOrder> {
    const [r] = await db.insert(printOrders).values(data).returning(); return r;
  }
  async updatePrintOrder(id: number, data: Partial<InsertPrintOrder>): Promise<PrintOrder | undefined> {
    const [r] = await db.update(printOrders).set({ ...data, updatedAt: new Date() }).where(eq(printOrders.id, id)).returning(); return r;
  }
  async deletePrintOrder(id: number): Promise<void> {
    await db.delete(printOrders).where(eq(printOrders.id, id));
  }

  async getPrintProjectsByOrg(orgId: number): Promise<PrintProject[]> {
    return db.select().from(printProjects).where(eq(printProjects.organizationId, orgId)).orderBy(desc(printProjects.createdAt));
  }
  async getPrintProject(id: number): Promise<PrintProject | undefined> {
    const [r] = await db.select().from(printProjects).where(eq(printProjects.id, id)); return r;
  }
  async createPrintProject(data: InsertPrintProject): Promise<PrintProject> {
    const [r] = await db.insert(printProjects).values(data).returning(); return r;
  }
  async updatePrintProject(id: number, data: Partial<InsertPrintProject>): Promise<PrintProject | undefined> {
    const [r] = await db.update(printProjects).set({ ...data, updatedAt: new Date() }).where(eq(printProjects.id, id)).returning(); return r;
  }
  async deletePrintProject(id: number): Promise<void> {
    await db.delete(printProjects).where(eq(printProjects.id, id));
  }

  async getPrintContactsByOrg(orgId: number): Promise<PrintContact[]> {
    return db.select().from(printContacts).where(eq(printContacts.organizationId, orgId)).orderBy(desc(printContacts.createdAt));
  }
  async getPrintContact(id: number): Promise<PrintContact | undefined> {
    const [r] = await db.select().from(printContacts).where(eq(printContacts.id, id)); return r;
  }
  async createPrintContact(data: InsertPrintContact): Promise<PrintContact> {
    const [r] = await db.insert(printContacts).values(data).returning(); return r;
  }
  async updatePrintContact(id: number, data: Partial<InsertPrintContact>): Promise<PrintContact | undefined> {
    const [r] = await db.update(printContacts).set({ ...data, updatedAt: new Date() }).where(eq(printContacts.id, id)).returning(); return r;
  }
  async deletePrintContact(id: number): Promise<void> {
    await db.delete(printContacts).where(eq(printContacts.id, id));
  }

  async getPrintLandingPagesByOrg(orgId: number): Promise<PrintLandingPage[]> {
    return db.select().from(printLandingPages).where(eq(printLandingPages.organizationId, orgId)).orderBy(desc(printLandingPages.createdAt));
  }
  async getPrintLandingPage(id: number): Promise<PrintLandingPage | undefined> {
    const [r] = await db.select().from(printLandingPages).where(eq(printLandingPages.id, id)); return r;
  }
  async createPrintLandingPage(data: InsertPrintLandingPage): Promise<PrintLandingPage> {
    const [r] = await db.insert(printLandingPages).values(data).returning(); return r;
  }
  async updatePrintLandingPage(id: number, data: Partial<InsertPrintLandingPage>): Promise<PrintLandingPage | undefined> {
    const [r] = await db.update(printLandingPages).set({ ...data, updatedAt: new Date() }).where(eq(printLandingPages.id, id)).returning(); return r;
  }
  async deletePrintLandingPage(id: number): Promise<void> {
    await db.delete(printLandingPages).where(eq(printLandingPages.id, id));
  }

  async getPrintEmailsByOrg(orgId: number): Promise<PrintEmail[]> {
    return db.select().from(printEmails).where(eq(printEmails.organizationId, orgId)).orderBy(desc(printEmails.createdAt));
  }
  async createPrintEmail(data: InsertPrintEmail): Promise<PrintEmail> {
    const [r] = await db.insert(printEmails).values(data).returning(); return r;
  }
  async updatePrintEmail(id: number, data: Partial<InsertPrintEmail>): Promise<PrintEmail | undefined> {
    const [r] = await db.update(printEmails).set(data).where(eq(printEmails.id, id)).returning(); return r;
  }

  // Print materials catalog
  async getPrintMaterials(orgId: number, opts: { activeOnly?: boolean } = {}): Promise<PrintMaterial[]> {
    const where = opts.activeOnly
      ? and(eq(printMaterials.organizationId, orgId), eq(printMaterials.isActive, true))
      : eq(printMaterials.organizationId, orgId);
    return db.select().from(printMaterials).where(where).orderBy(asc(printMaterials.displayOrder), asc(printMaterials.id));
  }
  async getPrintMaterial(id: number): Promise<PrintMaterial | undefined> {
    const [m] = await db.select().from(printMaterials).where(eq(printMaterials.id, id));
    return m;
  }
  async getPrintMaterialBySlug(slug: string): Promise<PrintMaterial | undefined> {
    const [m] = await db.select().from(printMaterials).where(eq(printMaterials.slug, slug));
    return m;
  }
  async createPrintMaterial(data: InsertPrintMaterial): Promise<PrintMaterial> {
    const [m] = await db.insert(printMaterials).values(data).returning();
    return m;
  }
  async updatePrintMaterial(id: number, data: Partial<InsertPrintMaterial>): Promise<PrintMaterial | undefined> {
    const [m] = await db.update(printMaterials).set({ ...data, updatedAt: new Date() }).where(eq(printMaterials.id, id)).returning();
    return m;
  }
  async deletePrintMaterial(id: number): Promise<void> {
    await db.delete(printMaterials).where(eq(printMaterials.id, id));
  }

  // Print order items
  async getPrintOrderItems(orderId: number): Promise<PrintOrderItem[]> {
    return db.select().from(printOrderItems).where(eq(printOrderItems.orderId, orderId)).orderBy(asc(printOrderItems.id));
  }
  async createPrintOrderItem(data: InsertPrintOrderItem): Promise<PrintOrderItem> {
    const [r] = await db.insert(printOrderItems).values(data).returning(); return r;
  }
  async deletePrintOrderItems(orderId: number): Promise<void> {
    await db.delete(printOrderItems).where(eq(printOrderItems.orderId, orderId));
  }

  // Print order files
  async getPrintOrderFiles(orderId: number): Promise<PrintOrderFile[]> {
    return db.select().from(printOrderFiles).where(eq(printOrderFiles.orderId, orderId)).orderBy(desc(printOrderFiles.uploadedAt));
  }
  async createPrintOrderFile(data: InsertPrintOrderFile): Promise<PrintOrderFile> {
    const [r] = await db.insert(printOrderFiles).values(data).returning(); return r;
  }
  async deletePrintOrderFile(id: number): Promise<void> {
    await db.delete(printOrderFiles).where(eq(printOrderFiles.id, id));
  }

  // Print order events
  async getPrintOrderEvents(orderId: number): Promise<PrintOrderEvent[]> {
    return db.select().from(printOrderEvents).where(eq(printOrderEvents.orderId, orderId)).orderBy(desc(printOrderEvents.createdAt));
  }
  async createPrintOrderEvent(data: InsertPrintOrderEvent): Promise<PrintOrderEvent> {
    const [r] = await db.insert(printOrderEvents).values(data).returning(); return r;
  }

  async getPrintOrderByMagicLink(token: string): Promise<PrintOrder | undefined> {
    const [r] = await db.select().from(printOrders).where(eq(printOrders.magicLinkToken, token));
    return r;
  }
}

export const storage = new DatabaseStorage();
