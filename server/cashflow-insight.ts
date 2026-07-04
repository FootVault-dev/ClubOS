/**
 * Club-wide cashflow insight — the "why" layer on top of the Xero P&L.
 *
 * Source: Christchurch United FC Inc / USG Xero Profit & Loss, 15 complete
 * months (Apr 2025 – Jun 2026), reconciled exactly to Xero's own Net Profit row.
 * This is a DECISION GUIDE, not the official accounts.
 *
 * Data note: a curated monthly snapshot pulled and reconciled on 2026-07-04.
 * The live Budget → Xero sync (`xeroActuals`) is the next step to make this
 * self-refreshing; until then these are fixed figures. 2026 months are on a
 * cash basis, 2025 on accrual — trust the seasonal *shape*, not month-for-month
 * 2025-vs-2026 deltas.
 *
 * "Donations" = the owner / related-party prop that covers the deficit =
 * Xero "Donations" + "Fundraising" accounts (this is how the club is actually
 * kept solvent each month). Operating net strips it out to show the real
 * trading result.
 *
 * Served only to super_admin (see requireTab("cashflow") + SUPER_ADMIN_ONLY_TABS)
 * because it exposes staff-wage-level financials.
 */

export interface CashflowMonth {
  period: string; // YYYY-MM
  income: number; // Total Income
  cos: number; // Total Cost of Sales
  opex: number; // Total Operating Expenses
  otherIncome: number; // Total Other Income
  net: number; // Xero Net Profit (reconciles)
  donations: number; // Donations + Fundraising
  wages: number | null; // Wages – Admin & Coaching (2026 only; null before)
}

// Raw monthly rows, in dollars, straight from Xero (Total-row values only, so
// no double counting). Net Profit reconciles to Xero for every month.
const MONTHS: CashflowMonth[] = [
  { period: "2025-04", income: 215149.70, cos: 43966.06, opex: 93476.73, otherIncome: 10434.99, net: 88141.90, donations: 8729.28, wages: null },
  { period: "2025-05", income: 114464.67, cos: 54201.55, opex: 94762.71, otherIncome: 310.00, net: -34189.59, donations: 0, wages: null },
  { period: "2025-06", income: 74194.99, cos: 28855.52, opex: 74993.67, otherIncome: 1734.46, net: -27919.74, donations: 3488.00, wages: null },
  { period: "2025-07", income: 200473.11, cos: 65920.14, opex: 128393.15, otherIncome: 7892.35, net: 14052.17, donations: 34227.36, wages: null },
  { period: "2025-08", income: 61685.00, cos: 21105.28, opex: 79285.82, otherIncome: 575.76, net: -38130.34, donations: 0, wages: null },
  { period: "2025-09", income: 158911.25, cos: 42039.49, opex: 86290.38, otherIncome: 1965.22, net: 32546.60, donations: 0, wages: null },
  { period: "2025-10", income: 84607.52, cos: 57972.45, opex: 80252.72, otherIncome: 6692.16, net: -46925.49, donations: 0, wages: null },
  { period: "2025-11", income: 46275.63, cos: 27003.07, opex: 72813.56, otherIncome: 1582.56, net: -51958.44, donations: 7450.99, wages: null },
  { period: "2025-12", income: 208126.03, cos: 77990.73, opex: 162363.71, otherIncome: 4944.51, net: -27283.90, donations: 204073.47, wages: null },
  { period: "2026-01", income: 270404.04, cos: 100509.26, opex: 144588.06, otherIncome: 6646.51, net: 31953.23, donations: 160546.28, wages: 85042.26 },
  { period: "2026-02", income: 218157.77, cos: 94826.12, opex: 179321.51, otherIncome: 54591.01, net: -1398.85, donations: 116000.00, wages: 111057.48 },
  { period: "2026-03", income: 226732.11, cos: 39819.53, opex: 174984.27, otherIncome: 7278.52, net: 19206.83, donations: 132488.00, wages: 111980.55 },
  { period: "2026-04", income: 266852.66, cos: 93970.32, opex: 162192.65, otherIncome: 15571.74, net: 26261.43, donations: 70000.00, wages: 117497.24 },
  { period: "2026-05", income: 189298.10, cos: 62150.66, opex: 203843.68, otherIncome: 38955.18, net: -37741.06, donations: 38000.00, wages: 91821.84 },
  { period: "2026-06", income: 103975.30, cos: 45164.07, opex: 126135.12, otherIncome: 4018.57, net: -63305.32, donations: 3329.13, wages: 94303.82 },
];

