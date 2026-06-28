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
