// Public signing page — /sign/:token. No login, no admin chrome. The signer
// reviews the PDF, types + draws their signature, consents, and signs. On the
// final signer, the server generates the completed PDF + certificate and emails
// all parties. Legal basis: Contract and Commercial Law Act 2017 (Part 4).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRoute } from "wouter";
import { SignaturePad } from "@/components/signature-pad";
import { Loader2, CheckCircle2, FileText, ShieldCheck, AlertTriangle } from "lucide-react";

interface SignData {
  documentStatus: string;
  title: string;
  message: string | null;
  orgName: string;
  signer: { name: string; email: string; status: string };
  parties: { name: string; status: string }[];
}

export default function SignPage() {
  const [, params] = useRoute("/sign/:token");
  const token = params?.token ?? "";

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<SignData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [typedName, setTypedName] = useState("");
  const [sigImage, setSigImage] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<null | { allComplete: boolean }>(null);
  const [declined, setDeclined] = useState(false);
  const [showDecline, setShowDecline] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const signPanel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/sign/${token}`);
        const json = await res.json();
        if (!active) return;
        if (!res.ok) { setError(json.message || "This signing link is invalid."); }
        else { setData(json); setTypedName(json.signer?.name ?? ""); }
      } catch {
        if (active) setError("Could not load this document. Please try again.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [token]);

  const submit = async () => {
    if (!typedName.trim() || !consent) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/sign/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signatureName: typedName.trim(), signatureImage: sigImage, consent: true }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.message || "Could not record your signature."); }
      else { setDone({ allComplete: !!json.allComplete }); }
    } catch {
      setError("Something went wrong while signing. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const decline = async () => {
    setSubmitting(true);
    try {
      await fetch(`/api/sign/${token}/decline`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: declineReason.trim() || null }),
      });
      setDeclined(true);
    } finally { setSubmitting(false); }
  };

  // ── Shell ──
  const Shell = ({ children }: { children: ReactNode }) => (
    <div className="min-h-screen bg-[#f4f2ec] text-slate-900">
      <div className="h-1.5 bg-gradient-to-r from-[#937224] via-[#C9A43E] to-[#E4C56A]" />
      <div className="max-w-5xl mx-auto px-4 py-6 md:py-10">{children}</div>
      <footer className="max-w-5xl mx-auto px-4 pb-10 text-xs text-slate-400 text-center">
        Secure electronic signing · Powered by ClubOS e-Sign · Valid under the Contract and Commercial Law Act 2017 (NZ)
      </footer>
    </div>
  );

  if (loading) return <Shell><div className="py-32 text-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" />Loading document…</div></Shell>;

  if (error && !data) return (
    <Shell><div className="bg-white rounded-2xl border p-10 text-center max-w-md mx-auto mt-10">
      <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto mb-3" />
      <h1 className="text-lg font-semibold">Link unavailable</h1>
      <p className="text-slate-500 mt-1 text-sm">{error}</p>
    </div></Shell>
  );

  if (declined) return (
    <Shell><div className="bg-white rounded-2xl border p-10 text-center max-w-md mx-auto mt-10">
      <h1 className="text-lg font-semibold">Signing declined</h1>
      <p className="text-slate-500 mt-1 text-sm">We've let the sender know you declined to sign “{data?.title}”.</p>
    </div></Shell>
  );

  if (done) return (
    <Shell><div className="bg-white rounded-2xl border p-10 text-center max-w-md mx-auto mt-10">
      <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
      <h1 className="text-xl font-bold">Signed — thank you, {data?.signer.name}</h1>
      <p className="text-slate-500 mt-2 text-sm">
        {done.allComplete
          ? "All parties have now signed. A copy of the completed document is on its way to your inbox."
          : "Your signature has been recorded. You'll receive a copy once everyone has signed."}
      </p>
    </div></Shell>
  );

  if (!data) return null;

  if (data.documentStatus === "voided") return (
    <Shell><div className="bg-white rounded-2xl border p-10 text-center max-w-md mx-auto mt-10">
      <AlertTriangle className="w-8 h-8 text-slate-400 mx-auto mb-3" />
      <h1 className="text-lg font-semibold">No longer available</h1>
      <p className="text-slate-500 mt-1 text-sm">This document has been voided by the sender.</p>
    </div></Shell>
  );

  const alreadySigned = data.signer.status === "signed";

  return (
    <Shell>
      <div className="mb-5">
        <div className="text-xs uppercase tracking-widest text-[#937224] font-semibold">{data.orgName}</div>
        <h1 className="text-2xl font-bold mt-1 flex items-center gap-2"><FileText className="w-6 h-6 text-[#C9A43E]" /> {data.title}</h1>
        {data.message && <p className="text-slate-500 italic mt-1 text-sm border-l-2 border-[#C9A43E] pl-3">“{data.message}”</p>}
        <p className="text-sm text-slate-500 mt-2">Signing as <strong className="text-slate-700">{data.signer.name}</strong> ({data.signer.email})</p>
      </div>

      <div className="grid lg:grid-cols-[1fr_360px] gap-5 items-start">
        {/* Document */}
        <div className="bg-white rounded-2xl border overflow-hidden shadow-sm">
          <object data={`/api/sign/${token}/document.pdf`} type="application/pdf" className="w-full" style={{ height: "70vh", minHeight: 480 }}>
            <div className="p-8 text-center text-sm text-slate-500">
              Can't preview the PDF here. <a className="text-[#937224] underline" href={`/api/sign/${token}/document.pdf`} target="_blank" rel="noreferrer">Open it in a new tab</a>.
            </div>
          </object>
        </div>

        {/* Sign panel */}
        <div ref={signPanel} className="bg-white rounded-2xl border p-5 shadow-sm lg:sticky lg:top-6 space-y-4">
          {alreadySigned ? (
            <div className="text-center py-6">
              <CheckCircle2 className="w-9 h-9 text-emerald-500 mx-auto mb-2" />
              <div className="font-semibold">You've already signed</div>
              <p className="text-sm text-slate-500 mt-1">Thanks — nothing more to do.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="w-4 h-4 text-[#C9A43E]" /> Adopt your signature</div>

              <div>
                <label className="text-xs text-slate-500">Full legal name</label>
                <input
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                  placeholder="Your full name"
                  className="mt-1 w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#C9A43E]/40"
                />
                {typedName.trim() && (
                  <div className="mt-2 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200">
                    <span style={{ fontFamily: "'Brush Script MT', cursive" }} className="text-2xl text-slate-800">{typedName}</span>
                  </div>
                )}
              </div>

              <div>
                <label className="text-xs text-slate-500">Draw your signature (optional)</label>
                <div className="mt-1"><SignaturePad onChange={setSigImage} height={150} /></div>
              </div>

              <label className="flex items-start gap-2 text-xs text-slate-600 cursor-pointer">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 accent-[#C9A43E]" />
                <span>I agree to sign this document electronically and that my electronic signature is legally binding, under the Contract and Commercial Law Act 2017.</span>
              </label>

              {error && <p className="text-xs text-red-500">{error}</p>}

              <button
                onClick={submit}
                disabled={!typedName.trim() || !consent || submitting}
                className="w-full h-11 rounded-xl bg-[#C9A43E] hover:bg-[#b8942f] disabled:opacity-50 text-slate-900 font-bold text-sm transition-colors flex items-center justify-center gap-2"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Sign document
              </button>

              {!showDecline ? (
                <button onClick={() => setShowDecline(true)} className="w-full text-xs text-slate-400 hover:text-slate-600">Decline to sign</button>
              ) : (
                <div className="space-y-2 border-t pt-3">
                  <input value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder="Reason (optional)" className="w-full h-9 rounded-lg border border-slate-300 px-3 text-sm" />
                  <div className="flex gap-2">
                    <button onClick={() => setShowDecline(false)} className="flex-1 h-9 rounded-lg border text-sm">Cancel</button>
                    <button onClick={decline} disabled={submitting} className="flex-1 h-9 rounded-lg bg-red-500 text-white text-sm font-medium disabled:opacity-50">Confirm decline</button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Parties progress */}
          <div className="border-t pt-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1.5">Signers</div>
            {data.parties.map((p, i) => (
              <div key={i} className="flex items-center justify-between text-sm py-0.5">
                <span className="text-slate-600">{p.name}</span>
                <span className={p.status === "signed" ? "text-emerald-600 text-xs font-medium" : "text-slate-400 text-xs"}>
                  {p.status === "signed" ? "✓ Signed" : p.status === "declined" ? "Declined" : "Pending"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  );
}
