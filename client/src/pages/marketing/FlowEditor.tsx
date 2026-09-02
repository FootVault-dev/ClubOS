// Marketing Suite — Flow editor (Phase E). A vertical step-list builder: the
// trigger card at the top, then delay / condition / email / SMS / update /
// exit step cards, with an add-step button between each. Publish snapshots an
// immutable version — running enrolments keep the version they entered on.
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft, Clock, GitBranch, Mail, MessageSquare, Tag, LogOut, Plus, Trash2, ChevronUp, ChevronDown,
  Zap, Rocket, Pause, Play, Send, AlertTriangle,
} from "lucide-react";
import type { MktFlow, MktFlowDetail, FlowStep, FlowStepType, FlowAnalytics, SmsPreview } from "./types";
import { FlowStatusBadge, flowTriggerSummary } from "./ui";

const newId = () => "s" + Math.random().toString(36).slice(2, 9);

const STEP_META: Record<FlowStepType, { label: string; icon: any; color: string }> = {
  delay: { label: "Wait", icon: Clock, color: "text-slate-500" },
  condition: { label: "Condition", icon: GitBranch, color: "text-violet-500" },
  email: { label: "Email", icon: Mail, color: "text-blue-500" },
  sms: { label: "SMS", icon: MessageSquare, color: "text-emerald-500" },
  update_property: { label: "Update property", icon: Tag, color: "text-amber-500" },
  exit: { label: "Exit flow", icon: LogOut, color: "text-red-500" },
};

function defaultStep(type: FlowStepType): FlowStep {
  const id = newId();
  const base = { id, next: null as string | null };
  switch (type) {
    case "delay": return { ...base, type, config: { value: 1, unit: "days" } };
    case "condition": return { ...base, type, config: { definition: { all: [] } }, nextIfFalse: null };
    case "email": return { ...base, type, config: { isMarketing: true, subject: "", bodyHtml: "<p>Hi {{first_name}},</p>\n<p></p>" } };
    case "sms": return { ...base, type, config: { isMarketing: true, body: "" } };
    case "update_property": return { ...base, type, config: { path: "", value: "" } };
    case "exit": return { ...base, type, config: { reason: "manual_exit" } };
  }
}

