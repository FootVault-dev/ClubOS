// Marketing Suite — the 4-step campaign wizard.
// Routes: /admin/marketing/campaigns/new (create) and
//         /admin/marketing/campaigns/:id/edit (resume a draft).
//
// A draft mkt_campaigns row is created immediately on entering "new" (the
// admin API has no "estimate against an unsaved definition" path for
// campaigns — audience-estimate reads audience off the saved row — so the
// wizard always has a real id to PATCH against from step 1 onward).
import { useEffect, useRef, useState, Component, type ReactNode, Suspense, lazy } from "react";
import { useRoute, useLocation, useSearch } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWorkspace } from "@/lib/workspace-context";
import { workspaceDomainBySlug } from "@shared/org-domains";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChevronLeft, ChevronRight, Check, X, Loader2, Send, CalendarClock, Users, Mail, MessageSquare, Code2, LayoutTemplate } from "lucide-react";
import type { MktCampaign, MktList, MktSegment, AudienceRef, CampaignAudience, AudienceEstimate, SmsCampaignPreview, MktChannel } from "./types";
import { fmtDateTime } from "./ui";
import { formatCurrency } from "@/lib/format";
import type { EmailBuilderResult } from "@/components/marketing/EmailBuilder";
import TemplatePicker from "@/components/marketing/TemplatePicker";

// Real money per SMS send — the send-confirm friction (type the recipient
// count) kicks in above this estimated cost. $50 NZD ex-GST.
const SMS_CONFIRM_COST_THRESHOLD_CENTS = 5000;

// Mirrors server/marketing/brand.ts BRAND_KEY_BY_ORG — client-side copy since
// that file lives under server/ and can't be imported from the browser bundle.
const BRAND_KEY_BY_ORG: Record<number, string> = { 1: "cufc", 2: "siu", 3: "mfl", 4: "usc", 5: "cic", 6: "cugc", 7: "usg", 8: "prints" };

const EmailBuilder = lazy(() => import("@/components/marketing/EmailBuilder"));

const STEPS = ["Audience", "Content", "Review", "Send"] as const;

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

// ── small error boundary — the EmailBuilder contract stub is under active
// development by a parallel agent; if it throws, fall back to raw HTML. ──────
class BuilderBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { hasError: boolean }> {
  constructor(props: any) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err: unknown) { console.warn("[Marketing] EmailBuilder crashed, falling back to simple HTML mode", err); }
  render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

