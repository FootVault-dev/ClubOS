import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, bigint, smallint, boolean, timestamp, date, decimal, numeric, doublePrecision, real, pgEnum, uniqueIndex, unique, index, time, jsonb, serial, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import type { HiringQuestion } from "./hiring";
import type { ProgramFilter } from "./api-scopes";
import type { InvoiceLine, InvoiceSpendSummary } from "./invoice-types";
import type { StaffChatAttachment } from "./staff-chat";

export const roleEnum = pgEnum("role_type", ["super_admin", "admin", "team_member", "manager", "coach", "finance", "marketing", "registrar"]);
// "tenant" is for someone who exists in ClubOS only because they rent a room in
// the residency houses. A player or staff member who also rents keeps their own
// type — the tenancy links to the contact, not to its type.
export const contactTypeEnum = pgEnum("contact_type", ["player", "guardian", "staff", "volunteer", "sponsor", "tenant"]);
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
  // Hiring tab brand whitelist. The Hiring tab is one tab for every brand, so
  // holding it used to mean seeing every brand's applicants. null = all brands
  // (what every membership predating this column means — never narrow silently);
  // ["mfl","cic"] = only those; [] = none, so the tab opens empty rather than
  // full. Enforced server-side in server/hiring-routes.ts, not in the client.
  hiringBrands: jsonb("hiring_brands").$type<string[] | null>(),
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
  // Staff profile picture. An object-storage path we issued (`/objects/...`),
  // never an arbitrary URL — see the PATCH /api/auth/me guard. Nullable with
  // NO default on purpose: "this person hasn't set a photo" is a fact about
  // them, and a placeholder written into the column would be indistinguishable
  // from a real choice. The UI falls back to initials.
  avatarUrl: text("avatar_url"),
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
  // ── Structured NZF identity (2026-07-28) ───────────────────────────────────
  // The columns above hold the human-readable answer and stay the display
  // value. These hold the machine values NZ Football keys on, captured from
  // their own published vocabulary (shared/nzf-vocabulary.ts) at the moment the
  // family answers — so the push never re-resolves a string, and a rename on
  // their side cannot silently re-point a registration at a different group.
  // Free text was the bug: it produced "Christchurch" as a country of birth and
  // 68 bare "European" answers NZF cannot accept.
  nationalityCode: text("nationality_code"),           // FIFA/IOC alpha-3, NOT ISO
  countryOfBirthCode: text("country_of_birth_code"),
  ethnicityGroupId: integer("ethnicity_group_id"),
  ethnicitySelectionIds: integer("ethnicity_selection_ids").array(),
  ethnicity2GroupId: integer("ethnicity2_group_id"),
  ethnicity2SelectionIds: integer("ethnicity2_selection_ids").array(),
  identityCapturedAt: timestamp("identity_captured_at", { withTimezone: true }),
  identityCapturedSource: text("identity_captured_source"), // 'form' | 'staff' | 'import'
  // A documented skip at the counter. The NZF fields are required by default;
  // staff may defer them so a parent is never blocked from paying, but the
  // deferral is attributed and lands the child on a follow-up list. A gap is
  // then a decision someone made, not an accident.
  identityDeferredAt: timestamp("identity_deferred_at", { withTimezone: true }),
  identityDeferredReason: text("identity_deferred_reason"),
  identityDeferredByUserId: integer("identity_deferred_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  // ── Structured address ─────────────────────────────────────────────────────
  // `address` above stays untouched (every existing read path depends on it).
  // Sporty requires six SEPARATE fields and — contradicting its own swagger,
  // verified against the live API — all six are mandatory including Region.
  // A single line cannot be split back apart reliably.
  addressStreet: text("address_street"),
  addressSuburb: text("address_suburb"),
  addressCity: text("address_city"),
  addressRegion: text("address_region"),
  addressPostcode: text("address_postcode"),
  addressCountry: text("address_country"),             // FIFA/IOC alpha-3
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

  // Weeks from the term start during which the FULL term price is charged,
  // before pro-rata begins. The club's real U4–U8 rule (Olga, 2026-08-01):
  // weeks 1–5 cost the full $160, pro-rata starts at week 6 → 5.
  // 0 = pro-rate from day one, which is every other programme and the
  // behaviour every existing row had before this column existed.
  prorataGraceWeeks: integer("prorata_grace_weeks").notNull().default(0),

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
  // The REAL first-charge date (the Stripe subscription's trial_end), persisted
  // at creation so missed-payment maths never guesses the schedule from the
  // comp start (wrong for teams that signed up after the term began).
  weeklyFirstChargeDate: date("weekly_first_charge_date"),
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
  // ── Office / walk-up payments (2026-07-27) ─────────────────────────────────
  // A parent registers at the counter and pays EFTPOS or cash. Values live in
  // shared/payments.ts; deliberately no DB CHECK on this column.
  paymentMethod: text("payment_method"),
  // The EFTPOS terminal reference, receipt number, or bank-transfer particulars
  // — whatever the person reconciling the till will need to match it up.
  paymentReference: text("payment_reference"),
  // Who took the money. ON DELETE RESTRICT: deleting a staff member must never
  // erase the record of who handled a cash payment. Deactivate, don't delete.
  servedByUserId: integer("served_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  // When the money changed hands — distinct from registeredAt, which is when
  // the row was typed in. A till reconciliation needs the payment's clock.
  // withTimezone because a bare timestamp read back through a JS Date is
  // interpreted as local and lands 12 hours out in NZ.
  paidAt: timestamp("paid_at", { withTimezone: true }),
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
  // Optional human label for the slot — e.g. "U4–U6", "U7–U8" for age-split
  // Saturday sessions. Lets a single program run multiple slots on the same
  // day with different rolls.
  name: text("name"),
});
// Uniqueness on camp_dates lives in two PARTIAL indexes, not a plain UNIQUE
// (see migrations/2026-07-23_camp_dates_slot_key.sql), because the two models
// need different keys:
//   camp_dates_day_uniq   (camp_id, date) WHERE start_time IS NULL
//       — holiday camps: one row per camp per day, split by the capacity cols.
//   camp_dates_slot_uniq  (camp_id, date, start_time) WHERE start_time IS NOT NULL
//       — term timetables: the U4-U8 academy runs Sat 09:30 AND Sat 10:30.
// Do NOT reinstate a plain UNIQUE (camp_id, date) — it makes an age-split
// Saturday impossible, and a plain UNIQUE (camp_id, date, start_time) would
// silently stop protecting holiday camps, whose start_time is always NULL.

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

// One roll line per person per session. Exactly one of childId/contactId is
// set — enforced by `attendance_one_person_ck`, not by hope:
//   childId   — holiday camps, where the player is a `children` row reached
//               through a per-day registration_items line.
//   contactId — academy/term programmes, where the registrant contact IS the
//               player (contacts.type='player') and a term enrolment writes no
//               per-date items at all.
// Both references are NO ACTION (≈ RESTRICT): deleting a person must never
// erase the record of whether they turned up.
export const attendance = pgTable("attendance", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  campId: integer("camp_id").notNull().references(() => programs.id),
  campDateId: integer("camp_date_id").notNull().references(() => campDates.id),
  childId: integer("child_id").references(() => children.id),
  contactId: integer("contact_id").references(() => contacts.id),
  checkedInAt: timestamp("checked_in_at"),
  // Camps only. A holiday camp signs a child out to a named adult (a custody
  // record); a 45-minute academy session just ends. Term rolls never set it.
  checkedOutAt: timestamp("checked_out_at"),
  checkedInByUserId: integer("checked_in_by_user_id").references(() => users.id),
  checkedOutByUserId: integer("checked_out_by_user_id").references(() => users.id),
  // Term-roll state: 'present' | 'absent'. NULL means NOT MARKED YET, which is
  // a different fact from absent and must stay distinguishable — a blank roll
  // must never read as "nobody came". Deliberately not a DB enum/CHECK.
  status: text("status"),
  markedAt: timestamp("marked_at"),
  markedByUserId: integer("marked_by_user_id").references(() => users.id),
  // Why this person is on the roll without being a confirmed registration.
  // NULL = a registration (the normal case) · 'open_training' = free
  // trialist · 'unpaid' = training while the fees are outstanding. Not a DB
  // enum — new reasons shouldn't need a migration; the route validates it.
  guestKind: text("guest_kind"),
  note: text("note"),
});

// Which coaches are rostered onto a session, and whether they turned up.
// The sibling of `attendance`: that table answers "which children were here",
// this one answers "which coaches did we have on, and did they show".
//
// A coach IS a `contacts` row (type='staff') — players and coaches already live
// there (Paul Holocher's Term 3 roster was seeded into it), and forking them
// would fork the club's database. Same reasoning as `club_squad_members`.
//
// Keyed on the camp_date, which is a SLOT not a day: the U4–U8 programme runs
// Sat 09:30 (U4–U6) and Sat 10:30 (U7–U8) as separate sessions with separate
// coaches. Both people/session FKs are NO ACTION — deleting a coach must never
// erase the record of who ran a session.
export const sessionCoaches = pgTable("session_coaches", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  campId: integer("camp_id").notNull().references(() => programs.id),
  campDateId: integer("camp_date_id").notNull().references(() => campDates.id),
  contactId: integer("contact_id").notNull().references(() => contacts.id),
  // 'lead' | 'coach' | 'assistant'. Validated by the route, never a DB CHECK —
  // a stale CHECK constraint is how the MFL checkout 500'd.
  role: text("role").notNull().default("coach"),
  // 'present' | 'absent' | NULL. NULL means NOT MARKED YET, which is a
  // different fact from absent: a half-taken roll must never read as "nobody
  // turned up", and "we never checked" is not the same as "he didn't come".
  status: text("status"),
  markedAt: timestamp("marked_at"),
  markedByUserId: integer("marked_by_user_id").references(() => users.id),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (t) => ({
  // Assigning the same coach twice is a no-op, not a duplicate that would
  // double every count on the overview.
  uniqueCoach: uniqueIndex("session_coaches_unique").on(t.campDateId, t.contactId),
  campIdx: index("session_coaches_camp_idx").on(t.campId),
  contactIdx: index("session_coaches_contact_idx").on(t.contactId),
}));
export const insertSessionCoachSchema = createInsertSchema(sessionCoaches).omit({ id: true, createdAt: true });
export type InsertSessionCoach = z.infer<typeof insertSessionCoachSchema>;
export type SessionCoach = typeof sessionCoaches.$inferSelect;

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
  // When set + status "scheduled", the mailer-schedule worker dispatches the
  // send at/after this time (atomic claim → "sending"). Null = send immediately.
  scheduledAt: timestamp("scheduled_at"),
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
  // Marketing attribution — where a PUBLIC booking originated, captured from a
  // ?source= / utm_* param on the booking URL (e.g. the cufc.co.nz "Field Hire"
  // menu link arrives with ?source=field-hire-mainmenu). NULL for manual/member
  // bookings and for public bookings that arrived untagged. Kept separate from
  // `source` (the manual|public|member_request channel) so that audit taxonomy
  // is untouched.
  attributionSource: text("attribution_source"),
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
  // "Split with PayShare" — the third-party group-checkout option, live beside
  // Player Pay rather than replacing it. Its own switch on purpose: turning
  // PayShare off must never take our own split down with it, and vice versa.
  payshareEnabled: boolean("payshare_enabled").default(false),
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
  // Referee scoring app (clone of tournaments.gameDurationMinutes /
  // breakBetweenMinutes) — leagues run their own match lengths.
  halfLengthMinutes: integer("half_length_minutes").notNull().default(20),
  breakMinutes: integer("break_minutes").notNull().default(5),
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
  // Optional marketing ribbon on the public night card ("New league discount").
  // Free text set per division in the league admin, so drawing attention to a
  // night needs a row edit, never a deploy. NULL = no badge (the default, and
  // what every existing division means). The "Sold out" ribbon still wins:
  // a full night must never advertise a discount it cannot honour.
  badgeText: text("badge_text"),
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
  // Share-link reminder emails to the captain (open registration splits only) —
  // count + last-sent drive the sweep cadence and cap; a manual admin resend
  // stamps lastReminderAt but never consumes the cap.
  reminderCount: integer("reminder_count").notNull().default(0),
  lastReminderAt: timestamp("last_reminder_at"),
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

// ── PayShare — third-party group-checkout orchestration ─────────────────────
// PayShare runs the group SESSION (invite link, participant progress, completion
// rules); the money still moves on our own Stripe rails. Deliberately its own
// tables rather than an extra fundingType on split_sessions: that table already
// carries live MFL registration money, and coupling a third party's state
// machine to it would put real registrations behind PayShare's uptime.
export const payshareSessions = pgTable("payshare_sessions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  // PayShare's own session id — the join key on every inbound hook and webhook.
  sessionId: text("session_id").notNull(),
  // The facility_bookings group this funds, held 'pending' until completion.
  bookingGroupId: text("booking_group_id"),
  // What we told PayShare the group owes. Minor units + an explicit ISO currency:
  // PayShare requires currency on every session and there is deliberately no
  // default, so a booking's own currency is always what gets sent.
  amountMinor: integer("amount_minor").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull().default("open"), // 'open'|'completed'|'expired'|'cancelled'
  sessionUrl: text("session_url"),
  merchantOrderRef: text("merchant_order_ref"),
  // PayShare's deadline for the group. Our pending-slot hold is pinned to this
  // so we can never release a pitch while PayShare still has the group live.
  expiresAt: timestamp("expires_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uniqueSessionId: uniqueIndex("payshare_sessions_session_id_unique").on(t.sessionId),
}));

export const payshareParticipants = pgTable("payshare_participants", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  payshareSessionId: integer("payshare_session_id").notNull().references(() => payshareSessions.id, { onDelete: "cascade" }),
  participantId: text("participant_id").notNull(),
  role: text("role").notNull().default("participant"), // 'host'|'participant'
  // PayShare tells US each share — we never compute it. Stored so the pay page
  // charges exactly what PayShare told that person they owe, to the cent.
  shareAmountMinor: integer("share_amount_minor").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull().default("pending"), // 'pending'|'authorized'|'captured'|'failed'
  // Random token in our pay-page URL. Never PayShare's participantId: that is
  // theirs, shows in their UI, and would make our pay links guessable.
  payToken: text("pay_token").notNull(),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  // Where PayShare wants the payer sent back to once their share is done.
  returnUrl: text("return_url"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uniqueParticipant: uniqueIndex("payshare_participants_session_participant_unique").on(t.payshareSessionId, t.participantId),
  uniquePayToken: uniqueIndex("payshare_participants_pay_token_unique").on(t.payToken),
}));

// Inbound-event dedupe. The SDK offers an in-memory Map/Set for this, which is
// wrong here: prod runs TWO Fly machines, so in-memory state lets the same
// replayed webhook confirm one booking twice. The unique index is the real
// guard, and the stored response is replayed verbatim on a duplicate so a retry
// can never mint a second payment intent.
export const payshareEvents = pgTable("payshare_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  eventId: text("event_id").notNull(),
  kind: text("kind").notNull(), // 'create_payment'|'webhook'
  sessionId: text("session_id"),
  responseJson: jsonb("response_json"),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
}, (t) => ({
  uniqueEvent: uniqueIndex("payshare_events_event_id_kind_unique").on(t.eventId, t.kind),
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
  // Referee scoring app: accountability stamp (mirrors tournament_games) — which
  // referee last saved a score, and when. FK ON DELETE SET NULL: removing a
  // referee must never erase the history that a game was scored.
  lastScoredByRefereeId: integer("last_scored_by_referee_id").references(() => leagueReferees.id, { onDelete: "set null" }),
  lastScoredAt: timestamp("last_scored_at"),
  // Live match timer (Score Game) — same phase machine as tournament_games, but
  // leagues have no brackets and no isLive column: status='in_progress' plays
  // the "is this game live right now" role instead.
  timerPhase: text("timer_phase").notNull().default("pre"), // pre|first_half|half_time|second_half|finished
  timerRunning: boolean("timer_running").notNull().default(false),
  timerStartedAt: timestamp("timer_started_at"),
  timerBaseSeconds: integer("timer_base_seconds").notNull().default(0),
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

// ── MFL referee scoring (clone of the CIC referee system, shared/schema.ts
// `cicReferees` / `cicRefereeAssignments`) ──────────────────────────────────
// Referees are a SEPARATE identity from ClubOS staff `users` AND from
// `leagueGameReferees` (a ClubOS user assigned as ref, used by the older
// session-based /api/league/games/:id/score path) — see
// server/league-referee-routes.ts for the full reasoning. Public signup writes
// a 'pending' row; an MFL staffer approves it before it can log in. Statuses
// validated app-side in shared/league-referees.ts (no DB enum).
export const leagueReferees = pgTable("league_referees", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  passwordHash: text("password_hash").notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | suspended | declined
  approvedBy: integer("approved_by").references(() => users.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at"),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // Invoice/payment details — the MFL coordinator fills a per-ref invoice
  // fortnightly and needs each ref's bank account to pay into. Captured at
  // signup, editable any time by the ref (PATCH /api/public/mfl-referees/me,
  // server/league-referee-routes.ts). All nullable: refs who signed up before
  // 2026-07-13 have none, and the admin UI says so plainly rather than
  // guessing.
  bankAccountName: text("bank_account_name"),
  bankAccountNumber: text("bank_account_number"),
  bankName: text("bank_name"),
  address: text("address"),
  gstNumber: text("gst_number"),
});

// Soft assignment of a referee to a game — drives the ref's default "My games"
// view. Any approved ref can still score any MFL game (flexibility as fixtures
// shift); assignment is organisation + accountability, not a hard lock.
export const leagueRefereeAssignments = pgTable("league_referee_assignments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  refereeId: integer("referee_id").notNull().references(() => leagueReferees.id, { onDelete: "cascade" }),
  gameId: integer("game_id").notNull().references(() => leagueGames.id, { onDelete: "cascade" }),
  assignedBy: integer("assigned_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uniqAssignment: unique().on(t.refereeId, t.gameId),
}));

// Goals — unlike CIC's tournamentGoals, MFL has no player-roster table
// (tournamentPlayers), so the scorer is free text. teamId is the CREDITED team
// (an own goal sends the opponent's teamId — the client computes the flip).
export const leagueGoals = pgTable("league_goals", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  gameId: integer("game_id").notNull().references(() => leagueGames.id, { onDelete: "cascade" }),
  teamId: integer("team_id").references(() => leagueTeams.id, { onDelete: "set null" }),
  playerName: text("player_name").notNull(),
  minute: integer("minute"),
  isOwnGoal: boolean("is_own_goal").notNull().default(false),
  isPenalty: boolean("is_penalty").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  gameIdx: index("league_goals_game_idx").on(t.gameId),
}));

// Disciplinary cards — same free-text-player shape as leagueGoals.
export const leagueCards = pgTable("league_cards", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  gameId: integer("game_id").notNull().references(() => leagueGames.id, { onDelete: "cascade" }),
  teamId: integer("team_id").references(() => leagueTeams.id, { onDelete: "set null" }),
  playerName: text("player_name").notNull(),
  cardType: text("card_type").notNull(), // 'yellow' | 'red'
  minute: integer("minute"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  gameIdx: index("league_cards_game_idx").on(t.gameId),
}));

// Photos/highlights for an MFL competition — a staged gallery (unpublished rows
// let an admin queue images before they go live).
export const leagueMedia = pgTable("league_media", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  competitionId: integer("competition_id").references(() => leagueCompetitions.id, { onDelete: "set null" }),
  url: text("url").notNull(),
  caption: text("caption"),
  takenAt: date("taken_at"),
  sortOrder: integer("sort_order").notNull().default(0),
  published: boolean("published").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  orgPublishedIdx: index("league_media_org_published_idx").on(t.organizationId, t.published),
}));

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
  // Referee scoring app: which referee last saved a score here, and when. Set
  // server-side on every referee write so the office always knows who touched a
  // game. FK ON DELETE SET NULL — removing a referee never erases the history.
  lastScoredByRefereeId: integer("last_scored_by_referee_id").references(() => cicReferees.id, { onDelete: "set null" }),
  lastScoredAt: timestamp("last_scored_at"),
  // Live match timer (Score Game). Phase machine; the clock is DERIVED, never
  // stored ticking. first_half/second_half count UP to the half length
  // (tournament game_duration_minutes); half_time counts DOWN from the break.
  timerPhase: text("timer_phase").notNull().default("pre"), // pre|first_half|half_time|second_half|finished
  timerRunning: boolean("timer_running").notNull().default(false),
  timerStartedAt: timestamp("timer_started_at"),
  timerBaseSeconds: integer("timer_base_seconds").notNull().default(0),
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

