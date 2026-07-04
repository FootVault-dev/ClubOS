import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend, ReferenceLine,
} from "recharts";
import { TrendingDown, Gift, AlertTriangle, Sun, Snowflake, Wallet, Info } from "lucide-react";

interface Month {
  period: string;
  income: number;
  net: number;
  donations: number;
  operatingNet: number;
  wages: number | null;
  season: string;
}
interface Insight {
  dataThrough: string;
  monthsCount: number;
  basisNote: string;
  donationsDef: string;
  months: Month[];
  summary: {
    avgOperatingBurn: number;
    annualisedBurn: number;
    donationsLast6: number;
    operatingLossLast6: number;
    avgWages: number | null;
    latest: { period: string; net: number; donations: number; operatingNet: number };
  };
  seasonal: { summerAvgIncome: number; winterAvgIncome: number; strongWindow: string; dangerZone: string };
  guidance: string[];
}

const MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Full dollars — the source data is already in dollars, not cents.
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-NZ")}`;
const compact = (n: number) => {
  const a = Math.abs(n);
  const s = n < 0 ? "-" : "";
  if (a >= 1_000_000) return `${s}$${(a / 1_000_000).toFixed(2)}m`;
  if (a >= 1_000) return `${s}$${Math.round(a / 1000)}k`;
  return `${s}$${Math.round(a)}`;
};
const label = (period: string, idx: number) => {
  const y = period.slice(2, 4), m = parseInt(period.slice(5, 7), 10);
  return m === 1 || idx === 0 ? `${MON[m]} ’${y}` : MON[m];
};
const fmtPeriod = (period: string) => `${MON[parseInt(period.slice(5, 7), 10)]} ’${period.slice(2, 4)}`;

