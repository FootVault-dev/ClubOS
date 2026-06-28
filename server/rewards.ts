// League Builders engine — opt-in referral rewards for MFL.
//
// A member joins → gets a personal STACKABLE 10% discount code (a `discounts` row
// with combinesWithOrder=true) + an invite token (share link + My Builder page).
// When a referred team's registration CONFIRMS using that code, the builder earns
// Builder Points (+3 for a referred captain's first league, +1 each additional)
// and ACCOUNT CREDIT (commission at their tier) toward their own fees. Attribution
// is idempotent per registration (unique registration_id on the event ledger).
import crypto from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "./db";
import { rewardBuilders, rewardBuilderEvents, type RewardBuilder } from "@shared/schema";
import { storage } from "./storage";
import { builderTierFor, nextBuilderTier, BUILDER_TIERS } from "@shared/rewards";

function token(bytes = 12): string { return crypto.randomBytes(bytes).toString("base64url"); }

function genBuilderCode(name: string): string {
  const initials = (name || "MFL").replace(/[^a-zA-Z]/g, "").slice(0, 4).toUpperCase() || "MFL";
  return `BUILD-${initials}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

async function builderByEmail(orgId: number, email: string): Promise<RewardBuilder | undefined> {
  const [b] = await db.select().from(rewardBuilders).where(and(eq(rewardBuilders.organizationId, orgId), eq(rewardBuilders.email, email.trim().toLowerCase())));
  return b;
}

// Opt-in: create (or return existing) builder for this email + a backing 10% code.
export async function joinBuilder(opts: { organizationId: number; name: string; email: string; phone?: string; contactId?: number | null }): Promise<RewardBuilder> {
  const email = opts.email.trim().toLowerCase();
  const existing = await builderByEmail(opts.organizationId, email);
  if (existing) return existing;

  // Unique builder code (retry on the rare collision; unique index is the backstop).
  let code = genBuilderCode(opts.name);
  for (let i = 0; i < 5; i++) {
    const dupe = await storage.getDiscountByCode(code, opts.organizationId);
    if (!dupe) break;
    code = genBuilderCode(opts.name);
  }
  const discount = await storage.createDiscount({
    organizationId: opts.organizationId,
    title: `League Builder — ${opts.name}`,
    code,
    type: "amount_off_order",
    method: "code",
    valueType: "percentage",
    value: "10",
    appliesTo: "all",
    eligibility: "all",
    minPurchaseType: "none",
    combinesWithOrder: true,   // stacks with early-bird (Daniel's decision)
    combinesWithProduct: true,
    status: "active",
    startDate: new Date(),
  } as any);

  try {
    const [b] = await db.insert(rewardBuilders).values({
      organizationId: opts.organizationId,
      contactId: opts.contactId ?? null,
      name: opts.name.trim(),
      email,
      phone: opts.phone ?? null,
      builderCode: code,
      discountId: discount.id,
      inviteToken: token(),
    }).returning();
    return b;
  } catch (e: any) {
    // Lost a same-email race → return the row that won.
    if (e?.code === "23505" || /duplicate|unique/i.test(e?.message || "")) {
      const b = await builderByEmail(opts.organizationId, email);
      if (b) return b;
    }
    throw e;
  }
}

export async function getBuilderByCode(code: string, orgId: number): Promise<RewardBuilder | undefined> {
  const [b] = await db.select().from(rewardBuilders).where(and(eq(rewardBuilders.builderCode, code), eq(rewardBuilders.organizationId, orgId)));
  return b;
}

function builderPublic(b: RewardBuilder, events: any[], baseUrl: string) {
  const tier = builderTierFor(b.points);
  const next = nextBuilderTier(b.points);
  const referrals = events.filter((e) => e.type === "referral_first" || e.type === "referral_extra");
  return {
    name: b.name,
    builderCode: b.builderCode,
    inviteUrl: `${baseUrl}/league?ref=${b.builderCode}`,
    points: b.points,
    tier: tier?.name ?? null,
    nextTier: next ? { name: next.tier.name, pointsAway: next.pointsAway } : null,
    tiers: BUILDER_TIERS,
    creditEarnedCents: b.creditEarnedCents,
    creditUsedCents: b.creditUsedCents,
    creditBalanceCents: b.creditEarnedCents - b.creditUsedCents,
    referralsCount: referrals.length,
    teamsReferred: new Set(referrals.map((e) => e.referredEmail)).size,
    recent: referrals.slice(0, 20).map((e) => ({ teamName: e.referredTeamName, points: e.points, commissionCents: e.commissionCents, at: e.createdAt })),
  };
}

export async function getBuilderViewByToken(inviteToken: string, baseUrl: string) {
  const [b] = await db.select().from(rewardBuilders).where(eq(rewardBuilders.inviteToken, inviteToken));
  if (!b) return null;
  const events = await db.select().from(rewardBuilderEvents).where(eq(rewardBuilderEvents.builderId, b.id)).orderBy(desc(rewardBuilderEvents.createdAt));
  return builderPublic(b, events, baseUrl);
}

// Attribute a confirmed registration to a builder (idempotent per registration).
// reg.discountCode is the comma-separated codes used. First matching builder code
// wins. +3 for the referred captain's first league, +1 each additional. Self-
// referrals are skipped. Commission (account credit) at the builder's tier.
export async function attributeReferral(opts: {
  organizationId: number; registrationId: number; discountCodeRaw: string | null;
  referredEmail: string | null; referredContactId: number | null; teamName: string | null;
}): Promise<void> {
  const codes = String(opts.discountCodeRaw || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (codes.length === 0) return;
  const referredEmail = (opts.referredEmail || "").trim().toLowerCase();

  let builder: RewardBuilder | undefined;
  for (const c of codes) {
    const b = await getBuilderByCode(c, opts.organizationId);
    if (b) { builder = b; break; }
  }
  if (!builder) return;

  // Can't refer yourself.
  if ((referredEmail && builder.email === referredEmail) || (opts.referredContactId && builder.contactId && builder.contactId === opts.referredContactId)) return;

  // First league for this referred captain, or an additional one?
  const prior = await db.select().from(rewardBuilderEvents)
    .where(and(eq(rewardBuilderEvents.builderId, builder.id), eq(rewardBuilderEvents.referredEmail, referredEmail)));
  const isFirst = prior.filter((e) => e.type === "referral_first" || e.type === "referral_extra").length === 0;
  const points = isFirst ? 3 : 1;

  const newPoints = builder.points + points;
  const tier = builderTierFor(newPoints);          // tier-after-award (inclusive)
  const commissionCents = tier?.commissionCents ?? 0;

  try {
    await db.insert(rewardBuilderEvents).values({
      builderId: builder.id,
      type: isFirst ? "referral_first" : "referral_extra",
      points,
      commissionCents,
      registrationId: opts.registrationId,
      referredEmail,
      referredTeamName: opts.teamName ?? null,
      tierAtEarning: tier?.name ?? null,
    });
  } catch (e: any) {
    // Unique registration_id → already attributed. Idempotent: stop.
    if (e?.code === "23505" || /duplicate|unique/i.test(e?.message || "")) return;
    throw e;
  }

  await db.update(rewardBuilders).set({
    points: newPoints,
    creditEarnedCents: builder.creditEarnedCents + commissionCents,
  }).where(eq(rewardBuilders.id, builder.id));
}

// ── Admin ──────────────────────────────────────────────────────────────────
export async function listBuilders(orgId: number) {
  const rows = await db.select().from(rewardBuilders).where(eq(rewardBuilders.organizationId, orgId)).orderBy(desc(rewardBuilders.points));
  return rows.map((b) => ({
    id: b.id, name: b.name, email: b.email, phone: b.phone, builderCode: b.builderCode,
    points: b.points, tier: builderTierFor(b.points)?.name ?? "—",
    creditEarnedCents: b.creditEarnedCents, creditUsedCents: b.creditUsedCents,
    creditBalanceCents: b.creditEarnedCents - b.creditUsedCents, createdAt: b.createdAt,
  }));
}

export async function getBuilderDetail(id: number) {
  const [b] = await db.select().from(rewardBuilders).where(eq(rewardBuilders.id, id));
  if (!b) return null;
  const events = await db.select().from(rewardBuilderEvents).where(eq(rewardBuilderEvents.builderId, id)).orderBy(desc(rewardBuilderEvents.createdAt));
  const tier = builderTierFor(b.points);
  return {
    builder: {
      id: b.id, name: b.name, email: b.email, phone: b.phone, builderCode: b.builderCode,
      points: b.points, tier: tier?.name ?? "—",
      creditEarnedCents: b.creditEarnedCents, creditUsedCents: b.creditUsedCents,
      creditBalanceCents: b.creditEarnedCents - b.creditUsedCents,
    },
    events: events.map((e) => ({ id: e.id, type: e.type, points: e.points, commissionCents: e.commissionCents, referredEmail: e.referredEmail, referredTeamName: e.referredTeamName, tierAtEarning: e.tierAtEarning, note: e.note, at: e.createdAt })),
  };
}

// Admin records credit the builder has redeemed against their fees (Phase 1 manual;
// checkout auto-redemption is Phase 1b). delta>0 = credit used.
export async function recordCreditUsed(builderId: number, amountCents: number, note?: string): Promise<void> {
  const [b] = await db.select().from(rewardBuilders).where(eq(rewardBuilders.id, builderId));
  if (!b) return;
  await db.insert(rewardBuilderEvents).values({ builderId, type: "credit_used", commissionCents: -Math.abs(amountCents), note: note ?? "Credit redeemed", registrationId: null });
  await db.update(rewardBuilders).set({ creditUsedCents: b.creditUsedCents + Math.abs(amountCents) }).where(eq(rewardBuilders.id, builderId));
}