// ── CIC referee accounts (match scoring) ──────────────────────────────────────
// Referees are a SEPARATE identity from ClubOS staff `users`: they must never
// hold a staff session, because many /api/admin/* routes carry no org check. A
// referee credential (an HMAC token carrying a referee id, see
// server/cic-referee-routes.ts) only ever reaches the CIC referee scoring
// endpoints. Public signup writes a 'pending' row; a CIC staffer approves it
// before it can log in. Statuses validated in shared/referees.ts (no DB enum).
export const cicReferees = pgTable("cic_referees", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  passwordHash: text("password_hash").notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | suspended | declined
  approvedBy: integer("approved_by").references(() => users.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at"),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Soft assignment of a referee to a game — drives the ref's default "My games"
// view. Any approved ref can still score any CIC game (flexibility as fixtures
// shift); assignment is organisation + accountability, not a hard lock. The
// case-insensitive one-account-per-email index lives in the migration SQL.
export const cicRefereeAssignments = pgTable("cic_referee_assignments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  refereeId: integer("referee_id").notNull().references(() => cicReferees.id, { onDelete: "cascade" }),
  gameId: integer("game_id").notNull().references(() => tournamentGames.id, { onDelete: "cascade" }),
  assignedBy: integer("assigned_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uniqAssignment: unique().on(t.refereeId, t.gameId),
}));

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

// ── Total Tracking Platform, Phase 1 (Behavioral Depth) ──────────────────────
// behavior_events — a SEPARATE pipeline from analyticsEvents above (which is the
// LIVE attribution touch path — see AGENTS.md rule 4). Written to ONLY by the
// POST /api/public/analytics/behavior collector. The real table
// (migrations/2026-07-10_behavior_events.sql) is monthly RANGE-partitioned on
// `ts` with a composite (id, ts) primary key — drizzle can't own partitioning,
// so this mirror carries matching columns for query typing only (no partition
// clause, no PK annotation, since drizzle-kit push is never run against this
// schema — the migration file is the source of truth).
export const behaviorEvents = pgTable("behavior_events", {
  id: bigint("id", { mode: "number" }).notNull(),
  visitorId: text("visitor_id"),
  personId: integer("person_id"),
  sessionId: text("session_id"),
  site: text("site"),
  eventType: text("event_type").notNull(),
  pagePath: text("page_path"),
  cssPath: text("css_path"),
  offsetX: real("offset_x"),
  offsetY: real("offset_y"),
  viewport: text("viewport"),
  scrollBand: integer("scroll_band"),
  sectionKey: text("section_key"),
  visibleMs: integer("visible_ms"),
  dwellMs: integer("dwell_ms"),
  formId: text("form_id"),
  metric: text("metric"),
  metricValue: real("metric_value"),
  textHash: text("text_hash"),
  country: text("country"),
  city: text("city"),
  isBot: boolean("is_bot").notNull().default(false),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  visitorTsIdx: index("behavior_events_visitor_ts_idx").on(t.visitorId, t.ts),
  pageTsIdx: index("behavior_events_page_ts_idx").on(t.pagePath, t.ts),
  typeTsIdx: index("behavior_events_type_ts_idx").on(t.eventType, t.ts),
  sectionTsIdx: index("behavior_events_section_ts_idx").on(t.sectionKey, t.ts),
}));

export const insertBehaviorEventSchema = createInsertSchema(behaviorEvents).omit({ id: true });
export type InsertBehaviorEvent = z.infer<typeof insertBehaviorEventSchema>;
export type BehaviorEvent = typeof behaviorEvents.$inferSelect;
export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;

// ── Behavior rollups (nightly; the ONLY tables the Behavior tab/agents read —
// never behavior_events directly. See AGENTS.md North star, D17/D18.) ─────────

export const pageStatsDaily = pgTable("page_stats_daily", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  site: text("site").notNull().default(""),
  pagePath: text("page_path").notNull(),
  day: date("day").notNull(),
  views: integer("views").notNull().default(0),
  uniques: integer("uniques").notNull().default(0),
  avgDwellMs: real("avg_dwell_ms").notNull().default(0),
  scrollHist: jsonb("scroll_hist").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  exitRate: real("exit_rate").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  unq: uniqueIndex("page_stats_daily_unq").on(t.site, t.pagePath, t.day),
  dayIdx: index("page_stats_daily_day_idx").on(t.day),
}));

export type PageStatsDaily = typeof pageStatsDaily.$inferSelect;

export const sectionStatsDaily = pgTable("section_stats_daily", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  pagePath: text("page_path").notNull(),
  sectionKey: text("section_key").notNull(),
  day: date("day").notNull(),
  avgVisibleMs: real("avg_visible_ms").notNull().default(0),
  viewCount: integer("view_count").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  unq: uniqueIndex("section_stats_daily_unq").on(t.pagePath, t.sectionKey, t.day),
  dayIdx: index("section_stats_daily_day_idx").on(t.day),
}));

export type SectionStatsDaily = typeof sectionStatsDaily.$inferSelect;

export const clickStatsDaily = pgTable("click_stats_daily", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  pagePath: text("page_path").notNull(),
  cssPath: text("css_path").notNull(),
  viewport: text("viewport").notNull().default(""),
  day: date("day").notNull(),
  clicks: integer("clicks").notNull().default(0),
  uniques: integer("uniques").notNull().default(0),
  avgOffsetX: real("avg_offset_x").notNull().default(0),
  avgOffsetY: real("avg_offset_y").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  unq: uniqueIndex("click_stats_daily_unq").on(t.pagePath, t.cssPath, t.viewport, t.day),
  dayIdx: index("click_stats_daily_day_idx").on(t.day),
}));

export type ClickStatsDaily = typeof clickStatsDaily.$inferSelect;

export const journeyEdgesDaily = pgTable("journey_edges_daily", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  site: text("site").notNull().default(""),
  fromPath: text("from_path").notNull(),
  toPath: text("to_path").notNull(),
  day: date("day").notNull(),
  count: integer("count").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  unq: uniqueIndex("journey_edges_daily_unq").on(t.site, t.fromPath, t.toPath, t.day),
  dayIdx: index("journey_edges_daily_day_idx").on(t.day),
}));

export type JourneyEdgesDaily = typeof journeyEdgesDaily.$inferSelect;

export const hourOfDayProfile = pgTable("hour_of_day_profile", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  site: text("site").notNull().default(""),
  dow: smallint("dow").notNull(),
  hour: smallint("hour").notNull(),
  sessions: integer("sessions").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  unq: uniqueIndex("hour_of_day_profile_unq").on(t.site, t.dow, t.hour),
}));

export type HourOfDayProfile = typeof hourOfDayProfile.$inferSelect;

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
export const insertLeagueRefereeSchema = createInsertSchema(leagueReferees).omit({ id: true, createdAt: true });
export const insertLeagueRefereeAssignmentSchema = createInsertSchema(leagueRefereeAssignments).omit({ id: true, createdAt: true });
export const insertLeagueGoalSchema = createInsertSchema(leagueGoals).omit({ id: true, createdAt: true });
export const insertLeagueCardSchema = createInsertSchema(leagueCards).omit({ id: true, createdAt: true });
export const insertLeagueMediaSchema = createInsertSchema(leagueMedia).omit({ id: true, createdAt: true });
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
export type InsertLeagueReferee = z.infer<typeof insertLeagueRefereeSchema>;
export type LeagueReferee = typeof leagueReferees.$inferSelect;
export type InsertLeagueRefereeAssignment = z.infer<typeof insertLeagueRefereeAssignmentSchema>;
export type LeagueRefereeAssignment = typeof leagueRefereeAssignments.$inferSelect;
export type InsertLeagueGoal = z.infer<typeof insertLeagueGoalSchema>;
export type LeagueGoal = typeof leagueGoals.$inferSelect;
export type InsertLeagueCard = z.infer<typeof insertLeagueCardSchema>;
export type LeagueCard = typeof leagueCards.$inferSelect;
export type InsertLeagueMedia = z.infer<typeof insertLeagueMediaSchema>;
export type LeagueMedia = typeof leagueMedia.$inferSelect;
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
  // Programmes this key may read WITHIN those orgs — the third axis of least
  // privilege, for staff who run part of a workspace (holiday-camp coordinator
  // vs the whole academy). NULL = unrestricted; see shared/api-scopes.ts.
  // A programme matches on type OR slug. Present-but-empty means nothing.
  programFilter: jsonb("program_filter").$type<ProgramFilter | null>(),
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

