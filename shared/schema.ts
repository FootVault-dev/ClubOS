import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, bigint, boolean, timestamp, date, decimal, doublePrecision, pgEnum, uniqueIndex, unique, index, time, jsonb, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const roleEnum = pgEnum("role_type", ["super_admin", "admin", "team_member", "manager", "coach", "finance", "marketing", "registrar"]);
export const contactTypeEnum = pgEnum("contact_type", ["player", "guardian", "staff", "volunteer", "sponsor"]);
export const genderEnum = pgEnum("gender_type", ["male", "female", "other"]);
export const programTypeEnum = pgEnum("program_type", ["holiday_camp", "academy", "trials", "event", "open_training", "league_team"]);
export const registrationStatusEnum = pgEnum("registration_status", ["pending", "confirmed", "waitlisted", "cancelled", "refunded", "partially_refunded"]);
export const invoiceStatusEnum = pgEnum("invoice_status", ["draft", "sent", "paid", "overdue", "refunded"]);
export const facilityTypeEnum = pgEnum("facility_type", ["field", "mini_pitch", "meeting_room", "changing_room", "futsal", "court", "other"]);
export const bookingStatusEnum = pgEnum("booking_status", ["confirmed", "paid", "pending", "cancelled"]);

export const organizations = pgTable("organizations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logoUrl: text("logo_url"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const userOrganizations = pgTable("user_organizations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  role: roleEnum("role").notNull().default("admin"),
  // Tab access whitelist. null = full access (legacy/admin behaviour).
  // [] = no tabs (effectively no access in workspace).
  // ["calendar", "projects"] = whitelist of tab slugs (see shared/tabs.ts).
  tabs: jsonb("tabs").$type<string[] | null>(),
});

export const users = pgTable("users", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  email: text("email").notNull().unique(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  password: text("password").notNull(),
  // Google OAuth — null for password-only users; populated on first
  // Google sign-in. Lets us match returning Google users by stable subject ID
  // even if they change email.
  googleId: text("google_id").unique(),
  // Apple Sign-In — same pattern as googleId. Populated on first Apple
  // sign-in with the `sub` claim from the verified identity token. Stable
  // across email changes and "Hide My Email" relay swaps.
  appleId: text("apple_id").unique(),
  role: roleEnum("role").notNull().default("coach"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Self-service password reset. A user requests a reset, we email them a
// one-time link carrying a random token; only the SHA-256 hash is stored here
// (never the raw token), so a DB leak can't be replayed. Single-use (usedAt)
// and short-lived (expiresAt). Rows are disposable — cascade-deleted with the
// user and safe to prune once used/expired.
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  // timestamptz so expiry/throttle comparisons against Date.now() are correct
  // regardless of the server's local timezone (the box runs NZ time).
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const contacts = pgTable("contacts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  type: contactTypeEnum("type").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  alternatePhone: text("alternate_phone"),
  gender: genderEnum("gender"),
  dateOfBirth: date("date_of_birth"),
  address: text("address"),
  nationality: text("nationality"),
  school: text("school"),
  schoolYear: text("school_year"),
  medicalNotes: text("medical_notes"),
  allergies: text("allergies"),
  emergencyContact: text("emergency_contact"),
  emergencyPhone: text("emergency_phone"),
  photoConsent: boolean("photo_consent").default(false),
  medicalConsent: boolean("medical_consent").default(false),
  newsletterConsent: boolean("newsletter_consent").default(true),
  previousClub: text("previous_club"),
  teamName: text("team_name"),
  tags: text("tags"),
  notes: text("notes"),
  // ── NZ Football / Mainland Football registration audit fields ──────────────
  // Required by NZF's National Registration System (Sporty). Friendly Manager
  // collects exactly these today; ClubOS could not, which would have made the
  // annual Mainland Football database audit impossible to satisfy from ClubOS.
  // Free text, not enums — Sporty's accepted vocabulary is not yet confirmed
  // (validated in the app against shared/academy.ts NZF_ETHNICITIES).
  countryOfBirth: text("country_of_birth"),
  placeOfBirth: text("place_of_birth"),
  ethnicity: text("ethnicity"),
  subEthnicity: text("sub_ethnicity"),       // specific ethnic group / iwi
  ethnicity2: text("ethnicity2"),            // optional second ethnicity
  subEthnicity2: text("sub_ethnicity2"),
  // Reconciliation key for the Friendly Manager historical import, so a family
  // who registers online is not duplicated when the export lands.
  friendlyManagerId: text("friendly_manager_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const contactRelationships = pgTable("contact_relationships", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  guardianId: integer("guardian_id").notNull().references(() => contacts.id),
  playerId: integer("player_id").notNull().references(() => contacts.id),
  relationship: text("relationship").notNull().default("parent"),
  isPrimaryContact: boolean("is_primary_contact").default(true),
});

// Slug uniqueness is per-organization, NOT global. Different workspaces
// can each have their own 'recreational' or 'world-cup' program without
// colliding. Enforced by the programs_org_slug_unique constraint.
export const programs = pgTable("programs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  // CRITICAL: programs are org-scoped. Without this column declared on the
  // Drizzle schema, db.insert silently drops the field even though the DB
  // column exists, leading to programs with org_id=null that don't appear
  // in any workspace's program list (May 2026 incident). Every program
  // must be tied to an organisation.
  organizationId: integer("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug"),
  type: programTypeEnum("type").notNull(),
  description: text("description"),
  heroImage: text("hero_image"),
  // Wistia media id (e.g. '0l469en6m5'). When set, the public landing page
  // renders this video as the hero. Falls back to heroImage if null.
  heroVideoId: text("hero_video_id"),
  // Custom blocks rendered between the FAQ and footer on the public page.
  // Each block is { id, type: 'stats'|'features'|'cta', props: object }.
  // Designed to be append-only — the existing page template stays as-is,
  // blocks add custom sections without breaking the layout.
  customBlocksJson: jsonb("custom_blocks_json").default(sql`'[]'::jsonb`),
  location: text("location"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  bookingsOpenDate: date("bookings_open_date"),
  bookingsCloseDate: date("bookings_close_date"),
  includeWeekends: boolean("include_weekends").default(false),
  capacity: integer("capacity"),
  // Age GRADE bounds, not ages in years. NZF classifies by year of birth, so a
  // child born 2017 is U9 for the whole 2026 season. See shared/academy.ts.
  ageMin: integer("age_min"),
  ageMax: integer("age_max"),
  // ── Academy (2026-07-09) ───────────────────────────────────────────────────
  // 'core' (FUNiño / Pre-Academy / Academy — the training pathway) vs
  // 'additional' (Technification, Goalkeeper, Morning Programme). Long present
  // in the prod DB via raw SQL in server/seed.ts but never mirrored here, which
  // made it invisible to Drizzle and a `db:push` casualty. Now declared.
  academySection: text("academy_section"),
  seasonYear: integer("season_year"),
  // Open for online self-registration. Distinct from isActive (public
  // visibility): a programme can be described publicly while closed to signups.
  // Defaults FALSE so a newly seeded programme can never take money by accident.
  registrationOpen: boolean("registration_open").notNull().default(false),
  fee: decimal("fee", { precision: 10, scale: 2 }),
  fullDayCost: decimal("full_day_cost", { precision: 10, scale: 2 }),
  heroHeadline: text("hero_headline"),
  heroSubheadline: text("hero_subheadline"),
  descriptionShort: text("description_short"),
  descriptionLong: text("description_long"),
  whatToBring: text("what_to_bring"),
  inclusions: text("inclusions"),
  refundPolicy: text("refund_policy"),
  contactEmail: text("contact_email"),
  primaryCta: text("primary_cta").default("Book Now"),
  faqJson: text("faq_json"),
  pageContentJson: text("page_content_json"),

  // Schedule binding — tells the system how this program's calendar relates
  // to the workspace's terms. Term-bound programs auto-populate their
  // start/end from the term they reference. holidayWindow is a string token
  // like '2026-spring' so we can recompute holiday windows from terms.
  scheduleType: text("schedule_type"),  // 'term' | 'holiday' | 'custom' | 'event'
  termId: integer("term_id"),            // → terms.id (when scheduleType = 'term')
  holidayWindow: text("holiday_window"), // e.g. '2026-spring' (when scheduleType = 'holiday')
  sessionCount: integer("session_count"),  // weeks/sessions in the term (default 10 for NZ)

  // Pricing model — 'flat' is the legacy single-fee behaviour. 'term_prorated'
  // discounts based on sessions remaining in the term. 'per_day' is for
  // holiday camps where customers pick which days they want.
  pricingModel: text("pricing_model").default("flat"),
  termPriceCents: integer("term_price_cents"),  // full term price in cents

  // Weekly recurring pattern for term-mode programs — JSON array of slots:
  //   [{ daysOfWeek: number[], startTime: "HH:MM", endTime: "HH:MM",
  //      capacity: number, name?: string }]
  // Persisted so admins can re-generate sessions after editing the term
  // (e.g. when a term's date range changes) without re-typing the schedule.
  weeklyPatternJson: text("weekly_pattern_json"),

  // --- MFL team-registration (type = 'league_team') ---
  // A league_team program is the sellable "register your team" offering that
  // wraps a single league competition. The captain picks a division (night/
  // format) inside the registration form; division pricing lives on
  // leagueDivisions.teamCostCents. These columns are null for camps/academy.
  leagueCompetitionId: integer("league_competition_id").references(() => leagueCompetitions.id, { onDelete: "set null" }),
  // Early-bird urgency: after this date a late fee is added to the order.
  earlyBirdDeadline: date("early_bird_deadline"),
  lateFeeCents: integer("late_fee_cents").default(0),
  // Optional checkout upsells: JSON array [{ type, label, priceCents }]
  // e.g. [{type:'referee',label:'Qualified referee (season)',priceCents:8000}].
  upsellsJson: jsonb("upsells_json").default(sql`'[]'::jsonb`),
  // Instalment: deposit taken now; balance charged off-session on the due date.
  depositCents: integer("deposit_cents"),
  // Payment plan for the league_team offering:
  //   'installment'    = deposit now + ONE balance charge on balanceDueDate.
  //   'deposit_weekly' = deposit now (covers the final weeks) + `numWeeklyPayments`
  //                      weekly auto-charges anchored to the competition start.
  paymentPlan: text("payment_plan").default("installment"),
  numWeeklyPayments: integer("num_weekly_payments").default(8),
  // Split Pay rollout flag — when true the public register page offers "Split
  // across my squad". Default false so the feature only appears where explicitly
  // enabled (the test program first; real Term 3 once a live charge is validated).
  splitEnabled: boolean("split_enabled").default(false),

  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
// Note: "one league_team program per competition" is enforced at the
// application layer (the settings-upsert requires a slug, and programs.slug is
// already unique per org — so a concurrent double-create collides on slug and
// the handler re-fetches + updates instead). A typed Drizzle unique index on
// leagueCompetitionId can't be used here because that column forward-references
// leagueCompetitions (defined later), which breaks schema type inference.

// Program options — priced packages a customer can pick from on the public
// landing page. One Beginner program can have:
//   1) Thursday only — $295/term
//   2) Saturday only (with ballet) — $350/term
//   3) Both days combo — $565/term, weekly pay available
// Each option has its own schedule_text (free-form, displayed to parents),
// price, and (for combos / large totals) an opt-in weekly Stripe sub
// option that breaks the term price into N weekly installments.
export const programOptions = pgTable("program_options", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  programId: integer("program_id").notNull().references(() => programs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  scheduleText: text("schedule_text"),  // e.g. "Thursdays 4-6pm" — shown to parents
  fullPriceCents: integer("full_price_cents").notNull(),
  pricingModel: text("pricing_model").notNull().default("term_prorated"),  // 'flat' | 'term_prorated'
  sessionCount: integer("session_count"),  // overrides program.sessionCount when set
  allowPayWeekly: boolean("allow_pay_weekly").notNull().default(false),
  weeklyPriceCents: integer("weekly_price_cents"),  // computed if null
  displayOrder: integer("display_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertProgramOptionSchema = createInsertSchema(programOptions).omit({ id: true, createdAt: true });
export type InsertProgramOption = z.infer<typeof insertProgramOptionSchema>;
export type ProgramOption = typeof programOptions.$inferSelect;

// School/program terms — org-scoped so each workspace can manage its own
// calendar (NZ school terms for gymnastics, OFC season blocks for football,
// etc.). One row per (org, year, termNumber) so an org can never have two
// "Term 2 2026" rows.
export const terms = pgTable("terms", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  year: integer("year").notNull(),
  termNumber: integer("term_number").notNull(),
  name: text("name"),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uniqueOrgYearTerm: unique().on(t.organizationId, t.year, t.termNumber),
}));

export const programSessions = pgTable("program_sessions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  programId: integer("program_id").notNull().references(() => programs.id),
  name: text("name").notNull(),
  date: date("date").notNull(),
  startTime: text("start_time"),
  endTime: text("end_time"),
  venue: text("venue"),
  rollTaker: text("roll_taker"),
  cost: decimal("cost", { precision: 10, scale: 2 }),
  capacity: integer("capacity"),
});

export const sessionBookings = pgTable("session_bookings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  sessionId: integer("session_id").notNull().references(() => programSessions.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => contacts.id),
  attended: boolean("attended").default(false),
  paid: boolean("paid").default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const programDiscounts = pgTable("program_discounts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  programId: integer("program_id").notNull().references(() => programs.id, { onDelete: "cascade" }),
  minBookings: integer("min_bookings").notNull(),
  discountPercent: decimal("discount_percent", { precision: 5, scale: 2 }).notNull(),
});

export const registrations = pgTable("registrations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderNumber: integer("order_number"),
  programId: integer("program_id").notNull().references(() => programs.id),
  contactId: integer("contact_id").notNull().references(() => contacts.id),
  guardianId: integer("guardian_id").references(() => contacts.id),
  status: registrationStatusEnum("status").notNull().default("pending"),
  amountPaid: decimal("amount_paid", { precision: 10, scale: 2 }).default("0"),
  notes: text("notes"),
  source: text("source"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  fbclid: text("fbclid"),
  gclid: text("gclid"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  subtotalCents: integer("subtotal_cents"),
  discountCents: integer("discount_cents").default(0),
  discountCode: text("discount_code"),
  discountId: integer("discount_id"),
  totalCents: integer("total_cents"),
  currency: text("currency").default("NZD"),
  registrationLocation: text("registration_location").default("online"),
  referralSource: text("referral_source"),
  // Class registrations may pick a specific program option (e.g. Beginner
  // Thursday vs Beginner Combo) and a payment mode (upfront vs weekly sub).
  programOptionId: integer("program_option_id"),
  paymentMode: text("payment_mode"),  // 'upfront' | 'weekly' | 'installment'
  stripeSubscriptionId: text("stripe_subscription_id"),

  // --- MFL team registration ---
  // The division (league night/format) the captain bought into, and the team
  // name typed at registration. The leagueTeam row is materialised on payment.
  leagueDivisionId: integer("league_division_id").references(() => leagueDivisions.id, { onDelete: "set null" }),
  teamName: text("team_name"),
  // Multi-team "stack & save" orders: every team registered in one checkout
  // shares this group id and a single deposit PaymentIntent. Null for a normal
  // single-team registration.
  registrationGroupId: text("registration_group_id"),
  // Instalment state (paymentMode = 'installment'): deposit now + off-session
  // balance charge on balanceDueDate. balanceStatus drives the balance cron.
  depositCents: integer("deposit_cents"),
  balanceCents: integer("balance_cents"),
  balanceDueDate: date("balance_due_date"),
  balanceStatus: text("balance_status").default("none"),  // 'none'|'scheduled'|'charging'|'paid'|'failed'
  balancePaymentIntentId: text("balance_payment_intent_id"),
  balanceAttempts: integer("balance_attempts").default(0),
  // Set when a balance charge is claimed ('charging'). Used to detect and
  // recover stale charges after a lost/late Stripe webhook.
  balanceChargeStartedAt: timestamp("balance_charge_started_at"),
  // Card-on-file for the off-session balance charge.
  stripeCustomerId: text("stripe_customer_id"),
  stripePaymentMethodId: text("stripe_payment_method_id"),
  // Deposit-weekly plan (paymentMode = 'deposit_weekly'): the saved card is
  // billed weeklyAmountCents per week via a Stripe subscription. weeksPaid is
  // advanced by the invoice.paid webhook; when it reaches weeksTotal the
  // registration is fully paid (deposit + all weeks).
  weeklyAmountCents: integer("weekly_amount_cents"),
  weeksPaid: integer("weeks_paid").default(0),
  weeksTotal: integer("weeks_total"),
  refundedAt: timestamp("refunded_at"),
  refundedAmountCents: integer("refunded_amount_cents"),
  refundReason: text("refund_reason"),
  refundedBy: integer("refunded_by"),
  stripeRefundId: text("stripe_refund_id"),
  stripeRefundStatus: text("stripe_refund_status"),
  // ── AttributionOS (additive, T3) — HDYHAU reuses referral_source above ──────
  visitorId: text("visitor_id"),
  clickId: text("click_id"),
  personId: integer("person_id"),
  fbp: text("fbp"),
  fbc: text("fbc"),
  metaAdId: text("meta_ad_id"),
  metaAdsetId: text("meta_adset_id"),
  metaCampaignId: text("meta_campaign_id"),
  metaPlatform: text("meta_platform"),
  attributionChannel: text("attribution_channel"),
  // ── Academy (2026-07-09) ───────────────────────────────────────────────────
  // Evidence of consent at the moment of payment: which policy, and when. A
  // tick-box with no version is not evidence.
  policyAcceptedAt: timestamp("policy_accepted_at", { withTimezone: true }),
  policyVersion: text("policy_version"),
  nzfConsentAt: timestamp("nzf_consent_at", { withTimezone: true }),
  // 'term' | 'year'. The full-year plan earns the policy's 5% training-fee
  // discount and is only offered on core academy programmes.
  academyPaymentPlan: text("academy_payment_plan"),
  seasonYear: integer("season_year"),
  // Provenance. NULL = created in ClubOS. 'friendly_manager' = imported.
  legacySource: text("legacy_source"),
  legacyExternalId: text("legacy_external_id"),
  registeredAt: timestamp("registered_at").defaultNow().notNull(),
});

export const campPricing = pgTable("camp_pricing", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  campId: integer("camp_id").notNull().references(() => programs.id, { onDelete: "cascade" }),
  productType: text("product_type").notNull(),
  priceCents: integer("price_cents").notNull(),
  currency: text("currency").notNull().default("NZD"),
});

export const campDates = pgTable("camp_dates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  campId: integer("camp_id").notNull().references(() => programs.id, { onDelete: "cascade" }),
  date: date("date").notNull(),
  capacityFullDay: integer("capacity_full_day"),
  capacityMorning: integer("capacity_morning"),
  capacityAfternoon: integer("capacity_afternoon"),
  // Class-mode (term programs run weekly): simple start/end time on the
  // session row. NULL on holiday-camp dates which use the morning/afternoon
  // capacity model instead.
  startTime: text("start_time"),
  endTime: text("end_time"),
  // Optional human label for the slot — e.g. "Age 4-6", "Age 7-8" for
  // age-split Saturday sessions. Lets a single program run multiple slots
  // on the same day with different rolls.
  name: text("name"),
});

export const campSettings = pgTable("camp_settings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  campId: integer("camp_id").notNull().unique().references(() => programs.id, { onDelete: "cascade" }),
  confirmationEmailSubject: text("confirmation_email_subject"),
  confirmationEmailBody: text("confirmation_email_body"),
  fromEmail: text("from_email"),
  replyTo: text("reply_to"),
});

export const children = pgTable("children", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  parentId: integer("parent_id").notNull().references(() => contacts.id),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  dateOfBirth: date("date_of_birth"),
  gender: text("gender"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const childMedical = pgTable("child_medical", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  childId: integer("child_id").notNull().unique().references(() => children.id, { onDelete: "cascade" }),
  allergies: text("allergies"),
  epiPen: boolean("epi_pen").default(false),
  notes: text("notes"),
});

export const registrationItems = pgTable("registration_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  registrationId: integer("registration_id").notNull().references(() => registrations.id, { onDelete: "cascade" }),
  // childId/campDateId are camp-specific (one line per child per camp day) and
  // are NULL for non-camp line items such as MFL upsells and late fees, which
  // carry their own priceCents + label instead.
  childId: integer("child_id").references(() => children.id),
  campDateId: integer("camp_date_id").references(() => campDates.id),
  productType: text("product_type").notNull(),  // camps: MORNING|AFTERNOON|FULL_DAY · MFL: team_fee|referee|photo_pack|late_fee
  // Self-contained price + label for non-camp line items (MFL add-ons/fees).
  priceCents: integer("price_cents"),
  label: text("label"),
  refundedAmountCents: integer("refunded_amount_cents"),
});

export const attendance = pgTable("attendance", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  campId: integer("camp_id").notNull().references(() => programs.id),
  campDateId: integer("camp_date_id").notNull().references(() => campDates.id),
  childId: integer("child_id").notNull().references(() => children.id),
  checkedInAt: timestamp("checked_in_at"),
  checkedOutAt: timestamp("checked_out_at"),
  checkedInByUserId: integer("checked_in_by_user_id").references(() => users.id),
  checkedOutByUserId: integer("checked_out_by_user_id").references(() => users.id),
  note: text("note"),
});

export const emailLogs = pgTable("email_logs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  campId: integer("camp_id").references(() => programs.id),
  registrationId: integer("registration_id").references(() => registrations.id),
  toEmail: text("to_email").notNull(),
  subject: text("subject"),
  body: text("body"),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
  providerMessageId: text("provider_message_id"),
});

export const metaEventLogs = pgTable("meta_event_logs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  campId: integer("camp_id").references(() => programs.id),
  registrationId: integer("registration_id").references(() => registrations.id),
  eventName: text("event_name").notNull(),
  payloadJson: text("payload_json"),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
  success: boolean("success").default(false),
});

export const emailCampaigns = pgTable("email_campaigns", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  fromEmail: text("from_email").notNull(),
  replyTo: text("reply_to"),
  segmentType: text("segment_type").notNull(),
  segmentConfig: text("segment_config"),
  recipientCount: integer("recipient_count").default(0),
  sentCount: integer("sent_count").default(0),
  failedCount: integer("failed_count").default(0),
  status: text("status").notNull().default("draft"),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── League Builders (referral / affiliate rewards) ──────────────────────────
// Opt-in: a member joins → gets a personal stackable 10% discount code + invite
// link. Referred teams' confirmed registrations award Builder Points (+3 first
// league per referred captain, +1 each extra) and accrue ACCOUNT CREDIT (cash-
// equivalent commission at the builder's tier) toward their own fees.
export const rewardBuilders = pgTable("reward_builders", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull(),
  contactId: integer("contact_id"),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  builderCode: text("builder_code").notNull(),   // the stackable 10% discount code
  discountId: integer("discount_id"),            // the discounts row backing the code
  inviteToken: text("invite_token").notNull(),   // public token for the share link + My Builder page
  points: integer("points").notNull().default(0),
  creditEarnedCents: integer("credit_earned_cents").notNull().default(0),
  creditUsedCents: integer("credit_used_cents").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  builderCodeUnq: uniqueIndex("reward_builders_code_unq").on(t.builderCode),
  inviteTokenUnq: uniqueIndex("reward_builders_invite_unq").on(t.inviteToken),
  orgEmailUnq: uniqueIndex("reward_builders_org_email_unq").on(t.organizationId, t.email),
}));

