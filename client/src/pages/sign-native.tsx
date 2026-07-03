// e-Sign v2 — NATIVE signing experience. The agreement is a branded web page,
// not an embedded PDF: the signer reads the actual document, fills their
// details inline (they merge live into the agreement text), signs with finger
// or trackpad, and an under-18 date of birth automatically brings in the
// parent/guardian co-signature block. The archived PDF is typeset server-side
// from the same content JSON this page renders.
// Legal basis: Contract and Commercial Law Act 2017 (Part 4).
import { useMemo, useRef, useState, type ReactNode } from "react";
import { SignaturePad } from "@/components/signature-pad";
import { Loader2, CheckCircle2, ShieldCheck, AlertTriangle, X, Lock, Users } from "lucide-react";

interface ContentItem { kind: "p" | "bullet" | "numbered"; text: string }
interface ContentSection { heading: string; items: ContentItem[] }
interface NativeContent {
  docTitle: string;
  partiesIntro: string[];
  sections: ContentSection[];
  signAck: string;
  appendix?: { title: string; intro?: string; sections: { heading: string; items: ContentItem[] }[] };
}
interface FormField { key: string; label: string; type: string; required?: boolean; help?: string; placeholder?: string }
export interface NativePayload {
  brand: Record<string, any>;
  content: NativeContent;
  form: FormField[];
  settings: Record<string, any>;
  variables: Record<string, string>;
  role: "primary" | "counter";
  myFormData: Record<string, any> | null;
  primaryDetails: { name: string; email: string; formData: Record<string, any> | null; signatureImage: string | null; signedAt: string | null } | null;
}
export interface NativeSignData {
  documentStatus: string; title: string; message: string | null; orgName: string;
  signer: { name: string; email: string; status: string };
  parties: { name: string; status: string }[];
  native: NativePayload;
}

interface BrandTokens {
  bg: string; panel: string; border: string; gold: string; goldDeep: string;
  paper: string; ink: string; orgLabel: string; logoUrl: string | null;
}
const FONT = "'Inter Tight', Inter, system-ui, -apple-system, sans-serif";

// Page chrome — MODULE level so component identity is stable across renders.
// Defining these inside NativeSign remounted the whole tree on every state
// change: inputs lost focus (mobile keyboard closed after each character) and
// the signature canvas was wiped. Same bug sign.tsx fixed on 2026-07-03 —
// never define components inside a component.
function Shell({ B, children }: { B: BrandTokens; children: ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: B.bg, color: "#fff", fontFamily: FONT }}>
      <div className="h-1.5" style={{ background: `linear-gradient(90deg, ${B.goldDeep}, ${B.gold}, ${B.goldDeep})` }} />
      {children}
      <footer className="max-w-3xl mx-auto px-5 pb-10 pt-6 text-center text-[11px]" style={{ color: "rgba(255,255,255,0.32)" }}>
        <Lock className="w-3 h-3 inline-block mr-1 -mt-0.5" />
        Secure electronic signing · Legally valid under the Contract and Commercial Law Act 2017 (NZ) · {B.orgLabel} × ClubOS e-Sign
      </footer>
    </div>
  );
}

function StateCard({ B, icon, title, sub }: { B: BrandTokens; icon: ReactNode; title: string; sub?: string }) {
  return (
    <Shell B={B}>
      <div className="max-w-md mx-auto px-5 py-28 text-center">
        {B.logoUrl && <img src={B.logoUrl} alt={B.orgLabel} className="w-16 h-16 mx-auto mb-6 rounded-full" />}
        <div className="mx-auto mb-4">{icon}</div>
        <h1 className="text-xl font-bold">{title}</h1>
        {sub && <p className="mt-2 text-sm" style={{ color: "rgba(255,255,255,0.55)" }}>{sub}</p>}
      </div>
    </Shell>
  );
}