// Quotes submitted from the unitedprints.co.nz "Instant Quote" page — indicative
// self-serve totals awaiting Dima's Approve/Reject. Approve materialises a
// quote into a real printOrders row (+ items + a 'created' event) so it enters
// the existing Orders/production pipeline; Reject just closes it out. Status is
// app-validated text, not a pgEnum, to avoid the prod enum-drift the hiring/
// vehicles/housing tables already dodge this way.
export const printQuotes = pgTable("print_quotes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  // Random 48-hex token, for a future customer-facing quote view.
  token: text("token").notNull().unique(),

  status: text("status").notNull().default("new"), // new | approved | rejected

  customerName: text("customer_name"),
  customerEmail: text("customer_email"),
  customerPhone: text("customer_phone"),

  source: text("source"),
  sourceUrl: text("source_url"),

  subtotalCents: integer("subtotal_cents").notNull().default(0),
  gstCents: integer("gst_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull().default(0),

  // Always true today — the website only ever sends an indicative self-serve
  // total, never a confirmed price.
  indicative: boolean("indicative").notNull().default(true),

  note: text("note"),

  reviewedBy: integer("reviewed_by").references(() => users.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at"),
  rejectedReason: text("rejected_reason"),
  promotedOrderId: integer("promoted_order_id").references(() => printOrders.id, { onDelete: "set null" }),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export const insertPrintQuoteSchema = createInsertSchema(printQuotes).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPrintQuote = z.infer<typeof insertPrintQuoteSchema>;
export type PrintQuote = typeof printQuotes.$inferSelect;

export const printQuoteItems = pgTable("print_quote_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  quoteId: integer("quote_id").notNull().references(() => printQuotes.id, { onDelete: "cascade" }),

  designName: text("design_name"),
  material: text("material"),
  sizeLabel: text("size_label"),
  areaM2: decimal("area_m2", { precision: 10, scale: 4 }),
  quantity: integer("quantity").notNull().default(1),
  lineExGstCents: integer("line_ex_gst_cents").notNull().default(0),
  designFileName: text("design_file_name"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertPrintQuoteItemSchema = createInsertSchema(printQuoteItems).omit({ id: true, createdAt: true });
export type InsertPrintQuoteItem = z.infer<typeof insertPrintQuoteItemSchema>;
export type PrintQuoteItem = typeof printQuoteItems.$inferSelect;

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
  // Terminal, no-score outcomes (Olympic convention): "dns" | "dnf" | "dsq".
  // Mutually exclusive with `score` — an entry is pending, scored, or one of
  // these. Null for a normal entry.
  status: text("status"),
  scoredByUserId: integer("scored_by_user_id").references(() => users.id, { onDelete: "set null" }),
  scoredAt: timestamp("scored_at"),
  source: text("source").notNull().default("public"), // "public" | "admin"
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSkillsChallengeEntrySchema = createInsertSchema(skillsChallengeEntries).omit({ id: true, createdAt: true });
export type InsertSkillsChallengeEntry = z.infer<typeof insertSkillsChallengeEntrySchema>;
export type SkillsChallengeEntry = typeof skillsChallengeEntries.$inferSelect;

// ---- Mobile push notifications (CIC Youth fans + ClubOS staff) ----
// Devices register their Expo push token on app launch; CIC broadcasts are
// composed in the ClubOS "Notifications" tab and fan out through Expo's push
// service in batches of 100. `disabled` flips when Expo reports the device as
// no longer registered (app uninstalled / token rotated).
//
// 🔴 `app` SEPARATES TWO COMPLETELY DIFFERENT AUDIENCES and every query must
// filter on it: "cic-youth" rows are anonymous FANS, "clubos-staff" rows are
// named STAFF. Sending a staff message to an unfiltered device list would push
// club-internal chat to every parent who installed the tournament app.
export const devicePushTokens = pgTable("device_push_tokens", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  token: text("token").notNull().unique(),
  app: text("app").notNull().default("cic-youth"),
  // NULL for CIC fan devices — they are deliberately anonymous and always will
  // be. Set for staff phones, which is what makes person-addressed push
  // possible at all. Cascade: a deleted user's token must be unreachable.
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  platform: text("platform").notNull().default("unknown"), // "ios" | "android" | "unknown"
  deviceName: text("device_name"),
  disabled: boolean("disabled").notNull().default(false),
  failureCount: integer("failure_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---- Per-person notification preferences ----
// One row per user; a MISSING ROW IS VALID and means "never opened settings" —
// the server answers DEFAULT_PREFERENCES (shared/notifications.ts), so nothing
// needs backfilling and a new staff member works on day one.
// Delivery columns are validated TEXT, never pg enums: adding a mode must not
// require a migration. Hours are 0–23 NZ calendar parts, never timestamps.
export const notificationPreferences = pgTable("notification_preferences", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  pushEnabled: boolean("push_enabled").notNull().default(true),
  emailEnabled: boolean("email_enabled").notNull().default(true),
  // 'both' | 'push' | 'email' | 'none'
  chatDm: text("chat_dm").notNull().default("both"),
  chatMention: text("chat_mention").notNull().default("both"),
  chatChannel: text("chat_channel").notNull().default("push"),
  taskAssigned: text("task_assigned").notNull().default("both"),
  taskDue: text("task_due").notNull().default("email"),
  // Message text on the lock screen — chat can carry a child's name.
  showPreview: boolean("show_preview").notNull().default(true),
  quietHoursEnabled: boolean("quiet_hours_enabled").notNull().default(true),
  quietHoursStart: integer("quiet_hours_start").notNull().default(20),
  quietHoursEnd: integer("quiet_hours_end").notNull().default(8),
  dailyDigest: boolean("daily_digest").notNull().default(false),
  dailyDigestHour: integer("daily_digest_hour").notNull().default(8),
  weeklyDigest: boolean("weekly_digest").notNull().default(false),
  weeklyDigestDay: integer("weekly_digest_day").notNull().default(1), // ISO Mon=1
  weeklyDigestHour: integer("weekly_digest_hour").notNull().default(8),
  // Idempotency for the 15-minute digest sweep, compared on the NZ calendar day.
  lastDailyDigestAt: timestamp("last_daily_digest_at", { withTimezone: true }),
  lastWeeklyDigestAt: timestamp("last_weekly_digest_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type NotificationPreferencesRow = typeof notificationPreferences.$inferSelect;

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

// ---- CUFC Open Trainings ----
// Free open-training requests from cufc.co.nz (2026-07-21). U9–U20 academy
// programmes are invite-only: the public form replaces the direct checkout,
// staff approve or decline each request in the CUFC workspace "Open Trainings"
// tab, and an approval sends the family a confirmation email. The age band is
// DERIVED server-side from the child's date of birth (NZF rule: grade =
// season year − birth year), never trusted from the browser. DOB is ISO text —
// a `date` column read through node-postgres comes back a day out in NZ.
export const cufcOpenTrainings = pgTable("cufc_open_trainings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  ageGroup: text("age_group").notNull(), // 'u4-u8' | 'u9-u12' | 'u13-plus' — app-validated, no CHECK (prod enum drift)
  childFirstName: text("child_first_name").notNull(),
  childLastName: text("child_last_name").notNull(),
  childDob: text("child_dob").notNull(), // ISO date, e.g. "2015-04-09"
  ageGrade: integer("age_grade"),        // NZF grade at request time (season − birth year)
  guardianName: text("guardian_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),        // club rule: phone is mandatory
  currentClub: text("current_club"),
  notes: text("notes"),                  // anything the parent told us
  status: text("status").notNull().default("pending"), // 'pending' | 'approved' | 'declined' — app-validated
  sessionDetails: text("session_details"), // staff-entered; included in the approval email
  staffNotes: text("staff_notes"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedBy: text("decided_by"),
  source: text("source"),
  sourceUrl: text("source_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertCufcOpenTrainingSchema = createInsertSchema(cufcOpenTrainings).omit({ id: true, createdAt: true });
export type InsertCufcOpenTraining = z.infer<typeof insertCufcOpenTrainingSchema>;
export type CufcOpenTraining = typeof cufcOpenTrainings.$inferSelect;

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
  // Native docs: which signer fills the details schedule (name/DOB/bank/IRD…).
  // Deliberately SEPARATE from signingOrder so the Club can sign FIRST while the
  // counterparty still supplies their own details. Backfilled true for every
  // signingOrder=0 row, so pre-existing documents behave exactly as before.
  isFormSigner: boolean("is_form_signer").notNull().default(false),
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

// ── Sponsor Traffic (group / USG workspace) ───────────────────────────────────
// Tracks how much website traffic the club sends to its sponsors' sites via
// tracked redirect links (app.usg.co.nz/s/{shortCode}), plus a sponsor-site
// health check — born because a sponsor's site went down and we only found out
// when a friend mentioned it. One row = one PLACEMENT (a sponsor on one brand
// site) — a shared sponsor (e.g. Moana Skies on both CUFC and SIU) gets a row
// per brand because the destination URL and tracked link differ per brand.
export const sponsors = pgTable("sponsors", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  brand: text("brand").notNull(),                 // cufc | siu | mfl | cic | …
  websiteUrl: text("website_url").notNull(),       // their real destination
  shortCode: text("short_code").notNull().unique(), // tracked-link code → /s/{shortCode}
  logoUrl: text("logo_url"),
  tier: text("tier"),                              // partner | Principal partner | …
  // Sponsor-site health check — button-triggered (POST .../:id/check or
  // .../check-all). No cron yet; a daily scheduled sweep is a natural future
  // enhancement once this proves useful.
  siteStatus: text("site_status").notNull().default("unknown"), // ok | down | unknown
  siteStatusCode: integer("site_status_code"),
  siteCheckedAt: timestamp("site_checked_at"),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  openCount: integer("open_count").notNull().default(0), // denormalised (non-internal clicks)
  lastOpenedAt: timestamp("last_opened_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  orgIdx: index("sponsors_org_idx").on(t.organizationId),
  brandIdx: index("sponsors_brand_idx").on(t.brand),
}));

export const insertSponsorSchema = createInsertSchema(sponsors).omit({ id: true, createdAt: true, updatedAt: true, openCount: true, lastOpenedAt: true });
export type InsertSponsor = z.infer<typeof insertSponsorSchema>;
export type Sponsor = typeof sponsors.$inferSelect;

// One row per tracked-link touch on a sponsor's link. Same shape as
// proposal_events plus `source` — the optional `?src=` query param, so a click
// can be attributed to the page/section that sent it even if the referrer
// header is stripped (common on mobile / in-app browsers).
export const sponsorLinkEvents = pgTable("sponsor_link_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  sponsorId: integer("sponsor_id").notNull().references(() => sponsors.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("click"),
  visitorId: text("visitor_id"),
  device: text("device"),                          // mobile | tablet | desktop
  userAgent: text("user_agent"),
  referrer: text("referrer"),
  source: text("source"),                          // from ?src= — which page/section sent it
  country: text("country"),                         // coarse geo only — no raw IP
  isInternal: boolean("is_internal").notNull().default(false),
  metaJson: jsonb("meta_json").$type<Record<string, any> | null>(),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
}, (t) => ({
  sponsorOccurredIdx: index("sponsor_link_events_sponsor_idx").on(t.sponsorId, t.occurredAt),
  sponsorKindIdx: index("sponsor_link_events_kind_idx").on(t.sponsorId, t.kind),
}));

export const insertSponsorLinkEventSchema = createInsertSchema(sponsorLinkEvents).omit({ id: true, occurredAt: true });
export type InsertSponsorLinkEvent = z.infer<typeof insertSponsorLinkEventSchema>;
export type SponsorLinkEvent = typeof sponsorLinkEvents.$inferSelect;

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
// ═══════════════════════════════════════════════════════════════════════════
// Shop — native e-commerce module (MFL Store pilot, Shopify replacement).
// Generic multi-brand: everything hangs off organization_id; MFL (org 3) is
// the first store. Money = integer NZD cents (except costUsd, a supplier cost
// REFERENCE only — USD, ex shipping/duties — never used in calculations).
// ═══════════════════════════════════════════════════════════════════════════

export const shopProducts = pgTable("shop_products", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  description: text("description"),
  type: text("type").notNull().default("shirt"),        // 'kit' | 'shirt' | ... open-ended
  priceCents: integer("price_cents").notNull().default(0),
  compareAtCents: integer("compare_at_cents"),
  costUsd: decimal("cost_usd", { precision: 10, scale: 2 }),  // reference only (USD, ex shipping/duties)
  badge: text("badge"),
  status: text("status").notNull().default("draft"),    // 'draft' | 'active' | 'archived'
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  orgSlugUnq: uniqueIndex("shop_products_org_slug_unique").on(t.organizationId, t.slug),
}));
export const insertShopProductSchema = createInsertSchema(shopProducts).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertShopProduct = z.infer<typeof insertShopProductSchema>;
export type ShopProduct = typeof shopProducts.$inferSelect;

export const shopProductColours = pgTable("shop_product_colours", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("product_id").notNull().references(() => shopProducts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  swatchHex: text("swatch_hex"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
});
export const insertShopProductColourSchema = createInsertSchema(shopProductColours).omit({ id: true });
export type InsertShopProductColour = z.infer<typeof insertShopProductColourSchema>;
export type ShopProductColour = typeof shopProductColours.$inferSelect;

// colourId null = product-level image.
export const shopProductImages = pgTable("shop_product_images", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("product_id").notNull().references(() => shopProducts.id, { onDelete: "cascade" }),
  colourId: integer("colour_id").references(() => shopProductColours.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  alt: text("alt"),
  sortOrder: integer("sort_order").notNull().default(0),
});
export const insertShopProductImageSchema = createInsertSchema(shopProductImages).omit({ id: true });
export type InsertShopProductImage = z.infer<typeof insertShopProductImageSchema>;
export type ShopProductImage = typeof shopProductImages.$inferSelect;

// Variant = colour × size. Stock lives here.
export const shopVariants = pgTable("shop_variants", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("product_id").notNull().references(() => shopProducts.id, { onDelete: "cascade" }),
  colourId: integer("colour_id").notNull().references(() => shopProductColours.id, { onDelete: "cascade" }),
  size: text("size").notNull(),
  sku: text("sku"),
  stock: integer("stock").notNull().default(0),
  // Optional per-variant price override (NZD cents). Null → use the product
  // price (all MFL kits). Used by variable-price products like the CIC Gift Card
  // where each denomination variant carries its own price.
  priceCents: integer("price_cents"),
  active: boolean("active").notNull().default(true),
}, (t) => ({
  colourSizeUnq: uniqueIndex("shop_variants_colour_size_unique").on(t.colourId, t.size),
}));
export const insertShopVariantSchema = createInsertSchema(shopVariants).omit({ id: true });
export type InsertShopVariant = z.infer<typeof insertShopVariantSchema>;
export type ShopVariant = typeof shopVariants.$inferSelect;

export const shopShippingOptions = pgTable("shop_shipping_options", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  description: text("description"),
  priceCents: integer("price_cents").notNull().default(0),
  requiresAddress: boolean("requires_address").notNull().default(false),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});
export const insertShopShippingOptionSchema = createInsertSchema(shopShippingOptions).omit({ id: true });
export type InsertShopShippingOption = z.infer<typeof insertShopShippingOptionSchema>;
export type ShopShippingOption = typeof shopShippingOptions.$inferSelect;

// kind 'percent' → value is a whole percent (10 = 10%); 'fixed' → value is cents.
export const shopDiscountCodes = pgTable("shop_discount_codes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  kind: text("kind").notNull().default("percent"),
  value: integer("value").notNull().default(0),
  active: boolean("active").notNull().default(true),
  startsAt: timestamp("starts_at"),
  endsAt: timestamp("ends_at"),
  maxUses: integer("max_uses"),
  usedCount: integer("used_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  orgCodeUnq: uniqueIndex("shop_discount_codes_org_code_unique").on(t.organizationId, t.code),
}));
export const insertShopDiscountCodeSchema = createInsertSchema(shopDiscountCodes).omit({ id: true, createdAt: true });
export type InsertShopDiscountCode = z.infer<typeof insertShopDiscountCodeSchema>;
export type ShopDiscountCode = typeof shopDiscountCodes.$inferSelect;

// Shop customisation contract (stored as jsonb on shop_order_items; the
// storefront is built against EXACTLY these shapes):
export interface ShopSponsorSlot { text?: string; logoUrl?: string } // logoUrl wins if both
export interface ShopKitCustomisation {
  teamLogo?: ShopSponsorSlot; // team crest — chest, over the heart
  frontSponsor?: ShopSponsorSlot;
  backTopSponsor?: ShopSponsorSlot;
  backBottomSponsor?: ShopSponsorSlot;
}
export interface ShopUnitPersonalisation { name?: string; number?: string } // number = 1–2 digits

// Totals are GST-INCLUSIVE; gstCents = NZ GST content = round(total * 3 / 23).
// orderToken = public status-lookup key; orderNumber = human "MFL-1001".
export const shopOrders = pgTable("shop_orders", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderNumber: text("order_number").unique(),
  orderToken: uuid("order_token").notNull().unique().default(sql`gen_random_uuid()`),
  status: text("status").notNull().default("pending"),
  // 'pending' | 'paid' | 'processing' | 'ready_for_pickup' | 'shipped' |
  // 'completed' | 'cancelled' | 'refunded'
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  shippingOptionId: integer("shipping_option_id").references(() => shopShippingOptions.id, { onDelete: "set null" }),
  shippingLabel: text("shipping_label"),
  shippingCents: integer("shipping_cents").notNull().default(0),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  suburb: text("suburb"),
  city: text("city"),
  postcode: text("postcode"),
  subtotalCents: integer("subtotal_cents").notNull().default(0),
  discountCents: integer("discount_cents").notNull().default(0),
  discountCode: text("discount_code"),
  gstCents: integer("gst_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull().default(0),
  currency: text("currency").notNull().default("NZD"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  contactId: integer("contact_id").references(() => contacts.id),
  source: text("source").notNull().default("online"),   // POS-ready
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  utmTerm: text("utm_term"),
  fbclid: text("fbclid"),
  gclid: text("gclid"),
  visitorId: text("visitor_id"),
  notes: text("notes"),
  // Player Pay (group payment): 'standard' | 'player_pay'. player_pay orders
  // start as status='awaiting_players' and flip to 'paid' (all_paid_at set)
  // when the LAST shop_order_shares row is paid.
  paymentMode: text("payment_mode").notNull().default("standard"),
  teamName: text("team_name"),
  allPaidAt: timestamp("all_paid_at"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export const insertShopOrderSchema = createInsertSchema(shopOrders).omit({ id: true, orderToken: true, createdAt: true, updatedAt: true });
export type InsertShopOrder = z.infer<typeof insertShopOrderSchema>;
export type ShopOrder = typeof shopOrders.$inferSelect;

// Line items snapshot everything at purchase time so history never drifts.
export const shopOrderItems = pgTable("shop_order_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer("order_id").notNull().references(() => shopOrders.id, { onDelete: "cascade" }),
  productId: integer("product_id").references(() => shopProducts.id, { onDelete: "set null" }),
  variantId: integer("variant_id").references(() => shopVariants.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  colourName: text("colour_name"),
  size: text("size"),
  imageUrl: text("image_url"),
  unitCents: integer("unit_cents").notNull().default(0),
  qty: integer("qty").notNull().default(1),
  lineCents: integer("line_cents").notNull().default(0),
  costUsdSnapshot: decimal("cost_usd_snapshot", { precision: 10, scale: 2 }),
  // Kit customisation (sponsor slots) + per-shirt personalisation. When units
  // is present its length === qty. Personalisation is included in the price
  // ($0 — no price impact).
  customisation: jsonb("customisation").$type<ShopKitCustomisation | null>(),
  units: jsonb("units").$type<ShopUnitPersonalisation[] | null>(),
});
export const insertShopOrderItemSchema = createInsertSchema(shopOrderItems).omit({ id: true });
export type InsertShopOrderItem = z.infer<typeof insertShopOrderItemSchema>;
export type ShopOrderItem = typeof shopOrderItems.$inferSelect;

// Player Pay — one row per player on a payment_mode='player_pay' order.
// shareToken is the public pay-link key; amounts sum EXACTLY to the order
// total (shipping split evenly, remainder cents on the last share).
export const shopOrderShares = pgTable("shop_order_shares", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer("order_id").notNull().references(() => shopOrders.id, { onDelete: "cascade" }),
  playerName: text("player_name").notNull(),
  playerEmail: text("player_email").notNull(),
  playerPhone: text("player_phone"),
  size: text("size").notNull(),
  shirtName: text("shirt_name"),
  shirtNumber: text("shirt_number"),
  amountCents: integer("amount_cents").notNull(),
  shareToken: uuid("share_token").notNull().unique().default(sql`gen_random_uuid()`),
  status: text("status").notNull().default("pending"), // 'pending' | 'paid'
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type InsertShopOrderShare = typeof shopOrderShares.$inferInsert;
export type ShopOrderShare = typeof shopOrderShares.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════
// CIC Media Library — staff (Max) upload photos/videos and organise them by
// team + custom categories ("like our Google Drive"). Feeds a public catalog
// API (/api/public/media/:brand/*) a future storefront will read. Greenfield —
// first brand is CIC (org 5), multi-brand ready like the shop module.
//
// Storage: originals live PRIVATE (clubos-media bucket, storage_key); once a
// gallery/asset is published, a watermarked preview + thumb are generated into
// the PUBLIC clubos-media-previews bucket (preview_key / thumb_key). The
// public API only ever returns preview/thumb URLs — never storage_key, never
// player_name (internal-only, e.g. matching a face to a shirt for staff).
// ═══════════════════════════════════════════════════════════════════════════

export const mediaCategories = pgTable("media_categories", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  orgSlugUnq: uniqueIndex("media_categories_org_slug_unique").on(t.organizationId, t.slug),
}));
export const insertMediaCategorySchema = createInsertSchema(mediaCategories).omit({ id: true, createdAt: true });
export type InsertMediaCategory = z.infer<typeof insertMediaCategorySchema>;
export type MediaCategory = typeof mediaCategories.$inferSelect;

// A shoot/collection — usually one per team per day, but can be a custom
// grouping too. tournamentId/teamId are set when created "from a team" via the
// picker; ageGroup/clubName are denormalised snapshots so the gallery still
// reads sensibly even if the team is later renamed or removed.
export const mediaGalleries = pgTable("media_galleries", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").references(() => tournaments.id, { onDelete: "set null" }),
  teamId: integer("team_id").references(() => tournamentTeams.id, { onDelete: "set null" }),
  ageGroup: text("age_group"),
  clubName: text("club_name"),
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  // FK to media_assets added via ALTER TABLE in the migration (media_assets is
  // created after this table) — plain int here, same precedent as
  // clubLogoConsents.clubId above.
  coverAssetId: integer("cover_asset_id"),
  shootDate: date("shoot_date"),
  status: text("status").notNull().default("draft"), // 'draft' | 'published' | 'hidden'
  assetCount: integer("asset_count").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  orgSlugUnq: uniqueIndex("media_galleries_org_slug_unique").on(t.organizationId, t.slug),
}));
export const insertMediaGallerySchema = createInsertSchema(mediaGalleries).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMediaGallery = z.infer<typeof insertMediaGallerySchema>;
export type MediaGallery = typeof mediaGalleries.$inferSelect;

// One row per uploaded file. kind='video' skips the sharp preview pipeline
// (previewKey/thumbKey stay null — video thumbnails are a later phase).
// bibNumber is public-safe (storefront search-by-bib); playerName is
// INTERNAL ONLY and must never appear in a /api/public/media response.
export const mediaAssets = pgTable("media_assets", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  galleryId: integer("gallery_id").references(() => mediaGalleries.id, { onDelete: "set null" }),
  categoryId: integer("category_id").references(() => mediaCategories.id, { onDelete: "set null" }),
  teamId: integer("team_id").references(() => tournamentTeams.id, { onDelete: "set null" }),
  kind: text("kind").notNull().default("photo"), // 'photo' | 'video'
  storageKey: text("storage_key").notNull(),      // PRIVATE original (clubos-media bucket)
  previewKey: text("preview_key"),                // watermarked preview, PUBLIC (clubos-media-previews)
  thumbKey: text("thumb_key"),                    // small thumb, PUBLIC (clubos-media-previews)
  originalFilename: text("original_filename"),
  contentType: text("content_type"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  width: integer("width"),
  height: integer("height"),
  durationSec: integer("duration_sec"),
  bibNumber: integer("bib_number"),
  playerName: text("player_name"), // INTERNAL ONLY — never returned by the public API
  takenAt: timestamp("taken_at", { withTimezone: true }),
  priceCents: integer("price_cents"),
  status: text("status").notNull().default("draft"), // 'draft' | 'published'
  sortOrder: integer("sort_order").notNull().default(0),
  uploadedBy: integer("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertMediaAssetSchema = createInsertSchema(mediaAssets).omit({ id: true, createdAt: true });
export type InsertMediaAsset = z.infer<typeof insertMediaAssetSchema>;
export type MediaAsset = typeof mediaAssets.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════
// Warehouse (WMS) — United Prints workspace. One physical warehouse at United
// Sports Centre shared by four brands' sellable merch (MFL + CIC on our own
// commerce engine, SIU + CUFC on two Shopify stores), United Prints raw
// materials, club equipment (loan/return) and event stock.
//
// Truth model (SPEC.md §4.1, D1/D2): `wh_movements` is an APPEND-ONLY signed
// ledger — no UPDATE/DELETE code paths, ever. `wh_stock` is a same-transaction
// cache (never the source of truth); `available` is DERIVED (on_hand minus
// active reservations) and is NEVER a stored column anywhere in this schema.
// Enum-ish text columns (kind, status, movement_type, reason_code…) carry NO
// DB CHECK constraints — validated in shared/warehouse.ts instead (a stale
// CHECK once 500'd the MFL checkout). The one true invariant, `delta <> 0` on
// wh_movements, IS a DB CHECK — see migrations/2026-07-13_warehouse.sql.
//
// Not org-scoped (like feature_requests above) — this is a single shared
// warehouse, not a per-workspace list; brand ownership lives on `brand_owner`
// instead. Access is gated by requireTab("warehouse") in the routes layer.
//
// None of the `insertWhXSchema` exports below call `.omit(...)` — verified
// (isolated repro) that `createInsertSchema(t).omit({...})` throws a spurious
// tsc TS2322 "boolean is not assignable to never" on ANY table whose `id` uses
// `.generatedAlwaysAsIdentity()` (a drizzle-zod 0.7 / zod 3.24 inference bug,
// already the majority of shared/schema.ts's 154 pre-existing baseline
// errors). Dropping `.omit()` is behaviourally identical here — every field it
// would have omitted (id, createdAt, updatedAt, processedAt) already carries
// a DB default, so drizzle-zod already infers it optional on insert.
// ═══════════════════════════════════════════════════════════════════════════

// Bins, named zones (RECEIVING/PACK/DISPATCH/QUARANTINE) and virtual
// locations (SUPPLIER/CUSTOMER/SCRAP/PRODUCTION) so every movement always has
// a real from/to story (D8). `code` validated by isValidLocationCode() /
// normalised by normaliseLocationCode() in shared/warehouse.ts.
export const whLocations = pgTable("wh_locations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: text("code").notNull().unique(),          // e.g. 'A-01-2', 'QUARANTINE', 'SUPPLIER'
  // What a human calls this place — "United Sports Centre Warehouse" for
  // USC-WAREHOUSE. Nullable: the code is still the identity (it's what a label
  // encodes and a scanner reads), and every location that pre-dates this column
  // has no name and must keep showing its code. Never used for lookup.
  name: text("name"),
  zone: text("zone"),                             // first segment of a bin code, or the named zone itself
  // LocationKind: 'bin' | 'zone' | 'virtual' | 'person' | 'vehicle'. The last
  // two are D20 — "issued to Riley" and "in the van" are locations, not a
  // free-text assigned_to field that drifts out of sync with the ledger.
  kind: text("kind").notNull().default("bin"),
  // D20 — a bin within a zone, a shelf within a vehicle. SET NULL on delete:
  // removing a parent orphans its children rather than cascading a delete
  // through locations that still hold real stock.
  parentLocationId: integer("parent_location_id").references((): any => whLocations.id, { onDelete: "set null" }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertWhLocationSchema = createInsertSchema(whLocations); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhLocation = z.infer<typeof insertWhLocationSchema>;
export type WhLocation = typeof whLocations.$inferSelect;

// Everything stocked: sellable merch + uniforms, print-shop materials, club
// equipment, event stock. Identical physical products owned by different
// brands are DIFFERENT items (D4) — brand_owner is part of the item's
// identity, never a pooled row. Channel mappings are nullable + partial-unique
// so an item can be unmapped, native-mapped, or Shopify-mapped.
export const whItems = pgTable("wh_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  sku: text("sku").notNull().unique(),            // BRAND-CAT-STYLE-COLOUR-SIZE (D7) — shared/warehouse.ts isValidSku
  name: text("name").notNull(),
  kind: text("kind").notNull().default("merch"),  // ItemKind: 'merch' | 'material' | 'equipment' | 'event'
  // D18 — 'stock' (counted in bulk, wh_stock) | 'asset' (owned one-by-one,
  // wh_item_instances). Fixed at creation and enforced in the PATCH route:
  // flipping it changes which child table holds the item's physical reality,
  // so it is a deliberate data migration, never a UI toggle.
  trackingMode: text("tracking_mode").notNull().default("stock"),
  brandOwner: text("brand_owner").notNull().default("club"), // BrandOwner: 'cufc'|'siu'|'mfl'|'cic'|'up'|'club'
  // The extensible leaf of the hierarchy — and the key wh_field_templates
  // hangs custom fields off (D23).
  category: text("category"),
  unit: text("unit").notNull().default("ea"),     // Unit: 'ea' | 'm' | 'roll' | 'box'
  purchaseUnit: text("purchase_unit"),            // Unit the supplier sells in, e.g. 'roll'
  purchaseQty: numeric("purchase_qty", { precision: 12, scale: 3 }), // e.g. 1 roll = 50 m
  allowNegative: boolean("allow_negative").notNull().default(false), // D16 — bulk materials where paperwork lags
  isLoanable: boolean("is_loanable").notNull().default(false),
  minQty: numeric("min_qty", { precision: 12, scale: 3 }), // reorder alert threshold
  costCents: integer("cost_cents"),                // reference only, NZD cents
  defaultLocationId: integer("default_location_id").references(() => whLocations.id, { onDelete: "set null" }),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  // Native ClubOS commerce mapping (MFL/CIC) — D11.
  shopVariantId: integer("shop_variant_id").references(() => shopVariants.id, { onDelete: "set null" }),
  // Shopify mapping (SIU/CUFC) — D9.
  shopifyStore: text("shopify_store"),             // 'siu' | 'cufc'
  shopifyInventoryItemId: text("shopify_inventory_item_id"),
  shopifyVariantId: text("shopify_variant_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  shopVariantUnq: uniqueIndex("wh_items_shop_variant_unique")
    .on(t.shopVariantId)
    .where(sql`${t.shopVariantId} IS NOT NULL`),
  shopifyMappingUnq: uniqueIndex("wh_items_shopify_mapping_unique")
    .on(t.shopifyStore, t.shopifyVariantId)
    .where(sql`${t.shopifyVariantId} IS NOT NULL`),
}));
export const insertWhItemSchema = createInsertSchema(whItems); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhItem = z.infer<typeof insertWhItemSchema>;
export type WhItem = typeof whItems.$inferSelect;

// Manufacturer EANs / any scanned code that isn't the item's own SKU — looked
// up verbatim (never reshaped, D5). packQty lets one scan of a multipack alias
// post a multi-unit movement (e.g. a case barcode = 12 eaches).
export const whBarcodeAliases = pgTable("wh_barcode_aliases", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: text("code").notNull().unique(),
  itemId: integer("item_id").notNull().references(() => whItems.id, { onDelete: "cascade" }),
  packQty: numeric("pack_qty", { precision: 12, scale: 3 }).notNull().default("1"),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertWhBarcodeAliasSchema = createInsertSchema(whBarcodeAliases); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhBarcodeAlias = z.infer<typeof insertWhBarcodeAliasSchema>;
export type WhBarcodeAlias = typeof whBarcodeAliases.$inferSelect;

// T12/§4.3 — SIU sibling-variant fan-out. A single wh_item (one physical
// blank shirt) is sold as 3 SEPARATE Shopify variants of the same size
// (Plain/Player/Custom printing) that must all move together — whItems'
// OWN shopify_variant_id/shopify_inventory_item_id columns hold the item's
// PRIMARY mapping (unchanged, still what T4/T8's existing code reads); this
// table holds the EXTRA sibling variant(s) that receive the identical
// `available` on every push and must also resolve back to the same item on
// an inbound order/refund webhook line. Unique on (store, shopify_variant_id)
// — a given Shopify variant belongs to exactly one wh_item, never two.
export const whShopifyVariantLinks = pgTable("wh_shopify_variant_links", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  itemId: integer("item_id").notNull().references(() => whItems.id, { onDelete: "cascade" }),
  store: text("store").notNull(),                 // 'siu' | 'cufc' — must match the item's own shopify_store
  shopifyVariantId: text("shopify_variant_id").notNull(),
  shopifyInventoryItemId: text("shopify_inventory_item_id").notNull(),
  note: text("note"),                             // e.g. 'Player printing'
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  storeVariantUnq: uniqueIndex("wh_shopify_variant_links_store_variant_unique").on(t.store, t.shopifyVariantId),
}));
export const insertWhShopifyVariantLinkSchema = createInsertSchema(whShopifyVariantLinks); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhShopifyVariantLink = z.infer<typeof insertWhShopifyVariantLinkSchema>;
export type WhShopifyVariantLink = typeof whShopifyVariantLinks.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════
// Warehouse v2 (D18–D25, migrations/2026-07-27_warehouse_v2.sql) — asset
// tracking and self-service custom fields.
// ═══════════════════════════════════════════════════════════════════════════

// D19 — ONE physical unit of an asset item (a heat press, a desk, a laptop):
// the things the club owns one-by-one rather than counts in bulk. Its
// movements ride the SAME wh_movements ledger with instance_id set and a
// delta of ±1, so the audit trail is never split in two.
//
// D20 — there is deliberately no `assigned_to` free-text column. Where a thing
// is, including "issued to Riley" and "in the van", is `locationId` pointing
// at a 'person'/'vehicle' location. Lending to an outside party is wh_loans.
export const whItemInstances = pgTable("wh_item_instances", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  // RESTRICT, never CASCADE — deleting an item definition must not silently
  // erase the history of the physical objects bought under it.
  itemId: integer("item_id").notNull().references(() => whItems.id, { onDelete: "restrict" }),
  // Our own printed, scannable label. Distinct from serialNumber, which is the
  // manufacturer's and may be missing, duplicated across brands, or worn off.
  assetTag: text("asset_tag"),
  serialNumber: text("serial_number"),
  locationId: integer("location_id").notNull().references(() => whLocations.id, { onDelete: "restrict" }),
  // InstanceCondition: 'new' | 'working' | 'damaged' | 'decommissioned'.
  // 'decommissioned' IS retirement and keeps its whole ledger — retire, never
  // delete (the Vehicles-tab doctrine). Validated in shared/warehouse.ts.
  condition: text("condition").notNull().default("working"),
  purchaseDate: date("purchase_date"),
  warrantyUntil: date("warranty_until"),
  costCents: integer("cost_cents"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  assetTagUnq: uniqueIndex("wh_item_instances_asset_tag_unique")
    .on(t.assetTag)
    .where(sql`${t.assetTag} IS NOT NULL`),
  itemSerialUnq: uniqueIndex("wh_item_instances_item_serial_unique")
    .on(t.itemId, t.serialNumber)
    .where(sql`${t.serialNumber} IS NOT NULL`),
}));
export const insertWhItemInstanceSchema = createInsertSchema(whItemInstances); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhItemInstance = z.infer<typeof insertWhItemInstanceSchema>;
export type WhItemInstance = typeof whItemInstances.$inferSelect;

// D23 — admin-editable schema-in-data. Adding, reordering or removing a field
// here changes what renders on the item card, with NO schema migration and no
// developer. Keyed on wh_items.category (our extensible leaf).
export const whFieldTemplates = pgTable("wh_field_templates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  // D26 — null for a CUSTOM field (stored in wh_item_fields, as before); set
  // to a CoreFieldKey ('sku', 'name', 'barcodes'…) when the row is instead a
  // placement of a built-in control, whose value goes to its own column.
  coreField: text("core_field"),
  // D26 — null shows on both stock and asset forms; 'stock'/'asset' scopes it.
  trackingMode: text("tracking_mode"),
  // Nullable since D26: a core-field placement belongs to the whole form, not
  // to one category. Still required in practice for custom fields.
  category: text("category"),
  fieldKey: text("field_key").notNull(),          // slugified from label, stable once created
  label: text("label").notNull(),
  fieldType: text("field_type").notNull().default("text"), // FieldType — validated in shared/warehouse.ts
  options: jsonb("options").$type<string[] | null>(),      // for 'select'
  required: boolean("required").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  helpText: text("help_text"),
  // D22 — does this describe the DEFINITION ('item', e.g. "vinyl width") or
  // one physical unit ('instance', e.g. "WOF expiry")?
  appliesTo: text("applies_to").notNull().default("item"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  categoryKeyUnq: uniqueIndex("wh_field_templates_category_key_unique")
    .on(t.category, t.fieldKey)
    .where(sql`${t.coreField} IS NULL`),
}));
export const insertWhFieldTemplateSchema = createInsertSchema(whFieldTemplates); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhFieldTemplate = z.infer<typeof insertWhFieldTemplateSchema>;
export type WhFieldTemplate = typeof whFieldTemplates.$inferSelect;

// D22/D24 — the values, in TYPED columns so "every WOF expiring this month" is
// an indexed date comparison in Postgres, not a string sort in JavaScript.
// Exactly one of itemId/instanceId is set (a DB CHECK in the migration — a
// structural invariant, unlike the enum-ish columns which are validated
// app-side).
export const whItemFields = pgTable("wh_item_fields", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  itemId: integer("item_id").references(() => whItems.id, { onDelete: "cascade" }),
  instanceId: integer("instance_id").references(() => whItemInstances.id, { onDelete: "cascade" }),
  fieldKey: text("field_key").notNull(),
  valueText: text("value_text"),
  valueNumber: numeric("value_number", { precision: 14, scale: 4 }),
  valueDate: date("value_date"),
  valueBoolean: boolean("value_boolean"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  itemKeyUnq: uniqueIndex("wh_item_fields_item_key_unique")
    .on(t.itemId, t.fieldKey)
    .where(sql`${t.itemId} IS NOT NULL`),
  instanceKeyUnq: uniqueIndex("wh_item_fields_instance_key_unique")
    .on(t.instanceId, t.fieldKey)
    .where(sql`${t.instanceId} IS NOT NULL`),
}));
export const insertWhItemFieldSchema = createInsertSchema(whItemFields); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhItemField = z.infer<typeof insertWhItemFieldSchema>;
export type WhItemField = typeof whItemFields.$inferSelect;

// THE LEDGER (D1). Append-only — no UPDATE/DELETE code paths, ever; stock
// corrections are new adjustment movements. `groupId` links every leg of one
// multi-leg operation (a transfer is a -row at the source + a +row at the
// destination sharing one groupId — see legsSumToZero() in shared/warehouse.ts).
// `delta <> 0` is a true invariant enforced by a DB CHECK in the migration
// (everything else here is validated app-side, never by a DB CHECK/enum).
export const whMovements = pgTable("wh_movements", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  groupId: uuid("group_id").notNull().default(sql`gen_random_uuid()`),
  itemId: integer("item_id").notNull().references(() => whItems.id, { onDelete: "restrict" }),
  // D19 — set only for an asset item's movement, where delta is always ±1.
  // ONE ledger for stock and assets: wh_stock.on_hand for an asset item at a
  // location is therefore just the count of instances standing there, and
  // every existing stock/dashboard/reconcile query keeps working untouched.
  instanceId: integer("instance_id").references((): any => whItemInstances.id, { onDelete: "restrict" }),
  locationId: integer("location_id").notNull().references(() => whLocations.id, { onDelete: "restrict" }),
  delta: numeric("delta", { precision: 12, scale: 3 }).notNull(), // signed; CHECK (delta <> 0) in the migration
  movementType: text("movement_type").notNull(),  // MovementType (D15) — validated in shared/warehouse.ts
  reasonCode: text("reason_code"),                // ReasonCode (D15) — validated in shared/warehouse.ts
  refKind: text("ref_kind"),                      // RefKind — polymorphic reference (shop_order, po, requisition…)
  // bigint, not integer (T12 fix) — a Shopify order id ('shopify_order' ref)
  // routinely exceeds Postgres int4's ~2.1bn ceiling; every OTHER ref_kind
  // uses one of our own serial ids (po/requisition/loan/count line ids, or
  // shop_orders.id), which fit comfortably either way. mode:'number' keeps
  // the TS type identical to plain integer (JS numbers are exact up to 2^53,
  // matching this file's own client_ts/size_bytes bigint columns) — zero
  // downstream change needed in any already-committed T3/T5/T6/T8/T9/T10/T11 code.
  refId: bigint("ref_id", { mode: "number" }),
  operatorUserId: integer("operator_user_id").notNull().references(() => users.id), // D17 — named operator, always
  note: text("note"),
  idempotencyKey: text("idempotency_key").unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const insertWhMovementSchema = createInsertSchema(whMovements); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhMovement = z.infer<typeof insertWhMovementSchema>;
export type WhMovement = typeof whMovements.$inferSelect;

// Cache only (D1/D2) — maintained in the SAME transaction as the ledger insert
// via an atomic non-negative-guarded upsert (server/warehouse.ts
// postMovementGroup). Nightly reconcile asserts on_hand == Σ ledger deltas and
// repairs + alerts on any drift (a repair means a code path bypassed the engine).
export const whStock = pgTable("wh_stock", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  itemId: integer("item_id").notNull().references(() => whItems.id, { onDelete: "cascade" }),
  locationId: integer("location_id").notNull().references(() => whLocations.id, { onDelete: "cascade" }),
  onHand: numeric("on_hand", { precision: 12, scale: 3 }).notNull().default("0"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  itemLocationUnq: uniqueIndex("wh_stock_item_location_unique").on(t.itemId, t.locationId),
}));
export const insertWhStockSchema = createInsertSchema(whStock); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhStock = z.infer<typeof insertWhStockSchema>;
export type WhStock = typeof whStock.$inferSelect;

// Hard reservations (D3) for every paid-but-unfulfilled order (native +
// Shopify) — physical truth stays true: the shirt is on the shelf until it's
// picked. `available(item) = Σ on_hand(sellable bins) − Σ active reservations`
// — computed in queries, never stored. Partial-unique so at most one ACTIVE
// reservation exists per (ref, item); released/consumed rows are history.
export const whReservations = pgTable("wh_reservations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  itemId: integer("item_id").notNull().references(() => whItems.id, { onDelete: "restrict" }),
  qty: numeric("qty", { precision: 12, scale: 3 }).notNull(),
  refKind: text("ref_kind").notNull(),             // RefKind — shop_order | shopify_order | requisition | …
  refId: bigint("ref_id", { mode: "number" }).notNull(), // bigint — see whMovements.refId's comment (T12)
  status: text("status").notNull().default("active"), // ReservationStatus: 'active' | 'released' | 'consumed'
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  activeRefItemUnq: uniqueIndex("wh_reservations_active_ref_item_unique")
    .on(t.refKind, t.refId, t.itemId)
    .where(sql`${t.status} = 'active'`),
}));
export const insertWhReservationSchema = createInsertSchema(whReservations); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhReservation = z.infer<typeof insertWhReservationSchema>;
export type WhReservation = typeof whReservations.$inferSelect;

// Purchase orders. `qty_received` is DERIVED from receipt movements
// referencing a po_line (ref_kind='po', ref_id=line id) — never a stored column.
export const whPurchaseOrders = pgTable("wh_purchase_orders", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  supplierName: text("supplier_name").notNull(),
  status: text("status").notNull().default("draft"), // PoStatus (D15/§4.1)
  expectedOn: date("expected_on"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export const insertWhPurchaseOrderSchema = createInsertSchema(whPurchaseOrders); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhPurchaseOrder = z.infer<typeof insertWhPurchaseOrderSchema>;
export type WhPurchaseOrder = typeof whPurchaseOrders.$inferSelect;

export const whPoLines = pgTable("wh_po_lines", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  poId: integer("po_id").notNull().references(() => whPurchaseOrders.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => whItems.id, { onDelete: "restrict" }),
  qtyOrdered: numeric("qty_ordered", { precision: 12, scale: 3 }).notNull(),
  unitCostCents: integer("unit_cost_cents"),
  notes: text("notes"),
});
export const insertWhPoLineSchema = createInsertSchema(whPoLines); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhPoLine = z.infer<typeof insertWhPoLineSchema>;
export type WhPoLine = typeof whPoLines.$inferSelect;

// Requisitions (D13) — any staff submits (requireAuth, like the Feedback
// board above), operators approve/pick/ready/collect. chargeTo drives the
// monthly chargeback report (suggested values: CUFC/SIU/MFL/CIC/USC/Academy/Office
// — free text, Daniel names the real list at seed time).
export const whRequisitions = pgTable("wh_requisitions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  requestedBy: integer("requested_by").notNull().references(() => users.id),
  chargeTo: text("charge_to").notNull(),
  status: text("status").notNull().default("submitted"), // RequisitionStatus (D15/§4.1)
  neededBy: date("needed_by"),
  approvedBy: integer("approved_by").references(() => users.id, { onDelete: "set null" }),
  collectedAt: timestamp("collected_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export const insertWhRequisitionSchema = createInsertSchema(whRequisitions); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhRequisition = z.infer<typeof insertWhRequisitionSchema>;
export type WhRequisition = typeof whRequisitions.$inferSelect;

export const whRequisitionLines = pgTable("wh_requisition_lines", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  requisitionId: integer("requisition_id").notNull().references(() => whRequisitions.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => whItems.id, { onDelete: "restrict" }),
  qtyRequested: numeric("qty_requested", { precision: 12, scale: 3 }).notNull(),
  qtyPicked: numeric("qty_picked", { precision: 12, scale: 3 }),
});
export const insertWhRequisitionLineSchema = createInsertSchema(whRequisitionLines); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhRequisitionLine = z.infer<typeof insertWhRequisitionLineSchema>;
export type WhRequisitionLine = typeof whRequisitionLines.$inferSelect;

// Equipment loans (D14) — library/tool-crib model. `overdue` is DERIVED
// (dueOn < nzTodayIso() AND status='out') — never a stored column; see
// isLoanOverdue() in shared/warehouse.ts. borrowerContactId is nullable —
// coaches may lack a ClubOS login, so a free-text borrowerName always works.
export const whLoans = pgTable("wh_loans", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  borrowerName: text("borrower_name").notNull(),
  borrowerContactId: integer("borrower_contact_id").references(() => contacts.id, { onDelete: "set null" }),
  dueOn: date("due_on").notNull(),
  status: text("status").notNull().default("out"), // LoanStatus: 'out' | 'returned'
  operatorUserId: integer("operator_user_id").notNull().references(() => users.id), // D17 — named at checkout
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  returnedAt: timestamp("returned_at"),
});
export const insertWhLoanSchema = createInsertSchema(whLoans); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhLoan = z.infer<typeof insertWhLoanSchema>;
export type WhLoan = typeof whLoans.$inferSelect;

// conditionGrade/conditionNote/replacementChargedCents are set on return only.
export const whLoanLines = pgTable("wh_loan_lines", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  loanId: integer("loan_id").notNull().references(() => whLoans.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => whItems.id, { onDelete: "restrict" }),
  qty: numeric("qty", { precision: 12, scale: 3 }).notNull(),
  conditionGrade: text("condition_grade"),        // ConditionGrade: 'A' | 'B' | 'C' | 'D' — set on return
  conditionNote: text("condition_note"),
  replacementChargedCents: integer("replacement_charged_cents"),
});
export const insertWhLoanLineSchema = createInsertSchema(whLoanLines); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhLoanLine = z.infer<typeof insertWhLoanLineSchema>;
export type WhLoanLine = typeof whLoanLines.$inferSelect;

// Cycle counts (D12) — blind by default (counter never sees expected_qty;
// snapshotted server-side and hidden from the counter UI). counted_by <>
// approved_by is enforced app-side (shared/warehouse.ts), never a DB CHECK
// (both are the same users FK, so a same-column CHECK can't express it anyway).
export const whCounts = pgTable("wh_counts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  scopeZone: text("scope_zone"),                  // free-text scope, e.g. a zone code
  scopeClass: text("scope_class"),                // ABC cadence class this session covers, if class-scoped
  blind: boolean("blind").notNull().default(true),
  countedBy: integer("counted_by").references(() => users.id, { onDelete: "set null" }),
  approvedBy: integer("approved_by").references(() => users.id, { onDelete: "set null" }),
  status: text("status").notNull().default("open"), // CountStatus: 'open' | 'submitted' | 'approved'
  createdAt: timestamp("created_at").defaultNow().notNull(),
  submittedAt: timestamp("submitted_at"),
  approvedAt: timestamp("approved_at"),
});
export const insertWhCountSchema = createInsertSchema(whCounts); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhCount = z.infer<typeof insertWhCountSchema>;
export type WhCount = typeof whCounts.$inferSelect;

// expectedQty is the snapshot taken when the session opens — never sent to
// the counter's UI (blind). Approval posts an adjustment movement group for
// every line whose resolution is 'accepted' with a variance.
export const whCountLines = pgTable("wh_count_lines", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  countId: integer("count_id").notNull().references(() => whCounts.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => whItems.id, { onDelete: "restrict" }),
  locationId: integer("location_id").notNull().references(() => whLocations.id, { onDelete: "restrict" }),
  expectedQty: numeric("expected_qty", { precision: 12, scale: 3 }).notNull(),
  countedQty: numeric("counted_qty", { precision: 12, scale: 3 }),
  resolution: text("resolution"),                 // CountLineResolution: 'accepted' | 'recount'
}, (t) => ({
  countItemLocationUnq: uniqueIndex("wh_count_lines_count_item_location_unique").on(t.countId, t.itemId, t.locationId),
}));
export const insertWhCountLineSchema = createInsertSchema(whCountLines); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhCountLine = z.infer<typeof insertWhCountLineSchema>;
export type WhCountLine = typeof whCountLines.$inferSelect;

// Webhook dedupe (D9) — Shopify can and does redeliver. Unique on the
// provider's own webhook id, never our own generated key.
export const whShopifyEvents = pgTable("wh_shopify_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  webhookId: text("webhook_id").notNull().unique(),
  topic: text("topic").notNull(),
  store: text("store").notNull(),                 // 'siu' | 'cufc'
  processedAt: timestamp("processed_at").defaultNow().notNull(),
});
export const insertWhShopifyEventSchema = createInsertSchema(whShopifyEvents); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhShopifyEvent = z.infer<typeof insertWhShopifyEventSchema>;
export type WhShopifyEvent = typeof whShopifyEvents.$inferSelect;

// Per mapped item x store push state — echo suppression + drift detection
// (D9) + the sync dashboard's data. One row per (item, store).
export const whSyncState = pgTable("wh_sync_state", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  itemId: integer("item_id").notNull().references(() => whItems.id, { onDelete: "cascade" }),
  store: text("store").notNull(),                 // 'siu' | 'cufc' | 'native'
  lastPushedQty: numeric("last_pushed_qty", { precision: 12, scale: 3 }),
  lastPushedAt: timestamp("last_pushed_at"),
  pending: boolean("pending").notNull().default(false),
  lastDriftAt: timestamp("last_drift_at"),
  driftNote: text("drift_note"),
}, (t) => ({
  itemStoreUnq: uniqueIndex("wh_sync_state_item_store_unique").on(t.itemId, t.store),
}));
export const insertWhSyncStateSchema = createInsertSchema(whSyncState); // no .omit() — see note above whLocations (drizzle-zod omit() bug w/ generatedAlwaysAsIdentity)
export type InsertWhSyncState = z.infer<typeof insertWhSyncStateSchema>;
export type WhSyncState = typeof whSyncState.$inferSelect;

// ── Hiring — job postings + applications ─────────────────────────────────────
// The careers engine behind every brand site's job adverts. A job is owned by
// the workspace that MANAGES it (organizationId — USG hires for the group) and
// advertised under a public `brand` key (cufc, mfl, cic…), which is what the
// brand site's form posts to. So one Hiring tab can run recruitment for every
// brand without each brand needing its own workspace tab.
//
// NOT the Volunteers module: a volunteer signs up once and is rostered onto
// task-types by day; an applicant applies to one posting and moves through a
// selection pipeline for it. See shared/hiring.ts.
//
// Named hiring_* because bare `jobs` already means print-production jobs and
// bare `applications` already means grant + Football Institute applications.
export const hiringJobs = pgTable("hiring_jobs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  brand: text("brand").notNull(),                          // public brand key — cufc | mfl | cic | cugc | unitedprints | siu
  slug: text("slug").notNull(),                            // url-safe, unique within a brand
  title: text("title").notNull(),
  tagline: text("tagline"),
  description: text("description"),                        // optional long copy (the advert can also live on the brand site)
  employmentType: text("employment_type"),                 // "Paid casual — one fixture", "Part-time", "Volunteer"…
  positions: integer("positions").notNull().default(1),
  payLabel: text("pay_label"),                             // free text — "$50 per commentator". Never a number: pay is not always money.
  location: text("location"),
  status: text("status").notNull().default("draft"),       // draft | open | closed  (validated app-side, no pg enum)
  closesAt: timestamp("closes_at", { withTimezone: true }),
  advertUrl: text("advert_url"),                           // where the public advert lives
  notifyEmail: text("notify_email"),                       // who gets pinged on a new application
  // [{ id, label, type, required?, help?, placeholder?, options?, minLength?, maxLength?, accept?, maxBytes? }]
  questions: jsonb("questions").$type<HiringQuestion[]>().notNull().default(sql`'[]'::jsonb`),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  brandSlugUnq: uniqueIndex("hiring_jobs_brand_slug_unq").on(t.brand, t.slug),
  orgIdx: index("hiring_jobs_org_idx").on(t.organizationId, t.createdAt),
}));

