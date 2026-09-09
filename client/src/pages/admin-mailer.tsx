import { useState, useRef, useCallback, useMemo, useEffect, Fragment, lazy, Suspense } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Mail, Send, ChevronRight, ChevronLeft, Users, Trash2, Plus, X,
  Bold, Italic, Underline, AlignLeft, AlignCenter, AlignRight,
  List, ListOrdered, Link as LinkIcon, Image, Type, Palette,
  Eye, Loader2, CheckCircle2, AlertCircle, Upload, Heading1,
  Heading2, Minus, RotateCcw, Search,
} from "lucide-react";

import { useWorkspace } from "@/lib/workspace-context";

// The visual builder is a ~725KB GrapesJS bundle. Lazy so the Mailer's Setup
// and Send steps stay light and it only streams in when you reach Content.
const EmailBuilder = lazy(() => import("@/components/marketing/EmailBuilder"));

// Which brand the canvas and the starter templates dress themselves in. The
// keys are brand-themes.ts's; an unknown workspace gets the neutral theme
// rather than another club's colours.
const BRAND_BY_SLUG: Record<string, string> = {
  "christchurch-united": "cufc",
  "south-island-united": "siu",
  "mini-football-leagues": "mfl",
  "united-gymnastics": "cugc",
  "united-sports-centre": "usc",
  "christchurch-international-cup": "cic",
  "united-sports-group": "usg",
  "united-prints": "prints",
};

type SegmentData = {
  campId: number;
  campName: string;
  dates: { id: number; date: string }[];
};

type Campaign = {
  id: number;
  subject: string;
  fromEmail: string;
  segmentType: string;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  status: string;
  sentAt: string | null;
  createdAt: string;
};

// The full row, fetched only when a past send is opened — this one carries the
// HTML that actually went out.
type CampaignDetail = Campaign & {
  body: string;
  replyTo: string | null;
  segmentConfig: string | null;
};

const STEPS = ["Setup", "Content", "Send"];
const HISTORY_PAGE = 10;

// "cic_youth_custom" → "CIC youth custom". Segment types are namespaced by the
// mailer that sent them, which is what tells CIC sends apart from camp sends.
function segmentLabel(segmentType: string) {
  const pretty = String(segmentType || "").replace(/_/g, " ").trim();
  if (!pretty) return "—";
  return pretty.replace(/^(cic|cufc|mfl|siu)\b/i, (m) => m.toUpperCase());
}

