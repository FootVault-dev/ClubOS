import { useState, useRef, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Mail, Users, Send, Search, Download, Crown, Loader2, Bold, Italic, List,
  Link2, Heading, Eye, CheckCircle2, AlertTriangle, X,
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { LeagueCompetition } from "@shared/schema";

type Contact = { name: string; email: string; phone: string; role: string; team: string; league: string; term: string; unsubscribed: boolean };
type Campaign = { id: number; subject: string; recipientCount: number | null; sentCount: number | null; failedCount: number | null; status: string; scheduledAt: string | null; sentAt: string | null; createdAt: string };
type Division = { id: number; name: string };
type View = "compose" | "contacts";

export default function LeagueMailer() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const { toast } = useToast();
  const [view, setView] = useState<View>("compose");

  // Audience selection (shared by compose + contacts)
  const [termId, setTermId] = useState<string>("all");
  const [audience, setAudience] = useState<"captains" | "all">("all");

  const { data: terms = [] } = useQuery<LeagueCompetition[]>({
    queryKey: ["/api/admin/league/competitions", { orgId }],
    queryFn: () => fetch(`/api/admin/league/competitions?orgId=${orgId}`).then((r) => r.json()),
    enabled: !!orgId,
  });

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Mailer</h1>
          <p className="text-sm text-white/40 mt-1">Your MFL contact database + newsletters and updates</p>
        </div>
        <div className="inline-flex rounded-lg border border-white/5 bg-white/[0.02] p-0.5">
          {([["compose", "Compose"], ["contacts", "Contacts"]] as const).map(([v, label]) => (
            <button key={v} onClick={() => setView(v)} data-testid={`mailer-view-${v}`}
              className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${view === v ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {view === "contacts"
        ? <ContactsView termId={termId} setTermId={setTermId} terms={terms} />
        : <ComposeView termId={termId} setTermId={setTermId} audience={audience} setAudience={setAudience} terms={terms} toast={toast} />}
    </div>
  );
}

// ── Contacts (CRM) ────────────────────────────────────────────────────────────
function ContactsView({ termId, setTermId, terms }: { termId: string; setTermId: (s: string) => void; terms: LeagueCompetition[] }) {
  const [q, setQ] = useState("");
  const [role, setRole] = useState<"all" | "Captain" | "Player">("all");

  const { data, isLoading } = useQuery<{ contacts: Contact[]; total: number; unsubscribedCount: number }>({
    queryKey: ["/api/admin/league/mailer/contacts", termId],
    queryFn: () => fetch(`/api/admin/league/mailer/contacts${termId !== "all" ? `?competitionId=${termId}` : ""}`).then((r) => r.json()),
  });

  const contacts = data?.contacts ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return contacts.filter((c) =>
      (role === "all" || c.role === role) &&
      (!needle || c.name.toLowerCase().includes(needle) || c.email.toLowerCase().includes(needle) || (c.team || "").toLowerCase().includes(needle)),
    );
  }, [contacts, q, role]);

  const exportCsv = () => {
    const header = ["Name", "Email", "Phone", "Role", "Team", "Term", "Unsubscribed"];
    const rows = filtered.map((c) => [c.name, c.email, c.phone, c.role, c.team, c.term, c.unsubscribed ? "yes" : "no"]);
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `mfl-contacts-${termId === "all" ? "all" : "term-" + termId}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Contacts", value: data?.total ?? 0 },
          { label: "Captains", value: contacts.filter((c) => c.role === "Captain").length },
          { label: "Players", value: contacts.filter((c) => c.role === "Player").length },
          { label: "Unsubscribed", value: data?.unsubscribedCount ?? 0 },
        ].map((s, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <p className="text-[10px] uppercase tracking-wider text-white/30">{s.label}</p>
            <p className="text-lg font-bold text-white mt-0.5">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or team…"
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/25" data-testid="contacts-search" />
        </div>
        <Select value={termId} onValueChange={setTermId}>
          <SelectTrigger className="premium-input text-white w-[200px]"><SelectValue placeholder="Term" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All terms</SelectItem>
            {terms.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={role} onValueChange={(v) => setRole(v as any)}>
          <SelectTrigger className="premium-input text-white w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone</SelectItem>
            <SelectItem value="Captain">Captains</SelectItem>
            <SelectItem value="Player">Players</SelectItem>
          </SelectContent>
        </Select>
        <button onClick={exportCsv} disabled={!filtered.length}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-white/10 text-white hover:bg-white/15 transition-colors disabled:opacity-40" data-testid="contacts-export">
          <Download className="w-3.5 h-3.5" /> Export CSV
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-white/20 text-sm">Loading contacts…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <div className="flex flex-col items-center justify-center py-16 text-white/20">
            <Users className="w-12 h-12 mb-3" />
            <p className="text-sm">No contacts match.</p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b border-white/5">
                {["Name", "Email", "Phone", "Role", "Team", "Term"].map((h) => (
                  <th key={h} className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => (
                <tr key={c.email + i} className={`border-b border-white/[0.02] ${c.unsubscribed ? "opacity-40" : ""}`} data-testid={`contact-row-${i}`}>
                  <td className="px-4 py-2.5 text-sm text-white/80 font-medium">
                    <span className="inline-flex items-center gap-1.5">{c.role === "Captain" && <Crown className="w-3 h-3 text-amber-400" />}{c.name || "—"}</span>
                  </td>
                  <td className="px-4 py-2.5 text-sm text-white/60">{c.email}{c.unsubscribed && <span className="ml-2 text-[10px] text-red-400">unsubscribed</span>}</td>
                  <td className="px-4 py-2.5 text-sm text-white/50">{c.phone || "—"}</td>
                  <td className="px-4 py-2.5 text-sm text-white/60">{c.role}</td>
                  <td className="px-4 py-2.5 text-sm text-white/50">{c.team || "—"}</td>
                  <td className="px-4 py-2.5 text-sm text-white/40">{c.term}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ── Compose ───────────────────────────────────────────────────────────────────
function ComposeView({ termId, setTermId, audience, setAudience, terms, toast }: {
  termId: string; setTermId: (s: string) => void; audience: "captains" | "all"; setAudience: (a: "captains" | "all") => void;
  terms: LeagueCompetition[]; toast: ReturnType<typeof useToast>["toast"];
}) {
  const [subject, setSubject] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  const compId = termId !== "all" ? parseInt(termId) : null;

  const { data: preview } = useQuery<{ count: number }>({
    queryKey: ["/api/admin/league/mailer/preview", termId, audience],
    queryFn: () => apiRequest("POST", "/api/admin/league/mailer/preview", { competitionId: compId, audience }).then((r) => r.json()),
  });

  // Poll while a broadcast is in flight — the send runs as a background queue
  // on the server (Resend rate limit), so progress lands on the campaign row.
  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ["/api/admin/league/mailer/campaigns"],
    queryFn: () => fetch("/api/admin/league/mailer/campaigns").then((r) => r.json()),
    refetchInterval: (query) => (query.state.data ?? []).some((c) => c.status === "sending") ? 3000 : false,
  });

  const body = () => editorRef.current?.innerHTML || "";
  const exec = (cmd: string, val?: string) => { document.execCommand(cmd, false, val); editorRef.current?.focus(); };

  const testSend = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/league/mailer/test-send", { to: testEmail.trim(), subject, body: body() }).then((r) => r.json()),
    onSuccess: (r: { ok: boolean }) => toast(r.ok ? { title: "Test sent", description: `Check ${testEmail}` } : { title: "Test failed", description: "Check the address + try again", variant: "destructive" }),
    onError: (e: any) => toast({ title: "Couldn't send test", description: e.message, variant: "destructive" }),
  });

  const send = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/league/mailer/send", { subject, body: body(), competitionId: compId, audience }).then((r) => r.json()),
    onSuccess: (r: { queued: boolean; recipientCount: number }) => {
      setConfirmOpen(false);
      toast({ title: "Sending now 📤", description: `Queued to ${r.recipientCount} recipients — watch the progress under Recent sends.` });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/mailer/campaigns"] });
      setSubject(""); if (editorRef.current) editorRef.current.innerHTML = "";
    },
    onError: (e: any) => { setConfirmOpen(false); toast({ title: "Send failed", description: e.message, variant: "destructive" }); },
  });

  const canSend = subject.trim().length > 0 && body().replace(/<[^>]*>/g, "").trim().length > 0;

  const audienceLabel = `${audience === "all" ? "Everyone (captains + players)" : "Captains only"}${termId === "all" ? " · all terms" : ` · ${terms.find((t) => String(t.id) === termId)?.name || "term"}`}`;

  return (
    <div className="grid lg:grid-cols-3 gap-6">
      {/* Composer */}
      <div className="lg:col-span-2 space-y-4">
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="text-[11px] uppercase tracking-wider text-white/30 font-semibold">Audience</div>
            <Select value={termId} onValueChange={setTermId}>
              <SelectTrigger className="premium-input text-white w-[180px] h-8 text-xs"><SelectValue placeholder="Term" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All terms</SelectItem>
                {terms.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.02] p-0.5">
              {([["all", "Everyone"], ["captains", "Captains only"]] as const).map(([v, label]) => (
                <button key={v} onClick={() => setAudience(v)}
                  className={`text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${audience === v ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}>{label}</button>
              ))}
            </div>
            <span className="text-xs text-white/50 ml-auto flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> {preview?.count ?? "…"} recipients</span>
          </div>
        </div>

        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject line"
          className="w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-white/10 text-white placeholder:text-white/30 font-medium focus:outline-none focus:border-white/25" data-testid="mailer-subject" />

        <div className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-white/5">
            {[
              { icon: Bold, cmd: "bold", title: "Bold" },
              { icon: Italic, cmd: "italic", title: "Italic" },
              { icon: Heading, cmd: "formatBlock", val: "<h2>", title: "Heading" },
              { icon: List, cmd: "insertUnorderedList", title: "Bullet list" },
            ].map((b, i) => (
              <button key={i} type="button" title={b.title} onClick={() => exec(b.cmd, b.val)}
                className="w-8 h-8 rounded-md flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10">
                <b.icon className="w-4 h-4" />
              </button>
            ))}
            <button type="button" title="Link" onClick={() => { const url = prompt("Link URL:"); if (url) exec("createLink", url); }}
              className="w-8 h-8 rounded-md flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10"><Link2 className="w-4 h-4" /></button>
          </div>
          <div ref={editorRef} contentEditable suppressContentEditableWarning data-testid="mailer-body"
            className="min-h-[280px] p-4 text-white/90 text-sm leading-relaxed focus:outline-none [&_h2]:text-lg [&_h2]:font-bold [&_h2]:my-2 [&_a]:text-amber-400 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5"
            style={{ wordBreak: "break-word" }} />
        </div>
        <p className="text-[11px] text-white/30">Sent from the black-and-gold Mini Football Leagues template, with an unsubscribe link added automatically.</p>

        {/* Test + send */}
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 flex items-center gap-3 flex-wrap">
          <input value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="you@email.com"
            className="flex-1 min-w-[160px] px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/25" data-testid="mailer-test-email" />
          <button onClick={() => testSend.mutate()} disabled={!canSend || !testEmail.trim() || testSend.isPending}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-white/10 text-white hover:bg-white/15 disabled:opacity-40" data-testid="mailer-test-send">
            {testSend.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />} Send test
          </button>
          <button onClick={() => setConfirmOpen(true)} disabled={!canSend || !(preview?.count)}
            className="flex items-center gap-2 text-sm font-semibold px-5 py-2 rounded-lg bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-40" data-testid="mailer-send">
            <Send className="w-4 h-4" /> Send to {preview?.count ?? 0}
          </button>
        </div>
      </div>

      {/* History */}
      <div className="space-y-3">
        <div className="text-[11px] uppercase tracking-wider text-white/30 font-semibold px-1">Recent sends</div>
        {campaigns.length === 0 ? (
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-6 text-center text-white/25 text-xs">
            <Mail className="w-8 h-8 mx-auto mb-2" /> No newsletters sent yet.
          </div>
        ) : campaigns.map((c) => (
          <div key={c.id} className="rounded-xl border border-white/5 bg-white/[0.02] p-3.5">
            <div className="text-sm font-medium text-white/85 truncate">{c.subject}</div>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-white/40">
              {c.status === "sending"
                ? <><Loader2 className="w-3 h-3 text-amber-400 animate-spin" /> {c.sentCount ?? 0}/{c.recipientCount ?? 0} sent · sending…</>
                : <><CheckCircle2 className="w-3 h-3 text-green-400" /> {c.sentCount ?? 0}/{c.recipientCount ?? 0} sent</>}
              {(c.failedCount ?? 0) > 0 && <span className="text-red-400">· {c.failedCount} failed</span>}
              <span className="ml-auto">{c.status === "sending" ? "" : c.sentAt ? new Date(c.sentAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short" }) : "draft"}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Confirm modal */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setConfirmOpen(false)}>
          <div className="bg-[#0a0e1a] border border-amber-500/20 rounded-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold text-white">Send this newsletter?</h3>
              <button onClick={() => setConfirmOpen(false)} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-white/60 leading-relaxed">
              This sends "<span className="text-white">{subject}</span>" to <span className="text-amber-400 font-semibold">{preview?.count ?? 0} {audience === "all" ? "captains + players" : "captains"}</span> ({audienceLabel}). This can't be undone.
            </p>
            <div className="flex items-start gap-2 mt-3 text-[11px] text-white/40 bg-white/[0.03] rounded-lg p-3">
              <AlertTriangle className="w-4 h-4 text-amber-400/70 flex-shrink-0 mt-0.5" /> Send a test to yourself first if you haven't — there's no recall once it's out.
            </div>
            <div className="grid grid-cols-2 gap-3 mt-5">
              <button onClick={() => setConfirmOpen(false)} className="py-2.5 rounded-lg text-sm font-medium bg-white/10 text-white hover:bg-white/15">Cancel</button>
              <button onClick={() => send.mutate()} disabled={send.isPending}
                className="py-2.5 rounded-lg text-sm font-semibold bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-50 flex items-center justify-center gap-2" data-testid="mailer-confirm-send">
                {send.isPending ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</> : <>Send now</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