export const hiringApplications = pgTable("hiring_applications", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  jobId: integer("job_id").notNull().references(() => hiringJobs.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  email: text("email").notNull(),
  phone: text("phone").notNull(),                          // phone is mandatory on every form we run
  dateOfBirth: date("date_of_birth"),
  city: text("city"),

  // Under-16s need a parent/guardian. `guardianRequired` is decided SERVER-side
  // from the date of birth — never trusted from the browser.
  guardianRequired: boolean("guardian_required").notNull().default(false),
  guardianName: text("guardian_name"),
  guardianRelationship: text("guardian_relationship"),
  guardianEmail: text("guardian_email"),
  guardianPhone: text("guardian_phone"),
  guardianConsent: boolean("guardian_consent").notNull().default(false),

  // Answers to the job's custom questions, keyed by question id.
  answers: jsonb("answers").$type<Record<string, string | boolean>>().notNull().default(sql`'{}'::jsonb`),

  // The audition: a pasted link, or a file in object storage, or both.
  // auditionObjectPath is "/objects/uploads/<uuid>.<ext>" — private, and only
  // ever streamed back through the tab-gated admin endpoint.
  auditionUrl: text("audition_url"),
  auditionObjectPath: text("audition_object_path"),
  auditionFilename: text("audition_filename"),
  auditionMime: text("audition_mime"),
  auditionBytes: integer("audition_bytes"),

  status: text("status").notNull().default("new"),         // new | reviewing | shortlisted | trial | offered | hired | declined | withdrawn
  rating: integer("rating"),                               // 1–5, reviewer's score
  reviewerNotes: text("reviewer_notes"),
  reviewedBy: integer("reviewed_by").references(() => users.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),

  consentContact: boolean("consent_contact").notNull().default(false),
  consentBroadcast: boolean("consent_broadcast").notNull().default(false),
  rightToWork: boolean("right_to_work").notNull().default(false),

  sourceUrl: text("source_url"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  jobIdx: index("hiring_applications_job_idx").on(t.jobId, t.createdAt),
  orgIdx: index("hiring_applications_org_idx").on(t.organizationId, t.createdAt),
  // One application per email per job. A second attempt is a friendly 409, not a duplicate row.
  jobEmailUnq: uniqueIndex("hiring_applications_job_email_unq").on(t.jobId, t.email),
}));