function formatSentAt(c: { sentAt: string | null; createdAt: string }) {
  const stamp = c.sentAt || c.createdAt;
  return new Date(stamp).toLocaleDateString("en-NZ", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export default function AdminMailer() {
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [segmentType, setSegmentType] = useState("all");
  const [selectedCampId, setSelectedCampId] = useState<number | null>(null);
  const [selectedDateId, setSelectedDateId] = useState<number | null>(null);
  const [selectedSession, setSelectedSession] = useState<string>("");
  const [manualEmails, setManualEmails] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [subject, setSubject] = useState("");
  const [fromEmail, setFromEmail] = useState("CUFC Camps <noreply@cufc.co.nz>");
  const [replyTo, setReplyTo] = useState("info@cufc.co.nz");
  const [hasEditorContent, setHasEditorContent] = useState(false);
  const { currentOrg } = useWorkspace();
  const brandKey = BRAND_BY_SLUG[currentOrg?.slug ?? ""] ?? "";

  const [bodyHtml, setBodyHtml] = useState("");
  // The editable design behind the HTML. Kept beside `bodyHtml` rather than
  // instead of it: the send only ever reads the compiled HTML, so a design that
  // fails to load can never stop an email going out.
  const [bodyDoc, setBodyDoc] = useState<unknown | null>(null);
  const [designSavedAt, setDesignSavedAt] = useState<Date | null>(null);
  const [textColor, setTextColor] = useState("#333333");
  const [bgColor, setBgColor] = useState("#ffffff");
  const textColorRef = useRef<HTMLInputElement>(null);
  const bgColorRef = useRef<HTMLInputElement>(null);

  // Send history — search + paging + the opened campaign.
  const [historySearch, setHistorySearch] = useState("");
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE);
  const [openCampaignId, setOpenCampaignId] = useState<number | null>(null);

  const { data: segments = [] } = useQuery<SegmentData[]>({
    queryKey: ["/api/admin/mailer/segments"],
  });

  // Debounced so typing doesn't fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setHistoryQuery(historySearch.trim());
      setHistoryLimit(HISTORY_PAGE);
    }, 250);
    return () => clearTimeout(t);
  }, [historySearch]);

  const { data: history, isFetching: historyLoading } = useQuery<{ campaigns: Campaign[]; total: number }>({
    queryKey: ["/api/admin/mailer/campaigns", historyQuery, historyLimit],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/admin/mailer/campaigns?q=${encodeURIComponent(historyQuery)}&limit=${historyLimit}`,
      );
      return res.json();
    },
    placeholderData: (prev) => prev,
  });
  const campaigns = history?.campaigns ?? [];
  const historyTotal = history?.total ?? 0;

  const { data: openCampaign, isFetching: openCampaignLoading } = useQuery<CampaignDetail>({
    queryKey: ["/api/admin/mailer/campaigns", "detail", openCampaignId],
    enabled: openCampaignId !== null,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/mailer/campaigns/${openCampaignId}`);
      return res.json();
    },
  });

  const segmentConfig = useMemo(() => {
    if (segmentType === "camp" && selectedCampId) return { campId: selectedCampId };
    if (segmentType === "day" && selectedCampId && selectedDateId) return { campId: selectedCampId, campDateId: selectedDateId };
    if (segmentType === "session" && selectedCampId && selectedDateId && selectedSession) return { campId: selectedCampId, campDateId: selectedDateId, sessionType: selectedSession };
    if (segmentType === "custom") return { emails: manualEmails };
    return {};
  }, [segmentType, selectedCampId, selectedDateId, selectedSession, manualEmails]);

  const previewMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/mailer/preview-recipients", { segmentType, segmentConfig }),
    onSuccess: async (res) => {
      const data = await res.json();
      toast({ title: `${data.count} recipient${data.count !== 1 ? "s" : ""} found` });
    },
  });

  // The builder hands back the doc, the compiled email-safe HTML and a plain-text
  // version in one go. `hasEditorContent` gates the Next button, so it tracks the
  // TEXT: a design of nothing but a spacer is not something to email 3,800 people.
  const handleDesignSave = useCallback((result: { doc: unknown; html: string; text: string }) => {
    setBodyHtml(result.html);
    setBodyDoc(result.doc);
    setHasEditorContent((result.text || "").trim().length > 0);
    setDesignSavedAt(new Date());
  }, []);

  // 🔴 Nothing in this page had ever called /test-send, so there was no way to
  // see your own email before 3,800 people did. It posts the real subject and
  // design through the same renderer as the live send, so what arrives is what
  // they get — unsubscribe footer and all.
  const [testEmail, setTestEmail] = useState("");
  const testMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/admin/mailer/test-send", {
        to: testEmail.trim(),
        subject,
        body: bodyHtml,
        fromEmail,
        replyTo,
      }),
    onSuccess: () =>
      toast({
        title: "Test sent",
        description: `Check ${testEmail.trim()} — it is the real email, marked [TEST].`,
      }),
    onError: (e: any) =>
      toast({ title: "Test failed", description: e?.message || "Could not send the test.", variant: "destructive" }),
  });

  const sendMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/admin/mailer/send", {
        subject,
        body: bodyHtml,
        bodyDoc,
        fromEmail,
        replyTo,
        segmentType,
        segmentConfig,
        manualEmails: manualEmails.length > 0 ? manualEmails : undefined,
      }),
    onSuccess: async (res) => {
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/admin/mailer/campaigns"] });
      // The send is a QUEUE now, not a burst that finishes inside the request —
      // it paces at ~1.5/s to stay under Resend's 10/s limit, so 3,861 people
      // takes about 40 minutes. Claiming "sent!" the instant the button is
      // pressed is exactly how nobody noticed 75% were being rejected.
      toast({
        title: "Sending started",
        description: `${data.recipientCount} ${data.recipientCount === 1 ? "person" : "people"} queued. It sends steadily — watch the count on this page climb.`,
      });
      setStep(0);
      setSubject("");
      setBodyHtml("");
      setBodyDoc(null);
      setDesignSavedAt(null);
      setHasEditorContent(false);
      setManualEmails([]);
      setSegmentType("all");
    },
    onError: (error: any) => {
      toast({ title: "Send failed", description: error.message, variant: "destructive" });
    },
  });

  const addManualEmail = useCallback(() => {
    const email = emailInput.trim();
    if (email && email.includes("@") && !manualEmails.includes(email)) {
      setManualEmails(prev => [...prev, email]);
      setEmailInput("");
    }
  }, [emailInput, manualEmails]);

  const removeManualEmail = useCallback((email: string) => {
    setManualEmails(prev => prev.filter(e => e !== email));
  }, []);


  const selectedCamp = segments.find(s => s.campId === selectedCampId);
  const selectedDate = selectedCamp?.dates.find(d => d.id === selectedDateId);

  const canProceedSetup = segmentType === "all" ||
    (segmentType === "camp" && selectedCampId) ||
    (segmentType === "day" && selectedCampId && selectedDateId) ||
    (segmentType === "session" && selectedCampId && selectedDateId && selectedSession) ||
    (segmentType === "custom" && manualEmails.length > 0);

  const canSend = subject.trim() && (hasEditorContent || bodyHtml.trim().length > 0);

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white/90" data-testid="text-mailer-title">Mailer</h1>
          <p className="text-sm text-white/40 mt-1">Build and send email campaigns to your contacts</p>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-6">
        {STEPS.map((label, i) => (
          <Fragment key={label}>
            {i > 0 && <ChevronRight className="w-4 h-4 text-white/20" />}
            <button
              onClick={() => i <= step ? setStep(i) : undefined}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                i === step
                  ? "bg-blue-500/15 text-blue-400 border border-blue-500/25"
                  : i < step
                  ? "bg-white/5 text-white/60 border border-white/10 cursor-pointer hover:bg-white/10"
                  : "bg-white/[0.02] text-white/20 border border-white/5 cursor-default"
              }`}
              data-testid={`button-step-${label.toLowerCase()}`}
            >
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
                i < step ? "bg-green-500/20 text-green-400" : i === step ? "bg-blue-500/20 text-blue-400" : "bg-white/5 text-white/20"
              }`}>
                {i < step ? "✓" : i + 1}
              </span>
              {label}
            </button>
          </Fragment>
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-6">
          <div className="glass-card rounded-2xl p-6 space-y-5">
            <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">Recipients</h2>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {[
                { key: "all", label: "All Contacts", desc: "Every parent email" },
                { key: "camp", label: "By Camp", desc: "Registered to a camp" },
                { key: "day", label: "By Day", desc: "Specific camp day" },
                { key: "session", label: "By Session", desc: "Morning or afternoon" },
                { key: "custom", label: "Custom List", desc: "Manual email entry" },
              ].map(seg => (
                <button
                  key={seg.key}
                  onClick={() => { setSegmentType(seg.key); setSelectedCampId(null); setSelectedDateId(null); setSelectedSession(""); }}
                  className={`p-4 rounded-xl border text-left transition-all ${
                    segmentType === seg.key
                      ? "bg-blue-500/10 border-blue-500/30 shadow-[0_0_12px_rgba(59,130,246,0.1)]"
                      : "bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]"
                  }`}
                  data-testid={`button-segment-${seg.key}`}
                >
                  <div className={`text-sm font-medium ${segmentType === seg.key ? "text-blue-400" : "text-white/70"}`}>{seg.label}</div>
                  <div className="text-xs text-white/30 mt-1">{seg.desc}</div>
                </button>
              ))}
            </div>

            {(segmentType === "camp" || segmentType === "day" || segmentType === "session") && (
              <div className="space-y-3">
                <label className="text-xs text-white/40 uppercase tracking-wider">Select Camp</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {segments.map(s => (
                    <button
                      key={s.campId}
                      onClick={() => { setSelectedCampId(s.campId); setSelectedDateId(null); setSelectedSession(""); }}
                      className={`p-3 rounded-xl border text-left text-sm transition-all ${
                        selectedCampId === s.campId
                          ? "bg-blue-500/10 border-blue-500/30 text-blue-400"
                          : "bg-white/[0.02] border-white/[0.06] text-white/60 hover:bg-white/[0.04]"
                      }`}
                      data-testid={`button-camp-${s.campId}`}
                    >
                      {s.campName}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(segmentType === "day" || segmentType === "session") && selectedCamp && (
              <div className="space-y-3">
                <label className="text-xs text-white/40 uppercase tracking-wider">Select Day</label>
                <div className="flex flex-wrap gap-2">
                  {selectedCamp.dates.map(d => (
                    <button
                      key={d.id}
                      onClick={() => { setSelectedDateId(d.id); setSelectedSession(""); }}
                      className={`px-4 py-2 rounded-xl border text-sm transition-all ${
                        selectedDateId === d.id
                          ? "bg-blue-500/10 border-blue-500/30 text-blue-400"
                          : "bg-white/[0.02] border-white/[0.06] text-white/60 hover:bg-white/[0.04]"
                      }`}
                      data-testid={`button-date-${d.id}`}
                    >
                      {new Date(d.date + "T12:00:00").toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" })}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {segmentType === "session" && selectedDateId && (
              <div className="space-y-3">
                <label className="text-xs text-white/40 uppercase tracking-wider">Select Session</label>
                <div className="flex gap-2">
                  {["morning", "afternoon", "full_day"].map(s => (
                    <button
                      key={s}
                      onClick={() => setSelectedSession(s)}
                      className={`px-4 py-2 rounded-xl border text-sm capitalize transition-all ${
                        selectedSession === s
                          ? "bg-blue-500/10 border-blue-500/30 text-blue-400"
                          : "bg-white/[0.02] border-white/[0.06] text-white/60 hover:bg-white/[0.04]"
                      }`}
                      data-testid={`button-session-${s}`}
                    >
                      {s.replace("_", " ")}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {segmentType === "custom" && (
              <div className="space-y-3">
                <label className="text-xs text-white/40 uppercase tracking-wider">Enter Email Addresses</label>
                <div className="flex gap-2">
                  <Input
                    value={emailInput}
                    onChange={e => setEmailInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addManualEmail(); } }}
                    placeholder="email@example.com"
                    className="premium-input text-white/80 flex-1"
                    data-testid="input-manual-email"
                  />
                  <Button onClick={addManualEmail} variant="outline" className="border-blue-500/30 text-blue-400 hover:bg-blue-500/10" data-testid="button-add-email">
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
                {manualEmails.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {manualEmails.map(email => (
                      <Badge key={email} variant="outline" className="border-blue-500/20 text-blue-400 bg-blue-500/5 gap-1 pr-1">
                        {email}
                        <button onClick={() => removeManualEmail(email)} className="ml-1 hover:text-red-400" data-testid={`button-remove-${email}`}>
                          <X className="w-3 h-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            )}

            {segmentType !== "custom" && (
              <div className="space-y-3">
                <label className="text-xs text-white/40 uppercase tracking-wider">Additional Manual Emails (Optional)</label>
                <div className="flex gap-2">
                  <Input
                    value={emailInput}
                    onChange={e => setEmailInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addManualEmail(); } }}
                    placeholder="Add extra emails manually..."
                    className="premium-input text-white/80 flex-1"
                    data-testid="input-extra-email"
                  />
                  <Button onClick={addManualEmail} variant="outline" className="border-white/10 text-white/40 hover:bg-white/5" data-testid="button-add-extra-email">
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
                {manualEmails.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {manualEmails.map(email => (
                      <Badge key={email} variant="outline" className="border-white/10 text-white/50 bg-white/[0.02] gap-1 pr-1">
                        {email}
                        <button onClick={() => removeManualEmail(email)} className="ml-1 hover:text-red-400" data-testid={`button-remove-extra-${email}`}>
                          <X className="w-3 h-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Button
                onClick={() => previewMutation.mutate()}
                variant="outline"
                className="border-white/10 text-white/60 hover:bg-white/5"
                disabled={!canProceedSetup || previewMutation.isPending}
                data-testid="button-preview-recipients"
              >
                {previewMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Users className="w-4 h-4 mr-2" />}
                Preview Recipients
              </Button>
              <Button
                onClick={() => setStep(1)}
                disabled={!canProceedSetup}
                className="bg-blue-600 hover:bg-blue-700 text-white"
                data-testid="button-next-content"
              >
                Next: Content
                <ChevronRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>

          <div className="glass-card rounded-2xl p-6 space-y-4">
            <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">Sender Details</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-white/40 mb-1.5 block">From Email</label>
                <Input value={fromEmail} onChange={e => setFromEmail(e.target.value)} className="premium-input text-white/80" data-testid="input-from-email" />
              </div>
              <div>
                <label className="text-xs text-white/40 mb-1.5 block">Reply-To</label>
                <Input value={replyTo} onChange={e => setReplyTo(e.target.value)} className="premium-input text-white/80" data-testid="input-reply-to" />
              </div>
            </div>
          </div>

          {(historyTotal > 0 || historyQuery) && (
            <div className="glass-card rounded-2xl p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">Send History</h2>
                <div className="relative w-full sm:w-72">
                  <Search className="w-3.5 h-3.5 text-white/30 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <Input
                    value={historySearch}
                    onChange={e => setHistorySearch(e.target.value)}
                    placeholder="Search subject or content..."
                    className="premium-input text-white/80 pl-9 pr-8 h-9 text-sm"
                    data-testid="input-search-campaigns"
                  />
                  {historySearch && (
                    <button
                      onClick={() => setHistorySearch("")}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70"
                      title="Clear search"
                      data-testid="button-clear-campaign-search"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              <div className="text-xs text-white/30">
                {historyQuery
                  ? `${historyTotal} ${historyTotal === 1 ? "email" : "emails"} matching "${historyQuery}"`
                  : `${historyTotal} ${historyTotal === 1 ? "email" : "emails"} sent — click one to see what went out`}
              </div>

              {campaigns.length === 0 && !historyLoading && (
                <div className="p-6 text-center text-sm text-white/30">No emails match that search.</div>
              )}

              <div className="space-y-2">
                {campaigns.map(c => (
                  <button
                    key={c.id}
                    onClick={() => setOpenCampaignId(c.id)}
                    className="w-full flex items-center justify-between gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/[0.06] text-left transition-all hover:bg-white/[0.05] hover:border-white/[0.12]"
                    data-testid={`button-campaign-${c.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-white/70 truncate" data-testid={`text-campaign-subject-${c.id}`}>{c.subject}</div>
                      <div className="text-xs text-white/30 mt-0.5 truncate">
                        {formatSentAt(c)} · {segmentLabel(c.segmentType)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className={`text-xs ${c.status === "sent" ? "border-green-500/20 text-green-400" : c.status === "failed" ? "border-red-500/20 text-red-400" : "border-yellow-500/20 text-yellow-400"}`}>
                        {c.status === "sent" ? <CheckCircle2 className="w-3 h-3 mr-1" /> : c.status === "failed" ? <AlertCircle className="w-3 h-3 mr-1" /> : null}
                        {c.sentCount}/{c.recipientCount}
                      </Badge>
                      <ChevronRight className="w-4 h-4 text-white/20" />
                    </div>
                  </button>
                ))}
              </div>

              {campaigns.length < historyTotal && (
                <Button
                  onClick={() => setHistoryLimit(l => l + HISTORY_PAGE)}
                  variant="outline"
                  disabled={historyLoading}
                  className="w-full border-white/10 text-white/50 hover:bg-white/5"
                  data-testid="button-load-more-campaigns"
                >
                  {historyLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Show older ({historyTotal - campaigns.length} more)
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <div className="glass-card rounded-2xl p-6 space-y-4">
            <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">Subject Line</h2>
            <Input
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Enter your email subject..."
              className="premium-input text-white/80 text-lg h-12"
              data-testid="input-subject"
            />
          </div>

          <div className="glass-card rounded-2xl p-4 space-y-3">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">Design</h2>
                {/* There is no left or right pane on a phone, so the phone is
                    not told to use one. */}
                <p className="text-xs text-white/35 mt-1 max-w-xl hidden md:block">
                  Drag a section in from the left, click any text to edit it, and style it on the right.
                  Hit <span className="text-white/60 font-medium">Save design</span> when it looks right —
                  that is what gets sent.
                </p>
                <p className="text-xs text-white/35 mt-1 max-w-xl md:hidden">
                  Edit the email below and hit <span className="text-white/60 font-medium">Save</span> —
                  that is what gets sent. The drag-and-drop designer needs a laptop.
                </p>
              </div>
              {designSavedAt && (
                <span
                  className="text-xs text-emerald-400/80 flex items-center gap-1.5 shrink-0"
                  data-testid="text-design-saved"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Design saved {designSavedAt.toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" })}
                </span>
              )}
            </div>

            {/* A definite height, but ONLY from md up. The three-pane shell
                (palette · canvas · inspector) collapses to nothing inside an
                auto-height parent, so on a laptop it gets 74vh — tall enough to
                work in, short enough to leave Back/Next on screen.
                🔴 Below 768px the builder swaps itself for the plain-HTML
                fallback, which is ~950px of notice + editor + preview: inside a
                fixed 74vh box with overflow-hidden the preview was cut off
                entirely and could not be scrolled to. Height and clipping are
                therefore desktop-only, and `md` here MUST stay in step with
                useIsNarrow(767) in EmailBuilder — they are the same boundary. */}
            <div
              className="rounded-xl border border-white/10 bg-white md:overflow-hidden md:h-[74vh] md:min-h-[560px]"
              data-testid="email-builder"
            >
              <Suspense
                fallback={
                  <div className="h-full flex items-center justify-center gap-2 text-sm text-gray-500">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading the builder…
                  </div>
                }
              >
                <EmailBuilder
                  workspaceId={currentOrg?.id ?? 1}
                  brandKey={brandKey}
                  initialDoc={bodyDoc}
                  initialHtml={bodyHtml}
                  onSave={handleDesignSave}
                  onDirty={() => setDesignSavedAt(null)}
                />
              </Suspense>
            </div>

            {!designSavedAt && bodyHtml.trim().length > 0 && (
              <p className="text-xs text-amber-400/70 flex items-center gap-1.5" data-testid="text-design-unsaved">
                <AlertCircle className="w-3.5 h-3.5" />
                You have changes that are not saved yet — press Save design in the builder.
              </p>
            )}
          </div>

          <div className="flex items-center justify-between">
            <Button
              onClick={() => setStep(0)}
              variant="outline"
              className="border-white/10 text-white/60 hover:bg-white/5"
              data-testid="button-back-setup"
            >
              <ChevronLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
            <Button
              onClick={() => setStep(2)}
              disabled={!canSend}
              className="bg-blue-600 hover:bg-blue-700 text-white"
              data-testid="button-next-send"
            >
              Next: Review & Send
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="glass-card rounded-2xl p-6 space-y-4">
            <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">Review Campaign</h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.06]">
                <div className="text-xs text-white/40 mb-1">Subject</div>
                <div className="text-sm text-white/80" data-testid="text-review-subject">{subject}</div>
              </div>
              <div className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.06]">
                <div className="text-xs text-white/40 mb-1">From</div>
                <div className="text-sm text-white/80" data-testid="text-review-from">{fromEmail}</div>
              </div>
              <div className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.06]">
                <div className="text-xs text-white/40 mb-1">Segment</div>
                <div className="text-sm text-white/80 capitalize" data-testid="text-review-segment">
                  {segmentType === "all" ? "All contacts" :
                   segmentType === "camp" ? `Camp: ${selectedCamp?.campName || ""}` :
                   segmentType === "day" ? `${selectedCamp?.campName || ""} — ${selectedDate ? new Date(selectedDate.date + "T12:00:00").toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" }) : ""}` :
                   segmentType === "session" ? `${selectedCamp?.campName || ""} — ${selectedSession.replace("_", " ")}` :
                   `Custom (${manualEmails.length} emails)`}
                </div>
              </div>
              <div className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.06]">
                <div className="text-xs text-white/40 mb-1">Reply To</div>
                <div className="text-sm text-white/80" data-testid="text-review-reply">{replyTo}</div>
              </div>
            </div>

            <div className="rounded-xl border border-white/10 overflow-hidden">
              <div className="bg-gray-50 p-4">
                {/* An iframe, not a div. The builder compiles a COMPLETE email
                    document; dropping one into a div makes the browser discard
                    its html/head/body and leaks the email's CSS into the admin,
                    so the review would not show what the recipient gets. */}
                <iframe
                  title="Email preview"
                  srcDoc={bodyHtml}
                  sandbox=""
                  className="w-full max-w-[640px] mx-auto block bg-white rounded-lg shadow-sm border border-gray-100"
                  style={{ height: 560 }}
                  data-testid="iframe-review-preview"
                />
              </div>
            </div>
          </div>

          <div className="glass-card rounded-2xl p-4 space-y-2">
            <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">Send yourself a test first</h2>
            <p className="text-xs text-white/35">
              The same email the list gets, subject prefixed with [TEST]. Worth doing every time —
              it is the only place a broken image or an ugly line break shows up before it is too late.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Input
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                placeholder="you@cufc.co.nz"
                className="premium-input text-white/80 flex-1 min-w-[220px]"
                data-testid="input-test-email"
              />
              <Button
                variant="outline"
                onClick={() => testMutation.mutate()}
                disabled={!testEmail.includes("@") || !bodyHtml.trim() || testMutation.isPending}
                className="border-white/10 text-white/70 hover:bg-white/5"
                data-testid="button-send-test"
              >
                {testMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 animate-spin mr-2" />Sending…</>
                ) : (
                  <><Eye className="w-4 h-4 mr-2" />Send test</>
                )}
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <Button
              onClick={() => setStep(1)}
              variant="outline"
              className="border-white/10 text-white/60 hover:bg-white/5"
              data-testid="button-back-content"
            >
              <ChevronLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
            <Button
              onClick={() => sendMutation.mutate()}
              disabled={sendMutation.isPending}
              className="bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white px-6"
              data-testid="button-send-campaign"
            >
              {sendMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-2" />
                  Send Campaign
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      <Dialog open={openCampaignId !== null} onOpenChange={o => { if (!o) setOpenCampaignId(null); }}>
        <DialogContent className="max-w-3xl bg-[#0a0f1a] border border-white/10 text-white/90 max-h-[85vh] overflow-y-auto">
          <DialogTitle className="text-base font-semibold text-white/90 pr-8 leading-snug min-w-0 break-words" data-testid="text-campaign-detail-subject">
            {openCampaign?.subject || (openCampaignLoading ? "Loading..." : "Campaign")}
          </DialogTitle>

          {openCampaignLoading && !openCampaign ? (
            <div className="py-16 flex items-center justify-center text-white/30">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : openCampaign ? (
            // min-w-0 all the way down: a sent email is built on fixed-width
            // tables (600px is the email standard), and without this its
            // min-content width drags the whole dialog wider than the phone.
            <div className="space-y-4 min-w-0">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <DetailField label="Sent" value={formatSentAt(openCampaign)} />
                <DetailField
                  label="Delivered"
                  value={`${openCampaign.sentCount} of ${openCampaign.recipientCount}${openCampaign.failedCount > 0 ? ` — ${openCampaign.failedCount} failed` : ""}`}
                />
                <DetailField label="From" value={openCampaign.fromEmail} />
                <DetailField label="Reply-to" value={openCampaign.replyTo || "—"} />
                <DetailField label="Audience" value={segmentLabel(openCampaign.segmentType)} />
                <DetailField label="Status" value={openCampaign.status} />
              </div>

              {recipientList(openCampaign.segmentConfig).length > 0 && (
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.06]">
                  <div className="text-xs text-white/40 mb-2">Sent to these addresses</div>
                  <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                    {recipientList(openCampaign.segmentConfig).map(email => (
                      <Badge key={email} variant="outline" className="border-white/10 text-white/50 bg-white/[0.02] text-[11px] font-normal">
                        {email}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              <div className="min-w-0">
                <div className="text-xs text-white/40 mb-2">What was sent</div>
                <div className="rounded-xl border border-white/10 overflow-hidden min-w-0">
                  {/* The email scrolls sideways inside this box rather than
                      pushing the dialog off the screen. */}
                  <div className="bg-gray-50 p-4 overflow-x-auto">
                    <div className="max-w-[600px] mx-auto bg-white rounded-lg shadow-sm p-6 border border-gray-100">
                      <div
                        className="prose prose-sm max-w-none [&_img]:max-w-full [&_img]:h-auto"
                        style={{ color: "#333", lineHeight: "1.6" }}
                        dangerouslySetInnerHTML={{ __html: openCampaign.body }}
                        data-testid="html-campaign-body"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="py-10 text-center text-sm text-white/40">Couldn't load that campaign.</div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.06] min-w-0">
      <div className="text-xs text-white/40 mb-1">{label}</div>
      <div className="text-sm text-white/80 break-words">{value}</div>
    </div>
  );
}

// Custom sends record the exact address list they went to in segmentConfig.
// Segment sends don't (the audience was a query), so this returns nothing.
function recipientList(segmentConfig: string | null): string[] {
  if (!segmentConfig) return [];
  try {
    const parsed = JSON.parse(segmentConfig);
    const emails = parsed?.emails;
    return Array.isArray(emails) ? emails.filter((e: unknown) => typeof e === "string") : [];
  } catch {
    return [];
  }
}

function ToolBtn({ icon: Icon, label, onClick }: { icon: any; cmd?: string; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="h-8 w-8 rounded-lg flex items-center justify-center text-white/40 hover:text-white/70 hover:bg-white/[0.06] transition-all"
      title={label}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
}
