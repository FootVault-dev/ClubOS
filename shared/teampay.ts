/**
 * Team Pay — the shared decider for team entries, squad payment and fill-ins.
 *
 * Built 2026-08-27 from Isaac Living's spec (13 Aug Tournament Planning Meeting):
 * a team manager needs to see who on their squad has paid, nudge the ones who
 * haven't, and pull in a fill-in when they're short. Piloting on the Christchurch
 * Ethnic Cup, then MFL and CIC 7's — so nothing in here knows about a specific
 * competition.
 *
 * WHY THIS FILE EXISTS: the per-player share, the three statuses the manager
 * sees, and whether an entry is paid up are each computed in more than one place
 * (server charging, server email, manager dashboard, player page, admin board).
 * They are declared ONCE here. A second implementation is how "you owe $57" and
 * "you owe $67" end up on the same screen.
 */

// ── the share ─────────────────────────────────────────────────────────────────

/**
 * What one squad member owes.
 *
 * 🔴 Rounded ONCE, from the whole team fee — never by accumulating a rounded
 * figure per player. And deliberately rounded UP so the squad's shares can never
 * sum to less than the fee: the club must not be a cent short because 800/14
 * doesn't divide. The overflow (at most squadSize-1 cents) is the last payer's
 * problem in every split system there is, and here it is at most 13c.
 */
export function shareCents(feeCents: number, squadSize: number): number {
  if (!Number.isInteger(feeCents) || feeCents < 0) throw new Error("teampay: feeCents must be a non-negative integer");
  if (!Number.isInteger(squadSize) || squadSize < 1) throw new Error("teampay: squadSize must be a positive integer");
  return Math.ceil(feeCents / squadSize);
}

/** The most the club can collect on an entry — never more than the team fee. */
export function collectableCents(feeCents: number, squadSize: number): number {
  return Math.min(feeCents, shareCents(feeCents, squadSize) * squadSize);
}

// ── how the team pays ─────────────────────────────────────────────────────────

/**
 * 'split' — every player pays their own share. The original design.
 * 'whole' — the manager settles the team fee on one card.
 *
 * Daniel, 2026-09-04. A team that already has the money hands one person the
 * job of paying it, and that person collects from their mates by whatever means
 * they already use. Split-only had no route for that at all.
 *
 * 🔴 The mode decides WHO IS ASKED, never what is owed. Both paths settle the
 * same balance — fee minus everything already collected — so switching mode
 * halfway can neither double-charge a team nor forgive a debt.
 */
export type PaymentMode = "split" | "whole";

export const PAYMENT_MODES: readonly PaymentMode[] = ["split", "whole"] as const;

/** Validated here rather than by a DB CHECK — a stale CHECK 500'd the MFL checkout. */
export function isPaymentMode(v: unknown): v is PaymentMode {
  return typeof v === "string" && (PAYMENT_MODES as readonly string[]).includes(v);
}

export const PAYMENT_MODE_LABEL: Record<PaymentMode, string> = {
  split: "Everyone pays their own share",
  whole: "I'll pay the whole team fee",
};

// ── the three statuses Isaac asked for ────────────────────────────────────────

export type PlayerStatus = "paid" | "opened" | "invited" | "declined" | "removed";

export interface PlayerFacts {
  paidAt?: Date | string | null;
  firstOpenedAt?: Date | string | null;
  declinedAt?: Date | string | null;
  removedAt?: Date | string | null;
}

/**
 * 🔴 DERIVED, never stored. A status column would need writing at four different
 * moments (invite, open, pay, remove) and the first one missed is a manager
 * chasing someone who already paid.
 *
 * Order matters: paid outranks everything, because a player who paid and was
 * then removed still paid — the money is real and the manager must see it.
 */
export function playerStatus(p: PlayerFacts): PlayerStatus {
  if (p.paidAt) return "paid";
  if (p.removedAt) return "removed";
  if (p.declinedAt) return "declined";
  if (p.firstOpenedAt) return "opened";
  return "invited";
}

/** What the manager reads on the row. Plain words — this is not an admin tool. */
export const PLAYER_STATUS_LABEL: Record<PlayerStatus, string> = {
  invited: "Not opened",
  opened: "Opened, not paid",
  paid: "Paid",
  declined: "Can't play",
  removed: "Removed",
};