export const insertHiringJobSchema = createInsertSchema(hiringJobs).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertHiringJob = z.infer<typeof insertHiringJobSchema>;
export type HiringJob = typeof hiringJobs.$inferSelect;

export const insertHiringApplicationSchema = createInsertSchema(hiringApplications).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertHiringApplication = z.infer<typeof insertHiringApplicationSchema>;
export type HiringApplication = typeof hiringApplications.$inferSelect;

// ── USG Invoices — tracked, payable invoices (United Sports Group, org 7) ────
// The public payable page (apps/invoices, a separate Vercel app) calls
// /api/public/invoices/:token* here; ClubOS is the system of record. Named
// usg_* (not bare `invoices`) to dodge this schema's documented naming-
// collision history — see the hiring_* comment above for the same reasoning.
//
// Deliberately NO 'overdue' status: overdue is DERIVED at read time from
// dueOn (see shared/invoice-types.ts deriveInvoiceStatus) — a stored
// "overdue" goes stale the moment a scheduled job doesn't run, and pushing a
// due date out would need its own reversal logic. status is one of
// draft | sent | paid | void, validated in the app — no pg enum (this schema
// has documented enum drift in prod; do NOT reuse the orphaned
// invoiceStatusEnum above, which has a DIFFERENT vocabulary and is unused).
//
// token is the public identifier — unguessable (an invoice carries bank
// details, so it must never be enumerable). id/organizationId never leave
// the admin surface; the public GET response is hand-shaped in
// server/invoice-routes.ts, never `res.json(row)`.
export const usgInvoices = pgTable("usg_invoices", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  token: text("token").notNull().unique(),
  number: text("number").notNull().unique(),
  status: text("status").notNull().default("draft"),        // draft | sent | paid | void

  brand: text("brand").notNull().default("siu"),             // siu | cufc — see SUPPLIER_BY_BRAND

  recipientName: text("recipient_name").notNull(),
  recipientEmail: text("recipient_email"),
  recipientAddress: jsonb("recipient_address").$type<string[]>(),

  title: text("title").notNull(),
  intro: text("intro"),

  spendSummary: jsonb("spend_summary").$type<InvoiceSpendSummary>(),
  lines: jsonb("lines").$type<InvoiceLine[]>().notNull(),
  notes: jsonb("notes").$type<string[]>(),

  gstTreatment: text("gst_treatment").notNull().default("inclusive"), // inclusive | exclusive

  // Server-computed from lines + gstTreatment on every create/update — NEVER
  // trusted from the client. See shared/invoice-money.ts.
  subtotalCents: integer("subtotal_cents").notNull(),
  gstCents: integer("gst_cents").notNull(),
  totalCents: integer("total_cents").notNull(),

  issuedOn: date("issued_on").notNull(),
  dueOn: date("due_on").notNull(),
  termsLabel: text("terms_label"),

  cardEnabled: boolean("card_enabled").notNull().default(false),

  isDraft: boolean("is_draft").notNull().default(true),
  draftReasons: jsonb("draft_reasons").$type<string[]>(),

  bankAccountName: text("bank_account_name"),
  bankAccountNumber: text("bank_account_number"),
  bankReference: text("bank_reference"),
  bankParticulars: text("bank_particulars"),
  bankCode: text("bank_code"),

  paidAt: timestamp("paid_at"),
  paidMethod: text("paid_method"),                            // card | bank
  paidAmountCents: integer("paid_amount_cents"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  tokenUnq: uniqueIndex("usg_invoices_token_unq").on(t.token),
  orgStatusIdx: index("usg_invoices_org_status_idx").on(t.organizationId, t.status),
}));

// Append-only audit/tracking log behind the admin timeline (created → sent →
// opened ×N → reminder_sent → paid/voided). Same shape as the Proposal
// Tracker's proposal_events.
export const usgInvoiceEvents = pgTable("usg_invoice_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  invoiceId: integer("invoice_id").notNull().references(() => usgInvoices.id, { onDelete: "cascade" }),

  kind: text("kind").notNull(),                               // opened | sent | reminder_sent | paid | voided | created
  at: timestamp("at").defaultNow().notNull(),

  ipHash: text("ip_hash"),                                    // sha256(ip + salt) — never the raw IP
  userAgent: text("user_agent"),
  referrer: text("referrer"),
  isStaff: boolean("is_staff").notNull().default(false),      // our own opens don't pollute the count
  meta: jsonb("meta"),
}, (t) => ({
  invoiceAtIdx: index("usg_invoice_events_invoice_at_idx").on(t.invoiceId, t.at),
}));

export const insertUsgInvoiceSchema = createInsertSchema(usgInvoices).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUsgInvoice = z.infer<typeof insertUsgInvoiceSchema>;
export type UsgInvoice = typeof usgInvoices.$inferSelect;

export const insertUsgInvoiceEventSchema = createInsertSchema(usgInvoiceEvents).omit({ id: true, at: true });
export type InsertUsgInvoiceEvent = z.infer<typeof insertUsgInvoiceEventSchema>;
export type UsgInvoiceEvent = typeof usgInvoiceEvents.$inferSelect;
// ─────────────────────────────────────────────────────────────────────────────
// FLEET — company vehicles (USG workspace, super-admin only).
//
// Prefixed `fleet_` for the same reason Hiring took `hiring_jobs`: bare
// `assignments`, `costs` and `service_records` are names a future feature will
// want, and bare `vehicles` reads like it could be anything.
//
// Derived, never stored: compliance status (expired / due soon) is computed
// from the dates on read by `vehicleCompliance()` in shared/vehicles.ts. A
// stored `is_expired` flag is only true until the day nobody runs the job —
// the same rule the invoice pages follow for `overdue`.
//
// Retire, never delete: a vehicle is `disposed` and an assignment gets a
// `returned_on`. Who was driving the van in March is a question the club will
// eventually need to answer — an insurance claim, a speeding ticket, an FBT
// review — and a DELETE destroys the only record of it.
// ─────────────────────────────────────────────────────────────────────────────

export const fleetVehicles = pgTable("fleet_vehicles", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  // Identity
  plate: text("plate").notNull(),                       // NZ registration plate, stored upper-cased
  make: text("make").notNull(),
  model: text("model").notNull(),
  variant: text("variant"),
  year: integer("year"),
  colour: text("colour"),
  vin: text("vin"),
  engineNumber: text("engine_number"),
  vehicleType: text("vehicle_type").notNull().default("car"),   // car|van|minibus|ute|truck|trailer|other (validated app-side, no pg enum)
  fuelType: text("fuel_type").notNull().default("petrol"),      // petrol|diesel|hybrid|plug_in_hybrid|electric|lpg|other
  transmission: text("transmission"),
  seats: integer("seats"),

  // An odometer reading is a fact about a moment, not a property of the vehicle,
  // so the reading carries the date it was taken. RUC status is untrustworthy
  // without it.
  odometerKm: integer("odometer_km"),
  odometerAt: date("odometer_at"),

  // Compliance. A vehicle carries a WOF or a COF, never both.
  complianceType: text("compliance_type").notNull().default("wof"), // wof|cof
  wofExpiresOn: date("wof_expires_on"),
  cofExpiresOn: date("cof_expires_on"),
  regoExpiresOn: date("rego_expires_on"),

  // RUC expires at an odometer reading, not a date. `ruc_required` is seeded
  // from fuel type but a human owns it — the rules change and we are not NZTA.
  rucRequired: boolean("ruc_required").notNull().default(false),
  rucValidToKm: integer("ruc_valid_to_km"),

  // Ownership
  ownership: text("ownership").notNull().default("owned"),       // owned|leased|financed
  lessor: text("lessor"),
  leaseEndsOn: date("lease_ends_on"),
  leaseMonthlyCents: integer("lease_monthly_cents"),
  purchasedOn: date("purchased_on"),
  purchasePriceCents: integer("purchase_price_cents"),
  supplier: text("supplier"),
  disposedOn: date("disposed_on"),
  disposalPriceCents: integer("disposal_price_cents"),

  status: text("status").notNull().default("active"),            // active|in_workshop|off_road|disposed

  // Servicing — the NEXT due is set by a human (you can know a van is due in
  // October before you've ever logged a service), and updated when one is logged.
  nextServiceDueOn: date("next_service_due_on"),
  nextServiceDueKm: integer("next_service_due_km"),

  // FBT. In NZ a vehicle *available* for private use attracts Fringe Benefit
  // Tax — availability, not use, is the test. We record the position; the
  // accountant rules on it.
  fbtPrivateUse: boolean("fbt_private_use").notNull().default(false),
  fbtExemption: text("fbt_exemption").notNull().default("none"), // none|work_related_vehicle|emergency_call|other
  fbtNotes: text("fbt_notes"),

  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // A plate is unique in New Zealand, but it can be transferred off a disposed
  // vehicle onto a new one — so the uniqueness is among LIVE vehicles only.
  // That partial index can't be expressed here; it lives in the migration.
  orgStatusIdx: index("fleet_vehicles_org_status_idx").on(t.organizationId, t.status),
  orgPlateIdx: index("fleet_vehicles_org_plate_idx").on(t.organizationId, t.plate),
}));
export const insertFleetVehicleSchema = createInsertSchema(fleetVehicles).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFleetVehicle = z.infer<typeof insertFleetVehicleSchema>;
export type FleetVehicle = typeof fleetVehicles.$inferSelect;

/** Who has the vehicle, and who had it. `holder_user_id` links a ClubOS login
 *  where one exists, but `holder_name` is the authority — part-time coaches and
 *  contractors drive club vans without ever having an account. */
export const fleetAssignments = pgTable("fleet_assignments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  vehicleId: integer("vehicle_id").notNull().references(() => fleetVehicles.id, { onDelete: "cascade" }),

  holderUserId: integer("holder_user_id").references(() => users.id, { onDelete: "set null" }),
  holderName: text("holder_name").notNull(),
  holderEmail: text("holder_email"),
  holderPhone: text("holder_phone"),
  licenceClass: text("licence_class"),
  licenceExpiresOn: date("licence_expires_on"),

  assignedOn: date("assigned_on").notNull(),
  returnedOn: date("returned_on"),                     // NULL = they still have it
  odometerStartKm: integer("odometer_start_km"),
  odometerEndKm: integer("odometer_end_km"),

  purpose: text("purpose"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // One OPEN assignment per vehicle is enforced by a partial unique index in
  // the migration — two people cannot hold the same van at once, and the
  // database says so rather than the application hoping so.
  vehicleIdx: index("fleet_assignments_vehicle_idx").on(t.vehicleId, t.assignedOn),
  orgIdx: index("fleet_assignments_org_idx").on(t.organizationId),
}));
export const insertFleetAssignmentSchema = createInsertSchema(fleetAssignments).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFleetAssignment = z.infer<typeof insertFleetAssignmentSchema>;
export type FleetAssignment = typeof fleetAssignments.$inferSelect;

/** One row per vehicle per policy period. A fleet-wide policy is simply the
 *  same `policy_number` across several vehicles — which keeps the "is this van
 *  insured today" query a single indexed lookup instead of a union. */
export const fleetInsurancePolicies = pgTable("fleet_insurance_policies", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  vehicleId: integer("vehicle_id").notNull().references(() => fleetVehicles.id, { onDelete: "cascade" }),

  insurer: text("insurer").notNull(),
  policyNumber: text("policy_number").notNull(),
  coverType: text("cover_type").notNull().default("comprehensive"), // comprehensive|third_party_fire_theft|third_party|mechanical_breakdown|other
  startsOn: date("starts_on").notNull(),
  expiresOn: date("expires_on").notNull(),
  excessCents: integer("excess_cents"),
  premiumCents: integer("premium_cents"),
  agreedValueCents: integer("agreed_value_cents"),
  contactName: text("contact_name"),
  contactPhone: text("contact_phone"),

  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  vehicleExpiryIdx: index("fleet_insurance_vehicle_expiry_idx").on(t.vehicleId, t.expiresOn),
  orgIdx: index("fleet_insurance_org_idx").on(t.organizationId),
}));
export const insertFleetInsurancePolicySchema = createInsertSchema(fleetInsurancePolicies).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFleetInsurancePolicy = z.infer<typeof insertFleetInsurancePolicySchema>;
export type FleetInsurancePolicy = typeof fleetInsurancePolicies.$inferSelect;

export const fleetServiceRecords = pgTable("fleet_service_records", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  vehicleId: integer("vehicle_id").notNull().references(() => fleetVehicles.id, { onDelete: "cascade" }),

  servicedOn: date("serviced_on").notNull(),
  serviceType: text("service_type").notNull().default("service"), // service|repair|wof_check|cof_check|tyres|recall|other
  provider: text("provider"),
  odometerKm: integer("odometer_km"),
  description: text("description"),
  costCents: integer("cost_cents"),
  invoiceRef: text("invoice_ref"),
  nextServiceDueOn: date("next_service_due_on"),
  nextServiceDueKm: integer("next_service_due_km"),

  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  vehicleIdx: index("fleet_service_vehicle_idx").on(t.vehicleId, t.servicedOn),
  orgIdx: index("fleet_service_org_idx").on(t.organizationId),
}));
export const insertFleetServiceRecordSchema = createInsertSchema(fleetServiceRecords).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFleetServiceRecord = z.infer<typeof insertFleetServiceRecordSchema>;
export type FleetServiceRecord = typeof fleetServiceRecords.$inferSelect;

/** Running costs. `amount_cents` is GST-inclusive, as it appears on the docket —
 *  the coding of GST is Xero's job, not this tab's. Litres is a real number
 *  (never money), so it can be a float without the cents discipline. */
