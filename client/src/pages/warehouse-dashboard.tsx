// Warehouse dashboard (T16a, SPEC §4.4) — the `/admin/warehouse` landing
// page: stock health, pending requisitions, overdue loans, sync drift
// alerts, and the ledger's recent tail. One aggregated read from
// `GET /api/admin/warehouse/dashboard` (added this task — no prior
// endpoint computed any of this). Visual style matches `prints-dashboard.tsx`
// (dark premium stat cards + feed panels) since this is the same "workspace
// landing page" role for the warehouse feature that prints-dashboard plays
// for United Prints' print-shop side.
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Package, AlertTriangle, ClipboardList, Clock, RefreshCw, ArrowRight, Boxes, ScanLine,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { BRAND_OWNER_LABELS, MOVEMENT_TYPE_LABELS, REASON_CODE_LABELS } from "@shared/warehouse";

interface DashboardLowStockItem {
  id: number;
  sku: string;
  name: string;
  brandOwner: string;
  minQty: number;
  onHand: number;
}
interface DashboardRequisition {
  id: number;
  chargeTo: string;
  status: string;
  neededBy: string | null;
  requesterName: string;
}
interface DashboardLoan {
  id: number;
  borrowerName: string;
  dueOn: string;
  overdue: boolean;
}
interface DashboardDriftAlert {
  itemId: number;
  store: string;
  lastPushedQty: string | null;
  lastDriftAt: string;
  driftNote: string | null;
  itemSku: string;
  itemName: string;
}
interface DashboardMovement {
  id: number;
  delta: string;
  movementType: string;
  reasonCode: string | null;
  createdAt: string;
  itemSku: string;
  itemName: string;
  locationCode: string;
  operatorName: string;
}
interface DashboardData {
  activeItemCount: number;
  lowStockItems: DashboardLowStockItem[];
  lowStockCount: number;
  pendingRequisitions: DashboardRequisition[];
  pendingRequisitionsCount: number;
  overdueLoans: DashboardLoan[];
  overdueLoansCount: number;
  driftAlerts: DashboardDriftAlert[];
  driftAlertsCount: number;
  recentMovements: DashboardMovement[];
}

function qty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  return new Date(`${d}T00:00:00`).toLocaleDateString("en-NZ", { day: "numeric", month: "short" });
}

