// Marketing Suite — Dashboard view (rendered inside Home.tsx).
// Consumes GET /api/admin/marketing/dashboard (the one summary endpoint).
//
// NOTE — data gap: the dashboard endpoint returns only
// { profiles, sends30d, deliveredTotal, revenue, revenuePerRecipient, topCampaigns }.
// It does NOT return a 30-day-windowed delivered %, an aggregate human-click
// count, or an aggregate conversions count/opens count. Those fields ARE fully
// available per-campaign via GET /campaigns/:id/analytics (wired up in
// CampaignDetail.tsx). Cards below show "—" with an explanatory subtitle where
// the dashboard endpoint doesn't expose the number, rather than fabricating one.
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Send, Users, TrendingUp, MousePointerClick, DollarSign, Eye, Mail } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import type { DashboardSummary } from "./types";
import { StatCard, CampaignStatusBadge, EmptyState, LoadingRows, fmtDateTime } from "./ui";

export default function DashboardView({ onOpenCampaigns }: { onOpenCampaigns: () => void }) {
  const [, setLocation] = useLocation();
  const { data, isLoading } = useQuery<DashboardSummary>({ queryKey: ["/api/admin/marketing/dashboard"] });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard label="Sends (30d)" value={isLoading ? "…" : (data?.sends30d ?? 0).toLocaleString()} testId="mkt-stat-sends" />
        <StatCard
          label="Delivered"
          value={isLoading ? "…" : (data?.deliveredTotal ?? 0).toLocaleString()}
          sub="all-time total — this endpoint isn't windowed to 30d"
          testId="mkt-stat-delivered"
        />
        <StatCard label="Human clicks" value="—" sub="not exposed by /dashboard yet — see a campaign's analytics" muted testId="mkt-stat-human-clicks" />
        <StatCard
          label="Conversions & revenue"
          value={isLoading ? "…" : formatCurrency(data?.revenue ?? 0)}
          sub="conversion count not exposed by /dashboard yet"
          tone="good"
          testId="mkt-stat-revenue"
        />
        <StatCard
          label="Revenue per recipient"
          value={isLoading ? "…" : formatCurrency(data?.revenuePerRecipient ?? 0, { decimals: 2 })}
          testId="mkt-stat-rpr"
        />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard
          label="Opens"
          value="—"
          sub="inflated by Apple Mail Privacy Protection — directional only. Aggregate not exposed here yet; view per-campaign."
          muted
          testId="mkt-stat-opens"
        />
        <StatCard label="Profiles in audience" value={isLoading ? "…" : (data?.profiles ?? 0).toLocaleString()} testId="mkt-stat-profiles" />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium">Recent campaigns</CardTitle>
          <button onClick={onOpenCampaigns} className="text-xs text-primary hover:underline" data-testid="mkt-dashboard-view-all">
            View all campaigns →
          </button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingRows rows={4} />
          ) : !data?.topCampaigns?.length ? (
            <EmptyState
              icon={Mail}
              title="No campaigns sent yet"
              description="Create your first campaign to see sends, deliveries and revenue land here."
              action={<button onClick={onOpenCampaigns} className="text-xs font-medium text-primary hover:underline mt-1">Go to Campaigns →</button>}
            />
          ) : (
            <div className="overflow-x-auto -mx-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Sent</TableHead>
                    <TableHead className="text-right">Recipients</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.topCampaigns.map((c) => (
                    <TableRow
                      key={c.id}
                      className="cursor-pointer"
                      onClick={() => setLocation(`/admin/marketing/campaigns/${c.id}`)}
                      data-testid={`mkt-dashboard-campaign-${c.id}`}
                    >
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell><CampaignStatusBadge status={c.status} /></TableCell>
                      <TableCell className="text-muted-foreground text-sm">{fmtDateTime(c.sentAt)}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.sentCount}/{c.recipientCount}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
