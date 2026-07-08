// Marketing Suite — small shared UI atoms used across the Marketing tab pages.
// Kept local to client/src/pages/marketing (Phase C owns this directory).
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import type { CampaignStatus, LegalBasis, SubState } from "./types";

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function StatCard({
  label, value, sub, tone = "default", muted, testId,
}: { label: string; value: string | number; sub?: string; tone?: "default" | "good" | "warn" | "bad"; muted?: boolean; testId?: string }) {
  const toneColor = tone === "good" ? "text-emerald-500" : tone === "warn" ? "text-amber-500" : tone === "bad" ? "text-red-500" : "";
  return (
    <Card className={muted ? "opacity-70" : undefined} data-testid={testId}>
      <CardContent className="p-4">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</p>
        <p className={`text-2xl font-bold mt-1 ${toneColor}`}>{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export function MiniBar({ value, max, color = "hsl(var(--primary))" }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-2 rounded bg-muted overflow-hidden w-full">
      <div className="h-full rounded" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, action }: { icon: any; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed p-10 flex flex-col items-center justify-center text-center gap-2">
      <Icon className="w-9 h-9 text-muted-foreground/50 mb-1" />
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="text-xs text-muted-foreground max-w-sm">{description}</p>}
      {action}
    </div>
  );
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return <div className="space-y-2">{Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;
}

export function CampaignStatusBadge({ status, progressPct }: { status: CampaignStatus; progressPct?: number }) {
  const map: Record<CampaignStatus, { label: string; className: string }> = {
    draft: { label: "Draft", className: "bg-muted text-muted-foreground" },
    scheduled: { label: "Scheduled", className: "bg-blue-500/15 text-blue-500 border-blue-500/30" },
    sending: { label: progressPct != null ? `Sending ${progressPct}%` : "Sending", className: "bg-amber-500/15 text-amber-500 border-amber-500/30 animate-pulse" },
    sent: { label: "Sent", className: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30" },
    paused: { label: "Paused", className: "bg-muted text-muted-foreground" },
    cancelled: { label: "Cancelled", className: "bg-red-500/10 text-red-500 border-red-500/20" },
    failed: { label: "Failed", className: "bg-red-500/15 text-red-500 border-red-500/30" },
  };
  const m = map[status] || map.draft;
  return <Badge variant="outline" className={m.className}>{m.label}</Badge>;
}

export function ConsentBadge({ subState }: { subState: SubState }) {
  const map: Record<SubState, { label: string; className: string }> = {
    subscribed: { label: "Subscribed", className: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30" },
    never: { label: "Never", className: "bg-muted text-muted-foreground" },
    unsubscribed: { label: "Unsubscribed", className: "bg-red-500/15 text-red-500 border-red-500/30" },
  };
  const m = map[subState] || map.never;
  return <Badge variant="outline" className={m.className}>{m.label}</Badge>;
}

export function LegalBasisBadge({ legalBasis }: { legalBasis: LegalBasis }) {
  return <Badge variant="outline" className="text-muted-foreground">{legalBasis.replace(/_/g, " ")}</Badge>;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function pct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`;
}
