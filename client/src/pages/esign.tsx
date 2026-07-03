// E-Sign tab — ClubOS DocuSign replacement. Send any PDF for electronic
// signature, track status, download the completed signed PDF. Org-scoped;
// available across workspaces (staff contracts, sponsors, vendors, any doc).
// Internal admin — session + "esign" tab permission. The signer side is the
// public /sign/:token page (no login).
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  FileSignature, Plus, X, Upload, Send, Copy, Download, Trash2, Ban,
  Clock, CheckCircle2, Eye, FileText, ChevronRight, ChevronUp, ChevronDown, Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EsignPrepare } from "@/pages/esign-prepare";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

interface Signer {
  id: number;
  name: string;
  email: string;
  status: string; // pending | viewed | signed | declined
  token: string;
  signedAt: string | null;
  viewedAt: string | null;
  declineReason: string | null;
}
interface EventRow {
  id: number;
  type: string;
  actorEmail: string | null;
  ip: string | null;
  createdAt: string;
}
interface Doc {
  id: number;
  title: string;
  message: string | null;
  status: string; // draft | sent | viewed | completed | voided | declined
  docType?: string; // 'pdf' | 'native' (template-rendered web page)
  sourceFileName: string | null;
  createdAt: string;
  sentAt: string | null;
  completedAt: string | null;
  signers: Signer[];
  events?: EventRow[];
}
interface Template {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  variables: { key: string; label: string; type: string; options?: string[]; allowCustom?: boolean; default?: string; required?: boolean }[];
  settings: Record<string, any> | null;
  brand: Record<string, any>;
}

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "text-white/50 bg-white/5 border-white/10" },
  sent: { label: "Out for signature", cls: "text-sky-300 bg-sky-400/10 border-sky-400/25" },
  viewed: { label: "Viewed", cls: "text-indigo-300 bg-indigo-400/10 border-indigo-400/25" },
  completed: { label: "Completed", cls: "text-emerald-300 bg-emerald-400/10 border-emerald-400/25" },
  voided: { label: "Voided", cls: "text-white/40 bg-white/5 border-white/10" },
  declined: { label: "Declined", cls: "text-red-300 bg-red-400/10 border-red-400/25" },
};

function fmt(ts: string | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-NZ", { dateStyle: "medium", timeStyle: "short" });
}
function signerOrigin() {
  return window.location.origin;
}