// Signature capture with an explicit confirm step: draw (multiple strokes
// fine) → "Confirm signature" → locked preview + Redo. The committed value
// only reaches the parent on confirm, so the signer always SEES what was
// captured — no more "I signed but the box looks blank".
function SignatureBox({ B, value, onChange, height = 170 }: {
  B: BrandTokens; value: string | null; onChange: (v: string | null) => void; height?: number;
}) {
  const [pending, setPending] = useState<string | null>(null);
  if (value) {
    return (
      <div>
        <div className="rounded-xl border bg-white flex items-center justify-center overflow-hidden" style={{ borderColor: "#cfc7b2", height }}>
          <img src={value} alt="Your signature" className="max-h-full max-w-full object-contain p-2" />
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-[12.5px] font-semibold inline-flex items-center gap-1.5" style={{ color: "#2e7d4f" }}>
            <CheckCircle2 className="w-4 h-4" /> Signature captured
          </span>
          <button type="button" onClick={() => { onChange(null); setPending(null); }} className="text-[12.5px] underline" style={{ color: "#8d8774" }}>
            Redo signature
          </button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <SignaturePad onChange={setPending} height={height} />
      <button
        type="button"
        disabled={!pending}
        onClick={() => pending && onChange(pending)}
        className="mt-2 w-full h-11 rounded-xl font-bold text-[14px] transition-opacity disabled:opacity-40"
        style={{ background: pending ? B.gold : "#e8e1cf", color: "#17150e" }}
      >
        {pending ? "Confirm signature" : "Draw your signature above, then confirm"}
      </button>
    </div>
  );
}

const ageFromDob = (iso: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const now = new Date();
  let age = now.getFullYear() - +m[1];
  if (now.getMonth() + 1 < +m[2] || (now.getMonth() + 1 === +m[2] && now.getDate() < +m[3])) age -= 1;
  return age >= 0 && age < 120 ? age : null;
};
const fmtDobNz = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return iso;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};