/**
 * Which players count towards the squad and the money.
 * A removed or declined player is neither owed nor chased — unless they paid,
 * in which case their money still counts (see playerStatus).
 */
export function countsTowardsSquad(p: PlayerFacts): boolean {
  return !!p.paidAt || (!p.removedAt && !p.declinedAt);
}

/** Only these two states are worth a nudge. Nudging a payer is how you lose them. */
export function isNudgeable(p: PlayerFacts): boolean {
  const s = playerStatus(p);
  return s === "invited" || s === "opened";
}

// ── the entry's money position ────────────────────────────────────────────────

export interface EntryMoney {
  feeCents: number;
  squadSize: number;
  shareCents: number;
  paymentMode: PaymentMode;
  /** Sum of what was actually charged — a fact, read off the paid rows. */
  paidCents: number;
  /** Of that, what the manager settled on behalf of the whole team. */
  teamPaidCents: number;
  /** Of that, what the squad paid share by share. */
  playersPaidCents: number;
  paidCount: number;
  /** Players on the roster who still owe (excludes declined/removed). */
  outstandingCount: number;
  outstandingCents: number;
  /** Roster slots not yet filled with anybody. */
  emptySlots: number;
  isPaidUp: boolean;
  percentPaid: number;
}

/**
 * 🔴 Nothing stores a total. What a team has paid is the sum of its players'
 * actual charges, recomputed on read. The Accommodation import found a workbook
 * stating four different figures for one term; a stored total is how that happens.
 */
export function entryMoney(
  entry: {
    feeCents: number;
    squadSize: number;
    paymentMode?: PaymentMode | string | null;
    /** What the manager settled for the whole team, if anything. */
    teamPaidCents?: number | null;
  },
  players: Array<PlayerFacts & { paidCents?: number | null }>,
): EntryMoney {
  const share = shareCents(entry.feeCents, entry.squadSize);
  const active = players.filter(countsTowardsSquad);
  const paid = players.filter((p) => !!p.paidAt);

  // Sum what was CHARGED, not shares × count — a share can change between an
  // entry being created and a player paying, and the charge is the fact.
  const playersPaidCents = paid.reduce((sum, p) => sum + (p.paidCents ?? 0), 0);

  // 🔴 ONE balance, fed from both directions. A team that split $250 and then
  // had its manager settle the rest owes nothing; a team whose manager paid in
  // full owes nothing even though not one player row says "paid".
  const teamPaidCents = entry.teamPaidCents ?? 0;
  const paidCents = playersPaidCents + teamPaidCents;

  // An entry created before this column existed reads 'split', which is what it
  // was. Anything unrecognised also reads 'split' — the safe direction, because
  // it keeps asking players rather than silently deciding nobody owes anything.
  const paymentMode: PaymentMode = entry.paymentMode === "whole" ? "whole" : "split";

  const unpaid = active.filter((p) => !p.paidAt);
  const emptySlots = Math.max(0, entry.squadSize - active.length);

  return {
    feeCents: entry.feeCents,
    squadSize: entry.squadSize,
    shareCents: share,
    paymentMode,
    paidCents,
    teamPaidCents,
    playersPaidCents,
    paidCount: paid.length,
    outstandingCount: unpaid.length,
    // What is still owed against the TEAM FEE, never against the roster —
    // an under-filled squad still owes the whole fee.
    outstandingCents: Math.max(0, entry.feeCents - paidCents),
    emptySlots,
    isPaidUp: paidCents >= entry.feeCents,
    percentPaid: entry.feeCents > 0 ? Math.min(100, Math.round((paidCents / entry.feeCents) * 100)) : 0,
  };
}

// ── what a given link may charge, right now ───────────────────────────────────

/**
 * 🔴 The two functions below are the ONLY places an amount is decided, and both
 * are bounded by the outstanding balance. Every charge in this system is the
 * outcome of one of them, computed on the server, from the entry — the browser
 * sends a token and never an amount.
 *
 * The cap is what makes the two payment paths safe to mix. Without it, a
 * manager settling the balance and a player paying their share at the same
 * moment collect the fee twice, and the club is refunding a customer for its
 * own bug.
 */

