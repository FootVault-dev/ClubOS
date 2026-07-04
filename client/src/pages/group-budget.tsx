import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { FinanceNav } from "@/components/finance-nav";
import { ArrowRight, DollarSign, TrendingDown, TrendingUp, User } from "lucide-react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend, ReferenceLine,
} from "recharts";

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface MonthlyRollupResp {
  year: number;
  centres: Array<{ id: number; name: string; incomeByMonth: number[]; expenseByMonth: number[] }>;
  totals: {
    incomeByMonth: number[];
    expenseByMonth: number[];
    netByMonth: number[];
    cumulativeNetByMonth: number[];
    incomeCents: number;
    expenseCents: number;
    netCents: number;
  };
}

interface CostCentreRow {
  id: number;
  slug: string;
  name: string;
  bucket: string;
  ownerId: number | null;
  ownerName: string | null;
  isVirtual: boolean;
  totalIncomeCents: number;
  totalExpenseCents: number;
  netCents: number;
}

interface RollupResp {
  year: number;
  centres: CostCentreRow[];
  totals: { incomeCents: number; expenseCents: number; netCents: number };
}

const fmtMoney = (cents: number) => {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-NZ", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};

const BUCKET_LABELS: Record<string, string> = {
  operating: "Operating",
  team: "Pro Teams",
  shared: "Shared / Overheads",
  tournament: "Tournaments",
};
const BUCKET_ORDER = ["operating", "team", "tournament", "shared"];

export default function GroupBudgetPage() {
  const year = new Date().getFullYear();
  const { data, isLoading, error } = useQuery<RollupResp>({
    queryKey: ["/api/admin/budget/rollup", `?year=${year}`],
  });
  const monthly = useQuery<MonthlyRollupResp>({
    queryKey: ["/api/admin/budget/rollup-monthly", `?year=${year}`],
  });

  const chartData = useMemo(() => {
    if (!monthly.data) return [];
    const { totals } = monthly.data;
    return MONTH_LABELS.map((label, i) => ({
      month: label,
      income: totals.incomeByMonth[i] / 100,
      expense: -totals.expenseByMonth[i] / 100,
      net: totals.netByMonth[i] / 100,
      cumulative: totals.cumulativeNetByMonth[i] / 100,
    }));
  }, [monthly.data]);

  const grouped = useMemo(() => {
    if (!data) return [] as { bucket: string; rows: CostCentreRow[] }[];
    const byBucket = new Map<string, CostCentreRow[]>();
    for (const c of data.centres) {
      const arr = byBucket.get(c.bucket) ?? [];
      arr.push(c);
      byBucket.set(c.bucket, arr);
    }
    return BUCKET_ORDER.filter(b => byBucket.has(b)).map(bucket => ({
      bucket,
      rows: (byBucket.get(bucket) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [data]);

  if (isLoading) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <Skeleton className="h-8 w-64 mb-6" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 p-4 text-sm">
          Failed to load budget: {(error as Error).message}
        </div>
      </div>
    );
  }
  if (!data || data.centres.length === 0) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <h1 className="text-2xl font-semibold text-white mb-2">Budget — {year}</h1>
        <p className="text-sm text-white/60">No cost centres yet. Run the seed script or add one from the admin tools.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <FinanceNav />
      <div className="flex items-baseline justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-white">Budget — {data.year}</h1>
          <p className="text-sm text-white/50 mt-1">
            {data.centres.length} cost centres · United Sports Group
          </p>
        </div>
        <div className="flex items-center gap-6 text-right">
          <Stat label="Income" value={fmtMoney(data.totals.incomeCents)} accent="emerald" icon={<TrendingUp className="w-4 h-4" />} />
          <Stat label="Expenses" value={fmtMoney(data.totals.expenseCents)} accent="red" icon={<TrendingDown className="w-4 h-4" />} />
          <Stat label="Net" value={fmtMoney(data.totals.netCents)} accent={data.totals.netCents >= 0 ? "emerald" : "red"} icon={<DollarSign className="w-4 h-4" />} bold />
        </div>
      </div>

      {monthly.data && (
        <section className="mb-8">
          <h2 className="text-xs uppercase tracking-wider font-semibold text-white/40 mb-3">Monthly cash flow — {monthly.data.year}</h2>
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="month" stroke="rgba(255,255,255,0.4)" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} />
                <Tooltip
                  contentStyle={{ background: "rgba(15,15,18,0.95)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "rgba(255,255,255,0.6)", fontSize: 11, marginBottom: 4 }}
                  formatter={(value: number, name: string) => [`$${Math.abs(value).toLocaleString("en-NZ", { maximumFractionDigits: 0 })}`, name]}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
                <Bar dataKey="income" name="Income" fill="rgba(52, 211, 153, 0.55)" stackId="cash" />
                <Bar dataKey="expense" name="Expense" fill="rgba(248, 113, 113, 0.55)" stackId="cash" />
                <Line type="monotone" dataKey="cumulative" name="Cumulative net" stroke="rgba(96, 165, 250, 0.9)" strokeWidth={2} dot={{ r: 3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      <div className="space-y-8">
        {grouped.map(g => {
          const subIncome = g.rows.reduce((s, r) => s + r.totalIncomeCents, 0);
          const subExpense = g.rows.reduce((s, r) => s + r.totalExpenseCents, 0);
          const subNet = subIncome - subExpense;
          return (
            <section key={g.bucket}>
              <h2 className="text-xs uppercase tracking-wider font-semibold text-white/40 mb-3">{BUCKET_LABELS[g.bucket] ?? g.bucket}</h2>
              <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="text-[11px] uppercase tracking-wider text-white/40 bg-white/[0.02]">
                    <tr>
                      <th className="text-left py-3 px-4 font-semibold">Cost centre</th>
                      <th className="text-left py-3 px-4 font-semibold">Owner</th>
                      <th className="text-right py-3 px-4 font-semibold">Income</th>
                      <th className="text-right py-3 px-4 font-semibold">Expense</th>
                      <th className="text-right py-3 px-4 font-semibold">Net</th>
                      <th className="w-10 py-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map(r => (
                      <tr key={r.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                        <td className="py-3 px-4">
                          <Link href={`/admin/budget/cost-centres/${r.slug}`} className="text-white/90 hover:text-white">
                            {r.name}
                          </Link>
                        </td>
                        <td className="py-3 px-4 text-white/60 text-xs">
                          {r.ownerName ? (
                            <span className="inline-flex items-center gap-1.5"><User className="w-3 h-3" />{r.ownerName}</span>
                          ) : (
                            <span className="text-amber-400/70">No owner assigned</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right tabular-nums text-emerald-400/80">{r.totalIncomeCents ? fmtMoney(r.totalIncomeCents) : "—"}</td>
                        <td className="py-3 px-4 text-right tabular-nums text-red-400/80">{r.totalExpenseCents ? fmtMoney(r.totalExpenseCents) : "—"}</td>
                        <td className={`py-3 px-4 text-right tabular-nums font-semibold ${r.netCents >= 0 ? "text-emerald-300" : "text-red-300"}`}>{fmtMoney(r.netCents)}</td>
                        <td className="py-3 px-2">
                          <Link href={`/admin/budget/cost-centres/${r.slug}`} className="text-white/30 hover:text-white">
                            <ArrowRight className="w-4 h-4" />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-white/[0.02] border-t border-white/[0.06]">
                    <tr>
                      <td className="py-2.5 px-4 text-white/50 text-xs uppercase tracking-wider" colSpan={2}>Subtotal — {BUCKET_LABELS[g.bucket]}</td>
                      <td className="py-2.5 px-4 text-right tabular-nums text-emerald-300/80 text-xs">{fmtMoney(subIncome)}</td>
                      <td className="py-2.5 px-4 text-right tabular-nums text-red-300/80 text-xs">{fmtMoney(subExpense)}</td>
                      <td className={`py-2.5 px-4 text-right tabular-nums text-xs font-semibold ${subNet >= 0 ? "text-emerald-300" : "text-red-300"}`}>{fmtMoney(subNet)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value, accent, icon, bold }: { label: string; value: string; accent: "emerald" | "red"; icon: React.ReactNode; bold?: boolean }) {
  const color = accent === "emerald" ? "text-emerald-300" : "text-red-300";
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-wider text-white/40 flex items-center justify-end gap-1.5">
        {icon}
        {label}
      </div>
      <div className={`mt-0.5 tabular-nums ${color} ${bold ? "text-xl font-semibold" : "text-base"}`}>{value}</div>
    </div>
  );
}
