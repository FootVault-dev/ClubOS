// ─────────────────────────────────────────────────────────────────────────────
// CUGC term pricing — SERVER-AUTHORITATIVE.
// A faithful mirror of apps/cugc-website/src/lib/pricing.ts (the proration
// engine) plus the Term 3 program/option/price data from
// apps/cugc-website/src/site.ts. The enrol endpoint computes the price from
// THIS module — the client-sent price is always ignored.
// ─────────────────────────────────────────────────────────────────────────────

export const CUGC_TERM = {
  name: "Term 3 2026",
  start: "2026-07-20", // Mon 20 Jul
  end: "2026-09-25",   // Fri 25 Sep
  weeks: 10,
};

export type CugcOption = { label: string; price: number; times: string[] }; // full-term price in NZD
export type CugcProgram = {
  slug: string; title: string; ages: string; image: string; // image = path on cugc.co.nz
  annual?: boolean; inviteOnly?: boolean;
  options: CugcOption[];
};

// Mirrors apps/cugc-website/src/site.ts `programs` (slug, title, ages, options[].label/price/times).
export const CUGC_PROGRAMS: CugcProgram[] = [
  {
    slug: "gymplay",
    title: "GymPlay",
    ages: "3–6 years",
    image: "/img/program-1.jpg",
    options: [
      {
        label: "1–2 sessions per week",
        price: 165,
        times: ["Wednesday 4:00–4:45pm", "Saturday 9:30–10:15am", "Saturday 10:30–11:15am"],
      },
    ],
  },
  {
    slug: "gymbasics",
    title: "GymBasics",
    ages: "5–7 & 8+ years",
    image: "/img/program-2.jpg",
    options: [
      { label: "Ages 5–7 · once a week", price: 250, times: ["Tuesday 4:00–5:30pm", "Saturday 9:00–10:30am"] },
      { label: "Ages 5–7 · twice a week", price: 350, times: ["Tuesday + Saturday"] },
      { label: "Ages 8+ · once a week", price: 195, times: ["Friday 4:00–5:00pm"] },
    ],
  },
  {
    slug: "competitive",
    title: "Competitive Stream — Level 1",
    ages: "By invitation",
    image: "/img/program-3.jpg",
    annual: true,
    inviteOnly: true,
    options: [
      { label: "1× per week (2 hours)", price: 295, times: ["Thursday"] },
      { label: "2× per week (4.5 hours)", price: 565, times: ["Tuesday or Thursday, + Saturday"] },
    ],
  },
];

// ── Discount / test codes for the enrol flow ─────────────────────────────────
// Server-side only (never in the client bundle). Codes are normalised to
// uppercase before lookup. priceCentsOverride REPLACES the computed term price
// for the whole enrolment. Remove test codes once they've served their purpose.
export const CUGC_DISCOUNT_CODES: Record<string, { label: string; priceCentsOverride: number }> = {
  "CUGC-TEST-2741": { label: "Internal $1 end-to-end payment test", priceCentsOverride: 100 },
};

const MS_WEEK = 7 * 24 * 60 * 60 * 1000;

/** Parse a YYYY-MM-DD as a local date (avoids TZ off-by-one). */
function d(iso: string): Date {
  const [y, m, day] = iso.split("-").map(Number);
  return new Date(y, m - 1, day);
}

export type CugcPricing = {
  status: "upcoming" | "active" | "ended";
  fullPrice: number;
  price: number;
  weeksTotal: number;
  weeksLeft: number;
  discountPct: number;
  prorated: boolean;
};

/**
 * Compute today's price for a term-priced program. Identical logic to the
 * website's proratedTermPrice so the price the family saw matches the charge.
 */
export function proratedTermPrice(
  fullPrice: number,
  startIso: string,
  endIso: string,
  weeksTotal: number,
  now: Date = new Date(),
): CugcPricing {
  const start = d(startIso);
  const end = d(endIso);
  const base = { fullPrice, weeksTotal, price: fullPrice, weeksLeft: weeksTotal, discountPct: 0, prorated: false };

  if (now < start) return { ...base, status: "upcoming" };
  if (now >= end) return { ...base, status: "ended", price: fullPrice, weeksLeft: 0 };

  const weeksElapsed = Math.floor((now.getTime() - start.getTime()) / MS_WEEK);
  const weeksLeft = Math.max(1, weeksTotal - weeksElapsed); // always at least 1 week's value
  const price = Math.round((fullPrice * weeksLeft) / weeksTotal);
  const discountPct = Math.round(((fullPrice - price) / fullPrice) * 100);

  return { status: "active", fullPrice, price, weeksTotal, weeksLeft, discountPct, prorated: price < fullPrice };
}

/**
 * Resolve a program + option from the enrol form and price it server-side.
 * Returns null if the program slug or option index is invalid.
 */
export function computeCugcEnrolPrice(
  programSlug: string,
  optionIndex: number,
  now: Date = new Date(),
): { program: CugcProgram; option: CugcOption; pricing: CugcPricing } | null {
  const program = CUGC_PROGRAMS.find((p) => p.slug === programSlug);
  if (!program) return null;
  if (!Number.isInteger(optionIndex)) return null;
  const option = program.options[optionIndex];
  if (!option) return null;
  const pricing = proratedTermPrice(option.price, CUGC_TERM.start, CUGC_TERM.end, CUGC_TERM.weeks, now);
  return { program, option, pricing };
}