export default function CampaignWizard() {
  const { toast } = useToast();
  const { currentOrg } = useWorkspace();
  const [, setLocation] = useLocation();
  const search = useSearch();
  const [editMatch, editParams] = useRoute("/admin/marketing/campaigns/:id/edit");
  const editId = editMatch ? Number(editParams?.id) : null;
  // Channel is chosen on "New campaign" (Campaigns.tsx) via ?channel=sms|email
  // and baked into the draft at creation — an edit-mode load overrides it from
  // the saved row (see the init effect below).
  const channelFromQuery: MktChannel = new URLSearchParams(search).get("channel") === "sms" ? "sms" : "email";

  const [step, setStep] = useState(0);
  const [campaignId, setCampaignId] = useState<number | null>(editId);
  const [loaded, setLoaded] = useState(editId == null); // create mode starts "loaded" with defaults
  const initRef = useRef(false);

  // form state
  const [name, setName] = useState("Untitled campaign");
  const [channel, setChannel] = useState<MktChannel>(channelFromQuery);
  const [audienceMode, setAudienceMode] = useState<"all" | "specific">("all");
  const [include, setInclude] = useState<AudienceRef[]>([]);
  const [exclude, setExclude] = useState<AudienceRef[]>([]);
  const [subject, setSubject] = useState("");
  const [preheader, setPreheader] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [simpleMode, setSimpleMode] = useState(true); // the Phase D builder is a contract stub today — default to a working editor
  // Template picker (Phase D → wizard wiring): applying a template hands us a
  // fresh Tiptap doc — the rich editor only reads `initialDoc` on mount, so a
  // `key` bump forces a clean remount with the new content. `builderResult`
  // mirrors whatever the editor (or plain-HTML mode) last produced, so
  // "Save current as template" always has a real { doc, html, text } to save.
  const [initialDoc, setInitialDoc] = useState<unknown | null>(null);
  const [builderKey, setBuilderKey] = useState(0);
  const [builderResult, setBuilderResult] = useState<EmailBuilderResult | null>(null);
  const [testEmail, setTestEmail] = useState("");
  // SMS-only content state (channel === 'sms').
  const [smsBody, setSmsBody] = useState("");
  const [allowUnicode, setAllowUnicode] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [sendMode, setSendMode] = useState<"now" | "schedule">("now");
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("10:00");
  const [confirmSend, setConfirmSend] = useState(false);
  const [confirmCountInput, setConfirmCountInput] = useState(""); // send-confirm friction for expensive SMS sends
  const [blocked, setBlocked] = useState<string | null>(null);

  const { data: lists = [] } = useQuery<MktList[]>({ queryKey: ["/api/admin/marketing/lists"] });
  const { data: segments = [] } = useQuery<MktSegment[]>({ queryKey: ["/api/admin/marketing/segments"] });

  const createDraft = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/admin/marketing/campaigns", { name: "Untitled campaign", channel: channelFromQuery });
      return r.json() as Promise<MktCampaign>;
    },
    onSuccess: (row) => { setCampaignId(row.id); setChannel(row.channel === "sms" ? "sms" : "email"); setLoaded(true); },
    onError: (e: any) => toast({ title: "Couldn't start a new campaign", description: e.message, variant: "destructive" }),
  });

  // Load an existing draft (edit route) once.
  const { data: existing } = useQuery<MktCampaign>({
    queryKey: ["/api/admin/marketing/campaigns", editId],
    enabled: editId != null,
  });

  useEffect(() => {
    if (initRef.current) return;
    if (editId != null) {
      if (!existing) return;
      initRef.current = true;
      if (existing.status !== "draft") { setBlocked(existing.status); return; }
      setName(existing.name);
      const ch: MktChannel = existing.channel === "sms" ? "sms" : "email";
      setChannel(ch);
      const aud = existing.audience || {};
      const inc = aud.include ?? [];
      if (inc.some((r) => r.type === "all")) { setAudienceMode("all"); }
      else { setAudienceMode("specific"); setInclude(inc); }
      setExclude(aud.exclude ?? []);
      if (ch === "sms") {
        setSmsBody(existing.bodyHtml ?? "");
        setAllowUnicode(aud.smsOptions?.allowUnicode === true);
      } else {
        setSubject(existing.subject ?? "");
        setPreheader(existing.preheader ?? "");
        setReplyTo(existing.replyTo ?? "");
        setBodyHtml(existing.bodyHtml ?? "");
      }
      setLoaded(true);
    } else if (!initRef.current) {
      initRef.current = true;
      createDraft.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId, existing]);

  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      if (!campaignId) return null;
      const r = await apiRequest("PATCH", `/api/admin/marketing/campaigns/${campaignId}`, body);
      return r.json();
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  const currentAudience: CampaignAudience = {
    ...(audienceMode === "all" ? { include: [{ type: "all" as const }] } : { include }),
    exclude,
    ...(channel === "sms" ? { smsOptions: { allowUnicode } } : {}),
  };

  // Debounced audience autosave → re-estimate whenever include/exclude/mode changes.
  const estimate = useMutation({
    mutationFn: async () => {
      if (!campaignId) return null;
      await apiRequest("PATCH", `/api/admin/marketing/campaigns/${campaignId}`, { audience: currentAudience });
      const r = await apiRequest("POST", `/api/admin/marketing/campaigns/${campaignId}/audience-estimate`);
      return r.json() as Promise<AudienceEstimate>;
    },
  });
  useEffect(() => {
    if (!campaignId || !loaded) return;
    const t = setTimeout(() => estimate.mutate(), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, loaded, audienceMode, JSON.stringify(include), JSON.stringify(exclude)]);

  // Re-check compliance whenever step 3 is reached.
  const reviewEstimate = useQuery<AudienceEstimate>({
    queryKey: ["/api/admin/marketing/campaigns", campaignId, "audience-estimate", step],
    queryFn: async () => (await apiRequest("POST", `/api/admin/marketing/campaigns/${campaignId}/audience-estimate`)).json(),
    enabled: step === 2 && campaignId != null,
  });

  const testSend = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/marketing/campaigns/${campaignId}/test-email`, { to: testEmail.trim() }).then((r) => r.json()),
    onSuccess: (r: { ok: boolean; skipped?: boolean }) =>
      toast(r.ok ? { title: "Test sent", description: `Check ${testEmail}` } : { title: "Test failed", description: r.skipped ? "Resend isn't configured in this environment." : "Check the address and try again.", variant: "destructive" }),
    onError: (e: any) => toast({ title: "Couldn't send test", description: e.message, variant: "destructive" }),
  });

  // Live SMS cost/encoding preview (debounced) — runs the SAME compose pipeline
  // the send worker uses, so what's shown while typing matches what gets sent.
  const smsPreview = useMutation({
    mutationFn: async () => {
      if (!campaignId) return null;
      const r = await apiRequest("POST", `/api/admin/marketing/campaigns/${campaignId}/sms-preview`, { body: smsBody, allowUnicode });
      return r.json() as Promise<SmsCampaignPreview>;
    },
  });
  useEffect(() => {
    if (!campaignId || !loaded || channel !== "sms") return;
    const t = setTimeout(() => smsPreview.mutate(), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, loaded, channel, smsBody, allowUnicode]);

  const testSms = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/marketing/campaigns/${campaignId}/test-sms`, { to: testPhone.trim() }).then((r) => r.json()),
    onSuccess: (r: { ok: boolean }) =>
      toast(r.ok ? { title: "Test sent", description: `Check ${testPhone}` } : { title: "Test failed", description: "Check the number and try again.", variant: "destructive" }),
    onError: (e: any) => toast({ title: "Couldn't send test", description: e.message, variant: "destructive" }),
  });

  const sendNow = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/marketing/campaigns/${campaignId}/send-now`),
    onSuccess: () => { toast({ title: "Sending now" }); queryClient.invalidateQueries({ queryKey: ["/api/admin/marketing/campaigns"] }); setLocation(`/admin/marketing/campaigns/${campaignId}`); },
    onError: (e: any) => { setConfirmSend(false); toast({ title: "Couldn't send", description: e.message, variant: "destructive" }); },
  });
  const schedule = useMutation({
    mutationFn: () => {
      const iso = new Date(`${scheduleDate}T${scheduleTime}:00`).toISOString();
      return apiRequest("POST", `/api/admin/marketing/campaigns/${campaignId}/schedule`, { scheduledAt: iso });
    },
    onSuccess: () => { toast({ title: "Scheduled" }); queryClient.invalidateQueries({ queryKey: ["/api/admin/marketing/campaigns"] }); setLocation(`/admin/marketing/campaigns/${campaignId}`); },
    onError: (e: any) => toast({ title: "Couldn't schedule", description: e.message, variant: "destructive" }),
  });

  const brandKey = currentOrg ? (BRAND_KEY_BY_ORG[currentOrg.id] ?? "usg") : "usg";
  const fromDisplay = currentOrg ? (() => { const w = workspaceDomainBySlug(currentOrg.slug); return w ? `${w.fromName} <noreply@${w.emailDomain}>` : "United Sports Group <noreply@cufc.co.nz>"; })() : "";

  if (blocked) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">This campaign is <span className="font-semibold">{blocked}</span> and can no longer be edited.</p>
        <Button variant="outline" size="sm" onClick={() => setLocation(`/admin/marketing/campaigns/${editId}`)}>View campaign →</Button>
      </div>
    );
  }
  if (!loaded || !campaignId) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Setting up your campaign…</div>;
  }

  const sendableCount = (step === 0 ? estimate.data : reviewEstimate.data)?.sendable ?? null;
  const contentOk = channel === "sms" ? smsBody.trim().length > 0 : stripHtml(bodyHtml).length > 0;
  // What "Save current as template" saves: the rich editor's last compiled
  // result in that mode, or a synthetic { doc: null, html, text } built from
  // the plain-HTML textarea in simple mode — either way, whatever's on screen.
  const currentBuilderResult: EmailBuilderResult | null = simpleMode
    ? (bodyHtml.trim() ? { doc: null, html: bodyHtml, text: stripHtml(bodyHtml) } : null)
    : builderResult;
  const subjectOk = channel === "sms" ? true : subject.trim().length > 0; // SMS has no subject line
  const audienceOk = (sendableCount ?? 0) > 0;
  const reviewOk = contentOk && subjectOk && audienceOk;

  // Real-money friction: an SMS send over $50 (ex-GST) requires typing the
  // exact recipient count to confirm before either send button is enabled.
  const smsCostCents = channel === "sms" ? (smsPreview.data?.estCostCents ?? 0) : 0;
  const needsCountConfirm = channel === "sms" && smsCostCents > SMS_CONFIRM_COST_THRESHOLD_CENTS;
  const countConfirmed = !needsCountConfirm || Number(confirmCountInput.trim()) === (sendableCount ?? -1);

  const goStep = async (next: number) => {
    if (step === 0) await patch.mutateAsync({ name: name.trim() || "Untitled campaign", audience: currentAudience });
    if (step === 1) {
      if (channel === "sms") {
        await patch.mutateAsync({ bodyHtml: smsBody, audience: currentAudience });
      } else {
        await patch.mutateAsync({ subject: subject.trim(), preheader: preheader.trim() || null, replyTo: replyTo.trim() || null, bodyHtml });
      }
    }
    setStep(next);
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-2 flex-wrap">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border ${i === step ? "bg-primary text-primary-foreground border-primary" : i < step ? "text-emerald-500 border-emerald-500/30 bg-emerald-500/10" : "text-muted-foreground"}`}>
              {i < step ? <Check className="w-3 h-3" /> : <span>{i + 1}</span>} {s}
            </div>
            {i < STEPS.length - 1 && <div className="w-4 h-px bg-border" />}
          </div>
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="mkt-wizard-name">Campaign name</Label>
            <Input id="mkt-wizard-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Term 3 registrations reminder" data-testid="mkt-wizard-name" />
          </div>

          <div className="flex items-center gap-2">
            {(["all", "specific"] as const).map((m) => (
              <button key={m} onClick={() => setAudienceMode(m)} data-testid={`mkt-wizard-audience-${m}`}
                className={`text-xs font-medium px-3 py-1.5 rounded-lg border ${audienceMode === m ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground"}`}>
                {m === "all" ? "Everyone" : "Specific lists & segments"}
              </button>
            ))}
          </div>

          {audienceMode === "specific" && (
            <div className="grid sm:grid-cols-2 gap-4">
              <AudiencePicker title="Include" lists={lists} segments={segments} value={include} onChange={setInclude} testPrefix="include" />
              <AudiencePicker title="Exclude (optional)" lists={lists} segments={segments} value={exclude} onChange={setExclude} testPrefix="exclude" />
            </div>
          )}

          <Card>
            <CardContent className={`p-4 grid ${channel === "sms" ? "grid-cols-4" : "grid-cols-3"} gap-3 text-center`}>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Total</p>
                <p className="text-xl font-bold">{estimate.isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : (estimate.data?.total ?? "—")}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Suppressed</p>
                <p className="text-xl font-bold text-muted-foreground">{estimate.isPending ? "…" : (estimate.data?.suppressed ?? "—")}</p>
              </div>
              {channel === "sms" && (
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground">No phone</p>
                  <p className="text-xl font-bold text-muted-foreground">{estimate.isPending ? "…" : (estimate.data?.noPhone ?? "—")}</p>
                </div>
              )}
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Sendable</p>
                <p className="text-2xl font-extrabold text-emerald-500" data-testid="mkt-wizard-sendable">{estimate.isPending ? <Loader2 className="w-5 h-5 animate-spin mx-auto text-emerald-500" /> : (estimate.data?.sendable ?? "—")}</p>
              </div>
            </CardContent>
          </Card>

          <WizardFooter onNext={() => goStep(1)} nextDisabled={patch.isPending} />
        </div>
      )}

      {step === 1 && channel === "sms" && (
        <SmsContentStep
          smsBody={smsBody} setSmsBody={setSmsBody}
          allowUnicode={allowUnicode} setAllowUnicode={setAllowUnicode}
          preview={smsPreview.data} previewPending={smsPreview.isPending}
          onBack={() => setStep(0)} onNext={() => goStep(2)} nextDisabled={patch.isPending || !contentOk}
        />
      )}

      {step === 1 && channel === "email" && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="mkt-wizard-subject">Subject</Label>
            <Input id="mkt-wizard-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="What shows up in the inbox" data-testid="mkt-wizard-subject" />
          </div>
          <div>
            <Label htmlFor="mkt-wizard-preheader">Preview text</Label>
            <Input id="mkt-wizard-preheader" value={preheader} onChange={(e) => setPreheader(e.target.value)} placeholder="The preview snippet after the subject" data-testid="mkt-wizard-preheader" />
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <Label>From</Label>
              <Input value={fromDisplay} disabled className="text-muted-foreground" data-testid="mkt-wizard-from" />
            </div>
            <div>
              <Label htmlFor="mkt-wizard-reply-to">Reply-to (optional)</Label>
              <Input id="mkt-wizard-reply-to" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="you@yourclub.co.nz" data-testid="mkt-wizard-reply-to" />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <Label>Content</Label>
            <button onClick={() => setSimpleMode((s) => !s)} className="text-xs text-primary hover:underline flex items-center gap-1 shrink-0" data-testid="mkt-wizard-toggle-editor">
              {simpleMode ? (
                <><LayoutTemplate className="w-3.5 h-3.5" /> Design with templates</>
              ) : (
                <><Code2 className="w-3.5 h-3.5" /> Switch to plain HTML</>
              )}
            </button>
          </div>

          <TemplatePicker
            currentResult={currentBuilderResult}
            onApply={(result) => {
              setBodyHtml(result.html);
              setBuilderResult(result);
              setInitialDoc(result.doc);
              setBuilderKey((k) => k + 1); // force the rich editor to remount with the applied doc
            }}
            channel="email"
            className="rounded-lg border p-3"
          />

          {simpleMode ? (
            <Textarea value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)} rows={14} placeholder="<p>Write your email HTML here…</p>" className="font-mono text-xs" data-testid="mkt-wizard-body-html" />
          ) : (
            <BuilderBoundary fallback={<Textarea value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)} rows={14} placeholder="<p>Write your email HTML here…</p>" className="font-mono text-xs" />}>
              <Suspense fallback={<div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">Loading editor…</div>}>
                <EmailBuilder
                  key={builderKey}
                  workspaceId={currentOrg?.id ?? 0}
                  brandKey={brandKey}
                  initialDoc={initialDoc}
                  onSave={(result) => { setBodyHtml(result.html); setBuilderResult(result); }}
                />
              </Suspense>
            </BuilderBoundary>
          )}
          <p className="text-[11px] text-muted-foreground">An unsubscribe footer is added automatically — no need to include one yourself.</p>

          <WizardFooter onBack={() => setStep(0)} onNext={() => goStep(2)} nextDisabled={patch.isPending || !subjectOk} />
        </div>
      )}

      {step === 2 && channel === "sms" && (
        <div className="space-y-4">
          <div className="rounded-xl border divide-y">
            <ComplianceRow ok label="Reply STOP to opt out" note="Appended automatically to every marketing SMS." />
            <ComplianceRow ok label="Quiet hours (8pm–8am NZ)" note="A send that lands in the quiet window queues automatically to 8am NZ — nothing texts overnight." />
            <ComplianceRow ok={contentOk} label="Message present" note={contentOk ? "Body has content." : "Add a message in step 2."} />
            <ComplianceRow
              ok={audienceOk}
              label={`${sendableCount ?? "…"} recipients with express consent (sendable)`}
              note={reviewEstimate.isLoading ? "Checking…" : audienceOk ? "Ready to send." : "0 sendable — check your audience, consent, and phone numbers in step 1."}
            />
          </div>

          <Card>
            <CardContent className="p-4 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Estimated cost</span>
              <span className="font-semibold" data-testid="mkt-wizard-sms-cost">
                {smsPreview.data ? `${formatCurrency(smsPreview.data.estCostCents, { fromCents: true })} + GST for ${smsPreview.data.totalMessages.toLocaleString()} messages` : "—"}
              </span>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-2">
              <Label htmlFor="mkt-wizard-test-phone">Send a test</Label>
              <div className="flex gap-2">
                <Input id="mkt-wizard-test-phone" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="+64211234567" data-testid="mkt-wizard-test-phone" />
                <Button variant="outline" onClick={() => testSms.mutate()} disabled={!testPhone.trim() || testSms.isPending} data-testid="mkt-wizard-test-send-sms">
                  {testSms.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageSquare className="w-4 h-4" />}
                </Button>
              </div>
            </CardContent>
          </Card>

          <WizardFooter onBack={() => setStep(1)} onNext={() => setStep(3)} nextDisabled={!reviewOk} nextLabel="Continue to send" />
        </div>
      )}

      {step === 2 && channel === "email" && (
        <div className="space-y-4">
          <div className="rounded-xl border divide-y">
            <ComplianceRow ok label="One-click unsubscribe headers" note="Added automatically to every marketing send (RFC 8058)." />
            <ComplianceRow ok label="Suppression gate" note="Every recipient is checked against consent + suppressions before sending." />
            <ComplianceRow ok={subjectOk} label="Subject present" note={subjectOk ? subject : "Add a subject in step 2."} />
            <ComplianceRow ok={contentOk} label="Content present" note={contentOk ? "Body has content." : "Add content in step 2."} />
            <ComplianceRow
              ok={audienceOk}
              label={`${sendableCount ?? "…"} recipients after suppression`}
              note={reviewEstimate.isLoading ? "Checking…" : audienceOk ? "Ready to send." : "0 sendable — check your audience and consent in step 1."}
            />
          </div>

          <Card>
            <CardContent className="p-4 space-y-2">
              <Label htmlFor="mkt-wizard-test-email">Send a test</Label>
              <div className="flex gap-2">
                <Input id="mkt-wizard-test-email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="you@email.com" data-testid="mkt-wizard-test-email" />
                <Button variant="outline" onClick={() => testSend.mutate()} disabled={!testEmail.trim() || testSend.isPending} data-testid="mkt-wizard-test-send">
                  {testSend.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                </Button>
              </div>
            </CardContent>
          </Card>

          <WizardFooter onBack={() => setStep(1)} onNext={() => setStep(3)} nextDisabled={!reviewOk} nextLabel="Continue to send" />
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            {(["now", "schedule"] as const).map((m) => (
              <button key={m} onClick={() => setSendMode(m)} data-testid={`mkt-wizard-send-mode-${m}`}
                className={`text-xs font-medium px-3 py-1.5 rounded-lg border flex items-center gap-1.5 ${sendMode === m ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground"}`}>
                {m === "now" ? <Send className="w-3.5 h-3.5" /> : <CalendarClock className="w-3.5 h-3.5" />} {m === "now" ? "Send now" : "Schedule"}
              </button>
            ))}
          </div>

          {sendMode === "schedule" && (
            <div className="grid sm:grid-cols-2 gap-4 max-w-md">
              <div>
                <Label>Date</Label>
                <DatePickerInput value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} data-testid="mkt-wizard-schedule-date" />
              </div>
              <div>
                <Label htmlFor="mkt-wizard-schedule-time">Time</Label>
                <Input id="mkt-wizard-schedule-time" type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} data-testid="mkt-wizard-schedule-time" />
              </div>
              <p className="text-[11px] text-muted-foreground sm:col-span-2">Scheduled in your local time — NZ (Pacific/Auckland) for the club's own staff.</p>
            </div>
          )}

          <Card>
            <CardContent className="p-4 text-sm space-y-1">
              <p><span className="text-muted-foreground">Campaign:</span> {name}</p>
              {channel === "email" ? (
                <p><span className="text-muted-foreground">Subject:</span> {subject}</p>
              ) : (
                <p className="line-clamp-2"><span className="text-muted-foreground">Message:</span> {smsPreview.data?.finalBody || smsBody}</p>
              )}
              <p><span className="text-muted-foreground">Sendable:</span> {reviewEstimate.data?.sendable ?? sendableCount ?? "—"} recipients</p>
              {channel === "sms" && smsPreview.data && (
                <p><span className="text-muted-foreground">Estimated cost:</span> {formatCurrency(smsPreview.data.estCostCents, { fromCents: true })} + GST</p>
              )}
            </CardContent>
          </Card>

          {needsCountConfirm && (
            <Card className="border-amber-500/40">
              <CardContent className="p-4 space-y-2">
                <p className="text-sm text-amber-500 font-medium">
                  This is a real-money send — an estimated {formatCurrency(smsCostCents, { fromCents: true })} + GST for {sendableCount ?? 0} messages.
                </p>
                <Label htmlFor="mkt-wizard-confirm-count" className="text-xs text-muted-foreground">Type {sendableCount ?? 0} to confirm before sending or scheduling</Label>
                <Input id="mkt-wizard-confirm-count" value={confirmCountInput} onChange={(e) => setConfirmCountInput(e.target.value)} placeholder={`${sendableCount ?? 0}`} data-testid="mkt-wizard-confirm-count" />
              </CardContent>
            </Card>
          )}

          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setStep(2)}><ChevronLeft className="w-4 h-4 mr-1" /> Back</Button>
            {sendMode === "now" ? (
              <Button onClick={() => setConfirmSend(true)} disabled={!reviewOk || sendNow.isPending || !countConfirmed} data-testid="mkt-wizard-send-now">
                <Send className="w-4 h-4 mr-1.5" /> Send to {sendableCount ?? 0} now
              </Button>
            ) : (
              <Button onClick={() => schedule.mutate()} disabled={!reviewOk || !scheduleDate || schedule.isPending || !countConfirmed} data-testid="mkt-wizard-schedule">
                {schedule.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <CalendarClock className="w-4 h-4 mr-1.5" />} Schedule send
              </Button>
            )}
          </div>
        </div>
      )}

      <AlertDialog open={confirmSend} onOpenChange={setConfirmSend}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send "{name}" now?</AlertDialogTitle>
            <AlertDialogDescription>
              This sends to <span className="font-semibold text-foreground">{sendableCount ?? 0} recipients</span> immediately. There's no recall once it's out — send yourself a test first if you haven't.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => sendNow.mutate()} disabled={sendNow.isPending || !countConfirmed} data-testid="mkt-wizard-confirm-send">
              {sendNow.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null} Send now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function WizardFooter({ onBack, onNext, nextDisabled, nextLabel }: { onBack?: () => void; onNext: () => void; nextDisabled?: boolean; nextLabel?: string }) {
  return (
    <div className="flex items-center gap-2 pt-2">
      {onBack && <Button variant="ghost" onClick={onBack}><ChevronLeft className="w-4 h-4 mr-1" /> Back</Button>}
      <Button onClick={onNext} disabled={nextDisabled} data-testid="mkt-wizard-next">
        {nextLabel ?? "Continue"} <ChevronRight className="w-4 h-4 ml-1" />
      </Button>
    </div>
  );
}

