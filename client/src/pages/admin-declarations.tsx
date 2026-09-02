// OFC Payables Declarations (Document F.05) — admin.
// Build a roster declaration, collect each player + staff member's electronic
// confirmation that the club has paid their contractual obligations, then the
// authorised signatory certifies and we produce ONE master PDF (OFC F.05 layout
// + per-person proof + Certificate of Completion) for the licensing submission.
//
// All subcomponents are MODULE scope (never define a component inside another —
// it remounts the tree and inputs lose focus; see sign.tsx / sign-native.tsx).
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { SignaturePad } from "@/components/signature-pad";
import {
  FileSignature, Plus, ArrowLeft, Users, Briefcase, Send, Eye, Download,
  Link2, Bell, Trash2, CheckCircle2, Clock, Circle, XCircle, ShieldCheck, Loader2, Ban,
} from "lucide-react";

// ── types ─────────────────────────────────────────────────────────────────
interface Signatory {
  id: number; group: "player" | "staff"; name: string; email: string | null;
  roleTitle: string | null; sortOrder: number; status: string; token: string;
  signedAt: string | null; viewedAt: string | null; declineReason: string | null;
}
interface Counts { total: number; signed: number }
interface Declaration {
  id: number; title: string; criterion: string; season: string | null; clubName: string;
  asOfDate: string | null; statement: string; statementTemplate: string;
  signatoryName: string | null; signatoryTitle: string | null; signatorySignedAt: string | null;
  status: string; createdAt: string; sentAt: string | null; completedAt: string | null;
  hasSignedPdf: boolean; counts: { players: Counts; staff: Counts };
  signatories: Signatory[];
  events?: { id: number; type: string; actorEmail: string | null; ip: string | null; createdAt: string; meta: any }[];
}

// ── helpers ───────────────────────────────────────────────────────────────
const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "—";
const fmtDateTime = (d: string | null) =>
  d ? new Date(d).toLocaleString("en-NZ", { dateStyle: "medium", timeStyle: "short" }) : "—";

const STATUS_META: Record<string, { label: string; color: string }> = {
  draft: { label: "Draft", color: "#64748b" },
  collecting: { label: "Collecting signatures", color: "#3b82f6" },
  completed: { label: "Certified & complete", color: "#22c55e" },
  voided: { label: "Voided", color: "#ef4444" },
};
const statusMeta = (s: string) => STATUS_META[s] || STATUS_META.draft;