function fmtDateTime(d: string): string {
  return new Date(d).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function WarehouseDashboard() {
  const [, setLocation] = useLocation();

  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ["/api/admin/warehouse/dashboard"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/dashboard")).json(),
  });

  const cards = [
    { label: "Active items", value: data?.activeItemCount ?? 0, sub: "In the catalog", icon: Package, accent: "blue" },
    { label: "Low stock", value: data?.lowStockCount ?? 0, sub: "Below reorder point", icon: AlertTriangle, accent: data && data.lowStockCount > 0 ? "amber" : "green" },
    { label: "Pending requisitions", value: data?.pendingRequisitionsCount ?? 0, sub: "Awaiting pick/collection", icon: ClipboardList, accent: "purple" },
    { label: "Overdue loans", value: data?.overdueLoansCount ?? 0, sub: "Past their due date", icon: Clock, accent: data && data.overdueLoansCount > 0 ? "red" : "green" },
  ];

  const accentClass = (a: string) => ({
    blue: "bg-blue-500/10 text-blue-400",
    green: "bg-emerald-500/10 text-emerald-400",
    purple: "bg-purple-500/10 text-purple-400",
    amber: "bg-amber-500/10 text-amber-400",
    red: "bg-red-500/10 text-red-400",
  } as Record<string, string>)[a] ?? "bg-white/5 text-white/40";

  if (isLoading) {
    return <div className="p-6 text-white/40">Loading dashboard...</div>;
  }

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Warehouse</h1>
          <p className="text-sm text-white/40 mt-0.5">Stock health across every bin, requisition and loan.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setLocation("/admin/warehouse/scan")}
            className="px-3 py-2 rounded-lg text-xs text-white/70 bg-white/[0.04] border border-white/10 hover:bg-white/[0.08] flex items-center gap-1.5"
          >
            <ScanLine className="w-3.5 h-3.5" /> Scan station
          </button>
          <button
            onClick={() => setLocation("/admin/warehouse/items")}
            className="px-3 py-2 rounded-lg text-xs text-white bg-blue-600 hover:bg-blue-700 flex items-center gap-1.5"
          >
            Browse items <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-2xl border border-white/5 bg-white/[0.02] p-5 flex items-start justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-white/40 mb-1">{c.label}</div>
              <div className="text-3xl font-bold text-white">{c.value}</div>
              <div className="text-[11px] text-white/40 mt-1">{c.sub}</div>
            </div>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${accentClass(c.accent)}`}>
              <c.icon className="w-5 h-5" />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Low stock */}
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white/70 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" /> Low stock
            </h2>
            <button onClick={() => setLocation("/admin/warehouse/items")} className="text-xs text-blue-400/70 hover:text-blue-400">View items</button>
          </div>
          {(!data?.lowStockItems || data.lowStockItems.length === 0) ? (
            <div className="py-8 text-center text-sm text-white/30">Nothing below its reorder point.</div>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {data.lowStockItems.map((i) => (
                <div key={i.id} className="flex items-center gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/5">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white font-mono truncate">{i.sku}</div>
                    <div className="text-[11px] text-white/40 truncate">{i.name} · {BRAND_OWNER_LABELS[i.brandOwner as keyof typeof BRAND_OWNER_LABELS] ?? i.brandOwner}</div>
                  </div>
                  <span className="text-xs font-mono text-amber-400 flex-shrink-0">{qty(i.onHand)} / {qty(i.minQty)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pending requisitions */}
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white/70 flex items-center gap-1.5">
              <ClipboardList className="w-3.5 h-3.5 text-purple-400" /> Pending requisitions
            </h2>
            <button onClick={() => setLocation("/admin/warehouse/requisitions")} className="text-xs text-blue-400/70 hover:text-blue-400">View all</button>
          </div>
          {(!data?.pendingRequisitions || data.pendingRequisitions.length === 0) ? (
            <div className="py-8 text-center text-sm text-white/30">Nothing waiting on approval or picking.</div>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {data.pendingRequisitions.map((r) => (
                <div key={r.id} className="flex items-center gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/5">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white truncate">{r.chargeTo} · {r.requesterName}</div>
                    <div className="text-[11px] text-white/40">Needed by {fmtDate(r.neededBy)}</div>
                  </div>
                  <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-white/[0.04] text-white/60 flex-shrink-0">
                    {r.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Overdue loans */}
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white/70 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-red-400" /> Overdue loans
            </h2>
            <button onClick={() => setLocation("/admin/warehouse/loans")} className="text-xs text-blue-400/70 hover:text-blue-400">View all</button>
          </div>
          {(!data?.overdueLoans || data.overdueLoans.length === 0) ? (
            <div className="py-8 text-center text-sm text-white/30">Nothing overdue.</div>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {data.overdueLoans.map((l) => (
                <div key={l.id} className="flex items-center gap-3 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white truncate">{l.borrowerName}</div>
                    <div className="text-[11px] text-red-300/70">Due {fmtDate(l.dueOn)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Drift alerts */}
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white/70 flex items-center gap-1.5">
              <RefreshCw className="w-3.5 h-3.5 text-orange-400" /> Sync drift
            </h2>
            <button onClick={() => setLocation("/admin/warehouse/sync")} className="text-xs text-blue-400/70 hover:text-blue-400">Open sync</button>
          </div>
          {(!data?.driftAlerts || data.driftAlerts.length === 0) ? (
            <div className="py-8 text-center text-sm text-white/30">No unexplained drift against Shopify.</div>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {data.driftAlerts.map((d) => (
                <div key={`${d.itemId}-${d.store}`} className="flex items-center gap-3 p-3 rounded-lg bg-orange-500/5 border border-orange-500/20">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white font-mono truncate">{d.itemSku}</div>
                    <div className="text-[11px] text-orange-300/70 truncate">{d.driftNote ?? `Drift on ${d.store}`} · {fmtDateTime(d.lastDriftAt)}</div>
                  </div>
                  <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-white/[0.04] text-white/60 flex-shrink-0">{d.store}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Recent movements feed */}
      <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-white/70 flex items-center gap-1.5">
            <Boxes className="w-3.5 h-3.5 text-blue-400" /> Recent movements
          </h2>
          <button onClick={() => setLocation("/admin/warehouse/ledger")} className="text-xs text-blue-400/70 hover:text-blue-400">Full ledger</button>
        </div>
        {(!data?.recentMovements || data.recentMovements.length === 0) ? (
          <div className="py-10 text-center">
            <Boxes className="w-8 h-8 text-white/15 mx-auto mb-2" />
            <p className="text-sm text-white/40">No stock movements posted yet.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {data.recentMovements.map((m) => {
              const delta = Number(m.delta);
              return (
                <div key={m.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-white/[0.02] border border-white/5">
                  <span className={`text-sm font-mono w-20 flex-shrink-0 ${delta >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {delta >= 0 ? "+" : ""}{qty(delta)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white truncate">{m.itemSku} <span className="text-white/40">· {m.itemName}</span></div>
                    <div className="text-[11px] text-white/40 truncate">
                      {m.locationCode} · {m.operatorName}
                      {m.reasonCode && ` · ${REASON_CODE_LABELS[m.reasonCode as keyof typeof REASON_CODE_LABELS] ?? m.reasonCode}`}
                    </div>
                  </div>
                  <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-white/[0.04] text-white/60 flex-shrink-0">
                    {MOVEMENT_TYPE_LABELS[m.movementType as keyof typeof MOVEMENT_TYPE_LABELS] ?? m.movementType}
                  </span>
                  <span className="text-[11px] text-white/30 flex-shrink-0 w-24 text-right">{fmtDateTime(m.createdAt)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