// SMS "Content" step (channel === 'sms') — the message textarea + live
// feedback: char/segment count, GSM-7-vs-Unicode encoding badge, the
// auto-appended "Reply STOP to opt out" suffix shown greyed inline, a
// sanitize-notice for any character sanitizeToGsm7 stripped, and the
// allowUnicode override with its cost warning.
const STOP_SUFFIX_MARKER = "Reply STOP to opt out";
function SmsContentStep({
  smsBody, setSmsBody, allowUnicode, setAllowUnicode, preview, previewPending, onBack, onNext, nextDisabled,
}: {
  smsBody: string; setSmsBody: (v: string) => void;
  allowUnicode: boolean; setAllowUnicode: (v: boolean) => void;
  preview?: SmsCampaignPreview | null; previewPending: boolean;
  onBack: () => void; onNext: () => void; nextDisabled?: boolean;
}) {
  const finalBody = preview?.finalBody ?? "";
  const suffixIdx = finalBody.indexOf(STOP_SUFFIX_MARKER);
  const mainPart = suffixIdx >= 0 ? finalBody.slice(0, suffixIdx) : finalBody;
  const suffixPart = suffixIdx >= 0 ? finalBody.slice(suffixIdx) : "";

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="mkt-wizard-sms-body">Message</Label>
        <Textarea
          id="mkt-wizard-sms-body" value={smsBody} onChange={(e) => setSmsBody(e.target.value)} rows={6}
          placeholder="Training moved to 6pm tonight, same field. See you there!" data-testid="mkt-wizard-sms-body"
        />
      </div>

      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="text-xs text-muted-foreground">
          {previewPending ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : `${preview?.chars ?? 0} chars · ${preview?.segments ?? 0} segment${(preview?.segments ?? 0) === 1 ? "" : "s"}`}
        </span>
        {preview && (
          <Badge variant="outline" className={preview.encoding === "ucs2" ? "text-amber-500 border-amber-500/30 bg-amber-500/10" : "text-emerald-500 border-emerald-500/30 bg-emerald-500/10"}>
            {preview.encoding === "ucs2" ? "Unicode — costs more" : "GSM-7"}
          </Badge>
        )}
      </div>

      <div className="rounded-lg border border-dashed p-3 text-xs" data-testid="mkt-wizard-sms-preview">
        <p className="text-muted-foreground mb-1">Preview — what actually sends:</p>
        {finalBody ? (
          <p>
            <span>{mainPart}</span>
            {suffixPart && <span className="text-muted-foreground/60">{suffixPart}</span>}
          </p>
        ) : (
          <p className="text-muted-foreground">Start typing above…</p>
        )}
      </div>

      {!allowUnicode && (preview?.sanitizedRemoved?.length ?? 0) > 0 && (
        <p className="text-xs text-amber-500" data-testid="mkt-wizard-sanitize-notice">
          Removed non-SMS characters (smart quotes, emoji, etc): <span className="font-mono">{preview!.sanitizedRemoved.join(" ")}</span> — turn on "Allow unicode" below to keep them.
        </p>
      )}

      <label className="flex items-center gap-2 text-xs cursor-pointer">
        <Switch checked={allowUnicode} onCheckedChange={setAllowUnicode} data-testid="mkt-wizard-allow-unicode" />
        Allow unicode / emoji — uses UCS-2 encoding (up to 3x the segments and cost per message)
      </label>

      <Card>
        <CardContent className="p-4 grid grid-cols-2 gap-3 text-center">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Messages</p>
            <p className="text-xl font-bold">{previewPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : (preview?.totalMessages ?? "—")}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Est. cost</p>
            <p className="text-xl font-bold">{preview ? `${formatCurrency(preview.estCostCents, { fromCents: true })} + GST` : "—"}</p>
          </div>
        </CardContent>
      </Card>
      <p className="text-[11px] text-muted-foreground">"Reply STOP to opt out" is added automatically to every marketing SMS — no need to include it yourself.</p>

      <WizardFooter onBack={onBack} onNext={onNext} nextDisabled={nextDisabled} />
    </div>
  );
}

