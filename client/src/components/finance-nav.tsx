import { Link, useLocation } from "wouter";

/**
 * Shared top menu for the USG finance area (Budget · Cashflow · Xero).
 * Rendered at the top of every finance page so they read as one area.
 * Add new views here as finance grows — this is the single place to extend.
 */
const ITEMS: { label: string; url: string; match: (p: string) => boolean }[] = [
  { label: "Overview", url: "/admin/budget", match: (p) => p === "/admin/budget" || p.startsWith("/admin/budget/cost-centres") },
  { label: "Cashflow", url: "/admin/cashflow", match: (p) => p === "/admin/cashflow" },
  { label: "Xero actuals", url: "/admin/budget/xero", match: (p) => p.startsWith("/admin/budget/xero") },
];

export function FinanceNav() {
  const [location] = useLocation();
  return (
    <div className="border-b border-white/[0.07] mb-6">
      <nav className="flex gap-1 -mb-px overflow-x-auto">
        {ITEMS.map((it) => {
          const active = it.match(location);
          return (
            <Link
              key={it.url}
              href={it.url}
              className={`whitespace-nowrap px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                active
                  ? "border-blue-400 text-white"
                  : "border-transparent text-white/45 hover:text-white/80 hover:border-white/15"
              }`}
            >
              {it.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