export default function FlowEditor() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/admin/marketing/flows/:id");
  const flowId = Number(params?.id);

  const { data: flow, isLoading } = useQuery<MktFlowDetail>({
    queryKey: [`/api/admin/marketing/flows/${flowId}`],
    enabled: Number.isFinite(flowId),
  });
  const { data: analytics } = useQuery<FlowAnalytics>({
    queryKey: [`/api/admin/marketing/flows/${flowId}/analytics`],
    enabled: Number.isFinite(flowId),
  });

  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<MktFlow["triggerType"]>("event");
  const [triggerConfig, setTriggerConfig] = useState<Record<string, any>>({});
  const [steps, setSteps] = useState<FlowStep[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);

  useEffect(() => {
    if (flow && !loaded) {
      setName(flow.name);
      setTriggerType(flow.triggerType);
      setTriggerConfig(flow.triggerConfig || {});
      setSteps((flow.draftGraph?.steps as FlowStep[]) || []);
      setLoaded(true);
    }
  }, [flow, loaded]);

  // Re-link next pointers into a linear chain; a condition's false edge is an
  // explicit null (exit the flow) so "only continue if…" gates work.
  const relinked = useMemo<FlowStep[]>(() => steps.map((s, i) => {
    const next = steps[i + 1]?.id ?? null;
    if (s.type === "condition") return { ...s, next, nextIfFalse: null };
    const { nextIfFalse, ...rest } = s as any;
    return { ...rest, next };
  }), [steps]);

  const saveDraft = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/admin/marketing/flows/${flowId}`, { name, triggerType, triggerConfig });
      await apiRequest("PUT", `/api/admin/marketing/flows/${flowId}/draft`, { graph: { steps: relinked, entry: relinked[0]?.id ?? null } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/admin/marketing/flows/${flowId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/marketing/flows"] });
      toast({ title: "Draft saved" });
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  const publish = useMutation({
    mutationFn: async () => {
      await saveDraft.mutateAsync();
      return apiRequest("POST", `/api/admin/marketing/flows/${flowId}/publish`, {}).then((r) => r.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/admin/marketing/flows/${flowId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/marketing/flows"] });
      setConfirmPublish(false);
      toast({ title: "Flow published", description: "New entrants get this version. Running enrolments keep theirs." });
    },
    onError: (e: any) => toast({ title: "Couldn't publish", description: e.message, variant: "destructive" }),
  });

  const setStatus = useMutation({
    mutationFn: (action: "pause" | "resume") => apiRequest("POST", `/api/admin/marketing/flows/${flowId}/${action}`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/admin/marketing/flows/${flowId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/marketing/flows"] });
    },
    onError: (e: any) => toast({ title: "Couldn't update", description: e.message, variant: "destructive" }),
  });

  function patchStep(idx: number, patch: Partial<FlowStep> | { config: Record<string, any> }) {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } as FlowStep : s)));
  }
  function patchConfig(idx: number, cfg: Record<string, any>) {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, config: { ...s.config, ...cfg } } : s)));
  }
  function insertStep(at: number, type: FlowStepType = "email") {
    setSteps((prev) => { const copy = [...prev]; copy.splice(at, 0, defaultStep(type)); return copy; });
  }
  function removeStep(idx: number) { setSteps((prev) => prev.filter((_, i) => i !== idx)); }
  function move(idx: number, dir: -1 | 1) {
    setSteps((prev) => {
      const j = idx + dir; if (j < 0 || j >= prev.length) return prev;
      const copy = [...prev]; [copy[idx], copy[j]] = [copy[j], copy[idx]]; return copy;
    });
  }

  if (isLoading || !flow) return <div className="p-6 text-sm text-muted-foreground">Loading flow…</div>;
  const isLive = flow.status === "live";

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-5">
      <button onClick={() => setLocation("/admin/marketing")} className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5" data-testid="mkt-flow-back">
        <ArrowLeft className="w-4 h-4" /> Back to Marketing
      </button>

      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} className="text-lg font-bold h-9 max-w-sm" data-testid="mkt-flow-name" />
            <FlowStatusBadge status={flow.status} />
            {flow.draftDirty && <Badge variant="outline" className="text-amber-500 border-amber-500/30">Unpublished changes</Badge>}
          </div>
          <p className="text-xs text-muted-foreground mt-1">{flowTriggerSummary({ triggerType, triggerConfig })}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => saveDraft.mutate()} disabled={saveDraft.isPending} data-testid="mkt-flow-save">Save draft</Button>
          {isLive
            ? <Button variant="outline" onClick={() => setStatus.mutate("pause")} disabled={setStatus.isPending} data-testid="mkt-flow-pause"><Pause className="w-4 h-4 mr-1.5" />Pause</Button>
            : flow.liveVersionId != null && <Button variant="outline" onClick={() => setStatus.mutate("resume")} disabled={setStatus.isPending} data-testid="mkt-flow-resume"><Play className="w-4 h-4 mr-1.5" />Resume</Button>}
          <Button onClick={() => setConfirmPublish(true)} disabled={publish.isPending || !steps.length} data-testid="mkt-flow-publish"><Rocket className="w-4 h-4 mr-1.5" />Publish</Button>
        </div>
      </div>

      {/* Trigger card */}
      <Card className="border-primary/30">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold"><Zap className="w-4 h-4 text-primary" /> Trigger — what starts this flow</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Trigger type</Label>
              <Select value={triggerType} onValueChange={(v) => setTriggerType(v as any)}>
                <SelectTrigger data-testid="mkt-flow-trigger-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="event">Event happens</SelectItem>
                  <SelectItem value="list">Added to a list</SelectItem>
                  <SelectItem value="segment">Enters a segment</SelectItem>
                  <SelectItem value="date_property">Date-based</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Re-entry</Label>
              <Select value={triggerConfig.reEntry || "never"} onValueChange={(v) => setTriggerConfig({ ...triggerConfig, reEntry: v })}>
                <SelectTrigger data-testid="mkt-flow-reentry"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">Once ever</SelectItem>
                  <SelectItem value="after_exit">Can re-enter after exiting</SelectItem>
                  <SelectItem value="always">Every time it triggers</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {triggerType === "event" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Trigger event (metric name)</Label>
                <Input value={triggerConfig.metricName || ""} onChange={(e) => setTriggerConfig({ ...triggerConfig, metricName: e.target.value })} placeholder="e.g. Started Registration" data-testid="mkt-flow-metric" />
              </div>
              <div>
                <Label className="text-xs">Exit / conversion event <span className="text-muted-foreground">(optional)</span></Label>
                <Input value={typeof triggerConfig.exitOn === "string" ? triggerConfig.exitOn : (triggerConfig.exitOn?.metricName || "")} onChange={(e) => setTriggerConfig({ ...triggerConfig, exitOn: e.target.value || undefined })} placeholder="e.g. Completed Registration" data-testid="mkt-flow-exiton" />
              </div>
            </div>
          )}
          {triggerType === "list" && (
            <div><Label className="text-xs">List ID</Label>
              <Input type="number" value={triggerConfig.listId ?? ""} onChange={(e) => setTriggerConfig({ ...triggerConfig, listId: Number(e.target.value) })} data-testid="mkt-flow-listid" /></div>
          )}
          {triggerType === "segment" && (
            <div><Label className="text-xs">Segment ID</Label>
              <Input type="number" value={triggerConfig.segmentId ?? ""} onChange={(e) => setTriggerConfig({ ...triggerConfig, segmentId: Number(e.target.value) })} data-testid="mkt-flow-segid" /></div>
          )}
          {triggerType === "date_property" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Date source</Label>
                <Select value={triggerConfig.source || "term_start"} onValueChange={(v) => setTriggerConfig({ ...triggerConfig, source: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="term_start">A fixed date (e.g. term start)</SelectItem>
                    <SelectItem value="profile_prop">A date on each profile</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {triggerConfig.source === "profile_prop" ? (
                <div><Label className="text-xs">Profile property path</Label>
                  <Input value={triggerConfig.propertyPath || ""} onChange={(e) => setTriggerConfig({ ...triggerConfig, propertyPath: e.target.value })} placeholder="e.g. membership_expiry" /></div>
              ) : (
                <div><Label className="text-xs">Date</Label>
                  <DatePickerInput value={triggerConfig.date || ""} onChange={(e) => setTriggerConfig({ ...triggerConfig, date: e.target.value })} data-testid="mkt-flow-date" /></div>
              )}
              <div><Label className="text-xs">Days offset (−14 = 14 days before)</Label>
                <Input type="number" value={triggerConfig.offsetDays ?? 0} onChange={(e) => setTriggerConfig({ ...triggerConfig, offsetDays: Number(e.target.value) })} /></div>
              <div><Label className="text-xs">Send time (NZ)</Label>
                <Input value={triggerConfig.time || "09:00"} onChange={(e) => setTriggerConfig({ ...triggerConfig, time: e.target.value })} placeholder="09:00" /></div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Steps */}
      <div className="space-y-0">
        <AddStep onAdd={(t) => insertStep(0, t)} first />
        {steps.map((step, i) => (
          <div key={step.id}>
            <StepCard
              step={step} index={i} total={steps.length} flowId={flowId}
              counts={analytics?.perStep?.[relinked[i]?.id ?? step.id]}
              onType={(t) => patchStep(i, { ...defaultStep(t), id: step.id })}
              onConfig={(cfg) => patchConfig(i, cfg)}
              onRemove={() => removeStep(i)}
              onMove={(d) => move(i, d)}
            />
            <AddStep onAdd={(t) => insertStep(i + 1, t)} />
          </div>
        ))}
        {!steps.length && (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            No steps yet. Add a wait, an email or an SMS above to build the journey.
          </div>
        )}
      </div>

      <AlertDialog open={confirmPublish} onOpenChange={setConfirmPublish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish this flow?</AlertDialogTitle>
            <AlertDialogDescription>
              New people who trigger the flow will get this version. Anyone already moving through it keeps the version they entered on — their scheduled messages are unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => publish.mutate()} disabled={publish.isPending}>Publish &amp; go live</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Add-step control (thin button between cards) ─────────────────────────────
function AddStep({ onAdd, first }: { onAdd: (t: FlowStepType) => void; first?: boolean }) {
  const [open, setOpen] = useState(false);
  const TYPES: FlowStepType[] = ["delay", "email", "sms", "condition", "update_property", "exit"];
  return (
    <div className={`flex justify-center ${first ? "pb-1" : "py-1"}`}>
      {!open ? (
        <button onClick={() => setOpen(true)} className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-full border border-dashed px-2.5 py-1" data-testid="mkt-flow-addstep">
          <Plus className="w-3 h-3" /> Add step
        </button>
      ) : (
        <div className="flex flex-wrap gap-1 justify-center rounded-lg border bg-muted/40 p-1">
          {TYPES.map((t) => { const M = STEP_META[t]; const Icon = M.icon; return (
            <button key={t} onClick={() => { onAdd(t); setOpen(false); }} className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-background" data-testid={`mkt-flow-addstep-${t}`}>
              <Icon className={`w-3.5 h-3.5 ${M.color}`} /> {M.label}
            </button>
          ); })}
          <button onClick={() => setOpen(false)} className="text-xs px-2 py-1 text-muted-foreground">✕</button>
        </div>
      )}
    </div>
  );
}

// ── One step card ────────────────────────────────────────────────────────────
function StepCard({ step, index, total, flowId, counts, onType, onConfig, onRemove, onMove }: {
  step: FlowStep; index: number; total: number; flowId: number;
  counts?: { sent: number; skipped: number; failed: number };
  onType: (t: FlowStepType) => void; onConfig: (cfg: Record<string, any>) => void;
  onRemove: () => void; onMove: (dir: -1 | 1) => void;
}) {
  const M = STEP_META[step.type];
  const Icon = M.icon;
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-[11px] font-semibold text-muted-foreground">{index + 1}</div>
            <Icon className={`w-4 h-4 ${M.color}`} />
            <Select value={step.type} onValueChange={(v) => onType(v as FlowStepType)}>
              <SelectTrigger className="h-8 w-[160px] text-sm" data-testid={`mkt-step-type-${index}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(STEP_META).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1 shrink-0 ml-auto">
            {counts && (counts.sent + counts.skipped + counts.failed > 0) && (
              <span className="text-[11px] text-muted-foreground mr-1">{counts.sent} sent · {counts.skipped} skipped{counts.failed ? ` · ${counts.failed} failed` : ""}</span>
            )}
            <Button size="icon" variant="ghost" className="h-7 w-7" disabled={index === 0} onClick={() => onMove(-1)}><ChevronUp className="w-4 h-4" /></Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" disabled={index === total - 1} onClick={() => onMove(1)}><ChevronDown className="w-4 h-4" /></Button>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-red-500 hover:text-red-500" onClick={onRemove} data-testid={`mkt-step-delete-${index}`}><Trash2 className="w-4 h-4" /></Button>
          </div>
        </div>

        {step.type === "delay" && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Wait</span>
            <Input type="number" min={0} value={step.config.value ?? 1} onChange={(e) => onConfig({ value: Number(e.target.value) })} className="w-20 h-8" data-testid={`mkt-step-delay-${index}`} />
            <Select value={step.config.unit || "days"} onValueChange={(v) => onConfig({ unit: v })}>
              <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="minutes">minutes</SelectItem>
                <SelectItem value="hours">hours</SelectItem>
                <SelectItem value="days">days</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">then continue</span>
          </div>
        )}

        {step.type === "email" && <EmailStep step={step} index={index} flowId={flowId} onConfig={onConfig} />}
        {step.type === "sms" && <SmsStep step={step} onConfig={onConfig} />}

        {step.type === "condition" && <ConditionStep step={step} onConfig={onConfig} />}

        {step.type === "update_property" && (
          <div className="grid gap-2 sm:grid-cols-2">
            <div><Label className="text-xs">Property</Label><Input value={step.config.path || ""} onChange={(e) => onConfig({ path: e.target.value })} placeholder="e.g. lifecycle_stage" /></div>
            <div><Label className="text-xs">Value</Label><Input value={step.config.value ?? ""} onChange={(e) => onConfig({ value: e.target.value })} placeholder="e.g. nurtured" /></div>
          </div>
        )}

        {step.type === "exit" && (
          <p className="text-sm text-muted-foreground">The person leaves the flow here (reason: {step.config.reason || "manual_exit"}).</p>
        )}
      </CardContent>
    </Card>
  );
}