export default function ESign() {
  const { toast } = useToast();
  const [newOpen, setNewOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [prepareId, setPrepareId] = useState<number | null>(null);

  const { data: docs = [], isLoading } = useQuery<Doc[]>({ queryKey: ["/api/admin/esign"] });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/esign"] });
  const onErr = (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" });

  const stats = useMemo(() => ({
    total: docs.length,
    out: docs.filter((d) => d.status === "sent" || d.status === "viewed").length,
    completed: docs.filter((d) => d.status === "completed").length,
    drafts: docs.filter((d) => d.status === "draft").length,
  }), [docs]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <FileSignature className="w-6 h-6 text-amber-400" />
            E-Sign
          </h1>
          <p className="text-sm text-white/40 mt-1">
            Send documents for electronic signature — staff contracts, sponsors, vendors. Replaces DocuSign.
          </p>
        </div>
        <Button onClick={() => setNewOpen(true)} className="gap-1.5">
          <Plus className="w-4 h-4" /> New document
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Documents", value: stats.total, icon: FileText },
          { label: "Out for signature", value: stats.out, icon: Clock },
          { label: "Completed", value: stats.completed, icon: CheckCircle2 },
          { label: "Drafts", value: stats.drafts, icon: FileSignature },
        ].map((s) => (
          <div key={s.label} className="bg-white/[0.03] border border-white/5 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-white/40 text-xs mb-1.5"><s.icon className="w-3.5 h-3.5" /> {s.label}</div>
            <div className="text-2xl font-bold text-white">{s.value}</div>
          </div>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center text-white/30 py-16">Loading…</div>
      ) : docs.length === 0 ? (
        <div className="text-center text-white/30 py-16 border border-dashed border-white/10 rounded-2xl">
          No documents yet. Click <span className="text-white/60">New document</span> to send your first one for signature.
        </div>
      ) : (
        <div className="space-y-2.5">
          {docs.map((d) => {
            const signed = d.signers.filter((s) => s.status === "signed").length;
            const st = STATUS[d.status] ?? STATUS.draft;
            return (
              <button
                key={d.id}
                onClick={() => (d.status === "draft" && d.docType !== "native" ? setPrepareId(d.id) : setDetailId(d.id))}
                className="w-full text-left bg-white/[0.03] border border-white/5 rounded-2xl p-4 hover:bg-white/[0.05] transition-colors flex items-center gap-4"
              >
                <div className="w-10 h-10 rounded-xl bg-amber-400/10 text-amber-400 flex items-center justify-center shrink-0">
                  <FileText className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-white font-medium truncate">{d.title}</div>
                  <div className="text-white/40 text-xs flex items-center gap-2 mt-0.5">
                    <Users className="w-3 h-3" /> {signed}/{d.signers.length} signed · sent {fmt(d.sentAt) === "—" ? "not yet" : fmt(d.sentAt)}
                  </div>
                </div>
                <span className={`text-[11px] font-medium px-2.5 py-1 rounded-full border ${st.cls}`}>{st.label}</span>
                <ChevronRight className="w-4 h-4 text-white/20" />
              </button>
            );
          })}
        </div>
      )}

      {newOpen && <NewDocDialog onClose={() => setNewOpen(false)} onDone={(id) => { setNewOpen(false); invalidate(); setPrepareId(id); }} onDoneNative={(id) => { setNewOpen(false); invalidate(); setDetailId(id); }} onErr={onErr} />}
      {detailId != null && <DetailDialog id={detailId} onClose={() => setDetailId(null)} onChanged={invalidate} onErr={onErr} />}
      {prepareId != null && <EsignPrepare docId={prepareId} onClose={() => { setPrepareId(null); invalidate(); }} onSent={() => { setPrepareId(null); invalidate(); }} />}
    </div>
  );
}

// ── New document ─────────────────────────────────────────────────────────────
function NewDocDialog({ onClose, onDone, onDoneNative, onErr }: { onClose: () => void; onDone: (id: number) => void; onDoneNative: (id: number) => void; onErr: (e: any) => void }) {
  const { toast } = useToast();
  const { data: templates = [] } = useQuery<Template[]>({ queryKey: ["/api/admin/esign/templates"] });
  const [mode, setMode] = useState<"pdf" | "template">("pdf");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [fileName, setFileName] = useState("");
  const [pdfBase64, setPdfBase64] = useState("");
  const [signers, setSigners] = useState([{ name: "", email: "" }]);
  const [sequential, setSequential] = useState(true);

  const moveSigner = (i: number, dir: -1 | 1) =>
    setSigners((p) => {
      const j = i + dir;
      if (j < 0 || j >= p.length) return p;
      const next = [...p];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const pickFile = (f: File | null) => {
    if (!f) return;
    if (f.type !== "application/pdf") { toast({ title: "PDF only", description: "Upload a PDF document.", variant: "destructive" }); return; }
    setFileName(f.name);
    if (!title) setTitle(f.name.replace(/\.pdf$/i, ""));
    const r = new FileReader();
    r.onload = () => setPdfBase64(String(r.result));
    r.readAsDataURL(f);
  };

  const valid = title.trim() && pdfBase64 && signers.some((s) => s.name.trim() && s.email.trim());

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/esign", {
        title: title.trim(),
        message: message.trim() || null,
        fileName,
        pdfBase64,
        sequential,
        signers: signers.filter((s) => s.name.trim() && s.email.trim()).map((s) => ({ name: s.name.trim(), email: s.email.trim() })),
      });
      return res.json();
    },
    onSuccess: (doc: any) => onDone(doc.id),
    onError: onErr,
  });

  if (mode === "template") {
    return <FromTemplateDialog templates={templates} onBack={() => setMode("pdf")} onClose={onClose} onDone={onDoneNative} onErr={onErr} />;
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>New document for signature</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1">
          {templates.length > 0 && (
            <button
              onClick={() => setMode("template")}
              className="w-full text-left rounded-xl border border-amber-400/30 bg-amber-400/5 hover:bg-amber-400/10 transition-colors p-3.5 flex items-center gap-3"
            >
              <div className="w-9 h-9 rounded-lg bg-amber-400/15 text-amber-400 flex items-center justify-center shrink-0">
                <FileSignature className="w-4.5 h-4.5" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold">Use an agreement template</div>
                <div className="text-xs text-muted-foreground truncate">
                  {templates.map((t) => t.name).join(" · ")} — branded web page, no PDF needed
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground ml-auto shrink-0" />
            </button>
          )}
          <div>
            <label className="text-xs text-muted-foreground">Document (PDF)</label>
            <label className="mt-1 flex items-center gap-2 px-3 py-3 rounded-lg border border-dashed border-input cursor-pointer hover:bg-accent/40 transition-colors">
              <Upload className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm truncate">{fileName || "Choose a PDF to send…"}</span>
              <input type="file" accept="application/pdf" className="hidden" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
            </label>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Title</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Vendor Agreement — Empire Chicken" className="mt-1" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Message to signers (optional)</label>
            <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Please review and sign." className="mt-1" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Signers</label>
            <div className="space-y-2 mt-1">
              {signers.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  {sequential && signers.length > 1 && (
                    <span className="w-5 h-5 shrink-0 rounded-full bg-amber-400/15 text-amber-500 text-[11px] font-bold flex items-center justify-center">{i + 1}</span>
                  )}
                  <Input value={s.name} onChange={(e) => setSigners((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="Full name" className="h-9" />
                  <Input value={s.email} onChange={(e) => setSigners((p) => p.map((x, j) => j === i ? { ...x, email: e.target.value } : x))} placeholder="email@example.com" className="h-9" />
                  {signers.length > 1 && (
                    <div className="flex flex-col shrink-0">
                      <button onClick={() => moveSigner(i, -1)} disabled={i === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-20"><ChevronUp className="w-3.5 h-3.5" /></button>
                      <button onClick={() => moveSigner(i, 1)} disabled={i === signers.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-20"><ChevronDown className="w-3.5 h-3.5" /></button>
                    </div>
                  )}
                  {signers.length > 1 && (
                    <button onClick={() => setSigners((p) => p.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-red-500 shrink-0"><X className="w-4 h-4" /></button>
                  )}
                </div>
              ))}
              <button onClick={() => setSigners((p) => [...p, { name: "", email: "" }])} className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                <Plus className="w-3.5 h-3.5" /> Add signer
              </button>
              {signers.length > 1 && (
                <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer pt-1">
                  <input type="checkbox" checked={sequential} onChange={(e) => setSequential(e.target.checked)} className="mt-0.5 accent-amber-400" />
                  <span><strong className="text-foreground">Sign in order</strong> — signer 2 is only invited after signer 1 has signed (their signature already on the document). Untick to invite everyone at once.</span>
                </label>
              )}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button disabled={!valid || create.isPending} onClick={() => create.mutate()} className="gap-1.5">
            <Send className="w-4 h-4" /> Create &amp; add fields
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── From template (e-Sign v2 native) ────────────────────────────────────────
// Pick a stored agreement template, set its variables (rate, start date, …),
// enter the recipient — they get a fully branded signing web page, fill their
// details inline and sign; you counter-sign after them.
function FromTemplateDialog({ templates, onBack, onClose, onDone, onErr }: {
  templates: Template[]; onBack: () => void; onClose: () => void; onDone: (id: number) => void; onErr: (e: any) => void;
}) {
  const { toast } = useToast();
  const [tplId, setTplId] = useState<number>(templates[0]?.id ?? 0);
  const tpl = templates.find((t) => t.id === tplId) ?? templates[0];
  const [vars, setVars] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const v of templates[0]?.variables ?? []) seed[v.key] = v.default || (v.options?.[0] ?? "");
    return seed;
  });
  const [custom, setCustom] = useState<Record<string, boolean>>({});
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  const pickTpl = (id: number) => {
    setTplId(id);
    const t = templates.find((x) => x.id === id);
    const seed: Record<string, string> = {};
    for (const v of t?.variables ?? []) seed[v.key] = v.default || (v.options?.[0] ?? "");
    setVars(seed);
    setCustom({});
  };

  const valid = tpl && /.+@.+\..+/.test(email.trim()) && (tpl.variables ?? []).every((v) => v.required === false || (vars[v.key] || "").trim());

  const create = useMutation({
    mutationFn: async (send: boolean) => {
      const res = await apiRequest("POST", "/api/admin/esign/from-template", {
        templateId: tpl.id,
        variables: vars,
        signerName: name.trim(),
        signerEmail: email.trim(),
        message: message.trim() || null,
        send,
      });
      return res.json();
    },
    onSuccess: (doc: any, send) => {
      toast({ title: send ? "Sent for signature" : "Draft saved", description: send ? `${name.trim() || email.trim()} has been emailed their signing link.` : "Send it from the document view when ready." });
      onDone(doc.id);
    },
    onError: onErr,
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><FileSignature className="w-5 h-5 text-amber-400" /> New from template</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1">
          {templates.length > 1 && (
            <div>
              <label className="text-xs text-muted-foreground">Template</label>
              <select value={tplId} onChange={(e) => pickTpl(parseInt(e.target.value))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm">
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          {templates.length === 1 && (
            <div className="rounded-xl border border-input p-3">
              <div className="text-sm font-semibold">{tpl.name}</div>
              {tpl.description && <div className="text-xs text-muted-foreground mt-0.5">{tpl.description}</div>}
            </div>
          )}

          {(tpl?.variables ?? []).map((v) => (
            <div key={v.key}>
              <label className="text-xs text-muted-foreground">{v.label}</label>
              {v.type === "select" && v.options?.length && !custom[v.key] ? (
                <div className="flex gap-2 mt-1">
                  <select value={vars[v.key] ?? ""} onChange={(e) => setVars((p) => ({ ...p, [v.key]: e.target.value }))} className="flex-1 h-10 rounded-lg border border-input bg-background px-3 text-sm">
                    {v.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                  {v.allowCustom && (
                    <Button type="button" size="sm" variant="outline" className="h-10" onClick={() => { setCustom((p) => ({ ...p, [v.key]: true })); setVars((p) => ({ ...p, [v.key]: "" })); }}>
                      Custom
                    </Button>
                  )}
                </div>
              ) : (
                <Input
                  type={v.type === "date" ? "date" : "text"}
                  value={vars[v.key] ?? ""}
                  onChange={(e) => setVars((p) => ({ ...p, [v.key]: e.target.value }))}
                  placeholder={v.type === "select" ? "e.g. $27.50" : ""}
                  className="mt-1"
                />
              )}
            </div>
          ))}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground">Recipient name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className="mt-1" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Recipient email</label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" className="mt-1" />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Message (optional)</label>
            <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Welcome to the team — please review and sign." className="mt-1" />
          </div>
          <p className="text-[11px] text-muted-foreground">
            They sign first on a branded web page (details filled inline, under-18s get a guardian co-sign step), then you counter-sign. Everyone gets the completed PDF automatically.
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onBack}>Back</Button>
          <Button variant="outline" disabled={!valid || create.isPending} onClick={() => create.mutate(false)}>Save draft</Button>
          <Button disabled={!valid || create.isPending} onClick={() => create.mutate(true)} className="gap-1.5">
            <Send className="w-4 h-4" /> Send for signature
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────
function DetailDialog({ id, onClose, onChanged, onErr }: { id: number; onClose: () => void; onChanged: () => void; onErr: (e: any) => void }) {
  const { toast } = useToast();
  const { data: doc, isLoading } = useQuery<Doc>({ queryKey: [`/api/admin/esign/${id}`] });
  const refresh = () => { queryClient.invalidateQueries({ queryKey: [`/api/admin/esign/${id}`] }); onChanged(); };

  const send = useMutation({ mutationFn: () => apiRequest("POST", `/api/admin/esign/${id}/send`), onSuccess: () => { toast({ title: "Sent", description: "Signers emailed." }); refresh(); }, onError: onErr });
  const remind = useMutation({ mutationFn: () => apiRequest("POST", `/api/admin/esign/${id}/remind`), onSuccess: () => toast({ title: "Reminder sent" }), onError: onErr });
  const voidIt = useMutation({ mutationFn: () => apiRequest("POST", `/api/admin/esign/${id}/void`), onSuccess: () => { toast({ title: "Voided" }); refresh(); }, onError: onErr });
  const del = useMutation({ mutationFn: () => apiRequest("DELETE", `/api/admin/esign/${id}`), onSuccess: () => { toast({ title: "Deleted" }); onClose(); onChanged(); }, onError: onErr });

  const copyLink = (token: string) => {
    navigator.clipboard.writeText(`${signerOrigin()}/sign/${token}`);
    toast({ title: "Signing link copied" });
  };

  const st = doc ? (STATUS[doc.status] ?? STATUS.draft) : STATUS.draft;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        {isLoading || !doc ? (
          <div className="py-16 text-center text-muted-foreground">Loading…</div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 pr-6">
                <span className="truncate">{doc.title}</span>
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border shrink-0 ${st.cls}`}>{st.label}</span>
              </DialogTitle>
            </DialogHeader>

            <div className="flex flex-wrap gap-2 py-2">
              <a href={`/api/admin/esign/${id}/source.pdf`} target="_blank" rel="noreferrer">
                <Button size="sm" variant="outline" className="gap-1.5"><FileText className="w-3.5 h-3.5" /> View document</Button>
              </a>
              {doc.status === "completed" && (
                <a href={`/api/admin/esign/${id}/signed.pdf`} target="_blank" rel="noreferrer">
                  <Button size="sm" className="gap-1.5"><Download className="w-3.5 h-3.5" /> Signed PDF</Button>
                </a>
              )}
              {doc.status === "draft" && <Button size="sm" className="gap-1.5" disabled={send.isPending} onClick={() => send.mutate()}><Send className="w-3.5 h-3.5" /> Send</Button>}
              {(doc.status === "sent" || doc.status === "viewed") && (
                <>
                  <Button size="sm" variant="outline" className="gap-1.5" disabled={remind.isPending} onClick={() => remind.mutate()}><Send className="w-3.5 h-3.5" /> Remind</Button>
                  <Button size="sm" variant="outline" className="gap-1.5 text-red-400" disabled={voidIt.isPending} onClick={() => voidIt.mutate()}><Ban className="w-3.5 h-3.5" /> Void</Button>
                </>
              )}
              {(doc.status === "draft" || doc.status === "voided") && (
                <Button size="sm" variant="outline" className="gap-1.5 text-red-400" disabled={del.isPending} onClick={() => del.mutate()}><Trash2 className="w-3.5 h-3.5" /> Delete</Button>
              )}
            </div>

            {doc.message && <p className="text-sm text-muted-foreground italic">“{doc.message}”</p>}

            <div className="space-y-2 mt-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Signers</div>
              {doc.signers.map((s) => {
                const ss = STATUS[s.status === "pending" ? "draft" : s.status] ?? STATUS.draft;
                return (
                  <div key={s.id} className="flex items-center gap-3 border rounded-xl p-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{s.name}</div>
                      <div className="text-xs text-muted-foreground truncate">{s.email}</div>
                      {s.status === "signed" && <div className="text-xs text-emerald-500 mt-0.5">Signed {fmt(s.signedAt)}</div>}
                      {s.status === "declined" && <div className="text-xs text-red-500 mt-0.5">Declined — {s.declineReason || "no reason"}</div>}
                    </div>
                    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${ss.cls}`}>
                      {s.status === "pending" ? "Awaiting" : s.status === "viewed" ? "Viewed" : s.status === "signed" ? "Signed" : "Declined"}
                    </span>
                    {doc.status !== "draft" && doc.status !== "voided" && s.status !== "signed" && (
                      <button onClick={() => copyLink(s.token)} title="Copy signing link" className="text-muted-foreground hover:text-foreground"><Copy className="w-4 h-4" /></button>
                    )}
                  </div>
                );
              })}
            </div>

            {doc.events && doc.events.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Audit trail</div>
                <div className="space-y-1.5">
                  {doc.events.map((e) => (
                    <div key={e.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Eye className="w-3 h-3 shrink-0" />
                      <span className="capitalize text-foreground/80">{e.type}</span>
                      {e.actorEmail && <span>· {e.actorEmail}</span>}
                      {e.ip && <span>· {e.ip}</span>}
                      <span className="ml-auto">{fmt(e.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
