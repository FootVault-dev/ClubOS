// Marketing Suite — Audience view: profile search + a detail drawer with
// per-channel consent, sources, event timeline and suppress/unsuppress.
//
// GET /api/admin/marketing/profiles returns a per-channel consent summary
// (sub_state + suppressed flag, for email and sms) alongside each row, built
// without N+1 — see server/marketing/routes.ts. The table below renders that
// as a small channel-chip pair per row; the detail drawer (GET /profiles/:id)
// still carries the full consent/suppression record for the deep dive.
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Search, Users, Mail, Phone, ShieldOff, ShieldCheck, Clock } from "lucide-react";
import type { MktProfileRow, MktProfileDetail, MktChannel, SuppressionScope, SubState } from "./types";
import { ConsentBadge, LegalBasisBadge, EmptyState, LoadingRows, fmtDateTime } from "./ui";

// Row-level consent summary from GET /profiles — {subState, suppressed} per
// channel. A suppressed row is always shown red regardless of sub_state (a
// bounce/complaint can suppress a technically-"subscribed" address).
interface ProfileChannelConsent { subState: SubState | null; suppressed: boolean }
interface MktProfileRowWithConsent extends MktProfileRow {
  consent: { email: ProfileChannelConsent; sms: ProfileChannelConsent };
}

function ConsentChip({ label, c }: { label: string; c: ProfileChannelConsent | undefined }) {
  if (!c || (c.subState == null && !c.suppressed)) {
    return <Badge variant="outline" className="text-[10px] text-muted-foreground/70">{label} —</Badge>;
  }
  const red = c.suppressed || c.subState === "unsubscribed";
  const green = !red && c.subState === "subscribed";
  const className = red
    ? "bg-red-500/15 text-red-500 border-red-500/30"
    : green
      ? "bg-emerald-500/15 text-emerald-500 border-emerald-500/30"
      : "bg-muted text-muted-foreground";
  return (
    <Badge variant="outline" className={`text-[10px] ${className}`} title={c.suppressed ? `${label}: suppressed` : `${label}: ${c.subState ?? "never"}`}>
      {label}
    </Badge>
  );
}

