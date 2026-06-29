// League Builders engine — opt-in referral rewards for MFL.
//
// A member joins → gets a personal STACKABLE 10% discount code (a `discounts` row
// with combinesWithOrder=true) + an invite token (share link + My Builder page).
// When a referred team's registration CONFIRMS using that code, the builder earns
// Builder Points (+3 for a referred captain's first league, +1 each additional)
// and ACCOUNT CREDIT (commission at their tier) toward their own fees. Attribution
// is idempotent per registration (unique registration_id on the event ledger).
import crypto from "crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { rewardBuilders, rewardBuilderEvents, rewardSeasonMembers, rewardSeasonEvents, rewardSeasonRewards, rewardRefBonus, leagueGameReferees, leagueGames, leagueCompetitions, users, type RewardBuilder, type RewardSeasonMember } from "@shared/schema";

// ─────────────────────────────────────────────────────────────────────────────
// MASTER PAUSE SWITCH for reward AUTO-ISSUANCE on registration.
// Paused 2026-06-29 at Daniel's request: the rewards program (Builder referral
// attribution + Season Ticket XP/voucher issuance) must not auto-create discount
// codes / credit on real registrations until it's consciously switched on.
// Admin Rewards tab + viewing still work; only the automatic accrual is gated.
// Flip to true to re-enable.
export const REWARDS_AUTO_ISSUE_ENABLED = false;
import { storage } from "./storage";
import { builderTierFor, nextBuilderTier, BUILDER_TIERS, SEASON_TIERS, seasonTierFor, SEASON_XP_PER_SIGNUP, REFEREE_TIERS, refereeTierFor, type SeasonTier } from "@shared/rewards";

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
  if (!REWARDS_AUTO_ISSUE_ENABLED) return;  // rewards paused — no auto-attribution
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

// ═══════════════════════════════════════════════════════════════════════════
// Season Ticket Rewards (loyalty) — +3 Team XP per confirmed signup; crossing a
// tier auto-issues a reward (voucher code, or custom kit flagged for fulfilment).
// ═══════════════════════════════════════════════════════════════════════════

