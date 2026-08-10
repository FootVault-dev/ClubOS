import { db } from "./db";
import { eq, desc, sql, and, ilike, or, inArray, asc, isNull, isNotNull, ne, gt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import crypto from "crypto";
import { contentHashOf } from "./studio/hash";
import {
  blockWordCount, expectedReadMs as studioExpectedReadMs, readRatio as studioReadRatio,
  classifyRead, collectBlockStrings,
} from "@shared/studio-signal";
import type { Block } from "@shared/studio-blocks";
import {
  users, contacts, contactRelationships, programs,
  programSessions, registrations, auditLogs, settings,
  sessionBookings, programDiscounts,
  campPricing, campDates, campSettings,
  children, childMedical, registrationItems,
  attendance, emailLogs, metaEventLogs, emailCampaigns,
  organizations, userOrganizations,
  facilities, facilityPricingRules, facilityBookings, facilityAddons, venueSettings,
  leagueCompetitions, leagueDivisions, leagueTeams, leagueGames, leagueCoupons, leagueWaitlist,
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
  type InsertLeagueWaitlist, type LeagueWaitlistEntry,
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
  tournaments, tournamentGroups, tournamentTeams, tournamentPlayers, tournamentStaff, tournamentGames, tournamentGoals, tournamentMvpVotes, tournamentGkRatings, tournamentCards, tournamentPenaltyKicks,
  clubs,
  type InsertTournament, type Tournament,
  type InsertTournamentGroup, type TournamentGroup,
  type InsertTournamentTeam, type TournamentTeam,
  type InsertTournamentPlayer, type TournamentPlayer,
  type InsertTournamentStaff, type TournamentStaff,
  type InsertTournamentGame, type TournamentGame,
  type InsertTournamentGoal, type TournamentGoal,
  type TournamentMvpVote, type TournamentGkRating,
  type InsertTournamentCard, type TournamentCard,
  type InsertTournamentPenaltyKick, type TournamentPenaltyKick,
  type InsertClub, type Club,
  terms,
  type InsertTerm, type Term,
  orgBrandContext, type OrgBrandContext,
  studioDocuments, type StudioDocument,
  studioDocumentVersions, type StudioDocumentVersion,
  studioAnalyticsSessions, type StudioAnalyticsSession,
  studioAnalyticsEvents,
  shortLinks, linkClicks,
  type InsertShortLink, type ShortLink,
} from "@shared/schema";
import { missedPayments } from "@shared/league-weekly";
import type { ReadClass } from "@shared/studio-signal";

// ── Studio "Signal" analytics read models (aggregation query outputs) ─────────
export interface StudioKeyCount { key: string; count: number; }
export interface StudioDocumentOverview {
  uniqueVisitors: number;
  totalSessions: number;
  returningVisitors: number;
  avgEngagedMs: number;
  medianEngagedMs: number;
  avgScrollPct: number;
  ctaClicks: number;          // total cta_click events (non-internal)
  ctaClickSessions: number;   // distinct sessions that clicked the CTA
  reachedEndSessions: number; // sessions with maxScroll >= 98%
  scrolledHalfSessions: number;
  deviceSplit: StudioKeyCount[];
  countrySplit: StudioKeyCount[];
  sourceSplit: StudioKeyCount[];
  firstActivityAt: string | null;
  lastActivityAt: string | null;
}
export interface StudioSessionRow {
  id: number;
  sessionId: string;
  visitorId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  engagedMs: number;
  maxScrollPct: number;
  device: string | null;
  country: string | null;
  sourceTag: string | null;
  ctaClicks: number;
  isReturning: boolean;
}
export interface StudioSectionRow {
  blockId: string;
  type: string;
  label: string;
  wordCount: number;
  expectedReadMs: number;
  medianDwellMs: number;
  avgDwellMs: number;
  reachedSessions: number;
  reachedPct: number;
  readRatio: number | null;
  readClass: ReadClass;
}
export interface StudioSectionEngagement { totalSessions: number; sections: StudioSectionRow[]; }
export interface StudioHotLead {
  documentId: number;
  title: string;
  brandId: string;
  partner: string | null; // best available partner label (source tag / slug)
  sessionId: string;
  visitorId: string | null;
  lastSeenAt: string;
  engagedMs: number;
  maxScrollPct: number;
  device: string | null;
  country: string | null;
  ctaClicks: number;
  isReturning: boolean;
}

// One suspension a player must serve, with the exact game they miss.
export type Suspension = {
  reason: "red" | "two_yellows";
  triggerGameId: number;
  triggerGameLabel: string;               // e.g. "Game 12" — where it was earned
  missesGame: {
    gameId: number; gameNumber: number | null; opponent: string;
    gameDate: string | null; startTime: string | null; field: string | null; stageDetail: string | null;
  } | null;                                // null = no later fixture (their last game / knockout TBD)
};
export type DisciplineRow = {
  playerId: number; playerName: string; shirtNumber: number | null;
  teamId: number; teamName: string; teamLogoUrl: string | null;
  yellows: number; reds: number;
  suspensions: Suspension[];
};

/**
 * One row per PLAYER on a programme's Players tab — not one per registration.
 *
 * ClubOS holds players in two different shapes and this type flattens both:
 *
 *  - **Academy** (U4–U8, Pre-Academy, Academy): the player IS the registration's
 *    contact — a `contacts` row of type 'player' — and the parent is
 *    `guardian_id`. There are no `children` rows and no `registration_items`.
 *  - **Holiday camps** (legacy): the player is a `children` row named on a
 *    `registration_items` line, and the registrant contact is the parent. One
 *    booking can cover several kids across several days.
 *
 * A player can hold more than one registration (re-registered, or booked
 * twice), so registrations are folded into one row and counted. `paidCents` is
 * only filled for the academy shape, where a registration maps 1:1 to a player;
 * splitting a camp booking that covers three siblings would invent a number
 * nobody paid.
 */
export type ProgramPlayer = {
  key: string;                     // "contact-123" / "child-45" — stable row key
  personType: "contact" | "child";
  personId: number;
  profilePath: string;             // where the row links in the admin UI
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  gender: string | null;
  allergies: string | null;
  epiPen: boolean;
  medicalNotes: string | null;
  parent: { id: number; firstName: string; lastName: string; email: string | null; phone: string | null } | null;
  status: string;                  // best status across their registrations
  registrationIds: number[];
  orderNumbers: number[];
  sessionsBooked: number;          // camp shape only — registration_items with a date
  paidCents: number | null;        // academy shape only — see above
  firstRegisteredAt: string | null;
  latestRegisteredAt: string | null;
};

// A campaign row for the mailer HISTORY list — deliberately without `body`.
// Bodies carry inlined base64 images, so selecting every campaign ever sent
// with its body is megabytes the list never renders. Open one to get the body.
export type EmailCampaignSummary = Omit<EmailCampaign, "body" | "replyTo" | "segmentConfig" | "scheduledAt">;

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getAllUsers(): Promise<User[]>;
  getAllUsersWithMemberships(): Promise<Array<User & { memberships: Array<{ orgId: number; orgName: string; orgSlug: string; role: string; tabs: string[] | null }> }>>;
  addUserToOrganization(userId: number, organizationId: number, role?: string, tabs?: string[] | null, hiringBrands?: string[] | null): Promise<UserOrganization>;
  updateUserOrgRole(userId: number, organizationId: number, role: string): Promise<UserOrganization | undefined>;
  updateUserOrgTabs(userId: number, organizationId: number, tabs: string[] | null): Promise<UserOrganization | undefined>;
  updateUserOrgMembership(userId: number, organizationId: number, updates: { role?: string; tabs?: string[] | null; hiringBrands?: string[] | null }): Promise<UserOrganization | undefined>;
  removeUserFromOrganization(userId: number, organizationId: number): Promise<void>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: number, data: Partial<InsertUser>): Promise<User | undefined>;
  deleteUser(id: number): Promise<void>;

  getContacts(): Promise<Contact[]>;
  getContact(id: number): Promise<Contact | undefined>;
  getContactsByIds(ids: number[]): Promise<Contact[]>;
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

  getUserOrganizations(userId: number): Promise<(Organization & { userRole: string; userTabs: string[] | null; userHiringBrands: string[] | null })[]>;

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
  confirmFacilityBookingsByGroup(groupId: string): Promise<FacilityBooking[]>;
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

  getLeagueWaitlist(orgId: number, competitionId?: number): Promise<LeagueWaitlistEntry[]>;
  createLeagueWaitlistEntry(data: InsertLeagueWaitlist): Promise<LeagueWaitlistEntry>;
  updateLeagueWaitlistEntry(id: number, data: Partial<InsertLeagueWaitlist>): Promise<LeagueWaitlistEntry | undefined>;
  deleteLeagueWaitlistEntry(id: number): Promise<void>;

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
  // Public match timeline: scorers + minutes for one game (goals only — never
  // cards/MVP/keeper, which stay admin-only). Own-goal scorer names are
  // suppressed (returned null) to avoid publicly naming a youth player for an OG.
  getPublicGameGoals(gameId: number): Promise<{
    id: number; minute: number | null; playerName: string | null;
    teamId: number; isOwnGoal: boolean; isPenalty: boolean;
  }[]>;
  createTournamentGoal(data: InsertTournamentGoal): Promise<TournamentGoal>;
  deleteTournamentGoal(id: number): Promise<void>;
  getTournamentTopScorers(tournamentId: number): Promise<{
    playerId: number; playerName: string; shirtNumber: number | null;
    teamId: number; teamName: string; teamLogoUrl: string | null;
    goals: number;
  }[]>;

  // Individual awards — ADMIN-ONLY (private). MVP votes + goalkeeper ratings.
  getTournamentMvpVotesByGame(gameId: number): Promise<TournamentMvpVote[]>;
  upsertTournamentMvpVote(gameId: number, voterTeamId: number, playerId: number): Promise<void>;
  deleteTournamentMvpVote(gameId: number, voterTeamId: number): Promise<void>;
  getTournamentGkRatingsByGame(gameId: number): Promise<TournamentGkRating[]>;
  upsertTournamentGkRating(gameId: number, teamId: number, playerId: number, rating: number): Promise<void>;
  deleteTournamentGkRating(gameId: number, teamId: number): Promise<void>;
  getTournamentMvpLeaderboard(tournamentId: number): Promise<{
    playerId: number; playerName: string; shirtNumber: number | null;
    teamId: number; teamName: string; teamLogoUrl: string | null; votes: number;
  }[]>;
  getTournamentGkLeaderboard(tournamentId: number): Promise<{
    playerId: number; playerName: string; shirtNumber: number | null;
    teamId: number; teamName: string; teamLogoUrl: string | null;
    games: number; avgRating: number; totalRating: number;
  }[]>;

  // Disciplinary cards — ADMIN-ONLY.
  getTournamentCardsByGame(gameId: number): Promise<TournamentCard[]>;
  createTournamentCard(data: InsertTournamentCard): Promise<TournamentCard>;
  deleteTournamentCard(id: number): Promise<void>;
  getTournamentDiscipline(tournamentId: number): Promise<DisciplineRow[]>;

  // Penalty shootout — kick-by-kick order for knockout games that finish level.
  getPenaltyKicksByGame(gameId: number): Promise<TournamentPenaltyKick[]>;
  addPenaltyKick(data: InsertTournamentPenaltyKick): Promise<TournamentPenaltyKick>;
  deletePenaltyKick(id: number): Promise<number | null>; // returns the affected gameId
  // Recompute home/away penalty totals on the game row from its kicks (scored
  // count per team) and write them back — keeps the bracket resolver correct.
  syncShootoutTotals(gameId: number): Promise<{ home: number; away: number }>;
  // Public, privacy-safe shootout timeline (taker name only on scored kicks).
  getPublicShootout(gameId: number): Promise<{
    kickNumber: number; teamId: number; scored: boolean; playerName: string | null;
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
  getRegistrationsForContact(contactId: number): Promise<(Registration & { program?: Program })[]>;
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
  getProgramPlayers(campId: number): Promise<ProgramPlayer[]>;

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
  searchEmailCampaigns(opts?: { q?: string; limit?: number; offset?: number }): Promise<{ rows: EmailCampaignSummary[]; total: number }>;
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

  getCampStats(orgId?: number): Promise<{
    totalParents: number;
    activeCamps: number;
    totalRegistrations: number;
    paidRegistrations: number;
    totalRevenueCents: number;
    // Club-wide distinct registered players (all program types, not just
    // camps) — added for the CUFC "whole club" dashboard. Additive only;
    // existing fields/behaviour untouched.
    registeredPlayers: number;
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

  // ── USG Studio ────────────────────────────────────────────────────────────
  // Brand pack (org_brand_context) + generated proposal pages + Signal analytics.
  getOrgBrandContext(orgId: number): Promise<OrgBrandContext | undefined>;
  getOrgBrandContextByBrandId(brandId: string): Promise<OrgBrandContext | undefined>;

  createStudioDocument(data: Omit<typeof studioDocuments.$inferInsert, "token"> & { token?: string }): Promise<StudioDocument>;
  getStudioDocumentById(id: number): Promise<StudioDocument | undefined>;
  getStudioDocumentByToken(token: string): Promise<StudioDocument | undefined>;
  listStudioDocuments(orgId: number): Promise<StudioDocument[]>;
  updateStudioDocument(id: number, data: Partial<typeof studioDocuments.$inferInsert>): Promise<StudioDocument | undefined>;
  publishStudioDocument(id: number, userId: number, label?: string): Promise<StudioDocument | undefined>;
  createStudioDocumentVersion(documentId: number, contentJson: Record<string, any>, createdBy: number, opts?: { label?: string; editOps?: Record<string, any> | null }): Promise<StudioDocumentVersion>;
  rollbackStudioDocument(id: number, versionInt: number, userId: number): Promise<StudioDocument | undefined>;

  // Signal ingest (public, no-auth beacon). Aggregation queries land in a later increment.
  upsertStudioAnalyticsSession(input: {
    documentId: number; sessionId: string; visitorId?: string | null;
    engagedMsDelta?: number; maxScrollPct?: number; device?: string | null;
    userAgent?: string | null; referrer?: string | null; sourceTag?: string | null;
    utmJson?: Record<string, any> | null; country?: string | null; isInternal?: boolean;
  }): Promise<StudioAnalyticsSession>;
  insertStudioAnalyticsEvents(batch: (typeof studioAnalyticsEvents.$inferInsert)[]): Promise<void>;

  // Signal aggregation reads (admin dashboard). All EXCLUDE isInternal sessions.
  getStudioDocumentAnalytics(documentId: number): Promise<StudioDocumentOverview>;
  getStudioDocumentSessions(documentId: number): Promise<StudioSessionRow[]>;
  getStudioSectionEngagement(documentId: number): Promise<StudioSectionEngagement>;
  getStudioHotLeads(orgId: number): Promise<StudioHotLead[]>;

  // AttributionOS — short links (T10)
  listShortLinks(orgId: number, opts?: { includeArchived?: boolean }): Promise<ShortLinkWithClicks[]>;
  getShortLink(id: number): Promise<ShortLink | undefined>;
  getShortLinkByKey(key: string): Promise<ShortLink | undefined>;
  createShortLink(data: InsertShortLink): Promise<ShortLink>;
  updateShortLink(id: number, data: Partial<InsertShortLink>): Promise<ShortLink | undefined>;
  getShortLinkStats(linkId: number, days: number): Promise<ShortLinkStats>;
}

// A short link plus its trailing-7-day (non-bot) click count, for the list view.
export type ShortLinkWithClicks = ShortLink & { last7dClicks: number };

// Per-link stats: NZ-local daily click series + conversions matched to the
// link's minted click ids across every attribution-columned conversion table.
export type ShortLinkStats = {
  linkId: number;
  days: number;
  totalClicks: number;        // counted (non-bot) clicks in window
  totalConversions: number;
  totalLeads: number;
  totalSales: number;
  dailyClicks: Array<{ date: string; clicks: number }>;
  conversions: Array<{ source: string; kind: "lead" | "sale"; count: number }>;
};

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

  async addUserToOrganization(userId: number, organizationId: number, role: string = "admin", tabs: string[] | null = null, hiringBrands: string[] | null = null): Promise<UserOrganization> {
    const [created] = await db.insert(userOrganizations).values({ userId, organizationId, role: role as any, tabs, hiringBrands }).returning();
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

  async updateUserOrgMembership(userId: number, organizationId: number, updates: { role?: string; tabs?: string[] | null; hiringBrands?: string[] | null }): Promise<UserOrganization | undefined> {
    const set: any = {};
    if (updates.role !== undefined) set.role = updates.role;
    if (updates.tabs !== undefined) set.tabs = updates.tabs;
    if (updates.hiringBrands !== undefined) set.hiringBrands = updates.hiringBrands;
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

  async getUserOrganizations(userId: number): Promise<(Organization & { userRole: string; userTabs: string[] | null; userHiringBrands: string[] | null })[]> {
    const rows = await db.select({
      org: organizations,
      userRole: userOrganizations.role,
      userTabs: userOrganizations.tabs,
      userHiringBrands: userOrganizations.hiringBrands,
    }).from(userOrganizations)
      .innerJoin(organizations, eq(userOrganizations.organizationId, organizations.id))
      .where(eq(userOrganizations.userId, userId))
      .orderBy(asc(organizations.name));
    return rows.map(r => ({
      ...r.org,
      userRole: r.userRole,
      userTabs: (r.userTabs as string[] | null) ?? null,
      // `?? null` would be wrong here only if [] were meant to mean "all" — it
      // isn't. [] means no brands, and it must survive the round trip.
      userHiringBrands: Array.isArray(r.userHiringBrands) ? (r.userHiringBrands as string[]) : null,
    }));
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

  /** Batch form of getContact — one query, not one per id. */
  async getContactsByIds(ids: number[]): Promise<Contact[]> {
    if (ids.length === 0) return [];
    return db.select().from(contacts).where(inArray(contacts.id, ids));
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

  /**
   * The Registrations page's whole dataset, in a fixed number of queries.
   *
   * The route used to build this by hand: getRegistrations() (2 queries per
   * row) and then, per row, getRegistrationItems (itself 2 queries per item),
   * getContact, getChildren (1 per child) and getProgram — all fired
   * concurrently through Promise.all. At CUFC's ~450 registrations that is a
   * few thousand simultaneous queries against a 15-connection pooler, and it
   * reproducibly 500'd the page with EMAXCONNSESSION. Exactly the failure that
   * took out the contact-detail pages; same fix, applied to the list.
   *
   * Nine queries, whatever the row count.
   */
  async getRegistrationsForList(opts: { programId?: number } = {}): Promise<any[]> {
    const statusFilter = sql`${registrations.status} IN ('confirmed', 'refunded', 'partially_refunded')`;
    const regs = await db
      .select()
      .from(registrations)
      .where(opts.programId ? and(eq(registrations.programId, opts.programId), statusFilter) : statusFilter)
      .orderBy(desc(registrations.orderNumber), desc(registrations.registeredAt));
    if (regs.length === 0) return [];

    // Empty IN lists are invalid SQL, so every batch is guarded rather than
    // trusted to be non-empty.
    const uniq = <T,>(xs: (T | null | undefined)[]) => Array.from(new Set(xs.filter((x): x is T => x != null)));
    const byId = <T extends { id: number }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));

    const regIds = regs.map((r) => r.id);
    const [items, progRows, contactRows, staffRows] = await Promise.all([
      db.select().from(registrationItems).where(inArray(registrationItems.registrationId, regIds)),
      (async () => { const ids = uniq(regs.map((r) => r.programId)); return ids.length ? db.select().from(programs).where(inArray(programs.id, ids)) : []; })(),
      // Both people on the row. For a camp the registration's contact IS the
      // parent; for an academy enrolment the contact is the PLAYER and the
      // parent hangs off guardianId. Fetching only the contact is how the
      // Registrations page ended up printing a child's name under
      // "Parent / Guardian", with no phone number to ring.
      (async () => {
        const ids = uniq([...regs.map((r) => r.contactId), ...regs.map((r) => r.guardianId)]);
        return ids.length ? db.select().from(contacts).where(inArray(contacts.id, ids)) : [];
      })(),
      // Both the counter staffer who took the payment AND whoever refunded it,
      // resolved in ONE batch. A second query per row here is what exhausted the
      // pooler last time this page grew a join.
      (async () => {
        const ids = uniq([...regs.map((r: any) => r.servedByUserId), ...regs.map((r: any) => r.refundedBy)]);
        return ids.length ? db.select().from(users).where(inArray(users.id, ids)) : [];
      })(),
    ]);

    const itemChildIds = uniq(items.map((i) => i.childId));
    const itemDateIds = uniq(items.map((i) => i.campDateId));
    const parentIds = uniq(regs.map((r) => r.contactId));
    const [itemChildren, itemDates, kidRows] = await Promise.all([
      itemChildIds.length ? db.select().from(children).where(inArray(children.id, itemChildIds)) : [],
      itemDateIds.length ? db.select().from(campDates).where(inArray(campDates.id, itemDateIds)) : [],
      parentIds.length ? db.select().from(children).where(inArray(children.parentId, parentIds)) : [],
    ]);

    const medIds = uniq([...itemChildren.map((c) => c.id), ...kidRows.map((c) => c.id)]);
    const medRows = medIds.length ? await db.select().from(childMedical).where(inArray(childMedical.childId, medIds)) : [];
    const medByChild = new Map(medRows.map((m) => [m.childId, m]));

    const progById = byId(progRows);
    const contactById = byId(contactRows);
    const childById = byId(itemChildren);
    const dateById = byId(itemDates);
    const staffById = new Map(staffRows.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));

    const itemsByReg = new Map<number, any[]>();
    for (const it of items) {
      const list = itemsByReg.get(it.registrationId) ?? [];
      const child = childById.get(it.childId);
      list.push({ ...it, child: child ? { ...child, medical: medByChild.get(child.id) || undefined } : undefined, campDate: dateById.get(it.campDateId) });
      itemsByReg.set(it.registrationId, list);
    }
    const kidsByParent = new Map<number, any[]>();
    for (const k of kidRows) {
      const list = kidsByParent.get(k.parentId!) ?? [];
      list.push({ ...k, medical: medByChild.get(k.id) || undefined });
      kidsByParent.set(k.parentId!, list);
    }

    return regs.map((r: any) => {
      const contact = contactById.get(r.contactId);
      const guardian = r.guardianId ? contactById.get(r.guardianId) : undefined;
      return {
        ...r,
        program: progById.get(r.programId),
        contact,
        // Only when it is a genuinely different person — on a camp
        // registration guardianId and contactId are the same row, and echoing
        // the parent twice would just be noise.
        guardian: guardian && guardian.id !== contact?.id ? guardian : undefined,
        items: itemsByReg.get(r.id) ?? [],
        children: kidsByParent.get(r.contactId) ?? [],
        servedByName: r.servedByUserId ? staffById.get(r.servedByUserId) ?? null : null,
        // Who sent the money back. Resolved at READ time from refundedBy rather
        // than stamped onto the row, so a later name change corrects everywhere
        // at once. Null when the refund predates the audit trail — which reads
        // honestly as "we don't know", never as nobody.
        refundedByName: (r as any).refundedBy ? staffById.get((r as any).refundedBy) ?? null : null,
      };
    });
  }

  async getRegistrationsByProgram(programId: number): Promise<(Registration & { contact?: Contact })[]> {
    const regs = await db.select().from(registrations).where(and(eq(registrations.programId, programId), sql`${registrations.status} IN ('confirmed', 'refunded', 'partially_refunded')`));
    return Promise.all(regs.map(async (r) => {
      const [contact] = await db.select().from(contacts).where(eq(contacts.id, r.contactId));
      return { ...r, contact };
    }));
  }

  /**
   * One contact's registrations — as the registrant OR as the guardian.
   *
   * The contact-detail pages used to call getRegistrations() and filter in JS.
   * That loads EVERY confirmed registration in the database and fires two more
   * queries per row, which reproducibly exhausted the 15-connection pool
   * (`EMAXCONNSESSION`) and 500'd the page. This is two queries, total.
   *
   * Unlike getRegistrations() this keeps pending rows: a player card reached
   * from a programme's Players tab must still show a pending registration —
   * the status badge says which it is.
   */
  async getRegistrationsForContact(contactId: number): Promise<(Registration & { program?: Program })[]> {
    const regs = await db.select().from(registrations)
      .where(or(eq(registrations.contactId, contactId), eq(registrations.guardianId, contactId)))
      .orderBy(desc(registrations.registeredAt));
    if (regs.length === 0) return [];
    const programIds = Array.from(new Set(regs.map(r => r.programId)));
    const progs = await db.select().from(programs).where(inArray(programs.id, programIds));
    const byId = new Map(progs.map(p => [p.id, p]));
    return regs.map(r => ({ ...r, program: byId.get(r.programId) }));
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
      // An academy term enrolment buys the TERM, not a set of dates — it writes
      // no per-date registration_items, so counting items alone reports 0
      // booked on every session of a fully-subscribed programme. Those
      // registrants (the contact shape) are on the roll for every session, so
      // they're added to each date's count. Programmes that do book per date
      // (CUGC) still count their items; a programme never has both shapes.
      const termEnrolments = await this.countTermEnrolments(campId);
      for (const d of dates) {
        const totalCount = items
          .filter(i => i.campDateId === d.id)
          .reduce((sum, i) => sum + (i.count || 0), 0);
        results.push({
          campDateId: d.id,
          date: d.date,
          productType: "SESSION",
          bookedCount: totalCount + termEnrolments,
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

  // Confirmed registrations of a term programme whose registrant contact IS
  // the player. This is the academy shape (storage.getProgramPlayers "Shape 1")
  // and it carries no per-date rows, so these people are on the roll for every
  // session of the term.
  private async countTermEnrolments(campId: number): Promise<number> {
    const program = await this.getProgram(campId);
    if (program?.scheduleType !== "term") return 0;
    const [r] = await db.select({ count: sql<number>`count(*)::int` })
      .from(registrations)
      .innerJoin(contacts, eq(registrations.contactId, contacts.id))
      .where(and(
        eq(registrations.programId, campId),
        eq(registrations.status, "confirmed"),
        eq(contacts.type, "player"),
      ));
    return r?.count || 0;
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

    // ── Academy shape ────────────────────────────────────────────────────────
    // The registrant contact IS the player and the term enrolment booked no
    // dates, so the roll for this session is every confirmed enrolment. Without
    // this branch the loop above returns nothing at all for an academy
    // programme (programme 4: 72 registrants, 0 registration_items).
    if (isTermMode) {
      const guardian = alias(contacts, "roll_guardian");
      const player = alias(contacts, "roll_player");
      const enrolled = await db.select({
        player: player,
        guardian: guardian,
      })
        .from(registrations)
        .innerJoin(player, eq(registrations.contactId, player.id))
        .leftJoin(guardian, eq(registrations.guardianId, guardian.id))
        .where(and(
          eq(registrations.programId, campId),
          eq(registrations.status, "confirmed"),
          eq(player.type, "player"),
        ));

      // Walk-ups added to THIS session by a coach — an open trainer or someone
      // whose fees aren't paid. They have no registration, so they'd otherwise
      // vanish from the roll the moment it reloaded. Scoped to this session on
      // purpose: turning up once doesn't put a trialist on every future roll.
      const guestRows = await db.select({ contact: player, att: attendance })
        .from(attendance)
        .innerJoin(player, eq(attendance.contactId, player.id))
        .where(and(
          eq(attendance.campDateId, campDateId),
          isNotNull(attendance.guestKind),
        ));

      const seenContactIds = new Set<number>();
      for (const row of enrolled) {
        const p = row.player;
        if (seenContactIds.has(p.id)) continue;   // re-registered → one roll line
        seenContactIds.add(p.id);

        let [att] = await db.select().from(attendance).where(and(
          eq(attendance.campDateId, campDateId),
          eq(attendance.contactId, p.id),
        ));
        if (!att) {
          try {
            const [created] = await db.insert(attendance)
              .values({ campId, campDateId, contactId: p.id }).returning();
            att = created;
          } catch {
            // Lost the race with another coach opening the same roll — the
            // partial unique index means the other insert won; re-read it.
            [att] = await db.select().from(attendance).where(and(
              eq(attendance.campDateId, campDateId),
              eq(attendance.contactId, p.id),
            ));
          }
        }

        results.push({
          // Shaped as a `child` so one roll UI serves both models. `epiPen` is
          // deliberately left undefined, not false: contacts carry allergies +
          // medicalNotes but have no EpiPen column, and an absent field must
          // never render as a checked "no EpiPen".
          child: {
            id: p.id,
            firstName: p.firstName,
            lastName: p.lastName,
            dateOfBirth: p.dateOfBirth,
            gender: p.gender,
            parentId: row.guardian?.id ?? 0,
            medical: (p.allergies || p.medicalNotes)
              ? { allergies: p.allergies, notes: p.medicalNotes } as any
              : undefined,
          } as any,
          parent: (row.guardian ?? null) as any,
          attendance: att || undefined,
          productType: "SESSION",
        } as any);
      }

      // Then the walk-ups. A guest who has since been registered would appear
      // in BOTH lists, so the registration wins — someone who has paid must
      // never keep reading as "not paid yet".
      for (const g of guestRows) {
        if (seenContactIds.has(g.contact.id)) continue;
        seenContactIds.add(g.contact.id);
        const p = g.contact;
        results.push({
          child: {
            id: p.id,
            firstName: p.firstName,
            lastName: p.lastName,
            dateOfBirth: p.dateOfBirth,
            gender: p.gender,
            parentId: 0,
            medical: (p.allergies || p.medicalNotes)
              ? { allergies: p.allergies, notes: p.medicalNotes } as any
              : undefined,
          } as any,
          parent: null as any,
          attendance: g.att,
          productType: "SESSION",
        } as any);
      }
    }

    return results.sort((a, b) => a.child.lastName.localeCompare(b.child.lastName));
  }

  async getProgramPlayers(campId: number): Promise<ProgramPlayer[]> {
    // Both shapes are queried — see the ProgramPlayer docblock. Cancelled and
    // pending rows are kept: the question is "who has signed up", and the
    // status column says where each one sits.
    //
    // A confirmed registration outranks pending, which outranks cancelled, so
    // someone who re-registered after a cancellation reads as confirmed.
    const rank: Record<string, number> = {
      confirmed: 5, paid: 5, pending: 4, waitlisted: 3, partially_refunded: 2, refunded: 1, cancelled: 0,
    };
    type Row = {
      personType: "contact" | "child";
      personId: number;
      firstName: string;
      lastName: string;
      dateOfBirth: string | null;
      gender: string | null;
      allergies: string | null;
      medicalNotes: string | null;
      parentId: number | null;
      parentFirstName: string | null;
      parentLastName: string | null;
      parentEmail: string | null;
      parentPhone: string | null;
      registrationId: number;
      orderNumber: number | null;
      status: string;
      registeredAt: Date | null;
      totalCents: number | null;
      hasSession: boolean;
    };

    const guardian = alias(contacts, "guardian_contact");

    // Shape 1 — academy: the registrant contact IS the player.
    const contactRows = await db.select({
      personId: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      dateOfBirth: contacts.dateOfBirth,
      gender: contacts.gender,
      allergies: contacts.allergies,
      medicalNotes: contacts.medicalNotes,
      parentId: guardian.id,
      parentFirstName: guardian.firstName,
      parentLastName: guardian.lastName,
      parentEmail: guardian.email,
      parentPhone: guardian.phone,
      registrationId: registrations.id,
      orderNumber: registrations.orderNumber,
      status: registrations.status,
      registeredAt: registrations.registeredAt,
      totalCents: registrations.totalCents,
    })
      .from(registrations)
      .innerJoin(contacts, eq(registrations.contactId, contacts.id))
      .leftJoin(guardian, eq(registrations.guardianId, guardian.id))
      .where(and(eq(registrations.programId, campId), eq(contacts.type, "player")));

    // Shape 2 — camps: one registration_items line per child per day.
    const childRows = await db.select({
      personId: children.id,
      firstName: children.firstName,
      lastName: children.lastName,
      dateOfBirth: children.dateOfBirth,
      gender: children.gender,
      parentId: contacts.id,
      parentFirstName: contacts.firstName,
      parentLastName: contacts.lastName,
      parentEmail: contacts.email,
      parentPhone: contacts.phone,
      registrationId: registrations.id,
      orderNumber: registrations.orderNumber,
      status: registrations.status,
      registeredAt: registrations.registeredAt,
      campDateId: registrationItems.campDateId,
    })
      .from(registrationItems)
      .innerJoin(registrations, eq(registrationItems.registrationId, registrations.id))
      .innerJoin(children, eq(registrationItems.childId, children.id))
      .leftJoin(contacts, eq(children.parentId, contacts.id))
      .where(eq(registrations.programId, campId));

    const rows: Row[] = [
      ...contactRows.map((r): Row => ({
        personType: "contact",
        personId: r.personId,
        firstName: r.firstName,
        lastName: r.lastName,
        dateOfBirth: r.dateOfBirth ?? null,
        gender: r.gender ?? null,
        allergies: r.allergies ?? null,
        medicalNotes: r.medicalNotes ?? null,
        parentId: r.parentId ?? null,
        parentFirstName: r.parentFirstName ?? null,
        parentLastName: r.parentLastName ?? null,
        parentEmail: r.parentEmail ?? null,
        parentPhone: r.parentPhone ?? null,
        registrationId: r.registrationId,
        orderNumber: r.orderNumber ?? null,
        status: r.status,
        registeredAt: r.registeredAt ?? null,
        totalCents: r.totalCents ?? null,
        hasSession: false,
      })),
      ...childRows.map((r): Row => ({
        personType: "child",
        personId: r.personId,
        firstName: r.firstName,
        lastName: r.lastName,
        dateOfBirth: r.dateOfBirth ?? null,
        gender: r.gender ?? null,
        allergies: null,          // camps keep medical in child_medical, joined below
        medicalNotes: null,
        parentId: r.parentId ?? null,
        parentFirstName: r.parentFirstName ?? null,
        parentLastName: r.parentLastName ?? null,
        parentEmail: r.parentEmail ?? null,
        parentPhone: r.parentPhone ?? null,
        registrationId: r.registrationId,
        orderNumber: r.orderNumber ?? null,
        status: r.status,
        registeredAt: r.registeredAt ?? null,
        totalCents: null,         // a camp booking can cover several siblings
        hasSession: r.campDateId != null,
      })),
    ];

    const byPerson = new Map<string, ProgramPlayer & { _regIds: Set<number> }>();
    for (const r of rows) {
      const key = `${r.personType}-${r.personId}`;
      let p = byPerson.get(key);
      if (!p) {
        p = {
          key,
          personType: r.personType,
          personId: r.personId,
          profilePath: r.personType === "child"
            ? `/admin/contacts/player/${r.personId}`
            : `/admin/contacts/parent/${r.personId}`,   // generic contact detail
          firstName: r.firstName,
          lastName: r.lastName,
          dateOfBirth: r.dateOfBirth,
          gender: r.gender,
          allergies: r.allergies,
          epiPen: false,
          medicalNotes: r.medicalNotes,
          parent: r.parentId
            ? {
                id: r.parentId,
                firstName: r.parentFirstName ?? "",
                lastName: r.parentLastName ?? "",
                email: r.parentEmail ?? null,
                phone: r.parentPhone ?? null,
              }
            : null,
          status: r.status,
          registrationIds: [],
          orderNumbers: [],
          sessionsBooked: 0,
          paidCents: null,
          firstRegisteredAt: null,
          latestRegisteredAt: null,
          _regIds: new Set<number>(),
        };
        byPerson.set(key, p);
      }
      if (r.hasSession) p.sessionsBooked += 1;
      if (!p._regIds.has(r.registrationId)) {
        p._regIds.add(r.registrationId);
        p.registrationIds.push(r.registrationId);
        if (r.orderNumber != null) p.orderNumbers.push(r.orderNumber);
        // Only count money the registration actually attributes to this player.
        if (r.totalCents != null) p.paidCents = (p.paidCents ?? 0) + r.totalCents;
      }
      if ((rank[r.status] ?? 0) > (rank[p.status] ?? 0)) p.status = r.status;
      const at = r.registeredAt ? new Date(r.registeredAt).toISOString() : null;
      if (at) {
        if (!p.firstRegisteredAt || at < p.firstRegisteredAt) p.firstRegisteredAt = at;
        if (!p.latestRegisteredAt || at > p.latestRegisteredAt) p.latestRegisteredAt = at;
      }
    }

    const players = Array.from(byPerson.values());
    if (players.length === 0) return [];

    // child_medical in one pass — allergies and EpiPen matter most on a roll.
    const childIds = players.filter(p => p.personType === "child").map(p => p.personId);
    if (childIds.length > 0) {
      const meds = await db.select().from(childMedical).where(inArray(childMedical.childId, childIds));
      const medByChild = new Map(meds.map(m => [m.childId, m]));
      for (const p of players) {
        if (p.personType !== "child") continue;
        const m = medByChild.get(p.personId);
        if (m) {
          p.allergies = m.allergies ?? null;
          p.epiPen = Boolean(m.epiPen);
          p.medicalNotes = m.notes ?? null;
        }
      }
    }

    return players
      .map(({ _regIds, ...p }) => p)
      .sort((a, b) => (a.lastName || "").localeCompare(b.lastName || "") || (a.firstName || "").localeCompare(b.firstName || ""));
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

  async getCampStats(orgId?: number): Promise<{
    totalParents: number;
    activeCamps: number;
    totalRegistrations: number;
    paidRegistrations: number;
    totalRevenueCents: number;
    registeredPlayers: number;
  }> {
    // "Active Camps" stays a literal holiday-camp count — it feeds the SIU
    // dashboard's Active Camps tile and the CUFC "X active camps" footer, both
    // of which mean camps, not the whole programme list.
    const campWhere = orgId
      ? and(eq(programs.type, "holiday_camp"), eq(programs.organizationId, orgId))
      : eq(programs.type, "holiday_camp");
    const [ac] = await db.select({ count: sql<number>`count(*)` }).from(programs)
      .where(and(eq(programs.isActive, true), campWhere));

    // Registrations, paid count and revenue cover the WHOLE workspace — every
    // programme type, not just camps — so the dashboard reflects academy (and
    // any future) revenue alongside camps, matching the registered-players
    // tile. This was the bug: these three were scoped to holiday_camp only, so
    // the CUFC dashboard sat on the camps numbers and hid ~$23k of academy
    // income. Without an orgId, keep the legacy holiday-camp-only behaviour so
    // the unscoped all-orgs call is unchanged.
    let statIds: number[];
    if (orgId) {
      const orgPrograms = await db.select({ id: programs.id }).from(programs).where(eq(programs.organizationId, orgId));
      statIds = orgPrograms.map(p => p.id);
    } else {
      const campPrograms = await db.select({ id: programs.id }).from(programs).where(eq(programs.type, "holiday_camp"));
      statIds = campPrograms.map(c => c.id);
    }

    let totalRegs = 0, paidRegs = 0, totalRev = 0;
    if (statIds.length > 0) {
      const [tr] = await db.select({ count: sql<number>`count(*)` }).from(registrations).where(inArray(registrations.programId, statIds));
      const [pr] = await db.select({ count: sql<number>`count(*)` }).from(registrations)
        .where(and(inArray(registrations.programId, statIds), eq(registrations.status, "confirmed")));
      const [rev] = await db.select({ total: sql<number>`COALESCE(SUM(total_cents), 0)` }).from(registrations)
        .where(and(inArray(registrations.programId, statIds), eq(registrations.status, "confirmed")));
      totalRegs = Number(tr.count);
      paidRegs = Number(pr.count);
      totalRev = Number(rev.total);
    }

    // Distinct registrant contacts across the workspace's programmes — reused
    // for both totalParents (SIU tile) and registeredPlayers (CUFC tile).
    // Without an orgId, totalParents keeps the legacy global guardian count.
    let distinctRegistrants = 0;
    if (orgId && statIds.length > 0) {
      const [dr] = await db.select({ count: sql<number>`count(distinct ${registrations.contactId})` })
        .from(registrations).where(inArray(registrations.programId, statIds));
      distinctRegistrants = Number(dr.count);
    }

    let totalParents: number;
    if (orgId) {
      totalParents = distinctRegistrants;
    } else {
      const [tp] = await db.select({ count: sql<number>`count(*)` }).from(contacts).where(eq(contacts.type, "guardian"));
      totalParents = Number(tp.count);
    }
    const registeredPlayers = orgId ? distinctRegistrants : totalParents;

    return {
      totalParents,
      activeCamps: Number(ac.count),
      totalRegistrations: totalRegs,
      paidRegistrations: paidRegs,
      totalRevenueCents: totalRev,
      registeredPlayers,
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

  // Mailer history search — every broadcast this club has ever sent, from any
  // mailer (camps, CIC, CUFC, MFL, league), newest first. `q` matches the
  // subject OR the email content, so "goalkeeper" finds the send that mentioned
  // it even when the subject line didn't. Paged, and body-free (see the type).
  async searchEmailCampaigns(opts: { q?: string; limit?: number; offset?: number } = {}): Promise<{ rows: EmailCampaignSummary[]; total: number }> {
    const raw = (opts.q ?? "").trim();
    // `%` and `_` are ILIKE wildcards — a search for "50% off" must not match
    // every campaign ever sent. Backslash is Postgres's default escape char.
    const term = raw.replace(/[\\%_]/g, (c) => `\\${c}`);
    const where = term
      ? or(ilike(emailCampaigns.subject, `%${term}%`), ilike(emailCampaigns.body, `%${term}%`))
      : undefined;

    const limit = Number.isFinite(opts.limit) ? Math.min(Math.max(Math.trunc(opts.limit!), 1), 100) : 20;
    const offset = Number.isFinite(opts.offset) ? Math.max(Math.trunc(opts.offset!), 0) : 0;

    const rows = await db
      .select({
        id: emailCampaigns.id,
        subject: emailCampaigns.subject,
        fromEmail: emailCampaigns.fromEmail,
        segmentType: emailCampaigns.segmentType,
        recipientCount: emailCampaigns.recipientCount,
        sentCount: emailCampaigns.sentCount,
        failedCount: emailCampaigns.failedCount,
        status: emailCampaigns.status,
        sentAt: emailCampaigns.sentAt,
        createdAt: emailCampaigns.createdAt,
      })
      .from(emailCampaigns)
      .where(where)
      .orderBy(desc(emailCampaigns.createdAt))
      .limit(limit)
      .offset(offset);

    const [counted] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailCampaigns)
      .where(where);

    return { rows, total: Number(counted?.n ?? 0) };
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

  // Confirm a whole booking GROUP (used by Player Pay venue splits, where each
  // payer has their own PI rather than one group PI). Idempotent: pending → paid.
  async confirmFacilityBookingsByGroup(groupId: string): Promise<FacilityBooking[]> {
    return db.update(facilityBookings)
      .set({ status: "paid", paidAt: new Date() })
      .where(and(
        eq(facilityBookings.bookingGroupId, groupId),
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

  async getLeagueWaitlist(orgId: number, competitionId?: number): Promise<LeagueWaitlistEntry[]> {
    const conditions = [eq(leagueWaitlist.organizationId, orgId)];
    if (competitionId) conditions.push(eq(leagueWaitlist.competitionId, competitionId));
    return db.select().from(leagueWaitlist).where(and(...conditions)).orderBy(desc(leagueWaitlist.createdAt));
  }

  async createLeagueWaitlistEntry(data: InsertLeagueWaitlist): Promise<LeagueWaitlistEntry> {
    const [w] = await db.insert(leagueWaitlist).values(data).returning();
    return w;
  }

  async updateLeagueWaitlistEntry(id: number, data: Partial<InsertLeagueWaitlist>): Promise<LeagueWaitlistEntry | undefined> {
    const [w] = await db.update(leagueWaitlist).set(data).where(eq(leagueWaitlist.id, id)).returning();
    return w;
  }

  async deleteLeagueWaitlistEntry(id: number): Promise<void> {
    await db.delete(leagueWaitlist).where(eq(leagueWaitlist.id, id));
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
  // captain contact, division name, team payment status and how far behind the
  // team's payments are (missed weekly charges / failed instalment balance) —
  // for the admin Registrations view. Missed is DERIVED here on every read
  // (shared/league-weekly.ts — same maths as the breakdown modal), Postgres
  // only, no Stripe calls.
  async getLeagueRegistrations(competitionId: number): Promise<any[]> {
    const progs = await db.select().from(programs)
      .where(and(eq(programs.leagueCompetitionId, competitionId), eq(programs.type, "league_team")));
    const progIds = progs.map(p => p.id);
    if (progIds.length === 0) return [];
    const comp = await this.getLeagueCompetition(competitionId);

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

    const nowMs = Date.now();
    return rows.map(r => {
      const missed = missedPayments({
        status: r.reg.status,
        paymentMode: r.reg.paymentMode,
        weeksTotal: r.reg.weeksTotal,
        weeksPaid: r.reg.weeksPaid,
        weeklyAmountCents: r.reg.weeklyAmountCents,
        weeklyFirstChargeDate: (r.reg as any).weeklyFirstChargeDate ?? null,
        compStartDate: (comp as any)?.startDate ?? null,
        registeredAt: r.reg.registeredAt,
        balanceStatus: r.reg.balanceStatus,
        balanceCents: r.reg.balanceCents,
        nowMs,
      });
      return {
        id: r.reg.id,
        teamName: r.reg.teamName,
        status: r.reg.status,
        divisionId: r.reg.leagueDivisionId ?? null,
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
        missedCount: missed.missedCount,
        missedCents: missed.missedCents,
      };
    });
  }

  // Raw registration rows for a competition (all columns, incl. the weekly-plan
  // + instalment fields) — used by the cashflow forecast to decompose each
  // team's payments into dated inflows. Same status set as getLeagueRegistrations
  // so totals reconcile with the Payments headline.
  async getLeagueCashflowRegs(competitionId: number): Promise<any[]> {
    const progs = await db.select().from(programs)
      .where(and(eq(programs.leagueCompetitionId, competitionId), eq(programs.type, "league_team")));
    const progIds = progs.map(p => p.id);
    if (progIds.length === 0) return [];
    return db.select().from(registrations)
      .where(and(
        inArray(registrations.programId, progIds),
        inArray(registrations.status, ["confirmed", "refunded", "partially_refunded", "waitlisted"]),
      ))
      .orderBy(desc(registrations.registeredAt));
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

  // Find (case-insensitive on full name) or create a player on a team — lets
  // admins log a goal scorer by name when the squad isn't pre-loaded. Returns
  // the playerId so the same scorer aggregates correctly in the Golden Boot.
  async findOrCreateTournamentPlayerByName(teamId: number, fullName: string): Promise<number> {
    const name = (fullName || "").trim().replace(/\s+/g, " ");
    if (!name) throw new Error("Scorer name is empty");
    const sp = name.indexOf(" ");
    const firstName = sp === -1 ? name : name.slice(0, sp);
    const lastName = sp === -1 ? "" : name.slice(sp + 1);
    const existing = await db.select({ id: tournamentPlayers.id }).from(tournamentPlayers)
      .where(and(eq(tournamentPlayers.teamId, teamId),
        sql`lower(trim(${tournamentPlayers.firstName} || ' ' || ${tournamentPlayers.lastName})) = lower(${name})`));
    if (existing.length) return existing[0].id;
    const [p] = await db.insert(tournamentPlayers).values({ teamId, firstName, lastName }).returning({ id: tournamentPlayers.id });
    return p.id;
  }

  // teamId → number of players, for every team in a tournament (roster coverage).
  async getTournamentPlayerCounts(tournamentId: number): Promise<Record<number, number>> {
    const rows = await db
      .select({ teamId: tournamentPlayers.teamId, n: sql<number>`count(*)::int` })
      .from(tournamentPlayers)
      .innerJoin(tournamentTeams, eq(tournamentPlayers.teamId, tournamentTeams.id))
      .where(eq(tournamentTeams.tournamentId, tournamentId))
      .groupBy(tournamentPlayers.teamId);
    const m: Record<number, number> = {};
    for (const r of rows) m[r.teamId] = r.n;
    return m;
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

  // Public match timeline — scorer name + minute per goal for one game. Joins
  // the player for the name; own goals return a null name so a child is never
  // publicly named for an OG (the goal still shows, credited to the right team).
  // Minute-less goals sort to the end; ties break by insertion order.
  async getPublicGameGoals(gameId: number): Promise<{
    id: number; minute: number | null; playerName: string | null;
    teamId: number; isOwnGoal: boolean; isPenalty: boolean;
  }[]> {
    const rows = await db.execute(sql`
      SELECT
        g.id          AS id,
        g.minute      AS minute,
        g.team_id     AS team_id,
        g.is_own_goal AS is_own_goal,
        g.is_penalty  AS is_penalty,
        CASE WHEN g.is_own_goal THEN NULL
             ELSE (p.first_name || ' ' || p.last_name) END AS player_name
      FROM tournament_goals g
      JOIN tournament_players p ON p.id = g.player_id
      WHERE g.game_id = ${gameId}
      ORDER BY g.minute ASC NULLS LAST, g.id ASC
    `);
    return (rows as any).rows.map((r: any) => ({
      id: r.id,
      minute: r.minute,
      playerName: r.player_name,
      teamId: r.team_id,
      isOwnGoal: r.is_own_goal,
      isPenalty: r.is_penalty,
    }));
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

  // ── Individual awards — ADMIN-ONLY (MVP votes + goalkeeper ratings) ──
  async getTournamentMvpVotesByGame(gameId: number): Promise<TournamentMvpVote[]> {
    return db.select().from(tournamentMvpVotes).where(eq(tournamentMvpVotes.gameId, gameId));
  }

  async upsertTournamentMvpVote(gameId: number, voterTeamId: number, playerId: number): Promise<void> {
    await db.insert(tournamentMvpVotes)
      .values({ gameId, voterTeamId, playerId })
      .onConflictDoUpdate({
        target: [tournamentMvpVotes.gameId, tournamentMvpVotes.voterTeamId],
        set: { playerId },
      });
  }

  async deleteTournamentMvpVote(gameId: number, voterTeamId: number): Promise<void> {
    await db.delete(tournamentMvpVotes)
      .where(and(eq(tournamentMvpVotes.gameId, gameId), eq(tournamentMvpVotes.voterTeamId, voterTeamId)));
  }

  async getTournamentGkRatingsByGame(gameId: number): Promise<TournamentGkRating[]> {
    return db.select().from(tournamentGkRatings).where(eq(tournamentGkRatings.gameId, gameId));
  }

  async upsertTournamentGkRating(gameId: number, teamId: number, playerId: number, rating: number): Promise<void> {
    await db.insert(tournamentGkRatings)
      .values({ gameId, teamId, playerId, rating })
      .onConflictDoUpdate({
        target: [tournamentGkRatings.gameId, tournamentGkRatings.teamId],
        set: { playerId, rating },
      });
  }

  async deleteTournamentGkRating(gameId: number, teamId: number): Promise<void> {
    await db.delete(tournamentGkRatings)
      .where(and(eq(tournamentGkRatings.gameId, gameId), eq(tournamentGkRatings.teamId, teamId)));
  }

  async getTournamentMvpLeaderboard(tournamentId: number): Promise<{
    playerId: number; playerName: string; shirtNumber: number | null;
    teamId: number; teamName: string; teamLogoUrl: string | null; votes: number;
  }[]> {
    // One vote each; MVP = most votes. Join votes → player → their team.
    const rows = await db.execute(sql`
      SELECT
        p.id           AS player_id,
        (p.first_name || ' ' || p.last_name) AS player_name,
        p.shirt_number AS shirt_number,
        t.id           AS team_id,
        t.name         AS team_name,
        COALESCE(t.logo_url, c.logo_url) AS team_logo_url,
        COUNT(*)::int  AS votes
      FROM tournament_mvp_votes v
      JOIN tournament_games games ON games.id = v.game_id
      JOIN tournament_players p   ON p.id = v.player_id
      JOIN tournament_teams t     ON t.id = p.team_id
      LEFT JOIN clubs c           ON c.id = t.club_id
      WHERE games.tournament_id = ${tournamentId}
      GROUP BY p.id, p.first_name, p.last_name, p.shirt_number,
               t.id, t.name, t.logo_url, c.logo_url
      ORDER BY votes DESC, p.last_name ASC, p.first_name ASC
    `);
    return (rows as any).rows.map((r: any) => ({
      playerId: r.player_id, playerName: r.player_name, shirtNumber: r.shirt_number,
      teamId: r.team_id, teamName: r.team_name, teamLogoUrl: r.team_logo_url, votes: r.votes,
    }));
  }

  async getTournamentGkLeaderboard(tournamentId: number): Promise<{
    playerId: number; playerName: string; shirtNumber: number | null;
    teamId: number; teamName: string; teamLogoUrl: string | null;
    games: number; avgRating: number; totalRating: number;
  }[]> {
    // Golden Glove = best average keeper rating across games (5 = best).
    // Rank by average, then by games played (more games = more reliable).
    const rows = await db.execute(sql`
      SELECT
        p.id           AS player_id,
        (p.first_name || ' ' || p.last_name) AS player_name,
        p.shirt_number AS shirt_number,
        t.id           AS team_id,
        t.name         AS team_name,
        COALESCE(t.logo_url, c.logo_url) AS team_logo_url,
        COUNT(*)::int              AS games,
        ROUND(AVG(r.rating), 2)::float8 AS avg_rating,
        SUM(r.rating)::int         AS total_rating
      FROM tournament_gk_ratings r
      JOIN tournament_games games ON games.id = r.game_id
      JOIN tournament_players p   ON p.id = r.player_id
      JOIN tournament_teams t     ON t.id = r.team_id
      LEFT JOIN clubs c           ON c.id = t.club_id
      WHERE games.tournament_id = ${tournamentId}
      GROUP BY p.id, p.first_name, p.last_name, p.shirt_number,
               t.id, t.name, t.logo_url, c.logo_url
      ORDER BY avg_rating DESC, games DESC, p.last_name ASC
    `);
    return (rows as any).rows.map((r: any) => ({
      playerId: r.player_id, playerName: r.player_name, shirtNumber: r.shirt_number,
      teamId: r.team_id, teamName: r.team_name, teamLogoUrl: r.team_logo_url,
      games: r.games, avgRating: r.avg_rating, totalRating: r.total_rating,
    }));
  }

  // ── Disciplinary cards — ADMIN-ONLY (yellow/red tracker) ──
  async getTournamentCardsByGame(gameId: number): Promise<TournamentCard[]> {
    return db.select().from(tournamentCards).where(eq(tournamentCards.gameId, gameId)).orderBy(asc(tournamentCards.minute));
  }

  async createTournamentCard(data: InsertTournamentCard): Promise<TournamentCard> {
    const [c] = await db.insert(tournamentCards).values(data).returning();
    return c;
  }

  async deleteTournamentCard(id: number): Promise<void> {
    await db.delete(tournamentCards).where(eq(tournamentCards.id, id));
  }

  // ── Penalty shootout ──────────────────────────────────────────────────────
  async getPenaltyKicksByGame(gameId: number): Promise<TournamentPenaltyKick[]> {
    return db.select().from(tournamentPenaltyKicks)
      .where(eq(tournamentPenaltyKicks.gameId, gameId))
      .orderBy(asc(tournamentPenaltyKicks.kickNumber));
  }

  async addPenaltyKick(data: InsertTournamentPenaltyKick): Promise<TournamentPenaltyKick> {
    // Concrete shape (drizzle-zod Insert* types infer loosely here).
    const d = data as { gameId: number; teamId: number; scored: boolean; kickNumber?: number | null; playerId?: number | null };
    // kickNumber is the running order; if not supplied, append to the end.
    let kickNumber = d.kickNumber;
    if (kickNumber == null) {
      const existing = await this.getPenaltyKicksByGame(d.gameId);
      kickNumber = (existing.at(-1)?.kickNumber ?? 0) + 1;
    }
    const [k] = await db.insert(tournamentPenaltyKicks).values({ ...d, kickNumber } as any).returning();
    return k;
  }

  async deletePenaltyKick(id: number): Promise<number | null> {
    // Delete, then re-sequence the remaining kicks 1..n so the order stays
    // contiguous (no gaps) for display. Returns the game it belonged to.
    const [row] = await db.select().from(tournamentPenaltyKicks).where(eq(tournamentPenaltyKicks.id, id));
    await db.delete(tournamentPenaltyKicks).where(eq(tournamentPenaltyKicks.id, id));
    if (!row) return null;
    const remaining = await this.getPenaltyKicksByGame(row.gameId);
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i].kickNumber !== i + 1) {
        await db.update(tournamentPenaltyKicks)
          .set({ kickNumber: i + 1 })
          .where(eq(tournamentPenaltyKicks.id, remaining[i].id));
      }
    }
    return row.gameId;
  }

  async syncShootoutTotals(gameId: number): Promise<{ home: number; away: number }> {
    const game = await this.getTournamentGame(gameId);
    if (!game) return { home: 0, away: 0 };
    const kicks = await this.getPenaltyKicksByGame(gameId);
    if (kicks.length === 0) {
      // No kicks logged — leave any manually-entered totals untouched (the
      // "quick score" path sets home/away penalties directly).
      return { home: game.homePenalties ?? 0, away: game.awayPenalties ?? 0 };
    }
    const home = kicks.filter(k => k.teamId === game.homeTeamId && k.scored).length;
    const away = kicks.filter(k => k.teamId === game.awayTeamId && k.scored).length;
    await db.update(tournamentGames)
      .set({ homePenalties: home, awayPenalties: away })
      .where(eq(tournamentGames.id, gameId));
    return { home, away };
  }

  async getPublicShootout(gameId: number): Promise<{
    kickNumber: number; teamId: number; scored: boolean; playerName: string | null;
  }[]> {
    const rows = await db.execute(sql`
      SELECT
        k.kick_number AS kick_number,
        k.team_id     AS team_id,
        k.scored      AS scored,
        -- Only ever publicly name a child for a SCORED penalty — never for a
        -- miss (mirrors the own-goal suppression rule).
        CASE WHEN k.scored AND p.id IS NOT NULL
             THEN (p.first_name || ' ' || p.last_name) ELSE NULL END AS player_name
      FROM tournament_penalty_kicks k
      LEFT JOIN tournament_players p ON p.id = k.player_id
      WHERE k.game_id = ${gameId}
      ORDER BY k.kick_number ASC
    `);
    return (rows as any).rows.map((r: any) => ({
      kickNumber: r.kick_number,
      teamId: r.team_id,
      scored: r.scored,
      playerName: r.player_name,
    }));
  }

  async getTournamentDiscipline(tournamentId: number): Promise<DisciplineRow[]> {
    // Card totals per player PLUS computed suspensions with the exact game each
    // suspended player misses. Rules: a red card = miss the team's next game;
    // every 2nd yellow (2,4,6…) accumulated = miss the team's next game. The
    // "next game" is resolved from the team's own fixtures in chronological order.
    const YELLOW_BAN_EVERY = 2;

    // Games (for fixtures + chronology) + team names (for opponent labels).
    const games = await db.select().from(tournamentGames).where(eq(tournamentGames.tournamentId, tournamentId));
    const teams = await db.select({ id: tournamentTeams.id, name: tournamentTeams.name })
      .from(tournamentTeams).where(eq(tournamentTeams.tournamentId, tournamentId));
    const teamName = new Map<number, string>(teams.map(t => [t.id, t.name]));

    // Chronological order key: date → time → game number (zero-padded, stable).
    const orderKey = (g: any) =>
      `${g.gameDate || "9999-99-99"} ${g.startTime || "99:99"} ${String(g.gameNumber ?? 999999).padStart(6, "0")}`;
    const orderOf = new Map<number, string>(games.map(g => [g.id, orderKey(g)]));

    // Per-team fixtures, sorted chronologically.
    const teamFixtures = new Map<number, any[]>();
    for (const g of games) {
      for (const tid of [g.homeTeamId, g.awayTeamId]) {
        if (!tid) continue;
        if (!teamFixtures.has(tid)) teamFixtures.set(tid, []);
        teamFixtures.get(tid)!.push(g);
      }
    }
    for (const arr of teamFixtures.values()) arr.sort((a, b) => orderKey(a).localeCompare(orderKey(b)));

    // The team's first fixture strictly AFTER a given game (by order key).
    const nextFixtureAfter = (teamId: number, afterGameId: number) => {
      const fixtures = teamFixtures.get(teamId) || [];
      const after = orderOf.get(afterGameId) || "";
      const g = fixtures.find(f => (orderOf.get(f.id) || "").localeCompare(after) > 0);
      if (!g) return null;
      const oppId = g.homeTeamId === teamId ? g.awayTeamId : g.homeTeamId;
      const opponent = (oppId && teamName.get(oppId)) || g.homeTeamPlaceholder || g.awayTeamPlaceholder || "TBD";
      return {
        gameId: g.id, gameNumber: g.gameNumber, opponent,
        gameDate: g.gameDate, startTime: g.startTime, field: g.field, stageDetail: g.stageDetail,
      };
    };

    // All cards joined to player + team.
    const cardRows = (await db.execute(sql`
      SELECT
        cd.id AS id, cd.game_id AS game_id, cd.card_type AS card_type,
        p.id AS player_id, (p.first_name || ' ' || p.last_name) AS player_name, p.shirt_number AS shirt_number,
        t.id AS team_id, t.name AS team_name, COALESCE(t.logo_url, c.logo_url) AS team_logo_url
      FROM tournament_cards cd
      JOIN tournament_games games ON games.id = cd.game_id
      JOIN tournament_players p   ON p.id = cd.player_id
      JOIN tournament_teams t     ON t.id = cd.team_id
      LEFT JOIN clubs c           ON c.id = t.club_id
      WHERE games.tournament_id = ${tournamentId}
    `) as any).rows as any[];

    // Group by player.
    const byPlayer = new Map<number, DisciplineRow & { _cards: any[] }>();
    for (const r of cardRows) {
      let row = byPlayer.get(r.player_id);
      if (!row) {
        row = {
          playerId: r.player_id, playerName: r.player_name, shirtNumber: r.shirt_number,
          teamId: r.team_id, teamName: r.team_name, teamLogoUrl: r.team_logo_url,
          yellows: 0, reds: 0, suspensions: [], _cards: [],
        };
        byPlayer.set(r.player_id, row);
      }
      row._cards.push(r);
      if (r.card_type === "yellow") row.yellows++; else if (r.card_type === "red") row.reds++;
    }

    // Walk each player's cards in chronological order → suspensions.
    const gameLabel = (gameId: number) => {
      const g = games.find(x => x.id === gameId);
      return g ? `Game ${g.gameNumber ?? gameId}` : `Game ${gameId}`;
    };
    const out: DisciplineRow[] = [];
    for (const row of byPlayer.values()) {
      const cards = row._cards.sort((a, b) => (orderOf.get(a.game_id) || "").localeCompare(orderOf.get(b.game_id) || ""));
      let yellowCount = 0;
      const suspensions: Suspension[] = [];
      for (const cd of cards) {
        if (cd.card_type === "red") {
          suspensions.push({ reason: "red", triggerGameId: cd.game_id, triggerGameLabel: gameLabel(cd.game_id), missesGame: nextFixtureAfter(row.teamId, cd.game_id) });
        } else if (cd.card_type === "yellow") {
          yellowCount++;
          if (yellowCount % YELLOW_BAN_EVERY === 0) {
            suspensions.push({ reason: "two_yellows", triggerGameId: cd.game_id, triggerGameLabel: gameLabel(cd.game_id), missesGame: nextFixtureAfter(row.teamId, cd.game_id) });
          }
        }
      }
      const { _cards, ...clean } = row;
      out.push({ ...clean, suspensions });
    }

    // Suspended players first (by their earliest missed game), then most cards.
    const firstMissKey = (r: DisciplineRow) => {
      const withGame = r.suspensions.map(s => s.missesGame).filter(Boolean) as NonNullable<Suspension["missesGame"]>[];
      if (withGame.length === 0) return "~"; // no scheduled miss → sort after
      return withGame.map(g => `${g.gameDate || "9999"} ${g.startTime || "99:99"}`).sort()[0];
    };
    out.sort((a, b) => {
      const aSusp = a.suspensions.length > 0, bSusp = b.suspensions.length > 0;
      if (aSusp !== bSusp) return aSusp ? -1 : 1;
      if (aSusp && bSusp) { const k = firstMissKey(a).localeCompare(firstMissKey(b)); if (k) return k; }
      if (b.reds !== a.reds) return b.reds - a.reds;
      if (b.yellows !== a.yellows) return b.yellows - a.yellows;
      return a.playerName.localeCompare(b.playerName);
    });
    return out;
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

  // ── USG Studio ──────────────────────────────────────────────────────────
  async getOrgBrandContext(orgId: number): Promise<OrgBrandContext | undefined> {
    const [r] = await db.select().from(orgBrandContext).where(eq(orgBrandContext.organizationId, orgId));
    return r;
  }
  async getOrgBrandContextByBrandId(brandId: string): Promise<OrgBrandContext | undefined> {
    const [r] = await db.select().from(orgBrandContext).where(eq(orgBrandContext.brandId, brandId));
    return r;
  }

  async createStudioDocument(data: Omit<typeof studioDocuments.$inferInsert, "token"> & { token?: string }): Promise<StudioDocument> {
    // Unguessable share link — same mechanic as esignSigners.token.
    const token = data.token || crypto.randomBytes(24).toString("base64url");
    const [r] = await db.insert(studioDocuments).values({ ...data, token }).returning();
    return r;
  }
  async getStudioDocumentById(id: number): Promise<StudioDocument | undefined> {
    const [r] = await db.select().from(studioDocuments).where(eq(studioDocuments.id, id));
    return r;
  }
  async getStudioDocumentByToken(token: string): Promise<StudioDocument | undefined> {
    const [r] = await db.select().from(studioDocuments).where(eq(studioDocuments.token, token));
    return r;
  }
  async listStudioDocuments(orgId: number): Promise<StudioDocument[]> {
    return db.select().from(studioDocuments)
      .where(eq(studioDocuments.organizationId, orgId))
      .orderBy(desc(studioDocuments.updatedAt));
  }
  async updateStudioDocument(id: number, data: Partial<typeof studioDocuments.$inferInsert>): Promise<StudioDocument | undefined> {
    const [r] = await db.update(studioDocuments)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(studioDocuments.id, id)).returning();
    return r;
  }

  private async nextStudioVersionInt(documentId: number): Promise<number> {
    const [row] = await db.select({ max: sql<number>`COALESCE(MAX(${studioDocumentVersions.versionInt}), 0)` })
      .from(studioDocumentVersions)
      .where(eq(studioDocumentVersions.documentId, documentId));
    return Number(row?.max ?? 0) + 1;
  }

  async createStudioDocumentVersion(
    documentId: number,
    contentJson: Record<string, any>,
    createdBy: number,
    opts?: { label?: string; editOps?: Record<string, any> | null },
  ): Promise<StudioDocumentVersion> {
    const versionInt = await this.nextStudioVersionInt(documentId);
    const [r] = await db.insert(studioDocumentVersions).values({
      documentId, versionInt, contentJson,
      editOps: opts?.editOps ?? null, label: opts?.label ?? null, createdBy,
    }).returning();
    return r;
  }

  async publishStudioDocument(id: number, userId: number, label?: string): Promise<StudioDocument | undefined> {
    const doc = await this.getStudioDocumentById(id);
    if (!doc) return undefined;
    // Snapshot the exact content being published + freeze its hash.
    const hash = contentHashOf(doc.contentJson);
    await this.createStudioDocumentVersion(id, doc.contentJson as Record<string, any>, userId, { label: label ?? "publish" });
    const [r] = await db.update(studioDocuments).set({
      status: "published",
      contentHash: hash,
      publishedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(studioDocuments.id, id)).returning();
    return r;
  }

  async rollbackStudioDocument(id: number, versionInt: number, userId: number): Promise<StudioDocument | undefined> {
    const doc = await this.getStudioDocumentById(id);
    if (!doc) return undefined;
    const [ver] = await db.select().from(studioDocumentVersions)
      .where(and(eq(studioDocumentVersions.documentId, id), eq(studioDocumentVersions.versionInt, versionInt)));
    if (!ver) return undefined;
    const content = ver.contentJson as Record<string, any>;
    // Restoring a snapshot is itself a new version (never lose history).
    await this.createStudioDocumentVersion(id, content, userId, { label: `rollback to v${versionInt}` });
    const [r] = await db.update(studioDocuments).set({
      contentJson: content,
      contentHash: contentHashOf(content),
      updatedAt: new Date(),
    }).where(eq(studioDocuments.id, id)).returning();
    return r;
  }

  async upsertStudioAnalyticsSession(input: {
    documentId: number; sessionId: string; visitorId?: string | null;
    engagedMsDelta?: number; maxScrollPct?: number; device?: string | null;
    userAgent?: string | null; referrer?: string | null; sourceTag?: string | null;
    utmJson?: Record<string, any> | null; country?: string | null; isInternal?: boolean;
  }): Promise<StudioAnalyticsSession> {
    // Read-modify-write keyed on (documentId, sessionId). No DB unique constraint
    // exists on that pair, so we can't use ON CONFLICT; beacons from a single tab
    // are effectively serialised (batched every ~5s) so contention is negligible.
    // TODO(studio): add a unique index on (document_id, session_id) in a later
    // migration to enable a true UPSERT and remove the read-modify-write race.
    const [existing] = await db.select().from(studioAnalyticsSessions)
      .where(and(
        eq(studioAnalyticsSessions.documentId, input.documentId),
        eq(studioAnalyticsSessions.sessionId, input.sessionId),
      ));

    const now = new Date();
    const engagedDelta = Math.max(0, Math.round(input.engagedMsDelta ?? 0));
    const scroll = Math.max(0, Math.min(100, Math.round(input.maxScrollPct ?? 0)));

    if (existing) {
      const [r] = await db.update(studioAnalyticsSessions).set({
        lastSeenAt: now,
        engagedMs: (existing.engagedMs ?? 0) + engagedDelta,
        maxScrollPct: Math.max(existing.maxScrollPct ?? 0, scroll),
        // adopt a stronger identity if it arrives later (e.g. usg_vid appears)
        visitorId: input.visitorId ?? existing.visitorId,
        device: existing.device ?? input.device ?? null,
        referrer: existing.referrer ?? input.referrer ?? null,
        country: existing.country ?? input.country ?? null,
        utmJson: input.utmJson ?? existing.utmJson,
        // once internal, stay internal
        isInternal: existing.isInternal || !!input.isInternal,
      }).where(eq(studioAnalyticsSessions.id, existing.id)).returning();
      return r;
    }

    const [r] = await db.insert(studioAnalyticsSessions).values({
      documentId: input.documentId,
      sessionId: input.sessionId,
      visitorId: input.visitorId ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
      engagedMs: engagedDelta,
      maxScrollPct: scroll,
      device: input.device ?? null,
      userAgent: input.userAgent ?? null,
      referrer: input.referrer ?? null,
      sourceTag: input.sourceTag ?? null,
      utmJson: input.utmJson ?? null,
      country: input.country ?? null,
      isInternal: !!input.isInternal,
    }).returning();
    return r;
  }

  async insertStudioAnalyticsEvents(batch: (typeof studioAnalyticsEvents.$inferInsert)[]): Promise<void> {
    if (!batch.length) return;
    await db.insert(studioAnalyticsEvents).values(batch);
  }

  // ── Signal aggregation reads ──────────────────────────────────────────────
  // Every query below EXCLUDES is_internal = true sessions (staff / author
  // previews) so the dashboard only ever shows real prospect engagement.

  async getStudioDocumentAnalytics(documentId: number): Promise<StudioDocumentOverview> {
    // Session-level rollup. unique visitors = distinct visitor_id, treating a null
    // visitor_id session as its own visitor so we never under-count.
    const agg = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total_sessions,
        COUNT(DISTINCT COALESCE(visitor_id, 'sid:' || session_id))::int AS unique_visitors,
        COALESCE(AVG(engaged_ms), 0) AS avg_engaged_ms,
        COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY engaged_ms), 0) AS median_engaged_ms,
        COALESCE(AVG(max_scroll_pct), 0) AS avg_scroll_pct,
        COUNT(*) FILTER (WHERE max_scroll_pct >= 50)::int AS scrolled_half,
        COUNT(*) FILTER (WHERE max_scroll_pct >= 98)::int AS reached_end,
        MIN(first_seen_at) AS first_activity,
        MAX(last_seen_at) AS last_activity
      FROM studio_analytics_sessions
      WHERE document_id = ${documentId} AND is_internal = false
    `);
    const a = (agg.rows[0] || {}) as any;

    const ret = await db.execute(sql`
      SELECT COUNT(*)::int AS returning FROM (
        SELECT visitor_id FROM studio_analytics_sessions
        WHERE document_id = ${documentId} AND is_internal = false AND visitor_id IS NOT NULL
        GROUP BY visitor_id HAVING COUNT(DISTINCT session_id) > 1
      ) t
    `);

    // CTA clicks come from events, scoped to non-internal sessions via a join.
    const cta = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE e.type = 'cta_click')::int AS cta_clicks,
        COUNT(DISTINCT e.session_id) FILTER (WHERE e.type = 'cta_click')::int AS cta_sessions
      FROM studio_analytics_events e
      JOIN studio_analytics_sessions s
        ON s.document_id = e.document_id AND s.session_id = e.session_id
      WHERE e.document_id = ${documentId} AND s.is_internal = false
    `);
    const c = (cta.rows[0] || {}) as any;

    const splitOf = async (col: "device" | "country" | "source_tag"): Promise<StudioKeyCount[]> => {
      const r = await db.execute(sql`
        SELECT COALESCE(${sql.raw(col)}, 'unknown') AS key, COUNT(*)::int AS count
        FROM studio_analytics_sessions
        WHERE document_id = ${documentId} AND is_internal = false
        GROUP BY 1 ORDER BY count DESC
      `);
      return (r.rows as any[]).map((x) => ({ key: String(x.key), count: Number(x.count) }));
    };
    const [deviceSplit, countrySplit, sourceSplit] = await Promise.all([
      splitOf("device"), splitOf("country"), splitOf("source_tag"),
    ]);

    return {
      uniqueVisitors: Number(a.unique_visitors ?? 0),
      totalSessions: Number(a.total_sessions ?? 0),
      returningVisitors: Number((ret.rows[0] as any)?.returning ?? 0),
      avgEngagedMs: Math.round(Number(a.avg_engaged_ms ?? 0)),
      medianEngagedMs: Math.round(Number(a.median_engaged_ms ?? 0)),
      avgScrollPct: Math.round(Number(a.avg_scroll_pct ?? 0)),
      ctaClicks: Number(c.cta_clicks ?? 0),
      ctaClickSessions: Number(c.cta_sessions ?? 0),
      reachedEndSessions: Number(a.reached_end ?? 0),
      scrolledHalfSessions: Number(a.scrolled_half ?? 0),
      deviceSplit, countrySplit, sourceSplit,
      firstActivityAt: a.first_activity ? new Date(a.first_activity).toISOString() : null,
      lastActivityAt: a.last_activity ? new Date(a.last_activity).toISOString() : null,
    };
  }

  async getStudioDocumentSessions(documentId: number): Promise<StudioSessionRow[]> {
    const r = await db.execute(sql`
      SELECT
        s.id, s.session_id, s.visitor_id, s.first_seen_at, s.last_seen_at,
        s.engaged_ms, s.max_scroll_pct, s.device, s.country, s.source_tag,
        (SELECT COUNT(*)::int FROM studio_analytics_events e
           WHERE e.document_id = s.document_id AND e.session_id = s.session_id
             AND e.type = 'cta_click') AS cta_clicks,
        (s.visitor_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM studio_analytics_sessions p
           WHERE p.document_id = s.document_id AND p.visitor_id = s.visitor_id
             AND p.is_internal = false AND p.first_seen_at < s.first_seen_at
        )) AS is_returning
      FROM studio_analytics_sessions s
      WHERE s.document_id = ${documentId} AND s.is_internal = false
      ORDER BY s.last_seen_at DESC
      LIMIT 500
    `);
    return (r.rows as any[]).map((x) => ({
      id: Number(x.id),
      sessionId: String(x.session_id),
      visitorId: x.visitor_id != null ? String(x.visitor_id) : null,
      firstSeenAt: new Date(x.first_seen_at).toISOString(),
      lastSeenAt: new Date(x.last_seen_at).toISOString(),
      engagedMs: Number(x.engaged_ms ?? 0),
      maxScrollPct: Number(x.max_scroll_pct ?? 0),
      device: x.device != null ? String(x.device) : null,
      country: x.country != null ? String(x.country) : null,
      sourceTag: x.source_tag != null ? String(x.source_tag) : null,
      ctaClicks: Number(x.cta_clicks ?? 0),
      isReturning: !!x.is_returning,
    }));
  }

  async getStudioSectionEngagement(documentId: number): Promise<StudioSectionEngagement> {
    const doc = await this.getStudioDocumentById(documentId);
    const blocks: Block[] = ((doc?.contentJson as any)?.blocks ?? []) as Block[];

    // Total non-internal sessions = the denominator for "% reached".
    const totRes = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM studio_analytics_sessions
      WHERE document_id = ${documentId} AND is_internal = false
    `);
    const totalSessions = Number((totRes.rows[0] as any)?.n ?? 0);

    // Per (block, session): summed dwell + whether it was touched. Then per block:
    // distinct sessions reached + median/avg of per-session dwell.
    const perBlock = await db.execute(sql`
      WITH per AS (
        SELECT e.block_id, e.session_id,
          COALESCE(SUM(e.dwell_ms) FILTER (WHERE e.type = 'section_exit'), 0) AS dwell_ms
        FROM studio_analytics_events e
        JOIN studio_analytics_sessions s
          ON s.document_id = e.document_id AND s.session_id = e.session_id
        WHERE e.document_id = ${documentId} AND s.is_internal = false
          AND e.block_id IS NOT NULL
          AND e.type IN ('section_enter', 'section_exit')
        GROUP BY e.block_id, e.session_id
      )
      SELECT block_id,
        COUNT(*)::int AS reached_sessions,
        COALESCE(AVG(dwell_ms), 0) AS avg_dwell_ms,
        COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dwell_ms), 0) AS median_dwell_ms
      FROM per
      GROUP BY block_id
    `);
    const byBlock = new Map<string, { reached: number; avg: number; median: number }>();
    for (const x of perBlock.rows as any[]) {
      byBlock.set(String(x.block_id), {
        reached: Number(x.reached_sessions ?? 0),
        avg: Math.round(Number(x.avg_dwell_ms ?? 0)),
        median: Math.round(Number(x.median_dwell_ms ?? 0)),
      });
    }

    const sections: StudioSectionRow[] = blocks.map((block) => {
      const stat = byBlock.get(block.id) ?? { reached: 0, avg: 0, median: 0 };
      const wordCount = blockWordCount(block);
      const reachedPct = totalSessions > 0 ? Math.round((stat.reached / totalSessions) * 100) : 0;
      const ratio = studioReadRatio(stat.median, wordCount);
      return {
        blockId: block.id,
        type: block.type,
        label: studioSectionLabel(block),
        wordCount,
        expectedReadMs: studioExpectedReadMs(wordCount),
        medianDwellMs: stat.median,
        avgDwellMs: stat.avg,
        reachedSessions: stat.reached,
        reachedPct,
        readRatio: ratio == null ? null : Math.round(ratio * 100) / 100,
        readClass: classifyRead(ratio, reachedPct),
      };
    });

    return { totalSessions, sections };
  }

  async getStudioHotLeads(orgId: number): Promise<StudioHotLead[]> {
    // Across this workspace's PUBLISHED docs: non-internal sessions active in the
    // last 48h, ranked by a blended score (engaged time + scroll depth + recency).
    const r = await db.execute(sql`
      SELECT
        d.id AS document_id, d.title, d.brand_id,
        COALESCE(d.source_tag, d.slug) AS partner,
        s.session_id, s.visitor_id, s.last_seen_at, s.engaged_ms, s.max_scroll_pct,
        s.device, s.country,
        (SELECT COUNT(*)::int FROM studio_analytics_events e
           WHERE e.document_id = s.document_id AND e.session_id = s.session_id
             AND e.type = 'cta_click') AS cta_clicks,
        (s.visitor_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM studio_analytics_sessions p
           WHERE p.document_id = s.document_id AND p.visitor_id = s.visitor_id
             AND p.is_internal = false AND p.first_seen_at < s.first_seen_at
        )) AS is_returning
      FROM studio_analytics_sessions s
      JOIN studio_documents d ON d.id = s.document_id
      WHERE d.organization_id = ${orgId} AND d.status = 'published'
        AND s.is_internal = false
        AND s.last_seen_at >= now() - interval '48 hours'
      ORDER BY (
        s.engaged_ms / 1000.0
        + s.max_scroll_pct
        + GREATEST(0, 2880 - EXTRACT(EPOCH FROM (now() - s.last_seen_at)) / 60)
      ) DESC
      LIMIT 30
    `);
    return (r.rows as any[]).map((x) => ({
      documentId: Number(x.document_id),
      title: String(x.title),
      brandId: String(x.brand_id),
      partner: x.partner != null ? String(x.partner) : null,
      sessionId: String(x.session_id),
      visitorId: x.visitor_id != null ? String(x.visitor_id) : null,
      lastSeenAt: new Date(x.last_seen_at).toISOString(),
      engagedMs: Number(x.engaged_ms ?? 0),
      maxScrollPct: Number(x.max_scroll_pct ?? 0),
      device: x.device != null ? String(x.device) : null,
      country: x.country != null ? String(x.country) : null,
      ctaClicks: Number(x.cta_clicks ?? 0),
      isReturning: !!x.is_returning,
    }));
  }

  // ── AttributionOS short links (T10) ────────────────────────────────────────

  async listShortLinks(orgId: number, opts?: { includeArchived?: boolean }): Promise<ShortLinkWithClicks[]> {
    const conds = [eq(shortLinks.organizationId, orgId)];
    if (!opts?.includeArchived) conds.push(eq(shortLinks.active, true));
    const links = await db
      .select()
      .from(shortLinks)
      .where(and(...conds))
      .orderBy(desc(shortLinks.createdAt));
    if (links.length === 0) return [];

    // Trailing-7-day counted (non-bot) clicks per link, one grouped query.
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({ linkId: linkClicks.linkId, n: sql<number>`count(*)::int` })
      .from(linkClicks)
      .where(and(
        inArray(linkClicks.linkId, links.map((l) => l.id)),
        eq(linkClicks.isBot, false),
        gt(linkClicks.createdAt, since),
      ))
      .groupBy(linkClicks.linkId);
    const last7d = new Map<number, number>();
    for (const r of rows) last7d.set(r.linkId, Number(r.n) || 0);

    return links.map((l) => ({ ...l, last7dClicks: last7d.get(l.id) ?? 0 }));
  }

  async getShortLink(id: number): Promise<ShortLink | undefined> {
    const [r] = await db.select().from(shortLinks).where(eq(shortLinks.id, id));
    return r;
  }

  async getShortLinkByKey(key: string): Promise<ShortLink | undefined> {
    const [r] = await db.select().from(shortLinks).where(eq(shortLinks.key, key));
    return r;
  }

  async createShortLink(data: InsertShortLink): Promise<ShortLink> {
    const [r] = await db.insert(shortLinks).values(data).returning();
    return r;
  }

  async updateShortLink(id: number, data: Partial<InsertShortLink>): Promise<ShortLink | undefined> {
    const [r] = await db.update(shortLinks).set(data).where(eq(shortLinks.id, id)).returning();
    return r;
  }

  async getShortLinkStats(linkId: number, days: number): Promise<ShortLinkStats> {
    const windowDays = Math.max(1, Math.min(365, Math.floor(days) || 30));
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    // NZ-local daily click series (never toISOString for NZ dates — group on the
    // Pacific/Auckland-local calendar date).
    const dayRows = await db
      .select({
        date: sql<string>`to_char(${linkClicks.createdAt} AT TIME ZONE 'Pacific/Auckland', 'YYYY-MM-DD')`,
        clicks: sql<number>`count(*)::int`,
      })
      .from(linkClicks)
      .where(and(
        eq(linkClicks.linkId, linkId),
        eq(linkClicks.isBot, false),
        gt(linkClicks.createdAt, since),
      ))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const dailyClicks = dayRows.map((r) => ({ date: r.date, clicks: Number(r.clicks) || 0 }));
    const totalClicks = dailyClicks.reduce((s, d) => s + d.clicks, 0);

    // Conversions attributed to THIS link = conversion rows whose click_id was
    // one of the link's minted (non-bot) click ids. One CTE feeds every table so
    // it's a single round-trip. Kinds mark revenue (sale) vs lead surfaces.
    const SOURCES: Array<{ table: string; kind: "lead" | "sale" }> = [
      { table: "registrations", kind: "sale" },
      { table: "cugc_registrations", kind: "sale" },
      { table: "print_orders", kind: "sale" },
      { table: "league_waitlist", kind: "lead" },
      { table: "cugc_free_sessions", kind: "lead" },
      { table: "cic7s_registrations", kind: "lead" },
      { table: "football_institute_applications", kind: "lead" },
      { table: "booking_requests", kind: "lead" },
    ];
    const unions = SOURCES.map(
      (s) => sql`select ${s.table} as source, count(*)::int as n from ${sql.raw(s.table)} where click_id in (select click_id from cids)`,
    );
    const convSql = sql`with cids as (select click_id from link_clicks where link_id = ${linkId} and is_bot = false and click_id is not null) ${sql.join(unions, sql` union all `)}`;
    const convRes = await db.execute(convSql);
    const countBySource = new Map<string, number>();
    for (const row of (convRes.rows as Array<{ source: string; n: number }>)) {
      countBySource.set(row.source, Number(row.n) || 0);
    }

    const conversions = SOURCES.map((s) => ({
      source: s.table,
      kind: s.kind,
      count: countBySource.get(s.table) ?? 0,
    }));
    const totalLeads = conversions.filter((c) => c.kind === "lead").reduce((s, c) => s + c.count, 0);
    const totalSales = conversions.filter((c) => c.kind === "sale").reduce((s, c) => s + c.count, 0);

    return {
      linkId,
      days: windowDays,
      totalClicks,
      totalConversions: totalLeads + totalSales,
      totalLeads,
      totalSales,
      dailyClicks,
      conversions,
    };
  }
}

// A short human label for a content block (first prose string, else the type).
function studioSectionLabel(block: Block): string {
  const first = collectBlockStrings(block).find((s) => s && s.trim().length > 0);
  if (first) return first.trim().replace(/\s+/g, " ").slice(0, 60);
  return block.type.replace(/_/g, " ");
}

export const storage = new DatabaseStorage();
