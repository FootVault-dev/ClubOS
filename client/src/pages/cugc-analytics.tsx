// CUGC — Enrolment Analytics.
// Lives in the Gymnastics workspace → Analytics tab. Aggregates come straight
// from the cugc_registrations table (via /api/admin/cugc/analytics). Page-view /
// ad analytics are tracked separately by the Meta Pixel on cugc.co.nz and are
// out of scope for this DB view.
import { useQuery } from "@tanstack/react-query";
import { BarChart3, DollarSign, Users, Clock, XCircle } from "lucide-react";

interface Analytics {
  totals: { total: number; paid: number; pending: number; cancelled: number; revenueCents: number };
  byProgram: { programSlug: string; programName: string; total: number; paid: number; revenueCents: number }[];
  overTime: { date: string; count: number }[];
  recent: {
    id: number; gymnastName: string; programName: string; optionLabel: string;
    priceCents: number; status: string; createdAt: string;
  }[];
}

const STATUS_STYLE: Record<string, string> = {
  paid: "text-emerald-300 bg-emerald-400/10 border-emerald-400/25",
  pending_payment: "text-amber-300 bg-amber-400/10 border-amber-400/25",
  cancelled: "text-white/40 bg-white/[0.04] border-white/10",
};
const STATUS_LABEL: Record<string, string> = { paid: "Paid", pending_payment: "Pending", cancelled: "Cancelled" };

function money(cents: number): string {
  return `$${Math.round((cents || 0) / 100).toLocaleString("en-NZ")}`;
}
function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short" }); } catch { return iso; }
}

export default function CugcAnalytics() {
  const { data, isLoading } = useQuery<Analytics>({ queryKey: ["/api/admin/cugc/analytics"] });

  const maxDay = Math.max(1, ...(data?.overTime.map((d) => d.count) || [1]));

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white/90 flex items-center gap-2.5">
          <BarChart3 className="w-6 h-6 text-blue-400" />
          CUGC — Enrolment Analytics
        </h1>
        <p className="text-sm text-white/40 mt-1">Enrolments, revenue and program mix from the cugc.co.nz enrol flow.</p>
      </div>

      {isLoading || !data ? (
        <div className="text-white/40 text-sm py-16 text-center">Loading analytics…</div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={<Users className="w-5 h-5 text-blue-300" />} label="Total enrolments" value={String(data.totals.total)} />
            <StatCard icon={<DollarSign className="w-5 h-5 text-emerald-300" />} label={`Revenue (${data.totals.paid} paid)`} value={money(data.totals.revenueCents)} />
            <StatCard icon={<Clock className="w-5 h-5 text-amber-300" />} label="Pending payment" value={String(data.totals.pending)} />
            <StatCard icon={<XCircle className="w-5 h-5 text-white/40" />} label="Cancelled" value={String(data.totals.cancelled)} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* By program */}
            <div className="rounded-2xl border border-white/[0.06] p-5">
              <h2 className="text-sm font-semibold text-white/70 mb-4">By program</h2>
              {data.byProgram.length === 0 ? (
                <p className="text-white/35 text-sm">No enrolments yet.</p>
              ) : (
                <div className="space-y-3">
                  {data.byProgram.map((p) => (
                    <div key={p.programSlug} className="flex items-center justify-between text-sm">
                      <div>
                        <p className="text-white/85">{p.programName}</p>
                        <p className="text-white/40 text-xs">{p.paid} paid · {p.total} total</p>
                      </div>
                      <span className="text-white/80 font-medium">{money(p.revenueCents)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Over time */}
            <div className="rounded-2xl border border-white/[0.06] p-5">
              <h2 className="text-sm font-semibold text-white/70 mb-4">Enrolments over time</h2>
              {data.overTime.length === 0 ? (
                <p className="text-white/35 text-sm">No enrolments yet.</p>
              ) : (
                <div className="space-y-2">
                  {data.overTime.slice(-14).map((d) => (
                    <div key={d.date} className="flex items-center gap-3 text-xs">
                      <span className="w-14 text-white/45 shrink-0">{fmtDate(d.date)}</span>
                      <div className="flex-1 h-2.5 rounded-full bg-white/[0.05] overflow-hidden">
                        <div className="h-full rounded-full bg-blue-400/60" style={{ width: `${(d.count / maxDay) * 100}%` }} />
                      </div>
                      <span className="w-6 text-right text-white/60">{d.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Recent */}
          <div className="rounded-2xl border border-white/[0.06] p-5">
            <h2 className="text-sm font-semibold text-white/70 mb-4">Recent enrolments</h2>
            {data.recent.length === 0 ? (
              <p className="text-white/35 text-sm">No enrolments yet.</p>
            ) : (
              <div className="space-y-2">
                {data.recent.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-3 text-sm border-b border-white/[0.04] last:border-0 pb-2 last:pb-0">
                    <div className="min-w-0">
                      <p className="text-white/85 truncate">{r.gymnastName}</p>
                      <p className="text-white/40 text-xs truncate">{r.programName} · {r.optionLabel}</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-white/70">{money(r.priceCents)}</span>
                      <span className={`px-2 py-0.5 rounded-md border text-[11px] font-medium ${STATUS_STYLE[r.status] || STATUS_STYLE.cancelled}`}>{STATUS_LABEL[r.status] || r.status}</span>
                      <span className="text-white/40 text-xs w-12 text-right">{fmtDate(r.createdAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="text-xs text-white/30">
            Note: page views, ad clicks and conversion tracking come from the Meta Pixel on cugc.co.nz — those live in Meta Events Manager, not this view. This dashboard reflects enrolment records only.
          </p>
        </>
      )}
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] p-5">
      <div className="flex items-center gap-2 text-white/40 text-xs mb-2">{icon}<span>{label}</span></div>
      <p className="text-2xl font-semibold text-white/90">{value}</p>
    </div>
  );
}
