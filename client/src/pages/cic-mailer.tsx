import { useState, useRef, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Mail, Users, Send, Search, Download, Shield, Loader2, Bold, Italic, List,
  Link2, Heading, Eye, CheckCircle2, AlertTriangle, X,
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Contact = { name: string; email: string; phone: string; role: string; team: string; term: string; unsubscribed: boolean };
type Campaign = { id: number; subject: string; recipientCount: number | null; sentCount: number | null; failedCount: number | null; status: string; sentAt: string | null; createdAt: string };
type Tournament = { id: number; name: string; ageGroup: string | null; archived: boolean };
type Source = "youth" | "7s";
type Audience = "contacts" | "all" | "staff" | "custom";
type View = "compose" | "contacts";

// Split a hand-typed recipient list on whitespace/commas/semicolons — returns
// deduped valid emails plus whatever didn't look like an address.
function parseEmails(input: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const token of input.split(/[\s,;]+/)) {
    const t = token.trim();
    if (!t) continue;
    const email = t.toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (!seen.has(email)) { seen.add(email); valid.push(email); }
    } else {
      invalid.push(t);
    }
  }
  return { valid, invalid };
}

// The CIC Mailer — one page shared by the CIC Youth and CIC 7's views of the
// tournament workspace. Youth pulls team + club contacts from the tournament
// tables; 7's pulls the register-interest list. Same engine as the MFL mailer.
export default function CicMailer() {
  const { currentOrg, cicView } = useWorkspace();
  const orgId = currentOrg?.id;
  const { toast } = useToast();
  const [view, setView] = useState<View>("compose");

  // Audience selection (shared by compose + contacts). Default source follows
  // whichever CIC view (Youth / 7's) the sidebar toggle is on.
  const [source, setSource] = useState<Source>(cicView === "7s" ? "7s" : "youth");
  const [tournamentId, setTournamentId] = useState<string>("all");
  const [audience, setAudience] = useState<Audience>("all");

  const { data: tournaments = [] } = useQuery<Tournament[]>({
    queryKey: ["/api/admin/tournament/tournaments", { orgId }],
    queryFn: () => fetch(`/api/admin/tournament/tournaments?orgId=${orgId}`).then((r) => r.json()),
    enabled: !!orgId,
  });
  const activeTournaments = useMemo(() => tournaments.filter((t) => !t.archived), [tournaments]);

  const pickSource = (s: Source) => {
    setSource(s);
    setTournamentId("all");
    // Youth-only segments don't exist on the 7's list — fall back to everyone.
    if (s === "7s" && (audience === "staff" || audience === "contacts")) setAudience("all");
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Mailer</h1>
          <p className="text-sm text-white/40 mt-1">Your CIC contact database + newsletters and updates</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex rounded-lg border border-white/5 bg-white/[0.02] p-0.5">
            {([["youth", "CIC Youth"], ["7s", "CIC 7's"]] as const).map(([v, label]) => (
              <button key={v} onClick={() => pickSource(v)} data-testid={`mailer-source-${v}`}
                className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${source === v ? "bg-amber-500/15 text-amber-300" : "text-white/40 hover:text-white/70"}`}>
                {label}
              </button>
            ))}
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
      </div>

      {view === "contacts"
        ? <ContactsView source={source} tournamentId={tournamentId} setTournamentId={setTournamentId} tournaments={activeTournaments} />
        : <ComposeView source={source} tournamentId={tournamentId} setTournamentId={setTournamentId} audience={audience} setAudience={setAudience} tournaments={activeTournaments} toast={toast} />}
    </div>
  );
}

// ── Contacts (CRM) ────────────────────────────────────────────────────────────
function ContactsView({ source, tournamentId, setTournamentId, tournaments }: {
  source: Source; tournamentId: string; setTournamentId: (s: string) => void; tournaments: Tournament[];
}) {
  const [q, setQ] = useState("");
  const [role, setRole] = useState<string>("all");

  const { data, isLoading } = useQuery<{ contacts: Contact[]; total: number; unsubscribedCount: number }>({
    queryKey: ["/api/admin/cic/mailer/contacts", source, tournamentId],
    queryFn: () => {
      const params = new URLSearchParams({ source });
      if (source === "youth" && tournamentId !== "all") params.set("tournamentId", tournamentId);
      return fetch(`/api/admin/cic/mailer/contacts?${params}`).then((r) => r.json());
    },
  });

  const contacts = data?.contacts ?? [];
  const roles = useMemo(() => Array.from(new Set(contacts.map((c) => c.role).filter(Boolean))).sort(), [contacts]);
  const topRoles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of contacts) counts.set(c.role, (counts.get(c.role) || 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 2);
  }, [contacts]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return contacts.filter((c) =>
      (role === "all" || c.role === role) &&
      (!needle || c.name.toLowerCase().includes(needle) || c.email.toLowerCase().includes(needle) || (c.team || "").toLowerCase().includes(needle)),
    );
  }, [contacts, q, role]);

  const exportCsv = () => {
    const header = ["Name", "Email", "Phone", "Role", "Club / Team", "Tournament", "Unsubscribed"];
    const rows = filtered.map((c) => [c.name, c.email, c.phone, c.role, c.team, c.term, c.unsubscribed ? "yes" : "no"]);
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cic-${source}-contacts${source === "youth" && tournamentId !== "all" ? `-tournament-${tournamentId}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Contacts", value: data?.total ?? 0 },
          { label: topRoles[0]?.[0] ? `${topRoles[0][0]}s` : "—", value: topRoles[0]?.[1] ?? 0 },
          { label: topRoles[1]?.[0] ? `${topRoles[1][0]}s` : "—", value: topRoles[1]?.[1] ?? 0 },
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
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, club or team…"
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/25" data-testid="contacts-search" />
        </div>
        {source === "youth" && (
          <Select value={tournamentId} onValueChange={setTournamentId}>
            <SelectTrigger className="premium-input text-white w-[220px]"><SelectValue placeholder="Tournament" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tournaments</SelectItem>
              {tournaments.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger className="premium-input text-white w-[170px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone</SelectItem>
            {roles.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
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
                {["Name", "Email", "Phone", "Role", "Club / Team", "Tournament"].map((h) => (
                  <th key={h} className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => (
                <tr key={c.email + i} className={`border-b border-white/[0.02] ${c.unsubscribed ? "opacity-40" : ""}`} data-testid={`contact-row-${i}`}>
                  <td className="px-4 py-2.5 text-sm text-white/80 font-medium">
                    <span className="inline-flex items-center gap-1.5">{c.role === "Club contact" && <Shield className="w-3 h-3 text-amber-400" />}{c.name || "—"}</span>
                  </td>
                  <td className="px-4 py-2.5 text-sm text-white/60">{c.email}{c.unsubscribed && <span className="ml-2 text-[10px] text-red-400">unsubscribed</span>}</td>
                  <td className="px-4 py-2.5 text-sm text-white/50">{c.phone || "—"}</td>
                  <td className="px-4 py-2.5 text-sm text-white/60">{c.role}</td>
                  <td className="px-4 py-2.5 text-sm text-white/50">{c.team || "—"}</td>
                  <td className="px-4 py-2.5 text-sm text-white/40">{c.term || "—"}</td>
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
function ComposeView({ source, tournamentId, setTournamentId, audience, setAudience, tournaments, toast }: {
  source: Source; tournamentId: string; setTournamentId: (s: string) => void;
  audience: Audience; setAudience: (a: Audience) => void;
  tournaments: Tournament[]; toast: ReturnType<typeof useToast>["toast"];
}) {
  const [subject, setSubject] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [customText, setCustomText] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  const tournId = source === "youth" && tournamentId !== "all" ? parseInt(tournamentId) : null;
  const custom = useMemo(() => parseEmails(customText), [customText]);

  const { data: preview } = useQuery<{ count: number }>({
    queryKey: ["/api/admin/cic/mailer/preview", source, tournamentId, audience, audience === "custom" ? custom.valid.join(",") : ""],
    queryFn: () => apiRequest("POST", "/api/admin/cic/mailer/preview", { source, tournamentId: tournId, audience, customEmails: custom.valid }).then((r) => r.json()),
    enabled: audience !== "custom" || custom.valid.length > 0,
  });
  const recipientCount = audience === "custom" && custom.valid.length === 0 ? 0 : preview?.count;

  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ["/api/admin/cic/mailer/campaigns"],
    queryFn: () => fetch("/api/admin/cic/mailer/campaigns").then((r) => r.json()),
  });

  const body = () => editorRef.current?.innerHTML || "";
  const exec = (cmd: string, val?: string) => { document.execCommand(cmd, false, val); editorRef.current?.focus(); };

  const testSend = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/cic/mailer/test-send", { to: testEmail.trim(), subject, body: body(), source }).then((r) => r.json()),
    onSuccess: (r: { ok: boolean }) => toast(r.ok ? { title: "Test sent", description: `Check ${testEmail}` } : { title: "Test failed", description: "Check the address + try again", variant: "destructive" }),
    onError: (e: any) => toast({ title: "Couldn't send test", description: e.message, variant: "destructive" }),
  });

  const send = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/cic/mailer/send", { subject, body: body(), source, tournamentId: tournId, audience, customEmails: custom.valid }).then((r) => r.json()),
    onSuccess: (r: { recipientCount: number; sentCount: number; failedCount: number }) => {
      setConfirmOpen(false);
      toast({ title: "Newsletter sent 🎉", description: `${r.sentCount} sent${r.failedCount ? ` · ${r.failedCount} failed` : ""} of ${r.recipientCount}` });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/cic/mailer/campaigns"] });
      setSubject(""); if (editorRef.current) editorRef.current.innerHTML = "";
    },
    onError: (e: any) => { setConfirmOpen(false); toast({ title: "Send failed", description: e.message, variant: "destructive" }); },
  });

  const canSend = subject.trim().length > 0 && body().replace(/<[^>]*>/g, "").trim().length > 0
    && (audience !== "custom" || custom.valid.length > 0);

  const audienceLabel = audience === "custom"
    ? "your custom email list"
    : source === "7s"
    ? "everyone who registered interest in CIC 7's"
    : `${audience === "all" ? "team + club contacts and squad staff" : audience === "staff" ? "coaches + managers only" : "team + club contacts only"}${tournamentId === "all" ? " · all tournaments" : ` · ${tournaments.find((t) => String(t.id) === tournamentId)?.name || "tournament"}`}`;

  return (
    <div className="grid lg:grid-cols-3 gap-6">
      {/* Composer */}
      <div className="lg:col-span-2 space-y-4">
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="text-[11px] uppercase tracking-wider text-white/30 font-semibold">Audience</div>
            {source === "youth" && audience !== "custom" && (
              <Select value={tournamentId} onValueChange={setTournamentId}>
                <SelectTrigger className="premium-input text-white w-[200px] h-8 text-xs"><SelectValue placeholder="Tournament" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All tournaments</SelectItem>
                  {tournaments.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.02] p-0.5">
              {(source === "youth"
                ? ([["all", "Everyone"], ["contacts", "Contacts only"], ["staff", "Coaches + managers"], ["custom", "Custom"]] as const)
                : ([["all", "Interest list"], ["custom", "Custom"]] as const)
              ).map(([v, label]) => (
                <button key={v} onClick={() => setAudience(v)} data-testid={`mailer-audience-${v}`}
                  className={`text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${audience === v ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}>{label}</button>
              ))}
            </div>
            <span className="text-xs text-white/50 ml-auto flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> {recipientCount ?? "…"} recipients</span>
          </div>
          {audience === "custom" && (
            <div className="space-y-1.5">
              <textarea value={customText} onChange={(e) => setCustomText(e.target.value)} rows={3}
                placeholder="Type or paste email addresses — separated by commas, spaces or new lines"
                className="w-full px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/25 resize-y"
                data-testid="mailer-custom-emails" />
              <p className="text-[11px] text-white/40">
                {custom.valid.length} valid address{custom.valid.length === 1 ? "" : "es"}
                {custom.invalid.length > 0 && (
                  <span className="text-red-400"> · ignoring: {custom.invalid.slice(0, 5).join(", ")}{custom.invalid.length > 5 ? ` +${custom.invalid.length - 5} more` : ""}</span>
                )}
              </p>
            </div>
          )}
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
        <p className="text-[11px] text-white/30">
          {source === "7s"
            ? "Sent from the navy-and-lime CIC Summer 7's template, with an unsubscribe link added automatically."
            : "Sent from the black-and-gold Christchurch International Cup template, with an unsubscribe link added automatically."}
        </p>

        {/* Test + send */}
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 flex items-center gap-3 flex-wrap">
          <input value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="you@email.com"
            className="flex-1 min-w-[160px] px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/25" data-testid="mailer-test-email" />
          <button onClick={() => testSend.mutate()} disabled={!canSend || !testEmail.trim() || testSend.isPending}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-white/10 text-white hover:bg-white/15 disabled:opacity-40" data-testid="mailer-test-send">
            {testSend.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />} Send test
          </button>
          <button onClick={() => setConfirmOpen(true)} disabled={!canSend || !recipientCount}
            className="flex items-center gap-2 text-sm font-semibold px-5 py-2 rounded-lg bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-40" data-testid="mailer-send">
            <Send className="w-4 h-4" /> Send to {recipientCount ?? 0}
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
              <CheckCircle2 className="w-3 h-3 text-green-400" /> {c.sentCount ?? 0}/{c.recipientCount ?? 0} sent
              {(c.failedCount ?? 0) > 0 && <span className="text-red-400">· {c.failedCount} failed</span>}
              <span className="ml-auto">{c.sentAt ? new Date(c.sentAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short" }) : "draft"}</span>
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
              This sends "<span className="text-white">{subject}</span>" to <span className="text-amber-400 font-semibold">{recipientCount ?? 0} recipients</span> ({audienceLabel}). This can't be undone.
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