export function NativeSign({ token, data }: { token: string; data: NativeSignData }) {
  const n = data.native;
  const B: BrandTokens = {
    bg: n.brand?.bg || "#0a0a0a",
    panel: n.brand?.panel || "#141414",
    border: n.brand?.border || "#2a2a2a",
    gold: n.brand?.accent || "#d1b96e",
    goldDeep: n.brand?.accentDeep || "#a8915a",
    paper: n.brand?.paper || "#faf8f2",
    ink: n.brand?.ink || "#17150e",
    orgLabel: n.brand?.orgLabel || data.orgName,
    logoUrl: n.brand?.logoUrl || null,
  };
  const isPrimary = n.role === "primary";

  // form state (primary signer only)
  const [form, setForm] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const f of n.form) seed[f.key] = n.myFormData?.[f.key] ? String(n.myFormData[f.key]) : "";
    return seed;
  });
  const [sigImage, setSigImage] = useState<string | null>(null);
  const [guardianName, setGuardianName] = useState("");
  const [guardianRel, setGuardianRel] = useState("");
  const [guardianSig, setGuardianSig] = useState<string | null>(null);
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [agreeEsign, setAgreeEsign] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | { allComplete: boolean }>(null);
  const [declined, setDeclined] = useState(false);
  const [showDecline, setShowDecline] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const signRef = useRef<HTMLDivElement>(null);

  const dobField = n.form.find((f) => f.type === "dob");
  const dob = dobField ? form[dobField.key] : "";
  const age = dob ? ageFromDob(dob) : null;
  const needsGuardian = !!n.settings?.guardianUnder18 && isPrimary && age != null && age < 18;

  const nameField = n.form.find((f) => f.key === "referee_name") || n.form.find((f) => f.type === "text");
  const typedName = isPrimary ? (nameField ? form[nameField.key] : "") : data.signer.name;
  const [counterName, setCounterName] = useState(data.signer.name);
  const signatureName = isPrimary ? typedName : counterName;

  // live merge for {{key}} in agreement text
  const values = useMemo(() => {
    const v: Record<string, string> = { ...n.variables };
    const source = isPrimary ? form : (n.primaryDetails?.formData as Record<string, any>) || {};
    for (const f of n.form) {
      const raw = source[f.key];
      if (raw != null && String(raw).trim() !== "") v[f.key] = f.type === "dob" || f.type === "date" ? fmtDobNz(String(raw)) : String(raw);
    }
    return v;
  }, [n.variables, n.form, form, isPrimary, n.primaryDetails]);
  const subst = (text: string) =>
    text.split(/(\{\{\w+\}\})/g).map((part, i) => {
      const m = /^\{\{(\w+)\}\}$/.exec(part);
      if (!m) return <span key={i}>{part}</span>;
      const v = values[m[1]];
      return v ? (
        <span key={i} className="font-semibold" style={{ borderBottom: `2px solid ${B.gold}66` }}>{v}</span>
      ) : (
        <span key={i} className="inline-block min-w-[110px] align-baseline" style={{ borderBottom: "1.5px solid #b6b0a2" }}>&nbsp;</span>
      );
    });

  const requiredMissing = useMemo(() => {
    if (!isPrimary) return [] as string[];
    const missing: string[] = [];
    for (const f of n.form) if (f.required !== false && !String(form[f.key] || "").trim()) missing.push(f.label);
    if (needsGuardian) {
      if (!guardianName.trim()) missing.push("Guardian name");
      if (!guardianSig) missing.push("Guardian signature");
    }
    return missing;
  }, [isPrimary, n.form, form, needsGuardian, guardianName, guardianSig]);

  const totalSteps = (isPrimary ? n.form.filter((f) => f.required !== false).length + (needsGuardian ? 2 : 0) : 0) + 3; // + signature + 2 consents
  const doneSteps = totalSteps - requiredMissing.length - (sigImage ? 0 : 1) - (agreeTerms ? 0 : 1) - (agreeEsign ? 0 : 1);
  const canSign = requiredMissing.length === 0 && !!sigImage && agreeTerms && agreeEsign && !!signatureName.trim();

  const submit = async () => {
    if (!canSign || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, any> = { consent: true, signatureName: signatureName.trim(), signatureImage: sigImage };
      if (isPrimary) {
        body.formData = { ...form };
        if (needsGuardian) {
          body.formData.guardian_name = guardianName.trim();
          body.formData.guardian_relationship = guardianRel.trim();
          body.formData.guardian_signature = guardianSig;
        }
      }
      const res = await fetch(`/api/sign/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) setError(json.message || "Could not record your signature.");
      else setDone({ allComplete: !!json.allComplete });
    } catch {
      setError("Something went wrong while signing. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const decline = async () => {
    setSubmitting(true);
    try {
      await fetch(`/api/sign/${token}/decline`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: declineReason.trim() || null }) });
      setDeclined(true);
    } finally {
      setSubmitting(false);
    }
  };

  if (declined) return <StateCard B={B} icon={<X className="w-9 h-9 mx-auto" style={{ color: "rgba(255,255,255,0.4)" }} />} title="Signing declined" sub={`We've let ${B.orgLabel} know you declined to sign.`} />;
  if (done) return <StateCard B={B} icon={<CheckCircle2 className="w-11 h-11 mx-auto text-emerald-400" />} title={`Signed — thank you, ${signatureName.split(" ")[0] || data.signer.name}`} sub={done.allComplete ? "All parties have now signed. Your copy of the completed agreement is on its way to your inbox." : "Your signature has been recorded. You'll receive the completed agreement by email once it's counter-signed."} />;
  if (data.documentStatus === "voided") return <StateCard B={B} icon={<AlertTriangle className="w-9 h-9 mx-auto text-amber-400" />} title="No longer available" sub="This document has been voided by the sender." />;
  if (data.signer.status === "signed") return <StateCard B={B} icon={<CheckCircle2 className="w-10 h-10 mx-auto text-emerald-400" />} title="You've already signed" sub="Thanks — nothing more to do. Your copy will arrive by email once everyone has signed." />;

  const input = "w-full h-12 rounded-xl border bg-white px-3.5 text-[16px] outline-none transition-shadow focus:ring-2";
  const inputStyle = { borderColor: "#ddd6c6", color: B.ink, ["--tw-ring-color" as any]: `${B.gold}55` };

  return (
    <Shell B={B}>
      {/* Hero */}
      <header className="max-w-3xl mx-auto px-5 pt-10 pb-8 text-center">
        {B.logoUrl && <img src={B.logoUrl} alt={B.orgLabel} className="w-[76px] h-[76px] mx-auto mb-5 rounded-full" />}
        <div className="text-[11px] font-bold uppercase" style={{ color: B.gold, letterSpacing: "0.28em" }}>{B.orgLabel}</div>
        <h1 className="mt-2.5 text-[28px] md:text-4xl font-extrabold leading-tight">{n.content.docTitle}</h1>
        <p className="mt-3 text-sm" style={{ color: "rgba(255,255,255,0.55)" }}>
          Prepared for <span className="text-white font-semibold">{data.signer.name}</span> · takes about 3 minutes
        </p>
        {data.message && (
          <p className="mt-4 mx-auto max-w-md text-sm italic rounded-xl px-4 py-3" style={{ background: B.panel, border: `1px solid ${B.border}`, color: "rgba(255,255,255,0.7)" }}>
            “{data.message}”
          </p>
        )}
        <div className="mt-5 flex items-center justify-center gap-2 flex-wrap">
          {data.parties.map((p, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 text-[11px] font-medium rounded-full px-3 py-1.5" style={{ background: B.panel, border: `1px solid ${B.border}`, color: p.status === "signed" ? "#6ee7b7" : "rgba(255,255,255,0.6)" }}>
              {p.status === "signed" ? <CheckCircle2 className="w-3 h-3" /> : <Users className="w-3 h-3" />}
              {p.name}{p.status === "signed" ? " · signed" : ""}
            </span>
          ))}
        </div>
      </header>

      {/* The document */}
      <main className="max-w-3xl mx-auto px-3 md:px-5 pb-44">
        <article className="rounded-3xl shadow-2xl overflow-hidden" style={{ background: B.paper, color: B.ink }}>
          <div className="h-2" style={{ background: `linear-gradient(90deg, ${B.goldDeep}, ${B.gold})` }} />
          <div className="px-5 py-8 md:px-12 md:py-12">

            {/* Parties */}
            <div className="space-y-2 text-[15px] leading-relaxed">
              {n.content.partiesIntro.map((line, i) => <p key={i}>{subst(line)}</p>)}
            </div>

            {/* Sections */}
            {n.content.sections.map((sec, si) => (
              <section key={si} className="mt-9">
                <div className="w-6 h-1 rounded-full mb-2.5" style={{ background: B.gold }} />
                <h2 className="text-[17px] font-bold mb-3">{sec.heading}</h2>
                <SectionItems items={sec.items} subst={subst} gold={B.goldDeep} />
              </section>
            ))}

            {/* Your details — the form lives inside the document */}
            <section className="mt-10">
              <div className="w-6 h-1 rounded-full mb-2.5" style={{ background: B.gold }} />
              <h2 className="text-[17px] font-bold">Referee Details</h2>
              {isPrimary ? (
                <>
                  <p className="text-[13px] mt-1 mb-4" style={{ color: "#75705f" }}>Fill these in — they become part of the signed agreement.</p>
                  <div className="grid md:grid-cols-2 gap-4">
                    {n.form.map((f) => (
                      <div key={f.key} className={f.type === "address" ? "md:col-span-2" : ""}>
                        <label className="block text-[12px] font-semibold mb-1.5" style={{ color: "#5c5748" }}>
                          {f.label}{f.required !== false && <span style={{ color: B.goldDeep }}> *</span>}
                        </label>
                        <input
                          type={f.type === "dob" || f.type === "date" ? "date" : f.type === "phone" ? "tel" : "text"}
                          inputMode={f.type === "bank" ? "numeric" : undefined}
                          value={form[f.key] || ""}
                          onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
                          placeholder={f.placeholder || ""}
                          className={input}
                          style={inputStyle}
                        />
                        {f.help && <p className="text-[11px] mt-1" style={{ color: "#8d8774" }}>{f.help}</p>}
                      </div>
                    ))}
                    <div>
                      <label className="block text-[12px] font-semibold mb-1.5" style={{ color: "#5c5748" }}>Email</label>
                      <div className="h-12 rounded-xl border flex items-center px-3.5 text-[15px]" style={{ borderColor: "#e4ddcc", background: "#f3efe3", color: "#6d6857" }}>
                        {data.signer.email}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="mt-4 grid md:grid-cols-2 gap-x-8 gap-y-3">
                  {n.form.map((f) => {
                    const v = n.primaryDetails?.formData?.[f.key];
                    return (
                      <div key={f.key} className="flex items-baseline justify-between gap-4 border-b pb-2" style={{ borderColor: "#eae4d3" }}>
                        <span className="text-[12px] font-semibold" style={{ color: "#75705f" }}>{f.label}</span>
                        <span className="text-[14px] font-medium text-right">{v ? (f.type === "dob" || f.type === "date" ? fmtDobNz(String(v)) : String(v)) : "—"}</span>
                      </div>
                    );
                  })}
                  <div className="flex items-baseline justify-between gap-4 border-b pb-2" style={{ borderColor: "#eae4d3" }}>
                    <span className="text-[12px] font-semibold" style={{ color: "#75705f" }}>Email</span>
                    <span className="text-[14px] font-medium text-right">{n.primaryDetails?.email}</span>
                  </div>
                </div>
              )}
            </section>

            {/* Guardian block — appears automatically for under-18s */}
            {isPrimary && needsGuardian && (
              <section className="mt-8 rounded-2xl p-5 md:p-6" style={{ background: "#f5efdd", border: `1.5px solid ${B.gold}` }}>
                <h3 className="text-[15px] font-bold flex items-center gap-2">
                  <ShieldCheck className="w-4.5 h-4.5" style={{ color: B.goldDeep }} />
                  Parent / guardian co-signature
                </h3>
                <p className="text-[13px] mt-1.5 leading-relaxed" style={{ color: "#6d6650" }}>
                  Because you're {age}, a parent or legal guardian needs to co-sign. Pass the device over when you get to the signature below —
                  they're agreeing: <em>“As parent/legal guardian of the Referee, I consent to the Referee entering into this Agreement on the terms above.”</em>
                </p>
                <div className="grid md:grid-cols-2 gap-4 mt-4">
                  <div>
                    <label className="block text-[12px] font-semibold mb-1.5" style={{ color: "#5c5748" }}>Guardian full name <span style={{ color: B.goldDeep }}>*</span></label>
                    <input value={guardianName} onChange={(e) => setGuardianName(e.target.value)} className={input} style={inputStyle} />
                  </div>
                  <div>
                    <label className="block text-[12px] font-semibold mb-1.5" style={{ color: "#5c5748" }}>Relationship to you</label>
                    <input value={guardianRel} onChange={(e) => setGuardianRel(e.target.value)} placeholder="e.g. Mother, Father, Legal guardian" className={input} style={inputStyle} />
                  </div>
                </div>
                <div className="mt-4">
                  <label className="block text-[12px] font-semibold mb-1.5" style={{ color: "#5c5748" }}>Guardian signature <span style={{ color: B.goldDeep }}>*</span></label>
                  <SignatureBox B={B} value={guardianSig} onChange={setGuardianSig} height={140} />
                </div>
              </section>
            )}

            {/* Advice notice */}
            {n.settings?.adviceNotice && (
              <div className="mt-8 rounded-2xl px-5 py-4 text-[13px] leading-relaxed flex gap-3 items-start" style={{ background: "#f1ece0", color: "#6d6650" }}>
                <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" style={{ color: B.goldDeep }} />
                <span>{n.settings.adviceNotice}</span>
              </div>
            )}

            {/* Signatures */}
            <section className="mt-10" ref={signRef}>
              <div className="w-6 h-1 rounded-full mb-2.5" style={{ background: B.gold }} />
              <h2 className="text-[17px] font-bold mb-1.5">Signatures</h2>
              <p className="text-[13px] mb-5" style={{ color: "#75705f" }}>{subst(n.content.signAck)}</p>

              {/* Counter-party block */}
              <div className="rounded-2xl border p-5 mb-4" style={{ borderColor: "#e4ddcc", background: "#fbf9f2" }}>
                <div className="text-[10.5px] font-bold uppercase tracking-[0.18em]" style={{ color: B.goldDeep }}>
                  {isPrimary ? (n.settings?.counterSignerRole || "The League") : (n.settings?.primarySignerRole || "The Referee")}
                </div>
                {isPrimary ? (
                  <p className="text-[13px] mt-2" style={{ color: "#8d8774" }}>
                    Counter-signed by {B.orgLabel} after you sign — you'll be emailed the completed agreement.
                  </p>
                ) : (
                  <div className="mt-2 flex items-end justify-between gap-4">
                    <div>
                      <div className="text-[15px] font-bold">{n.primaryDetails?.name}</div>
                      {n.primaryDetails?.signedAt && (
                        <div className="text-[12px] mt-0.5" style={{ color: "#8d8774" }}>
                          Signed {new Date(n.primaryDetails.signedAt).toLocaleString("en-NZ", { dateStyle: "long", timeStyle: "short" })}
                        </div>
                      )}
                    </div>
                    {n.primaryDetails?.signatureImage && <img src={n.primaryDetails.signatureImage} alt="signature" className="h-12 object-contain" />}
                  </div>
                )}
              </div>

              {/* My signature */}
              <div className="rounded-2xl p-5 md:p-6" style={{ border: `1.5px solid ${B.gold}`, background: "#fffdf6" }}>
                <div className="text-[10.5px] font-bold uppercase tracking-[0.18em]" style={{ color: B.goldDeep }}>
                  {isPrimary ? (n.settings?.primarySignerRole || "The Referee") : (n.settings?.counterSignerRole || "The League")} — sign here
                </div>
                {!isPrimary && (
                  <div className="mt-3">
                    <label className="block text-[12px] font-semibold mb-1.5" style={{ color: "#5c5748" }}>Full legal name</label>
                    <input value={counterName} onChange={(e) => setCounterName(e.target.value)} className={input} style={inputStyle} />
                  </div>
                )}
                {isPrimary && (
                  <p className="text-[13px] mt-2 mb-1" style={{ color: "#8d8774" }}>
                    Signing as <span className="font-semibold" style={{ color: B.ink }}>{typedName.trim() || "— fill in your full legal name above —"}</span>
                  </p>
                )}
                <div className="mt-3">
                  <label className="block text-[12px] font-semibold mb-1.5" style={{ color: "#5c5748" }}>
                    Draw your signature — finger on your phone, mouse or trackpad on a computer <span style={{ color: B.goldDeep }}>*</span>
                  </label>
                  <SignatureBox B={B} value={sigImage} onChange={setSigImage} height={170} />
                </div>
              </div>
            </section>

            {/* Appendix */}
            {n.content.appendix && (
              <section className="mt-12 pt-8" style={{ borderTop: `2px solid ${B.gold}44` }}>
                <div className="text-[10.5px] font-bold uppercase tracking-[0.22em] mb-1.5" style={{ color: B.goldDeep }}>Forms part of this agreement</div>
                <h2 className="text-[19px] font-extrabold">{n.content.appendix.title}</h2>
                {n.content.appendix.intro && <p className="text-[14px] mt-2.5 leading-relaxed" style={{ color: "#5c5748" }}>{subst(n.content.appendix.intro)}</p>}
                {n.content.appendix.sections.map((sec, i) => (
                  <div key={i} className="mt-6">
                    <h3 className="text-[15px] font-bold mb-2.5">{sec.heading}</h3>
                    <SectionItems items={sec.items} subst={subst} gold={B.goldDeep} />
                  </div>
                ))}
              </section>
            )}
          </div>
        </article>

        {/* Consents */}
        <div className="mt-6 rounded-2xl p-5 space-y-3.5" style={{ background: B.panel, border: `1px solid ${B.border}` }}>
          <label className="flex items-start gap-3 cursor-pointer text-[13.5px] leading-relaxed" style={{ color: "rgba(255,255,255,0.78)" }}>
            <input type="checkbox" checked={agreeTerms} onChange={(e) => setAgreeTerms(e.target.checked)} className="mt-1 w-4.5 h-4.5 shrink-0" style={{ accentColor: B.gold }} />
            <span>I have read and agree to the {n.content.docTitle}{n.content.appendix ? `, including the ${n.content.appendix.title.replace(/^Appendix A — /, "")}` : ""}.</span>
          </label>
          <label className="flex items-start gap-3 cursor-pointer text-[13.5px] leading-relaxed" style={{ color: "rgba(255,255,255,0.78)" }}>
            <input type="checkbox" checked={agreeEsign} onChange={(e) => setAgreeEsign(e.target.checked)} className="mt-1 w-4.5 h-4.5 shrink-0" style={{ accentColor: B.gold }} />
            <span>I agree to sign electronically and that my electronic signature is legally binding under the Contract and Commercial Law Act 2017 (NZ).</span>
          </label>
        </div>
      </main>

      {/* Sticky sign bar */}
      <div className="fixed bottom-0 inset-x-0 z-40" style={{ background: "rgba(8,8,8,0.92)", backdropFilter: "blur(14px)", borderTop: `1px solid ${B.border}` }}>
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-white">{Math.max(doneSteps, 0)}/{totalSteps} complete</div>
            <div className="w-24 md:w-36 h-1.5 rounded-full overflow-hidden mt-1" style={{ background: "rgba(255,255,255,0.12)" }}>
              <div className="h-full rounded-full transition-all duration-300" style={{ width: `${Math.max(0, Math.min(100, (doneSteps / totalSteps) * 100))}%`, background: B.gold }} />
            </div>
          </div>
          {error && <span className="text-[11.5px] leading-tight" style={{ color: "#f0564f" }}>{error}</span>}
          <div className="ml-auto flex items-center gap-2.5 shrink-0">
            {!showDecline ? (
              <button onClick={() => setShowDecline(true)} className="text-[12px]" style={{ color: "rgba(255,255,255,0.4)" }}>Decline</button>
            ) : (
              <>
                <input value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder="Reason (optional)" className="h-10 w-28 md:w-40 rounded-lg px-2.5 text-[13px] text-white" style={{ background: B.panel, border: `1px solid ${B.border}` }} />
                <button onClick={decline} disabled={submitting} className="h-10 px-3 rounded-lg text-[13px] font-semibold text-white" style={{ background: "#c0392b" }}>Confirm</button>
              </>
            )}
            <button
              onClick={submit}
              disabled={!canSign || submitting}
              className="h-12 px-6 rounded-xl font-extrabold text-[14.5px] inline-flex items-center gap-2 transition-opacity"
              style={{ background: canSign ? B.gold : "rgba(255,255,255,0.12)", color: canSign ? "#0a0a0a" : "rgba(255,255,255,0.35)" }}
            >
              {submitting ? <Loader2 className="w-4.5 h-4.5 animate-spin" /> : <CheckCircle2 className="w-4.5 h-4.5" />}
              Sign agreement
            </button>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function SectionItems({ items, subst, gold }: { items: ContentItem[]; subst: (t: string) => React.ReactNode; gold: string }) {
  let num = 0;
  return (
    <div className="space-y-2.5 text-[14.5px] leading-[1.65]">
      {items.map((item, i) => {
        if (item.kind === "bullet")
          return (
            <div key={i} className="flex gap-3">
              <span className="mt-[9px] w-1.5 h-1.5 rounded-full shrink-0" style={{ background: gold }} />
              <p>{subst(item.text)}</p>
            </div>
          );
        if (item.kind === "numbered") {
          num += 1;
          return (
            <div key={i} className="flex gap-3">
              <span className="font-bold shrink-0 w-5 text-right" style={{ color: gold }}>{num}.</span>
              <p>{subst(item.text)}</p>
            </div>
          );
        }
        return <p key={i}>{subst(item.text)}</p>;
      })}
    </div>
  );
}
