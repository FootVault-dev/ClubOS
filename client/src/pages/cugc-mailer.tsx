import { useState, useRef, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Mail, Users, Send, Search, Download, Loader2, Bold, Italic, List,
  Link2, Heading, Eye, CheckCircle2, AlertTriangle, X, Sparkles, MailOpen,
} from "lucide-react";

type Contact = { name: string; email: string; phone: string; role: string; program: string; unsubscribed: boolean };
type Campaign = {
  id: number; subject: string; recipientCount: number | null; sentCount: number | null;
  failedCount: number | null; status: string; sentAt: string | null; createdAt: string;
  deliveredCount: number; openedCount: number;
};
type Program = { slug: string; name: string; count: number };
type Recipient = { id: number; email: string; status: string; sentAt: string; firstOpenedAt: string | null; openCount: number };
type Audience = "newsletter" | "all" | "program" | "custom";
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

// The CUGC Mailer — United Gymnastics newsletters to the gym's own list
// (newsletter signups, enrolled families, free-session bookings, enquiries),
// with per-send delivery + open tracking.
export default function CugcMailer() {
  const { toast } = useToast();
  const [view, setView] = useState<View>("compose");

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-white">Mailer</h1>
          <p className="text-sm text-white/40 mt-1">United Gymnastics newsletters — your families, trials and newsletter signups</p>
        </div>
        <div className="inline-flex rounded-lg border border-white/5 bg-white/[0.02] p-0.5">
          {([["compose", "Compose"], ["contacts", "Contacts"]] as const).map(([v, label]) => (
            <button key={v} onClick={() => setView(v)} data-testid={`cugc-mailer-view-${v}`}
              className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${view === v ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {view === "contacts" ? <ContactsView /> : <ComposeView toast={toast} />}
    </div>
  );
}

// ── Contacts ──────────────────────────────────────────────────────────────────
function ContactsView() {
  const [q, setQ] = useState("");
  const { data, isLoading } = useQuery<{ contacts: Contact[]; total: number; unsubscribedCount: number }>({
    queryKey: ["/api/admin/cugc/mailer/contacts"],
  });

  const contacts = data?.contacts ?? [];
  const countBy = (role: string) => contacts.filter((c) => c.role === role).length;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return contacts;
    return contacts.filter((c) =>
      c.name.toLowerCase().includes(needle) || c.email.toLowerCase().includes(needle) ||
      (c.phone || "").toLowerCase().includes(needle) || (c.program || "").toLowerCase().includes(needle));
  }, [contacts, q]);

  const exportCsv = () => {
    const header = ["Name", "Email", "Phone", "Source", "Programme", "Unsubscribed"];
    const rows = filtered.map((c) => [c.name, c.email, c.phone, c.role, c.program, c.unsubscribed ? "yes" : "no"]);
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cugc-contacts.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: "Contacts", value: data?.total ?? 0 },
          { label: "Newsletter", value: countBy("Newsletter") },
          { label: "Enrolled", value: countBy("Enrolled") },
          { label: "Free session", value: countBy("Free session") },
          { label: "Unsubscribed", value: data?.unsubscribedCount ?? 0 },
        ].map((s, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-4 min-w-0">
            <p className="text-[10px] uppercase tracking-wider text-white/30">{s.label}</p>
            <p className="text-lg font-bold text-white mt-0.5">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, phone or programme…"
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/25" data-testid="cugc-contacts-search" />
        </div>
        <button onClick={exportCsv} disabled={!filtered.length}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-white/10 text-white hover:bg-white/15 transition-colors disabled:opacity-40" data-testid="cugc-contacts-export">
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
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="border-b border-white/5">
                {["Name", "Email", "Phone", "Source", "Programme"].map((h) => (
                  <th key={h} className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => (
                <tr key={c.email + i} className={`border-b border-white/[0.02] ${c.unsubscribed ? "opacity-40" : ""}`} data-testid={`cugc-contact-row-${i}`}>
                  <td className="px-4 py-2.5 text-sm text-white/80 font-medium">
                    <span className="inline-flex items-center gap-1.5">{c.role === "Newsletter" && <Sparkles className="w-3 h-3 text-amber-400" />}{c.name || "—"}</span>
                  </td>
                  <td className="px-4 py-2.5 text-sm text-white/60">{c.email}{c.unsubscribed && <span className="ml-2 text-[10px] text-red-400">unsubscribed</span>}</td>
                  <td className="px-4 py-2.5 text-sm text-white/50">{c.phone || "—"}</td>
                  <td className="px-4 py-2.5 text-sm text-white/50">{c.role}</td>
                  <td className="px-4 py-2.5 text-sm text-white/50">{c.program || "—"}</td>
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
function ComposeView({ toast }: { toast: ReturnType<typeof useToast>["toast"] }) {
  const [audience, setAudience] = useState<Audience>("all");
  const [programSlug, setProgramSlug] = useState("");
  const [subject, setSubject] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [customText, setCustomText] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [openCampaign, setOpenCampaign] = useState<number | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  const custom = useMemo(() => parseEmails(customText), [customText]);

  const { data: programsData } = useQuery<{ programs: Program[] }>({
    queryKey: ["/api/admin/cugc/mailer/programs"],
  });
  const programs = programsData?.programs ?? [];

  const { data: preview } = useQuery<{ count: number }>({
    queryKey: ["/api/admin/cugc/mailer/preview", audience, programSlug, custom.valid.join(",")],
    queryFn: () => apiRequest("POST", "/api/admin/cugc/mailer/preview", {
      audience, programSlug, customEmails: custom.valid,
    }).then((r) => r.json()),
    enabled: audience !== "program" || !!programSlug,
  });
  const recipientCount = preview?.count;

  // Poll while a broadcast is in flight — the send runs as a background queue
  // on the server (Resend rate limit), so progress lands on the campaign row.
  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ["/api/admin/cugc/mailer/campaigns"],
    refetchInterval: (query) => (query.state.data ?? []).some((c) => c.status === "sending") ? 3000 : 30000,
  });

  const body = () => editorRef.current?.innerHTML || "";
  const exec = (cmd: string, val?: string) => { document.execCommand(cmd, false, val); editorRef.current?.focus(); };

  const testSend = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/cugc/mailer/test-send", { to: testEmail.trim(), subject, body: body() }).then((r) => r.json()),
    onSuccess: (r: { ok: boolean }) => toast(r.ok ? { title: "Test sent", description: `Check ${testEmail}` } : { title: "Test failed", description: "Check the address + try again", variant: "destructive" }),
    onError: (e: any) => toast({ title: "Couldn't send test", description: e.message, variant: "destructive" }),
  });

  const send = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/cugc/mailer/send", {
      subject, body: body(), audience, programSlug, customEmails: custom.valid,
    }).then((r) => r.json()),
    onSuccess: (r: { queued: boolean; recipientCount: number }) => {
      setConfirmOpen(false);
      toast({ title: "Sending now 📤", description: `Queued to ${r.recipientCount} recipients — watch the progress under Recent sends.` });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/cugc/mailer/campaigns"] });
      setSubject(""); setCustomText(""); if (editorRef.current) editorRef.current.innerHTML = "";
    },
    onError: (e: any) => { setConfirmOpen(false); toast({ title: "Send failed", description: e.message, variant: "destructive" }); },
  });

  const canSend = subject.trim().length > 0
    && body().replace(/<[^>]*>/g, "").trim().length > 0
    && (audience !== "program" || !!programSlug)
    && !!recipientCount;

  const audienceLabel =
    audience === "custom" ? "just the addresses you typed"
    : audience === "newsletter" ? "your newsletter subscribers"
    : audience === "program" ? `${programs.find((p) => p.slug === programSlug)?.name || "that programme"} families`
    : "everyone on your list";
  const extrasLabel = audience !== "custom" && custom.valid.length > 0
    ? ` plus ${custom.valid.length} address${custom.valid.length === 1 ? "" : "es"} you added`
    : "";

  return (
    <div className="grid lg:grid-cols-3 gap-6">
      {/* Composer */}
      <div className="lg:col-span-2 space-y-4 min-w-0">
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="text-[11px] uppercase tracking-wider text-white/30 font-semibold">Send to</div>
            <div className="inline-flex flex-wrap rounded-lg border border-white/10 bg-white/[0.02] p-0.5 gap-0.5">
              {([
                ["all", "Everyone"],
                ["newsletter", "Newsletter subscribers"],
                ["program", "By programme"],
                ["custom", "Just typed addresses"],
              ] as const).map(([v, label]) => (
                <button key={v} onClick={() => setAudience(v)} data-testid={`cugc-mailer-audience-${v}`}
                  className={`text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${audience === v ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}>{label}</button>
              ))}
            </div>
            <span className="text-xs text-white/50 ml-auto flex items-center gap-1.5 whitespace-nowrap">
              <Users className="w-3.5 h-3.5" /> {recipientCount ?? "…"} recipients
            </span>
          </div>

          {audience === "program" && (
            <div className="flex flex-wrap gap-1.5">
              {programs.length === 0 ? (
                <p className="text-[11px] text-white/40">No programmes with sign-ups yet.</p>
              ) : programs.map((p) => (
                <button key={p.slug} onClick={() => setProgramSlug(p.slug)} data-testid={`cugc-mailer-program-${p.slug}`}
                  className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${programSlug === p.slug ? "border-amber-400/40 bg-amber-400/10 text-amber-200" : "border-white/10 bg-white/[0.02] text-white/50 hover:text-white/80"}`}>
                  {p.name} <span className="text-white/30">· {p.count}</span>
                </button>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[11px] uppercase tracking-wider text-white/30 font-semibold block">
              {audience === "custom" ? "Addresses to send to" : "Add anyone else (optional)"}
            </label>
            <textarea value={customText} onChange={(e) => setCustomText(e.target.value)} rows={2}
              placeholder="name@email.com — commas, spaces or new lines. One address is fine."
              className="w-full px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/25 resize-y"
              data-testid="cugc-mailer-custom-emails" />
            <p className="text-[11px] text-white/40">
              {custom.valid.length} valid address{custom.valid.length === 1 ? "" : "es"}
              {audience !== "custom" && custom.valid.length > 0 && <span className="text-white/30"> · added on top of {audienceLabel}</span>}
              {custom.invalid.length > 0 && (
                <span className="text-red-400"> · ignoring: {custom.invalid.slice(0, 5).join(", ")}{custom.invalid.length > 5 ? ` +${custom.invalid.length - 5} more` : ""}</span>
              )}
            </p>
          </div>
        </div>

        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject line"
          className="w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-white/10 text-white placeholder:text-white/30 font-medium focus:outline-none focus:border-white/25" data-testid="cugc-mailer-subject" />

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
          <div ref={editorRef} contentEditable suppressContentEditableWarning data-testid="cugc-mailer-body"
            className="min-h-[280px] p-4 text-white/90 text-sm leading-relaxed focus:outline-none [&_h2]:text-lg [&_h2]:font-bold [&_h2]:my-2 [&_a]:text-blue-400 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5"
            style={{ wordBreak: "break-word" }} />
        </div>
        <p className="text-[11px] text-white/30">
          Sent from the United Gymnastics template (noreply@cugc.co.nz), replies go to info@cugc.co.nz, and an unsubscribe link is added automatically.
        </p>

        {/* Test + send */}
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 flex items-center gap-3 flex-wrap">
          <input value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="you@email.com"
            className="flex-1 min-w-[160px] px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/25" data-testid="cugc-mailer-test-email" />
          <button onClick={() => testSend.mutate()} disabled={!subject.trim() || !testEmail.trim() || testSend.isPending}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-white/10 text-white hover:bg-white/15 disabled:opacity-40" data-testid="cugc-mailer-test-send">
            {testSend.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />} Send test
          </button>
          <button onClick={() => setConfirmOpen(true)} disabled={!canSend}
            className="flex items-center gap-2 text-sm font-semibold px-5 py-2 rounded-lg bg-[#013590] text-white hover:bg-[#0143b0] disabled:opacity-40" data-testid="cugc-mailer-send">
            <Send className="w-4 h-4" /> Send to {recipientCount ?? 0}
          </button>
        </div>
      </div>

      {/* History */}
      <div className="space-y-3 min-w-0">
        <div className="text-[11px] uppercase tracking-wider text-white/30 font-semibold px-1">Recent sends</div>
        {campaigns.length === 0 ? (
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-6 text-center text-white/25 text-xs">
            <Mail className="w-8 h-8 mx-auto mb-2" /> No newsletters sent yet.
          </div>
        ) : campaigns.map((c) => {
          const delivered = c.deliveredCount || 0;
          const openRate = delivered > 0 ? Math.round((c.openedCount / delivered) * 100) : 0;
          return (
            <button key={c.id} onClick={() => setOpenCampaign(c.id)} data-testid={`cugc-mailer-campaign-${c.id}`}
              className="w-full text-left rounded-xl border border-white/5 bg-white/[0.02] p-3.5 hover:border-white/15 transition-colors">
              <div className="text-sm font-medium text-white/85 truncate">{c.subject}</div>
              <div className="flex items-center gap-2 mt-1 text-[11px] text-white/40 flex-wrap">
                {c.status === "sending"
                  ? <><Loader2 className="w-3 h-3 text-amber-400 animate-spin" /> {c.sentCount ?? 0}/{c.recipientCount ?? 0} sent · sending…</>
                  : <><CheckCircle2 className="w-3 h-3 text-green-400" /> {delivered}/{c.recipientCount ?? 0} delivered</>}
                {(c.failedCount ?? 0) > 0 && <span className="text-red-400">· {c.failedCount} failed</span>}
              </div>
              {c.status !== "sending" && (
                <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-amber-300/80">
                  <MailOpen className="w-3 h-3" /> {c.openedCount} opened{delivered > 0 ? ` · ${openRate}%` : ""}
                  <span className="ml-auto text-white/30">{c.sentAt ? new Date(c.sentAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short" }) : ""}</span>
                </div>
              )}
            </button>
          );
        })}
        <p className="text-[10px] text-white/25 leading-relaxed px-1">
          "Delivered" means the email was accepted for delivery. Opens are counted by a tracking
          pixel — Apple Mail pre-loads images for its users, so treat opens as a guide, not a headcount.
        </p>
      </div>

      {openCampaign !== null && <CampaignDetail id={openCampaign} onClose={() => setOpenCampaign(null)} />}

      {/* Confirm modal */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setConfirmOpen(false)}>
          <div className="bg-[#0a0e1a] border border-[#013590]/40 rounded-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold text-white">Send this newsletter?</h3>
              <button onClick={() => setConfirmOpen(false)} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-white/60 leading-relaxed">
              This sends "<span className="text-white">{subject}</span>" to <span className="text-amber-300 font-semibold">{recipientCount ?? 0} recipients</span> ({audienceLabel}{extrasLabel}). This can't be undone.
            </p>
            <div className="flex items-start gap-2 mt-3 text-[11px] text-white/40 bg-white/[0.03] rounded-lg p-3">
              <AlertTriangle className="w-4 h-4 text-amber-400/70 flex-shrink-0 mt-0.5" /> Send a test to yourself first if you haven't — there's no recall once it's out.
            </div>
            <div className="grid grid-cols-2 gap-3 mt-5">
              <button onClick={() => setConfirmOpen(false)} className="py-2.5 rounded-lg text-sm font-medium bg-white/10 text-white hover:bg-white/15">Cancel</button>
              <button onClick={() => send.mutate()} disabled={send.isPending}
                className="py-2.5 rounded-lg text-sm font-semibold bg-[#013590] text-white hover:bg-[#0143b0] disabled:opacity-50 flex items-center justify-center gap-2" data-testid="cugc-mailer-confirm-send">
                {send.isPending ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</> : <>Send now</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── One past send: who got it, who opened it ─────────────────────────────────
function CampaignDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, isLoading } = useQuery<{
    campaign: Campaign & { body: string; replyTo: string | null };
    recipients: Recipient[]; deliveredCount: number; failedCount: number; openedCount: number;
  }>({ queryKey: [`/api/admin/cugc/mailer/campaigns/${id}`] });

  const openRate = data && data.deliveredCount > 0 ? Math.round((data.openedCount / data.deliveredCount) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-white/10 rounded-2xl w-full max-w-2xl my-8 min-w-0" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 p-5 border-b border-white/5">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-white truncate">{data?.campaign.subject ?? "Loading…"}</h3>
            <p className="text-[11px] text-white/40 mt-0.5">
              {data?.campaign.sentAt ? new Date(data.campaign.sentAt).toLocaleString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}
            </p>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/60 flex-shrink-0" data-testid="cugc-campaign-close"><X className="w-5 h-5" /></button>
        </div>

        {isLoading || !data ? (
          <div className="p-10 text-center text-white/25 text-sm">Loading…</div>
        ) : (
          <div className="p-5 space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: "Recipients", value: data.campaign.recipientCount ?? 0 },
                { label: "Delivered", value: data.deliveredCount },
                { label: "Opened", value: `${data.openedCount}${data.deliveredCount ? ` · ${openRate}%` : ""}` },
                { label: "Failed", value: data.failedCount },
              ].map((s, i) => (
                <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-3 min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-white/30">{s.label}</p>
                  <p className="text-base font-bold text-white mt-0.5 truncate">{s.value}</p>
                </div>
              ))}
            </div>

            <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
              <div className="text-[10px] uppercase tracking-wider text-white/30 px-4 py-2 border-b border-white/5 font-semibold">Who it went to</div>
              {/* A flex row, not a table: on a 390px phone a min-width table
                  pushed the status off the right edge and hid the open time
                  entirely. Here the address takes the slack and truncates,
                  and the status/time column always stays on screen. */}
              <div className="max-h-64 overflow-y-auto">
                {data.recipients.length === 0 ? (
                  <p className="px-4 py-6 text-center text-white/25 text-xs">Still sending — recipients appear as they go out.</p>
                ) : data.recipients.map((r) => (
                  <div key={r.id} className="flex items-center gap-3 px-4 py-2 border-b border-white/[0.02]">
                    <span className="text-sm text-white/70 truncate flex-1 min-w-0" title={r.email}>{r.email}</span>
                    <span className="text-xs whitespace-nowrap flex-shrink-0 text-right">
                      {r.status === "failed"
                        ? <span className="text-red-400">failed</span>
                        : r.firstOpenedAt
                          ? <span className="text-amber-300 inline-flex items-center gap-1"><MailOpen className="w-3 h-3" /> opened{r.openCount > 1 ? ` ×${r.openCount}` : ""}</span>
                          : <span className="text-white/30">delivered</span>}
                      {r.firstOpenedAt && (
                        <span className="block text-[10px] text-white/30 sm:inline sm:ml-2">
                          {new Date(r.firstOpenedAt).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
              <div className="text-[10px] uppercase tracking-wider text-white/30 px-4 py-2 border-b border-white/5 font-semibold">What was sent</div>
              <div className="overflow-x-auto p-4 bg-white">
                <div className="text-sm text-black min-w-0" dangerouslySetInnerHTML={{ __html: data.campaign.body || "" }} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
