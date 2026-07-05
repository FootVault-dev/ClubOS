// Public signing page for an OFC Payables Declaration (Document F.05) — one
// player / staff member confirms, on a branded page, that the club has paid
// their contractual obligations. No login. Legal basis: Contract and Commercial
// Law Act 2017 (Part 4).
//
// All subcomponents are MODULE scope — never define a component inside another
// (it remounts the tree: mobile keyboard closes per keystroke, signature canvas
// wipes). Hard-won on sign.tsx / sign-native.tsx.
import { useEffect, useState, type ReactNode } from "react";
import { useRoute } from "wouter";
import { SignaturePad } from "@/components/signature-pad";
import { Loader2, CheckCircle2, ShieldCheck, AlertTriangle, Lock } from "lucide-react";

const FONT = "'Inter Tight', Inter, system-ui, -apple-system, sans-serif";

interface Brand { orgLabel: string; accent: string; accentDeep: string; logoUrl: string | null }
interface DeclData {
  signatory: { name: string; group: "player" | "staff"; roleTitle: string | null; status: string; signedAt: string | null };
  title: string; criterion: string; clubName: string; season: string | null; asOfLabel: string | null;
  statement: string; brand: Brand;
}

const DEFAULT_BRAND: Brand = { orgLabel: "South Island United", accent: "#C59949", accentDeep: "#937224", logoUrl: null };

// ── page chrome ─────────────────────────────────────────────────────────────
function Shell({ brand, children }: { brand: Brand; children: ReactNode }) {
  return (
    <div className="min-h-screen w-full" style={{ background: "#f6f4ee", color: "#1a1712", fontFamily: FONT }}>
      <div className="h-1.5 w-full" style={{ background: `linear-gradient(90deg, ${brand.accentDeep}, ${brand.accent}, ${brand.accentDeep})` }} />
      <div className="max-w-xl mx-auto px-4 sm:px-6">{children}</div>
      <footer className="max-w-xl mx-auto px-4 sm:px-6 pb-10 pt-4 text-center text-[11px]" style={{ color: "#8d8774" }}>
        <Lock className="w-3 h-3 inline-block mr-1 -mt-0.5" />
        Secure electronic signing · Legally valid under the Contract and Commercial Law Act 2017 (NZ) · {brand.orgLabel}
      </footer>
    </div>
  );
}

function BrandHeader({ brand, chipLabel }: { brand: Brand; chipLabel: string }) {
  return (
    <div className="text-center pt-9 pb-5">
      {brand.logoUrl && <img src={brand.logoUrl} alt={brand.orgLabel} className="w-14 h-14 mx-auto mb-3 object-contain" />}
      <div className="text-[11px] font-bold tracking-[0.18em]" style={{ color: brand.accentDeep }}>{brand.orgLabel.toUpperCase()}</div>
      <div className="inline-block mt-2 px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wide"
        style={{ background: "#171512", color: brand.accent }}>
        {chipLabel}
      </div>
    </div>
  );
}

function StateCard({ brand, icon, title, sub }: { brand: Brand; icon: ReactNode; title: string; sub?: string }) {
  return (
    <Shell brand={brand}>
      <div className="py-24 text-center">
        {brand.logoUrl && <img src={brand.logoUrl} alt={brand.orgLabel} className="w-16 h-16 mx-auto mb-6 object-contain" />}
        <div className="mx-auto mb-4 flex justify-center">{icon}</div>
        <h1 className="text-xl font-bold">{title}</h1>
        {sub && <p className="mt-2 text-sm" style={{ color: "#6b6559" }}>{sub}</p>}
      </div>
    </Shell>
  );
}

