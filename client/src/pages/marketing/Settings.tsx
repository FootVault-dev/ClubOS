// Marketing Suite — Settings. Read-only v1.
//
// NOTE — scope: "webhook health (last event received timestamp)" from the
// build brief isn't shown here — server/marketing/routes.ts exposes no
// endpoint for it (webhook.ts writes mkt_email_events but nothing in routes.ts
// surfaces a last-received timestamp). Omitted per the brief's own fallback
// ("if not exposed, omit") rather than fabricated.
import { useWorkspace } from "@/lib/workspace-context";
import { workspaceDomainBySlug } from "@shared/org-domains";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Globe, Moon, ShieldCheck } from "lucide-react";

export default function SettingsView() {
  const { currentOrg } = useWorkspace();
  const domain = currentOrg ? workspaceDomainBySlug(currentOrg.slug) : undefined;

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
