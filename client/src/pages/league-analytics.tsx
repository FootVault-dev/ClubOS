import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { Users, DollarSign, TrendingUp, UserCheck, Percent, RefreshCw, BarChart3, CreditCard, Trophy, CalendarDays, Wallet } from "lucide-react";
import { formatCurrency as _fc } from "@/lib/format";

const fc = (cents: number) => _fc(cents || 0, { fromCents: true });

function MetricCard({ title, value, subtitle, icon: Icon, color = "blue" }: { title: string; value: string | number; subtitle?: string; icon: any; color?: string }) {
  const colorMap: Record<string, string> = {
    blue: "text-blue-600 bg-blue-50 dark:bg-blue-900/20",
    green: "text-green-600 bg-green-50 dark:bg-green-900/20",
    orange: "text-orange-600 bg-orange-50 dark:bg-orange-900/20",
    purple: "text-purple-600 bg-purple-50 dark:bg-purple-900/20",
    gold: "text-yellow-600 bg-yellow-50 dark:bg-yellow-900/20",
  };
  return (
    <Card data-testid={`metric-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${colorMap[color] || colorMap.blue}`}><Icon className="w-4 h-4" /></div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground truncate">{title}</p>
            <p className="text-xl font-bold">{value}</p>
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Bars({ rows }: { rows: { label: string; value: number; right: string; sub?: string }[] }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="space-y-3">
      {rows.map((r, i) => (
        <div key={i}>
          <div className="flex justify-between text-sm mb-1"><span className="font-medium truncate">{r.label}</span><span>{r.right}</span></div>
          <div className="h-2 bg-muted rounded overflow-hidden"><div className="h-full bg-primary rounded" style={{ width: `${(r.value / max) * 100}%` }} /></div>
          {r.sub && <p className="text-xs text-muted-foreground mt-1">{r.sub}</p>}
        </div>
      ))}
    </div>
  );
}

const Loading = () => <div className="flex items-center justify-center py-16"><RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" /></div>;

export default function LeagueAnalytics() {
  const [term, setTerm] = useState<string>("all");
  const params = new URLSearchParams();
  if (term !== "all") params.set("competitionId", term);

  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/admin/league/analytics", term],
    queryFn: () => fetch(`/api/admin/league/analytics?${params}`).then((r) => r.json()),
  });
  const terms: { id: number; name: string }[] = data?.terms || [];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Analytics</h1>
            <p className="text-sm text-muted-foreground">Key business metrics across the leagues</p>
          </div>
        </div>
        <Select value={term} onValueChange={setTerm}>
          <SelectTrigger className="w-[220px]" data-testid="analytics-term"><SelectValue placeholder="Term" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All terms</SelectItem>
            {terms.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {isLoading || !data ? <Loading /> : (
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="w-full justify-start overflow-x-auto">
            <TabsTrigger value="overview" data-testid="tab-overview">Overview</TabsTrigger>
            <TabsTrigger value="revenue" data-testid="tab-revenue">Revenue</TabsTrigger>
            <TabsTrigger value="divisions" data-testid="tab-divisions">Divisions</TabsTrigger>
            <TabsTrigger value="rewards" data-testid="tab-rewards">Rewards</TabsTrigger>
          </TabsList>

          {/* Overview */}
          <TabsContent value="overview" className="space-y-6 mt-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard title="Teams" value={data.overview.teams} subtitle={`${data.overview.confirmedTeams} confirmed`} icon={Users} color="blue" />
              <MetricCard title="Revenue collected" value={fc(data.overview.revenueCollectedCents)} subtitle={`of ${fc(data.overview.totalContractedCents)} contracted`} icon={DollarSign} color="green" />
              <MetricCard title="Avg team value" value={fc(data.overview.avgTeamValueCents)} icon={TrendingUp} color="purple" />
              <MetricCard title="Fill rate" value={data.overview.fillRatePct != null ? `${data.overview.fillRatePct}%` : "—"} subtitle={data.overview.capacity ? `${data.overview.activeTeams}/${data.overview.capacity} spots` : "no capacity set"} icon={Percent} color="orange" />
              <MetricCard title="Unique captains" value={data.overview.uniqueCaptains} icon={UserCheck} color="blue" />
              <MetricCard title="Balance owed" value={fc(data.overview.revenueOwedCents)} subtitle={`${data.overview.owedTeams} teams`} icon={Wallet} color="orange" />
              <MetricCard title="Spots left" value={data.overview.spotsLeft} icon={CalendarDays} color="green" />
              <MetricCard title="Divisions" value={data.overview.divisions} icon={BarChart3} color="purple" />
            </div>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Signups over time</CardTitle></CardHeader>
              <CardContent>
                {data.signupsByDay.length === 0 ? <p className="text-sm text-muted-foreground py-8 text-center">No signups in this view.</p> : (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={data.signupsByDay.map((d: any) => ({ date: new Date(d.date).toLocaleDateString("en-NZ", { day: "numeric", month: "short" }), teams: d.count }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                      <Line type="monotone" dataKey="teams" stroke="#d1b96e" strokeWidth={2} dot={{ r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Revenue */}
          <TabsContent value="revenue" className="space-y-6 mt-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard title="Collected" value={fc(data.overview.revenueCollectedCents)} icon={DollarSign} color="green" />
              <MetricCard title="Contracted" value={fc(data.overview.totalContractedCents)} icon={TrendingUp} color="blue" />
              <MetricCard title="Outstanding" value={fc(data.overview.revenueOwedCents)} subtitle={`${data.overview.owedTeams} teams`} icon={Wallet} color="orange" />
              <MetricCard title="Avg team value" value={fc(data.overview.avgTeamValueCents)} icon={Percent} color="purple" />
            </div>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><CreditCard className="w-4 h-4" /> Payment method mix</CardTitle></CardHeader>
              <CardContent>
                <Bars rows={data.paymentMix.map((p: any) => ({ label: p.mode, value: p.count, right: `${p.count} ${p.count === 1 ? "team" : "teams"}`, sub: `${fc(p.collectedCents)} collected` }))} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Payment status</CardTitle></CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {data.statusMix.map((s: any) => (
                    <div key={s.status} className="p-3 rounded-lg bg-muted/50 text-center">
                      <p className="text-xs text-muted-foreground capitalize">{String(s.status).replace(/_/g, " ")}</p>
                      <p className="text-lg font-bold">{s.count}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Divisions */}
          <TabsContent value="divisions" className="space-y-6 mt-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Fill rate by division</CardTitle></CardHeader>
              <CardContent>
                {data.byDivision.length === 0 ? <p className="text-sm text-muted-foreground py-8 text-center">No divisions.</p> : (
                  <div className="space-y-4">
                    {data.byDivision.map((d: any) => (
                      <div key={d.name} data-testid={`division-${d.name}`}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="font-medium truncate">{d.name}</span>
                          <span>{d.teams}{d.capacity != null ? `/${d.capacity}` : ""} teams{d.fillPct != null ? ` · ${d.fillPct}%` : ""}</span>
                        </div>
                        <div className="h-2 bg-muted rounded overflow-hidden"><div className="h-full bg-primary rounded" style={{ width: `${d.fillPct != null ? Math.min(100, d.fillPct) : 0}%` }} /></div>
                        <p className="text-xs text-muted-foreground mt-1">{fc(d.collectedCents)} collected{d.spotsLeft != null ? ` · ${d.spotsLeft} spots left` : ""}</p>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Rewards */}
          <TabsContent value="rewards" className="space-y-6 mt-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <MetricCard title="League Builders" value={data.rewards.builders} subtitle="referrers signed up" icon={Trophy} color="gold" />
              <MetricCard title="Builder credit earned" value={fc(data.rewards.builderCreditEarnedCents)} icon={DollarSign} color="green" />
              <MetricCard title="Season members" value={data.rewards.seasonMembers} subtitle={`${data.rewards.seasonRewardsIssued} rewards issued`} icon={UserCheck} color="blue" />
              <MetricCard title="Referees" value={data.rewards.referees} icon={Users} color="purple" />
              <MetricCard title="Ref tokens" value={data.rewards.refTokens} icon={Trophy} color="gold" />
            </div>
            <p className="text-xs text-muted-foreground">Full detail in the <span className="font-medium">Rewards</span> tab.</p>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
