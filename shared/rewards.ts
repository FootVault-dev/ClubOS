// League Builders reward tiers — shared by server (commission at earning time) and
// client (display). Commission is the cash-equivalent value credited per new team
// at the builder's tier; in Phase 1 it accrues as ACCOUNT CREDIT toward their own
// fees (not a cash payout). Points: +3 for a referred captain's first league, +1
// for each additional league they enter.
export interface BuilderTier {
  name: string;
  points: number;        // points threshold to reach this tier
  commissionCents: number; // credit earned per new referred team at this tier
}

export const BUILDER_TIERS: BuilderTier[] = [
  { name: "Amateur", points: 3, commissionCents: 10000 },
  { name: "Semi-Pro", points: 10, commissionCents: 12000 },
  { name: "Pro", points: 20, commissionCents: 15000 },
  { name: "Champion", points: 35, commissionCents: 20000 },
  { name: "Legends Club", points: 50, commissionCents: 25000 },
];

// The highest tier reached at a given point total (null = below the first tier).
export function builderTierFor(points: number): BuilderTier | null {
  let tier: BuilderTier | null = null;
  for (const t of BUILDER_TIERS) {
    if (points >= t.points) tier = t;
  }
  return tier;
}

// The next tier up + points remaining to reach it (null when at the top).
export function nextBuilderTier(points: number): { tier: BuilderTier; pointsAway: number } | null {
  for (const t of BUILDER_TIERS) {
    if (points < t.points) return { tier: t, pointsAway: t.points - points };
  }
  return null;
}

// ── Season Ticket Rewards (loyalty / retention) ─────────────────────────────
// A team earns +3 Team XP every league signup. Crossing a tier unlocks a reward:
// auto-issued one-time discount voucher, or a custom kit (manual fulfilment).
export interface SeasonTier {
  name: string;
  xp: number;
  rewardType: "discount" | "custom_kit";
  value: number;          // percent off (discount tiers); 0 for custom kit
  label: string;
}

export const SEASON_XP_PER_SIGNUP = 3;

export const SEASON_TIERS: SeasonTier[] = [
  { name: "Amateur", xp: 3, rewardType: "discount", value: 10, label: "10% Frontrunner discount" },
  { name: "Semi-Pro", xp: 10, rewardType: "discount", value: 20, label: "20% discount voucher" },
  { name: "Pro", xp: 20, rewardType: "custom_kit", value: 0, label: "Custom kit for your team" },
  { name: "Champion", xp: 35, rewardType: "discount", value: 50, label: "50% discount voucher" },
  { name: "Legends Club", xp: 50, rewardType: "discount", value: 100, label: "100% discount voucher" },
];

export function seasonTierFor(xp: number): SeasonTier | null {
  let tier: SeasonTier | null = null;
  for (const t of SEASON_TIERS) if (xp >= t.xp) tier = t;
  return tier;
}

export function nextSeasonTier(xp: number): { tier: SeasonTier; xpAway: number } | null {
  for (const t of SEASON_TIERS) if (xp < t.xp) return { tier: t, xpAway: t.xp - xp };
  return null;
}
