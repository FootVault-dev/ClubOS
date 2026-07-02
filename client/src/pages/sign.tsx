// Public signing page — /sign/:token. No login. Two modes:
//  • FIELD mode  — the sender placed fields; signer fills them on the document
//    with a "X of Y" tracker; Finish unlocks only when all required are done.
//  • SIMPLE mode — no fields; classic type/draw signature + consent.
// Legal basis: Contract and Commercial Law Act 2017 (Part 4).
import { useEffect, useMemo, useState, type ReactNode, type CSSProperties } from "react";
import { useRoute } from "wouter";
import { SignaturePad } from "@/components/signature-pad";
import { PdfDoc } from "@/components/pdf-doc";
import { Loader2, CheckCircle2, FileText, ShieldCheck, AlertTriangle, PenLine, X } from "lucide-react";

interface Field {
  id: number; type: string; page: number; x: number; y: number; w: number; h: number;
  required: boolean; label: string | null; value: string | null; valueImage: string | null;
}
interface SignData {
  documentStatus: string; title: string; message: string | null; orgName: string;
  signer: { name: string; email: string; status: string };
  parties: { name: string; status: string }[];
  fields: Field[];
}

const initialsOf = (name: string) => name.trim().split(/\s+/).map((w) => w[0] || "").join("").toUpperCase().slice(0, 4);

// Page chrome — module-level so its identity is stable across renders.
// (Defining these inside the component remounted the whole tree on every
// keystroke: canvases reloaded and the page jumped to the top.)
const Shell = ({ children }: { children: ReactNode }) => (
  <div className="min-h-screen bg-[#f4f2ec] text-slate-900">
    <div className="h-1.5 bg-gradient-to-r from-[#937224] via-[#C9A43E] to-[#E4C56A]" />
    <div className="max-w-5xl mx-auto px-3 md:px-4 py-5 md:py-8">{children}</div>
    <footer className="max-w-5xl mx-auto px-4 pb-44 md:pb-28 text-xs text-slate-400 text-center">
      Secure electronic signing · ClubOS e-Sign · Valid under the Contract and Commercial Law Act 2017 (NZ)
    </footer>
  </div>
);
const Card = ({ icon, title, sub }: { icon: ReactNode; title: string; sub?: string }) => (
  <div className="bg-white rounded-2xl border p-10 text-center max-w-md mx-auto mt-10">
    {icon}<h1 className="text-lg font-semibold mt-2">{title}</h1>{sub && <p className="text-slate-500 mt-1 text-sm">{sub}</p>}
  </div>
);