function genVoucherCode(pct: number): string {
  return `SEASON${pct}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

// Accrue Team XP for a confirmed registration (idempotent per registration), then
// issue any newly-unlocked tier rewards. Keyed by captain email.
export async function accrueSeasonXp(opts: {
  organizationId: number; registrationId: number; name: string; email: string; phone?: string | null; contactId?: number | null; teamName?: string | null;
}): Promise<void> {
  if (!REWARDS_AUTO_ISSUE_ENABLED) return;  // rewards paused — no auto XP/voucher issuance
  const email = String(opts.email || "").trim().toLowerCase();
  if (!email) return;

  // Find/create the member.
  let [member] = await db.select().from(rewardSeasonMembers).where(and(eq(rewardSeasonMembers.organizationId, opts.organizationId), eq(rewardSeasonMembers.email, email)));
  if (!member) {
    try {
      [member] = await db.insert(rewardSeasonMembers).values({
        organizationId: opts.organizationId, contactId: opts.contactId ?? null,
        name: opts.name || email, email, phone: opts.phone ?? null,
      }).returning();
    } catch (e: any) {
      if (e?.code === "23505" || /duplicate|unique/i.test(e?.message || "")) {
        [member] = await db.select().from(rewardSeasonMembers).where(and(eq(rewardSeasonMembers.organizationId, opts.organizationId), eq(rewardSeasonMembers.email, email)));
      } else throw e;
    }
  }
  if (!member) return;

  // Idempotent +XP per registration (unique registration_id on the event).
  try {
    await db.insert(rewardSeasonEvents).values({ memberId: member.id, xp: SEASON_XP_PER_SIGNUP, registrationId: opts.registrationId, teamName: opts.teamName ?? null });
  } catch (e: any) {
    if (e?.code === "23505" || /duplicate|unique/i.test(e?.message || "")) return; // already accrued
    throw e;
  }
  const newXp = member.xp + SEASON_XP_PER_SIGNUP;
  await db.update(rewardSeasonMembers).set({ xp: newXp }).where(eq(rewardSeasonMembers.id, member.id));

  // Issue any tiers now reached that haven't been issued yet.
  for (const tier of SEASON_TIERS) {
    if (newXp >= tier.xp) await issueSeasonReward({ ...member, xp: newXp }, tier);
  }
}

async function issueSeasonReward(member: RewardSeasonMember, tier: SeasonTier): Promise<void> {
  // Idempotent: unique (member, tier). Insert the reward row first; if it already
  // exists the unique index throws and we skip (no duplicate voucher).
  let voucherCode: string | null = null;
  let discountId: number | null = null;
  if (tier.rewardType === "discount") {
    voucherCode = genVoucherCode(tier.value);
    try {
      const d = await storage.createDiscount({
        organizationId: member.organizationId,
        title: `Season Ticket ${tier.name} — ${member.name}`,
        code: voucherCode,
        type: "amount_off_order", method: "code", valueType: "percentage", value: String(tier.value),
        appliesTo: "all", eligibility: "all", minPurchaseType: "none",
        combinesWithOrder: true, combinesWithProduct: true, status: "active",
        maxTotalUses: 1, startDate: new Date(),
      } as any);
      discountId = d.id;
    } catch (e: any) { console.error("[Season] voucher code create failed:", e?.message); }
  }
  try {
    await db.insert(rewardSeasonRewards).values({
      memberId: member.id, tier: tier.name, rewardType: tier.rewardType,
      voucherCode, discountId, status: "issued",
    });
  } catch (e: any) {
    if (e?.code === "23505" || /duplicate|unique/i.test(e?.message || "")) {
      // Already issued — clean up the orphan discount we just made.
      if (discountId) { try { await (storage as any).updateDiscount?.(discountId, { status: "disabled" }); } catch {} }
      return;
    }
    throw e;
  }
  void sendSeasonRewardEmail(member, tier, voucherCode);
}

async function sendSeasonRewardEmail(member: RewardSeasonMember, tier: SeasonTier, voucherCode: string | null): Promise<void> {
  try {
    const { sendSeasonRewardEmail: send } = await import("./email");
    await send({ to: member.email, memberName: member.name?.split(" ")[0] || "there", tierName: tier.name, rewardLabel: tier.label, voucherCode });
  } catch (e: any) { console.error(`[Season] reward email failed member=${member.id}:`, e?.message); }
}

export async function listSeasonMembers(orgId: number) {
  const rows = await db.select().from(rewardSeasonMembers).where(eq(rewardSeasonMembers.organizationId, orgId)).orderBy(desc(rewardSeasonMembers.xp));
  const out = [] as any[];
  for (const m of rows) {
    const rewards = await db.select().from(rewardSeasonRewards).where(eq(rewardSeasonRewards.memberId, m.id));
    out.push({
      id: m.id, name: m.name, email: m.email, phone: m.phone, xp: m.xp,
      tier: seasonTierFor(m.xp)?.name ?? "—",
      rewardsIssued: rewards.length,
      kitPending: rewards.some((r) => r.rewardType === "custom_kit" && r.status !== "fulfilled"),
    });
  }
  return out;
}

export async function getSeasonDetail(id: number) {
  const [m] = await db.select().from(rewardSeasonMembers).where(eq(rewardSeasonMembers.id, id));
  if (!m) return null;
  const rewards = await db.select().from(rewardSeasonRewards).where(eq(rewardSeasonRewards.memberId, id)).orderBy(desc(rewardSeasonRewards.createdAt));
  const events = await db.select().from(rewardSeasonEvents).where(eq(rewardSeasonEvents.memberId, id)).orderBy(desc(rewardSeasonEvents.createdAt));
  return {
    member: { id: m.id, name: m.name, email: m.email, phone: m.phone, xp: m.xp, tier: seasonTierFor(m.xp)?.name ?? "—" },
    rewards: rewards.map((r) => ({ id: r.id, tier: r.tier, rewardType: r.rewardType, voucherCode: r.voucherCode, status: r.status, at: r.createdAt })),
    signups: events.map((e) => ({ teamName: e.teamName, xp: e.xp, at: e.createdAt })),
  };
}

export async function fulfilSeasonReward(rewardId: number): Promise<void> {
  await db.update(rewardSeasonRewards).set({ status: "fulfilled" }).where(eq(rewardSeasonRewards.id, rewardId));
}

// ═══════════════════════════════════════════════════════════════════════════
// Referee Rewards (staff retention) — tokens derived live from final games
// refereed + admin bonus tokens. Tiers unlock perks; pay-rate is display-only.
// ═══════════════════════════════════════════════════════════════════════════

async function orgCompetitionIds(orgId: number): Promise<number[]> {
  const comps = await db.select({ id: leagueCompetitions.id }).from(leagueCompetitions).where(eq(leagueCompetitions.organizationId, orgId));
  return comps.map((c) => c.id);
}

export async function listReferees(orgId: number) {
  const compIds = await orgCompetitionIds(orgId);
  const byUser = new Map<number, { userId: number; name: string; email: string; gamesRefereed: number; assigned: number; bonus: number }>();

  if (compIds.length > 0) {
    const assignments = await db.select({
      userId: leagueGameReferees.userId, status: leagueGames.status,
      firstName: users.firstName, lastName: users.lastName, email: users.email,
    }).from(leagueGameReferees)
      .innerJoin(leagueGames, eq(leagueGameReferees.gameId, leagueGames.id))
      .innerJoin(users, eq(leagueGameReferees.userId, users.id))
      .where(inArray(leagueGames.competitionId, compIds));
    for (const a of assignments) {
      let r = byUser.get(a.userId);
      if (!r) { r = { userId: a.userId, name: `${a.firstName} ${a.lastName}`.trim(), email: a.email, gamesRefereed: 0, assigned: 0, bonus: 0 }; byUser.set(a.userId, r); }
      r.assigned++;
      if (a.status === "final") r.gamesRefereed++;
    }
  }

  const bonuses = await db.select().from(rewardRefBonus).where(eq(rewardRefBonus.organizationId, orgId));
  const missingIds = Array.from(new Set(bonuses.map((b) => b.userId))).filter((id) => !byUser.has(id));
  if (missingIds.length > 0) {
    const us = await db.select().from(users).where(inArray(users.id, missingIds));
    for (const u of us) byUser.set(u.id, { userId: u.id, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email, gamesRefereed: 0, assigned: 0, bonus: 0 });
  }
  for (const b of bonuses) { const r = byUser.get(b.userId); if (r) r.bonus += b.tokens; }

  return Array.from(byUser.values()).map((r) => {
    const tokens = r.gamesRefereed + r.bonus;
    const tier = refereeTierFor(tokens);
    return { userId: r.userId, name: r.name, email: r.email, gamesRefereed: r.gamesRefereed, bonusTokens: r.bonus, tokens, tier: tier?.name ?? "—", payRateCents: tier?.payRateCents ?? null };
  }).sort((a, b) => b.tokens - a.tokens);
}

export async function getRefereeDetail(orgId: number, userId: number) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) return null;
  const compIds = await orgCompetitionIds(orgId);
  const games = compIds.length > 0
    ? await db.select({ id: leagueGames.id, gameDate: leagueGames.gameDate, status: leagueGames.status })
        .from(leagueGameReferees)
        .innerJoin(leagueGames, eq(leagueGameReferees.gameId, leagueGames.id))
        .where(and(eq(leagueGameReferees.userId, userId), inArray(leagueGames.competitionId, compIds)))
        .orderBy(desc(leagueGames.gameDate))
    : [];
  const bonus = await db.select().from(rewardRefBonus).where(and(eq(rewardRefBonus.organizationId, orgId), eq(rewardRefBonus.userId, userId))).orderBy(desc(rewardRefBonus.createdAt));
  const gamesRefereed = games.filter((g) => g.status === "final").length;
  const bonusTotal = bonus.reduce((s, b) => s + b.tokens, 0);
  const tokens = gamesRefereed + bonusTotal;
  const tier = refereeTierFor(tokens);
  return {
    referee: { userId, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email, tokens, gamesRefereed, gamesAssigned: games.length, bonusTotal, tier: tier?.name ?? "—", payRateCents: tier?.payRateCents ?? null },
    tiers: REFEREE_TIERS,
    games: games.map((g) => ({ id: g.id, date: g.gameDate, status: g.status })),
    bonus: bonus.map((b) => ({ id: b.id, tokens: b.tokens, note: b.note, at: b.createdAt })),
  };
}

export async function addRefBonus(orgId: number, userId: number, tokens: number, note?: string): Promise<void> {
  await db.insert(rewardRefBonus).values({ organizationId: orgId, userId, tokens, note: note ?? null });
}