// Immutable ledger: every point/credit movement. One referral event per
// registration (unique registrationId) makes attribution idempotent.
export const rewardBuilderEvents = pgTable("reward_builder_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  builderId: integer("builder_id").notNull().references(() => rewardBuilders.id, { onDelete: "cascade" }),
  type: text("type").notNull(),  // 'referral_first' | 'referral_extra' | 'credit_used' | 'adjust'
  points: integer("points").notNull().default(0),
  commissionCents: integer("commission_cents").notNull().default(0),
  registrationId: integer("registration_id"),
  referredEmail: text("referred_email"),
  referredTeamName: text("referred_team_name"),
  tierAtEarning: text("tier_at_earning"),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  regUnq: uniqueIndex("reward_builder_events_reg_unq").on(t.registrationId),
}));

// ── Season Ticket Rewards (loyalty) ─────────────────────────────────────────
// A team (keyed by captain email) earns +3 Team XP per confirmed league signup.
// Crossing a tier unlocks a reward (auto-issued voucher code, or custom kit).
export const rewardSeasonMembers = pgTable("reward_season_members", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull(),
  contactId: integer("contact_id"),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  xp: integer("xp").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  orgEmailUnq: uniqueIndex("reward_season_org_email_unq").on(t.organizationId, t.email),
}));

// +3 XP per confirmed registration. Unique registration_id = idempotent accrual.
export const rewardSeasonEvents = pgTable("reward_season_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  memberId: integer("member_id").notNull().references(() => rewardSeasonMembers.id, { onDelete: "cascade" }),
  xp: integer("xp").notNull().default(0),
  registrationId: integer("registration_id"),
  teamName: text("team_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  regUnq: uniqueIndex("reward_season_events_reg_unq").on(t.registrationId),
}));

// One row per tier unlocked → the issued reward (voucher code or custom kit).
export const rewardSeasonRewards = pgTable("reward_season_rewards", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  memberId: integer("member_id").notNull().references(() => rewardSeasonMembers.id, { onDelete: "cascade" }),
  tier: text("tier").notNull(),
  rewardType: text("reward_type").notNull(),  // 'discount' | 'custom_kit'
  voucherCode: text("voucher_code"),
  discountId: integer("discount_id"),
  status: text("status").notNull().default("issued"),  // 'issued' | 'fulfilled'
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  memberTierUnq: uniqueIndex("reward_season_rewards_member_tier_unq").on(t.memberId, t.tier),
}));

// Referee Rewards — bonus tokens (courses, ref of the season, etc). Game tokens
// are derived live from final games refereed; only manual bonuses are stored here.
export const rewardRefBonus = pgTable("reward_ref_bonus", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokens: integer("tokens").notNull().default(0),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// All-in-one support inbox — every inbound customer message across channels
// (website contact form now; email / Instagram / Facebook / live chat next).
// One row per message; the admin Inbox tab reads + manages these.
export const inboxMessages = pgTable("inbox_messages", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull(),
  channel: text("channel").notNull(),        // 'web_form'|'email'|'instagram'|'facebook'|'livechat'
  name: text("name"),
  email: text("email"),
  phone: text("phone"),
  subject: text("subject"),
  body: text("body").notNull(),
  status: text("status").notNull().default("new"),  // 'new'|'read'|'replied'|'archived'
  sourceUrl: text("source_url"),
  handledByUserId: integer("handled_by_user_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Live chat ────────────────────────────────────────────────────────────────
// Powers the reusable Intercom-style chat widget on the brand marketing sites
// (cicyouth.com, and reusable across MFL/CUGC/USG). A conversation is a threaded
// exchange between a website visitor and staff, scoped to an org. Managed in
// ClubOS → (workspace) → Live Chat. Distinct from inbox_messages (one-shot forms).
export const chatConversations = pgTable("chat_conversations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull(),
  token: text("token").notNull(),              // opaque public handle held by the visitor's browser
  brandKey: text("brand_key"),                 // which site started it, e.g. 'cicyouth'
  visitorName: text("visitor_name"),
  visitorEmail: text("visitor_email"),
  visitorPhone: text("visitor_phone"),
  status: text("status").notNull().default("open"),   // 'open'|'closed'
  sourceUrl: text("source_url"),
  userAgent: text("user_agent"),
  agentUnread: integer("agent_unread").notNull().default(0),    // visitor msgs staff hasn't opened
  visitorUnread: integer("visitor_unread").notNull().default(0), // agent msgs visitor hasn't seen
  lastVisitorAt: timestamp("last_visitor_at"),
  lastAgentAt: timestamp("last_agent_at"),
  lastMessageAt: timestamp("last_message_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  tokenUnq: uniqueIndex("chat_conv_token_unq").on(t.token),
  orgRecentIdx: index("chat_conv_org_recent_idx").on(t.organizationId, t.lastMessageAt),
}));

export const chatMessages = pgTable("chat_messages", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  conversationId: integer("conversation_id").notNull(),
  sender: text("sender").notNull(),            // 'visitor'|'agent'|'system'
  authorName: text("author_name"),             // staff display name for agent messages
  authorUserId: integer("author_user_id"),     // staff user id for agent messages
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  convIdx: index("chat_msg_conv_idx").on(t.conversationId, t.id),
}));

// ── CIC interest registrations ───────────────────────────────────────────────
// Structured "Register Your Interest" submissions from cicyouth.com. One row per
// club/registration — a club admin registers ALL the age groups they want in one
// hit and is the single contact for all of them (ageGroups holds every selected
// grade). Powers the age-group board in ClubOS → Tournaments → CIC → Registrations
// (slots fill per grade with the exact team contact + the timestamp they registered).
export const cicInterestRegistrations = pgTable("cic_interest_registrations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  email: text("email").notNull(),
  phone: text("phone"),
  club: text("club"),
  location: text("location"),  // "Melbourne, Australia" — where the team is travelling from
  ageGroups: text("age_groups").array().notNull().default(sql`ARRAY[]::text[]`), // e.g. {U9,U11,U13}
  status: text("status").notNull().default("new"),  // 'new'|'confirmed'|'declined'|'archived'
  notes: text("notes"),
  sourceUrl: text("source_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  orgIdx: index("cic_interest_org_idx").on(t.organizationId, t.createdAt),
}));

// Email suppression list — anyone who unsubscribed from broadcasts. Per-org
// (organizationId null = global). The mailer audience resolver excludes these.
export const emailUnsubscribes = pgTable("email_unsubscribes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id"),
  email: text("email").notNull(),
  source: text("source"), // e.g. 'league_broadcast'
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  orgEmailUnq: uniqueIndex("email_unsub_org_email_unq").on(t.organizationId, t.email),
}));