function EmailStep({ step, index, flowId, onConfig }: { step: FlowStep; index: number; flowId: number; onConfig: (cfg: Record<string, any>) => void }) {
  const { toast } = useToast();
  const [testTo, setTestTo] = useState("");
  const test = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/marketing/flows/${flowId}/test-email`, { stepId: step.id, to: testTo }),
    onSuccess: () => toast({ title: "Test sent", description: `Sent to ${testTo}` }),
    onError: (e: any) => toast({ title: "Test failed", description: e.message, variant: "destructive" }),
  });
  return (
    <div className="space-y-2">
      <div><Label className="text-xs">Subject</Label>
        <Input value={step.config.subject || ""} onChange={(e) => onConfig({ subject: e.target.value })} placeholder="Subject line — use {{first_name}}" data-testid={`mkt-step-subject-${index}`} /></div>
      <div><Label className="text-xs">Body (HTML — merge tags like {"{{first_name}}"} supported)</Label>
        <Textarea value={step.config.bodyHtml || ""} onChange={(e) => onConfig({ bodyHtml: e.target.value })} rows={7} className="font-mono text-xs" data-testid={`mkt-step-body-${index}`} /></div>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={step.config.isMarketing !== false} onCheckedChange={(v) => onConfig({ isMarketing: v })} /> Marketing (off = operational, e.g. finish-your-registration)
        </label>
        <div className="flex items-center gap-1.5">
          <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@email.com" className="h-8 w-48" />
          <Button size="sm" variant="outline" disabled={!testTo || test.isPending} onClick={() => test.mutate()}><Send className="w-3.5 h-3.5 mr-1" />Test</Button>
        </div>
      </div>
    </div>
  );
}

function SmsStep({ step, onConfig }: { step: FlowStep; onConfig: (cfg: Record<string, any>) => void }) {
  const [preview, setPreview] = useState<SmsPreview | null>(null);
  const timer = useRef<any>(null);
  const body = step.config.body || "";
  const isMkt = step.config.isMarketing !== false;
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!body) { setPreview(null); return; }
    timer.current = setTimeout(async () => {
      try {
        const r = await apiRequest("POST", "/api/admin/marketing/flows/preview-sms", { body, isMarketing: isMkt });
        setPreview(await r.json());
      } catch { setPreview(null); }
    }, 400);
    return () => timer.current && clearTimeout(timer.current);
  }, [body, isMkt]);
  return (
    <div className="space-y-2">
      <div><Label className="text-xs">Message</Label>
        <Textarea value={body} onChange={(e) => onConfig({ body: e.target.value })} rows={3} placeholder="Keep it short — {{first_name}} supported" data-testid="mkt-step-sms" /></div>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={isMkt} onCheckedChange={(v) => onConfig({ isMarketing: v })} /> Marketing (appends “Reply STOP”)
        </label>
        {preview && (
          <div className="text-[11px] text-muted-foreground flex items-center gap-2">
            <Badge variant="outline" className={preview.encoding === "ucs2" ? "text-amber-500 border-amber-500/30" : "text-muted-foreground"}>{preview.encoding.toUpperCase()}</Badge>
            {preview.chars} chars · {preview.segments} segment{preview.segments === 1 ? "" : "s"} · ~{(preview.costEstimatePerRecipientCents / 100).toFixed(2)}/recipient
            {preview.encoding === "ucs2" && <span className="inline-flex items-center gap-1 text-amber-500"><AlertTriangle className="w-3 h-3" />non-GSM chars triple the cost</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// Compact condition builder (AND of single conditions) → {all:[{any:[cond]}]}.
// Continue only if ALL match; otherwise the person exits (a gate).
function ConditionStep({ step, onConfig }: { step: FlowStep; onConfig: (cfg: Record<string, any>) => void }) {
  const def = step.config.definition || { all: [] };
  const rows: any[] = (def.all || []).map((g: any) => (g.any?.[0] ?? g));
  const setRows = (next: any[]) => onConfig({ definition: { all: next.map((c) => ({ any: [c] })) } });
  const update = (i: number, patch: any) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Continue only if the person matches all of these — otherwise they exit the flow.</p>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5">
          <Select value={r.type || "profile_property"} onValueChange={(v) => update(i, { type: v })}>
            <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="profile_property">Profile property</SelectItem>
              <SelectItem value="event">Did an event</SelectItem>
              <SelectItem value="consent">Consent</SelectItem>
            </SelectContent>
          </Select>
          {r.type === "event" ? (
            <>
              <Input value={r.metric || ""} onChange={(e) => update(i, { metric: e.target.value })} placeholder="metric" className="h-8 w-40" />
              <Select value={r.op || ">="} onValueChange={(v) => update(i, { op: v })}>
                <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value=">=">at least</SelectItem><SelectItem value="zero">never</SelectItem></SelectContent>
              </Select>
              {r.op !== "zero" && <Input type="number" value={r.count ?? 1} onChange={(e) => update(i, { count: Number(e.target.value) })} className="h-8 w-16" />}
            </>
          ) : r.type === "consent" ? (
            <>
              <Select value={r.channel || "email"} onValueChange={(v) => update(i, { channel: v })}>
                <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="email">email</SelectItem><SelectItem value="sms">sms</SelectItem></SelectContent>
              </Select>
              <Select value={r.subState || "subscribed"} onValueChange={(v) => update(i, { subState: v })}>
                <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="subscribed">subscribed</SelectItem><SelectItem value="unsubscribed">unsubscribed</SelectItem></SelectContent>
              </Select>
            </>
          ) : (
            <>
              <Input value={r.path || ""} onChange={(e) => update(i, { path: e.target.value })} placeholder="field / props.key" className="h-8 w-40" />
              <Select value={r.op || "eq"} onValueChange={(v) => update(i, { op: v })}>
                <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="eq">is</SelectItem><SelectItem value="neq">is not</SelectItem>
                  <SelectItem value="contains">contains</SelectItem><SelectItem value="exists">exists</SelectItem>
                </SelectContent>
              </Select>
              {r.op !== "exists" && <Input value={r.value ?? ""} onChange={(e) => update(i, { value: e.target.value })} placeholder="value" className="h-8 w-32" />}
            </>
          )}
          <Button size="icon" variant="ghost" className="h-7 w-7 text-red-500" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 className="w-3.5 h-3.5" /></Button>
        </div>
      ))}
      <Button size="sm" variant="outline" onClick={() => setRows([...rows, { type: "profile_property", op: "eq" }])}><Plus className="w-3.5 h-3.5 mr-1" />Add condition</Button>
    </div>
  );
}
