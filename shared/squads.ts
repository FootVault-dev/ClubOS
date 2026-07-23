// Club squads — pure logic. No DB, no network.
//
// A squad is one of the club's own teams for one season: "U14 Boys 2026",
// "First Team 2026". Its members are `contacts` rows with a role.
//
// Tested by script/test-squads.ts.

import { ageGradeFor } from "./academy";

// ── Roles ───────────────────────────────────────────────────────────────────

export const SQUAD_ROLES = [
  "player",
  "head_coach",
  "assistant_coach",
  "goalkeeper_coach",
  "manager",
  "physio",
  "team_official",
] as const;
export type SquadRole = (typeof SQUAD_ROLES)[number];

export const SQUAD_ROLE_LABELS: Record<SquadRole, string> = {
  player: "Player",
  head_coach: "Head coach",
  assistant_coach: "Assistant coach",
  goalkeeper_coach: "Goalkeeper coach",
  manager: "Team manager",
  physio: "Physio",
  team_official: "Team official",
};

/** Everyone who isn't a player is staff — the split the roster UI draws on. */
export const STAFF_ROLES: SquadRole[] = SQUAD_ROLES.filter((r) => r !== "player") as SquadRole[];

export function isSquadRole(v: unknown): v is SquadRole {
  return typeof v === "string" && (SQUAD_ROLES as readonly string[]).includes(v);
}

// ── Positions ───────────────────────────────────────────────────────────────

export const POSITIONS = ["GK", "DF", "MF", "FW"] as const;
export type Position = (typeof POSITIONS)[number];
export const POSITION_LABELS: Record<Position, string> = {
  GK: "Goalkeeper",
  DF: "Defender",
  MF: "Midfielder",
  FW: "Forward",
};
export function isPosition(v: unknown): v is Position {
  return typeof v === "string" && (POSITIONS as readonly string[]).includes(v);
}

// ── Bands ───────────────────────────────────────────────────────────────────

/** A grouping for the UI, not a rule. The club's pathway, top to bottom. */
export const SQUAD_BANDS = ["senior", "academy", "youth"] as const;
export type SquadBand = (typeof SQUAD_BANDS)[number];
export const SQUAD_BAND_LABELS: Record<SquadBand, string> = {
  senior: "Senior",
  academy: "Academy",
  // The club says "Pre-Academy", never "Youth" — U9 through U12 is the
  // Pre-Academy pathway, and that is the wording on the programmes and the
  // coaches' team sheets.
  youth: "Pre-Academy",
};
export function isSquadBand(v: unknown): v is SquadBand {
  return typeof v === "string" && (SQUAD_BANDS as readonly string[]).includes(v);
}

/** Suggest a band from the age grade. U13+ is Academy, below that Youth, and a
 *  squad with no grade at all is a senior side. Only ever a default — the club
 *  can override it, because "NXT (U20)" is a judgement call, not arithmetic. */
export function bandForAgeGrade(ageGrade: number | null | undefined): SquadBand {
  if (typeof ageGrade !== "number") return "senior";
  if (ageGrade >= 18) return "senior";
  if (ageGrade >= 13) return "academy";
  return "youth";
}

/** Sort key: seniors first, then oldest youth down to the youngest.
 *  Mirrors how a club lists its teams — First Team at the top, U9s at the foot. */
export function squadSortKey(s: { ageGrade?: number | null; displayOrder?: number | null }): number {
  if (typeof s.displayOrder === "number" && s.displayOrder !== 0) return s.displayOrder;
  // No grade = senior = top. Otherwise older grades sort above younger.
  if (typeof s.ageGrade !== "number") return 0;
  return 100 - s.ageGrade;
}

// ── Eligibility ─────────────────────────────────────────────────────────────

export interface SquadEligibility {
  eligible: boolean;
  grade: number | null;
  reason: string;
}

/**
 * Is this player the right age for this squad?
 *
 * Uses the same NZF rule as registrations: grade = seasonYear − birthYear.
 * A player may always PLAY UP (a strong U13 in the U14s is normal and legal);
 * playing DOWN is what gets a club sanctioned. So an older player is a warning
 * we surface, and a younger player is simply allowed.
 */
export function checkSquadEligibility(
  dobIso: string | null | undefined,
  seasonYear: number,
  squadAgeGrade: number | null | undefined,
): SquadEligibility {
  if (typeof squadAgeGrade !== "number") {
    return { eligible: true, grade: ageGradeFor(dobIso, seasonYear), reason: "Senior squad — no age limit" };
  }
  const grade = ageGradeFor(dobIso, seasonYear);
  if (grade === null) {
    return { eligible: true, grade: null, reason: "No date of birth on file — age not checked" };
  }
  if (grade > squadAgeGrade) {
    return {
      eligible: false,
      grade,
      reason: `Over age: U${grade} in ${seasonYear}, this squad is U${squadAgeGrade}.`,
    };
  }
  if (grade < squadAgeGrade) {
    return { eligible: true, grade, reason: `Playing up — U${grade} in a U${squadAgeGrade} squad.` };
  }
  return { eligible: true, grade, reason: `U${grade} in ${seasonYear}` };
}

// ── Validation ──────────────────────────────────────────────────────────────

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function validateSquad(input: {
  name?: unknown;
  seasonYear?: unknown;
  ageGrade?: unknown;
  band?: unknown;
}): string[] {
  const errors: string[] = [];
  if (!str(input.name)) errors.push("Squad name is required.");
  const y = Number(input.seasonYear);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) errors.push("A valid season year is required.");
  if (input.ageGrade !== null && input.ageGrade !== undefined && input.ageGrade !== "") {
    const g = Number(input.ageGrade);
    if (!Number.isInteger(g) || g < 4 || g > 23) errors.push("Age grade must be between U4 and U23, or blank for a senior squad.");
  }
  if (input.band !== null && input.band !== undefined && input.band !== "" && !isSquadBand(input.band)) {
    errors.push("Unknown squad band.");
  }
  return errors;
}

export function validateSquadMember(input: {
  contactId?: unknown;
  role?: unknown;
  squadNumber?: unknown;
  position?: unknown;
}): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(Number(input.contactId)) || Number(input.contactId) <= 0) {
    errors.push("Pick a person.");
  }
  if (!isSquadRole(input.role)) errors.push("Pick a role.");
  if (input.squadNumber !== null && input.squadNumber !== undefined && input.squadNumber !== "") {
    const n = Number(input.squadNumber);
    if (!Number.isInteger(n) || n < 1 || n > 99) errors.push("Squad number must be between 1 and 99.");
    if (input.role !== "player") errors.push("Only players have a squad number.");
  }
  if (input.position !== null && input.position !== undefined && input.position !== "") {
    if (!isPosition(input.position)) errors.push("Unknown position.");
    if (input.role !== "player") errors.push("Only players have a position.");
  }
  return errors;
}

/** Roster summary for a squad card. Departed members never count. */
export function summariseRoster(members: Array<{ role: string; leftAt?: string | null }>) {
  const active = members.filter((m) => !m.leftAt);
  const players = active.filter((m) => m.role === "player").length;
  const staff = active.length - players;
  return { players, staff, total: active.length, departed: members.length - active.length };
}
