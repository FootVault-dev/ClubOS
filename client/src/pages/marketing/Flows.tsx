// Marketing Suite — Flows list (Phase E). The automations home: live/paused/draft
// flows with their trigger, enrolments, messages sent and attributed revenue.
// "New flow" opens the template gallery (the 3 launch flows) or a blank flow;
// creating navigates to the editor at its own route (/admin/marketing/flows/:id).
import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Zap, Plus, TrendingUp, Mail, Clock, FileText } from "lucide-react";
import type { MktFlow, FlowTemplateCard } from "./types";
import { EmptyState, LoadingRows, FlowStatusBadge, flowTriggerSummary } from "./ui";

function money(n: number): string {
  return `$${(n || 0).toLocaleString("en-NZ", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export default function FlowsView() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [galleryOpen, setGalleryOpen] = useState(false);

  const { data: flows = [], isLoading } = useQuery<MktFlow[]>({
    queryKey: ["/api/admin/marketing/flows"],
  });
  const { data: templates = [] } = useQuery<FlowTemplateCard[]>({
    queryKey: ["/api/admin/marketing/flows/templates"],
    enabled: galleryOpen,
  });

  const create = useMutation({
    mutationFn: (body: { templateKey?: string }) => apiRequest("POST", "/api/admin/marketing/flows", body).then((r) => r.json()),
    onSuccess: (flow: MktFlow) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/marketing/flows"] });
      setGalleryOpen(false);
      setLocation(`/admin/marketing/flows/${flow.id}`);
    },
    onError: (e: any) => toast({ title: "Couldn't create flow", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Automated journeys that run 24/7 — recover abandoned enrolments, remind families to re-register, welcome new sign-ups.
        </p>
        <Button onClick={() => setGalleryOpen(true)} data-testid="mkt-flow-new">
          <Plus className="w-4 h-4 mr-1.5" /> New flow
        </Button>
      </div>

      {isLoading ? (
        <LoadingRows rows={4} />
      ) : !flows.length ? (
        <EmptyState
          icon={Zap}
          title="No flows yet — automations do the heavy lifting"
          description="Flows earn far more per person than one-off campaigns because they're perfectly timed. Start with a proven template."
          action={<Button size="sm" className="mt-2" onClick={() => setGalleryOpen(true)}>Browse flow templates</Button>}
        />
      ) : (
        <div className="rounded-xl border overflow-x-auto">
          <Table className="min-w-[680px]">
            <TableHeader>
              <TableRow>
                <TableHead>Flow</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Completed</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {flows.map((f) => (
                <TableRow key={f.id} className="cursor-pointer" onClick={() => setLocation(`/admin/marketing/flows/${f.id}`)} data-testid={`mkt-flow-row-${f.id}`}>
                  <TableCell className="font-medium">
                    {f.name}
                    <div className="text-xs text-muted-foreground">{flowTriggerSummary(f)}</div>
                  </TableCell>
                  <TableCell><FlowStatusBadge status={f.status} /></TableCell>
                  <TableCell className="text-right tabular-nums">{f.stats?.activeEnrollments ?? 0}</TableCell>
                  <TableCell className="text-right tabular-nums">{f.stats?.completed ?? 0}</TableCell>
                  <TableCell className="text-right tabular-nums">{f.stats?.messagesSent ?? 0}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{money(f.stats?.revenue ?? 0)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Template gallery */}
      <Dialog open={galleryOpen} onOpenChange={setGalleryOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Start a new flow</DialogTitle>
            <DialogDescription>Pick a proven template to start fast, or build from scratch. Everything is editable afterwards.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-1 max-h-[60vh] overflow-y-auto pr-1">
            {templates.map((t) => (
              <button
                key={t.key}
                disabled={create.isPending}
                onClick={() => create.mutate({ templateKey: t.key })}
                data-testid={`mkt-flow-template-${t.key}`}
                className="text-left rounded-xl border p-4 hover:border-primary/60 hover:bg-muted/40 transition-colors disabled:opacity-50"
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{t.name}</span>
                  <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><Mail className="w-3 h-3" />{t.stepCount} steps</span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">{t.description}</p>
                <p className="text-xs text-emerald-600 dark:text-emerald-500 mt-2 inline-flex items-start gap-1.5"><TrendingUp className="w-3.5 h-3.5 mt-0.5 shrink-0" />{t.expectedImpact}</p>
              </button>
            ))}
            <button
              disabled={create.isPending}
              onClick={() => create.mutate({})}
              data-testid="mkt-flow-template-blank"
              className="text-left rounded-xl border border-dashed p-4 hover:border-primary/60 hover:bg-muted/40 transition-colors disabled:opacity-50"
            >
              <div className="flex items-center gap-2 font-semibold"><FileText className="w-4 h-4" /> Blank flow</div>
              <p className="text-sm text-muted-foreground mt-1">Start empty — choose your own trigger and steps.</p>
            </button>
          </div>
          {create.isPending && <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Clock className="w-3.5 h-3.5 animate-spin" /> Creating…</p>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
