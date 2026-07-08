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
export interface CampaignAudience { include?: AudienceRef[]; exclude?: AudienceRef[] }

export interface MktCampaign {
  id: number;
  workspaceId: number;
  name: string;
  channel: string;
  subject: string | null;
  preheader: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  templateId: number | null;
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
}

export interface CampaignAnalytics {
  campaign: { id: number; name: string; subject: string | null; status: CampaignStatus; sentAt: string | null; recipientCount: number };
  funnel: {
    total: number; queued: number; sent: number; delivered: number;
    bounced: number; complained: number; failed: number; unsubscribed: number;
  };
  engagement: {
    uniqueOpens: number; uniqueClicks: number; openCount: number; humanOpenCount: number;
    machineOpenCount: number; clickCount: number; humanClickCount: number; botClickCount: number;
  };
  kpis: {
    humanClickRate: number; conversionRate: number; revenuePerRecipient: number; openRateMppInflated: number;
  };
  links: { linkUrl: string; clicks: number; humanClicks: number }[];
  conversions: { count: number; revenue: number };
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
}