function openPdf(base64: string, filename: string, download = false) {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    if (download) {
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.click();
    } else {
      window.open(url, "_blank");
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch { /* ignore */ }
}

const inputCls =
  "w-full h-10 px-3 rounded-lg bg-white/[0.03] border border-white/10 text-white/90 text-sm placeholder:text-white/25 focus:outline-none focus:border-amber-500/40";
const labelCls = "block text-[11px] font-semibold uppercase tracking-wide text-white/40 mb-1.5";
const cardCls = "rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5";

// ── status pill ─────────────────────────────────────────────────────────────
function Pill({ status }: { status: string }) {
  const m = statusMeta(status);
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold"
      style={{ background: `${m.color}1a`, color: m.color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  );
}
function SigIcon({ status }: { status: string }) {
  if (status === "signed") return <CheckCircle2 className="w-4 h-4" style={{ color: "#22c55e" }} />;
  if (status === "declined") return <XCircle className="w-4 h-4" style={{ color: "#ef4444" }} />;
  if (status === "viewed") return <Eye className="w-4 h-4" style={{ color: "#3b82f6" }} />;
  return <Circle className="w-4 h-4 text-white/30" />;
}

// ── list view ─────────────────────────────────────────────────────────────
function DeclList({ onOpen }: { onOpen: (id: number) => void }) {
  const { currentOrg } = useWorkspace();
  const { toast } = useToast();
  const orgId = currentOrg?.id;
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("Confirmation of No Overdue Payables towards Players and Club Staff");
  const [season, setSeason] = useState("2026/27");
  const [clubName, setClubName] = useState("Christchurch United Football Club Incorporated");
  const [asOfDate, setAsOfDate] = useState("");
  const [signatoryName, setSignatoryName] = useState("");
  const [signatoryTitle, setSignatoryTitle] = useState("");

  const { data: list = [], isLoading } = useQuery<Declaration[]>({
    queryKey: ["/api/admin/declarations", orgId],
    queryFn: async () => (await apiRequest("GET", "/api/admin/declarations")).json(),
    enabled: !!orgId,
  });

  const create = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/admin/declarations", {
        title, season, clubName, asOfDate: asOfDate || null, signatoryName, signatoryTitle,
      })).json(),
    onSuccess: (d: Declaration) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/declarations", orgId] });
      setCreating(false);
      onOpen(d.id);
    },
    onError: (e: any) => toast({ title: "Couldn't create", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <FileSignature className="w-6 h-6 text-amber-400" /> Declarations
          </h1>
          <p className="text-white/45 text-sm mt-1 max-w-2xl">
            OFC club-licensing confirmations. Each player and staff member signs electronically that the club has paid
            their contractual obligations; you certify, and ClubOS produces one master PDF (signatures + proof) for the submission.
          </p>
        </div>
        <button onClick={() => setCreating((v) => !v)}
          className="shrink-0 inline-flex items-center gap-1.5 h-10 px-4 rounded-xl bg-amber-500 text-black font-semibold text-sm hover:bg-amber-400 transition-colors">
          <Plus className="w-4 h-4" /> New declaration
        </button>
      </div>

      {creating && (
        <div className={`${cardCls} mt-5 space-y-4`}>
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className={labelCls}>Document title</label>
              <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Season</label>
              <input className={inputCls} value={season} onChange={(e) => setSeason(e.target.value)} placeholder="2026/27" />
            </div>
            <div>
              <label className={labelCls}>Paid up to (as-of date)</label>
              <DatePickerInput className={inputCls} value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className={labelCls}>Club (legal applicant)</label>
              <input className={inputCls} value={clubName} onChange={(e) => setClubName(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Authorised signatory</label>
              <input className={inputCls} value={signatoryName} onChange={(e) => setSignatoryName(e.target.value)} placeholder="e.g. Slava Meyn" />
            </div>
            <div>
              <label className={labelCls}>Signatory job title</label>
              <input className={inputCls} value={signatoryTitle} onChange={(e) => setSignatoryTitle(e.target.value)} placeholder="e.g. President" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button disabled={create.isPending} onClick={() => create.mutate()}
              className="inline-flex items-center gap-1.5 h-10 px-4 rounded-xl bg-amber-500 text-black font-semibold text-sm disabled:opacity-50">
              {create.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create & add roster
            </button>
            <button onClick={() => setCreating(false)} className="h-10 px-4 rounded-xl border border-white/10 text-white/60 text-sm hover:bg-white/5">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-6 space-y-3">
        {isLoading && [0, 1, 2].map((i) => <div key={i} className="h-20 rounded-2xl bg-white/[0.03] animate-pulse" />)}
        {!isLoading && list.length === 0 && !creating && (
          <div className="text-center py-16 text-white/40">
            <FileSignature className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">No declarations yet. Start the F.05 payables confirmation with “New declaration”.</p>
          </div>
        )}
        {list.map((d) => {
          const ps = d.counts.players, ss = d.counts.staff;
          const totalSigned = ps.signed + ss.signed, total = ps.total + ss.total;
          return (
            <button key={d.id} onClick={() => onOpen(d.id)}
              className="w-full text-left rounded-2xl border border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04] p-5 transition-colors">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-bold tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">OFC {d.criterion}</span>
                    <Pill status={d.status} />
                  </div>
                  <h3 className="text-white font-semibold truncate">{d.title}</h3>
                  <p className="text-white/45 text-xs mt-1">
                    {d.season ? `Season ${d.season} · ` : ""}{d.clubName} · created {fmtDate(d.createdAt)}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-white font-bold text-lg">{totalSigned}<span className="text-white/40 text-sm">/{total}</span></div>
                  <div className="text-white/40 text-[11px]">signed</div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── roster panel ────────────────────────────────────────────────────────────
function RosterPanel({
  group, title, icon, list, counts, disabled, onAdd, onRemove, onRemind, onCopy,
}: {
  group: "player" | "staff"; title: string; icon: React.ReactNode; list: Signatory[]; counts: Counts;
  disabled: boolean;
  onAdd: (group: "player" | "staff", bulk: string) => void;
  onRemove: (id: number) => void;
  onRemind: (id: number) => void;
  onCopy: (token: string) => void;
}) {
  const [bulk, setBulk] = useState("");
  return (
    <div className={cardCls}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-white flex items-center gap-2">{icon} {title}</h3>
        <span className="text-xs text-white/50">{counts.signed}/{counts.total} signed</span>
      </div>

      {counts.total > 0 && (
        <div className="h-1.5 rounded-full bg-white/[0.06] mb-4 overflow-hidden">
          <div className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${counts.total ? (counts.signed / counts.total) * 100 : 0}%` }} />
        </div>
      )}

      <div className="space-y-1.5 mb-4">
        {list.length === 0 && <p className="text-white/35 text-xs py-2">No {title.toLowerCase()} added yet.</p>}
        {list.map((s) => (
          <div key={s.id} className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.05]">
            <SigIcon status={s.status} />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-white/90 truncate">{s.name}</div>
              <div className="text-[11px] text-white/40 truncate">
                {s.email || "no email · in-person link"}{s.signedAt ? ` · signed ${fmtDate(s.signedAt)}` : ""}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button title="Copy signing link" onClick={() => onCopy(s.token)} className="p-1.5 rounded-md hover:bg-white/10 text-white/50">
                <Link2 className="w-3.5 h-3.5" />
              </button>
              {s.email && s.status !== "signed" && (
                <button title="Email reminder" onClick={() => onRemind(s.id)} className="p-1.5 rounded-md hover:bg-white/10 text-white/50">
                  <Bell className="w-3.5 h-3.5" />
                </button>
              )}
              {!disabled && (
                <button title="Remove" onClick={() => onRemove(s.id)} className="p-1.5 rounded-md hover:bg-red-500/15 text-white/40 hover:text-red-400">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {!disabled && (
        <div className="space-y-2">
          <textarea
            value={bulk} onChange={(e) => setBulk(e.target.value)}
            rows={3}
            placeholder={`Paste one per line:\nJane Smith, jane@email.com\nSam Jones`}
            className="w-full px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-white/90 text-sm placeholder:text-white/25 focus:outline-none focus:border-amber-500/40 resize-y"
          />
          <button
            disabled={!bulk.trim()}
            onClick={() => { onAdd(group, bulk); setBulk(""); }}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-white/[0.06] border border-white/10 text-white/80 text-sm hover:bg-white/[0.1] disabled:opacity-40">
            <Plus className="w-4 h-4" /> Add {title.toLowerCase()}
          </button>
          <p className="text-[11px] text-white/30">Name required · email optional (needed to send an invite; without one, use the copy-link for in-person signing).</p>
        </div>
      )}
    </div>
  );
}

// ── certify panel ─────────────────────────────────────────────────────────
function CertifyPanel({ decl, onDone, onCancel }: { decl: Declaration; onDone: () => void; onCancel: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState(decl.signatoryName || "");
  const [title, setTitle] = useState(decl.signatoryTitle || "");
  const [typed, setTyped] = useState("");
  const [sig, setSig] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);

  const certify = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/admin/declarations/${decl.id}/certify`, {
        name, title, signatureName: typed, signatureImage: sig, consent,
      })).json(),
    onSuccess: () => { toast({ title: "Certified", description: "Master PDF generated and emailed to you." }); onDone(); },
    onError: (e: any) => toast({ title: "Couldn't certify", description: e.message, variant: "destructive" }),
  });

  const total = decl.counts.players.total + decl.counts.staff.total;
  const signed = decl.counts.players.signed + decl.counts.staff.signed;
  const canCertify = consent && typed.trim().length >= 2 && !certify.isPending;

  return (
    <div className={`${cardCls} border-amber-500/20`}>
      <h3 className="font-semibold text-white flex items-center gap-2 mb-1"><ShieldCheck className="w-5 h-5 text-amber-400" /> Certify &amp; finalise</h3>
      <p className="text-white/50 text-sm mb-4">
        As the club’s authorised signatory you certify the information above is true and correct. This locks the declaration and
        produces the master PDF. {signed < total && (
          <span className="text-amber-300">Note: {signed} of {total} people have signed — you can still certify, but unsigned rows will show blank.</span>
        )}
      </p>
      <div className="grid sm:grid-cols-2 gap-4 mb-4">
        <div>
          <label className={labelCls}>Your name</label>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
        </div>
        <div>
          <label className={labelCls}>Job title</label>
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. President / CEO" />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls}>Type your full name to sign</label>
          <input className={inputCls} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type your name" />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls}>Draw signature (optional)</label>
          <div className="rounded-xl overflow-hidden bg-white">
            <SignaturePad onChange={setSig} height={140} />
          </div>
        </div>
      </div>
      <label className="flex items-start gap-2.5 mb-4 cursor-pointer">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 w-4 h-4 accent-amber-500" />
        <span className="text-sm text-white/70">I certify that the information provided is true and correct to the best of my knowledge, and I consent to signing this declaration electronically.</span>
      </label>
      <div className="flex items-center gap-2">
        <button disabled={!canCertify} onClick={() => certify.mutate()}
          className="inline-flex items-center gap-1.5 h-10 px-4 rounded-xl bg-amber-500 text-black font-semibold text-sm disabled:opacity-40">
          {certify.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />} Certify &amp; generate master PDF
        </button>
        <button onClick={onCancel} className="h-10 px-4 rounded-xl border border-white/10 text-white/60 text-sm hover:bg-white/5">Cancel</button>
      </div>
    </div>
  );
}

// ── detail view ─────────────────────────────────────────────────────────────
function DeclDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const { currentOrg } = useWorkspace();
  const { toast } = useToast();
  const orgId = currentOrg?.id;
  const [showCertify, setShowCertify] = useState(false);
  const [rendering, setRendering] = useState(false);

  const key = ["/api/admin/declarations", id, "detail"];
  const { data: decl, isLoading } = useQuery<Declaration>({
    queryKey: key,
    queryFn: async () => (await apiRequest("GET", `/api/admin/declarations/${id}`)).json(),
  });
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: key });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/declarations", orgId] });
  };

  const patch = useMutation({
    mutationFn: async (body: Partial<Declaration>) => (await apiRequest("PATCH", `/api/admin/declarations/${id}`, body)).json(),
    onSuccess: () => invalidate(),
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });
  const addSigs = useMutation({
    mutationFn: async (signatories: any[]) => (await apiRequest("POST", `/api/admin/declarations/${id}/signatories`, { signatories })).json(),
    onSuccess: () => invalidate(),
    onError: (e: any) => toast({ title: "Couldn't add", description: e.message, variant: "destructive" }),
  });
  const removeSig = useMutation({
    mutationFn: async (sid: number) => (await apiRequest("DELETE", `/api/admin/declarations/${id}/signatories/${sid}`)).json(),
    onSuccess: () => invalidate(),
  });
  const send = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/admin/declarations/${id}/send`, {})).json(),
    onSuccess: (r: any) => { toast({ title: "Invites sent", description: `Emailed ${r.emailed} pending signatory(ies).` }); invalidate(); },
    onError: (e: any) => toast({ title: "Send failed", description: e.message, variant: "destructive" }),
  });
  const remind = useMutation({
    mutationFn: async (sid: number) => (await apiRequest("POST", `/api/admin/declarations/${id}/signatories/${sid}/remind`, {})).json(),
    onSuccess: () => toast({ title: "Reminder sent" }),
  });
  const voidDecl = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/admin/declarations/${id}/void`, {})).json(),
    onSuccess: () => { toast({ title: "Voided" }); invalidate(); },
  });

  const copyLink = (token: string) => {
    navigator.clipboard?.writeText(`${window.location.origin}/declaration/${token}`);
    toast({ title: "Signing link copied" });
  };
  const parseBulk = (group: "player" | "staff", bulk: string) => {
    const rows = bulk.split("\n").map((line) => {
      const parts = line.split(",").map((p) => p.trim());
      const name = parts[0];
      const email = parts.find((p) => /.+@.+\..+/.test(p)) || null;
      const roleTitle = parts[1] && !/.+@.+\..+/.test(parts[1]) ? parts[1] : null;
      return name ? { group, name, email, roleTitle } : null;
    }).filter(Boolean);
    if (rows.length) addSigs.mutate(rows as any[]);
  };
  const preview = async () => {
    setRendering(true);
    try {
      const r = await (await apiRequest("POST", `/api/admin/declarations/${id}/render`, {})).json();
      openPdf(r.pdf, `${decl?.criterion || "F05"}-declaration.pdf`, false);
    } catch (e: any) {
      toast({ title: "Couldn't render", description: e.message, variant: "destructive" });
    } finally { setRendering(false); }
  };

  if (isLoading || !decl) {
    return <div className="max-w-4xl mx-auto px-6 py-8"><div className="h-40 rounded-2xl bg-white/[0.03] animate-pulse" /></div>;
  }

  const closed = decl.status === "completed" || decl.status === "voided";
  const players = decl.signatories.filter((s) => s.group === "player");
  const staff = decl.signatories.filter((s) => s.group === "staff");
  const pendingWithEmail = decl.signatories.filter((s) => s.email && s.status !== "signed" && s.status !== "declined").length;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-white/50 hover:text-white/80 text-sm mb-5">
        <ArrowLeft className="w-4 h-4" /> All declarations
      </button>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10px] font-bold tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">OFC {decl.criterion}</span>
            <Pill status={decl.status} />
          </div>
          <h1 className="text-2xl font-bold text-white">{decl.title}</h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={preview} disabled={rendering}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-white/10 text-white/70 text-sm hover:bg-white/5 disabled:opacity-50">
            {rendering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />} Preview PDF
          </button>
          {decl.status === "completed" && decl.hasSignedPdf && (
            <button onClick={preview} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-emerald-500/15 text-emerald-300 text-sm hover:bg-emerald-500/25">
              <Download className="w-4 h-4" /> Master PDF
            </button>
          )}
        </div>
      </div>

      {/* editable header */}
      <div className={`${cardCls} mb-5`}>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Season</label>
            <input className={inputCls} defaultValue={decl.season || ""} disabled={closed}
              onBlur={(e) => e.target.value !== (decl.season || "") && patch.mutate({ season: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Paid up to (as-of date)</label>
            <DatePickerInput className={inputCls} value={decl.asOfDate || ""} disabled={closed}
              onChange={(e) => e.target.value !== (decl.asOfDate || "") && patch.mutate({ asOfDate: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Club (legal applicant)</label>
            <input className={inputCls} defaultValue={decl.clubName} disabled={closed}
              onBlur={(e) => e.target.value !== decl.clubName && patch.mutate({ clubName: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Authorised signatory</label>
            <input className={inputCls} defaultValue={decl.signatoryName || ""} disabled={closed}
              onBlur={(e) => e.target.value !== (decl.signatoryName || "") && patch.mutate({ signatoryName: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Signatory job title</label>
            <input className={inputCls} defaultValue={decl.signatoryTitle || ""} disabled={closed}
              onBlur={(e) => e.target.value !== (decl.signatoryTitle || "") && patch.mutate({ signatoryTitle: e.target.value })} />
          </div>
        </div>
        <div className="mt-4 p-3.5 rounded-lg bg-amber-500/[0.06] border border-amber-500/15">
          <div className={labelCls}>Statement each person confirms</div>
          <p className="text-sm text-white/70 leading-relaxed">{decl.statement}</p>
        </div>
      </div>

      {/* roster */}
      <div className="grid md:grid-cols-2 gap-5 mb-5">
        <RosterPanel group="player" title="Players" icon={<Users className="w-4 h-4 text-amber-400" />}
          list={players} counts={decl.counts.players} disabled={closed}
          onAdd={parseBulk} onRemove={(sid) => removeSig.mutate(sid)} onRemind={(sid) => remind.mutate(sid)} onCopy={copyLink} />
        <RosterPanel group="staff" title="Club Staff" icon={<Briefcase className="w-4 h-4 text-amber-400" />}
          list={staff} counts={decl.counts.staff} disabled={closed}
          onAdd={parseBulk} onRemove={(sid) => removeSig.mutate(sid)} onRemind={(sid) => remind.mutate(sid)} onCopy={copyLink} />
      </div>

      {/* actions */}
      {!closed && (
        <div className="flex flex-wrap items-center gap-2 mb-5">
          <button onClick={() => send.mutate()} disabled={send.isPending || pendingWithEmail === 0}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-xl bg-white/[0.06] border border-white/10 text-white/85 text-sm hover:bg-white/[0.1] disabled:opacity-40">
            {send.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Send invites{pendingWithEmail > 0 ? ` (${pendingWithEmail})` : ""}
          </button>
          <button onClick={() => setShowCertify((v) => !v)} disabled={decl.signatories.length === 0}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-xl bg-amber-500 text-black font-semibold text-sm disabled:opacity-40">
            <ShieldCheck className="w-4 h-4" /> Certify &amp; finalise
          </button>
          <button onClick={() => { if (confirm("Void this declaration? It can no longer be signed.")) voidDecl.mutate(); }}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-xl border border-white/10 text-white/50 text-sm hover:bg-red-500/10 hover:text-red-400 ml-auto">
            <Ban className="w-4 h-4" /> Void
          </button>
        </div>
      )}

      {showCertify && !closed && (
        <div className="mb-5">
          <CertifyPanel decl={decl} onDone={() => { setShowCertify(false); invalidate(); }} onCancel={() => setShowCertify(false)} />
        </div>
      )}

      {decl.status === "completed" && (
        <div className={`${cardCls} border-emerald-500/20 mb-5`}>
          <div className="flex items-center gap-2 text-emerald-300 font-semibold mb-1"><CheckCircle2 className="w-5 h-5" /> Certified &amp; complete</div>
          <p className="text-white/55 text-sm">
            Certified by {decl.signatoryName || "—"}{decl.signatoryTitle ? `, ${decl.signatoryTitle}` : ""} on {fmtDateTime(decl.completedAt)}.
            The master PDF is ready — open it with “Master PDF” above.
          </p>
        </div>
      )}

      {/* audit */}
      {decl.events && decl.events.length > 0 && (
        <div className={cardCls}>
          <h3 className="font-semibold text-white flex items-center gap-2 mb-3"><Clock className="w-4 h-4 text-white/50" /> Activity</h3>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {decl.events.map((e) => (
              <div key={e.id} className="flex items-center justify-between text-xs text-white/50 py-1 border-b border-white/[0.04]">
                <span className="capitalize">{e.type.replace(/_/g, " ")}{e.actorEmail ? ` · ${e.actorEmail}` : ""}</span>
                <span className="text-white/30">{fmtDateTime(e.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── page ────────────────────────────────────────────────────────────────────
export default function AdminDeclarations() {
  const [selected, setSelected] = useState<number | null>(null);
  return selected == null
    ? <DeclList onOpen={setSelected} />
    : <DeclDetail id={selected} onBack={() => setSelected(null)} />;
}