export default function AudienceView() {
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data: profiles = [], isLoading } = useQuery<MktProfileRowWithConsent[]>({
    queryKey: ["/api/admin/marketing/profiles", q],
    queryFn: async () => {
      const url = `/api/admin/marketing/profiles${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`;
      const r = await apiRequest("GET", url);
      return r.json();
    },
  });

  return (
    <div className="space-y-4">
      <div className="relative max-w-md">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, email or phone…"
          className="pl-9"
          data-testid="mkt-audience-search"
        />
      </div>

      {isLoading ? (
        <LoadingRows rows={8} />
      ) : !profiles.length ? (
        <EmptyState
          icon={Users}
          title={q ? "No profiles match your search" : "No profiles yet"}
          description={q ? "Try a different name, email or phone." : "Profiles populate automatically from registrations, contacts and every audience source ClubOS already tracks."}
        />
      ) : (
        <div className="rounded-xl border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Consent</TableHead>
                <TableHead>Last activity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((p) => (
                <TableRow key={p.id} className="cursor-pointer" onClick={() => setSelectedId(p.id)} data-testid={`mkt-audience-row-${p.id}`}>
                  <TableCell className="font-medium">{[p.firstName, p.lastName].filter(Boolean).join(" ") || "—"}</TableCell>
                  <TableCell className="text-sm">{p.email || "—"}</TableCell>
                  <TableCell className="text-sm">{p.phoneE164 || "—"}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <ConsentChip label="Email" c={p.consent?.email} />
                      <ConsentChip label="SMS" c={p.consent?.sms} />
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{fmtDateTime(p.lastEventAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="px-3 py-2 text-[11px] text-muted-foreground border-t">
            Showing up to 100 profiles{q ? " matching your search" : ""}. Narrow with search for a specific person.
          </div>
        </div>
      )}

      <Sheet open={selectedId != null} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {selectedId != null && <ProfileDetail id={selectedId} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ProfileDetail({ id }: { id: number }) {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<MktProfileDetail>({ queryKey: ["/api/admin/marketing/profiles", id] });
  const [confirm, setConfirm] = useState<{ channel: MktChannel; action: "suppress" | "unsuppress" } | null>(null);
  const [scope, setScope] = useState<SuppressionScope>("brand");

  const suppress = useMutation({
    mutationFn: (body: { channel: MktChannel; scope: SuppressionScope }) => apiRequest("POST", `/api/admin/marketing/profiles/${id}/suppress`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/marketing/profiles", id] });
      toast({ title: "Suppressed", description: "This profile will no longer receive marketing on that channel." });
      setConfirm(null);
    },
    onError: (e: any) => toast({ title: "Couldn't suppress", description: e.message, variant: "destructive" }),
  });
  const unsuppress = useMutation({
    mutationFn: (body: { channel: MktChannel }) => apiRequest("POST", `/api/admin/marketing/profiles/${id}/unsuppress`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/marketing/profiles", id] });
      toast({ title: "Unsuppressed", description: "Consent re-enabled — this profile can receive marketing again." });
      setConfirm(null);
    },
    onError: (e: any) => toast({ title: "Couldn't unsuppress", description: e.message, variant: "destructive" }),
  });

  if (isLoading || !data) return <div className="p-4"><LoadingRows rows={6} /></div>;

  const { profile, consent, events, suppressions } = data;
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ") || "Unnamed profile";
  const sources = Array.isArray((profile.props as any)?.sources) ? ((profile.props as any).sources as string[]) : [];
  // Channel-aware: /profiles/:id now returns email suppressions matched by
  // email AND sms suppressions matched by phone_e164 (server/marketing/routes.ts),
  // so this is a real suppression-record check, not a consent-based heuristic.
  const isSuppressed = (channel: MktChannel) => suppressions.some((s) => s.channel === channel);

  const channelRow = (channel: MktChannel, icon: React.ReactNode, identifier: string | null) => {
    const c = consent.find((x) => x.channel === channel);
    const suppressed = isSuppressed(channel);
    return (
      <div className="rounded-lg border p-3 space-y-2" key={channel}>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-sm font-medium capitalize">{icon}{channel}</div>
          {c ? <ConsentBadge subState={c.subState} /> : <Badge variant="outline" className="text-muted-foreground">No record</Badge>}
        </div>
        <div className="text-xs text-muted-foreground truncate">{identifier || "no identifier on file"}</div>
        {c && (
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <LegalBasisBadge legalBasis={c.legalBasis} />
            {c.source && <span className="text-muted-foreground">via {c.source}</span>}
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <Button size="sm" variant="outline" className="text-red-500 hover:text-red-500" disabled={!identifier}
            onClick={() => setConfirm({ channel, action: "suppress" })} data-testid={`mkt-suppress-${channel}`}>
            <ShieldOff className="w-3.5 h-3.5 mr-1.5" /> Suppress
          </Button>
          <Button size="sm" variant="outline" disabled={!identifier}
            onClick={() => setConfirm({ channel, action: "unsuppress" })} data-testid={`mkt-unsuppress-${channel}`}>
            <ShieldCheck className="w-3.5 h-3.5 mr-1.5" /> Unsuppress
          </Button>
        </div>
        {suppressed && <p className="text-[10px] text-red-500/80">Currently suppressed on this channel.</p>}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <SheetHeader>
        <SheetTitle>{name}</SheetTitle>
        <SheetDescription>Profile #{profile.id} · created {fmtDateTime(profile.createdAt)}</SheetDescription>
      </SheetHeader>

      <div className="space-y-1 text-sm">
        <div className="flex items-center gap-2"><Mail className="w-3.5 h-3.5 text-muted-foreground" />{profile.email || "—"}</div>
        <div className="flex items-center gap-2"><Phone className="w-3.5 h-3.5 text-muted-foreground" />{profile.phoneE164 || "—"}</div>
        {profile.externalId && <div className="text-xs text-muted-foreground">External ID: {profile.externalId}</div>}
      </div>

      {!!sources.length && (
        <div className="flex flex-wrap gap-1.5">
          {sources.map((s) => <Badge key={s} variant="secondary" className="text-[10px]">{s}</Badge>)}
        </div>
      )}

      <div>
        <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">Consent by channel</p>
        <div className="grid gap-3">
          {channelRow("email", <Mail className="w-3.5 h-3.5" />, profile.email)}
          {channelRow("sms", <Phone className="w-3.5 h-3.5" />, profile.phoneE164)}
        </div>
      </div>

      {!!suppressions.length && (
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">Suppression records</p>
          <div className="space-y-1.5">
            {suppressions.map((s) => (
              <div key={s.id} className="text-xs rounded-lg border p-2 flex items-center justify-between gap-2">
                <span>{s.scope}{s.brandKey ? ` · ${s.brandKey}` : ""} · {s.reason.replace(/_/g, " ")}</span>
                <span className="text-muted-foreground">{fmtDateTime(s.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2 flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" />Event timeline</p>
        {!events.length ? (
          <p className="text-xs text-muted-foreground">No events recorded yet.</p>
        ) : (
          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            {events.map((e) => (
              <div key={e.id} className="text-xs flex items-center justify-between gap-2 border-b pb-1.5 last:border-0">
                <span className="font-medium">{e.metric}</span>
                <span className="text-muted-foreground">{fmtDateTime(e.occurredAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={confirm != null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.action === "suppress" ? "Suppress this profile?" : "Unsuppress this profile?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.action === "suppress"
                ? `This blocks ALL ${confirm.channel} marketing to this profile at the scope you choose below — it's the same gate that protects every send. This is serious and takes effect immediately.`
                : `This re-enables consent so the profile can receive ${confirm?.channel} marketing again. Only do this if they've genuinely asked to be re-subscribed.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirm?.action === "suppress" && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium">Scope</p>
              <Select value={scope} onValueChange={(v) => setScope(v as SuppressionScope)}>
                <SelectTrigger data-testid="mkt-suppress-scope"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="brand">This brand only</SelectItem>
                  <SelectItem value="global">Every USG brand (global)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={confirm?.action === "suppress" ? "bg-red-600 hover:bg-red-700" : undefined}
              disabled={suppress.isPending || unsuppress.isPending}
              onClick={() => {
                if (!confirm) return;
                if (confirm.action === "suppress") suppress.mutate({ channel: confirm.channel, scope });
                else unsuppress.mutate({ channel: confirm.channel });
              }}
              data-testid="mkt-suppress-confirm"
            >
              {confirm?.action === "suppress" ? "Suppress" : "Unsuppress"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
