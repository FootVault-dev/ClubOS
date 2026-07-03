import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp, date, decimal, doublePrecision, pgEnum, uniqueIndex, unique, index, time, jsonb } from "drizzle-orm/pg-core";
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
  ageMin: integer("age_min"),
  ageMax: integer("age_max"),
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
  homeScore: integer("home_score"),
  awayScore: integer("away_score"),
  homePenalties: integer("home_penalties"),
  awayPenalties: integer("away_penalties"),
  notes: text("notes"),
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
});

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

export const insertGrantFunderSchema = createInsertSchema(grantFunders).omit({ id: true, createdAt: true, updatedAt: true });
export type GrantFunder = typeof grantFunders.$inferSelect;
export const insertGrantApplicationSchema = createInsertSchema(grantApplications).omit({ id: true, createdAt: true, updatedAt: true });
export type GrantApplication = typeof grantApplications.$inferSelect;

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
