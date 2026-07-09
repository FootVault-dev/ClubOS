import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3, DollarSign, Eye, Image as ImageIcon, ShoppingBag, ExternalLink, Loader2,
} from "lucide-react";

// The CIC store's public "burned preview" (watermarked, downsized) WebP — the
// same asset the storefront serves. Used only as a leaderboard thumbnail.
const PREVIEW_BASE = "https://content.cicyouth.com/photos/cic2026";
const STORE_URL = "https://content.cicyouth.com";

type PhotoRow = { id: string; impression: number; view: number; quickview: number; click: number; addtocart: number; purchase: number };
type Metric = keyof Omit<PhotoRow, "id">;
type Order = {
  order_ref: string | null;
  order_number: string | null;
  email: string;
  name: string | null;
  qty: number | null;
  total_cents: number | null;
  discount_code: string | null;
  status: string;
  created_at: string;
  paid_at: string | null;
};
type Data = {
  totals: Record<string, number>;
  revenueCents: number;
  paidOrders: number;
  photosSold: number;
  totalViews: number;
  visitsBySource: Record<string, number>;
  perPhoto: PhotoRow[];
  orders: Order[];
  generatedAt: string;
};

const METRICS: { key: Metric; label: string }[] = [
  { key: "impression", label: "Impressions" },
  { key: "view", label: "Views" },
  { key: "quickview", label: "Quick views" },
  { key: "click", label: "Clicks" },
  { key: "addtocart", label: "Add to cart" },
  { key: "purchase", label: "Purchased" },
];

const dollars = (cents: number | null | undefined) =>
  `$${(((cents || 0) as number) / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function Kpi({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-5">
      <div className="flex items-center gap-2 text-white/45">
        <Icon className="h-4 w-4 text-amber-300" />
        <span className="text-[11px] font-bold uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-2 text-3xl font-bold text-white">{value}</p>
    </div>
  );
}

export default function ContentMarketplace() {
  const { data, isLoading, error } = useQuery<Data>({ queryKey: ["/api/admin/cic/content-marketplace"] });
  const [sort, setSort] = useState<Metric>("purchase");

  const rows = useMemo(() => {
    if (!data) return [];
    return [...data.perPhoto].sort((a, b) => (b[sort] || 0) - (a[sort] || 0)).slice(0, 60);
  }, [data, sort]);

  const t = data?.totals || {};

  return (
    <div className="p-4 sm:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <BarChart3 className="h-6 w-6 text-amber-300" /> Content Marketplace
          </h1>
          <p className="text-sm text-white/40 mt-1">
            Live sales &amp; engagement for the CIC photo store at{" "}
            <a href={STORE_URL} target="_blank" rel="noreferrer" className="text-amber-300 hover:text-amber-200 inline-flex items-center gap-1">
              content.cicyouth.com <ExternalLink className="w-3 h-3" />
            </a>
          </p>
        </div>
        {data?.generatedAt && (
          <span className="text-[11px] text-white/30">Updated {fmtDate(data.generatedAt)}</span>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-white/40 text-sm py-16 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading analytics…
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Couldn't load analytics: {(error as any)?.message || "unknown error"}
        </div>
      )}

      {data && (
        <>
          {/* KPIs */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi icon={DollarSign} label="Total revenue" value={dollars(data.revenueCents)} />
            <Kpi icon={ShoppingBag} label="Paid orders" value={String(data.paidOrders || 0)} />
            <Kpi icon={ImageIcon} label="Photos sold" value={String(data.photosSold || 0)} />
            <Kpi icon={Eye} label="Total views" value={String(data.totalViews || 0)} />
          </div>

          {/* Funnel */}
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wide text-white/40 mb-2">Funnel</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {[...METRICS, { key: "visit" as any, label: "Visits" }].map((m) => (
                <div key={m.key} className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-white/40">{m.label}</p>
                  <p className="mt-1 text-xl font-bold text-white tabular-nums">{t[m.key] || 0}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Traffic sources */}
          {Object.keys(data.visitsBySource || {}).length > 0 && (
            <div>
              <h2 className="text-xs font-bold uppercase tracking-wide text-white/40 mb-2">Where visitors come from</h2>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.visitsBySource)
                  .sort((a, b) => b[1] - a[1])
                  .map(([src, n]) => (
                    <span key={src} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] px-3.5 py-1.5 text-sm">
                      <span className="font-semibold text-white/80">{src}</span>
                      <span className="font-bold text-amber-300 tabular-nums">{n}</span>
                    </span>
                  ))}
              </div>
            </div>
          )}

          {/* Per-photo leaderboard */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-white">Photo leaderboard</h2>
            <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
              {METRICS.map((m) => (
                <button
                  key={m.key}
                  onClick={() => setSort(m.key)}
                  data-testid={`cm-sort-${m.key}`}
                  className={`shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition ${
                    sort === m.key
                      ? "border-amber-400 bg-amber-500/15 text-amber-300"
                      : "border-white/10 bg-white/[0.02] text-white/60 hover:text-white"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-white/5">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-white/5 bg-white/[0.02] text-left text-[11px] uppercase tracking-wide text-white/40">
                  <th className="px-4 py-3 font-bold">Photo</th>
                  {METRICS.map((m) => (
                    <th key={m.key} className="px-3 py-3 text-right font-bold">{m.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="h-9 w-9 shrink-0 overflow-hidden rounded-md border border-white/10 bg-black/40">
                          <img
                            src={`${PREVIEW_BASE}/${r.id}.webp`}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
                          />
                        </div>
                        <span className="truncate font-mono text-xs text-white/80">{r.id}</span>
                      </div>
                    </td>
                    {METRICS.map((m) => (
                      <td key={m.key} className={`px-3 py-2.5 text-right tabular-nums ${sort === m.key ? "font-bold text-amber-300" : "text-white/70"}`}>
                        {r[m.key] || 0}
                      </td>
                    ))}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-white/40">
                      No engagement recorded yet — data appears as people browse.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Orders */}
          <h2 className="text-lg font-bold text-white">Orders</h2>
          <div className="overflow-x-auto rounded-xl border border-white/5">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-white/5 bg-white/[0.02] text-left text-[11px] uppercase tracking-wide text-white/40">
                  <th className="px-4 py-3 font-bold">Order</th>
                  <th className="px-4 py-3 font-bold">Customer</th>
                  <th className="px-3 py-3 text-right font-bold">Photos</th>
                  <th className="px-3 py-3 text-right font-bold">Total</th>
                  <th className="px-3 py-3 font-bold">Status</th>
                  <th className="px-3 py-3 font-bold">When</th>
                </tr>
              </thead>
              <tbody>
                {(data.orders || []).map((o, i) => (
                  <tr key={o.order_number || o.order_ref || i} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-2.5 font-semibold text-white/80">{o.order_number || o.order_ref || "—"}</td>
                    <td className="px-4 py-2.5 text-white/60">
                      <div className="truncate">{o.name || "—"}</div>
                      <div className="truncate text-xs text-white/35">{o.email}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-white/70">{o.qty ?? 0}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-white/80">{dollars(o.total_cents)}</td>
                    <td className="px-3 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                        o.status === "paid" ? "bg-emerald-400/15 text-emerald-300" : "bg-white/10 text-white/50"
                      }`}>
                        {o.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-white/50 whitespace-nowrap">{fmtDate(o.created_at)}</td>
                  </tr>
                ))}
                {(data.orders || []).length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-white/40">No orders yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