export const auditLogs = pgTable("audit_logs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => users.id),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: integer("entity_id"),
  details: text("details"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const facilities = pgTable("facilities", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: facilityTypeEnum("type").notNull().default("field"),
  description: text("description"),
  imageUrl: text("image_url"),
  imageUrls: text("image_urls").array().notNull().default(sql`ARRAY[]::text[]`),
  halfFull: boolean("half_full").default(false),
  floodlights: boolean("floodlights").default(false),
  bufferMinutes: integer("buffer_minutes").default(0),
  active: boolean("active").notNull().default(true),
  publicVisible: boolean("public_visible").notNull().default(true),
  displayOrder: integer("display_order").notNull().default(0),
  pricePerHourCents: integer("price_per_hour_cents").default(0),
  halfFieldPricePerHourCents: integer("half_field_price_per_hour_cents"),
  // Whether this pitch can be booked as a quarter, and the quarter base rate.
  quarterField: boolean("quarter_field").default(false),
  quarterFieldPricePerHourCents: integer("quarter_field_price_per_hour_cents"),
  // Per-facility iCal calendar token. Public consumers (Home Assistant for
  // automatic gates/lights, Google Calendar import, etc.) fetch the booking
  // feed at /api/public/facility-calendar/:token.ics. Nullable until admin
  // regenerates one. Treat as a capability URL — anyone with the token can
  // read the booking schedule (no PII included).
  calendarToken: text("calendar_token").unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const facilityPricingRules = pgTable("facility_pricing_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  facilityId: integer("facility_id").notNull().references(() => facilities.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  dayOfWeek: integer("day_of_week"),
  startTime: text("start_time"),
  endTime: text("end_time"),
  pricePerHour: decimal("price_per_hour", { precision: 10, scale: 2 }).notNull(),
  halfFieldPricePerHour: decimal("half_field_price_per_hour", { precision: 10, scale: 2 }),
  quarterFieldPricePerHour: decimal("quarter_field_price_per_hour", { precision: 10, scale: 2 }),
  isDefault: boolean("is_default").default(false),
});

export const facilityBookings = pgTable("facility_bookings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  facilityId: integer("facility_id").notNull().references(() => facilities.id, { onDelete: "cascade" }),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  customerPhone: text("customer_phone"),
  customerClub: text("customer_club"),
  bookingDate: date("booking_date").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  halfFull: text("half_full"),
  // For half-field bookings: 'front' or 'back'. NULL for full bookings or
  // legacy half bookings created before this column existed.
  halfPosition: text("half_position"),
  addonsJson: jsonb("addons_json"),
  subtotalCents: integer("subtotal_cents").default(0),
  gstCents: integer("gst_cents").default(0),
  totalCents: integer("total_cents").default(0),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
  gstAmount: decimal("gst_amount", { precision: 10, scale: 2 }),
  status: bookingStatusEnum("status").notNull().default("pending"),
  stripePaymentId: text("stripe_payment_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  // For "Pay weekly" recurring bookings — links the booking row to a
  // Stripe Subscription so the webhook can advance the right booking
  // when each weekly invoice succeeds.
  stripeSubscriptionId: text("stripe_subscription_id"),
  paidAt: timestamp("paid_at"),
  bookingGroupId: text("booking_group_id"),
  // Order-level discount code (e.g. member CUGC50) applied at checkout, and the
  // per-booking share of the discount in cents. totalCents already reflects it.
  discountCode: text("discount_code"),
  discountCents: integer("discount_cents").default(0),
  notes: text("notes"),
  color: text("color"),
  additionalFacilityIds: integer("additional_facility_ids").array(),
  recurrenceRule: text("recurrence_rule"),
  recurrenceEndDate: date("recurrence_end_date"),
  // Audit trail — how the booking originated and who put it on the calendar.
  //   source: 'manual'         → staff created it in the admin calendar
  //           'public'         → paid through the public booking website
  //           'member_request' → a member request a staff member approved
  // createdByUserId / createdByName: the staff member who created (manual) or
  //   approved (member_request) the booking. NULL for public bookings (no
  //   staff involved) and for legacy rows created before this existed.
  source: text("source"),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  createdByName: text("created_by_name"),
  // Waiver acceptance for bookings made through the public booking site —
  // stamped at checkout (see shared/usc-waiver.ts). Admin-created and
  // member-request bookings leave these at their defaults (the member flow
  // records its acceptance on booking_requests instead).
  waiverAccepted: boolean("waiver_accepted").notNull().default(false),
  waiverVersion: text("waiver_version"),
  waiverAcceptedAt: timestamp("waiver_accepted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const venueSettings = pgTable("venue_settings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().unique().references(() => organizations.id, { onDelete: "cascade" }),
  siteTitle: text("site_title").notNull().default("Book a Facility"),
  introText: text("intro_text").default(""),
  brandColor: text("brand_color").default("#6366f1"),
  openingTime: text("opening_time").notNull().default("07:00"),
  closingTime: text("closing_time").notNull().default("22:00"),
  slotMinutes: integer("slot_minutes").notNull().default(30),
  minDurationMinutes: integer("min_duration_minutes").notNull().default(60),
  advanceBookingDays: integer("advance_booking_days").notNull().default(60),
  gstRatePercent: decimal("gst_rate_percent", { precision: 5, scale: 2 }).notNull().default("15.00"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  footerText: text("footer_text").default(""),
  paymentPolicy: text("payment_policy").default("Full payment required at booking. Cancellations 48 hours+ in advance receive a full refund."),
  successMessage: text("success_message").default("Thanks for your booking! A confirmation has been sent to your email."),
  // Player Pay (split a booking across a group) — kill switch for the venue site.
  splitEnabled: boolean("split_enabled").default(false),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const facilityAddons = pgTable("facility_addons", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  price: decimal("price", { precision: 10, scale: 2 }).notNull().default("0"),
  unit: text("unit").notNull().default("per_hour"),
  maxQty: integer("max_qty"),
  appliesToAll: boolean("applies_to_all").default(true),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Member booking requests — submitted from the public member booking page
// (book.unitedsportscentre.com/members) with no payment attached. An admin
// reviews each request in the "Booking Requests" tab; approving one creates a
// confirmed $0 facilityBookings row (linked via facilityBookingId) so the slot
// blocks the public calendar like any other booking.
export const bookingRequests = pgTable("booking_requests", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  facilityId: integer("facility_id").notNull().references(() => facilities.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  dateOfBirth: date("date_of_birth").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  bookingDate: date("booking_date").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  // full | half | quarter — same vocabulary as facilityBookings.
  halfFull: text("half_full"),
  // front|back for halves, q1–q4 for quarters; NULL for full bookings.
  halfPosition: text("half_position"),
  // The waiver the member agreed to. waiverVersion pins the exact text
  // (see shared/usc-waiver.ts) so acceptance is auditable after edits.
  waiverAccepted: boolean("waiver_accepted").notNull().default(false),
  waiverVersion: text("waiver_version"),
  waiverAcceptedAt: timestamp("waiver_accepted_at"),
  status: text("status").notNull().default("pending"), // pending | approved | declined
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),
  declineReason: text("decline_reason"),
  // Set on approval — the confirmed facilityBookings row that holds the slot.
  facilityBookingId: integer("facility_booking_id").references(() => facilityBookings.id),
  notes: text("notes"),
  // ── AttributionOS (additive, T3) ──────────────────────────────────────────
  visitorId: text("visitor_id"),
  clickId: text("click_id"),
  personId: integer("person_id"),
  fbp: text("fbp"),
  fbc: text("fbc"),
  metaAdId: text("meta_ad_id"),
  metaAdsetId: text("meta_adset_id"),
  metaCampaignId: text("meta_campaign_id"),
  metaPlatform: text("meta_platform"),
  attributionChannel: text("attribution_channel"),
  hdyhau: text("hdyhau"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const leagueRegistrationStatusEnum = pgEnum("league_reg_status", ["open", "closed", "none"]);
export const gameStatusEnum = pgEnum("game_status", ["scheduled", "in_progress", "final", "cancelled", "forfeit"]);

export const leagueCompetitions = pgTable("league_competitions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sport: text("sport").notNull().default("Soccer"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  registrationStatus: text("registration_status").notNull().default("none"),
  youthLeague: boolean("youth_league").default(true),
  teamChat: boolean("team_chat").default(false),
  playoffCompetition: boolean("playoff_competition").default(false),
  enableRegistration: boolean("enable_registration").default(false),
  isPrivate: boolean("is_private").default(false),
  archived: boolean("archived").default(false),
  settingsJson: text("settings_json"),
  contactPhone: text("contact_phone"),
  contactEmail: text("contact_email"),
  contactWebsite: text("contact_website"),
  bannerImageUrl: text("banner_image_url"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const leagueDivisions = pgTable("league_divisions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  competitionId: integer("competition_id").notNull().references(() => leagueCompetitions.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  gender: text("gender"),
  ageGroup: text("age_group"),
  dayOfWeek: text("day_of_week"),
  maxTeams: integer("max_teams"),
  teamCostCents: integer("team_cost_cents").default(0),
  playerCostCents: integer("player_cost_cents").default(0),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const leagueTeams = pgTable("league_teams", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  competitionId: integer("competition_id").notNull().references(() => leagueCompetitions.id, { onDelete: "cascade" }),
  divisionId: integer("division_id").references(() => leagueDivisions.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  logoUrl: text("logo_url"),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  primaryColor: text("primary_color"),
  secondaryColor: text("secondary_color"),
  active: boolean("active").notNull().default(true),
  // Links a self-service paid registration to this team. NULL = admin-created
  // team (the existing manual flow). paymentStatus surfaces deposit vs paid in
  // the league admin and the Expo app.
  registrationId: integer("registration_id").references(() => registrations.id, { onDelete: "set null" }),
  paymentStatus: text("payment_status").default("unpaid"),  // 'unpaid'|'deposit_paid'|'paid_in_full'
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  // One paid registration → at most one team. NULLs (admin-created teams) are
  // distinct in Postgres unique indexes, so manual teams are unaffected. This
  // is the DB-level guard against the webhook/confirm-payment duplicate race.
  uniqueRegistration: uniqueIndex("league_teams_registration_id_unique").on(t.registrationId),
}));

// ── League waitlist ──────────────────────────────────────────────────────────
// Captured from the public join site when a night is sold out (or someone wants
// first call on multiple nights). One row per request; divisionIds holds every
// night they registered interest in. status: waiting → contacted → converted.
export const leagueWaitlist = pgTable("league_waitlist", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  competitionId: integer("competition_id").references(() => leagueCompetitions.id, { onDelete: "cascade" }),
  programSlug: text("program_slug"),
  teamName: text("team_name").notNull(),
  contactName: text("contact_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  divisionIds: jsonb("division_ids").$type<number[]>().notNull().default(sql`'[]'::jsonb`),
  notes: text("notes"),
  status: text("status").notNull().default("waiting"), // 'waiting'|'contacted'|'converted'
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  fbclid: text("fbclid"),
  // ── AttributionOS (additive, T3) ──────────────────────────────────────────
  visitorId: text("visitor_id"),
  clickId: text("click_id"),
  personId: integer("person_id"),
  fbp: text("fbp"),
  fbc: text("fbc"),
  metaAdId: text("meta_ad_id"),
  metaAdsetId: text("meta_adset_id"),
  metaCampaignId: text("meta_campaign_id"),
  metaPlatform: text("meta_platform"),
  attributionChannel: text("attribution_channel"),
  hdyhau: text("hdyhau"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Split Pay (split a team fee across the squad) ────────────────────────────
// A split session divides a FIXED team fee equally across N payers, each paying
// their own share on their own card. Lock-then-charge: members join + save a
// card while the session is 'open' (no money moves, the live share recomputes as
// people join/drop); when the captain locks, every saved card is charged its
// frozen share ONCE. The owning team registration stays 'pending' until the
// split settles, then materialises exactly one leagueTeam. See shared/league-pricing.ts
// (equalSplit) — the N shares sum to totalCents to the cent, so the club always
// collects the full fee.
export const splitSessions = pgTable("split_sessions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  // The team registration this split funds (created 'pending', confirmed on settle).
  registrationId: integer("registration_id").references(() => registrations.id, { onDelete: "set null" }),
  programId: integer("program_id").references(() => programs.id, { onDelete: "set null" }),
  leagueDivisionId: integer("league_division_id").references(() => leagueDivisions.id, { onDelete: "set null" }),
  teamName: text("team_name"),
  // The fixed total being split N ways (the already-discounted team fee).
  totalCents: integer("total_cents").notNull(),
  currency: text("currency").notNull().default("NZD"),
  // open: members join + save cards, share recomputes live, no money moves.
  // settling: locked — every saved card is being charged its frozen share once.
  // settled: all charged, team materialised. failed: a charge needs resolving.
  status: text("status").notNull().default("open"),  // 'open'|'settling'|'settled'|'cancelled'|'failed'
  // Captain's expected squad size — drives the "X / N joined" progress display
  // only; the real split is over the members holding a valid card at lock.
  targetCount: integer("target_count"),
  // Frozen per-member share at lock (null while open) — display/audit; the
  // authoritative per-member amount is splitMembers.chargedCents.
  shareLockedCents: integer("share_locked_cents"),
  // Private token the captain holds to lock/cancel/manage (never shown to members).
  organiserToken: text("organiser_token").notNull(),
  // Public short code in the share link / QR (/league/split/:code).
  shareCode: text("share_code").notNull(),
  lockedAt: timestamp("locked_at"),
  settledAt: timestamp("settled_at"),
  // Optional auto-lock deadline (e.g. competition start). Null = captain-locks only.
  // For venue bookings this doubles as the "hold expires, release the slot" time.
  deadlineAt: timestamp("deadline_at"),
  // Abandoned-session GC horizon.
  expiresAt: timestamp("expires_at"),
  // What this split funds: 'registration' (MFL team) or 'booking' (USC venue slot).
  fundingType: text("funding_type").notNull().default("registration"),
  // The facility booking group this split funds (when fundingType = 'booking').
  facilityBookingGroupId: text("facility_booking_group_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uniqueShareCode: uniqueIndex("split_sessions_share_code_unique").on(t.shareCode),
  // One split per team registration (DB backstop against double-create; NULLs are
  // distinct in Postgres unique indexes so non-registration splits are unaffected).
  uniqueRegistration: uniqueIndex("split_sessions_registration_id_unique").on(t.registrationId),
}));

export const splitMembers = pgTable("split_members", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  splitSessionId: integer("split_session_id").notNull().references(() => splitSessions.id, { onDelete: "cascade" }),
  name: text("name"),
  email: text("email").notNull(),  // required for receipt
  phone: text("phone"),
  role: text("role").notNull().default("member"),  // 'organiser'|'member'
  // joined: entered details. card_saved: SetupIntent succeeded, card on file.
  // paid: their frozen share was charged at lock. failed: charge declined.
  // removed: dropped while open (excluded from the split).
  status: text("status").notNull().default("joined"),  // 'joined'|'card_saved'|'paid'|'failed'|'removed'
  // Card on file — saved with NO charge via a SetupIntent, then charged once at lock.
  stripeCustomerId: text("stripe_customer_id"),
  stripeSetupIntentId: text("stripe_setup_intent_id"),
  stripePaymentMethodId: text("stripe_payment_method_id"),
  // The single lock charge.
  chargedCents: integer("charged_cents"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  paidAt: timestamp("paid_at"),
  // Only used if a captain cancels a settled/partly-settled split (explicit refund).
  stripeRefundId: text("stripe_refund_id"),
  stripeRefundStatus: text("stripe_refund_status"),
  // Private token identifying this member's device for status polling + retry.
  memberToken: text("member_token").notNull(),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
}, (t) => ({
  // A member can't join the same split twice with the same email (re-join
  // reactivates a 'removed' row instead of inserting a duplicate).
  uniqueSessionEmail: uniqueIndex("split_members_session_email_unique").on(t.splitSessionId, t.email),
}));

export const leagueGames = pgTable("league_games", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  competitionId: integer("competition_id").notNull().references(() => leagueCompetitions.id, { onDelete: "cascade" }),
  divisionId: integer("division_id").references(() => leagueDivisions.id, { onDelete: "set null" }),
  homeTeamId: integer("home_team_id").references(() => leagueTeams.id, { onDelete: "set null" }),
  awayTeamId: integer("away_team_id").references(() => leagueTeams.id, { onDelete: "set null" }),
  gameNumber: integer("game_number"),
  gameDate: date("game_date"),
  startTime: text("start_time"),
  endTime: text("end_time"),
  location: text("location"),
  surface: text("surface"),
  status: text("status").notNull().default("scheduled"),
  homeScore: integer("home_score"),
  awayScore: integer("away_score"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const leagueCoupons = pgTable("league_coupons", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  competitionId: integer("competition_id").notNull().references(() => leagueCompetitions.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  discountPercent: integer("discount_percent"),
  discountAmountCents: integer("discount_amount_cents"),
  maxUsage: integer("max_usage"),
  currentUsage: integer("current_usage").default(0),
  validUntil: date("valid_until"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const tournaments = pgTable("tournaments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  ageGroup: text("age_group"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  location: text("location"),
  numGroups: integer("num_groups").default(4),
  teamsPerGroup: integer("teams_per_group").default(4),
  groupStageFormat: text("group_stage_format").default("round_robin"),
  knockoutFormat: text("knockout_format").default("single_elimination"),
  gameDurationMinutes: integer("game_duration_minutes").default(20),
  breakBetweenMinutes: integer("break_between_minutes").default(5),
  pointsForWin: integer("points_for_win").default(3),
  pointsForDraw: integer("points_for_draw").default(1),
  pointsForLoss: integer("points_for_loss").default(0),
  registrationStatus: text("registration_status").default("none"),
  registrationFeeCents: integer("registration_fee_cents").default(0),
  status: text("status").notNull().default("draft"),
  active: boolean("active").notNull().default(true),
  archived: boolean("archived").notNull().default(false),
  // Default "Watch" destination for the whole age group (single-camera setups);
  // a game's own streamUrl overrides this when set.
  streamUrl: text("stream_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const tournamentGroups = pgTable("tournament_groups", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  tournamentId: integer("tournament_id").notNull().references(() => tournaments.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// A real-world football club that participates in tournaments. Scoped to an
// organization so each org (CIC, MFL, etc.) maintains its own club roster.
// One club row → many tournament_team rows (the same club enters U10, U12,
// U14 etc. as separate teams; each team can override the club logo/colors
// for variants like "CU Blue" vs "CU White").
export const clubs = pgTable("clubs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  shortName: text("short_name"),
  logoUrl: text("logo_url"),
  primaryColor: text("primary_color"),
  secondaryColor: text("secondary_color"),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  website: text("website"),
  notes: text("notes"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Club logo licence consents — a participating club's rep signs (via the public
// cicyouth.com/club-logo-agreement page) granting CIC permission to display their
// crest on the website + app. This is the auditable proof record (name, version,
// timestamp, IP). clubId is optional (the rep types their club name on a public
// form); an admin can link it to a clubs row later.
export const clubLogoConsents = pgTable("club_logo_consents", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull(),
  clubId: integer("club_id"),
  clubName: text("club_name").notNull(),
  repName: text("rep_name").notNull(),
  repRole: text("rep_role"),
  repEmail: text("rep_email").notNull(),
  repPhone: text("rep_phone"),
  licenceVersion: text("licence_version").notNull(),
  signatureName: text("signature_name").notNull(), // typed-name e-signature
  logoUrl: text("logo_url"),                        // optional uploaded logo
  documentHash: text("document_hash"),              // SHA-256 of exact signed licence text (proof fingerprint)
  sourceUrl: text("source_url"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  status: text("status").notNull().default("agreed"), // agreed | withdrawn
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const tournamentTeams = pgTable("tournament_teams", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  tournamentId: integer("tournament_id").notNull().references(() => tournaments.id, { onDelete: "cascade" }),
  groupId: integer("group_id").references(() => tournamentGroups.id, { onDelete: "set null" }),
  // Link to the parent club. Nullable for backwards-compat (existing rows
  // pre-clubs feature) and for one-off entries that don't fit a club.
  clubId: integer("club_id").references(() => clubs.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  clubName: text("club_name"),
  // logoUrl on a team overrides the club logo when set; resolvers fall back
  // to the linked club's logoUrl when this is null.
  logoUrl: text("logo_url"),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  primaryColor: text("primary_color"),
  secondaryColor: text("secondary_color"),
  seedNumber: integer("seed_number"),
  registrationStatus: text("registration_status").default("registered"),
  // Squad-list coverage: "missing" = no squad submitted (chase the club),
  // "submitted" = squad provided (may still need entering). Null = unknown.
  rosterStatus: text("roster_status"),
  paidAmountCents: integer("paid_amount_cents").default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const tournamentPlayers = pgTable("tournament_players", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  teamId: integer("team_id").notNull().references(() => tournamentTeams.id, { onDelete: "cascade" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  shirtNumber: integer("shirt_number"),
  dateOfBirth: date("date_of_birth"),
  idDocumentType: text("id_document_type"),
  idDocumentUrl: text("id_document_url"),
  // Age-eligibility verification — admins flip ageVerified once they've
  // eyeballed the document and confirmed the player meets the age cutoff.
  ageVerified: boolean("age_verified").notNull().default(false),
  verifiedByUserId: integer("verified_by_user_id").references(() => users.id, { onDelete: "set null" }),
  verifiedAt: timestamp("verified_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const tournamentStaff = pgTable("tournament_staff", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  teamId: integer("team_id").notNull().references(() => tournamentTeams.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// One row per goal scored. Top-scorer rankings + match goal lists both
// derive from this table — single source of truth for "who scored what".
export const tournamentGoals = pgTable("tournament_goals", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  gameId: integer("game_id").notNull().references(() => tournamentGames.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => tournamentPlayers.id, { onDelete: "cascade" }),
  teamId: integer("team_id").notNull().references(() => tournamentTeams.id, { onDelete: "cascade" }),
  minute: integer("minute"),
  isOwnGoal: boolean("is_own_goal").notNull().default(false),
  isPenalty: boolean("is_penalty").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const tournamentGames = pgTable("tournament_games", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  tournamentId: integer("tournament_id").notNull().references(() => tournaments.id, { onDelete: "cascade" }),
  groupId: integer("group_id").references(() => tournamentGroups.id, { onDelete: "set null" }),
  homeTeamId: integer("home_team_id").references(() => tournamentTeams.id, { onDelete: "set null" }),
  awayTeamId: integer("away_team_id").references(() => tournamentTeams.id, { onDelete: "set null" }),
  homeTeamPlaceholder: text("home_team_placeholder"),
  awayTeamPlaceholder: text("away_team_placeholder"),
  gameNumber: integer("game_number"),
  roundNumber: integer("round_number"),
  stage: text("stage").notNull().default("group"),
  stageDetail: text("stage_detail"),
  gameDate: date("game_date"),
  startTime: text("start_time"),
  endTime: text("end_time"),
  field: text("field"),
  status: text("status").notNull().default("scheduled"),
  // "Go Live" toggle + optional per-game stream URL for the Watch feature.
  isLive: boolean("is_live").notNull().default(false),
  streamUrl: text("stream_url"),
  homeScore: integer("home_score"),
  awayScore: integer("away_score"),
  homePenalties: integer("home_penalties"),
  awayPenalties: integer("away_penalties"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Individual awards (ADMIN-ONLY / private — never exposed publicly) ──
// Golden Boot is public (derived from tournamentGoals). MVP + Golden Glove
// involve human voting that could be rigged if standings were visible, so
// these two tables feed admin-only leaderboards.

// MVP: in each game, each team casts ONE vote for the best player on the
// OPPOSING team. One vote each — the tournament MVP is whoever has the most.
export const tournamentMvpVotes = pgTable("tournament_mvp_votes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  gameId: integer("game_id").notNull().references(() => tournamentGames.id, { onDelete: "cascade" }),
  // The team doing the voting.
  voterTeamId: integer("voter_team_id").notNull().references(() => tournamentTeams.id, { onDelete: "cascade" }),
  // The player being voted MVP (must be on the OTHER team — enforced in the route).
  playerId: integer("player_id").notNull().references(() => tournamentPlayers.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  // One vote per team per game (re-voting overwrites via upsert).
  uniqVoter: unique().on(t.gameId, t.voterTeamId),
}));

// Golden Glove: referees rate each team's goalkeeper 1–5 per game (5 = best).
// The tournament's best keeper is decided on average rating across games.
export const tournamentGkRatings = pgTable("tournament_gk_ratings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  gameId: integer("game_id").notNull().references(() => tournamentGames.id, { onDelete: "cascade" }),
  teamId: integer("team_id").notNull().references(() => tournamentTeams.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => tournamentPlayers.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull(), // 1–5
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  // One keeper rating per team per game.
  uniqGk: unique().on(t.gameId, t.teamId),
}));

// Disciplinary cards — ADMIN-ONLY (private). Feeds the card-accumulation
// tracker so staff can spot players who've picked up enough yellows to sit
// out a game. One row per card shown (a player can have many across games).
export const tournamentCards = pgTable("tournament_cards", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  gameId: integer("game_id").notNull().references(() => tournamentGames.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => tournamentPlayers.id, { onDelete: "cascade" }),
  teamId: integer("team_id").notNull().references(() => tournamentTeams.id, { onDelete: "cascade" }),
  cardType: text("card_type").notNull(), // 'yellow' | 'red'
  minute: integer("minute"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Penalty shootout — one row per kick, IN ORDER. Only used for knockout games
// that finish level. The game row's home_penalties / away_penalties hold the
// running TOTALS (source of truth for bracket advancement — see
// tournament-brackets.ts); these rows add the pro-app kick-by-kick sequence:
// which team took it, whether it was scored (green ✓) or missed/saved (red ✗),
// and an optional taker. Totals are kept in sync from these rows on every
// change. Public display shows the taker's name only for SCORED kicks (we
// never publicly name a child who missed) — mirrors the own-goal rule.
export const tournamentPenaltyKicks = pgTable("tournament_penalty_kicks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  gameId: integer("game_id").notNull().references(() => tournamentGames.id, { onDelete: "cascade" }),
  kickNumber: integer("kick_number").notNull(), // running order across both teams: 1,2,3…
  teamId: integer("team_id").notNull().references(() => tournamentTeams.id, { onDelete: "cascade" }),
  scored: boolean("scored").notNull(), // true = goal (✓), false = missed/saved (✗)
  playerId: integer("player_id").references(() => tournamentPlayers.id, { onDelete: "set null" }), // optional taker
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const analyticsEvents = pgTable("analytics_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  visitorId: text("visitor_id").notNull(),
  sessionId: text("session_id").notNull(),
  eventType: text("event_type").notNull(),
  page: text("page"),
  referrer: text("referrer"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  device: text("device"),
  browser: text("browser"),
  screenWidth: integer("screen_width"),
  campSlug: text("camp_slug"),
  // ── AttributionOS (additive, T2) ──────────────────────────────────────────
  fbclid: text("fbclid"),               // Facebook click id (present on organic clicks too)
  gclid: text("gclid"),                 // Google Ads click id
  clickId: text("click_id"),            // our first-party short-link click id (?ci=)
  fbp: text("fbp"),                     // Meta browser pixel cookie (_fbp)
  fbc: text("fbc"),                     // Meta click cookie (_fbc)
  personId: integer("person_id"),       // stitched identity (persons.id), NULL until known
  channel: text("channel"),             // classifyTouch() canonical channel
  channelRaw: text("channel_raw"),      // raw utm_source / referrer before normalisation
  landingUrl: text("landing_url"),      // full URL of the landing page for this touch
  isBot: boolean("is_bot").notNull().default(false),
  metadata: jsonb("metadata"),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
}, (t) => ({
  // AttributionOS (T21) — VACUUM-friendly composite indexes for the hot read
  // paths + nightly prune. Mirrors migrations/2026-07-04_attribution_indexes.sql.
  visitorTsIdx: index("analytics_events_visitor_ts_idx").on(t.visitorId, t.timestamp),
  personTsIdx: index("analytics_events_person_ts_idx").on(t.personId, t.timestamp),
  channelTsIdx: index("analytics_events_channel_ts_idx").on(t.channel, t.timestamp),
}));

export const insertAnalyticsEventSchema = createInsertSchema(analyticsEvents).omit({ id: true });
export type InsertAnalyticsEvent = z.infer<typeof insertAnalyticsEventSchema>;
export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;

export const splitTestStatusEnum = pgEnum("split_test_status", ["active", "completed", "cancelled"]);

export const splitTests = pgTable("split_tests", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  programId: integer("program_id").notNull(),
  field: text("field").notNull(),
  status: splitTestStatusEnum("status").default("active").notNull(),
  endCondition: text("end_condition").notNull(),
  endValue: integer("end_value").notNull(),
  winnerId: integer("winner_id"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const splitTestVariants = pgTable("split_test_variants", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  splitTestId: integer("split_test_id").notNull(),
  label: text("label").notNull(),
  value: text("value").notNull(),
  isControl: boolean("is_control").default(false).notNull(),
  views: integer("views").default(0).notNull(),
  registrations: integer("registrations").default(0).notNull(),
  revenue: integer("revenue").default(0).notNull(),
});

export const insertSplitTestSchema = createInsertSchema(splitTests).omit({ id: true, createdAt: true });
export type InsertSplitTest = z.infer<typeof insertSplitTestSchema>;
export type SplitTest = typeof splitTests.$inferSelect;

export const insertSplitTestVariantSchema = createInsertSchema(splitTestVariants).omit({ id: true });
export type InsertSplitTestVariant = z.infer<typeof insertSplitTestVariantSchema>;
export type SplitTestVariant = typeof splitTestVariants.$inferSelect;

export const insertSettingSchema = createInsertSchema(settings).omit({ updatedAt: true });
export type InsertSetting = z.infer<typeof insertSettingSchema>;
export type Setting = typeof settings.$inferSelect;

export const insertFacilitySchema = createInsertSchema(facilities).omit({ id: true, createdAt: true });
export const insertFacilityPricingRuleSchema = createInsertSchema(facilityPricingRules).omit({ id: true });
export const insertFacilityBookingSchema = createInsertSchema(facilityBookings).omit({ id: true, createdAt: true });
export const insertFacilityAddonSchema = createInsertSchema(facilityAddons).omit({ id: true, createdAt: true });
export const insertVenueSettingsSchema = createInsertSchema(venueSettings).omit({ id: true, updatedAt: true });
export const insertBookingRequestSchema = createInsertSchema(bookingRequests).omit({ id: true, createdAt: true });
export type InsertBookingRequest = z.infer<typeof insertBookingRequestSchema>;
export type BookingRequest = typeof bookingRequests.$inferSelect;

export const insertTournamentSchema = createInsertSchema(tournaments).omit({ id: true, createdAt: true });
export const insertTournamentGroupSchema = createInsertSchema(tournamentGroups).omit({ id: true, createdAt: true });
export const insertClubSchema = createInsertSchema(clubs).omit({ id: true, createdAt: true });
export const insertTournamentTeamSchema = createInsertSchema(tournamentTeams).omit({ id: true, createdAt: true });
export const insertTournamentPlayerSchema = createInsertSchema(tournamentPlayers).omit({ id: true, createdAt: true });
export const insertTournamentGoalSchema = createInsertSchema(tournamentGoals).omit({ id: true, createdAt: true });
export const insertTournamentStaffSchema = createInsertSchema(tournamentStaff).omit({ id: true, createdAt: true });
export const insertTournamentGameSchema = createInsertSchema(tournamentGames).omit({ id: true, createdAt: true });
export const insertTournamentMvpVoteSchema = createInsertSchema(tournamentMvpVotes).omit({ id: true, createdAt: true });
export const insertTournamentGkRatingSchema = createInsertSchema(tournamentGkRatings).omit({ id: true, createdAt: true });
export const insertTournamentCardSchema = createInsertSchema(tournamentCards).omit({ id: true, createdAt: true });
export const insertTournamentPenaltyKickSchema = createInsertSchema(tournamentPenaltyKicks).omit({ id: true, createdAt: true });

export const insertLeagueCompetitionSchema = createInsertSchema(leagueCompetitions).omit({ id: true, createdAt: true });
export const insertLeagueDivisionSchema = createInsertSchema(leagueDivisions).omit({ id: true, createdAt: true });
export const insertLeagueTeamSchema = createInsertSchema(leagueTeams).omit({ id: true, createdAt: true });
export const insertLeagueGameSchema = createInsertSchema(leagueGames).omit({ id: true, createdAt: true });
export const insertLeagueCouponSchema = createInsertSchema(leagueCoupons).omit({ id: true, createdAt: true });
export const insertLeagueWaitlistSchema = createInsertSchema(leagueWaitlist).omit({ id: true, createdAt: true });
export const insertSplitSessionSchema = createInsertSchema(splitSessions).omit({ id: true, createdAt: true });
export const insertSplitMemberSchema = createInsertSchema(splitMembers).omit({ id: true, joinedAt: true });

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
export const insertContactSchema = createInsertSchema(contacts).omit({ id: true, createdAt: true });
export const insertRelationshipSchema = createInsertSchema(contactRelationships).omit({ id: true });
export const insertProgramSchema = createInsertSchema(programs).omit({ id: true, createdAt: true });
export const insertSessionSchema = createInsertSchema(programSessions).omit({ id: true });
export const insertSessionBookingSchema = createInsertSchema(sessionBookings).omit({ id: true, createdAt: true });
export const insertDiscountSchema = createInsertSchema(programDiscounts).omit({ id: true });
export const insertRegistrationSchema = createInsertSchema(registrations).omit({ id: true, registeredAt: true });
export const insertAuditLogSchema = createInsertSchema(auditLogs).omit({ id: true, createdAt: true });
export const insertCampPricingSchema = createInsertSchema(campPricing).omit({ id: true });
export const insertCampDateSchema = createInsertSchema(campDates).omit({ id: true });
export const insertCampSettingsSchema = createInsertSchema(campSettings).omit({ id: true });
export const insertChildSchema = createInsertSchema(children).omit({ id: true, createdAt: true });
export const insertChildMedicalSchema = createInsertSchema(childMedical).omit({ id: true });
export const insertRegistrationItemSchema = createInsertSchema(registrationItems).omit({ id: true });
export const insertAttendanceSchema = createInsertSchema(attendance).omit({ id: true });
export const insertEmailLogSchema = createInsertSchema(emailLogs).omit({ id: true, sentAt: true });
export const insertMetaEventLogSchema = createInsertSchema(metaEventLogs).omit({ id: true, sentAt: true });
export const insertEmailCampaignSchema = createInsertSchema(emailCampaigns).omit({ id: true, createdAt: true, sentAt: true });
export const insertEmailUnsubscribeSchema = createInsertSchema(emailUnsubscribes).omit({ id: true, createdAt: true });
export type InsertEmailUnsubscribe = z.infer<typeof insertEmailUnsubscribeSchema>;
export type EmailUnsubscribe = typeof emailUnsubscribes.$inferSelect;
export type RewardBuilder = typeof rewardBuilders.$inferSelect;
export type RewardBuilderEvent = typeof rewardBuilderEvents.$inferSelect;
export type RewardSeasonMember = typeof rewardSeasonMembers.$inferSelect;
export type RewardSeasonReward = typeof rewardSeasonRewards.$inferSelect;
export type InboxMessage = typeof inboxMessages.$inferSelect;
export type ChatConversation = typeof chatConversations.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type CicInterestRegistration = typeof cicInterestRegistrations.$inferSelect;

export const insertOrganizationSchema = createInsertSchema(organizations).omit({ id: true, createdAt: true });
export const insertUserOrganizationSchema = createInsertSchema(userOrganizations).omit({ id: true });

export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizations.$inferSelect;
export type InsertUserOrganization = z.infer<typeof insertUserOrganizationSchema>;
export type UserOrganization = typeof userOrganizations.$inferSelect;

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertContact = z.infer<typeof insertContactSchema>;
export type Contact = typeof contacts.$inferSelect;
export type InsertRelationship = z.infer<typeof insertRelationshipSchema>;
export type ContactRelationship = typeof contactRelationships.$inferSelect;
export type InsertProgram = z.infer<typeof insertProgramSchema>;
export type Program = typeof programs.$inferSelect;
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type ProgramSession = typeof programSessions.$inferSelect;
export type InsertSessionBooking = z.infer<typeof insertSessionBookingSchema>;
export type SessionBooking = typeof sessionBookings.$inferSelect;
export type InsertDiscount = z.infer<typeof insertDiscountSchema>;
export type ProgramDiscount = typeof programDiscounts.$inferSelect;
export type InsertRegistration = z.infer<typeof insertRegistrationSchema>;
export type Registration = typeof registrations.$inferSelect;

// ── Academy waitlist ────────────────────────────────────────────────────────
// Academy programmes carry a `capacity` that the old class-registration flow
// ignored entirely — it would happily oversell a session. When a programme is
// full we capture the family rather than lose them. (leagueWaitlist exists but
// is MFL-team shaped: competition + division, no child.)
export const academyWaitlist = pgTable("academy_waitlist", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull(),
  programId: integer("program_id").notNull().references(() => programs.id, { onDelete: "cascade" }),
  seasonYear: integer("season_year"),
  childFirstName: text("child_first_name").notNull(),
  childLastName: text("child_last_name").notNull(),
  childDob: date("child_dob"),
  guardianName: text("guardian_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  notes: text("notes"),
  status: text("status").notNull().default("waiting"), // waiting|offered|converted|declined
  offeredAt: timestamp("offered_at", { withTimezone: true }),
  convertedRegistrationId: integer("converted_registration_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertAcademyWaitlistSchema = createInsertSchema(academyWaitlist).omit({ id: true, createdAt: true });
export type InsertAcademyWaitlist = z.infer<typeof insertAcademyWaitlistSchema>;
export type AcademyWaitlist = typeof academyWaitlist.$inferSelect;

// ── Club squads ─────────────────────────────────────────────────────────────
// The club's own teams, U9 → First Team, and who is in them. NOT leagueTeams
// (MFL social sides) and NOT tournamentTeams (visiting clubs at CIC).
// A squad IS a season's team, so season_year lives here, not on the member.
export const clubSquads = pgTable("club_squads", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull(),
  name: text("name").notNull(),
  slug: text("slug"),
  ageGrade: integer("age_grade"),          // NZF grade; NULL for seniors
  seasonYear: integer("season_year").notNull(),
  competition: text("competition"),
  displayOrder: integer("display_order").notNull().default(0),
  band: text("band"),                      // youth | academy | senior
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgSeasonNameKey: uniqueIndex("club_squads_org_season_name_key").on(t.organizationId, t.seasonYear, sql`lower(${t.name})`),
  orgSeasonIdx: index("club_squads_org_season_idx").on(t.organizationId, t.seasonYear, t.displayOrder),
}));
export const insertClubSquadSchema = createInsertSchema(clubSquads).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertClubSquad = z.infer<typeof insertClubSquadSchema>;
export type ClubSquad = typeof clubSquads.$inferSelect;

// A squad member is a CONTACT with a role — players and coaches already live in
// `contacts`, and forking them would fork the club's database.
// `leftAt` retires someone without deleting history: a child who left in August
// still played until August, and the NZF audit has to be able to show it.
export const clubSquadMembers = pgTable("club_squad_members", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  squadId: integer("squad_id").notNull().references(() => clubSquads.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("player"),
  squadNumber: integer("squad_number"),
  position: text("position"),               // GK | DF | MF | FW
  joinedAt: date("joined_at"),
  leftAt: date("left_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqueMember: uniqueIndex("club_squad_members_unique").on(t.squadId, t.contactId, t.role),
  squadIdx: index("club_squad_members_squad_idx").on(t.squadId, t.role),
  contactIdx: index("club_squad_members_contact_idx").on(t.contactId),
}));
export const insertClubSquadMemberSchema = createInsertSchema(clubSquadMembers).omit({ id: true, createdAt: true });
export type InsertClubSquadMember = z.infer<typeof insertClubSquadMemberSchema>;
export type ClubSquadMember = typeof clubSquadMembers.$inferSelect;

export type InsertCampPricing = z.infer<typeof insertCampPricingSchema>;
export type CampPricing = typeof campPricing.$inferSelect;
export type InsertCampDate = z.infer<typeof insertCampDateSchema>;
export type CampDate = typeof campDates.$inferSelect;
export type InsertCampSettings = z.infer<typeof insertCampSettingsSchema>;
export type CampSettings = typeof campSettings.$inferSelect;
export type InsertChild = z.infer<typeof insertChildSchema>;
export type Child = typeof children.$inferSelect;
export type InsertChildMedical = z.infer<typeof insertChildMedicalSchema>;
export type ChildMedical = typeof childMedical.$inferSelect;
export type InsertRegistrationItem = z.infer<typeof insertRegistrationItemSchema>;
export type RegistrationItem = typeof registrationItems.$inferSelect;
export type InsertAttendance = z.infer<typeof insertAttendanceSchema>;
export type Attendance = typeof attendance.$inferSelect;
export type InsertEmailLog = z.infer<typeof insertEmailLogSchema>;
export type EmailLog = typeof emailLogs.$inferSelect;
export type InsertMetaEventLog = z.infer<typeof insertMetaEventLogSchema>;
export type MetaEventLog = typeof metaEventLogs.$inferSelect;
export type InsertEmailCampaign = z.infer<typeof insertEmailCampaignSchema>;
export type EmailCampaign = typeof emailCampaigns.$inferSelect;
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertFacility = z.infer<typeof insertFacilitySchema>;
export type Facility = typeof facilities.$inferSelect;
export type InsertFacilityPricingRule = z.infer<typeof insertFacilityPricingRuleSchema>;
export type FacilityPricingRule = typeof facilityPricingRules.$inferSelect;
export type InsertFacilityBooking = z.infer<typeof insertFacilityBookingSchema>;
export type FacilityBooking = typeof facilityBookings.$inferSelect;
export type InsertFacilityAddon = z.infer<typeof insertFacilityAddonSchema>;
export type FacilityAddon = typeof facilityAddons.$inferSelect;
export type InsertVenueSettings = z.infer<typeof insertVenueSettingsSchema>;
export type VenueSettings = typeof venueSettings.$inferSelect;
export type InsertLeagueCompetition = z.infer<typeof insertLeagueCompetitionSchema>;
export type LeagueCompetition = typeof leagueCompetitions.$inferSelect;
export type InsertLeagueDivision = z.infer<typeof insertLeagueDivisionSchema>;
export type LeagueDivision = typeof leagueDivisions.$inferSelect;
export type InsertLeagueTeam = z.infer<typeof insertLeagueTeamSchema>;
export type LeagueTeam = typeof leagueTeams.$inferSelect;
export type InsertLeagueGame = z.infer<typeof insertLeagueGameSchema>;
export type LeagueGame = typeof leagueGames.$inferSelect;
export type InsertLeagueCoupon = z.infer<typeof insertLeagueCouponSchema>;
export type LeagueCoupon = typeof leagueCoupons.$inferSelect;
export type InsertLeagueWaitlist = z.infer<typeof insertLeagueWaitlistSchema>;
export type LeagueWaitlistEntry = typeof leagueWaitlist.$inferSelect;
export type InsertSplitSession = z.infer<typeof insertSplitSessionSchema>;
export type SplitSession = typeof splitSessions.$inferSelect;
export type InsertSplitMember = z.infer<typeof insertSplitMemberSchema>;
export type SplitMember = typeof splitMembers.$inferSelect;
export type InsertTournament = z.infer<typeof insertTournamentSchema>;
export type Tournament = typeof tournaments.$inferSelect;
export type InsertTournamentGroup = z.infer<typeof insertTournamentGroupSchema>;
export type TournamentGroup = typeof tournamentGroups.$inferSelect;
export type InsertClub = z.infer<typeof insertClubSchema>;
export type Club = typeof clubs.$inferSelect;
export type InsertTournamentTeam = z.infer<typeof insertTournamentTeamSchema>;
export type TournamentTeam = typeof tournamentTeams.$inferSelect;
export type InsertTournamentPlayer = z.infer<typeof insertTournamentPlayerSchema>;
export type TournamentPlayer = typeof tournamentPlayers.$inferSelect;
export type InsertTournamentGoal = z.infer<typeof insertTournamentGoalSchema>;
export type TournamentGoal = typeof tournamentGoals.$inferSelect;
export type InsertTournamentStaff = z.infer<typeof insertTournamentStaffSchema>;
export type TournamentStaff = typeof tournamentStaff.$inferSelect;
export type InsertTournamentGame = z.infer<typeof insertTournamentGameSchema>;
export type TournamentGame = typeof tournamentGames.$inferSelect;
export type InsertTournamentMvpVote = z.infer<typeof insertTournamentMvpVoteSchema>;
export type TournamentMvpVote = typeof tournamentMvpVotes.$inferSelect;
export type InsertTournamentGkRating = z.infer<typeof insertTournamentGkRatingSchema>;
export type TournamentGkRating = typeof tournamentGkRatings.$inferSelect;
export type InsertTournamentCard = z.infer<typeof insertTournamentCardSchema>;
export type TournamentCard = typeof tournamentCards.$inferSelect;
export type InsertTournamentPenaltyKick = z.infer<typeof insertTournamentPenaltyKickSchema>;
export type TournamentPenaltyKick = typeof tournamentPenaltyKicks.$inferSelect;

export const discounts = pgTable("discounts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  code: text("code"),
  type: text("type").notNull().default("amount_off_order"),
  method: text("method").notNull().default("code"),
  valueType: text("value_type").notNull().default("percentage"),
  value: decimal("value", { precision: 10, scale: 2 }).notNull().default("0"),
  appliesTo: text("applies_to").notNull().default("all"),
  campIds: integer("camp_ids").array(),
  eligibility: text("eligibility").notNull().default("all"),
  customerEmails: text("customer_emails").array(),
  minPurchaseType: text("min_purchase_type").notNull().default("none"),
  minPurchaseValue: decimal("min_purchase_value", { precision: 10, scale: 2 }),
  minQuantity: integer("min_quantity"),
  maxTotalUses: integer("max_total_uses"),
  onePerCustomer: boolean("one_per_customer").notNull().default(false),
  combinesWithProduct: boolean("combines_with_product").notNull().default(false),
  combinesWithOrder: boolean("combines_with_order").notNull().default(false),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date"),
  status: text("status").notNull().default("active"),
  timesUsed: integer("times_used").notNull().default(0),
  totalDiscountedCents: integer("total_discounted_cents").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const discountUsages = pgTable("discount_usages", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  discountId: integer("discount_id").notNull().references(() => discounts.id, { onDelete: "cascade" }),
  registrationId: integer("registration_id").references(() => registrations.id),
  contactEmail: text("contact_email"),
  discountedCents: integer("discounted_cents").notNull().default(0),
  usedAt: timestamp("used_at").defaultNow().notNull(),
});

export const apiKeys = pgTable("api_keys", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  createdById: integer("created_by_id").notNull().references(() => users.id),
  scopes: text("scopes").array().notNull().default(sql`ARRAY['read']::text[]`),
  // Orgs this key may read. NULL/empty = just organizationId (legacy single-org
  // keys). Enforced in requireApiKey; scopes gate WHAT, this gates WHOSE.
  allowedOrgIds: integer("allowed_org_ids").array(),
  // Set on keys created by POST /api/admin/api-keys/:id/rotate — points at the
  // key this one replaced (which keeps working until its grace expiry).
  rotatedFromId: integer("rotated_from_id"),
  lastUsedAt: timestamp("last_used_at"),
  expiresAt: timestamp("expires_at"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// One row per authenticated /api/v1/* request — the audit trail for every
// external system holding a key (staff AIOS collectors, Sporty). Written
// fire-and-forget after the response settles.
export const apiKeyRequestLogs = pgTable("api_key_request_logs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  apiKeyId: integer("api_key_id").notNull().references(() => apiKeys.id, { onDelete: "cascade" }),
  method: text("method").notNull(),
  path: text("path").notNull(),
  status: integer("status"),
  ip: text("ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ApiKeyRequestLog = typeof apiKeyRequestLogs.$inferSelect;

// Failed key-auth attempts (invalid/expired key presented). Feeds the per-IP
// brute-force limiter and the security-alert emails. presentedPrefix stores
// only the first 12 chars of whatever was presented — enough to tell a typo'd
// real key from random guessing, never a usable secret.
export const apiAuthFailures = pgTable("api_auth_failures", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  ip: text("ip"),
  path: text("path"),
  presentedPrefix: text("presented_prefix"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ApiAuthFailure = typeof apiAuthFailures.$inferSelect;

export const insertDiscountSchema2 = createInsertSchema(discounts).omit({ id: true, createdAt: true, updatedAt: true, timesUsed: true, totalDiscountedCents: true });
export type InsertDiscount2 = z.infer<typeof insertDiscountSchema2>;
export type Discount = typeof discounts.$inferSelect;

export const insertDiscountUsageSchema = createInsertSchema(discountUsages).omit({ id: true, usedAt: true });
export type InsertDiscountUsage = z.infer<typeof insertDiscountUsageSchema>;
export type DiscountUsage = typeof discountUsages.$inferSelect;

export const insertApiKeySchema = createInsertSchema(apiKeys).omit({ id: true, createdAt: true });
export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type ApiKey = typeof apiKeys.$inferSelect;

export const customDomains = pgTable("custom_domains", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  domain: text("domain").notNull().unique(),
  status: text("status").notNull().default("pending"),
  verified: boolean("verified").notNull().default(false),
  verifiedAt: timestamp("verified_at"),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCustomDomainSchema = createInsertSchema(customDomains).omit({ id: true, createdAt: true, verifiedAt: true });
export type InsertCustomDomain = z.infer<typeof insertCustomDomainSchema>;
export type CustomDomain = typeof customDomains.$inferSelect;

export const calendarEvents = pgTable("calendar_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  location: text("location"),
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time").notNull(),
  allDay: boolean("all_day").notNull().default(false),
  calendarType: text("calendar_type").notNull().default("general"),
  color: text("color").notNull().default("#3b82f6"),
  recurrence: text("recurrence"),
  amount: decimal("amount", { precision: 12, scale: 2 }),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCalendarEventSchema = createInsertSchema(calendarEvents).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCalendarEvent = z.infer<typeof insertCalendarEventSchema>;
export type CalendarEvent = typeof calendarEvents.$inferSelect;

// Per-event guest list. A guest is either an internal user (userId set) or
// an external invitee with just an email. RSVP token is opaque random — the
// public RSVP page (no auth) uses it to identify which row to update.
export const eventInvitees = pgTable("event_invitees", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  eventId: integer("event_id").notNull().references(() => calendarEvents.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  email: text("email").notNull(),
  name: text("name"),
  // pending | accepted | tentative | declined
  rsvpStatus: text("rsvp_status").notNull().default("pending"),
  rsvpToken: text("rsvp_token").notNull().unique(),
  invitedBy: integer("invited_by").references(() => users.id),
  invitedAt: timestamp("invited_at").defaultNow().notNull(),
  respondedAt: timestamp("responded_at"),
  inviteEmailSentAt: timestamp("invite_email_sent_at"),
});

// Reminders fire N minutes before an event's startTime. One event can have
// multiple. The cron sweeper picks up rows where (event.startTime - offset)
// has passed and sentAt is null. Channel is "email" for v1; "sms" / "push"
// to follow when Twilio / app are wired in.
export const eventReminders = pgTable("event_reminders", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  eventId: integer("event_id").notNull().references(() => calendarEvents.id, { onDelete: "cascade" }),
  // Minutes before startTime. e.g. 10, 30, 60, 720 (12h), 1440 (24h), 10080 (1w)
  offsetMinutes: integer("offset_minutes").notNull(),
  channel: text("channel").notNull().default("email"), // email | sms | push
  sentAt: timestamp("sent_at"),                         // null until dispatched
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEventInviteeSchema = createInsertSchema(eventInvitees).omit({ id: true, invitedAt: true });
export const insertEventReminderSchema = createInsertSchema(eventReminders).omit({ id: true, createdAt: true });
export type InsertEventInvitee = z.infer<typeof insertEventInviteeSchema>;
export type InsertEventReminder = z.infer<typeof insertEventReminderSchema>;
export type EventInvitee = typeof eventInvitees.$inferSelect;
export type EventReminder = typeof eventReminders.$inferSelect;

// Per-organization calendar categories (a.k.a. sub-calendars) — admins can create their own.
// Each event references one via the existing calendarEvents.calendarType slug.
export const calendarCategories = pgTable("calendar_categories", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  label: text("label").notNull(),
  color: text("color").notNull().default("#3b82f6"),
  displayOrder: integer("display_order").notNull().default(0),
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uniqueOrgSlug: unique("calendar_categories_org_slug_unique").on(t.organizationId, t.slug),
}));

export const insertCalendarCategorySchema = createInsertSchema(calendarCategories).omit({ id: true, createdAt: true });
export type InsertCalendarCategory = z.infer<typeof insertCalendarCategorySchema>;
export type CalendarCategory = typeof calendarCategories.$inferSelect;

// ── Project management ───────────────────────────────────────────────────────
// Lightweight Monday-style boards/groups/tasks. Tasks live in the USG
// "command center" workspace and use brand_tags (multi-select) so a single
// task can show up in multiple brand views — e.g. "design CIC sponsor pack"
// tagged ['cic','sponsorship'] appears in both filters.

export const taskPriorityEnum = pgEnum("task_priority", ["low", "medium", "high", "urgent"]);

export const projectBoards = pgTable("project_boards", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  // Default brand context for tasks created in this board (still overridable per task).
  brandTags: text("brand_tags").array().notNull().default(sql`ARRAY[]::text[]`),
  color: text("color").default("#3b82f6"),
  archived: boolean("archived").notNull().default(false),
  displayOrder: integer("display_order").notNull().default(0),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const projectGroups = pgTable("project_groups", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  boardId: integer("board_id").notNull().references(() => projectBoards.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").default("#6b7280"),
  // is_done = treat tasks in this group as completed (auto-fills completedAt).
  isDone: boolean("is_done").notNull().default(false),
  displayOrder: integer("display_order").notNull().default(0),
});

export const projectTasks = pgTable("project_tasks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  boardId: integer("board_id").notNull().references(() => projectBoards.id, { onDelete: "cascade" }),
  groupId: integer("group_id").references(() => projectGroups.id, { onDelete: "set null" }),
  // Self-ref. Null = top-level task. Set = subtask whose lifecycle follows
  // its parent (cascade delete). Subtasks keep every other column independent
  // — their own owner, due date, status, brand tags — so they show up in
  // My Tasks / Calendar as first-class items.
  parentId: integer("parent_id").references((): any => projectTasks.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  priority: taskPriorityEnum("priority").notNull().default("medium"),
  ownerId: integer("owner_id").references(() => users.id),
  dueDate: date("due_date"),
  brandTags: text("brand_tags").array().notNull().default(sql`ARRAY[]::text[]`),
  // ── Work-management additions (2026-07-04) ──
  // The DEPARTMENT that owns this task — the second axis of the matrix. Brand =
  // who it serves (brandTags), Department = who's accountable (single).
  departmentId: integer("department_id").references((): any => departments.id, { onDelete: "set null" }),
  // Self-reported traffic light for the meeting / leadership rollup, separate
  // from workflow status. none | on_track | at_risk | off_track.
  ragStatus: text("rag_status").notNull().default("none"),
  // Start-by date for backward planning ("should be underway now").
  startDate: date("start_date"),
  nextStep: text("next_step"),
  // Raised as a blocker/issue to solve in the weekly meeting (IDS).
  isIssue: boolean("is_issue").notNull().default(false),
  // Collaborators ("who's helping"). Owner stays single (ownerId) for accountability.
  helperIds: integer("helper_ids").array().notNull().default(sql`ARRAY[]::integer[]`),
  // Line-of-sight: the Priority ("Rock") this task ladders up to.
  goalId: integer("goal_id").references((): any => goals.id, { onDelete: "set null" }),
  displayOrder: integer("display_order").notNull().default(0),
  completedAt: timestamp("completed_at"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertProjectBoardSchema = createInsertSchema(projectBoards).omit({ id: true, createdAt: true });
export const insertProjectGroupSchema = createInsertSchema(projectGroups).omit({ id: true });
export const insertProjectTaskSchema = createInsertSchema(projectTasks).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProjectBoard = z.infer<typeof insertProjectBoardSchema>;
export type InsertProjectGroup = z.infer<typeof insertProjectGroupSchema>;
export type InsertProjectTask = z.infer<typeof insertProjectTaskSchema>;
export type ProjectBoard = typeof projectBoards.$inferSelect;
export type ProjectGroup = typeof projectGroups.$inferSelect;
export type ProjectTask = typeof projectTasks.$inferSelect;

// ── Departments ──────────────────────────────────────────────────────────────
// The team that owns work — the second axis alongside brand tags. Seeded with 7
// defaults for the USG workspace, editable in settings. A task/goal references
// one department (single accountable team); brands stay a multi-select tag.
export const departments = pgTable("departments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  color: text("color").notNull().default("#3b82f6"),
  leadUserId: integer("lead_user_id").references(() => users.id, { onDelete: "set null" }),
  sortOrder: integer("sort_order").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uniqueOrgSlug: unique("departments_org_slug_unique").on(t.organizationId, t.slug),
}));

export const insertDepartmentSchema = createInsertSchema(departments).omit({ id: true, createdAt: true });
export type InsertDepartment = z.infer<typeof insertDepartmentSchema>;
export type Department = typeof departments.$inferSelect;

// ── Goals ladder ─────────────────────────────────────────────────────────────
// One self-referential table for all three tiers (level): Vision → Season Goal →
// Priority ("Rock"). parent_id links a Priority to its Season Goal etc. Tasks link
// up via projectTasks.goalId. Brand is a tag at every level; department = owner-team.
export const goals = pgTable("goals", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  level: text("level").notNull().default("priority"), // vision | season | priority
  parentId: integer("parent_id").references((): any => goals.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description"),
  ownerId: integer("owner_id").references(() => users.id, { onDelete: "set null" }),
  departmentId: integer("department_id").references(() => departments.id, { onDelete: "set null" }),
  brandTags: text("brand_tags").array().notNull().default(sql`ARRAY[]::text[]`),
  ragStatus: text("rag_status").notNull().default("on_track"), // none|on_track|at_risk|off_track
  period: text("period"),        // '2026' (season) or '2026-Q3' (priority)
  targetDate: date("target_date"),
  archived: boolean("archived").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const goalMeasures = pgTable("goal_measures", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  goalId: integer("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  measureType: text("measure_type").notNull().default("lead"), // lead | lag
  targetValue: decimal("target_value"),
  currentValue: decimal("current_value").default("0"),
  unit: text("unit"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertGoalSchema = createInsertSchema(goals).omit({ id: true, createdAt: true, updatedAt: true });
export const insertGoalMeasureSchema = createInsertSchema(goalMeasures).omit({ id: true, createdAt: true });
export type InsertGoal = z.infer<typeof insertGoalSchema>;
export type InsertGoalMeasure = z.infer<typeof insertGoalMeasureSchema>;
export type Goal = typeof goals.$inferSelect;
export type GoalMeasure = typeof goalMeasures.$inferSelect;

// ── Playbooks (task templates + backward planning) ───────────────────────────
// A reusable checklist for a recurring event (run a tournament, launch a term,
// onboard a sponsor). Applying a playbook to an anchor date generates real tasks
// whose due dates = anchor + offsetDays (negative = before the event), so prep
// back-plans itself and nothing lands last-minute. See the 2026-07-05 migration.
export const taskTemplates = pgTable("task_templates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  // What the anchor date represents, e.g. "Tournament day", "Term start".
  anchorLabel: text("anchor_label").notNull().default("Event day"),
  departmentId: integer("department_id").references(() => departments.id, { onDelete: "set null" }),
  brandTags: text("brand_tags").array().notNull().default(sql`ARRAY[]::text[]`),
  color: text("color").notNull().default("#3b82f6"),
  archived: boolean("archived").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const taskTemplateItems = pgTable("task_template_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  templateId: integer("template_id").notNull().references(() => taskTemplates.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  // Days relative to the anchor date. Negative = before the event (prep),
  // 0 = event day, positive = after (wrap-up). The backward-planning core.
  offsetDays: integer("offset_days").notNull().default(0),
  priority: taskPriorityEnum("priority").notNull().default("medium"),
  departmentId: integer("department_id").references(() => departments.id, { onDelete: "set null" }),
  brandTags: text("brand_tags").array().notNull().default(sql`ARRAY[]::text[]`),
  nextStep: text("next_step"),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const insertTaskTemplateSchema = createInsertSchema(taskTemplates).omit({ id: true, createdAt: true });
export const insertTaskTemplateItemSchema = createInsertSchema(taskTemplateItems).omit({ id: true });
export type InsertTaskTemplate = z.infer<typeof insertTaskTemplateSchema>;
export type InsertTaskTemplateItem = z.infer<typeof insertTaskTemplateItemSchema>;
export type TaskTemplate = typeof taskTemplates.$inferSelect;
export type TaskTemplateItem = typeof taskTemplateItems.$inferSelect;

// ── Sponsorship CRM ──────────────────────────────────────────────────────────
// Pipeline + lifecycle tracker for sponsorship deals across every brand.
// Stages match Daniel's existing Pipedrive flow so muscle memory carries over,
// but the schema captures the sport-specific fields (asset category, term,
// exclusivity, contra value) that generic CRMs miss.

export const sponsorshipDealStageEnum = pgEnum("sponsorship_deal_stage", [
  "new_lead", "contact_made", "qualified", "call_scheduled",
  "proposal_sent", "negotiating", "won", "lost",
  "contract_sent", "invoice_sent", "invoice_paid", "onboarded", "active",
]);

export const sponsorshipDealTypeEnum = pgEnum("sponsorship_deal_type", ["cash", "contra", "hybrid"]);

export const sponsorshipDeals = pgTable("sponsorship_deals", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sponsorCompany: text("sponsor_company").notNull(),
  primaryContactName: text("primary_contact_name"),
  primaryContactEmail: text("primary_contact_email"),
  primaryContactPhone: text("primary_contact_phone"),
  stage: sponsorshipDealStageEnum("stage").notNull().default("new_lead"),
  stageChangedAt: timestamp("stage_changed_at").defaultNow().notNull(),
  dealValueCents: integer("deal_value_cents").default(0),
  contraValueCents: integer("contra_value_cents").default(0),
  dealType: sponsorshipDealTypeEnum("deal_type").notNull().default("cash"),
  currency: text("currency").notNull().default("NZD"),
  brandTags: text("brand_tags").array().notNull().default(sql`ARRAY[]::text[]`),
  assetCategory: text("asset_category"),
  termMonths: integer("term_months"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  exclusivity: text("exclusivity"),
  ownerId: integer("owner_id").references(() => users.id),
  source: text("source"),
  probability: integer("probability").default(10),
  expectedCloseDate: date("expected_close_date"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSponsorshipDealSchema = createInsertSchema(sponsorshipDeals).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSponsorshipDeal = z.infer<typeof insertSponsorshipDealSchema>;
export type SponsorshipDeal = typeof sponsorshipDeals.$inferSelect;

// Deliverables — what we promised the sponsor. The single biggest renewal
// driver (per industry research): "done" requires proof_url evidence. Each
// deal can have N deliverables (LED rotations, social posts, hospitality
// nights, signage, content series, etc.).
export const deliverableStatusEnum = pgEnum("deliverable_status", ["pending", "in_progress", "delivered", "overdue", "waived"]);
export const deliverableTriggerEnum = pgEnum("deliverable_trigger", ["once", "per_match", "weekly", "monthly", "quarterly", "annually"]);

export const sponsorshipDeliverables = pgTable("sponsorship_deliverables", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  dealId: integer("deal_id").notNull().references(() => sponsorshipDeals.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  type: text("type"),
  // 'contract' = from the signed contract (front-of-shirt, social posts, signage)
  // 'onboarding' = standard welcome items (book, merch pack, WhatsApp group)
  // 'activation' = scheduled live activations (LED rotation, matchday MC)
  // 'other' = ad-hoc
  category: text("category").notNull().default("contract"),
  triggerType: deliverableTriggerEnum("trigger_type").notNull().default("once"),
  scheduledDate: date("scheduled_date"),
  entitlementQty: integer("entitlement_qty").default(1),
  usedQty: integer("used_qty").default(0),
  status: deliverableStatusEnum("status").notNull().default("pending"),
  ownerId: integer("owner_id").references(() => users.id),
  proofUrl: text("proof_url"),
  deliveredAt: timestamp("delivered_at"),
  notes: text("notes"),
  displayOrder: integer("display_order").notNull().default(0),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSponsorshipDeliverableSchema = createInsertSchema(sponsorshipDeliverables).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSponsorshipDeliverable = z.infer<typeof insertSponsorshipDeliverableSchema>;
export type SponsorshipDeliverable = typeof sponsorshipDeliverables.$inferSelect;

// Org-level template of standard onboarding items applied to every won deal.
// When a deal flips to "won" or later, the engine reads every active template
// row and instantiates one deliverable per item with category='onboarding'.
export const sponsorshipOnboardingTemplates = pgTable("sponsorship_onboarding_templates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  defaultOwnerId: integer("default_owner_id").references(() => users.id),
  displayOrder: integer("display_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSponsorshipOnboardingTemplateSchema = createInsertSchema(sponsorshipOnboardingTemplates).omit({ id: true, createdAt: true });
export type InsertSponsorshipOnboardingTemplate = z.infer<typeof insertSponsorshipOnboardingTemplateSchema>;
export type SponsorshipOnboardingTemplate = typeof sponsorshipOnboardingTemplates.$inferSelect;

// ── Sponsorship prospect database (raw scraped outreach leads) ───────────────
// Top-of-funnel research/scraping list, kept SEPARATE from sponsorship_deals so
// the qualified pipeline isn't cluttered. When a prospect is actioned it is
// "promoted" into a sponsorship_deals row (status -> 'promoted', promoted_deal_id set).
export const sponsorshipProspectStatusEnum = pgEnum("sponsorship_prospect_status", [
  "new", "reviewing", "shortlisted", "promoted", "dismissed",
]);

export const sponsorshipProspects = pgTable("sponsorship_prospects", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  company: text("company").notNull(),
  website: text("website"),
  sector: text("sector"),
  location: text("location"),
  brandTags: text("brand_tags").array().notNull().default(sql`ARRAY[]::text[]`),
  segment: text("segment"),                  // research segment id, e.g. SP1
  category: text("category"),                // commercial category, e.g. hydration / automotive / finance
  tier: text("tier"),                        // A | B | C
  fitScore: integer("fit_score"),
  spendCapacityScore: integer("spend_capacity_score"),
  reachabilityScore: integer("reachability_score"),
  capacityEstimate: text("capacity_estimate"),
  alreadyBacksSport: boolean("already_backs_sport"),
  sportEvidence: text("sport_evidence"),
  whyFit: text("why_fit"),
  brief: text("brief"),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  emailConfidence: text("email_confidence"),
  contactPhone: text("contact_phone"),
  decisionMakerName: text("decision_maker_name"),
  decisionMakerRole: text("decision_maker_role"),
  decisionMakerLinkedin: text("decision_maker_linkedin"),
  linkedinUrl: text("linkedin_url"),
  sources: text("sources").array().notNull().default(sql`ARRAY[]::text[]`),
  gradeRationale: text("grade_rationale"),
  detail: text("detail"),                    // JSON string: full decision_makers[], socials{}, size_signal
  status: sponsorshipProspectStatusEnum("status").notNull().default("new"),
  promotedDealId: integer("promoted_deal_id").references(() => sponsorshipDeals.id, { onDelete: "set null" }),
  ownerId: integer("owner_id").references(() => users.id),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSponsorshipProspectSchema = createInsertSchema(sponsorshipProspects).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSponsorshipProspect = z.infer<typeof insertSponsorshipProspectSchema>;
export type SponsorshipProspect = typeof sponsorshipProspects.$inferSelect;

// ── Grant funding (USG workspace) ───────────────────────────────────────────
// Funder directory + application tracker. Brings the grants process in-house:
// what's out there, what we applied for, what got approved/declined and for
// how much. Applications keep a denormalised funderName so history survives
// funder-row deletion.

export const grantApplicationStatusEnum = pgEnum("grant_application_status", [
  "planning", "drafting", "submitted", "approved", "declined", "paid", "acquitted", "withdrawn",
]);

export const grantFunders = pgTable("grant_funders", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  funderType: text("funder_type"),           // Class 4 gaming trust | community trust | council | philanthropic
  geography: text("geography"),
  whatTheyFund: text("what_they_fund"),
  priorityScore: integer("priority_score"),  // 1-5
  typicalGrant: text("typical_grant"),
  maxGrant: text("max_grant"),
  applicationWindows: text("application_windows"),
  eligibility: text("eligibility"),
  relationshipRequirements: text("relationship_requirements"),
  proSportExcluded: boolean("pro_sport_excluded"), // Class-4 trusts barring professional sport → SIU ineligible
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  website: text("website"),
  segment: text("segment"),
  notes: text("notes"),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const grantApplications = pgTable("grant_applications", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  funderId: integer("funder_id").references(() => grantFunders.id, { onDelete: "set null" }),
  funderName: text("funder_name").notNull(),
  projectTitle: text("project_title").notNull(),
  purpose: text("purpose"),
  brandTags: text("brand_tags").array().notNull().default(sql`ARRAY[]::text[]`),
  amountRequestedCents: integer("amount_requested_cents").notNull().default(0),
  amountApprovedCents: integer("amount_approved_cents"),
  status: grantApplicationStatusEnum("status").notNull().default("planning"),
  round: text("round"),                      // e.g. "Aug 2026 committee"
  owner: text("owner"),                      // Tim Shanahan / Daniel / Ryan
  referenceNumber: text("reference_number"),
  submittedAt: timestamp("submitted_at"),
  decisionAt: timestamp("decision_at"),
  paidAt: timestamp("paid_at"),
  acquittalDueAt: timestamp("acquittal_due_at"),
  acquittedAt: timestamp("acquitted_at"),
  docsUrl: text("docs_url"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Structured application-window calendar: one row per funding window (a dated
// round, a rolling window, or an end-of-financial-year surplus window) so the
// Grants tab can render a real deadline calendar. Dates stored as YYYY-MM-DD
// text; carries funderName + display fields so the calendar renders standalone
// even when a window has no matching funder row.
export const grantFunderDeadlines = pgTable("grant_funder_deadlines", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  funderId: integer("funder_id").references(() => grantFunders.id, { onDelete: "set null" }),
  funderName: text("funder_name").notNull(),
  label: text("label"),
  kind: text("kind"),                        // fixed_round | rolling | eofy_surplus | notable_opportunity
  opensOn: text("opens_on"),                 // YYYY-MM-DD
  closesOn: text("closes_on"),               // YYYY-MM-DD
  decisionOn: text("decision_on"),           // YYYY-MM-DD
  eventYear: integer("event_year"),
  amountHint: text("amount_hint"),
  confidence: text("confidence"),            // verified | likely | inferred
  relevance: text("relevance"),              // core | conditional | ruled_out
  proSportExcluded: boolean("pro_sport_excluded"),
  sourceUrl: text("source_url"),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertGrantFunderSchema = createInsertSchema(grantFunders).omit({ id: true, createdAt: true, updatedAt: true });
export type GrantFunder = typeof grantFunders.$inferSelect;
export const insertGrantApplicationSchema = createInsertSchema(grantApplications).omit({ id: true, createdAt: true, updatedAt: true });
export type GrantApplication = typeof grantApplications.$inferSelect;
export type GrantFunderDeadline = typeof grantFunderDeadlines.$inferSelect;

// ── OFC Pro League licensing tracker (SIU workspace) ────────────────────────
// Live workbook of every licensing criterion + its evidence sub-items. Seeded
// from the "Analysis Tracker.xlsx" matrix. Ryan/Zach work it together toward the
// resubmission deadline; per-criterion OFC feedback + working status + subtask
// checklist. Rows keyed by organizationId (SIU = 2) like every org-scoped table.

export const licensingCriteria = pgTable("licensing_criteria", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  code: text("code").notNull(),                    // 'S.01', 'P.12', 'Article 21.2(d)'
  category: text("category").notNull(),            // Sporting | Legal | Financial | ...
  name: text("name").notNull(),
  grade: text("grade").notNull().default("A"),     // A | B | C
  requirementType: text("requirement_type"),
  owner: text("owner"),                            // Ryan | Dan | Zach | null
  deadline: date("deadline"),
  status: text("status").notNull().default("not_started"),
  assessment: text("assessment"),                  // OFC-material assessment
  priority: text("priority"),                      // High | Medium | Low
  maturityTarget: integer("maturity_target"),      // 1 or 3 (score-3 bar)
  actionRequired: text("action_required"),
  evidence2025: text("evidence_2025"),
  keyRisk: text("key_risk"),
  sourceUrls: text("source_urls"),
  ofcFeedback: text("ofc_feedback"),               // OFC review feedback → resubmit
  resubmitNeeded: boolean("resubmit_needed").notNull().default(false),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const licensingSubtasks = pgTable("licensing_subtasks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  criterionId: integer("criterion_id").notNull().references(() => licensingCriteria.id, { onDelete: "cascade" }),
  code: text("code").notNull(),                    // parent criterion code (denormalised)
  itemNum: text("item_num"),
  description: text("description").notNull(),
  grade: text("grade"),
  required: boolean("required").notNull().default(true),
  dueDate: date("due_date"),
  status: text("status").notNull().default("not_started"), // not_started | in_progress | done | na
  evidence2025: text("evidence_2025"),
  actionRequired: text("action_required"),
  sourceUrls: text("source_urls"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertLicensingCriterionSchema = createInsertSchema(licensingCriteria).omit({ id: true, createdAt: true, updatedAt: true });
export type LicensingCriterion = typeof licensingCriteria.$inferSelect;
export const insertLicensingSubtaskSchema = createInsertSchema(licensingSubtasks).omit({ id: true, createdAt: true, updatedAt: true });
export type LicensingSubtask = typeof licensingSubtasks.$inferSelect;

// ── Community engagement events (SIU workspace) ─────────────────────────────
// One board for fan/community events: outreach pipeline → plan → run → review.
// Ruby/Conor (merch), Brad (fan engagement / watch-alongs), club/school visits.
export const communityEvents = pgTable("community_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  eventType: text("event_type").notNull().default("other"),
  status: text("status").notNull().default("idea"),
  owner: text("owner"),
  partner: text("partner"),
  eventDate: date("event_date"),
  location: text("location"),
  description: text("description"),
  outreachNotes: text("outreach_notes"),
  reviewNotes: text("review_notes"),
  attendance: integer("attendance"),
  reach: text("reach"),
  links: text("links"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCommunityEventSchema = createInsertSchema(communityEvents).omit({ id: true, createdAt: true, updatedAt: true });
export type CommunityEvent = typeof communityEvents.$inferSelect;

// Tasks/deadlines attached to a community event (drives the events calendar).
export const communityEventTasks = pgTable("community_event_tasks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  eventId: integer("event_id").notNull().references(() => communityEvents.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  dueDate: date("due_date"),
  done: boolean("done").notNull().default(false),
  owner: text("owner"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export const insertCommunityEventTaskSchema = createInsertSchema(communityEventTasks).omit({ id: true, createdAt: true, updatedAt: true });
export type CommunityEventTask = typeof communityEventTasks.$inferSelect;

// ── Membership Program (SIU workspace) — PLACEHOLDER scaffold ────────────────
// Tiers (Bronze/Silver/Gold placeholders), members CRM, deliverables/perks
// roadmap for fulfilment. No live payments wired yet — prices are placeholders.
export const membershipTiers = pgTable("membership_tiers", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  tagline: text("tagline"),
  priceCents: integer("price_cents").notNull().default(0),
  billingInterval: text("billing_interval").notNull().default("yearly"),
  color: text("color"),
  benefits: jsonb("benefits").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const members = pgTable("members", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  tierId: integer("tier_id").references(() => membershipTiers.id, { onDelete: "set null" }),
  tierName: text("tier_name"),
  status: text("status").notNull().default("active"),
  billingInterval: text("billing_interval"),
  priceCents: integer("price_cents"),
  paymentStatus: text("payment_status").notNull().default("unpaid"),
  joinedAt: date("joined_at"),
  renewsAt: date("renews_at"),
  notes: text("notes"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  source: text("source"),
  paidAt: timestamp("paid_at"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  fbclid: text("fbclid"),
  referralSource: text("referral_source"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const membershipDeliverables = pgTable("membership_deliverables", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  tiers: jsonb("tiers").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  cadence: text("cadence"),
  status: text("status").notNull().default("idea"),
  owner: text("owner"),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertMembershipTierSchema = createInsertSchema(membershipTiers).omit({ id: true, createdAt: true, updatedAt: true });
export type MembershipTier = typeof membershipTiers.$inferSelect;
export const insertMemberSchema = createInsertSchema(members).omit({ id: true, createdAt: true, updatedAt: true });
export type Member = typeof members.$inferSelect;
export const insertMembershipDeliverableSchema = createInsertSchema(membershipDeliverables).omit({ id: true, createdAt: true, updatedAt: true });
export type MembershipDeliverable = typeof membershipDeliverables.$inferSelect;

// ── Billboard sales (Go Media contra resell) ────────────────────────────────
// USG holds a $250k contra credit with Go Media. We resell slices of that
// credit to local businesses at 20-30% off rate-card, target $200k revenue.
// Tracks credit-consumed vs cap and revenue-collected vs target, plus where
// each lead came from (walk-in / existing sponsor / referral / ad / cold).
export const billboardDealStageEnum = pgEnum("billboard_deal_stage", [
  "lead", "contacted", "quoted", "negotiating",
  "contract_sent", "paid", "live", "completed", "lost",
]);
export const billboardDealSourceEnum = pgEnum("billboard_deal_source", [
  "existing_sponsor", "walk_in", "referral", "ad", "cold_outreach", "inbound", "other",
]);

export const billboardDeals = pgTable("billboard_deals", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  customerName: text("customer_name").notNull(),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  source: billboardDealSourceEnum("source").notNull().default("cold_outreach"),
  sourceNotes: text("source_notes"),
  stage: billboardDealStageEnum("stage").notNull().default("lead"),
  stageChangedAt: timestamp("stage_changed_at").defaultNow().notNull(),
  rateCardValueCents: integer("rate_card_value_cents").notNull().default(0),
  discountPct: integer("discount_pct").notNull().default(20),
  netValueCents: integer("net_value_cents").notNull().default(0),
  revenueCollectedCents: integer("revenue_collected_cents").notNull().default(0),
  creditConsumedCents: integer("credit_consumed_cents").notNull().default(0),
  billboardLocations: text("billboard_locations").array().notNull().default(sql`ARRAY[]::text[]`),
  startDate: date("start_date"),
  endDate: date("end_date"),
  weeksBooked: integer("weeks_booked"),
  expectedCloseDate: date("expected_close_date"),
  ownerId: integer("owner_id").references(() => users.id),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertBillboardDealSchema = createInsertSchema(billboardDeals).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertBillboardDeal = z.infer<typeof insertBillboardDealSchema>;
export type BillboardDeal = typeof billboardDeals.$inferSelect;

// ── Mini Football Leagues — mobile app support ──────────────────────────────
// league_team_members links app users to teams. Parent registering kid:
// contact_id points to kid's contacts row. User-as-player: contact_id null.
export const leagueTeamMembers = pgTable("league_team_members", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  teamId: integer("team_id").notNull().references(() => leagueTeams.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  role: text("role").notNull().default("player"),
  jerseyNumber: integer("jersey_number"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const leagueGameReferees = pgTable("league_game_referees", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  gameId: integer("game_id").notNull().references(() => leagueGames.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  assignedAt: timestamp("assigned_at").defaultNow().notNull(),
});

export const leagueAnnouncements = pgTable("league_announcements", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  competitionId: integer("competition_id").references(() => leagueCompetitions.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  ctaLabel: text("cta_label"),
  ctaUrl: text("cta_url"),
  pinned: boolean("pinned").notNull().default(false),
  publishedAt: timestamp("published_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type LeagueTeamMember = typeof leagueTeamMembers.$inferSelect;
export type LeagueGameReferee = typeof leagueGameReferees.$inferSelect;
export type LeagueAnnouncement = typeof leagueAnnouncements.$inferSelect;

// ── United Prints MIS ────────────────────────────────────────────────────────
// A print shop management system inside ClubOS that does what ShopVox does
// (~NZD $1,000/mo) plus the one thing they don't: a public-facing instant-quote
// flow with embedded Stripe checkout. Reference: plans/2026-05-05-united-prints-mis-v1.md
//
// Lifecycle: draft → quote_sent → paid → artwork_pending → in_design → in_proof
// → proof_approved → in_production → finishing → ready → delivered → cancelled.
// One record (printOrders) carries the full lifecycle — quote and order are
// not separate tables.

export const printOrderStatusEnum = pgEnum("print_order_status", [
  "inquiry", "quoted", "confirmed", "in_production", "ready", "delivered", "cancelled",
  // v1 lifecycle additions:
  "draft", "quote_sent", "paid", "artwork_pending", "in_design", "in_proof",
  "proof_approved", "finishing",
]);

export const printMaterialCategoryEnum = pgEnum("print_material_category", [
  "banner", "corflute", "vinyl_decal", "aluminium", "garment", "rollup", "poster", "sticker", "custom",
]);

export const printPricingMethodEnum = pgEnum("print_pricing_method", [
  "per_m2", "per_piece", "per_piece_tiered", "garment_decoration", "bundle",
]);

// The catalog. The single most important table — every quote derives from a
// material's pricing method, base rate, and rules. Keep this normalised so
// Dima can update prices without code changes.
export const printMaterials = pgTable("print_materials", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  category: printMaterialCategoryEnum("category").notNull(),
  description: text("description"),
  heroImageUrl: text("hero_image_url"),
  isActive: boolean("is_active").notNull().default(true),
  displayOrder: integer("display_order").notNull().default(0),

  pricingMethod: printPricingMethodEnum("pricing_method").notNull(),
  baseRateCents: integer("base_rate_cents").notNull().default(0),
  substrateCostPerM2Cents: integer("substrate_cost_per_m2_cents").notNull().default(0),
  markupMultiplier: decimal("markup_multiplier", { precision: 5, scale: 2 }).notNull().default("2.5"),
  minChargeCents: integer("min_charge_cents").notNull().default(0),

  sizeMinWMm: integer("size_min_w_mm"),
  sizeMaxWMm: integer("size_max_w_mm"),
  sizeMinHMm: integer("size_min_h_mm"),
  sizeMaxHMm: integer("size_max_h_mm"),

  // Add-ons: [{id, name, formula: 'flat'|'per_unit'|'per_m'|'per_perimeter_m', unitPriceCents, default?}]
  addonsJson: jsonb("addons_json").notNull().default(sql`'[]'::jsonb`),
  // [{name, included: true}, ...]
  finishingDefaultJson: jsonb("finishing_default_json").notNull().default(sql`'[]'::jsonb`),
  // [{minQty: 10, discountPct: 5}, ...]
  qtyTiersJson: jsonb("qty_tiers_json").notNull().default(sql`'[]'::jsonb`),
  // For stock-size + bundle products: [{label, w, h, priceCents}, ...]
  sizeTiersJson: jsonb("size_tiers_json").notNull().default(sql`'[]'::jsonb`),

  turnaroundDays: integer("turnaround_days").notNull().default(3),
  rushAvailable: boolean("rush_available").notNull().default(true),
  humanQuoteRequired: boolean("human_quote_required").notNull().default(false),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPrintMaterialSchema = createInsertSchema(printMaterials).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPrintMaterial = z.infer<typeof insertPrintMaterialSchema>;
export type PrintMaterial = typeof printMaterials.$inferSelect;

export const printOrders = pgTable("print_orders", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").references(() => organizations.id, { onDelete: "cascade" }),

  // Order number visible to customer + Dima (e.g. UP-2026-0001). Generated server-side.
  orderNumber: text("order_number").unique(),

  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email"),
  customerPhone: text("customer_phone"),
  customerCompany: text("customer_company"),

  title: text("title").notNull(),
  description: text("description"),
  status: printOrderStatusEnum("status").notNull().default("inquiry"),

  // Money — all in cents. amount kept for back-compat with older rows.
  amount: decimal("amount", { precision: 12, scale: 2 }),
  subtotalCents: integer("subtotal_cents").notNull().default(0),
  gstCents: integer("gst_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull().default(0),
  paidCents: integer("paid_cents").notNull().default(0),

  // Delivery
  deliveryMethod: text("delivery_method").notNull().default("pickup"),  // 'pickup' | 'delivery'
  deliveryAddress: text("delivery_address"),
  deliveryQuoteCents: integer("delivery_quote_cents").notNull().default(0),

  pickupReadyDate: date("pickup_ready_date"),
  dueDate: date("due_date"),

  // Stripe
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripeInvoiceId: text("stripe_invoice_id"),

  // Magic link for the artwork upload portal (random 32-char). Public-readable
  // by token only, no auth needed.
  magicLinkToken: text("magic_link_token").unique(),

  quoteExpiresAt: timestamp("quote_expires_at"),
  customerNotes: text("customer_notes"),
  internalNotes: text("internal_notes"),
  notes: text("notes"),

  rushRequested: boolean("rush_requested").notNull().default(false),

  // ── AttributionOS (additive, T3) ──────────────────────────────────────────
  visitorId: text("visitor_id"),
  clickId: text("click_id"),
  personId: integer("person_id"),
  fbp: text("fbp"),
  fbc: text("fbc"),
  metaAdId: text("meta_ad_id"),
  metaAdsetId: text("meta_adset_id"),
  metaCampaignId: text("meta_campaign_id"),
  metaPlatform: text("meta_platform"),
  attributionChannel: text("attribution_channel"),
  hdyhau: text("hdyhau"),

  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPrintOrderSchema = createInsertSchema(printOrders).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPrintOrder = z.infer<typeof insertPrintOrderSchema>;
export type PrintOrder = typeof printOrders.$inferSelect;

// Line items on each order. Most banner orders are 1 item; garment orders or
// multi-product orders are 2-5. Each line item snapshots the material's
// pricing at quote time so historical orders don't drift if Dima updates
// material prices later.
export const printOrderItems = pgTable("print_order_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer("order_id").notNull().references(() => printOrders.id, { onDelete: "cascade" }),
  materialId: integer("material_id").references(() => printMaterials.id),

  // Snapshot at quote time
  materialName: text("material_name").notNull(),
  description: text("description"),

  widthMm: integer("width_mm"),
  heightMm: integer("height_mm"),
  quantity: integer("quantity").notNull().default(1),
  sides: integer("sides").notNull().default(1),

  // {selectedAddons: [...], finishing: [...]}
  configJson: jsonb("config_json").notNull().default(sql`'{}'::jsonb`),

  // Money — pre-GST. GST is computed at the order level on the sum of items.
  unitPriceCents: integer("unit_price_cents").notNull().default(0),
  qtyDiscountCents: integer("qty_discount_cents").notNull().default(0),
  addonsTotalCents: integer("addons_total_cents").notNull().default(0),
  subtotalCents: integer("subtotal_cents").notNull().default(0),

  // Cost tracking for margin reports
  estimatedCostCents: integer("estimated_cost_cents").notNull().default(0),

  // Human-readable breakdown of how the price was computed (so the customer
  // sees: '4.5 m² × $50/m² × 1', 'Eyelets ×4', 'Qty discount 10%')
  breakdownJson: jsonb("breakdown_json").notNull().default(sql`'[]'::jsonb`),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertPrintOrderItemSchema = createInsertSchema(printOrderItems).omit({ id: true, createdAt: true });
export type InsertPrintOrderItem = z.infer<typeof insertPrintOrderItemSchema>;
export type PrintOrderItem = typeof printOrderItems.$inferSelect;

// Design files / proofs / artwork. Either uploaded by the customer (via the
// magic-link portal) or by Dima (proofs, mockups). Files live in objectAcls
// like every other private file — same flow as team logos and age docs.
export const printOrderFiles = pgTable("print_order_files", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer("order_id").notNull().references(() => printOrders.id, { onDelete: "cascade" }),
  orderItemId: integer("order_item_id").references(() => printOrderItems.id, { onDelete: "cascade" }),
  objectPath: text("object_path").notNull(),
  filename: text("filename").notNull(),
  fileSize: integer("file_size"),
  mimeType: text("mime_type"),
  uploadedBy: text("uploaded_by").notNull().default("customer"),  // 'customer' | 'admin'
  fileType: text("file_type").notNull().default("artwork"),  // 'artwork' | 'proof' | 'reference' | 'invoice'
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
});
export const insertPrintOrderFileSchema = createInsertSchema(printOrderFiles).omit({ id: true, uploadedAt: true });
export type InsertPrintOrderFile = z.infer<typeof insertPrintOrderFileSchema>;
export type PrintOrderFile = typeof printOrderFiles.$inferSelect;

// Activity log on the order. Drives the "Events" tab on the order detail
// page and the customer-facing status timeline.
export const printOrderEvents = pgTable("print_order_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer("order_id").notNull().references(() => printOrders.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  // 'created' | 'quote_sent' | 'paid' | 'artwork_uploaded' | 'in_design' |
  // 'in_proof' | 'proof_approved' | 'in_production' | 'finishing' | 'ready' |
  // 'delivered' | 'cancelled' | 'note_added' | 'email_sent'
  notes: text("notes"),
  metadataJson: jsonb("metadata_json").notNull().default(sql`'{}'::jsonb`),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertPrintOrderEventSchema = createInsertSchema(printOrderEvents).omit({ id: true, createdAt: true });
export type InsertPrintOrderEvent = z.infer<typeof insertPrintOrderEventSchema>;
export type PrintOrderEvent = typeof printOrderEvents.$inferSelect;

export const printProjectStatusEnum = pgEnum("print_project_status", ["planning", "active", "on_hold", "completed", "archived"]);

export const printProjects = pgTable("print_projects", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  clientName: text("client_name").notNull(),
  clientEmail: text("client_email"),
  description: text("description"),
  status: printProjectStatusEnum("status").notNull().default("planning"),
  budget: decimal("budget", { precision: 12, scale: 2 }),
  startDate: date("start_date"),
  endDate: date("end_date"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPrintProjectSchema = createInsertSchema(printProjects).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPrintProject = z.infer<typeof insertPrintProjectSchema>;
export type PrintProject = typeof printProjects.$inferSelect;

export const printContacts = pgTable("print_contacts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  company: text("company"),
  type: text("type").notNull().default("customer"),
  tags: text("tags").array(),
  notes: text("notes"),
  totalOrders: integer("total_orders").notNull().default(0),
  totalRevenue: decimal("total_revenue", { precision: 12, scale: 2 }).default("0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPrintContactSchema = createInsertSchema(printContacts).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPrintContact = z.infer<typeof insertPrintContactSchema>;
export type PrintContact = typeof printContacts.$inferSelect;

export const printLandingPages = pgTable("print_landing_pages", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  headline: text("headline"),
  subheadline: text("subheadline"),
  ctaText: text("cta_text").default("Get a Quote"),
  ctaUrl: text("cta_url"),
  content: text("content"),
  published: boolean("published").notNull().default(false),
  views: integer("views").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPrintLandingPageSchema = createInsertSchema(printLandingPages).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPrintLandingPage = z.infer<typeof insertPrintLandingPageSchema>;
export type PrintLandingPage = typeof printLandingPages.$inferSelect;

export const printEmails = pgTable("print_emails", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  recipientCount: integer("recipient_count").notNull().default(0),
  sentCount: integer("sent_count").notNull().default(0),
  status: text("status").notNull().default("draft"),
  sentAt: timestamp("sent_at"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPrintEmailSchema = createInsertSchema(printEmails).omit({ id: true, createdAt: true });
export type InsertPrintEmail = z.infer<typeof insertPrintEmailSchema>;
export type PrintEmail = typeof printEmails.$inferSelect;

// ── Integrations (Xero, Stripe Connect, etc.) ────────────────────────────
// Per-organization OAuth connections to external services. Refresh tokens
// are 60-day TTL on Xero so we refresh on every API call where the token
// is within 5 mins of expiry.

export const integrationProviderEnum = pgEnum("integration_provider", ["xero", "stripe", "myob", "quickbooks"]);

export const orgIntegrations = pgTable("org_integrations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  provider: integrationProviderEnum("provider").notNull(),
  isActive: boolean("is_active").notNull().default(true),

  // OAuth tokens (Xero)
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiresAt: timestamp("token_expires_at"),

  // Provider-specific identifiers
  externalId: text("external_id"),       // Xero tenant_id, Stripe account_id, etc.
  externalName: text("external_name"),   // Org name as it appears on the provider

  // Provider-specific config (e.g. Xero invoice template, Stripe webhook secret)
  configJson: jsonb("config_json").notNull().default(sql`'{}'::jsonb`),

  connectedAt: timestamp("connected_at").defaultNow().notNull(),
  lastSyncedAt: timestamp("last_synced_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  uniqueOrgProvider: unique().on(t.organizationId, t.provider),
}));
export const insertOrgIntegrationSchema = createInsertSchema(orgIntegrations).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertOrgIntegration = z.infer<typeof insertOrgIntegrationSchema>;
export type OrgIntegration = typeof orgIntegrations.$inferSelect;

// Xero invoice tracking on print orders. Stored separately so we can record
// pushes that succeeded vs failed without bloating the orders table.
export const printXeroInvoices = pgTable("print_xero_invoices", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  printOrderId: integer("print_order_id").notNull().references(() => printOrders.id, { onDelete: "cascade" }),
  xeroInvoiceId: text("xero_invoice_id"),
  xeroInvoiceNumber: text("xero_invoice_number"),
  status: text("status").notNull().default("pending"),  // pending | sent | paid | failed
  errorMessage: text("error_message"),
  pushedAt: timestamp("pushed_at"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertPrintXeroInvoiceSchema = createInsertSchema(printXeroInvoices).omit({ id: true, createdAt: true });
export type InsertPrintXeroInvoice = z.infer<typeof insertPrintXeroInvoiceSchema>;
export type PrintXeroInvoice = typeof printXeroInvoices.$inferSelect;

export const objectAcls = pgTable("object_acls", {
  objectPath: text("object_path").primaryKey(),
  ownerUserId: integer("owner_user_id"),
  visibility: text("visibility").notNull().default("private"),
  aclRulesJson: text("acl_rules_json"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type ObjectAclRow = typeof objectAcls.$inferSelect;
export type InsertObjectAcl = typeof objectAcls.$inferInsert;

export const insertTermSchema = createInsertSchema(terms).omit({ id: true, createdAt: true });
export type InsertTerm = z.infer<typeof insertTermSchema>;

// ── Budget Module (USG workspace) ────────────────────────────────────────────
// Per-cost-centre budgets owned by named staff. Lines roll up into org-wide
// annual + monthly views. One-way Google Sheets sync (Phase 4) stamps
// `sourceSyncId` on every imported line so user edits can be detected.

export const budgetKindEnum = pgEnum("budget_kind", ["income", "expense"]);
export const budgetLineTypeEnum = pgEnum("budget_line_type", ["simple", "computed"]);

export const budgetCostCentres = pgTable("budget_cost_centres", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  // Slug used in URLs and as the natural key the sheet sync matches a sheet
  // tab to a centre row. Unique per (org, year).
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  // Grouping bucket for the rollup. operating | team | shared | tournament.
  bucket: text("bucket").notNull().default("operating"),
  ownerId: integer("owner_id").references(() => users.id),
  year: integer("year").notNull(),
  // True for centres whose totals are computed live from another table
  // (e.g. Sponsorship pulled from sponsorshipDeals). UI redirects to the
  // owning feature instead of showing an editable lines page.
  isVirtual: boolean("is_virtual").notNull().default(false),
  notes: text("notes"),
  displayOrder: integer("display_order").notNull().default(0),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const budgetLines = pgTable("budget_lines", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  costCentreId: integer("cost_centre_id").notNull().references(() => budgetCostCentres.id, { onDelete: "cascade" }),
  // Self-ref. Null = top-level line. Set = sub-line whose parent sums its
  // children (Sheet's row-group pattern: one referee → N per-date payments).
  parentLineId: integer("parent_line_id").references((): any => budgetLines.id, { onDelete: "cascade" }),
  kind: budgetKindEnum("kind").notNull(),
  lineType: budgetLineTypeEnum("line_type").notNull().default("simple"),
  // Section header from the sheet ("Coaching", "Field Hire"). Free-form;
  // grouped client-side. Null = ungrouped.
  section: text("section"),
  name: text("name").notNull(),
  // Always populated. For computed lines this is the cached product of the
  // assumption fields, recomputed on every write.
  amountCents: integer("amount_cents").notNull().default(0),
  // Assumption fields — populated only when lineType = 'computed'.
  unitRateCents: integer("unit_rate_cents"),
  unitsA: decimal("units_a", { precision: 10, scale: 2 }),
  unitsB: decimal("units_b", { precision: 10, scale: 2 }),
  unitsC: decimal("units_c", { precision: 10, scale: 2 }),
  unitLabelA: text("unit_label_a"),
  unitLabelB: text("unit_label_b"),
  unitLabelC: text("unit_label_c"),
  // 12-int-cents array; null = even split of amountCents across 12 months.
  // When set, must sum to amountCents (server-validated on write).
  monthlyPhasing: jsonb("monthly_phasing").$type<number[] | null>(),
  notes: text("notes"),
  displayOrder: integer("display_order").notNull().default(0),
  // Phase 4: set to the budgetSyncRuns.id that last wrote this row from the
  // sheet. Cleared whenever a user edits in-app — drives conflict detection.
  sourceSyncId: integer("source_sync_id"),
  createdBy: integer("created_by").references(() => users.id),
  updatedBy: integer("updated_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const budgetLineAttachments = pgTable("budget_line_attachments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  lineId: integer("line_id").notNull().references(() => budgetLines.id, { onDelete: "cascade" }),
  // receipt | invoice | quote | other
  kind: text("kind").notNull().default("receipt"),
  storageKey: text("storage_key").notNull(),
  originalFilename: text("original_filename").notNull(),
  contentType: text("content_type"),
  sizeBytes: integer("size_bytes"),
  uploadedBy: integer("uploaded_by").references(() => users.id),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  notes: text("notes"),
});

export const budgetSyncRuns = pgTable("budget_sync_runs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  triggeredBy: integer("triggered_by").references(() => users.id),
  source: text("source").notNull().default("google_sheet"),
  sourceRef: text("source_ref"),
  status: text("status").notNull().default("running"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
  rowsAdded: integer("rows_added").notNull().default(0),
  rowsUpdated: integer("rows_updated").notNull().default(0),
  rowsSkipped: integer("rows_skipped").notNull().default(0),
  errorMessage: text("error_message"),
  diffSummary: jsonb("diff_summary"),
});

export const insertBudgetCostCentreSchema = createInsertSchema(budgetCostCentres).omit({ id: true, createdAt: true, updatedAt: true });
export const insertBudgetLineSchema = createInsertSchema(budgetLines).omit({ id: true, createdAt: true, updatedAt: true });
export const insertBudgetLineAttachmentSchema = createInsertSchema(budgetLineAttachments).omit({ id: true, uploadedAt: true });
export const insertBudgetSyncRunSchema = createInsertSchema(budgetSyncRuns).omit({ id: true, startedAt: true });

export type InsertBudgetCostCentre = z.infer<typeof insertBudgetCostCentreSchema>;
export type BudgetCostCentre = typeof budgetCostCentres.$inferSelect;
export type InsertBudgetLine = z.infer<typeof insertBudgetLineSchema>;
export type BudgetLine = typeof budgetLines.$inferSelect;
export type InsertBudgetLineAttachment = z.infer<typeof insertBudgetLineAttachmentSchema>;
export type BudgetLineAttachment = typeof budgetLineAttachments.$inferSelect;
export type InsertBudgetSyncRun = z.infer<typeof insertBudgetSyncRunSchema>;
export type BudgetSyncRun = typeof budgetSyncRuns.$inferSelect;

// ── Xero P&L cache + cost-centre mapping ──────────────────────────────────
// Reuses the existing `org_integrations` row (provider='xero') for OAuth
// tokens. These tables sit on top of that to cache monthly actuals and map
// Xero accounts to budget cost centres.

export const xeroActuals = pgTable("xero_actuals", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  period: text("period").notNull(),     // YYYY-MM
  section: text("section"),             // "Income" / "Less Operating Expenses" / etc.
  account: text("account").notNull(),   // Xero account name
  // Cents, signed. Positive = income inflow OR expense outflow magnitude — we
  // preserve Xero's sign and rely on `section` + mapping `kind` to interpret.
  amountCents: integer("amount_cents").notNull(),
  // Last sync run that wrote this row; cleared if Xero next reports zero
  // (we keep the row, set amount to 0, so the variance shows correctly).
  lastSyncId: integer("last_sync_id"),
  collectedAt: timestamp("collected_at").defaultNow().notNull(),
}, t => ({
  uniqPeriodAccount: uniqueIndex("xero_actuals_org_period_account").on(t.organizationId, t.period, t.account),
}));

export const budgetMappingKindEnum = pgEnum("budget_mapping_kind", ["income", "expense", "ignore"]);

export const budgetAccountMappings = pgTable("budget_account_mappings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  year: integer("year").notNull(),
  // Xero account name as it appears in P&L. Match is exact.
  xeroAccount: text("xero_account").notNull(),
  // null = unmapped (still surfaces in actuals totals but not attributable to
  // a centre). Set = attribute the actual to this cost centre for the year.
  costCentreId: integer("cost_centre_id").references(() => budgetCostCentres.id, { onDelete: "set null" }),
  // 'ignore' = exclude this account from rollups (e.g. inter-account transfers).
  kind: budgetMappingKindEnum("kind").notNull().default("expense"),
  notes: text("notes"),
  updatedBy: integer("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, t => ({
  uniqAccountYear: uniqueIndex("budget_mappings_org_year_account").on(t.organizationId, t.year, t.xeroAccount),
}));

export const xeroSyncRuns = pgTable("xero_sync_runs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  triggeredBy: integer("triggered_by").references(() => users.id),  // null = cron
  status: text("status").notNull().default("running"),  // running | succeeded | failed
  fromPeriod: text("from_period"),
  toPeriod: text("to_period"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
  rowsAdded: integer("rows_added").notNull().default(0),
  rowsUpdated: integer("rows_updated").notNull().default(0),
  rowsSkipped: integer("rows_skipped").notNull().default(0),
  errorMessage: text("error_message"),
});

export const insertXeroActualSchema = createInsertSchema(xeroActuals).omit({ id: true, collectedAt: true });
export const insertBudgetAccountMappingSchema = createInsertSchema(budgetAccountMappings).omit({ id: true, updatedAt: true });
export const insertXeroSyncRunSchema = createInsertSchema(xeroSyncRuns).omit({ id: true, startedAt: true });

export type InsertXeroActual = z.infer<typeof insertXeroActualSchema>;
export type XeroActual = typeof xeroActuals.$inferSelect;
export type InsertBudgetAccountMapping = z.infer<typeof insertBudgetAccountMappingSchema>;
export type BudgetAccountMapping = typeof budgetAccountMappings.$inferSelect;
export type InsertXeroSyncRun = z.infer<typeof insertXeroSyncRunSchema>;
export type XeroSyncRun = typeof xeroSyncRuns.$inferSelect;

export type Term = typeof terms.$inferSelect;

// ---- CIC Skills Challenge ----
// Side-competition run at the tournament. One row per player per challenge
// entry. Registrations come from the public landing page (join.cicyouth.com)
// or from admins adding walk-ups; scores are entered by CIC admins in the
// mobile app or the ClubOS Skills Challenge tab.
// Score semantics per challenge:
//   juggling             → most juggles in 90 seconds (higher is better)
//   dribble_pass_finish  → best time in seconds, 2 attempts (lower is better)
export const skillsChallengeEntries = pgTable("skills_challenge_entries", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  playerName: text("player_name").notNull(),
  clubName: text("club_name").notNull(),
  ageGroup: text("age_group").notNull(), // "U10" | "U11"
  challenge: text("challenge").notNull(), // "juggling" | "dribble_pass_finish"
  score: decimal("score", { precision: 8, scale: 2 }),
  scoredByUserId: integer("scored_by_user_id").references(() => users.id, { onDelete: "set null" }),
  scoredAt: timestamp("scored_at"),
  source: text("source").notNull().default("public"), // "public" | "admin"
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSkillsChallengeEntrySchema = createInsertSchema(skillsChallengeEntries).omit({ id: true, createdAt: true });
export type InsertSkillsChallengeEntry = z.infer<typeof insertSkillsChallengeEntrySchema>;
export type SkillsChallengeEntry = typeof skillsChallengeEntries.$inferSelect;

// ---- Mobile push notifications (CIC Youth app) ----
// Devices register their Expo push token via the public API on app launch;
// broadcasts are composed in the ClubOS "Notifications" tab and fan out through
// Expo's push service in batches of 100. `disabled` flips when Expo reports the
// device as no longer registered (app uninstalled / token rotated).
export const devicePushTokens = pgTable("device_push_tokens", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  token: text("token").notNull().unique(),
  app: text("app").notNull().default("cic-youth"),
  platform: text("platform").notNull().default("unknown"), // "ios" | "android" | "unknown"
  deviceName: text("device_name"),
  disabled: boolean("disabled").notNull().default(false),
  failureCount: integer("failure_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const pushCampaigns = pgTable("push_campaigns", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  app: text("app").notNull().default("cic-youth"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  dataJson: text("data_json"),
  audience: text("audience").notNull().default("all"),
  recipientCount: integer("recipient_count").default(0),
  sentCount: integer("sent_count").default(0),
  failedCount: integer("failed_count").default(0),
  status: text("status").notNull().default("draft"), // "draft" | "sending" | "sent"
  sentByUserId: integer("sent_by_user_id").references(() => users.id, { onDelete: "set null" }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type DevicePushToken = typeof devicePushTokens.$inferSelect;
export type PushCampaign = typeof pushCampaigns.$inferSelect;

// ---- Mobile app users (marketing email list) ----
// When someone signs up / signs in inside the CIC Youth app, their email is
// captured here so CIC can build a segmented marketing list. Deduped by
// (organization, app, email).
export const appUsers = pgTable("app_users", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  app: text("app").notNull().default("cic-youth"),
  email: text("email").notNull(),
  name: text("name"),
  provider: text("provider").notNull().default("email"), // "email" | "apple" | "google"
  category: text("category"), // age-group interest, when known
  unsubscribed: boolean("unsubscribed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type AppUser = typeof appUsers.$inferSelect;

// ---- CIC 7's register-interest submissions (from the cic7s.com marketing site) ----
// Lives under the same CIC organization as the youth tournament; surfaced in the
// "CIC 7's" view of the Tournament workspace.
export const cic7sRegistrations = pgTable("cic7s_registrations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  email: text("email").notNull(),
  location: text("location"),
  phone: text("phone"),
  category: text("category"), // "Mens" | "Masters" | "Social"
  sourceUrl: text("source_url"),
  status: text("status").notNull().default("new"), // "new" | "contacted" | "confirmed" | "archived"
  // ── AttributionOS (additive, T3) ──────────────────────────────────────────
  visitorId: text("visitor_id"),
  clickId: text("click_id"),
  personId: integer("person_id"),
  fbp: text("fbp"),
  fbc: text("fbc"),
  metaAdId: text("meta_ad_id"),
  metaAdsetId: text("meta_adset_id"),
  metaCampaignId: text("meta_campaign_id"),
  metaPlatform: text("meta_platform"),
  attributionChannel: text("attribution_channel"),
  hdyhau: text("hdyhau"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCic7sRegistrationSchema = createInsertSchema(cic7sRegistrations).omit({ id: true, createdAt: true });
export type InsertCic7sRegistration = z.infer<typeof insertCic7sRegistrationSchema>;
export type Cic7sRegistration = typeof cic7sRegistrations.$inferSelect;

// ---- CUGC gymnastics enrolments (from the cugc.co.nz marketing site) ----
// One row per enrolment. Created 'pending_payment' when the family submits the
// enrol form; flipped to 'paid' by the CUGC Stripe webhook. CUGC has its OWN
// Stripe account (separate from the main ClubOS one). Lives under the
// "united-gymnastics" org and is surfaced in the Gymnastics workspace →
// Registrations tab. priceCents is the (possibly prorated) amount actually paid;
// fullPriceCents is the advertised full-term price.
export const cugcRegistrations = pgTable("cugc_registrations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  programSlug: text("program_slug").notNull(),
  programName: text("program_name").notNull(),
  optionLabel: text("option_label").notNull(),
  sessionTime: text("session_time"),
  priceCents: integer("price_cents").notNull(),          // what they pay today
  fullPriceCents: integer("full_price_cents").notNull(), // advertised full-term price
  term: text("term"),
  gymnastName: text("gymnast_name").notNull(),
  gymnastDob: text("gymnast_dob"),
  parentName: text("parent_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  emergencyName: text("emergency_name"),
  emergencyPhone: text("emergency_phone"),
  medical: text("medical"),
  photoConsent: text("photo_consent"),
  heardVia: text("heard_via"),
  status: text("status").notNull().default("pending_payment"), // 'pending_payment' | 'paid' | 'cancelled'
  stripeSessionId: text("stripe_session_id"),
  stripePaymentIntent: text("stripe_payment_intent"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  // First/last-touch ad attribution captured on cugc.co.nz (utm_*, fbclid,
  // referrer, landing page, visit count) — the "which ad created this customer"
  // record that CAC/LTV reporting is built on.
  attribution: jsonb("attribution"),
  // ── AttributionOS (additive, T3) — HDYHAU reuses heard_via above ───────────
  visitorId: text("visitor_id"),
  clickId: text("click_id"),
  personId: integer("person_id"),
  fbp: text("fbp"),
  fbc: text("fbc"),
  metaAdId: text("meta_ad_id"),
  metaAdsetId: text("meta_adset_id"),
  metaCampaignId: text("meta_campaign_id"),
  metaPlatform: text("meta_platform"),
  attributionChannel: text("attribution_channel"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertCugcRegistrationSchema = createInsertSchema(cugcRegistrations).omit({ id: true, createdAt: true });
export type InsertCugcRegistration = z.infer<typeof insertCugcRegistrationSchema>;
export type CugcRegistration = typeof cugcRegistrations.$inferSelect;

// ---- CUGC Free Sessions (trial bookings) ----
// One row per booked free trial session from cugc.co.nz/free-session. The
// visitor picks a program AND a concrete class date/time, so coaches know
// exactly who is coming to which session. Staff manage the lifecycle in
// Gymnastics → Free Sessions: booked → attended / no_show / cancelled, and
// mark 'enrolled' once the family converts to a paid term place (the funnel
// stage that closes the ad → trial → member loop).
export const cugcFreeSessions = pgTable("cugc_free_sessions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  programSlug: text("program_slug").notNull(),
  programName: text("program_name").notNull(),
  sessionLabel: text("session_label").notNull(), // e.g. "Wednesday 4:00–4:45pm"
  sessionDate: text("session_date").notNull(),   // ISO date of the booked class, e.g. "2026-07-22"
  childName: text("child_name").notNull(),
  childAge: integer("child_age"),
  parentName: text("parent_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  notes: text("notes"),          // anything the parent told us
  staffNotes: text("staff_notes"),
  status: text("status").notNull().default("booked"), // 'booked' | 'attended' | 'no_show' | 'cancelled' | 'enrolled'
  attendedAt: timestamp("attended_at", { withTimezone: true }),
  sourceUrl: text("source_url"),
  attribution: jsonb("attribution"), // same first/last-touch shape as cugc_registrations
  // ── AttributionOS (additive, T3) ──────────────────────────────────────────
  visitorId: text("visitor_id"),
  clickId: text("click_id"),
  personId: integer("person_id"),
  fbp: text("fbp"),
  fbc: text("fbc"),
  metaAdId: text("meta_ad_id"),
  metaAdsetId: text("meta_adset_id"),
  metaCampaignId: text("meta_campaign_id"),
  metaPlatform: text("meta_platform"),
  attributionChannel: text("attribution_channel"),
  hdyhau: text("hdyhau"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertCugcFreeSessionSchema = createInsertSchema(cugcFreeSessions).omit({ id: true, createdAt: true });
export type InsertCugcFreeSession = z.infer<typeof insertCugcFreeSessionSchema>;
export type CugcFreeSession = typeof cugcFreeSessions.$inferSelect;

// ---- Football Institute Applications ----
// Enrolment enquiries for the Football Institute (Christchurch United × Ao
// Tawhiti Unlimited Discovery). One row per application. Submissions come from
// the public marketing site's Apply form (cross-origin POST) or from admins
// adding a walk-up; managed in the CUFC "Football Institute" ClubOS tab.
export const footballInstituteApplications = pgTable("football_institute_applications", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  applicantName: text("applicant_name").notNull(), // student full name
  yearLevel: text("year_level"),                   // "Year 10".."Year 13"
  position: text("position"),
  currentSchool: text("current_school"),
  currentClub: text("current_club"),
  parentName: text("parent_name"),
  email: text("email").notNull(),                  // best contact email
  phone: text("phone"),
  studentEmail: text("student_email"),
  videoUrl: text("video_url"),
  message: text("message"),
  intakeYear: integer("intake_year"),
  status: text("status").notNull().default("new"), // new | contacted | reviewing | accepted | declined
  source: text("source").notNull().default("website"), // website | admin
  // ── AttributionOS (additive, T3) ──────────────────────────────────────────
  visitorId: text("visitor_id"),
  clickId: text("click_id"),
  personId: integer("person_id"),
  fbp: text("fbp"),
  fbc: text("fbc"),
  metaAdId: text("meta_ad_id"),
  metaAdsetId: text("meta_adset_id"),
  metaCampaignId: text("meta_campaign_id"),
  metaPlatform: text("meta_platform"),
  attributionChannel: text("attribution_channel"),
  hdyhau: text("hdyhau"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertFootballInstituteApplicationSchema = createInsertSchema(footballInstituteApplications).omit({ id: true, createdAt: true });
export type InsertFootballInstituteApplication = z.infer<typeof insertFootballInstituteApplicationSchema>;
export type FootballInstituteApplication = typeof footballInstituteApplications.$inferSelect;

// ---- CIC Food Truck Roster ----
// Staff roster for the food truck during the tournament. One row per person
// assigned to a position on a given day. Internal-only (ClubOS Food Truck tab).
// position: "lead" | "grill" | "barista" | "till" | "float"
export const foodTruckShifts = pgTable("food_truck_shifts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  shiftDate: date("shift_date").notNull(), // YYYY-MM-DD
  position: text("position").notNull(),
  staffName: text("staff_name").notNull(),
  timeLabel: text("time_label"), // optional, e.g. "AM", "PM", "9–3"
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertFoodTruckShiftSchema = createInsertSchema(foodTruckShifts).omit({ id: true, createdAt: true });
export type InsertFoodTruckShift = z.infer<typeof insertFoodTruckShiftSchema>;
export type FoodTruckShift = typeof foodTruckShifts.$inferSelect;

// ---- CIC Vendors (incoming food trucks & carts) ----
// Directory of the EXTERNAL food/beverage vendors trading at the Christchurch
// International Cup (Empire Chicken, Bangkok Wok, Frankie's Coffee Cart, …),
// plus our own truck, and a per-day booking roster. This is distinct from
// food_truck_shifts above (which rosters OUR truck's staff by position).
// Internal-only — ClubOS "vendors" tab.
// category:       "meal" | "coffee" | "dessert" | "drinks" | "other"
// contractStatus: "none" | "pending" | "sent" | "signed"  (sets up the e-sign phase)
export const cicVendors = pgTable("cic_vendors", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category").notNull().default("meal"),
  isOurs: boolean("is_ours").notNull().default(false), // our own CIC truck
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  contractStatus: text("contract_status").notNull().default("none"),
  esignDocumentId: integer("esign_document_id"), // linked e-Sign vendor agreement — status syncs from it
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCicVendorSchema = createInsertSchema(cicVendors).omit({ id: true, createdAt: true });
export type InsertCicVendor = z.infer<typeof insertCicVendorSchema>;
export type CicVendor = typeof cicVendors.$inferSelect;

// One row per (vendor, day) the vendor is rostered to trade at the tournament.
export const cicVendorBookings = pgTable("cic_vendor_bookings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  vendorId: integer("vendor_id").notNull().references(() => cicVendors.id, { onDelete: "cascade" }),
  bookingDate: date("booking_date").notNull(), // YYYY-MM-DD
  slot: integer("slot"), // optional ordering (Truck 1 / 2 / 3)
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCicVendorBookingSchema = createInsertSchema(cicVendorBookings).omit({ id: true, createdAt: true });
export type InsertCicVendorBooking = z.infer<typeof insertCicVendorBookingSchema>;
export type CicVendorBooking = typeof cicVendorBookings.$inferSelect;

// ---- Volunteers (reusable across workspaces) ----
// A full volunteer signup + rostering pipeline. Org-scoped, so the SAME module
// serves the Christchurch International Cup, Christchurch United (academy hours),
// South Island United, and any future event workspace — each org sees only its
// own volunteers. Three tables:
//   volunteers          — the people (signups come in via the public form)
//   volunteerTaskTypes  — the allocatable jobs (Car park, Boots, Music, …)
//   volunteerAssignments— one row per (volunteer, day) with the task + hours
// status: 'new' (needs review) | 'reviewing' | 'approved' | 'active' | 'declined' | 'inactive'
export const volunteers = pgTable("volunteers", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  email: text("email").notNull(),
  phone: text("phone"),
  dateOfBirth: date("date_of_birth"), // YYYY-MM-DD — safeguarding + age
  location: text("location"),         // suburb/city, optional
  status: text("status").notNull().default("new"),
  // Academy volunteer-hours use case (players who must do e.g. 20 hrs/year).
  isAcademyPlayer: boolean("is_academy_player").notNull().default(false),
  academyAgeGroup: text("academy_age_group"),   // e.g. "U14"
  hoursTarget: doublePrecision("hours_target"),  // e.g. 20 — null = no target
  availability: text("availability").array().notNull().default(sql`ARRAY[]::text[]`), // days/general availability they noted
  interests: text("interests").array().notNull().default(sql`ARRAY[]::text[]`),       // task areas they're keen on
  emergencyContact: text("emergency_contact"),
  tshirtSize: text("tshirt_size"),
  notes: text("notes"),               // volunteer-supplied
  reviewNotes: text("review_notes"),  // internal staff notes
  sourceUrl: text("source_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  orgIdx: index("volunteers_org_idx").on(t.organizationId, t.createdAt),
}));

export const insertVolunteerSchema = createInsertSchema(volunteers).omit({ id: true, createdAt: true });
export type InsertVolunteer = z.infer<typeof insertVolunteerSchema>;
export type Volunteer = typeof volunteers.$inferSelect;

// The jobs a volunteer can be allocated on a day. Seeded with sensible defaults
// per org on first use (Car park, Boots, Music, Gate & welcome, …) but fully
// editable — add/rename/recolour/retire per workspace.
export const volunteerTaskTypes = pgTable("volunteer_task_types", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull().default("#60a5fa"),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  orgNameUnq: uniqueIndex("volunteer_task_types_org_name_unq").on(t.organizationId, t.name),
}));

export const insertVolunteerTaskTypeSchema = createInsertSchema(volunteerTaskTypes).omit({ id: true, createdAt: true });
export type InsertVolunteerTaskType = z.infer<typeof insertVolunteerTaskTypeSchema>;
export type VolunteerTaskType = typeof volunteerTaskTypes.$inferSelect;

// One row per (volunteer, day). taskTypeId null = rostered, task TBD. hours
// drives the volunteer-hours ledger; completed = the hours actually count.
export const volunteerAssignments = pgTable("volunteer_assignments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  volunteerId: integer("volunteer_id").notNull().references(() => volunteers.id, { onDelete: "cascade" }),
  taskTypeId: integer("task_type_id").references(() => volunteerTaskTypes.id, { onDelete: "set null" }),
  assignmentDate: date("assignment_date").notNull(), // YYYY-MM-DD
  hours: doublePrecision("hours").notNull().default(6),
  completed: boolean("completed").notNull().default(false), // hours actually served
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  orgDateIdx: index("volunteer_assignments_org_date_idx").on(t.organizationId, t.assignmentDate),
  volDateUnq: uniqueIndex("volunteer_assignments_vol_date_unq").on(t.volunteerId, t.assignmentDate),
}));

export const insertVolunteerAssignmentSchema = createInsertSchema(volunteerAssignments).omit({ id: true, createdAt: true });
export type InsertVolunteerAssignment = z.infer<typeof insertVolunteerAssignmentSchema>;
export type VolunteerAssignment = typeof volunteerAssignments.$inferSelect;

// ---- E-Sign (DocuSign replacement) ----
// Org-wide electronic signature module. Send any PDF for signature, track
// status, generate a signed PDF + completion certificate, full audit trail.
// Reusable for staff contracts, sponsors, vendors, and any documentation.
// Legal basis: Contract and Commercial Law Act 2017 (Part 4).
// status: draft | sent | viewed | completed | voided | declined
export const esignDocuments = pgTable("esign_documents", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  message: text("message"),
  status: text("status").notNull().default("draft"),
  sequential: boolean("sequential").notNull().default(false), // invite signers one at a time, in signing_order
  docType: text("doc_type").notNull().default("pdf"), // 'pdf' (uploaded, field overlay) | 'native' (template-rendered branded web page)
  templateId: integer("template_id"),                 // esign_templates.id when doc_type = 'native'
  templateData: jsonb("template_data").$type<Record<string, any> | null>(), // sender-set variable values (rate, start date, …)
  sourceFileName: text("source_file_name"),
  sourcePdf: text("source_pdf").notNull(), // base64 of the original PDF
  signedPdf: text("signed_pdf"),           // base64 of final (original + certificate)
  docHash: text("doc_hash"),               // sha256 hex of source bytes
  createdBy: integer("created_by"),        // users.id of the sender
  sentAt: timestamp("sent_at"),
  completedAt: timestamp("completed_at"),
  voidedAt: timestamp("voided_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEsignDocumentSchema = createInsertSchema(esignDocuments).omit({ id: true, createdAt: true });
export type InsertEsignDocument = z.infer<typeof insertEsignDocumentSchema>;
export type EsignDocument = typeof esignDocuments.$inferSelect;

// One row per signer on a document. token gates the public signing link.
// status: pending | viewed | signed | declined
export const esignSigners = pgTable("esign_signers", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  documentId: integer("document_id").notNull().references(() => esignDocuments.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  signingOrder: integer("signing_order").notNull().default(0),
  status: text("status").notNull().default("pending"),
  token: text("token").notNull().unique(),
  signatureName: text("signature_name"),   // typed name
  signatureImage: text("signature_image"), // base64 png (drawn)
  consentedAt: timestamp("consented_at"),
  viewedAt: timestamp("viewed_at"),
  signedAt: timestamp("signed_at"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  declineReason: text("decline_reason"),
  formData: jsonb("form_data").$type<Record<string, any> | null>(), // native docs: signer-filled details (incl. guardian block for under-18s)
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEsignSignerSchema = createInsertSchema(esignSigners).omit({ id: true, createdAt: true });
export type InsertEsignSigner = z.infer<typeof insertEsignSignerSchema>;
export type EsignSigner = typeof esignSigners.$inferSelect;

// Immutable audit trail for each document.
export const esignEvents = pgTable("esign_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  documentId: integer("document_id").notNull().references(() => esignDocuments.id, { onDelete: "cascade" }),
  signerId: integer("signer_id"),
  type: text("type").notNull(), // created|sent|viewed|signed|completed|downloaded|voided|declined|reminded
  actorEmail: text("actor_email"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  meta: jsonb("meta").$type<Record<string, any> | null>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEsignEventSchema = createInsertSchema(esignEvents).omit({ id: true, createdAt: true });
export type InsertEsignEvent = z.infer<typeof insertEsignEventSchema>;
export type EsignEvent = typeof esignEvents.$inferSelect;

// Fillable fields placed on a document (DocuSign-style). Coordinates are
// normalized 0..1 relative to the page (x,y = top-left corner, screen
// convention — flipped to PDF space when stamping). One field is filled by
// one signer.
// type: signature | initials | text | date | checkbox
export const esignFields = pgTable("esign_fields", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  documentId: integer("document_id").notNull().references(() => esignDocuments.id, { onDelete: "cascade" }),
  signerId: integer("signer_id").notNull().references(() => esignSigners.id, { onDelete: "cascade" }),
  page: integer("page").notNull().default(0), // 0-based page index
  x: doublePrecision("x").notNull(),
  y: doublePrecision("y").notNull(),
  w: doublePrecision("w").notNull(),
  h: doublePrecision("h").notNull(),
  type: text("type").notNull(),
  required: boolean("required").notNull().default(true),
  label: text("label"),
  value: text("value"),             // filled text / date / "true" for checkbox
  valueImage: text("value_image"),  // base64 png for signature / initials
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEsignFieldSchema = createInsertSchema(esignFields).omit({ id: true, createdAt: true });
export type InsertEsignField = z.infer<typeof insertEsignFieldSchema>;
export type EsignField = typeof esignFields.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════
// AttributionOS — persons / identities / merges (T2, migration file 1)
// The attribution "person" is always the PARENT/payer — never a child (Hard Rule 4).
// A person is the identity spine that visitor ids, emails and phones resolve to.
// Merge rules (PostHog verbatim): anonymous→identified merges freely; two already-
// identified persons are NEVER auto-merged (logged to person_merges instead).
// ═══════════════════════════════════════════════════════════════════════════
export const persons = pgTable("persons", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  primaryEmail: text("primary_email"),   // normalised lowercase; nullable until identified
  primaryPhone: text("primary_phone"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPersonSchema = createInsertSchema(persons).omit({ id: true, createdAt: true });
export type InsertPerson = z.infer<typeof insertPersonSchema>;
export type Person = typeof persons.$inferSelect;

// Every known handle for a person: an email, a phone, or a visitor id (cookie).
// unique(kind, value) — the same handle can only ever point at one person.
export const personIdentities = pgTable("person_identities", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  personId: integer("person_id").notNull().references(() => persons.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),  // 'email' | 'phone' | 'visitor'
  value: text("value").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  kindValueUnq: uniqueIndex("person_identities_kind_value_unq").on(t.kind, t.value),
  personIdx: uniqueIndex("person_identities_person_kind_value_unq").on(t.personId, t.kind, t.value),
}));

export const insertPersonIdentitySchema = createInsertSchema(personIdentities).omit({ id: true, createdAt: true });
export type InsertPersonIdentity = z.infer<typeof insertPersonIdentitySchema>;
export type PersonIdentity = typeof personIdentities.$inferSelect;

// Audit trail for every merge decision — including the ones we REFUSE to make
// (reason 'blocked_auto_merge' when two already-identified persons collide).
export const personMerges = pgTable("person_merges", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  winnerId: integer("winner_id").notNull(),  // person kept (not FK — losers may be deleted)
  loserId: integer("loser_id").notNull(),    // person merged away (or would-be)
  reason: text("reason").notNull(),          // e.g. 'anon_to_identified' | 'blocked_auto_merge'
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPersonMergeSchema = createInsertSchema(personMerges).omit({ id: true, createdAt: true });
export type InsertPersonMerge = z.infer<typeof insertPersonMergeSchema>;
export type PersonMerge = typeof personMerges.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════
// AttributionOS — short links / QR, Meta ad spend + entities (T3, migration 2)
// ═══════════════════════════════════════════════════════════════════════════

// One trackable short link / QR poster (Dub-style). `key` is the public slug
// served at /l/:key; `destination` is validated to an allowlisted (our-own) host
// at create time — no open redirect. Counters are cached and repairable from
// link_clicks + the conversion tables (T21 repair function).
export const shortLinks = pgTable("short_links", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  key: text("key").notNull(),                 // public slug (unique) → /l/:key
  destination: text("destination").notNull(), // allowlisted target URL (our domains only)
  channel: text("channel"),                   // canonical channel locked at create time
  campaign: text("campaign"),
  medium: text("medium"),
  content: text("content"),
  brand: text("brand"),                       // which brand this link is for
  note: text("note"),                         // free-text staff note
  qrDefault: boolean("qr_default").notNull().default(false),  // built primarily for a QR poster
  clicks: integer("clicks").notNull().default(0),             // cached counter (repairable)
  leads: integer("leads").notNull().default(0),
  sales: integer("sales").notNull().default(0),
  saleAmountCents: integer("sale_amount_cents").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  keyUnq: uniqueIndex("short_links_key_unq").on(t.key),
  orgIdx: index("short_links_org_idx").on(t.organizationId, t.active, t.createdAt),
}));

export const insertShortLinkSchema = createInsertSchema(shortLinks).omit({ id: true, createdAt: true });
export type InsertShortLink = z.infer<typeof insertShortLinkSchema>;
export type ShortLink = typeof shortLinks.$inferSelect;

// One row per counted click on a short link. `clickId` is the minted first-party
// id echoed to the destination as ?ci= (unique). `ipHash` is SHA256(ip+ua) only —
// no raw IP is ever stored; it is the 1h per-link dedupe key (T9).
export const linkClicks = pgTable("link_clicks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  linkId: integer("link_id").notNull().references(() => shortLinks.id, { onDelete: "cascade" }),
  clickId: text("click_id").notNull(),        // minted first-party click id (unique; ?ci=)
  visitorId: text("visitor_id"),
  ipHash: text("ip_hash"),                    // SHA256(ip+ua) — no raw IP; 1h dedupe key
  ua: text("ua"),
  referrer: text("referrer"),
  isQr: boolean("is_qr").notNull().default(false),   // scanned from a QR poster (?qr=1)
  isBot: boolean("is_bot").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  clickIdUnq: uniqueIndex("link_clicks_click_id_unq").on(t.clickId),
  linkIdx: index("link_clicks_link_idx").on(t.linkId, t.createdAt),
}));

export const insertLinkClickSchema = createInsertSchema(linkClicks).omit({ id: true, createdAt: true });
export type InsertLinkClick = z.infer<typeof insertLinkClickSchema>;
export type LinkClick = typeof linkClicks.$inferSelect;

// Daily Meta Insights at level=ad, broken down by publisher_platform +
// platform_position (so FB vs IG spend is separable). Re-upserted for the last 7
// days each run; the unique key is (date, adId, publisherPlatform,
// platformPosition). Breakdown columns default to '' so the unique key never has
// a NULL (NULLs are distinct in a unique index and would defeat the upsert).
// spendCents is integer cents (Meta returns spend as decimal dollars — convert).
export const adSpendDaily = pgTable("ad_spend_daily", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  date: date("date").notNull(),
  adId: text("ad_id").notNull(),
  adsetId: text("adset_id"),
  campaignId: text("campaign_id"),
  publisherPlatform: text("publisher_platform").notNull().default(""),  // 'facebook' | 'instagram' | ...
  platformPosition: text("platform_position").notNull().default(""),    // 'feed' | 'story' | 'reels' | ...
  spendCents: integer("spend_cents").notNull().default(0),
  impressions: integer("impressions").notNull().default(0),
  clicks: integer("clicks").notNull().default(0),
  refreshedAt: timestamp("refreshed_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  unq: uniqueIndex("ad_spend_daily_unq").on(t.date, t.adId, t.publisherPlatform, t.platformPosition),
}));

export const insertAdSpendDailySchema = createInsertSchema(adSpendDaily).omit({ id: true, createdAt: true });
export type InsertAdSpendDaily = z.infer<typeof insertAdSpendDailySchema>;
export type AdSpendDaily = typeof adSpendDaily.$inferSelect;

// Name lookup for ad / adset / campaign ids seen in spend or conversions.
// Refreshed from /{ad-id}?fields=name,adset{name,campaign{name}}.
export const adEntities = pgTable("ad_entities", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  adId: text("ad_id").notNull(),
  adsetId: text("adset_id"),
  campaignId: text("campaign_id"),
  adName: text("ad_name"),
  adsetName: text("adset_name"),
  campaignName: text("campaign_name"),
  accountId: text("account_id"),
  refreshedAt: timestamp("refreshed_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  adIdUnq: uniqueIndex("ad_entities_ad_id_unq").on(t.adId),
}));

export const insertAdEntitySchema = createInsertSchema(adEntities).omit({ id: true, createdAt: true });
export type InsertAdEntity = z.infer<typeof insertAdEntitySchema>;
export type AdEntity = typeof adEntities.$inferSelect;

// AttributionOS (T14) — per-recipient email click tokens. A broadcast stamps each
// recipient's links with `ci=emc…`, a signed HMAC-derived token stored here mapping
// token → recipient email + campaign. On click, the cookie middleware resolves the
// token back to the email and binds the visitor to that person (identity stitch).
// The attribution person is the PARENT/payer — email addresses only, no child PII.
export const emailClickTokens = pgTable("email_click_tokens", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  token: varchar("token", { length: 64 }).notNull(),
  organizationId: integer("organization_id"),
  campaignId: integer("campaign_id"),
  email: text("email").notNull(),          // normalised lowercase recipient email
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  tokenKey: uniqueIndex("email_click_tokens_token_key").on(t.token),
}));

export const insertEmailClickTokenSchema = createInsertSchema(emailClickTokens).omit({ id: true, createdAt: true });
export type InsertEmailClickToken = z.infer<typeof insertEmailClickTokenSchema>;
export type EmailClickToken = typeof emailClickTokens.$inferSelect;

// Native document templates — agreements rendered as branded web pages instead
// of uploaded PDFs (e-Sign v2). The template holds the full agreement content
// (structured sections), the brand identity to render it in, sender-set
// variables (e.g. pay rate), and the form fields the signer fills inline.
// Adding a new agreement type = inserting a row here; no code changes.
export const esignTemplates = pgTable("esign_templates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),          // e.g. 'mfl-referee-agreement'
  name: text("name").notNull(),          // e.g. 'MFL Referee Contractor Agreement'
  description: text("description"),
  brand: jsonb("brand").$type<Record<string, any>>().notNull(),     // { orgLabel, logoUrl, bg, panel, accent, accentDeep, paper, ink }
  content: jsonb("content").$type<Record<string, any>>().notNull(), // { title, intro, sections:[{heading, items:[{kind:'p'|'bullet'|'numbered', text}]}], appendix:{...}, adviceNotice, signAck }
  variables: jsonb("variables").$type<any[]>().notNull(),           // sender-set: [{key,label,type:'select'|'text'|'date'|'money',options?,default?,required}]
  form: jsonb("form").$type<any[]>().notNull(),                     // signer-filled: [{key,label,type:'text'|'date'|'dob'|'phone'|'email'|'bank'|'address',required,help?,section?}]
  settings: jsonb("settings").$type<Record<string, any> | null>(),  // { guardianUnder18: true, counterSignerRole: 'The League', … }
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEsignTemplateSchema = createInsertSchema(esignTemplates).omit({ id: true, createdAt: true });
export type InsertEsignTemplate = z.infer<typeof insertEsignTemplateSchema>;
export type EsignTemplate = typeof esignTemplates.$inferSelect;


// ---- OFC Payables Declarations (Document F.05) ----
// A roster-declaration built on the e-Sign primitives: every listed player +
// club staff member individually confirms (on a branded signing page) that the
// club has paid all their contractual obligations; the club's authorised
// signatory then certifies. Finalising collates one master PDF in the OFC F.05
// template layout (Players table + Club Staff table + certification block),
// plus per-person proof and a Certificate of Completion. Separate tables from
// esign_* so this cannot affect live referee/vendor signing.
export const payablesDeclarations = pgTable("payables_declarations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  criterion: text("criterion").notNull().default("F.05"),
  season: text("season"),                                  // e.g. '2026/27'
  clubName: text("club_name").notNull(),                   // legal applicant name
  asOfDate: text("as_of_date"),                            // YYYY-MM-DD paid-up-to date
  statement: text("statement").notNull(),                  // confirmation wording ({{club}} {{season}} {{as_of}} merged)
  signatoryName: text("signatory_name"),                   // authorised signatory of the club
  signatoryTitle: text("signatory_title"),                 // their job title
  signatorySignatureName: text("signatory_signature_name"), // typed name at certification
  signatorySignatureImage: text("signatory_signature_image"), // base64 png drawn signature
  signatorySignedAt: timestamp("signatory_signed_at"),
  signatoryIp: text("signatory_ip"),
  status: text("status").notNull().default("draft"),       // draft | collecting | completed | voided
  signedPdf: text("signed_pdf"),                           // base64 finalised master PDF
  docHash: text("doc_hash"),                               // sha256 of source render
  createdBy: integer("created_by"),                        // users.id
  sentAt: timestamp("sent_at"),
  completedAt: timestamp("completed_at"),
  voidedAt: timestamp("voided_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPayablesDeclarationSchema = createInsertSchema(payablesDeclarations).omit({ id: true, createdAt: true });
export type InsertPayablesDeclaration = z.infer<typeof insertPayablesDeclarationSchema>;
export type PayablesDeclaration = typeof payablesDeclarations.$inferSelect;

// One row per listed player/staff member. token gates the public signing link.
export const payablesDeclarationSignatories = pgTable("payables_declaration_signatories", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  declarationId: integer("declaration_id").notNull().references(() => payablesDeclarations.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  groupKind: text("group_kind").notNull().default("player"), // 'player' | 'staff'
  name: text("name").notNull(),
  email: text("email"),                                    // nullable → in-person signing via copy-link
  roleTitle: text("role_title"),                           // optional (squad no. / staff role)
  sortOrder: integer("sort_order").notNull().default(0),
  token: text("token").notNull().unique(),
  status: text("status").notNull().default("pending"),     // pending | viewed | signed | declined
  signatureName: text("signature_name"),
  signatureImage: text("signature_image"),
  consentedAt: timestamp("consented_at"),
  viewedAt: timestamp("viewed_at"),
  signedAt: timestamp("signed_at"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  declineReason: text("decline_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPayablesDeclarationSignatorySchema = createInsertSchema(payablesDeclarationSignatories).omit({ id: true, createdAt: true });
export type InsertPayablesDeclarationSignatory = z.infer<typeof insertPayablesDeclarationSignatorySchema>;
export type PayablesDeclarationSignatory = typeof payablesDeclarationSignatories.$inferSelect;

// Immutable audit trail per declaration.
export const payablesDeclarationEvents = pgTable("payables_declaration_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  declarationId: integer("declaration_id").notNull().references(() => payablesDeclarations.id, { onDelete: "cascade" }),
  signatoryId: integer("signatory_id"),
  type: text("type").notNull(),
  actorEmail: text("actor_email"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  meta: jsonb("meta").$type<Record<string, any> | null>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPayablesDeclarationEventSchema = createInsertSchema(payablesDeclarationEvents).omit({ id: true, createdAt: true });
export type InsertPayablesDeclarationEvent = z.infer<typeof insertPayablesDeclarationEventSchema>;
export type PayablesDeclarationEvent = typeof payablesDeclarationEvents.$inferSelect;


// ---- USG Studio (brand-aware AI proposal pages) ----
// Data foundation for "USG Studio": generate on-brand proposal pages, publish them
// on an unguessable share link, and measure how prospects actually read them.
// Content-block schema (the { meta, blocks[] } page doc) lives in shared/studio-blocks.ts.
// This increment is data only — no routes / services / UI yet.

// The "Brand Pack" as data — one row per brand org. Replaces the hardcoded voice
// strings in server/ai.ts: voice, messaging, lexicon, banned terms, CTA rules, the
// theme token set to render in, and how the brand maps to live ClubOS data.
export const orgBrandContext = pgTable("org_brand_context", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().unique().references(() => organizations.id, { onDelete: "cascade" }), // one per brand
  brandId: text("brand_id").notNull(),                                                   // slug, e.g. 'mfl'
  voiceJson: jsonb("voice_json").$type<Record<string, any> | null>(),                    // tone / adjectives / dials / sentence rules
  messagingJson: jsonb("messaging_json").$type<Record<string, any> | null>(),            // positioning, key messages, taglines, do-not-claim
  lexiconJson: jsonb("lexicon_json").$type<Record<string, any> | null>(),                // approved / careful / banned terms → replacement
  bannedTerms: jsonb("banned_terms").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  ctaConventionsJson: jsonb("cta_conventions_json").$type<Record<string, any> | null>(), // how this brand phrases / routes CTAs
  themeRef: text("theme_ref"),                                                           // points at the brand theme / token set
  dataBindingsJson: jsonb("data_bindings_json").$type<Record<string, any> | null>(),     // reg URL patterns, current-term source, etc.
  version: text("version").notNull().default("v1.0.0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertOrgBrandContextSchema = createInsertSchema(orgBrandContext).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertOrgBrandContext = z.infer<typeof insertOrgBrandContextSchema>;
export type OrgBrandContext = typeof orgBrandContext.$inferSelect;

// A generated artifact — the proposal page. token gates the public share link
// (unguessable, same mechanic as esignSigners.token: crypto.randomBytes → base64url,
// generated in the route). contentJson = the validated { meta, blocks[] } page doc
// (shared/studio-blocks.ts). status: draft | published | archived.
export const studioDocuments = pgTable("studio_documents", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),   // unguessable public share link
  slug: text("slug"),
  brandId: text("brand_id").notNull(),
  format: text("format").notNull().default("proposal"),
  title: text("title").notNull(),
  status: text("status").notNull().default("draft"),
  contentJson: jsonb("content_json").$type<Record<string, any>>().notNull(), // PageDoc — see shared/studio-blocks.ts
  schemaVersion: integer("schema_version").notNull().default(1),
  contentHash: text("content_hash"),
  sourceTag: text("source_tag"),             // the ?source= attribution slug
  createdBy: integer("created_by").notNull(), // users.id of the staff creator
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  publishedAt: timestamp("published_at"),
});

export const insertStudioDocumentSchema = createInsertSchema(studioDocuments).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertStudioDocument = z.infer<typeof insertStudioDocumentSchema>;
export type StudioDocument = typeof studioDocuments.$inferSelect;

// Immutable snapshot per publish / edit — rollback + don't-clobber concurrent
// edits. One row per (document, versionInt).
export const studioDocumentVersions = pgTable("studio_document_versions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  documentId: integer("document_id").notNull().references(() => studioDocuments.id, { onDelete: "cascade" }),
  versionInt: integer("version_int").notNull(),
  contentJson: jsonb("content_json").$type<Record<string, any>>().notNull(),
  editOps: jsonb("edit_ops").$type<Record<string, any> | null>(), // what changed vs the prior version
  label: text("label"),
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  docVersionUnq: unique("studio_document_versions_doc_version_unique").on(t.documentId, t.versionInt),
}));

export const insertStudioDocumentVersionSchema = createInsertSchema(studioDocumentVersions).omit({ id: true, createdAt: true });
export type InsertStudioDocumentVersion = z.infer<typeof insertStudioDocumentVersionSchema>;
export type StudioDocumentVersion = typeof studioDocumentVersions.$inferSelect;

// One row per viewing session of a proposal — the "Signal" layer. engagedMs is
// ACTIVE / engaged time only (not tab-open). Privacy: coarse geo only — no raw IP
// is ever stored (country is derived or a salted hash at ingest). isInternal flags
// staff / owner preview views, excluded from prospect analytics.
export const studioAnalyticsSessions = pgTable("studio_analytics_sessions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  documentId: integer("document_id").notNull().references(() => studioDocuments.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),   // client sessionStorage uuid
  visitorId: text("visitor_id"),             // persistent localStorage id (counts return visits)
  firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  engagedMs: integer("engaged_ms").notNull().default(0),
  maxScrollPct: integer("max_scroll_pct").notNull().default(0),
  device: text("device"),                    // mobile | tablet | desktop
  userAgent: text("user_agent"),
  referrer: text("referrer"),
  sourceTag: text("source_tag"),
  utmJson: jsonb("utm_json").$type<Record<string, any> | null>(),
  country: text("country"),                  // coarse geo only — no raw IP stored
  isInternal: boolean("is_internal").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertStudioAnalyticsSessionSchema = createInsertSchema(studioAnalyticsSessions).omit({ id: true, createdAt: true });
export type InsertStudioAnalyticsSession = z.infer<typeof insertStudioAnalyticsSessionSchema>;
export type StudioAnalyticsSession = typeof studioAnalyticsSessions.$inferSelect;

// Granular events within a session (section dwell / scroll velocity / CTA clicks /
// heartbeats). blockId points at a content block id (shared/studio-blocks.ts) for
// per-section hotspots. clientTs is the client event time in epoch ms.
export const studioAnalyticsEvents = pgTable("studio_analytics_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  documentId: integer("document_id").notNull().references(() => studioDocuments.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  type: text("type").notNull(),              // pageview|section_enter|section_exit|scroll|click|cta_click|heartbeat|reached_end|visible|hidden
  blockId: text("block_id"),                 // which content block (section hotspots / dwell)
  scrollPct: integer("scroll_pct"),
  scrollVelocity: integer("scroll_velocity"), // px/s — skim vs read
  dwellMs: integer("dwell_ms"),              // time in a section on section_exit
  metaJson: jsonb("meta_json").$type<Record<string, any> | null>(), // click target / href, etc.
  clientTs: bigint("client_ts", { mode: "number" }), // client event time (epoch ms)
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertStudioAnalyticsEventSchema = createInsertSchema(studioAnalyticsEvents).omit({ id: true, createdAt: true });
export type InsertStudioAnalyticsEvent = z.infer<typeof insertStudioAnalyticsEventSchema>;
export type StudioAnalyticsEvent = typeof studioAnalyticsEvents.$inferSelect;

// ── Proposal Tracker (USG / group workspace) ────────────────────────────────
// A CRM + link-analytics layer over EVERY proposal Daniel & Ryan send —
// sponsorship, investor, development (USC / padel), partnership and client work.
// Unifies partner pages (apps/partners), USG Studio pages, PDFs and external
// decks under one sortable tracker (by type + category). Each proposal gets a
// tracked short link — app.usg.co.nz/r/{shortCode} — that logs every open into
// proposal_events and 302-redirects to the real link, so "what are the stats on
// that link" is answerable for ANY link type with zero cross-origin work. The
// `sourceTag` slug is the join key to Meet bookings (bookings.source) and Studio
// Signal, so booking + engagement fusion is a clean later step.
export const proposals = pgTable("proposals", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  company: text("company"),
  // sponsorship | investor | development | partnership | client | grant | other
  proposalType: text("proposal_type").notNull().default("sponsorship"),
  // Free/managed label: Breweries, Gyms, La Liga, Padel / USC, Core Pilates…
  category: text("category"),
  brandTags: text("brand_tags").array().notNull().default(sql`ARRAY[]::text[]`),
  // draft | sent | opened | in_discussion | negotiating | won | lost | on_hold
  status: text("status").notNull().default("draft"),
  valueCents: integer("value_cents"),            // deal value in cents
  currency: text("currency").notNull().default("NZD"),
  owner: text("owner"),                          // Daniel | Ryan | free text
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  linkUrl: text("link_url"),                     // the real proposal page / PDF / deck
  shortCode: text("short_code").unique(),        // tracked-link code → /r/{shortCode}
  sourceTag: text("source_tag"),                 // slug join-key → Meet bookings + Signal
  // Soft link to a USG Studio proposal page — no FK: studio_documents isn't live
  // in prod yet. Holds a studio_documents.id once Studio ships.
  studioDocumentId: integer("studio_document_id"),
  notes: text("notes"),
  sentAt: timestamp("sent_at"),
  decisionAt: timestamp("decision_at"),
  lastOpenedAt: timestamp("last_opened_at"),     // denormalised for fast sort/list
  openCount: integer("open_count").notNull().default(0), // denormalised (total opens)
  createdBy: integer("created_by").references(() => users.id),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertProposalSchema = createInsertSchema(proposals).omit({ id: true, createdAt: true, updatedAt: true, openCount: true, lastOpenedAt: true });
export type InsertProposal = z.infer<typeof insertProposalSchema>;
export type Proposal = typeof proposals.$inferSelect;

// Managed category list per workspace so Daniel curates the buckets (with a
// colour) instead of typing free text every time — the filter chips render from
// these. `proposalType` optionally groups a category under a type.
export const proposalCategories = pgTable("proposal_categories", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  proposalType: text("proposal_type"),
  color: text("color").notNull().default("#3b82f6"),
  sortOrder: integer("sort_order").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  orgNameUnq: unique("proposal_categories_org_name_unique").on(t.organizationId, t.name),
}));

export const insertProposalCategorySchema = createInsertSchema(proposalCategories).omit({ id: true, createdAt: true });
export type InsertProposalCategory = z.infer<typeof insertProposalCategorySchema>;
export type ProposalCategory = typeof proposalCategories.$inferSelect;

// One row per tracked-link touch. `kind`: open | cta_click | booking. Privacy:
// coarse geo (country from the CDN header) only — no raw IP stored. `visitorId`
// is a first-party cookie id (drives unique-visitor counts). `isInternal` flags
// staff/self opens so they can be excluded from the real prospect numbers.
export const proposalEvents = pgTable("proposal_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  proposalId: integer("proposal_id").notNull().references(() => proposals.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("open"),
  visitorId: text("visitor_id"),
  device: text("device"),                        // mobile | tablet | desktop
  userAgent: text("user_agent"),
  referrer: text("referrer"),
  country: text("country"),                      // coarse geo only — no raw IP
  isInternal: boolean("is_internal").notNull().default(false),
  metaJson: jsonb("meta_json").$type<Record<string, any> | null>(),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
});

export const insertProposalEventSchema = createInsertSchema(proposalEvents).omit({ id: true, occurredAt: true });
export type InsertProposalEvent = z.infer<typeof insertProposalEventSchema>;
export type ProposalEvent = typeof proposalEvents.$inferSelect;

// ── Content Calendar / Media Production (group / USG workspace) ───────────────
// The media & marketing team's Monday.com-style home. Each content_item runs a
// production pipeline (idea → scripting → to_shoot → editing → review →
// scheduled → published) and carries a PLANNED date + a PUBLISHED date (the
// planned-vs-delivered scoreboard), brand tags, format/channels, and the three
// named production roles Daniel asked for (photographer / videographer / editor)
// plus an accountable owner. content_sessions are the production activities on
// the calendar (meetings, planning, scripting, storyboarding, brainstorming,
// shoots, edit blocks). content_tasks are the granular "divvy up the work"
// checklist under an item, each with a production role + assignee.
export const contentItems = pgTable("content_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  brief: text("brief"),                          // what it's about / the concept
  // reel | short | long_video | photo | carousel | story | graphic | blog | email | podcast | other
  format: text("format").notNull().default("reel"),
  // instagram | tiktok | youtube | facebook | linkedin | x | website | email | other
  channels: text("channels").array().notNull().default(sql`ARRAY[]::text[]`),
  brandTags: text("brand_tags").array().notNull().default(sql`ARRAY[]::text[]`),
  // idea | scripting | to_shoot | editing | review | scheduled | published | cancelled
  status: text("status").notNull().default("idea"),
  priority: text("priority").notNull().default("medium"),   // low | medium | high | urgent
  plannedDate: date("planned_date"),             // when it's PLANNED to go out (calendar anchor)
  publishedDate: date("published_date"),         // when it ACTUALLY went out (delivered)
  ownerId: integer("owner_id").references(() => users.id, { onDelete: "set null" }),
  photographerId: integer("photographer_id").references(() => users.id, { onDelete: "set null" }),
  videographerId: integer("videographer_id").references(() => users.id, { onDelete: "set null" }),
  editorId: integer("editor_id").references(() => users.id, { onDelete: "set null" }),
  campaign: text("campaign"),                    // content pillar / campaign label (free text)
  assetUrl: text("asset_url"),                   // link to raw/edited assets (Drive/Frame.io)
  finalUrl: text("final_url"),                   // link to the published post
  sessionId: integer("session_id").references((): any => contentSessions.id, { onDelete: "set null" }),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertContentItemSchema = createInsertSchema(contentItems).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertContentItem = z.infer<typeof insertContentItemSchema>;
export type ContentItem = typeof contentItems.$inferSelect;

export const contentSessions = pgTable("content_sessions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  // meeting | planning | scripting | storyboard | brainstorm | shoot | edit | review | other
  sessionType: text("session_type").notNull().default("meeting"),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true }),
  allDay: boolean("all_day").notNull().default(false),
  location: text("location"),
  brandTags: text("brand_tags").array().notNull().default(sql`ARRAY[]::text[]`),
  attendeeIds: integer("attendee_ids").array().notNull().default(sql`ARRAY[]::integer[]`),
  leadId: integer("lead_id").references(() => users.id, { onDelete: "set null" }),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertContentSessionSchema = createInsertSchema(contentSessions).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertContentSession = z.infer<typeof insertContentSessionSchema>;
export type ContentSession = typeof contentSessions.$inferSelect;

export const contentTasks = pgTable("content_tasks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  contentItemId: integer("content_item_id").notNull().references(() => contentItems.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  // photography | videography | editing | scripting | design | publishing | other
  role: text("role").notNull().default("other"),
  assigneeId: integer("assignee_id").references(() => users.id, { onDelete: "set null" }),
  dueDate: date("due_date"),
  done: boolean("done").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertContentTaskSchema = createInsertSchema(contentTasks).omit({ id: true, createdAt: true });
export type InsertContentTask = z.infer<typeof insertContentTaskSchema>;
export type ContentTask = typeof contentTasks.$inferSelect;

// ── Feature Requests / Bug Reports (staff feedback board) ────────────────────
// One shared, club-wide backlog where any staff member reports a bug or asks
// for a feature/improvement, instead of scattered WhatsApp messages. Daniel +
// workspace managers triage it (status / priority / notes). NOT org-scoped —
// deliberately a single clean list. See migrations/2026-07-09_feature_requests.sql.
export const featureRequests = pgTable("feature_requests", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  type: text("type").notNull().default("bug"),          // bug | feature | improvement
  title: text("title").notNull(),
  description: text("description"),
  area: text("area"),                                   // which app/brand/system (free tag)
  pageUrl: text("page_url"),                            // link to where they saw it
  status: text("status").notNull().default("new"),      // new | planned | in_progress | done | declined
  priority: text("priority").notNull().default("normal"), // low | normal | high | urgent
  adminNotes: text("admin_notes"),                      // triage notes (managers only)
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  resolvedBy: integer("resolved_by").references(() => users.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertFeatureRequestSchema = createInsertSchema(featureRequests).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFeatureRequest = z.infer<typeof insertFeatureRequestSchema>;
export type FeatureRequest = typeof featureRequests.$inferSelect;

// ── Play Predictor (CUFC first-team match predictions) ───────────────────────
// Fans predict the Christchurch United first team's match from the CUFC
// website across the nine Chelsea Play Predictor categories, earn points
// (shared/predictor-scoring.ts) and climb per-game, monthly and season
// leaderboards for prizes. Every entrant is captured as a CUFC (org 1)
// marketing contact — the CUFC Mailer audience reads this table.

// One row per first-team game. Kickoff (minus five minutes) gates predictions;
// entering the final result flips status to 'final' and recomputes points for
// every prediction on the fixture.
export const predictorFixtures = pgTable("predictor_fixtures", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().default(1),
  externalId: text("external_id"),                 // optional id from an external fixtures feed
  mfMatchId: text("mf_match_id"),                  // Mainland Football match-centre id (result auto-sync)
  opponent: text("opponent").notNull(),
  homeAway: text("home_away").notNull().default("H"), // 'H' | 'A'
  kickoffAt: timestamp("kickoff_at", { withTimezone: true }).notNull(),
  venue: text("venue"),
  status: text("status").notNull().default("scheduled"), // 'scheduled' | 'final'
  // Which of the nine scoring categories are live. NULL → the default five.
  categories: jsonb("categories").$type<string[] | null>(),
  // The actual result, one field per category.
  cufcScore: integer("cufc_score"),
  opponentScore: integer("opponent_score"),
  goalscorers: jsonb("goalscorers").$type<string[] | null>(), // United scorers, in the order they scored
  firstGoalMinute: integer("first_goal_minute"),
  shots: integer("shots"),
  shotsOnTarget: integer("shots_on_target"),
  possession: integer("possession"),
  corners: integer("corners"),
  prize: text("prize"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => ({
  orgExternalUnq: uniqueIndex("predictor_fixtures_org_external_unq")
    .on(t.organizationId, t.externalId)
    .where(sql`${t.externalId} IS NOT NULL`),
}));

// Fan contact capture — unique per (org, lower(email)); re-predicting updates
// name/phone in place so the newest details win.
export const predictorEntrants = pgTable("predictor_entrants", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().default(1),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  marketingConsent: boolean("marketing_consent").notNull().default(true),
  source: text("source"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => ({
  orgEmailUnq: uniqueIndex("predictor_entrants_org_email_unq")
    .on(t.organizationId, sql`lower(${t.email})`),
}));

// One prediction per entrant per fixture, locked five minutes before kickoff.
// points_awarded + points_breakdown are written when the fixture result is
// entered (and rewritten if the result is corrected).
export const predictorPredictions = pgTable("predictor_predictions", {
  id: serial("id").primaryKey(),
  fixtureId: integer("fixture_id").notNull().references(() => predictorFixtures.id),
  entrantId: integer("entrant_id").notNull().references(() => predictorEntrants.id),
  cufcScore: integer("cufc_score").notNull(),
  opponentScore: integer("opponent_score").notNull(),
  firstScorer: text("first_scorer"),               // a squad name, or the __NO_SCORER__ sentinel
  firstGoalMinute: integer("first_goal_minute"),
  shots: integer("shots"),
  shotsOnTarget: integer("shots_on_target"),
  possession: integer("possession"),
  corners: integer("corners"),
  pointsAwarded: integer("points_awarded"),
  pointsBreakdown: jsonb("points_breakdown"),      // per-category result, for the fan-facing breakdown
  /** @deprecated the pre-Chelsea three-scorer list. Kept for column history; never written. */
  goalscorers: text("goalscorers").array(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => ({
  fixtureEntrantUnq: unique("predictor_predictions_fixture_entrant_unq").on(t.fixtureId, t.entrantId),
}));

// First-team player list behind the first-goalscorer picker on the public form.
export const predictorSquad = pgTable("predictor_squad", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().default(1),
  name: text("name").notNull(),
  position: text("position"),
  shirtNumber: integer("shirt_number"),
  active: boolean("active").notNull().default(true),
  sort: integer("sort").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const insertPredictorFixtureSchema = createInsertSchema(predictorFixtures).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPredictorFixture = z.infer<typeof insertPredictorFixtureSchema>;
export type PredictorFixture = typeof predictorFixtures.$inferSelect;

export const insertPredictorEntrantSchema = createInsertSchema(predictorEntrants).omit({ id: true, createdAt: true });
export type InsertPredictorEntrant = z.infer<typeof insertPredictorEntrantSchema>;
export type PredictorEntrant = typeof predictorEntrants.$inferSelect;

export const insertPredictorPredictionSchema = createInsertSchema(predictorPredictions).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPredictorPrediction = z.infer<typeof insertPredictorPredictionSchema>;
export type PredictorPrediction = typeof predictorPredictions.$inferSelect;

export const insertPredictorSquadSchema = createInsertSchema(predictorSquad).omit({ id: true, createdAt: true });
export type InsertPredictorSquad = z.infer<typeof insertPredictorSquadSchema>;
export type PredictorSquadPlayer = typeof predictorSquad.$inferSelect;