// Winter (May–Aug) = the danger zone: operating income thins while wages run flat.
// Summer (Nov–Apr, peaking Jan–Apr) = the strong inflow window.
const WINTER = new Set([5, 6, 7, 8]);

function monthNum(period: string): number {
  return parseInt(period.slice(5, 7), 10);
}

const round = (n: number) => Math.round(n * 100) / 100;

export function buildCashflowInsight() {
  const months = MONTHS.map((m) => ({
    ...m,
    operatingNet: round(m.net - m.donations), // real trading result, ex-donation prop
    season: WINTER.has(monthNum(m.period)) ? "winter" : "summer",
  }));

  // Last 6 complete months (the cash-basis window) — the truest read of the burn.
  const last6 = months.slice(-6);
  const opNet6 = last6.reduce((s, m) => s + m.operatingNet, 0);
  const donations6 = last6.reduce((s, m) => s + m.donations, 0);
  const avgOperatingBurn = round(opNet6 / last6.length);

  const wagesMonths = months.filter((m) => m.wages != null) as Array<typeof months[number] & { wages: number }>;
  const avgWages = wagesMonths.length
    ? round(wagesMonths.reduce((s, m) => s + m.wages, 0) / wagesMonths.length)
    : null;

  const latest = months[months.length - 1];

  const summer = months.filter((m) => m.season === "summer");
  const winter = months.filter((m) => m.season === "winter");
  const avgIncome = (arr: typeof months) => (arr.length ? round(arr.reduce((s, m) => s + m.income, 0) / arr.length) : 0);

  return {
    generatedFor: "united-sports-group",
    dataThrough: "2026-06",
    monthsCount: months.length,
    basisNote:
      "Xero P&L, reconciled to Xero's Net Profit. 2026 = cash basis, 2025 = accrual. A decision guide, not the official accounts.",
    donationsDef: 'Owner / related-party prop = Xero "Donations" + "Fundraising".',
    months,
    summary: {
      avgOperatingBurn, // ≈ −$90.9k/mo
      annualisedBurn: round(avgOperatingBurn * 12), // ≈ −$1.09m/yr
      donationsLast6: round(donations6), // what kept it solvent
      operatingLossLast6: round(opNet6),
      avgWages, // the fixed anchor (~$100k/mo, 2026)
      latest: {
        period: latest.period,
        net: latest.net,
        donations: latest.donations,
        operatingNet: latest.operatingNet,
      },
    },
    seasonal: {
      summerAvgIncome: avgIncome(summer),
      winterAvgIncome: avgIncome(winter),
      strongWindow: "Jan–Apr",
      dangerZone: "May–Aug",
    },
    guidance: [
      "Treat donations as a scheduled inflow with a forecast — not a safety net. Flag any month with no cover 4–6 weeks out.",
      "Build a winter buffer from the strong Jan–Apr window (Academy intake + CIC entries + camps + uniform all stack).",
      "Time discretionary spend to the inflow calendar — large flexible costs are safest Jan–Apr, not May–Aug.",
      "Forecast the plannable inflows: Academy fees, CIC entries (Mar–Jun), holiday camps, uniform, plus the donation top-up. Sponsorship & grants are upside, too lumpy to rely on.",
      "Payroll (~$100k/mo) is the immovable date — the view should always answer first: is payroll covered this month and next?",
    ],
  };
}