export const fleetCosts = pgTable("fleet_costs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  vehicleId: integer("vehicle_id").notNull().references(() => fleetVehicles.id, { onDelete: "cascade" }),

  incurredOn: date("incurred_on").notNull(),
  category: text("category").notNull(),                 // fuel|ruc|rego|wof|cof|insurance|service|repair|tyres|cleaning|fine|toll|parking|lease|other
  amountCents: integer("amount_cents").notNull(),
  supplier: text("supplier"),
  reference: text("reference"),
  odometerKm: integer("odometer_km"),
  litres: doublePrecision("litres"),                    // fuel only; enables c/km and L/100km

  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  vehicleIdx: index("fleet_costs_vehicle_idx").on(t.vehicleId, t.incurredOn),
  orgCategoryIdx: index("fleet_costs_org_category_idx").on(t.organizationId, t.category),
}));
export const insertFleetCostSchema = createInsertSchema(fleetCosts).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFleetCost = z.infer<typeof insertFleetCostSchema>;
export type FleetCost = typeof fleetCosts.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// HOUSING — residency houses, rooms, tenants, rent and utilities (USC, org 4).
//
// See migrations/2026-07-10_usc_housing.sql for the reasoning. Two things are
// deliberately absent as columns because they are DERIVED on read:
//   * a charge's `overdue` state  (paid_on IS NULL AND due_on < today-in-NZ)
//   * a room's occupancy          (does it have an active tenancy today?)
// Kinds/frequencies are validated TEXT (shared/housing.ts), never pg enums.
// ─────────────────────────────────────────────────────────────────────────────

export const housingHouses = pgTable("housing_houses", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  address: text("address"),
  notes: text("notes"),
  // Archive, never delete — a house with tenancy history is a financial record.
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  orgIdx: index("housing_houses_org_idx").on(t.organizationId),
}));

export const housingRooms = pgTable("housing_rooms", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  houseId: integer("house_id").notNull().references(() => housingHouses.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  roomType: text("room_type").notNull().default("single"),
  // The room's ASKING rent. The tenancy carries the rent actually agreed, so a
  // later price rise never rewrites what a sitting tenant owes.
  defaultRentCents: integer("default_rent_cents").notNull().default(0),
  defaultRentFrequency: text("default_rent_frequency").notNull().default("weekly"),
  notes: text("notes"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  houseIdx: index("housing_rooms_house_idx").on(t.houseId),
  orgIdx: index("housing_rooms_org_idx").on(t.organizationId),
}));

export const housingTenancies = pgTable("housing_tenancies", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  roomId: integer("room_id").notNull().references(() => housingRooms.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  // RESTRICT: deleting a person must never silently erase the rent they owed.
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  rentCents: integer("rent_cents").notNull().default(0),
  rentFrequency: text("rent_frequency").notNull().default("weekly"),
  startDate: date("start_date").notNull(),
  /** NULL = ongoing. INCLUSIVE — the tenant's last night. */
  endDate: date("end_date"),
  bondCents: integer("bond_cents").notNull().default(0),
  bondReturnedOn: date("bond_returned_on"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  roomIdx: index("housing_tenancies_room_idx").on(t.roomId),
  contactIdx: index("housing_tenancies_contact_idx").on(t.contactId),
  orgIdx: index("housing_tenancies_org_idx").on(t.organizationId),
  // NB: the real guarantee is the `housing_tenancies_no_overlap` EXCLUDE
  // constraint in the migration — drizzle cannot express it, so it is not here.
}));

export const housingRentCharges = pgTable("housing_rent_charges", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  tenancyId: integer("tenancy_id").notNull().references(() => housingTenancies.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  /** Rent in advance: the first day of the period it covers. */
  dueOn: date("due_on").notNull(),
  amountCents: integer("amount_cents").notNull(),
  paidOn: date("paid_on"),
  paidAmountCents: integer("paid_amount_cents"),
  method: text("method"),
  reference: text("reference"),
  waived: boolean("waived").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // Makes re-running the charge generator idempotent instead of double-charging.
  tenancyDueUnq: uniqueIndex("housing_rent_charges_tenancy_due_unq").on(t.tenancyId, t.dueOn),
  orgDueIdx: index("housing_rent_charges_org_due_idx").on(t.organizationId, t.dueOn),
}));

export const housingUtilityAccounts = pgTable("housing_utility_accounts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  houseId: integer("house_id").notNull().references(() => housingHouses.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),                 // power | internet | water | gas | rates | insurance | waste | other
  provider: text("provider"),
  accountNumber: text("account_number"),
  billingFrequency: text("billing_frequency").notNull().default("monthly"),
  /** A budgeting hint only — never what actually gets paid. */
  expectedAmountCents: integer("expected_amount_cents").notNull().default(0),
  notes: text("notes"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  houseIdx: index("housing_utility_accounts_house_idx").on(t.houseId),
  orgIdx: index("housing_utility_accounts_org_idx").on(t.organizationId),
}));

export const housingUtilityBills = pgTable("housing_utility_bills", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  utilityAccountId: integer("utility_account_id").notNull().references(() => housingUtilityAccounts.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  periodLabel: text("period_label"),
  dueOn: date("due_on").notNull(),
  amountCents: integer("amount_cents").notNull(),
  paidOn: date("paid_on"),
  paidAmountCents: integer("paid_amount_cents"),
  method: text("method"),
  reference: text("reference"),
  waived: boolean("waived").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  accountIdx: index("housing_utility_bills_account_idx").on(t.utilityAccountId),
  orgDueIdx: index("housing_utility_bills_org_due_idx").on(t.organizationId, t.dueOn),
}));

export type HousingHouse = typeof housingHouses.$inferSelect;
export type HousingRoom = typeof housingRooms.$inferSelect;
export type HousingTenancy = typeof housingTenancies.$inferSelect;
export type HousingRentCharge = typeof housingRentCharges.$inferSelect;
export type HousingUtilityAccount = typeof housingUtilityAccounts.$inferSelect;
export type HousingUtilityBill = typeof housingUtilityBills.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// MAINTENANCE — cleaning/consumable supplies + machines & equipment (USC, org 4).
//
// See migrations/2026-07-21_usc_maintenance.sql for the reasoning. Two things
// are deliberately absent as columns because they are DERIVED on read:
//   * a supply's stock status    (out / low / no_level / ok — qty vs reorder level)
//   * a machine's service status (overdue / due_soon / unknown / ok — vs today)
// Categories/statuses/reasons/kinds are validated TEXT (shared/maintenance.ts),
// never pg enums.
// ─────────────────────────────────────────────────────────────────────────────

export const maintSupplies = pgTable("maint_supplies", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category").notNull().default("other"),
  unit: text("unit"),
  qtyOnHand: integer("qty_on_hand").notNull().default(0),
  reorderLevel: integer("reorder_level"),
  location: text("location"),
  supplier: text("supplier"),
  // A reference unit cost, not a purchasing ledger.
  costCents: integer("cost_cents"),
  notes: text("notes"),
  // Archive, never delete — a supply with movement history keeps its trail.
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  orgIdx: index("maint_supplies_org_idx").on(t.organizationId),
}));

export const maintStockMovements = pgTable("maint_stock_movements", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  supplyId: integer("supply_id").notNull().references(() => maintSupplies.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  delta: integer("delta").notNull(),          // +received / -used
  reason: text("reason").notNull(),           // received|used|adjusted|stocktake
  note: text("note"),
  recordedBy: text("recorded_by"),            // staff email/name from session
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  supplyIdx: index("maint_stock_movements_supply_idx").on(t.supplyId),
  orgIdx: index("maint_stock_movements_org_idx").on(t.organizationId),
}));

export const maintAssets = pgTable("maint_assets", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category").notNull().default("other"),  // mower|tractor|trailer|power_tool|appliance|other
  make: text("make"),
  model: text("model"),
  serial: text("serial"),
  location: text("location"),
  purchaseDate: date("purchase_date"),
  purchaseCostCents: integer("purchase_cost_cents"),
  lastServicedOn: date("last_serviced_on"),
  nextServiceDueOn: date("next_service_due_on"),
  // Archive, never delete — a retired asset keeps its service history.
  status: text("status").notNull().default("active"),     // active|retired
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  orgIdx: index("maint_assets_org_idx").on(t.organizationId),
}));

export const maintServiceRecords = pgTable("maint_service_records", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  assetId: integer("asset_id").notNull().references(() => maintAssets.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  servicedOn: date("serviced_on").notNull(),
  kind: text("kind").notNull().default("service"),         // service|repair|inspection
  performedBy: text("performed_by"),
  costCents: integer("cost_cents"),
  nextDueOn: date("next_due_on"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  assetIdx: index("maint_service_records_asset_idx").on(t.assetId),
  orgIdx: index("maint_service_records_org_idx").on(t.organizationId),
}));

export type MaintSupply = typeof maintSupplies.$inferSelect;
export type MaintStockMovement = typeof maintStockMovements.$inferSelect;
export type MaintAsset = typeof maintAssets.$inferSelect;
export type MaintServiceRecord = typeof maintServiceRecords.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// MANAGEMENT — the planning workspace behind the "Management" tab (first home:
// United Prints, org 8; org-scoped and generic by design). Projects →
// per-project workflow statuses → tasks (+ checklists, finish-to-start
// dependencies for the Gantt, comments). Migration
// migrations/2026-07-22_up_management.sql; vocab/derivation in
// shared/management.ts. Overdue is DERIVED (due < today-NZ and not in a
// done-kind status), never stored; completed_at is stamped server-side when a
// task enters a done-kind column. Vocab columns are validated TEXT, never
// pg enums / CHECK gates.
// ─────────────────────────────────────────────────────────────────────────────

export const planProjects = pgTable("plan_projects", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color").notNull().default("#6366f1"),
  status: text("status").notNull().default("active"), // active|completed|archived
  startDate: date("start_date"),
  targetDate: date("target_date"),
  sortOrder: integer("sort_order").notNull().default(0),
  // What any tab-holder gets when not an explicit collaborator:
  // none|viewer|commenter|editor|admin. 'admin' = pre-collaborators behavior.
  defaultRole: text("default_role").notNull().default("admin"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  orgIdx: index("plan_projects_org_idx").on(t.organizationId),
}));

export const planCollaborators = pgTable("plan_collaborators", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: integer("project_id").notNull().references(() => planProjects.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull(),
  role: text("role").notNull().default("editor"), // viewer|commenter|editor|admin
  addedBy: integer("added_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectIdx: index("plan_collaborators_project_idx").on(t.projectId),
  userIdx: index("plan_collaborators_user_idx").on(t.userId),
  orgIdx: index("plan_collaborators_org_idx").on(t.organizationId),
  uq: unique("plan_collaborators_uq").on(t.projectId, t.userId),
}));

export type PlanCollaborator = typeof planCollaborators.$inferSelect;

export const planStatuses = pgTable("plan_statuses", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: integer("project_id").notNull().references(() => planProjects.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  color: text("color").notNull().default("#64748b"),
  kind: text("kind").notNull().default("todo"), // todo|active|done
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectIdx: index("plan_statuses_project_idx").on(t.projectId),
  orgIdx: index("plan_statuses_org_idx").on(t.organizationId),
}));

export const planTasks = pgTable("plan_tasks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: integer("project_id").notNull().references(() => planProjects.id, { onDelete: "cascade" }),
  statusId: integer("status_id").notNull().references(() => planStatuses.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  description: text("description"),
  priority: text("priority").notNull().default("medium"), // low|medium|high|urgent
  assigneeId: integer("assignee_id"),
  startDate: date("start_date"),
  dueDate: date("due_date"),
  milestone: boolean("milestone").notNull().default(false),
  progress: integer("progress"), // manual owner estimate 0–100; checklist shows done/total instead
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  sortOrder: integer("sort_order").notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  archived: boolean("archived").notNull().default(false),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectIdx: index("plan_tasks_project_idx").on(t.projectId),
  orgIdx: index("plan_tasks_org_idx").on(t.organizationId),
  statusIdx: index("plan_tasks_status_idx").on(t.statusId),
  assigneeIdx: index("plan_tasks_assignee_idx").on(t.assigneeId),
}));

export const planTaskDeps = pgTable("plan_task_deps", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  predecessorId: integer("predecessor_id").notNull().references(() => planTasks.id, { onDelete: "cascade" }),
  successorId: integer("successor_id").notNull().references(() => planTasks.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  succIdx: index("plan_task_deps_succ_idx").on(t.successorId),
  orgIdx: index("plan_task_deps_org_idx").on(t.organizationId),
  edgeUq: unique("plan_task_deps_edge_uq").on(t.predecessorId, t.successorId),
}));

export const planChecklistItems = pgTable("plan_checklist_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  taskId: integer("task_id").notNull().references(() => planTasks.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  done: boolean("done").notNull().default(false),
  assigneeId: integer("assignee_id"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  taskIdx: index("plan_checklist_task_idx").on(t.taskId),
  orgIdx: index("plan_checklist_org_idx").on(t.organizationId),
}));

export const planComments = pgTable("plan_comments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  taskId: integer("task_id").notNull().references(() => planTasks.id, { onDelete: "cascade" }),
  authorId: integer("author_id"),
  authorName: text("author_name"), // denormalized snapshot (recordedBy doctrine)
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  taskIdx: index("plan_comments_task_idx").on(t.taskId),
  orgIdx: index("plan_comments_org_idx").on(t.organizationId),
}));

export type PlanProject = typeof planProjects.$inferSelect;
export type PlanStatus = typeof planStatuses.$inferSelect;
export type PlanTask = typeof planTasks.$inferSelect;
export type PlanTaskDep = typeof planTaskDeps.$inferSelect;
export type PlanChecklistItem = typeof planChecklistItems.$inferSelect;
export type PlanComment = typeof planComments.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// SALES — United Print prospect database + sales pipeline (prints workspace).
//
// A prospect is a researched company that could buy what United Print sells
// (merch, trophies/medals, banners/signage, design). Rows arrive from the
// grounded research fleet (evidence_url + fetched_at on every row — provenance
// is the product, same rule as market_research_snapshots) or by hand.
//
// The pipeline stage lives on the prospect and only moves through the server's
// moveStage(), which always writes a sales_activities trail and promotes a won
// deal into print_contacts (the CRM tab) exactly once. Stage/tier/region are
// validated app-side in shared/sales.ts — deliberately NO DB CHECK, a stale
// CHECK is how the MFL checkout 500'd. "Follow-up due" is DERIVED from
// next_follow_up_on vs today, never stored.
// ─────────────────────────────────────────────────────────────────────────────

export const salesProspects = pgTable("sales_prospects", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  name: text("name").notNull(),
  website: text("website"),
  city: text("city"),
  region: text("region"),
  category: text("category"),
  subcategory: text("subcategory"),
  whyFit: text("why_fit"),
  servicesMatch: jsonb("services_match"),

  contactName: text("contact_name"),
  contactRole: text("contact_role"),
  email: text("email"),
  phone: text("phone"),

  evidenceUrl: text("evidence_url"),
  fetchedAt: date("fetched_at"),
  linkStatus: text("link_status"),

  fitScore: integer("fit_score"),
  volumeScore: integer("volume_score"),
  accessScore: integer("access_score"),
  localityScore: integer("locality_score"),
  totalScore: integer("total_score"),
  tier: text("tier"),
  rank: integer("rank"),

  source: text("source").notNull().default("manual"),
  stage: text("stage").notNull().default("new"),
  stageChangedAt: timestamp("stage_changed_at", { withTimezone: true }),
  nextFollowUpOn: date("next_follow_up_on"),
  declinedReason: text("declined_reason"),
  dealValueCents: integer("deal_value_cents"),
  promotedContactId: integer("promoted_contact_id").references(() => printContacts.id, { onDelete: "set null" }),

  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  orgStageIdx: index("sales_prospects_org_stage_idx").on(t.organizationId, t.stage),
  orgTierIdx: index("sales_prospects_org_tier_idx").on(t.organizationId, t.tier),
  orgFollowupIdx: index("sales_prospects_org_followup_idx").on(t.organizationId, t.nextFollowUpOn),
  orgScoreIdx: index("sales_prospects_org_score_idx").on(t.organizationId, t.totalScore),
  // The dedupe unique index (organization_id, lower(website)) WHERE website IS
  // NOT NULL lives in the SQL migration only — drizzle can't express lower().
}));

export const salesActivities = pgTable("sales_activities", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  prospectId: integer("prospect_id").notNull().references(() => salesProspects.id, { onDelete: "cascade" }),

  type: text("type").notNull(),
  outcome: text("outcome"),
  note: text("note"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),

  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  prospectIdx: index("sales_activities_prospect_idx").on(t.prospectId, t.occurredAt),
  orgIdx: index("sales_activities_org_idx").on(t.organizationId, t.occurredAt),
}));

export const insertSalesProspectSchema = createInsertSchema(salesProspects).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSalesProspect = z.infer<typeof insertSalesProspectSchema>;
export type SalesProspect = typeof salesProspects.$inferSelect;
export const insertSalesActivitySchema = createInsertSchema(salesActivities).omit({ id: true, createdAt: true });
export type InsertSalesActivity = z.infer<typeof insertSalesActivitySchema>;
export type SalesActivity = typeof salesActivities.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// STAFF VIDEOS — the in-house Loom (2026-07-20). Record screen/camera in the
// browser, store on Cloudflare Stream, share at /v/{token}. `token` is the
// public share id — random and non-enumerable (invoice-pages doctrine: a video
// may show internal systems, so the set of videos must not be guessable).
// A TRIM swaps stream_uid in place so share links survive trims; the old asset
// is remembered in prev_stream_uid and deleted from Stream to free quota.
// status/visibility/source are app-validated strings — deliberately NO CHECK
// constraints (a stale CHECK is how the MFL checkout once 500'd).
// ─────────────────────────────────────────────────────────────────────────────
export const staffVideos = pgTable(
  "staff_videos",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id),
    createdBy: integer("created_by").notNull().references(() => users.id),
    token: varchar("token", { length: 24 }).notNull(),
    title: text("title").notNull().default("Untitled video"),
    description: text("description"),
    streamUid: varchar("stream_uid", { length: 64 }),
    prevStreamUid: varchar("prev_stream_uid", { length: 64 }),
    status: varchar("status", { length: 20 }).notNull().default("uploading"), // uploading | processing | ready | error
    source: varchar("source", { length: 16 }).notNull().default("recording"), // recording | upload | clip
    visibility: varchar("visibility", { length: 16 }).notNull().default("link"), // link | staff | private
    allowDownload: boolean("allow_download").notNull().default(true),
    allowComments: boolean("allow_comments").notNull().default(true),
    durationSeconds: doublePrecision("duration_seconds"),
    width: integer("width"),
    height: integer("height"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    thumbnailUrl: text("thumbnail_url"),
    playbackHlsUrl: text("playback_hls_url"),
    downloadUrl: text("download_url"),
    captionsStatus: varchar("captions_status", { length: 20 }),
    viewCount: integer("view_count").notNull().default(0),
    clippedFromId: integer("clipped_from_id"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("staff_videos_token_key").on(t.token),
    index("staff_videos_org_idx").on(t.organizationId, t.createdAt),
    index("staff_videos_owner_idx").on(t.createdBy),
  ],
);

export const staffVideoEvents = pgTable(
  "staff_video_events",
  {
    id: serial("id").primaryKey(),
    videoId: integer("video_id").notNull().references(() => staffVideos.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 16 }).notNull(), // view | play | milestone
    viewerKey: varchar("viewer_key", { length: 64 }),
    percent: integer("percent"),
    positionSeconds: doublePrecision("position_seconds"),
    isStaff: boolean("is_staff").notNull().default(false),
    device: varchar("device", { length: 16 }),
    referrer: text("referrer"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("staff_video_events_video_idx").on(t.videoId, t.kind, t.createdAt),
    index("staff_video_events_viewer_idx").on(t.videoId, t.viewerKey),
  ],
);

// Comments AND emoji reactions in one table: an emoji-only row is a reaction
// (optionally pinned to at_seconds, Loom-style); a row with body is a comment.
export const staffVideoComments = pgTable(
  "staff_video_comments",
  {
    id: serial("id").primaryKey(),
    videoId: integer("video_id").notNull().references(() => staffVideos.id, { onDelete: "cascade" }),
    authorUserId: integer("author_user_id").references(() => users.id),
    authorName: varchar("author_name", { length: 120 }),
    body: text("body"),
    emoji: varchar("emoji", { length: 16 }),
    atSeconds: doublePrecision("at_seconds"),
    isStaff: boolean("is_staff").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("staff_video_comments_video_idx").on(t.videoId, t.createdAt)],
);