export default function SignPage() {
  const [, params] = useRoute("/sign/:token");
  const token = params?.token ?? "";

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<SignData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [vals, setVals] = useState<Record<number, { value?: string | null; valueImage?: string | null }>>({});
  const [adoptedName, setAdoptedName] = useState("");
  const [adoptedImage, setAdoptedImage] = useState<string | null>(null);
  const [adoptOpen, setAdoptOpen] = useState(false);

  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<null | { allComplete: boolean }>(null);
  const [declined, setDeclined] = useState(false);
  const [showDecline, setShowDecline] = useState(false);
  const [declineReason, setDeclineReason] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/sign/${token}`);
        const json = await res.json();
        if (!active) return;
        if (!res.ok) setError(json.message || "This signing link is invalid.");
        else {
          setData(json);
          setAdoptedName(json.signer?.name ?? "");
          const seed: Record<number, { value?: string | null; valueImage?: string | null }> = {};
          for (const f of json.fields ?? []) if (f.value || f.valueImage) seed[f.id] = { value: f.value, valueImage: f.valueImage };
          setVals(seed);
        }
      } catch { if (active) setError("Could not load this document."); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [token]);

  const fields = data?.fields ?? [];
  const fieldMode = fields.length > 0;

  const isFilled = (f: Field) => {
    const v = vals[f.id];
    if (f.type === "checkbox") return v?.value === "true";
    return !!v?.valueImage || !!(v?.value && String(v.value).trim());
  };
  const requiredFields = useMemo(() => fields.filter((f) => f.required), [fields]);
  const doneCount = requiredFields.filter(isFilled).length;
  const allRequiredDone = doneCount === requiredFields.length;

  const setVal = (id: number, patch: { value?: string | null; valueImage?: string | null }) =>
    setVals((p) => ({ ...p, [id]: { ...p[id], ...patch } }));

  const applySignature = (f: Field) => {
    if (f.type === "initials") setVal(f.id, adoptedImage ? { valueImage: adoptedImage, value: null } : { value: initialsOf(adoptedName), valueImage: null });
    else setVal(f.id, adoptedImage ? { valueImage: adoptedImage, value: null } : { value: adoptedName, valueImage: null });
  };

  const submit = async () => {
    if (!consent) return;
    if (fieldMode && !allRequiredDone) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/sign/${token}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consent: true,
          signatureName: (adoptedName || data?.signer.name || "").trim(),
          signatureImage: adoptedImage,
          fields: fields.map((f) => ({ id: f.id, value: vals[f.id]?.value ?? null, valueImage: vals[f.id]?.valueImage ?? null })),
        }),
      });
      const json = await res.json();
      if (!res.ok) setError(json.message || "Could not record your signature.");
      else setDone({ allComplete: !!json.allComplete });
    } catch { setError("Something went wrong while signing."); }
    finally { setSubmitting(false); }
  };

  const decline = async () => {
    setSubmitting(true);
    try {
      await fetch(`/api/sign/${token}/decline`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: declineReason.trim() || null }) });
      setDeclined(true);
    } finally { setSubmitting(false); }
  };

  if (loading) return <Shell><div className="py-32 text-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" />Loading document…</div></Shell>;
  if (error && !data) return <Shell><Card icon={<AlertTriangle className="w-8 h-8 text-amber-500 mx-auto" />} title="Link unavailable" sub={error} /></Shell>;
  if (declined) return <Shell><Card icon={<X className="w-8 h-8 text-slate-400 mx-auto" />} title="Signing declined" sub={`We've let ${data?.orgName} know you declined to sign.`} /></Shell>;
  if (done) return <Shell><Card icon={<CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto" />} title={`Signed — thank you, ${data?.signer.name}`} sub={done.allComplete ? "All parties have now signed. A copy is on its way to your inbox." : "Your signature has been recorded. You'll get a copy once everyone has signed."} /></Shell>;
  if (!data) return null;
  if (data.documentStatus === "voided") return <Shell><Card icon={<AlertTriangle className="w-8 h-8 text-slate-400 mx-auto" />} title="No longer available" sub="This document has been voided by the sender." /></Shell>;
  if (data.signer.status === "signed") return <Shell><Card icon={<CheckCircle2 className="w-9 h-9 text-emerald-500 mx-auto" />} title="You've already signed" sub="Thanks — nothing more to do." /></Shell>;

  // Header
  const head = (
    <div className="mb-5">
      <div className="text-xs uppercase tracking-widest text-[#937224] font-semibold">{data.orgName}</div>
      <h1 className="text-2xl font-bold mt-1 flex items-center gap-2"><FileText className="w-6 h-6 text-[#C9A43E]" /> {data.title}</h1>
      {data.message && <p className="text-slate-500 italic mt-1 text-sm border-l-2 border-[#C9A43E] pl-3">“{data.message}”</p>}
      <p className="text-sm text-slate-500 mt-2">Signing as <strong className="text-slate-700">{data.signer.name}</strong> ({data.signer.email})</p>
    </div>
  );

  // ── FIELD MODE ──
  if (fieldMode) {
    return (
      <Shell>
        {head}
        <div className="bg-white rounded-2xl border p-2 md:p-5 shadow-sm">
          <PdfDoc
            url={`/api/sign/${token}/document.pdf`}
            width={760}
            renderOverlay={(pageIndex, _pw, ph) => (
              <>
                {fields.filter((f) => f.page === pageIndex).map((f) => (
                  <FieldWidget key={f.id} field={f} value={vals[f.id]} pageH={ph}
                    filled={isFilled(f)}
                    onText={(v) => setVal(f.id, { value: v, valueImage: null })}
                    onToggle={() => setVal(f.id, { value: vals[f.id]?.value === "true" ? "false" : "true" })}
                    onSign={() => { if (!adoptedName && !adoptedImage) setAdoptOpen(true); else applySignature(f); }}
                  />
                ))}
              </>
            )}
          />
        </div>

        {/* Sticky action bar */}
        <div className="fixed bottom-0 inset-x-0 bg-white border-t shadow-[0_-4px_20px_rgba(0,0,0,0.06)] z-40">
          <div className="max-w-5xl mx-auto px-3 md:px-4 py-2.5 md:py-3 flex flex-wrap items-center gap-x-3 gap-y-2" style={{ paddingBottom: "max(0.65rem, env(safe-area-inset-bottom))" }}>
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold">{doneCount}/{requiredFields.length}</div>
              <div className="text-xs text-slate-500">
                required fields{fields.length > requiredFields.length ? ` · ${fields.length - requiredFields.length} optional` : ""}
              </div>
              <div className="w-28 h-1.5 bg-slate-200 rounded-full overflow-hidden ml-1">
                <div className="h-full bg-[#C9A43E]" style={{ width: `${requiredFields.length ? (doneCount / requiredFields.length) * 100 : 100}%` }} />
              </div>
            </div>
            <button onClick={() => setAdoptOpen(true)} className="text-xs px-3 py-2 rounded-lg border hover:bg-slate-50 inline-flex items-center gap-1.5">
              <PenLine className="w-3.5 h-3.5" /> {adoptedImage ? "Edit signature" : "Adopt signature"}
            </button>
            <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer max-w-xs">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="accent-[#C9A43E] shrink-0" />
              I agree to sign electronically (Contract and Commercial Law Act 2017).
            </label>
            {error && <span className="text-xs text-red-500">{error}</span>}
            <div className="ml-auto flex items-center gap-2">
              {!showDecline ? (
                <button onClick={() => setShowDecline(true)} className="text-xs text-slate-400 hover:text-slate-600">Decline</button>
              ) : (
                <>
                  <input value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder="Reason" className="h-9 w-32 rounded-lg border px-2 text-sm" />
                  <button onClick={decline} disabled={submitting} className="h-9 px-3 rounded-lg bg-red-500 text-white text-sm">Confirm</button>
                </>
              )}
              <button onClick={submit} disabled={!consent || !allRequiredDone || submitting}
                className="h-10 px-5 rounded-xl bg-[#C9A43E] hover:bg-[#b8942f] disabled:opacity-50 text-slate-900 font-bold text-sm inline-flex items-center gap-2">
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Finish &amp; sign
              </button>
            </div>
          </div>
        </div>

        {adoptOpen && (
          <AdoptModal name={adoptedName} onName={setAdoptedName} image={adoptedImage} onImage={setAdoptedImage} onClose={() => setAdoptOpen(false)} />
        )}
      </Shell>
    );
  }

  // ── SIMPLE MODE (no fields) ──
  return (
    <Shell>
      {head}
      <div className="grid lg:grid-cols-[1fr_360px] gap-5 items-start">
        <div className="bg-white rounded-2xl border overflow-hidden shadow-sm">
          <object data={`/api/sign/${token}/document.pdf`} type="application/pdf" className="w-full" style={{ height: "70vh", minHeight: 480 }}>
            <div className="p-8 text-center text-sm text-slate-500">Can't preview here. <a className="text-[#937224] underline" href={`/api/sign/${token}/document.pdf`} target="_blank" rel="noreferrer">Open the PDF</a>.</div>
          </object>
        </div>
        <div className="bg-white rounded-2xl border p-5 shadow-sm lg:sticky lg:top-6 space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="w-4 h-4 text-[#C9A43E]" /> Adopt your signature</div>
          <div>
            <label className="text-xs text-slate-500">Full legal name</label>
            <input value={adoptedName} onChange={(e) => setAdoptedName(e.target.value)} placeholder="Your full name" className="mt-1 w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#C9A43E]/40" />
            {adoptedName.trim() && <div className="mt-2 px-3 py-2 rounded-lg bg-slate-50 border"><span style={{ fontFamily: "'Brush Script MT', cursive" }} className="text-2xl">{adoptedName}</span></div>}
          </div>
          <div>
            <label className="text-xs text-slate-500">Draw your signature (optional)</label>
            <div className="mt-1"><SignaturePad onChange={setAdoptedImage} height={150} /></div>
          </div>
          <label className="flex items-start gap-2 text-xs text-slate-600 cursor-pointer">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 accent-[#C9A43E]" />
            I agree to sign electronically and that my signature is legally binding, under the Contract and Commercial Law Act 2017.
          </label>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button onClick={submit} disabled={!adoptedName.trim() || !consent || submitting} className="w-full h-11 rounded-xl bg-[#C9A43E] hover:bg-[#b8942f] disabled:opacity-50 text-slate-900 font-bold text-sm flex items-center justify-center gap-2">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Sign document
          </button>
          {!showDecline ? (
            <button onClick={() => setShowDecline(true)} className="w-full text-xs text-slate-400 hover:text-slate-600">Decline to sign</button>
          ) : (
            <div className="space-y-2 border-t pt-3">
              <input value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder="Reason (optional)" className="w-full h-9 rounded-lg border px-3 text-sm" />
              <div className="flex gap-2">
                <button onClick={() => setShowDecline(false)} className="flex-1 h-9 rounded-lg border text-sm">Cancel</button>
                <button onClick={decline} disabled={submitting} className="flex-1 h-9 rounded-lg bg-red-500 text-white text-sm">Confirm decline</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

// A single fillable field overlaid on the PDF.
function FieldWidget({ field, value, filled, pageH, onText, onToggle, onSign }: {
  field: Field; value?: { value?: string | null; valueImage?: string | null }; filled: boolean;
  pageH: number; onText: (v: string) => void; onToggle: () => void; onSign: () => void;
}) {
  const style: CSSProperties = { left: `${field.x * 100}%`, top: `${field.y * 100}%`, width: `${field.w * 100}%`, height: `${field.h * 100}%`, position: "absolute" };
  // Text scales with the box so it stays legible at any page width (mobile).
  const fontSize = Math.max(8, Math.min(13, Math.round(field.h * pageH * 0.62)));
  // Required = gold; optional = neutral grey so the two are obviously different.
  const base = field.required
    ? `rounded-sm ${!filled ? "ring-2 ring-[#C9A43E]" : "ring-1 ring-[#C9A43E]/40"} bg-[#C9A43E]/10`
    : `rounded-sm border ${!filled ? "border-dashed border-slate-400/80" : "border-slate-300"} bg-slate-400/10`;
  const labelText = field.label || (field.type === "date" ? "DD/MM/YYYY" : "Type here");

  if (field.type === "text" || field.type === "date") {
    return (
      <input
        style={{ ...style, fontSize }}
        value={value?.value ?? ""}
        onChange={(e) => onText(e.target.value)}
        placeholder={field.required ? `${labelText} *` : `${labelText} — optional`}
        title={field.required ? `${labelText} (required)` : `${labelText} (optional)`}
        className={`${base} px-1 text-slate-900 ${field.required ? "placeholder:text-[#937224]/50" : "placeholder:text-slate-400 placeholder:italic"} focus:outline-none focus:ring-2 focus:ring-[#C9A43E]`}
      />
    );
  }
  if (field.type === "checkbox") {
    return (
      <button style={style} onClick={onToggle} className={`${base} flex items-center justify-center`} title={`${field.label || "Tick"}${field.required ? " (required)" : " (optional)"}`}>
        {value?.value === "true" && <CheckCircle2 className="w-4 h-4 text-[#937224]" />}
      </button>
    );
  }
  // signature / initials
  return (
    <button style={style} onClick={onSign} className={`${base} flex items-center justify-center overflow-hidden`} title={field.label || "Sign here"}>
      {value?.valueImage ? (
        <img src={value.valueImage} alt="signature" className="max-h-full max-w-full object-contain" />
      ) : value?.value ? (
        <span style={{ fontFamily: "'Brush Script MT', cursive" }} className="text-slate-900 truncate px-1 leading-none" >{value.value}</span>
      ) : (
        <span className="text-[10px] font-semibold text-[#937224] uppercase tracking-wide">{field.type === "initials" ? "Initials" : "Sign"}</span>
      )}
    </button>
  );
}

function AdoptModal({ name, onName, image, onImage, onClose }: {
  name: string; onName: (v: string) => void; image: string | null; onImage: (v: string | null) => void; onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-md space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="font-semibold flex items-center gap-2"><PenLine className="w-4 h-4 text-[#C9A43E]" /> Adopt your signature</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
        </div>
        <div>
          <label className="text-xs text-slate-500">Full legal name</label>
          <input value={name} onChange={(e) => onName(e.target.value)} className="mt-1 w-full h-10 rounded-lg border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#C9A43E]/40" />
          {name.trim() && <div className="mt-2 px-3 py-2 rounded-lg bg-slate-50 border"><span style={{ fontFamily: "'Brush Script MT', cursive" }} className="text-2xl">{name}</span></div>}
        </div>
        <div>
          <label className="text-xs text-slate-500">Or draw it</label>
          <div className="mt-1"><SignaturePad onChange={onImage} height={150} /></div>
        </div>
        <button onClick={onClose} className="w-full h-10 rounded-xl bg-[#C9A43E] hover:bg-[#b8942f] text-slate-900 font-bold text-sm">Adopt &amp; use</button>
      </div>
    </div>
  );
}
