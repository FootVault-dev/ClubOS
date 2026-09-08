/**
 * Club Events — the rules shared by server and client.
 *
 * A ticketed club event (the first: the CUFC Club Dinner, Friday 13 November
 * 2026). Pricing is a list of ticket TYPES, each with a sales window, and the
 * server picks the one whose window holds "now" — so "early bird $150 to
 * 1 October, then $165" is data, not code, and editable in ClubOS with no deploy.
 *
 * 🔴 Money is integer cents everywhere here; the UI shows dollars.
 */
import type { TeampayBrand } from "./teampay";

export const CLUB_EVENT_STATUSES = ["draft", "open", "closed"] as const;
export type ClubEventStatus = (typeof CLUB_EVENT_STATUSES)[number];

export const ORDER_STATUSES = ["pending", "paid", "cancelled", "refunded"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const STRIPE_ACCOUNTS = ["club", "trust"] as const;
export type StripeAccountKey = (typeof STRIPE_ACCOUNTS)[number];

/** A pending order holds its seats this long (mirrors the DB trigger). */
export const PENDING_HOLD_MINUTES = 30;

/** Hard ceiling on one purchase, whatever the event says. */
export const ABSOLUTE_MAX_PER_ORDER = 50;

export function isClubEventStatus(v: unknown): v is ClubEventStatus {
  return typeof v === "string" && (CLUB_EVENT_STATUSES as readonly string[]).includes(v);
}
export function isStripeAccountKey(v: unknown): v is StripeAccountKey {
  return typeof v === "string" && (STRIPE_ACCOUNTS as readonly string[]).includes(v);
}

// ── brands ───────────────────────────────────────────────────────────────────
// Same shape as Team Pay's brand so the public pages reuse its shell components.
// CUFC values verbatim from apps/cufc-website/tailwind.config.js — navy
// #0C1640 ground, ink #13182F cards, royal #263996, Chatham gold #D4AF37.
export const CLUB_EVENT_BRANDS: Record<string, TeampayBrand & { royal: string; crest: string; siteName: string; siteUrl: string }> = {
  cufc: {
    bg: "#0C1640",
    ink: "#FFFFFF",
    accent: "#D4AF37",
    onAccent: "#0C1640",
    mute: "#AEB8D6",
    card: "#13182F",
    line: "#26305A",
    fontHeading: "'Oswald', 'Arial Narrow', system-ui, sans-serif",
    fontBody: "'Inter', system-ui, sans-serif",
    royal: "#263996",
    crest: "/logos/christchurch-united.png",
    siteName: "Christchurch United FC",
    siteUrl: "https://cufc.co.nz",
  },
};
export function clubEventBrand(key?: string | null) {
  return (key && CLUB_EVENT_BRANDS[key]) || CLUB_EVENT_BRANDS.cufc;
}

// ── pricing ──────────────────────────────────────────────────────────────────
export interface TicketTypeLike {
  id: number;
  name: string;
  priceCents: number;
  salesStart: Date | string | null;
  salesEnd: Date | string | null;
  quantityCap: number | null;
  sort: number;
  isActive: boolean;
}

const ms = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : null);

/** Is this type on sale at `now`? Windows are [start, end). */
export function typeOnSale(t: TicketTypeLike, now: Date = new Date()): boolean {
  if (!t.isActive) return false;
  const n = now.getTime();
  const s = ms(t.salesStart);
  const e = ms(t.salesEnd);
  if (s !== null && n < s) return false;
  if (e !== null && n >= e) return false;
  return true;
}

/**
 * The type a buyer gets right now: the on-sale type with the lowest sort,
 * then the lowest price. NULL when nothing is on sale.
 */
export function currentTicketType<T extends TicketTypeLike>(types: T[], now: Date = new Date()): T | null {
  const live = types.filter((t) => typeOnSale(t, now));
  live.sort((a, b) => a.sort - b.sort || a.priceCents - b.priceCents);
  return live[0] ?? null;
}

/** The next type to open after `now` (for "then $165 from 1 October"). */
export function nextTicketType<T extends TicketTypeLike>(types: T[], now: Date = new Date()): T | null {
  const n = now.getTime();
  const later = types.filter((t) => t.isActive && ms(t.salesStart) !== null && (ms(t.salesStart) as number) > n);
  later.sort((a, b) => (ms(a.salesStart) as number) - (ms(b.salesStart) as number) || a.sort - b.sort);
  return later[0] ?? null;
}

// ── NZ dates ─────────────────────────────────────────────────────────────────
// A sales window is typed as an NZ calendar date. "Until 1 October" means the
// window closes at 00:00 NZ on 1 October — the last purchase is 30 Sep 23:59.
const NZ = "Pacific/Auckland";

/** UTC instant of `yyyy-mm-dd` at `HH:MM` NZ local time. DST-correct. */
export function nzLocalToUtc(dateIso: string, hhmm = "00:00"): Date {
  const [y, m, d] = dateIso.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  // First guess: treat the wall time as UTC, then correct by the zone offset
  // at that instant. Two passes handle a DST edge on the day itself.
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const offset = nzOffsetMinutes(new Date(guess));
    guess = Date.UTC(y, m - 1, d, hh, mm) - offset * 60_000;
  }
  return new Date(guess);
}

function nzOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-NZ", {
    timeZone: NZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(at);
  const g = (k: string) => Number(parts.find((p) => p.type === k)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** `yyyy-mm-dd` of an instant in NZ. */
export function nzDateIso(at: Date | string): string {
  const d = new Date(at);
  const parts = new Intl.DateTimeFormat("en-NZ", { timeZone: NZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (k: string) => parts.find((p) => p.type === k)?.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
/** "HH:MM" of an instant in NZ. */
export function nzTimeHm(at: Date | string): string {
  const d = new Date(at);
  const parts = new Intl.DateTimeFormat("en-NZ", { timeZone: NZ, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const g = (k: string) => parts.find((p) => p.type === k)?.value;
  return `${g("hour")}:${g("minute")}`;
}

/** "Friday 13 November 2026" */
export function nzLongDate(at: Date | string): string {
  return new Intl.DateTimeFormat("en-NZ", { timeZone: NZ, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(at));
}
/** "1 October" */
export function nzShortDate(at: Date | string): string {
  return new Intl.DateTimeFormat("en-NZ", { timeZone: NZ, day: "numeric", month: "long" }).format(new Date(at));
}
/** "5.30pm" — the club's house style, no leading zero, dot not colon. */
export function nzClock(at: Date | string): string {
  const [h, m] = nzTimeHm(at).split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}.${String(m).padStart(2, "0")}${ampm}`;
}

// ── money ────────────────────────────────────────────────────────────────────
/** "$150" or "$57.50" — whole dollars stay whole. */
export function dollars(cents: number | null | undefined): string {
  const c = cents ?? 0;
  return c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`;
}

// ── validation ───────────────────────────────────────────────────────────────
export function normaliseEmail(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}
export function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
/** Loose NZ/intl phone check: at least 7 digits once formatting is stripped. */
export function isPhone(v: string): boolean {
  return v.replace(/[^\d]/g, "").length >= 7;
}
export function clampQuantity(q: unknown, max: number): number | null {
  const n = Number(q);
  if (!Number.isInteger(n)) return null;
  if (n < 1 || n > Math.min(max, ABSOLUTE_MAX_PER_ORDER)) return null;
  return n;
}
