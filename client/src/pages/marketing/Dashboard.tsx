// Marketing Suite — Dashboard view (rendered inside Home.tsx).
// Consumes GET /api/admin/marketing/dashboard (the one summary endpoint).
//
// Two rows of cards: a 30-day-windowed row (the honest, recency-weighted view
// — delivered %, human clicks, conversions & revenue, revenue per recipient)
// and an all-time row underneath. Aggregate "Opens" is still not exposed here
// (it's MPP-inflated and only meaningful per-campaign, see CampaignDetail.tsx)
// — that card stays an honest "—" rather than a fabricated number.
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Mail } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import type { DashboardSummary } from "./types";
import { StatCard, CampaignStatusBadge, EmptyState, LoadingRows, fmtDateTime, pct } from "./ui";

export default function DashboardView({ onOpenCampaigns }: { onOpenCampaigns: () => void }) {
  const [, setLocation] = useLocation();
  const { data, isLoading } = useQuery<DashboardSummary>({ queryKey: ["/api/admin/marketing/dashboard"] });

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Last 30 days</p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Sends" value={isLoading ? "…" : (data?.sends30d ?? 0).toLocaleString()} testId="mkt-stat-sends" />
          <StatCard
            label="Delivered"
            value={isLoading ? "…" : pct(data?.delivered30dPct ?? 0)}
            sub="of what was sent in the last 30 days"
            testId="mkt-stat-delivered-30d"
          />
          <StatCard
            label="Human clicks"
            value={isLoading ? "…" : (data?.humanClicks30d ?? 0).toLocaleString()}
            sub="bot/prefetch clicks excluded"
            testId="mkt-stat-human-clicks"
          />
          <StatCard
            label="Conversions & revenue"
            value={isLoading ? "…" : `${(data?.conversions30d?.count ?? 0).toLocaleString()} · ${formatCurrency(data?.conversions30d?.revenueCents ?? 0, { fromCents: true })}`}
            tone="good"
            testId="mkt-stat-conversions-30d"
          />
        </div>
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">All time</p>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <StatCard label="Delivered" value={isLoading ? "…" : (data?.deliveredTotal ?? 0).toLocaleString()} testId="mkt-stat-delivered" />
          <StatCard
            label="Revenue"
            value={isLoading ? "…" : formatCurrency(data?.revenue ?? 0)}
            tone="good"
            testId="mkt-stat-revenue"
          />
          <StatCard
            label="Revenue per recipient"
            value={isLoading ? "…" : formatCurrency(data?.revenuePerRecipient ?? 0, { decimals: 2 })}
            testId="mkt-stat-rpr"
          />
          <StatCard
            label="Revenue per recipient (30d)"
            value={isLoading ? "…" : formatCurrency(data?.rpr30d ?? 0, { decimals: 2 })}
            testId="mkt-stat-rpr-30d"
          />
          <StatCard
            label="Opens"
            value="—"
            sub="inflated by Apple Mail Privacy Protection — directional only, view per-campaign"
            muted
            testId="mkt-stat-opens"
          />
        </div>
      </div>

      <StatCard label="Profiles in audience" value={isLoading ? "…" : (data?.profiles ?? 0).toLocaleString()} testId="mkt-stat-profiles" />

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