export default function GroupCashflowPage() {
  const { data, isLoading, error } = useQuery<Insight>({ queryKey: ["/api/admin/cashflow/insight"] });

  const chartData = useMemo(
    () => (data?.months ?? []).map((m, i) => ({
      month: label(m.period, i),
      donations: Math.round(m.donations),
      net: Math.round(m.net),
      operating: Math.round(m.operatingNet),
    })),
    [data],
  );

  if (isLoading) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <Skeleton className="h-8 w-64 mb-6" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 p-4 text-sm">
          Failed to load cashflow: {(error as Error)?.message ?? "no data"}
        </div>
      </div>
    );
  }

  const s = data.summary;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Cashflow</h1>
        <p className="text-sm text-white/50 mt-1">
          Club-wide (Christchurch United FC Inc / USG) · {data.monthsCount} months to {fmtPeriod(data.dataThrough)}
          <span className="mx-2">·</span>
          <Link href="/admin/budget" className="text-blue-300 hover:text-blue-200">Budget & cost centres</Link>
        </p>
      </div>

      {/* Headline finding */}
      <div className="rounded-2xl border border-amber-400/20 bg-gradient-to-br from-amber-400/[0.06] to-transparent p-5 mb-6">
        <div className="flex items-start gap-3">
          <Gift className="w-5 h-5 text-amber-300 mt-0.5 shrink-0" />
          <div>
            <h2 className="text-lg font-semibold text-white">The club runs on donations.</h2>
            <p className="text-sm text-white/70 mt-1.5 leading-relaxed">
              Strip out the owner / related-party top-up and the club loses about{" "}
              <span className="text-red-300 font-semibold">{compact(s.avgOperatingBurn)}</span> every month
              (~<span className="text-red-300 font-semibold">{compact(s.annualisedBurn)}</span>/yr). Reported profit
              just tracks how much donation lands — <span className="text-white/90">{fmtPeriod(s.latest.period)}</span>{" "}
              printed <span className="text-red-300 font-semibold">{compact(s.latest.net)}</span> because the prop fell
              to <span className="text-amber-200 font-semibold">{compact(s.latest.donations)}</span>. The job of this
              view: make a month with no cover visible weeks ahead.
            </p>
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
        <StatCard icon={<TrendingDown className="w-4 h-4" />} accent="red"
          label="Operating burn / mo" value={compact(s.avgOperatingBurn)} sub="Real trading result, ex-donations" />
        <StatCard icon={<Gift className="w-4 h-4" />} accent="amber"
          label="Donations, last 6 mo" value={compact(s.donationsLast6)} sub="What kept it solvent" />
        <StatCard icon={<Wallet className="w-4 h-4" />} accent="red"
          label={`Latest — ${fmtPeriod(s.latest.period)}`} value={compact(s.latest.net)} sub="Xero net profit" />
        <StatCard icon={<TrendingDown className="w-4 h-4" />} accent="white"
          label="Wages / mo" value={s.avgWages != null ? compact(s.avgWages) : "—"} sub="The fixed anchor (2026)" />
      </div>

      {/* Chart */}
      <section className="mb-8">
        <h2 className="text-xs uppercase tracking-wider font-semibold text-white/40 mb-3">
          Reported net vs real trading result — donations bridge the gap
        </h2>
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="month" stroke="rgba(255,255,255,0.4)" fontSize={10} tickLine={false} axisLine={false} interval={0} angle={-30} textAnchor="end" height={44} />
              <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} />
              <Tooltip
                contentStyle={{ background: "rgba(15,15,18,0.95)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: "rgba(255,255,255,0.6)", fontSize: 11, marginBottom: 4 }}
                formatter={(value: number, name: string) => [money(value), name]}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />
              <Bar dataKey="donations" name="Donations in" fill="rgba(251, 191, 36, 0.5)" radius={[3, 3, 0, 0]} />
              <Line type="monotone" dataKey="net" name="Reported net" stroke="rgba(203, 213, 225, 0.9)" strokeWidth={2} dot={{ r: 2.5 }} />
              <Line type="monotone" dataKey="operating" name="Operating net (ex-donations)" stroke="rgba(248, 113, 113, 0.95)" strokeWidth={2} dot={{ r: 2.5 }} />
            </ComposedChart>
          </ResponsiveContainer>
          <p className="text-[11px] text-white/35 mt-2 px-1">
            Red is the real trading result each month. Where the amber bars rise to meet the grey line, a donation
            covered the gap. When amber shrinks (e.g. {fmtPeriod(s.latest.period)}), the grey line drops toward red.
          </p>
        </div>
      </section>

      {/* Seasonal */}
      <section className="mb-8">
        <h2 className="text-xs uppercase tracking-wider font-semibold text-white/40 mb-3">The seasonal shape</h2>
        <div className="grid md:grid-cols-2 gap-3">
          <div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.04] p-4">
            <div className="flex items-center gap-2 text-emerald-200 text-sm font-semibold"><Sun className="w-4 h-4" /> Strong window · {data.seasonal.strongWindow}</div>
            <p className="text-sm text-white/60 mt-1.5">Avg income <span className="text-white/90 font-semibold tabular-nums">{compact(data.seasonal.summerAvgIncome)}</span>/mo. Academy intake, CIC entries, holiday camps and uniform all stack. Ring-fence surplus here to carry winter.</p>
          </div>
          <div className="rounded-2xl border border-sky-400/15 bg-sky-400/[0.04] p-4">
            <div className="flex items-center gap-2 text-sky-200 text-sm font-semibold"><Snowflake className="w-4 h-4" /> Danger zone · {data.seasonal.dangerZone}</div>
            <p className="text-sm text-white/60 mt-1.5">Avg income <span className="text-white/90 font-semibold tabular-nums">{compact(data.seasonal.winterAvgIncome)}</span>/mo, while wages run flat (~{s.avgWages != null ? compact(s.avgWages) : "$100k"}). This is when the club most needs donation cover or a pre-built buffer.</p>
          </div>
        </div>
      </section>

      {/* Guidance */}
      <section className="mb-8">
        <h2 className="text-xs uppercase tracking-wider font-semibold text-white/40 mb-3">What this means for decisions</h2>
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] divide-y divide-white/[0.04]">
          {data.guidance.map((g, i) => (
            <div key={i} className="flex items-start gap-3 p-4">
              <span className="shrink-0 w-5 h-5 rounded-full bg-blue-500/15 text-blue-200 text-[11px] font-semibold flex items-center justify-center mt-0.5">{i + 1}</span>
              <p className="text-sm text-white/75 leading-relaxed">{g}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Caveat */}
      <div className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-4 flex items-start gap-2.5">
        <Info className="w-4 h-4 text-white/30 mt-0.5 shrink-0" />
        <p className="text-[12px] text-white/40 leading-relaxed">
          {data.basisNote} {data.donationsDef} A curated monthly snapshot through {fmtPeriod(data.dataThrough)} —
          wiring it to the live Budget → Xero sync so it refreshes itself is the next step. Monthly granularity only;
          a true daily cash runway needs dated bank data. Locked to you (super-admin) for now.
        </p>
      </div>
      <div className="flex items-center gap-2 mt-4 text-[12px] text-amber-300/60">
        <AlertTriangle className="w-3.5 h-3.5" /> A decision guide — always reconcile to Xero's own totals before treating any figure as official.
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, sub, accent }: { icon: React.ReactNode; label: string; value: string; sub: string; accent: "red" | "amber" | "white" }) {
  const color = accent === "red" ? "text-red-300" : accent === "amber" ? "text-amber-200" : "text-white";
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="text-[10px] uppercase tracking-wider text-white/40 flex items-center gap-1.5">{icon}{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-[11px] text-white/35 mt-0.5">{sub}</div>
    </div>
  );
}