// Draw → Confirm → locked preview + Redo. The committed value only reaches the
// parent on confirm, so the signer always SEES what was captured.
function SignatureBox({ brand, value, onChange }: { brand: Brand; value: string | null; onChange: (v: string | null) => void }) {
  const [pending, setPending] = useState<string | null>(null);
  if (value) {
    return (
      <div>
        <div className="rounded-xl border bg-white flex items-center justify-center overflow-hidden" style={{ borderColor: "#cfc7b2", height: 160 }}>
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
      <SignaturePad onChange={setPending} height={160} />
      <button
        type="button"
        disabled={!pending}
        onClick={() => pending && onChange(pending)}
        className="mt-2 w-full h-12 rounded-xl font-bold text-[15px] transition-opacity disabled:opacity-40"
        style={{ background: pending ? brand.accent : "#e8e1cf", color: "#17150e" }}
      >
        {pending ? "Confirm signature" : "Draw your signature above, then confirm"}
      </button>
    </div>
  );
}

// ── main ────────────────────────────────────────────────────────────────────
export default function SignDeclaration() {
  const [, params] = useRoute("/declaration/:token");
  const token = params?.token ?? "";

  const [data, setData] = useState<DeclData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [typed, setTyped] = useState("");
  const [sig, setSig] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/declaration/${token}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) { setLoadError(json.message || "This signing link is not valid."); }
        else { setData(json); if (json.signatory?.name) setTyped(json.signatory.name); }
      } catch {
        if (!cancelled) setLoadError("Couldn't load this page. Please check your connection and try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const brand = data?.brand || DEFAULT_BRAND;

  if (loading) return <StateCard brand={DEFAULT_BRAND} icon={<Loader2 className="w-8 h-8 animate-spin" style={{ color: "#C59949" }} />} title="Loading…" />;
  if (loadError) return <StateCard brand={DEFAULT_BRAND} icon={<AlertTriangle className="w-10 h-10" style={{ color: "#c2410c" }} />} title="Link not available" sub={loadError} />;
  if (!data) return <StateCard brand={DEFAULT_BRAND} icon={<AlertTriangle className="w-10 h-10" style={{ color: "#c2410c" }} />} title="Something went wrong" />;

  if (done || data.signatory.status === "signed") {
    return (
      <StateCard brand={brand}
        icon={<CheckCircle2 className="w-14 h-14" style={{ color: "#2e7d4f" }} />}
        title="Thank you — you're confirmed"
        sub={`Your electronic confirmation for ${data.clubName} has been recorded. There's nothing more to do.`} />
    );
  }

  const canSign = consent && typed.trim().length >= 2 && !!sig && !submitting;

  const submit = async () => {
    if (!canSign) return;
    setSubmitting(true); setError(null);
    try {
      const res = await fetch(`/api/declaration/${token}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true, signatureName: typed.trim(), signatureImage: sig }),
      });
      const json = await res.json();
      if (!res.ok) setError(json.message || "Could not record your signature. Please try again.");
      else setDone(true);
    } catch {
      setError("Something went wrong while signing. Please try again.");
    } finally { setSubmitting(false); }
  };

  const isStaff = data.signatory.group === "staff";
  // Player wording per Ryan (2026-07-05): brand-name framing ("South Island United")
  // + "for our financial records", dropping the "OFC licensing" mention so it can't
  // read as leverage. The boxed statement (names CUFC Inc, the legal applicant) is
  // unchanged. Staff kept exactly as-is per his instruction.
  const introLine = isStaff
    ? `As a member of club staff of ${data.clubName}, please confirm the statement below for the club’s OFC licensing.`
    : "As a player of South Island United, and for our financial records, please confirm the statement below:";
  const chipLabel = isStaff ? `OFC CLUB LICENSING · DOCUMENT ${data.criterion}` : "PAYMENT CONFIRMATION";

  return (
    <Shell brand={brand}>
      <BrandHeader brand={brand} chipLabel={chipLabel} />

      <div className="rounded-2xl bg-white border shadow-sm p-5 sm:p-6 mb-4" style={{ borderColor: "#e7e1d2" }}>
        <p className="text-[15px]">Kia ora <span className="font-bold">{data.signatory.name}</span>,</p>
        <p className="text-[14px] mt-2 leading-relaxed" style={{ color: "#4a4539" }}>
          {introLine}
        </p>

        <div className="mt-4 rounded-xl p-4 text-[14.5px] leading-relaxed" style={{ background: "#faf7ef", border: "1px solid #ece4d0", color: "#2a271f" }}>
          {data.statement}
        </div>
        {(data.season || data.asOfLabel) && (
          <div className="mt-2 text-[12px]" style={{ color: "#8d8774" }}>
            {data.season ? `Season ${data.season}` : ""}{data.season && data.asOfLabel ? "  ·  " : ""}{data.asOfLabel ? `Paid up to ${data.asOfLabel}` : ""}
          </div>
        )}
      </div>

      <div className="rounded-2xl bg-white border shadow-sm p-5 sm:p-6 mb-4" style={{ borderColor: "#e7e1d2" }}>
        <label className="block text-[12px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: "#8d8774" }}>Your full name</label>
        <input
          value={typed} onChange={(e) => setTyped(e.target.value)}
          placeholder="Type your full name"
          className="w-full h-12 px-3.5 rounded-xl border text-[15px] focus:outline-none"
          style={{ borderColor: "#d8d0bd", background: "#fff", color: "#1a1712" }}
        />

        <div className="mt-4">
          <label className="block text-[12px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: "#8d8774" }}>Signature</label>
          <SignatureBox brand={brand} value={sig} onChange={setSig} />
        </div>

        <label className="flex items-start gap-2.5 mt-5 cursor-pointer">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 w-5 h-5" style={{ accentColor: brand.accent }} />
          <span className="text-[13.5px] leading-snug" style={{ color: "#4a4539" }}>
            I confirm the statement above is true, and I agree to sign this declaration electronically.
          </span>
        </label>

        {error && (
          <div className="mt-4 flex items-start gap-2 text-[13px] rounded-lg p-3" style={{ background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca" }}>
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <button
          onClick={submit} disabled={!canSign}
          className="mt-5 w-full h-13 rounded-xl font-bold text-[16px] inline-flex items-center justify-center gap-2 transition-opacity disabled:opacity-40"
          style={{ height: 52, background: brand.accent, color: "#17150e" }}
        >
          {submitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <ShieldCheck className="w-5 h-5" />}
          Confirm &amp; sign
        </button>
        <p className="mt-3 text-center text-[11.5px]" style={{ color: "#a39d8c" }}>
          Takes a few seconds · legally valid under the Contract and Commercial Law Act 2017 (NZ)
        </p>
      </div>
    </Shell>
  );
}
