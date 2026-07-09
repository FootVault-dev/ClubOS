// Marketing Suite — campaign analytics detail. Route: /admin/marketing/campaigns/:id.
// Consumes GET /campaigns/:id/analytics — the one endpoint with the FULL honest
// funnel (queued→sent→delivered→human clicks→conversions), revenue/RPR, the
// link-click table (human vs bot) and demoted MPP-labelled opens. Polls every
// 3s while the campaign is sending.
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChevronLeft, Pencil, Ban, Loader2, Link2 } from "lucide-react";
import { useState } from "react";
import { formatCurrency } from "@/lib/format";
import type { CampaignAnalytics } from "./types";
import { StatCard, CampaignStatusBadge, LoadingRows, fmtDateTime, pct, MiniBar } from "./ui";

export default function CampaignDetailPage() {
  const [, params] = useRoute("/admin/marketing/campaigns/:id");
  const id = Number(params?.id);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [confirmCancel, setConfirmCancel] = useState(false);

  const { data, isLoading } = useQuery<CampaignAnalytics>({
    queryKey: ["/api/admin/marketing/campaigns", id, "analytics"],
    queryFn: async () => (await apiRequest("GET", `/api/admin/marketing/campaigns/${id}/analytics`)).json(),
    enabled: Number.isFinite(id),
    refetchInterval: (q) => (q.state.data as CampaignAnalytics | undefined)?.campaign.status === "sending" ? 3000 : false,
  });

  const cancel = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/marketing/campaigns/${id}/cancel`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/marketing/campaigns"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/marketing/campaigns", id, "analytics"] });
      setConfirmCancel(false);
      toast({ title: "Campaign cancelled" });
    },
    onError: (e: any) => toast({ title: "Couldn't cancel", description: e.message, variant: "destructive" }),
  });

  if (isLoading || !data) {
    return <div className="p-4 sm:p-6"><LoadingRows rows={6} /></div>;
  }

  const { campaign, funnel, engagement, kpis, links = [], conversions, smsFunnel, smsCost, smsInboundStopCount } = data;
  const isSms = campaign.channel === "sms";
  const progressPct = campaign.status === "sending" && campaign.recipientCount > 0
    ? Math.round(((isSms ? smsFunnel?.sent ?? 0 : funnel?.sent ?? 0) / campaign.recipientCount) * 100)
    : undefined;
  const deliveredPct = !isSms && funnel && funnel.sent > 0 ? funnel.delivered / funnel.sent : 0;

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/admin/marketing")} data-testid="mkt-detail-back"><ChevronLeft className="w-4 h-4" /></Button>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold">{campaign.name}</h1>
              <CampaignStatusBadge status={campaign.status} progressPct={progressPct} />
            </div>
            {campaign.subject && <p className="text-sm text-muted-foreground mt-0.5">{campaign.subject}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {campaign.status === "draft" && (
            <Button variant="outline" size="sm" onClick={() => setLocation(`/admin/marketing/campaigns/${id}/edit`)} data-testid="mkt-detail-edit">
              <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit
            </Button>
          )}
          {(campaign.status === "scheduled" || campaign.status === "sending") && (
            <Button variant="outline" size="sm" className="text-red-500 hover:text-red-500" onClick={() => setConfirmCancel(true)} data-testid="mkt-detail-cancel">
              <Ban className="w-3.5 h-3.5 mr-1.5" /> Cancel
            </Button>
          )}
        </div>
      </div>

      {isSms && smsFunnel ? (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Sent" value={smsFunnel.sent} sub={`of ${campaign.recipientCount} recipients`} />
            <StatCard label="Delivered" value={smsFunnel.delivered} sub={smsFunnel.sent ? pct(smsFunnel.delivered / smsFunnel.sent) : undefined} tone="good" />
            <StatCard label="Failed" value={smsFunnel.failed} tone={smsFunnel.failed ? "warn" : "default"} />
            <StatCard label="Actual cost" value={formatCurrency(smsCost?.actualCents ?? 0, { fromCents: true, decimals: 2 })} sub="+ GST" />
          </div>

          <StatCard
            label="STOP replies"
            value={smsInboundStopCount ?? 0}
            sub="from numbers this campaign texted, since it sent — each one is opted out globally"
            tone={smsInboundStopCount ? "warn" : "default"}
            testId="mkt-detail-sms-stop-count"
          />

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Funnel</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <FunnelRow label="Queued" value={smsFunnel.queued} max={smsFunnel.total} />
              <FunnelRow label="Sent" value={smsFunnel.sent} max={smsFunnel.total} />
              <FunnelRow label="Delivered" value={smsFunnel.delivered} max={smsFunnel.total} color="hsl(160 84% 39%)" />
              <FunnelRow label="Failed" value={smsFunnel.failed} max={smsFunnel.total} color="hsl(0 84% 60%)" />
            </CardContent>
          </Card>
        </>
      ) : funnel && engagement && kpis && conversions ? (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Delivered" value={`${funnel.delivered}/${funnel.sent}`} sub={funnel.sent ? pct(deliveredPct) : undefined} />
            <StatCard label="Human clicks — bots filtered" value={engagement.humanClickCount} sub={`${engagement.botClickCount} bot clicks filtered out`} tone="good" />
            <StatCard label="Conversions & revenue" value={formatCurrency(conversions.revenue)} sub={`${conversions.count} conversion${conversions.count === 1 ? "" : "s"}`} tone="good" />
            <StatCard label="Revenue per recipient" value={formatCurrency(kpis.revenuePerRecipient, { decimals: 2 })} />
          </div>

          <StatCard
            label="Opens"
            value={engagement.uniqueOpens}
            sub={`inflated by Apple Mail Privacy Protection — directional only (${engagement.machineOpenCount} of ${engagement.openCount} total opens flagged machine)`}
            muted
          />

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Funnel</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <FunnelRow label="Queued" value={funnel.total} max={funnel.total} />
              <FunnelRow label="Sent" value={funnel.sent} max={funnel.total} />
              <FunnelRow label="Delivered" value={funnel.delivered} max={funnel.total} />
              <FunnelRow label="Human clicks" value={engagement.humanClickCount} max={funnel.total} color="hsl(160 84% 39%)" />
              <FunnelRow label="Conversions" value={conversions.count} max={funnel.total} color="hsl(45 93% 47%)" />
              <div className="grid grid-cols-3 gap-3 pt-2 text-xs text-muted-foreground">
                <span>{funnel.bounced} bounced</span>
                <span>{funnel.complained} complained</span>
                <span>{funnel.unsubscribed} unsubscribed</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Link clicks</CardTitle></CardHeader>
            <CardContent>
              {!links.length ? (
                <p className="text-sm text-muted-foreground py-6 text-center">No clicks recorded yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>Link</TableHead><TableHead className="text-right">Human clicks</TableHead><TableHead className="text-right">Bot clicks</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {links.map((l) => (
                        <TableRow key={l.linkUrl}>
                          <TableCell className="max-w-xs truncate flex items-center gap-1.5"><Link2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />{l.linkUrl}</TableCell>
                          <TableCell className="text-right tabular-nums font-medium">{l.humanClicks}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">{l.clicks - l.humanClicks}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}

      <p className="text-xs text-muted-foreground">Sent {fmtDateTime(campaign.sentAt)} · {campaign.recipientCount} recipients</p>

      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this campaign?</AlertDialogTitle>
            <AlertDialogDescription>
              {campaign.status === "sending"
                ? "Sends already queued may still land, but no further batches will go out."
                : "The scheduled send will be called off."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              {cancel.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null} Cancel campaign
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FunnelRow({ label, value, max, color }: { label: string; value: number; max: number; color?: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 text-xs text-muted-foreground shrink-0">{label}</div>
      <MiniBar value={value} max={max} color={color} />
      <div className="w-14 text-right text-sm font-medium tabular-nums shrink-0">{value}</div>
    </div>
  );
}
