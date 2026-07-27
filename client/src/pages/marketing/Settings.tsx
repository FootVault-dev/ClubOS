// Marketing Suite — Settings. Read-only v1.
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { workspaceDomainBySlug } from "@shared/org-domains";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Globe, Moon, ShieldCheck, Activity } from "lucide-react";
import type { WebhookHealth } from "./types";
import { timeAgo } from "./ui";

const EVENT_TYPE_LABELS: Record<string, string> = {
  "email.sent": "Sent", "email.delivered": "Delivered", "email.delivery_delayed": "Delayed",
  "email.opened": "Opened", "email.clicked": "Clicked", "email.bounced": "Bounced",
  "email.complained": "Complained",
};

export default function SettingsView() {
  const { currentOrg } = useWorkspace();
  const domain = currentOrg ? workspaceDomainBySlug(currentOrg.slug) : undefined;
  const { data: health, isLoading: healthLoading } = useQuery<WebhookHealth>({ queryKey: ["/api/admin/marketing/webhook-health"] });

  const healthy = !!health?.lastEventAt && Date.now() - new Date(health.lastEventAt).getTime() < 24 * 60 * 60 * 1000;

  return (
    <div className="space-y-4 max-w-2xl">
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center gap-2">
          <Globe className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Sending domain</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {domain ? (
            <>
              <p className="text-sm"><span className="text-muted-foreground">From:</span> {domain.fromName} &lt;noreply@{domain.emailDomain}&gt;</p>
              <p className="text-xs text-muted-foreground">Verified Resend sending domain for this workspace. To change it, use the workspace's Domains tab.</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No verified domain on file for this workspace yet — sends fall back to Christchurch United's domain.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center gap-2">
          <Activity className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Webhook health</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {healthLoading ? (
            <p className="text-sm text-muted-foreground">Checking…</p>
          ) : !health?.lastEventAt ? (
            <p className="text-sm text-muted-foreground">No Resend events received yet for this workspace — that's expected before the first send.</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={healthy ? "bg-emerald-500/15 text-emerald-500 border-emerald-500/30" : "bg-amber-500/15 text-amber-500 border-amber-500/30"}>
                  {healthy ? "Receiving events" : "No events in 24h"}
                </Badge>
                <span className="text-xs text-muted-foreground">Last event {timeAgo(health.lastEventAt)}</span>
              </div>
              <p className="text-xs text-muted-foreground">{health.events24h.toLocaleString()} event{health.events24h === 1 ? "" : "s"} in the last 24 hours</p>
              {!!Object.keys(health.byType24h).length && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {Object.entries(health.byType24h).map(([type, n]) => (
                    <Badge key={type} variant="secondary" className="text-[10px] font-normal">
                      {EVENT_TYPE_LABELS[type] ?? type} · {n}
                    </Badge>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center gap-2">
          <Moon className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Quiet hours</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">20:00–08:00 NZ time (Pacific/Auckland)</p>
          <p className="text-xs text-muted-foreground mt-1">Applies to SMS sends and automation flows once those channels go live — no marketing lands in the middle of the night.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Compliance, always on</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm text-muted-foreground">
          <p>One-click unsubscribe headers (RFC 8058) on every marketing send.</p>
          <p>Every recipient is checked against consent and suppressions before sending — no list can bypass it.</p>
          <p>Bounces and complaints auto-suppress the address globally.</p>
        </CardContent>
      </Card>
    </div>
  );
}
