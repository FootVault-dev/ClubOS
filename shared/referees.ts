// CIC referee accounts — shared constants + validation, used by both the server
// (server/cic-referee-routes.ts) and any client that needs the status list.
//
// Referees are a SEPARATE identity from ClubOS staff `users`: a referee holds
// only a scoped, CIC-only scoring credential and never a staff session. See the
// server routes file for the full reasoning.

export const REFEREE_STATUSES = ["pending", "approved", "suspended", "declined"] as const;
export type RefereeStatus = (typeof REFEREE_STATUSES)[number];

export function isRefereeStatus(v: unknown): v is RefereeStatus {
  return typeof v === "string" && (REFEREE_STATUSES as readonly string[]).includes(v);
}

// Only an approved referee may log in and score. Pending awaits a staffer's tick;
// suspended/declined are locked out. Checked on every request (instant revoke).
export function refereeCanLogin(status: string | null | undefined): boolean {
  return status === "approved";
}

export const REFEREE_LIMITS = {
  // Public signup is throttled per IP (same shape as the hiring form limiter).
  maxSignupsPerIpPerHour: 6,
  // Failed logins per IP per window, before a short cool-off (brute-force guard).
  maxLoginFailsPerIpPerHour: 20,
  minPasswordLength: 8,
  maxNameLength: 120,
  maxEmailLength: 160,
  maxPhoneLength: 40,
} as const;