/** What one player's invite link should charge. 0 means: ask them for nothing. */
export function playerChargeCents(money: EntryMoney): number {
  // In whole mode the manager owes the fee. A player asked for $50 here would
  // be paying a second time for a seat their manager is already covering.
  if (money.paymentMode === "whole") return 0;
  return Math.max(0, Math.min(money.shareCents, money.outstandingCents));
}

/**
 * What the manager's "pay the team fee" button should charge.
 *
 * Deliberately the whole outstanding balance and not the whole fee: a manager
 * whose squad already chipped in $250 should be asked for $550, not $800.
 * This is why the button is offered in split mode too — it is how a team that
 * gave up on chasing three stragglers actually finishes paying.
 */
export function teamChargeCents(money: EntryMoney): number {
  return Math.max(0, money.outstandingCents);
}

// ── nudging ───────────────────────────────────────────────────────────────────

/** A player may be nudged once every 12 hours, at most 6 times in total. */
export const NUDGE_MIN_GAP_HOURS = 12;
export const NUDGE_MAX_TOTAL = 6;

/** NZ waking hours. Nobody wants a reminder about $57 at 6am. */
export const NUDGE_HOUR_FROM = 8;
export const NUDGE_HOUR_TO = 20;

export interface NudgeGate {
  allowed: boolean;
  /** Plain-English reason the button is disabled — shown to the manager. */
  reason?: string;
  nextAllowedAt?: Date;
}

export function nudgeGate(
  p: PlayerFacts & { nudgeCount?: number | null; lastNudgedAt?: Date | string | null; email?: string | null; phone?: string | null },
  now: Date,
): NudgeGate {
  if (!isNudgeable(p)) return { allowed: false, reason: "Nothing to chase" };
  if (!p.email && !p.phone) return { allowed: false, reason: "No email or mobile on file" };

  const count = p.nudgeCount ?? 0;
  if (count >= NUDGE_MAX_TOTAL) return { allowed: false, reason: `Reminded ${NUDGE_MAX_TOTAL} times — give them a call` };

  const last = p.lastNudgedAt ? new Date(p.lastNudgedAt) : null;
  if (last) {
    const next = new Date(last.getTime() + NUDGE_MIN_GAP_HOURS * 3600_000);
    if (next > now) {
      return { allowed: false, reason: `Reminded recently — you can nudge again later`, nextAllowedAt: next };
    }
  }
  return { allowed: true };
}

/** Is it a civil hour in New Zealand to send a reminder? */
export function withinNudgeHoursNz(now: Date): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", hour: "2-digit", hour12: false }).format(now),
  );
  return hour >= NUDGE_HOUR_FROM && hour < NUDGE_HOUR_TO;
}

// ── fill-ins ──────────────────────────────────────────────────────────────────

/**
 * 🔴 A manager NEVER sees a fill-in's contact details from the browse list.
 *
 * Isaac's spec says "managers can see all profiles and pick whoever they want",
 * and this is the one place the build deviates. Entering a team costs nothing
 * and needs no approval, so "is a team manager" is not a gate — anyone could
 * register a team and harvest the pool. Several of these people are new to the
 * country and told us so. Contact details are exchanged when the player accepts,
 * which is also the hold/confirmation window Isaac asked for.
 *
 * Flip RELEASE_CONTACT_ON_REQUEST to true if Daniel decides the friction is
 * worse than the exposure. It is a one-line change on purpose.
 */
export const RELEASE_CONTACT_ON_REQUEST = false;

/** How long a manager's claim on a fill-in blocks other managers. */
export const FILLIN_HOLD_HOURS = 48;

/** How many fill-ins one entry can hold at once — stops a team parking the pool. */
export const FILLIN_MAX_CONCURRENT_HOLDS = 3;

/** After a decline, that team can't ask that player again for this long. */
export const FILLIN_REASK_COOLDOWN_DAYS = 7;

export const FILLIN_POSITIONS = [
  "Goalkeeper",
  "Defender",
  "Midfielder",
  "Forward",
  "Anywhere",
] as const;
export type FillinPosition = (typeof FILLIN_POSITIONS)[number];

export const FILLIN_ABILITIES = [
  "Just for fun",
  "Played socially",
  "Club level",
  "Representative / semi-pro",
] as const;

export const FILLIN_MOTIVATIONS = [
  "Meet people",
  "Play competitively",
  "Keep fit",
  "Just for fun",
] as const;