function ComplianceRow({ ok, label, note }: { ok: boolean; label: string; note?: string }) {
  return (
    <div className="flex items-start gap-3 p-3">
      <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${ok ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500"}`}>
        {ok ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
    </div>
  );
}

function AudiencePicker({ title, lists, segments, value, onChange, testPrefix }: {
  title: string; lists: MktList[]; segments: MktSegment[]; value: AudienceRef[]; onChange: (v: AudienceRef[]) => void; testPrefix: string;
}) {
  const has = (type: "list" | "segment", id: number) => value.some((r) => r.type === type && r.id === id);
  const toggle = (type: "list" | "segment", id: number) => {
    onChange(has(type, id) ? value.filter((r) => !(r.type === type && r.id === id)) : [...value, { type, id }]);
  };
  return (
    <div className="rounded-lg border p-3 space-y-2">
      <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1.5"><Users className="w-3.5 h-3.5" />{title}</p>
      {!lists.length && !segments.length ? (
        <p className="text-xs text-muted-foreground">No lists or segments yet.</p>
      ) : (
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {lists.map((l) => (
            <label key={`list-${l.id}`} className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox checked={has("list", l.id)} onCheckedChange={() => toggle("list", l.id)} data-testid={`mkt-wizard-${testPrefix}-list-${l.id}`} />
              {l.name} <span className="text-xs text-muted-foreground">({l.memberCount})</span>
            </label>
          ))}
          {segments.map((s) => (
            <label key={`seg-${s.id}`} className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox checked={has("segment", s.id)} onCheckedChange={() => toggle("segment", s.id)} data-testid={`mkt-wizard-${testPrefix}-segment-${s.id}`} />
              {s.name} <span className="text-xs text-muted-foreground">({s.memberCount})</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