export type StaffVideo = typeof staffVideos.$inferSelect;
export type StaffVideoEvent = typeof staffVideoEvents.$inferSelect;
export type StaffVideoComment = typeof staffVideoComments.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Staff Chat — the in-house Slack (replaces the WhatsApp staff groups).
//
// Distinct from chat_conversations/chat_messages (the VISITOR live-chat widget
// on the brand sites) — staff chat is staff↔staff, org-wide, universal tab.
// Design: channels + DMs, no threads; unread = a per-membership pointer
// (Campfire model), never per-message receipt rows; mentions are explicit rows
// written at send time (powers badges + away-email escalation); presence is a
// single heartbeat row per user, server-side only (no green dots).
// Pure logic in shared/staff-chat.ts. Migration 2026-07-22_staff_chat.sql.
// ─────────────────────────────────────────────────────────────────────────────

export const staffChannels = pgTable(
  "staff_channels",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind").notNull().default("channel"), // 'channel' | 'dm'
    // Channels only. Slack-style normalized ("match-day-ops"); null for DMs.
    name: text("name"),
    topic: text("topic"),
    // Private channel = invite-only, hidden from the browse list.
    isPrivate: boolean("is_private").notNull().default(false),
    // Default channels auto-join every active staff member (e.g. general,
    // announcements) — nobody has to discover them.
    isDefault: boolean("is_default").notNull().default(false),
    // 'anyone' | 'leadership' — announcements channels are leadership-post-only.
    postPolicy: text("post_policy").notNull().default("anyone"),
    // DMs only: sorted participant ids "4:17:23". Same people → same DM
    // (partial unique index in the migration).
    dmKey: text("dm_key"),
    createdBy: integer("created_by"),
    archivedAt: timestamp("archived_at"), // archive, never delete — history survives
    lastMessageAt: timestamp("last_message_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("staff_channels_kind_idx").on(t.kind, t.lastMessageAt)],
);

export const staffChannelMembers = pgTable(
  "staff_channel_members",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    channelId: integer("channel_id").notNull().references(() => staffChannels.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"), // 'owner' | 'member'
    // 'all' = email/badge on every message · 'mentions' (default — research-
    // backed quiet default) · 'muted' = badge only, never escalate.
    notifyLevel: text("notify_level").notNull().default("mentions"),
    // THE unread pointer: everything newer than this is unread. Null = never
    // opened (unread since join).
    lastReadAt: timestamp("last_read_at"),
    // Debounce for the away-email escalation (≤1 email / channel / 15 min).
    lastEmailedAt: timestamp("last_emailed_at"),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
    // Leave/retire keeps the row — history of who was in the room survives.
    leftAt: timestamp("left_at"),
  },
  (t) => [
    uniqueIndex("staff_channel_members_unq").on(t.channelId, t.userId),
    index("staff_channel_members_user_idx").on(t.userId),
  ],
);

export const staffMessages = pgTable(
  "staff_messages",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    channelId: integer("channel_id").notNull().references(() => staffChannels.id, { onDelete: "cascade" }),
    authorId: integer("author_id").notNull(),
    body: text("body").notNull().default(""),
    // [{url,name,contentType,size,kind:'image'|'voice'|'file',durationSec?}]
    attachments: jsonb("attachments").$type<StaffChatAttachment[] | null>(),
    // Client-generated id → retry-safe idempotent sends (partial unique index).
    clientMessageId: text("client_message_id"),
    // Leadership can request explicit confirmation ("Confirm you've seen this")
    // — the read-acknowledgment WhatsApp structurally can't do.
    requiresAck: boolean("requires_ack").notNull().default(false),
    editedAt: timestamp("edited_at"),
    // Soft delete: row stays (channel history + "message removed" stub), body
    // is blanked and attachments cleared at delete time.
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("staff_messages_channel_idx").on(t.channelId, t.id)],
);

// One row per person actually mentioned in a message (explicit ids from the
// composer, or fan-out of a leadership @channel). Powers the mention badge and
// the email escalation — no free-text re-parsing ever.
export const staffMessageMentions = pgTable(
  "staff_message_mentions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    messageId: integer("message_id").notNull().references(() => staffMessages.id, { onDelete: "cascade" }),
    channelId: integer("channel_id").notNull(),
    userId: integer("user_id").notNull(),
    kind: text("kind").notNull().default("user"), // 'user' | 'channel'
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("staff_message_mentions_unq").on(t.messageId, t.userId),
    index("staff_message_mentions_user_idx").on(t.userId, t.channelId, t.createdAt),
  ],
);

export const staffMessageReactions = pgTable(
  "staff_message_reactions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    messageId: integer("message_id").notNull().references(() => staffMessages.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull(),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("staff_message_reactions_unq").on(t.messageId, t.userId, t.emoji),
    index("staff_message_reactions_msg_idx").on(t.messageId),
  ],
);

// Explicit "I've seen this" confirmations on requires_ack messages.
export const staffMessageAcks = pgTable(
  "staff_message_acks",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    messageId: integer("message_id").notNull().references(() => staffMessages.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull(),
    ackedAt: timestamp("acked_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("staff_message_acks_unq").on(t.messageId, t.userId),
    index("staff_message_acks_msg_idx").on(t.messageId),
  ],
);

// One heartbeat row per user, upserted by the sync poll. Server-side ONLY —
// decides "away → escalate to email". Never rendered as a green dot.
export const staffChatPresence = pgTable("staff_chat_presence", {
  userId: integer("user_id").primaryKey(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
});

export type StaffChannel = typeof staffChannels.$inferSelect;
export type StaffChannelMember = typeof staffChannelMembers.$inferSelect;
export type StaffMessage = typeof staffMessages.$inferSelect;
export type StaffMessageMention = typeof staffMessageMentions.$inferSelect;
export type StaffMessageReaction = typeof staffMessageReactions.$inferSelect;
export type StaffMessageAck = typeof staffMessageAcks.$inferSelect;
// ═══════════════ Sporty / NZ Football NRS — outbound registration push ═══════════════
// ClubOS pushes player registrations INTO NZ Football's National Registration System
// (Sporty Football API) — the same third-party pathway Friendly Manager and Club Hub
// use. NZF approval granted 2026-07-20 (Rodrigo Stephanou); UAT keys arrive after we
// tell him development is done.
//
// Design rules:
//  · sporty_id is the NRS registration id. Sporty's docs are emphatic: once ANY
//    response — INCLUDING an error response ("Player already registered", "Overseas
//    clearance is required", "Termination required") — returns a SportyId, it must be
//    saved and sent on every later RegisterPerson for that player. A null SportyId
//    always attempts a CREATE and is rejected as a duplicate. Losing the linkage risks
//    double-registering a child with the national body, hence RESTRICT on contact
//    delete.
//  · Preflight problems (missing DOB, unmapped ethnicity…) are DERIVED at read time
//    from the contact row — only push OUTCOMES are stored state.
//  · status / block_reason / outcome are text validated app-side in shared/sporty.ts,
//    never CHECK constraints (the stale-CHECK rule).

export const sportySyncState = pgTable(
  "sporty_sync_state",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
    // 'uat' | 'prod' (shared/sporty.ts sportyEnvironmentFor). A SportyId only means
    // something in the environment that issued it, and the doctrine above sends any
    // stored id on every later push — so UAT ids must never share a row with the
    // production ones the live push reads. One state row per contact PER environment.
    // Deliberately NO database default: a writer that doesn't name its environment
    // must fail loudly rather than silently claim to be production.
    environment: text("environment").notNull(),
    // The NRS registration id — see doctrine above. Null until Sporty first returns one.
    sportyId: integer("sporty_id"),
    personFifaId: text("person_fifa_id"),
    // 'pending' | 'synced' | 'blocked' | 'error' | 'excluded' (shared/sporty.ts)
    status: text("status").notNull().default("pending"),
    // 'overseas_clearance' | 'termination_required' | 'red_flag' — set when Sporty
    // created the registration but activation needs a human process on their side.
    blockReason: text("block_reason"),
    lastError: text("last_error"),
    // Hash of the last successfully-pushed payload: unchanged data is never re-sent.
    lastPayloadHash: text("last_payload_hash"),
    lastPushedAt: timestamp("last_pushed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    // Set when staff deliberately keep a contact out of the push (test rows,
    // duplicates awaiting merge). Cleared by re-including.
    excludedReason: text("excluded_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("sporty_sync_state_contact_env_unique").on(t.contactId, t.environment),
    index("sporty_sync_state_org_status_idx").on(t.organizationId, t.status),
  ],
);

// Append-only audit of every RegisterPerson call — what was sent, what came back.
// contact_id is SET NULL so the audit survives a contact deletion; the payload
// snapshot keeps the record intelligible for NZF queries years later.
export const sportyPushLog = pgTable(
  "sporty_push_log",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    endpoint: text("endpoint").notNull(), // 'RegisterPerson' | 'fantail/RegisterPerson'
    baseUrl: text("base_url").notNull(), // which environment the call actually hit
    outcome: text("outcome").notNull(), // 'synced' | 'blocked' | 'error' (shared/sporty.ts)
    httpStatus: integer("http_status"),
    sportyId: integer("sporty_id"),
    message: text("message"),
    requestPayload: jsonb("request_payload"),
    responseBody: jsonb("response_body"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("sporty_push_log_contact_idx").on(t.contactId, t.createdAt),
    index("sporty_push_log_org_idx").on(t.organizationId, t.createdAt),
  ],
);

// Sporty reference data (countries / genders / ethnicity groups / fantail form
// options), fetched from their API and cached so mapping is validated against the
// REAL vocabulary, not our guesses. One row per kind, upserted on refresh.
export const sportyReferenceCache = pgTable(
  "sporty_reference_cache",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind").notNull(), // 'countries' | 'genders' | 'ethnicity_groups' | 'fantail_form_options'
    // Vocabularies are per-environment too: UAT's country list is not proof of
    // what production accepts, and mapping against the wrong one is how bad data
    // reaches a national register. No default, for the same reason as sync state.
    environment: text("environment").notNull(),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("sporty_reference_cache_kind_env_unique").on(t.kind, t.environment)],
);

export type SportySyncState = typeof sportySyncState.$inferSelect;
export type SportyPushLogRow = typeof sportyPushLog.$inferSelect;
export type SportyReferenceCacheRow = typeof sportyReferenceCache.$inferSelect;

// ── MFL payment reminders ────────────────────────────────────────────────────
// One row per reminder email actually SENT to a captain who is behind on a
// weekly plan (or whose instalment balance failed). Analytics — email opens
// (tracking pixel, proxy-inflated, treat as approximate) and pay-page opens
// (bot-filtered, the honest signal) — are DERIVED from the events table,
// never stored as counters. Mirrors the invoice-pages doctrine.
export const leaguePaymentReminders = pgTable("league_payment_reminders", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  registrationId: integer("registration_id").notNull().references(() => registrations.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),           // open-tracking + pay-link tag; non-enumerable
  kind: text("kind").notNull().default("weekly_missed"), // 'weekly_missed' | 'balance_failed'
  sentTo: text("sent_to").notNull(),                  // captain email at send time
  sentByUserId: integer("sent_by_user_id"),
  sentByName: text("sent_by_name"),
  missedCount: integer("missed_count").notNull().default(0),
  missedCents: integer("missed_cents").notNull().default(0),
  payoffCents: integer("payoff_cents").notNull().default(0),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
}, (t) => [
  index("league_payment_reminders_reg_idx").on(t.registrationId, t.sentAt),
]);

export const leaguePaymentReminderEvents = pgTable("league_payment_reminder_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  reminderId: integer("reminder_id").notNull().references(() => leaguePaymentReminders.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),                      // 'email_open' | 'page_open'
  userAgent: text("user_agent"),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
}, (t) => [
  index("league_payment_reminder_events_rem_idx").on(t.reminderId, t.occurredAt),
]);

export type LeaguePaymentReminder = typeof leaguePaymentReminders.$inferSelect;
export type LeaguePaymentReminderEvent = typeof leaguePaymentReminderEvents.$inferSelect;

// ═════════════════════════════════════════════════════════════════════════════
// MARKETING SUITE ("MarketingOS") — Phase A foundation.
// Additive, all tables prefixed `mkt_`. The whole suite is an event-stream DB
// with a marketing UI on top: three load-bearing tables (profiles / consent /
// events) + queries over them. See plans/2026-07-09-clubos-marketing-suite.md
// and the synthesis §(a) for the ground-truth spec.
//
// Conventions match the rest of this file: identity PKs (never composite PKs —
// natural keys are enforced with unique indexes), timestamptz timestamps, index()
// helpers. pgEnums only for genuinely closed vocab (channel / consent axes /
// suppression scope+reason / encoding / stream / flow trigger); open-ended
// status/type fields stay `text` (validated in the app) to dodge prod enum-drift.
// ═════════════════════════════════════════════════════════════════════════════

// Closed-vocab enums (safe to model as Postgres enums — these value sets are fixed).
export const mktChannelEnum = pgEnum("mkt_channel", ["email", "sms"]);
// Klaviyo subscription-state axis.
export const mktSubStateEnum = pgEnum("mkt_sub_state", ["subscribed", "unsubscribed", "never"]);
// NZ UEM Act legal-basis axis (orthogonal to sub_state — a marketing send needs BOTH).
export const mktLegalBasisEnum = pgEnum("mkt_legal_basis", ["express", "inferred", "deemed", "none", "opted_out"]);
export const mktSuppressionScopeEnum = pgEnum("mkt_suppression_scope", ["global", "brand", "category", "list"]);
export const mktSuppressionReasonEnum = pgEnum("mkt_suppression_reason", ["unsub_oneclick", "unsub_prefs", "complaint", "hard_bounce", "manual", "invalid"]);
export const mktEmailStreamEnum = pgEnum("mkt_email_stream", ["marketing", "transactional"]);
export const mktSmsEncodingEnum = pgEnum("mkt_sms_encoding", ["gsm7", "ucs2"]);
export const mktFlowTriggerTypeEnum = pgEnum("mkt_flow_trigger_type", ["event", "list", "segment", "date_property"]);

// ── mkt_profiles — the canonical marketing identity (resolves C6) ─────────────
// A workspace-scoped superset of the attribution `persons` spine. Populated by the
// idempotent ingest ETL (server/marketing/ingest.ts) from every existing audience
// table, deduped on (workspace_id, lower(email)).
export const mktProfiles = pgTable("mkt_profiles", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  workspaceId: integer("workspace_id").notNull(),
  email: text("email"),
  phoneE164: text("phone_e164"),
  externalId: text("external_id"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  // {sources:["contacts","members"], phone_raw?:"..."} — provenance + un-parseable phones.
  props: jsonb("props").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  // Forward-compat pointer to the attribution `persons` spine. NO FK — that table
  // is stranded in the loop/attribution worktree and does NOT exist in this branch.
  // Backfilled when attribution lands (D1); the suite then pivots joins gradually.
  personId: integer("person_id"),
  // Optional link to the CUFC CRM.
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // Partial-unique so many null identifiers don't collide (nulls are only "equal"
  // under a normal unique index; the WHERE excludes them entirely). Case-insensitive
  // email dedup mirrors the predictor_entrants pattern.
  emailUnq: uniqueIndex("mkt_profiles_ws_email_unq").on(t.workspaceId, sql`lower(${t.email})`).where(sql`${t.email} IS NOT NULL`),
  phoneUnq: uniqueIndex("mkt_profiles_ws_phone_unq").on(t.workspaceId, t.phoneE164).where(sql`${t.phoneE164} IS NOT NULL`),
  wsIdx: index("mkt_profiles_ws_idx").on(t.workspaceId),
  contactIdx: index("mkt_profiles_contact_idx").on(t.contactId),
}));

// ── mkt_consent — two orthogonal axes per channel (resolves C3) ───────────────
// Natural key (profile_id, channel) enforced by a unique index (identity id PK to
// match this file's convention). A marketing send requires sub_state='subscribed'
// AND an appropriate legal_basis; SMS marketing specifically requires 'express'.
export const mktConsent = pgTable("mkt_consent", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  profileId: integer("profile_id").notNull().references(() => mktProfiles.id, { onDelete: "cascade" }),
  channel: mktChannelEnum("channel").notNull(),
  subState: mktSubStateEnum("sub_state").notNull().default("never"),
  legalBasis: mktLegalBasisEnum("legal_basis").notNull().default("inferred"),
  // Convenience flag = (sub_state = 'subscribed'); the query-time gate still checks both axes.
  canReceive: boolean("can_receive").notNull().default(false),
  source: text("source"),
  methodDetail: text("method_detail"),
  doubleOptin: boolean("double_optin").notNull().default(false),
  // Privacy Act IPP1/IPP3 + UEMA s9(3) burden-of-proof: the exact wording shown.
  privacyNoticeText: text("privacy_notice_text"),
  consentShownText: text("consent_shown_text"),
  consentAt: timestamp("consent_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  profileChannelUnq: uniqueIndex("mkt_consent_profile_channel_unq").on(t.profileId, t.channel),
}));

// ── mkt_suppressions — 4-scope superset, never leaks across brands (resolves C2) ─
// Enforced as a filter join before EVERY send. `phone_e164` extends the synthesis
// spec (which only named `email`) so SMS STOP opt-outs (Phase F) share the table.
export const mktSuppressions = pgTable("mkt_suppressions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  email: text("email"),
  phoneE164: text("phone_e164"),
  channel: mktChannelEnum("channel").notNull(),
  scope: mktSuppressionScopeEnum("scope").notNull().default("global"),
  brandKey: text("brand_key"),
  category: text("category"),
  listId: integer("list_id"),
  reason: mktSuppressionReasonEnum("reason").notNull().default("manual"),
  source: text("source"),
  // Phase B: a NULL expiry = permanent. A future expiry powers "pause 30 days"
  // (preference centre) — the send gate ignores suppressions whose expires_at has
  // passed, so the profile silently resumes without a cron un-suppress.
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // NULLS NOT DISTINCT so an email-only global suppression can't be inserted twice
  // (nullable scope columns would otherwise be treated as distinct on every insert).
  // Expressed as a table UNIQUE constraint (drizzle 0.39 exposes nullsNotDistinct
  // there, not on uniqueIndex); the SQL migration mirrors it as a UNIQUE INDEX …
  // NULLS NOT DISTINCT of the same name — semantically identical.
  scopeUnq: unique("mkt_suppressions_scope_unq").on(t.email, t.phoneE164, t.channel, t.scope, t.brandKey, t.category, t.listId).nullsNotDistinct(),
  emailIdx: index("mkt_suppressions_email_idx").on(t.email, t.channel),
  phoneIdx: index("mkt_suppressions_phone_idx").on(t.phoneE164, t.channel),
}));

// ── mkt_metrics — event-type registry, auto-created on first use ──────────────
export const mktMetrics = pgTable("mkt_metrics", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  workspaceId: integer("workspace_id").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  wsNameUnq: uniqueIndex("mkt_metrics_ws_name_unq").on(t.workspaceId, t.name),
}));

// ── mkt_events — the append-only keystone stream ─────────────────────────────
// bigint id (volume). Dedup on (profile_id, metric_id, unique_id) with NULLS
// DISTINCT (default): events with no unique_id are always inserted (not idempotent),
// events carrying one are deduped.
export const mktEvents = pgTable("mkt_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  workspaceId: integer("workspace_id").notNull(),
  profileId: integer("profile_id").notNull().references(() => mktProfiles.id, { onDelete: "cascade" }),
  metricId: integer("metric_id").notNull().references(() => mktMetrics.id, { onDelete: "cascade" }),
  properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  value: decimal("value", { precision: 14, scale: 2 }),
  valueCurrency: text("value_currency"),
  uniqueId: text("unique_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  dedupeUnq: uniqueIndex("mkt_events_dedupe_unq").on(t.profileId, t.metricId, t.uniqueId),
  wsMetricIdx: index("mkt_events_ws_metric_idx").on(t.workspaceId, t.metricId, t.occurredAt),
  profileIdx: index("mkt_events_profile_idx").on(t.profileId),
}));