/**
 * What a manager may see before the player has said yes.
 *
 * 🔴 This is an ALLOWLIST, and the browse endpoint builds its response from it
 * field by field. A `SELECT *` with a couple of deletes is how a phone number
 * reaches a page it was never meant to.
 */
export const FILLIN_PUBLIC_FIELDS = [
  "id",
  "firstName",
  "position",
  "ability",
  "highestLevel",
  "fromWhere",
  "motivation",
  "note",
  "createdAt",
] as const;

export interface FillinPublic {
  id: number;
  firstName: string;
  position: string | null;
  ability: string | null;
  highestLevel: string | null;
  fromWhere: string | null;
  motivation: string | null;
  note: string | null;
  createdAt: string;
}

// ── competition binding ───────────────────────────────────────────────────────

/**
 * A competition is a tournament (Ethnic Cup, CIC 7's) or a programme (MFL term).
 * Exactly one is set — the database enforces it, so no code path can create a
 * competition that belongs to both or neither.
 */
export type CompetitionKind = "tournament" | "program";

export interface TeampayBrand {
  /** Page background. */
  bg: string;
  /** Primary ink on that background. */
  ink: string;
  /** Accent — buttons, progress, the paid tick. */
  accent: string;
  /** Ink that sits ON the accent. */
  onAccent: string;
  /** Muted text. */
  mute: string;
  /** Card surface. */
  card: string;
  /** Hairline. */
  line: string;
  fontHeading: string;
  fontBody: string;
}

/**
 * Brands are keyed by a string on the competition row, so adding MFL or CIC 7's
 * is a row insert and not a deploy.
 *
 * Ethnic Cup values are taken verbatim from apps/ethniccup-website/src/site.ts
 * — the club-approved CIC gold, so the pages read as family.
 */
export const TEAMPAY_BRANDS: Record<string, TeampayBrand> = {
  ethniccup: {
    bg: "#0B0B0B",
    ink: "#FFFFFF",
    accent: "#C9A43E",
    onAccent: "#0B0B0B",
    mute: "#9A9A9A",
    card: "#141414",
    line: "#262626",
    fontHeading: "'Kanit', system-ui, sans-serif",
    fontBody: "'Inter', system-ui, sans-serif",
  },
  cic: {
    bg: "#0B0B0B",
    ink: "#FFFFFF",
    accent: "#C9A43E",
    onAccent: "#0B0B0B",
    mute: "#9A9A9A",
    card: "#141414",
    line: "#262626",
    fontHeading: "'Kanit', system-ui, sans-serif",
    fontBody: "'Inter', system-ui, sans-serif",
  },
  mfl: {
    bg: "#000000",
    ink: "#FFFFFF",
    accent: "#D1B96E",
    onAccent: "#000000",
    mute: "#9A9A9A",
    card: "#121212",
    line: "#242424",
    fontHeading: "'Anton', system-ui, sans-serif",
    fontBody: "'Inter', system-ui, sans-serif",
  },
  // CIC Summer 7's — volt on midnight navy, verbatim from apps/cic7s-website
  // tailwind.config.js (lime #cffd5a · navy #0a1122 · coal #10131C · line
  // #252A38). A manager arriving from cic7s.com must not land on a gold page.
  cic7s: {
    bg: "#0A1122",
    ink: "#FFFFFF",
    accent: "#CFFD5A",
    onAccent: "#0A1122",
    mute: "#9AA3B2",
    card: "#10131C",
    line: "#252A38",
    fontHeading: "'Kanit', system-ui, sans-serif",
    fontBody: "'Inter', system-ui, sans-serif",
  },
};

export const DEFAULT_BRAND: TeampayBrand = TEAMPAY_BRANDS.ethniccup;

export function brandFor(key?: string | null): TeampayBrand {
  return (key && TEAMPAY_BRANDS[key]) || DEFAULT_BRAND;
}

// ── tokens ────────────────────────────────────────────────────────────────────

/**
 * 🔴 These links are the only thing standing between the public and a squad's
 * names, emails and phone numbers. They must never be enumerable — same rule as
 * the invoice pages, and for the same reason. 32 hex chars = 128 bits.
 */
export const TOKEN_BYTES = 16;

/** Squad size bounds. 11-a-side with subs tops out well under 40. */
export const MIN_SQUAD_SIZE = 1;
export const MAX_SQUAD_SIZE = 40;
