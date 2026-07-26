// Marketing Suite — shared client-side types. Mirrors the mkt_* Drizzle tables
// (shared/schema.ts) and the admin API response shapes (server/marketing/routes.ts).
// Kept local to client/src/pages/marketing (Phase C owns this directory).

export type MktChannel = "email" | "sms";
export type SubState = "subscribed" | "unsubscribed" | "never";
export type LegalBasis = "express" | "inferred" | "deemed" | "none" | "opted_out";
export type SuppressionScope = "global" | "brand" | "category" | "list";
export type CampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled" | "failed";

export interface MktList {
  id: number;
  workspaceId: number;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MktSegment {
  id: number;
  workspaceId: number;
  name: string;
  definition: SegmentDefinition;
  status: string;
  memberCount: number;
  lastComputedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Segment condition tree — mirrors server/marketing/segments.ts compileNode ──
export type ConditionType = "profile_property" | "consent" | "list_membership" | "event";

export interface ProfilePropertyCondition {
  type: "profile_property";
  path: string; // "email" | "first_name" | "last_name" | "phone_e164" | "external_id" | "props.<key>"
  op: "eq" | "neq" | "contains" | "exists";
  value?: string;
}
export interface ConsentCondition {
  type: "consent";
  channel: MktChannel;
  subState?: SubState;
  legalBasis?: LegalBasis;
}
export interface ListMembershipCondition {
  type: "list_membership";
  listId: number;
  op: "in" | "not_in";
}
export interface EventCondition {
  type: "event";
  metric: string;
  op: ">=" | "=" | ">" | "<=" | "<" | "zero";
  count?: number;
  withinDays?: number;
}
export type Condition = ProfilePropertyCondition | ConsentCondition | ListMembershipCondition | EventCondition;

export interface ConditionGroup { any: Condition[] }
export interface SegmentDefinition { all: ConditionGroup[] }

// ── Campaigns ───────────────────────────────────────────────────────────────
export interface AudienceRef { type: "list" | "segment" | "all"; id?: number }
// { allowUnicode } lives inside audience.smsOptions — see server/marketing/
// campaign-sms.ts's file header for why (no schema change for SMS campaigns).
export interface CampaignAudience { include?: AudienceRef[]; exclude?: AudienceRef[]; smsOptions?: { allowUnicode?: boolean } }

export interface MktCampaign {
  id: number;
  workspaceId: number;
  name: string;
  channel: MktChannel;
  subject: string | null;
  preheader: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  templateId: number | null;
  // For channel='sms' campaigns this holds the plain-text SMS body TEMPLATE
  // (reused column — see server/marketing/campaign-sms.ts's header comment).
  bodyHtml: string | null;
  audience: CampaignAudience;
  smartSend: boolean;
  utm: Record<string, unknown> | null;
  isMarketing: boolean;
  status: CampaignStatus;
  scheduledAt: string | null;
  sentAt: string | null;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AudienceEstimate {
  total: number;
  sendable: number;
  suppressed: number;
  breakdown?: {
    excludedByConsent: number;
    excludedBySuppression: number;
    excludedNoIdentifier: number;
  };
  // sms only — how many of the excluded were excluded for having no phone at all.
  noPhone?: number;
}

// POST /campaigns/:id/sms-preview response — live cost/encoding preview for
// the wizard's Content step (see server/marketing/routes.ts).
export interface SmsCampaignPreview {
  encoding: "gsm7" | "ucs2";
  chars: number;
  segments: number;
  segmentLength: number;
  offendingChars: string[];
  finalBody: string;
  sanitizedRemoved: string[];
  segmentsPerMessage: number;
  totalMessages: number;
  centsPerSegment: number;
  estCostCents: number;
}

export interface CampaignAnalytics {
  campaign: { id: number; name: string; subject: string | null; status: CampaignStatus; sentAt: string | null; recipientCount: number; channel?: MktChannel };
  // ── email ──
  funnel?: {
    total: number; queued: number; sent: number; delivered: number;
    bounced: number; complained: number; failed: number; unsubscribed: number;
  };
  engagement?: {
    uniqueOpens: number; uniqueClicks: number; openCount: number; humanOpenCount: number;
    machineOpenCount: number; clickCount: number; humanClickCount: number; botClickCount: number;
  };
  kpis?: {
    humanClickRate: number; conversionRate: number; revenuePerRecipient: number; openRateMppInflated: number;
  };
  links?: { linkUrl: string; clicks: number; humanClicks: number }[];
  conversions?: { count: number; revenue: number };
  // ── sms ──
  smsFunnel?: { total: number; queued: number; sent: number; delivered: number; failed: number };
  smsCost?: { actualCents: number; currency: string };
  smsInboundStopCount?: number;
}

// ── Profiles ────────────────────────────────────────────────────────────────
export interface MktProfileRow {
  id: number;
  email: string | null;
  phoneE164: string | null;
  firstName: string | null;
  lastName: string | null;
  lastEventAt: string | null;
}

export interface MktProfileFull {
  id: number;
  workspaceId: number;
  email: string | null;
  phoneE164: string | null;
  externalId: string | null;
  firstName: string | null;
  lastName: string | null;
  props: Record<string, unknown>;
  lastEventAt: string | null;
  personId: number | null;
  contactId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface MktConsentRow {
  id: number;
  profileId: number;
  channel: MktChannel;
  subState: SubState;
  legalBasis: LegalBasis;
  canReceive: boolean;
  source: string | null;
  methodDetail: string | null;
  doubleOptin: boolean;
  consentAt: string | null;
  updatedAt: string;
}

export interface MktEventRow {
  id: number;
  metric: string;
  properties: Record<string, unknown>;
  value: string | null;
  occurredAt: string;
}

export interface MktSuppressionRow {
  id: number;
  email: string | null;
  phoneE164: string | null;
  channel: MktChannel;
  scope: SuppressionScope;
  brandKey: string | null;
  category: string | null;
  listId: number | null;
  reason: string;
  source: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface MktProfileDetail {
  profile: MktProfileFull;
  consent: MktConsentRow[];
  events: MktEventRow[];
  suppressions: MktSuppressionRow[];
}

export interface DashboardSummary {
  profiles: number;
  sends30d: number;
  deliveredTotal: number;
  revenue: number;
  revenuePerRecipient: number;
  topCampaigns: { id: number; name: string; status: CampaignStatus; sentAt: string | null; sentCount: number; recipientCount: number }[];
  // Windowed (30d) metrics — the honest, recency-weighted view alongside the
  // all-time totals above. See GET /api/admin/marketing/dashboard.
  delivered30dPct: number;
  humanClicks30d: number;
  conversions30d: { count: number; revenueCents: number };
  rpr30d: number;
}

// GET /api/admin/marketing/webhook-health (Settings) — last-received Resend
// event + a 24h pulse, so it's obvious whether the webhook is actually firing.
export interface WebhookHealth {
  lastEventAt: string | null;
  events24h: number;
  byType24h: Record<string, number>;
}

// ── Flows (Phase E) ───────────────────────────────────────────────────────────
export type FlowStatus = "draft" | "live" | "paused" | "archived";
export type FlowTriggerType = "event" | "list" | "segment" | "date_property";
export type FlowStepType = "delay" | "condition" | "email" | "sms" | "update_property" | "exit";

export interface FlowStep {
  id: string;
  type: FlowStepType;
  config: Record<string, any>;
  next: string | null;
  nextIfFalse?: string | null;
}
export interface FlowGraph {
  steps: FlowStep[];
  entry?: string | null;
}

export interface FlowStats {
  totalEnrollments: number;
  activeEnrollments: number;
  completed: number;
  exited: number;
  messagesSent: number;
  conversions: number;
  revenue: number;
}

export interface MktFlow {
  id: number;
  workspaceId: number;
  brandKey: string | null;
  name: string;
  status: FlowStatus;
  triggerType: FlowTriggerType;
  triggerConfig: Record<string, any>;
  entryFilter: Record<string, any> | null;
  reEntry: boolean;
  quietHours: Record<string, any>;
  liveVersionId: number | null;
  createdAt: string;
  updatedAt: string;
  stats?: FlowStats;
}

export interface MktFlowDetail extends MktFlow {
  draftGraph: FlowGraph;
  draftVersionId: number | null;
  draftDirty: boolean;
  liveVersion: { id: number; versionNo: number; publishedAt: string | null } | null;
}

export interface FlowTemplateCard {
  key: string;
  name: string;
  description: string;
  expectedImpact: string;
  triggerType: FlowTriggerType;
  stepCount: number;
}

export interface FlowAnalytics {
  flow: { id: number; name: string; status: FlowStatus };
  perStep: Record<string, { sent: number; skipped: number; failed: number }>;
  stats: FlowStats;
}

export interface FlowEnrollmentRow {
  id: number;
  status: string;
  currentStepId: string | null;
  enteredAt: string;
  exitedAt: string | null;
  exitReason: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface SmsPreview {
  encoding: "gsm7" | "ucs2";
  chars: number;
  segments: number;
  segmentLength: number;
  offendingChars: string[];
  finalBody: string;
  costEstimatePerRecipientCents: number;
}