// ── mkt_lists / mkt_list_members — static membership ─────────────────────────
export const mktLists = pgTable("mkt_lists", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  workspaceId: integer("workspace_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  wsIdx: index("mkt_lists_ws_idx").on(t.workspaceId),
}));

export const mktListMembers = pgTable("mkt_list_members", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  listId: integer("list_id").notNull().references(() => mktLists.id, { onDelete: "cascade" }),
  profileId: integer("profile_id").notNull().references(() => mktProfiles.id, { onDelete: "cascade" }),
  source: text("source"),
  addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  listProfileUnq: uniqueIndex("mkt_list_members_list_profile_unq").on(t.listId, t.profileId),
  profileIdx: index("mkt_list_members_profile_idx").on(t.profileId),
}));

// ── mkt_segments / mkt_segment_members — dynamic, definition-driven ──────────
// definition = one boolean tree {all:[…],any:[…]} evaluated by the shared engine
// (UI capped at 2 levels / ≤100 conds). members = materialised cache.
export const mktSegments = pgTable("mkt_segments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  workspaceId: integer("workspace_id").notNull(),
  name: text("name").notNull(),
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  status: text("status").notNull().default("active"), // active | archived
  memberCount: integer("member_count").notNull().default(0),
  lastComputedAt: timestamp("last_computed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  wsIdx: index("mkt_segments_ws_idx").on(t.workspaceId),
}));

export const mktSegmentMembers = pgTable("mkt_segment_members", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  segmentId: integer("segment_id").notNull().references(() => mktSegments.id, { onDelete: "cascade" }),
  profileId: integer("profile_id").notNull().references(() => mktProfiles.id, { onDelete: "cascade" }),
  computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  segProfileUnq: uniqueIndex("mkt_segment_members_seg_profile_unq").on(t.segmentId, t.profileId),
  profileIdx: index("mkt_segment_members_profile_idx").on(t.profileId),
}));

// ── mkt_templates — reusable content; block_tree is Tiptap JSON, NEVER raw HTML ─
export const mktTemplates = pgTable("mkt_templates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  workspaceId: integer("workspace_id").notNull(),
  name: text("name").notNull(),
  channel: text("channel").notNull().default("email"), // email | sms (text: leaves room for push)
  kind: text("kind").notNull().default("template"),     // template | synced_block
  subject: text("subject"),
  blockTree: jsonb("block_tree").$type<Record<string, unknown>>(),
  isMarketing: boolean("is_marketing").notNull().default(true), // drives SMS consent gate + quiet hours
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  wsIdx: index("mkt_templates_ws_idx").on(t.workspaceId),
}));

// ── mkt_campaigns — one consolidated engine (replaces the 4 copy-paste mailers) ─
export const mktCampaigns = pgTable("mkt_campaigns", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  workspaceId: integer("workspace_id").notNull(),
  name: text("name").notNull(),
  channel: text("channel").notNull().default("email"), // email | sms
  subject: text("subject"),
  preheader: text("preheader"),
  fromName: text("from_name"),
  fromEmail: text("from_email"),
  replyTo: text("reply_to"),
  templateId: integer("template_id").references(() => mktTemplates.id, { onDelete: "set null" }),
  // Phase B: the compiled, ready-to-send email HTML. The Tiptap block tree lives on
  // the linked template (block_tree); Phase D's serializer populates this. Until then
  // the send engine reads body_html directly, so the pipeline is end-to-end today.
  bodyHtml: text("body_html"),
  // {include:[…], exclude:[…]} of list/segment refs.
  audience: jsonb("audience").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  smartSend: boolean("smart_send").notNull().default(true),
  utm: jsonb("utm").$type<Record<string, unknown>>(),
  isMarketing: boolean("is_marketing").notNull().default(true),
  status: text("status").notNull().default("draft"), // draft|scheduled|sending|sent|paused|cancelled|failed
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  recipientCount: integer("recipient_count").notNull().default(0),
  sentCount: integer("sent_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  wsStatusIdx: index("mkt_campaigns_ws_status_idx").on(t.workspaceId, t.status),
}));

// ── mkt_flows / versions / enrollments / step_runs — the automation engine ────
// live_version_id is a SOFT pointer (plain int, no FK) to sidestep the circular
// flows↔flow_versions dependency; resolved in code.
export const mktFlows = pgTable("mkt_flows", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  workspaceId: integer("workspace_id").notNull(),
  brandKey: text("brand_key"),
  name: text("name").notNull(),
  status: text("status").notNull().default("draft"), // draft|live|paused|archived
  triggerType: mktFlowTriggerTypeEnum("trigger_type").notNull(),
  triggerConfig: jsonb("trigger_config").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  entryFilter: jsonb("entry_filter").$type<Record<string, unknown>>(),
  reEntry: boolean("re_entry").notNull().default(false),
  quietHours: jsonb("quiet_hours").$type<Record<string, unknown>>().notNull().default(sql`'{"start":"20:00","end":"08:00","tz":"Pacific/Auckland"}'::jsonb`),
  // smart-send suppression window, in SECONDS (this file imports no interval type).
  smartSendWindowSeconds: integer("smart_send_window_seconds"),
  liveVersionId: integer("live_version_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  wsIdx: index("mkt_flows_ws_idx").on(t.workspaceId),
}));

export const mktFlowVersions = pgTable("mkt_flow_versions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  flowId: integer("flow_id").notNull().references(() => mktFlows.id, { onDelete: "cascade" }),
  versionNo: integer("version_no").notNull(),
  graph: jsonb("graph").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  flowVersionUnq: uniqueIndex("mkt_flow_versions_flow_version_unq").on(t.flowId, t.versionNo),
}));

export const mktFlowEnrollments = pgTable("mkt_flow_enrollments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  flowId: integer("flow_id").notNull().references(() => mktFlows.id, { onDelete: "cascade" }),
  // PINNED: an enrollment runs the immutable version it entered on.
  flowVersionId: integer("flow_version_id").notNull().references(() => mktFlowVersions.id, { onDelete: "cascade" }),
  profileId: integer("profile_id").notNull().references(() => mktProfiles.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("active"), // active|completed|exited|cancelled
  currentStepId: text("current_step_id"),
  triggerEvent: jsonb("trigger_event").$type<Record<string, unknown>>(),
  enteredAt: timestamp("entered_at", { withTimezone: true }).defaultNow().notNull(),
  exitedAt: timestamp("exited_at", { withTimezone: true }),
  exitReason: text("exit_reason"),
  // graphile-worker job_key for the next scheduled step (debounce/cancel).
  nextRunJobKey: text("next_run_job_key"),
}, (t) => ({
  flowStatusIdx: index("mkt_flow_enrollments_flow_status_idx").on(t.flowId, t.status),
  profileIdx: index("mkt_flow_enrollments_profile_idx").on(t.profileId),
}));

export const mktFlowStepRuns = pgTable("mkt_flow_step_runs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  enrollmentId: integer("enrollment_id").notNull().references(() => mktFlowEnrollments.id, { onDelete: "cascade" }),
  stepId: text("step_id").notNull(),
  status: text("status").notNull().default("pending"), // pending|scheduled|sent|skipped|failed
  channel: text("channel"),
  // Polymorphic (email OR sms message) — plain int, no FK.
  messageId: integer("message_id"),
  idempotencyKey: text("idempotency_key"),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  idemUnq: uniqueIndex("mkt_flow_step_runs_idem_unq").on(t.idempotencyKey),
  enrollmentIdx: index("mkt_flow_step_runs_enrollment_idx").on(t.enrollmentId),
}));

// ── mkt_email_messages — one row per recipient per send ──────────────────────
export const mktEmailMessages = pgTable("mkt_email_messages", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  brandKey: text("brand_key"),
  workspaceId: integer("workspace_id"),
  campaignId: integer("campaign_id").references(() => mktCampaigns.id, { onDelete: "set null" }),
  flowId: integer("flow_id").references(() => mktFlows.id, { onDelete: "set null" }),
  profileId: integer("profile_id").references(() => mktProfiles.id, { onDelete: "set null" }),
  resendEmailId: text("resend_email_id"),
  stream: mktEmailStreamEnum("stream").notNull().default("marketing"),
  toEmail: text("to_email"),
  subject: text("subject"),
  status: text("status").notNull().default("queued"), // queued|scheduled|sent|delivered|bounced|complained|failed
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  bouncedAt: timestamp("bounced_at", { withTimezone: true }),
  complainedAt: timestamp("complained_at", { withTimezone: true }),
  firstOpenedAt: timestamp("first_opened_at", { withTimezone: true }),
  firstClickedAt: timestamp("first_clicked_at", { withTimezone: true }),
  openCount: integer("open_count").notNull().default(0),
  humanOpenCount: integer("human_open_count").notNull().default(0),
  clickCount: integer("click_count").notNull().default(0),
  humanClickCount: integer("human_click_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  resendIdUnq: uniqueIndex("mkt_email_messages_resend_id_unq").on(t.resendEmailId).where(sql`${t.resendEmailId} IS NOT NULL`),
  // Phase B: idempotency for the campaign orchestrator — a re-run of `campaign:send`
  // re-inserts the same (campaign_id, profile_id) rows with ON CONFLICT DO NOTHING,
  // so nobody is double-mailed. NULLS DISTINCT (default) means flow messages
  // (campaign_id NULL) never collide, so this never blocks the flow send path.
  campaignProfileUnq: uniqueIndex("mkt_email_messages_campaign_profile_unq").on(t.campaignId, t.profileId),
  campaignIdx: index("mkt_email_messages_campaign_idx").on(t.campaignId),
  flowIdx: index("mkt_email_messages_flow_idx").on(t.flowId),
  profileIdx: index("mkt_email_messages_profile_idx").on(t.profileId),
}));

// ── mkt_email_events — raw Resend stream, append-only, idempotent on svix_id ──
export const mktEmailEvents = pgTable("mkt_email_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  svixId: text("svix_id"),
  eventType: text("event_type").notNull(),
  resendEmailId: text("resend_email_id"),
  messageId: bigint("message_id", { mode: "number" }).references(() => mktEmailMessages.id, { onDelete: "set null" }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  linkUrl: text("link_url"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  isMachine: boolean("is_machine").notNull().default(false),
  machineReason: text("machine_reason"),
  rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>(),
}, (t) => ({
  svixUnq: uniqueIndex("mkt_email_events_svix_unq").on(t.svixId).where(sql`${t.svixId} IS NOT NULL`),
  resendIdIdx: index("mkt_email_events_resend_id_idx").on(t.resendEmailId),
  messageIdx: index("mkt_email_events_message_idx").on(t.messageId),
}));

export const mktEmailLinkClicks = pgTable("mkt_email_link_clicks", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  messageId: bigint("message_id", { mode: "number" }).references(() => mktEmailMessages.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").references(() => mktCampaigns.id, { onDelete: "set null" }),
  profileId: integer("profile_id").references(() => mktProfiles.id, { onDelete: "set null" }),
  linkUrl: text("link_url"),
  isBot: boolean("is_bot").notNull().default(false),
  clickedAt: timestamp("clicked_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  campaignIdx: index("mkt_email_link_clicks_campaign_idx").on(t.campaignId),
  messageIdx: index("mkt_email_link_clicks_message_idx").on(t.messageId),
}));

// ── mkt_conversions — materialised AND recomputable (resolves M10) ────────────
export const mktConversions = pgTable("mkt_conversions", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  profileId: integer("profile_id").references(() => mktProfiles.id, { onDelete: "cascade" }),
  messageId: bigint("message_id", { mode: "number" }).references(() => mktEmailMessages.id, { onDelete: "set null" }),
  campaignId: integer("campaign_id").references(() => mktCampaigns.id, { onDelete: "set null" }),
  conversionType: text("conversion_type"),
  revenueCents: integer("revenue_cents"),
  currency: text("currency").notNull().default("NZD"),
  attributedClickAt: timestamp("attributed_click_at", { withTimezone: true }),
  convertedAt: timestamp("converted_at", { withTimezone: true }).defaultNow().notNull(),
  windowDays: integer("window_days").notNull().default(3),
  model: text("model").notNull().default("last_touch_click"),
}, (t) => ({
  profileIdx: index("mkt_conversions_profile_idx").on(t.profileId),
  campaignIdx: index("mkt_conversions_campaign_idx").on(t.campaignId),
}));

// ── SMS ──────────────────────────────────────────────────────────────────────
export const mktSmsMessages = pgTable("mkt_sms_messages", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  profileId: integer("profile_id").references(() => mktProfiles.id, { onDelete: "set null" }),
  phoneE164: text("phone_e164").notNull(),
  campaignId: integer("campaign_id").references(() => mktCampaigns.id, { onDelete: "set null" }),
  body: text("body").notNull(),
  encoding: mktSmsEncodingEnum("encoding").notNull().default("gsm7"),
  segments: integer("segments"),
  costCents: integer("cost_cents"),
  provider: text("provider"),
  providerMessageId: text("provider_message_id"),
  senderId: text("sender_id"),
  status: text("status").notNull().default("queued"), // queued|sent|delivered|failed|undelivered
  isMarketing: boolean("is_marketing").notNull().default(true),
  queuedFor: timestamp("queued_for", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  profileIdx: index("mkt_sms_messages_profile_idx").on(t.profileId),
  campaignIdx: index("mkt_sms_messages_campaign_idx").on(t.campaignId),
}));

export const mktSmsInbound = pgTable("mkt_sms_inbound", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  phoneE164: text("phone_e164").notNull(),
  body: text("body"),
  matchedKeyword: text("matched_keyword"), // STOP | HELP | START | …
  providerMessageId: text("provider_message_id"),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  phoneIdx: index("mkt_sms_inbound_phone_idx").on(t.phoneE164),
}));

// Convenience types for the ingest ETL + Phase B.
export type MktProfile = typeof mktProfiles.$inferSelect;
export type InsertMktProfile = typeof mktProfiles.$inferInsert;
export type MktConsent = typeof mktConsent.$inferSelect;
export type MktSuppression = typeof mktSuppressions.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// TASK TRACKER (`tt_*`) — the organisation-wide project & task system.
//
// 🔴 DELIBERATELY NOT ORG-SCOPED, unlike every other planning table here. This
// is ONE shared dataset for the whole organisation, reached from every
// workspace's sidebar (the Chat / Feedback universal pattern). Brand is a TAG
// (`brands text[]`), never a container — so a Marketing task for MFL appears in
// both the Marketing filter and the MFL filter without being duplicated.
//
// Logic lives in shared/task-tracker.ts. Status columns carry a machine-readable
// `kind` (todo|active|blocked|done); overdue, progress and staleness are all
// DERIVED on read, never stored. See migrations/2026-08-03_task_tracker.sql.
// ─────────────────────────────────────────────────────────────────────────────

export const ttAreas = pgTable("tt_areas", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  color: text("color").notNull().default("#6366f1"),
  sortOrder: integer("sort_order").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const ttProjectStatuses = pgTable("tt_project_statuses", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  label: text("label").notNull(),
  kind: text("kind").notNull().default("todo"), // todo|active|blocked|done
  color: text("color").notNull().default("#64748b"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const ttTaskStatuses = pgTable("tt_task_statuses", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  label: text("label").notNull(),
  kind: text("kind").notNull().default("todo"), // todo|active|blocked|done
  color: text("color").notNull().default("#64748b"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const ttProjects = pgTable("tt_projects", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  emoji: text("emoji"),
  description: text("description"),
  kind: text("kind").notNull().default("project"), // project|goal
  statusId: integer("status_id").notNull().references(() => ttProjectStatuses.id, { onDelete: "restrict" }),
  // A project may ladder up to a goal row in this same table. Present in the
  // schema from day one because it is cheap now and expensive to retrofit.
  parentGoalId: integer("parent_goal_id"),
  ownerId: integer("owner_id").references(() => users.id, { onDelete: "set null" }),
  areas: text("areas").array().notNull().default(sql`'{}'::text[]`),
  brands: text("brands").array().notNull().default(sql`'{}'::text[]`),
  startDate: date("start_date"),
  targetDate: date("target_date"),
  targetNote: text("target_note"),
  sortOrder: integer("sort_order").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  statusIdx: index("tt_projects_status_idx").on(t.statusId),
  ownerIdx: index("tt_projects_owner_idx").on(t.ownerId),
}));

export const ttTasks = pgTable("tt_tasks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  // SET NULL, never CASCADE — deleting a project must not destroy the record
  // of work people did. The task lands in the "No project" bucket.
  projectId: integer("project_id").references(() => ttProjects.id, { onDelete: "set null" }),
  statusId: integer("status_id").notNull().references(() => ttTaskStatuses.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  description: text("description"),
  priority: text("priority").notNull().default("medium"), // low|medium|high|urgent
  ownerId: integer("owner_id").references(() => users.id, { onDelete: "set null" }),
  startDate: date("start_date"),
  dueDate: date("due_date"),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  sortOrder: integer("sort_order").notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).defaultNow().notNull(),
  archived: boolean("archived").notNull().default(false),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectIdx: index("tt_tasks_project_idx").on(t.projectId),
  statusIdx: index("tt_tasks_status_idx").on(t.statusId),
  ownerIdx: index("tt_tasks_owner_idx").on(t.ownerId),
}));

export const ttTaskAssignees = pgTable("tt_task_assignees", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  taskId: integer("task_id").notNull().references(() => ttTasks.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uq: unique("tt_task_assignees_uq").on(t.taskId, t.userId),
  userIdx: index("tt_task_assignees_user_idx").on(t.userId),
}));

export const ttChecklistItems = pgTable("tt_checklist_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  taskId: integer("task_id").notNull().references(() => ttTasks.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  done: boolean("done").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  taskIdx: index("tt_checklist_task_idx").on(t.taskId),
}));

export const ttComments = pgTable("tt_comments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  taskId: integer("task_id").notNull().references(() => ttTasks.id, { onDelete: "cascade" }),
  authorId: integer("author_id").references(() => users.id, { onDelete: "set null" }),
  authorName: text("author_name"), // denormalised snapshot (recordedBy doctrine)
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  taskIdx: index("tt_comments_task_idx").on(t.taskId),
}));

export type TtArea = typeof ttAreas.$inferSelect;
export type TtProjectStatus = typeof ttProjectStatuses.$inferSelect;
export type TtTaskStatus = typeof ttTaskStatuses.$inferSelect;
export type TtProject = typeof ttProjects.$inferSelect;
export type TtTask = typeof ttTasks.$inferSelect;
export type TtTaskAssignee = typeof ttTaskAssignees.$inferSelect;
export type TtChecklistItem = typeof ttChecklistItems.$inferSelect;
export type TtComment = typeof ttComments.$inferSelect;

// Task Tracker pages — the navigable hierarchy (brand → area → page → …).
// The first two levels are NOT rows: brands come from TT_BRANDS and areas from
// tt_areas, both of which already tag every project. See
// migrations/2026-08-04_task_tracker_pages.sql.
export const ttPages = pgTable("tt_pages", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  brand: text("brand").notNull(),
  areaKey: text("area_key"),
  // RESTRICT, never CASCADE — deleting a page must not take a tree of notes.
  parentId: integer("parent_id"),
  title: text("title").notNull(),
  emoji: text("emoji"),
  description: text("description"),
  viewType: text("view_type").notNull().default("doc"), // doc|projects|tasks|board|list
  body: text("body"),
  sortOrder: integer("sort_order").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  brandAreaIdx: index("tt_pages_brand_area_idx").on(t.brand, t.areaKey),
  parentIdx: index("tt_pages_parent_idx").on(t.parentId),
}));

export type TtPage = typeof ttPages.$inferSelect;
