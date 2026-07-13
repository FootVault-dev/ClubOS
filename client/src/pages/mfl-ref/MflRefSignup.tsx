// MFL referee sign-up — /mfl-ref/signup. Cloned from
// client/src/pages/ref/RefSignup.tsx (the CIC referee app). A proper,
// shareable LANDING PAGE for prospective referees (Daniel sends this link
// directly), not just a bare form: hero → what the role involves → trust
// bullets → sign-up card → footer note on approval. The submit flow itself
// mirrors CIC — an MFL coordinator approves every sign-up before the referee
// can log in and score (server/mfl-referee-routes.ts — POST
// /api/public/mfl-referees/signup always creates a 'pending' row). No token
// is issued here.
import { useState, type FormEvent, type ReactNode } from "react";
import { useLocation } from "wouter";
import { CheckCircle2, Loader2, ShieldCheck, Smartphone, Sparkles, Trophy, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { refPost, RefApiError, formatBankAccountInput } from "./mfl-ref-api";
import { useMflBrand } from "./useMflBrand";

const GOLD = "#d1b96e";
const INK = "#000000";
const PANEL = "#141414";

const FONT_STYLE = `
  .mfl-ref-display { font-family: 'Anton', 'Inter Tight', 'Inter', sans-serif; }
  .mfl-ref-body { font-family: 'Inter Tight', 'Inter', sans-serif; }
`;

const fieldClass =
  "h-12 text-base rounded-xl bg-white/5 border-white/10 text-white placeholder:text-white/30 focus-visible:ring-[#d1b96e] focus-visible:ring-offset-0";
const textareaClass =
  "min-h-[76px] text-base rounded-xl bg-white/5 border-white/10 text-white placeholder:text-white/30 focus-visible:ring-[#d1b96e] focus-visible:ring-offset-0";

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div>
      <label
        className="block text-xs font-semibold uppercase tracking-wide mb-1.5"
        style={{ color: "rgba(255,255,255,0.5)" }}
      >
        {label}
        {hint && (
          <span className="normal-case font-normal tracking-normal" style={{ color: "rgba(255,255,255,0.3)" }}>
            {" "}
            {hint}
          </span>
        )}
      </label>
      {children}
      {error && (
        <p className="mt-1.5 text-[11px]" style={{ color: "#fca5a5" }}>
          {error}
        </p>
      )}
    </div>
  );
}

const WHAT_YOU_DO: { icon: typeof Smartphone; title: string; body: string }[] = [
  {
    icon: Smartphone,
    title: "Run the clock, from your phone",
    body: "Score league nights live from pitch-side at the United Sports Centre — goals with scorer names, cards, all logged in real time.",
  },
  {
    icon: Users,
    title: "Cover your assigned games",
    body: "You'll see exactly which games are yours — Monday to Thursday league nights, teams, kickoff time — nothing else.",
  },
  {
    icon: ShieldCheck,
    title: "Approved before you get access",
    body: "Every application is reviewed by the MFL team. Once you're approved, your account switches on — and you're paid per game.",
  },
];

export default function MflRefSignup() {
  useMflBrand();
  const [, navigate] = useLocation();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  // Payment/invoice details — so the MFL coordinator can pay this ref per
  // game on the fortnightly invoice run (server/league-referee-routes.ts
  // signup validation mirrors these exactly). GST number is the one
  // optional field.
  const [bankAccountName, setBankAccountName] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankAccountNumber, setBankAccountNumber] = useState("");
  const [address, setAddress] = useState("");
  const [gstNumber, setGstNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  // Only show inline field errors once the referee has tried to submit —
  // not while they're still filling the form out top to bottom.
  const [attempted, setAttempted] = useState(false);

  const bankDigits = bankAccountNumber.replace(/\D/g, "");
  const bankAccountNumberValid = bankDigits.length === 15 || bankDigits.length === 16;
  const gstNumberValid = !gstNumber.trim() || /^[\d-]+$/.test(gstNumber.trim());

  const valid = Boolean(
    fullName.trim() &&
      email.trim() &&
      phone.trim() &&
      password.length >= 8 &&
      bankAccountName.trim() &&
      bankName.trim() &&
      bankAccountNumberValid &&
      address.trim() &&
      gstNumberValid,
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (!valid) return;
    setError(null);
    setLoading(true);
    try {
      await refPost("/api/public/mfl-referees/signup", {
        fullName: fullName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        password,
        bankAccountName: bankAccountName.trim(),
        bankName: bankName.trim(),
        bankAccountNumber,
        address: address.trim(),
        gstNumber: gstNumber.trim() || undefined,
      });
      setDone(true);
    } catch (e: any) {
      setError(e instanceof RefApiError ? e.message : "Something went wrong creating your account.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="mfl-ref-body min-h-screen w-full"
      style={{ background: `radial-gradient(120% 90% at 50% -10%, #1c1810 0%, ${INK} 55%)` }}
    >
      <style>{FONT_STYLE}</style>
      <div className="h-1.5 w-full" style={{ background: `linear-gradient(90deg, #8a774a, ${GOLD}, #ecd9a6)` }} />

      {done ? (
        <div className="min-h-screen flex flex-col items-center justify-center px-5 py-10">
          <div className="w-full max-w-sm text-center">
            <div
              className="mx-auto mb-4 h-16 w-16 rounded-2xl flex items-center justify-center"
              style={{ background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.35)" }}
            >
              <CheckCircle2 className="h-8 w-8" style={{ color: "#4ade80" }} />
            </div>
            <h1 className="mfl-ref-display text-2xl font-extrabold text-white mb-2">
              Thanks{fullName.trim() ? `, ${fullName.trim().split(" ")[0]}` : ""}
            </h1>
            <p className="text-sm leading-relaxed" style={{ color: "rgba(255,255,255,0.55)" }}>
              Your referee account is pending approval. The MFL team reviews every sign-up — we'll email you as
              soon as yours is active.
            </p>
            <button onClick={() => navigate("/mfl-ref")} className="mt-6 text-sm font-semibold" style={{ color: GOLD }}>
              ← Back to sign in
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* ── Hero ─────────────────────────────────────────────────────── */}
          <div className="px-5 pt-14 pb-10 text-center">
            <div className="max-w-md mx-auto">
              <div
                className="mx-auto mb-5 h-16 w-16 rounded-2xl flex items-center justify-center"
                style={{ background: "rgba(209,185,110,0.12)", border: "1px solid rgba(209,185,110,0.35)" }}
              >
                <Trophy className="h-8 w-8" style={{ color: GOLD }} />
              </div>
              <div
                className="text-[11px] font-bold uppercase tracking-[0.3em]"
                style={{ color: "rgba(255,255,255,0.45)" }}
              >
                Mini Football Leagues
              </div>
              <h1 className="mfl-ref-display text-[2.15rem] leading-[1.08] font-extrabold text-white mt-3">
                Referee at <span style={{ color: GOLD }}>Mini Football Leagues</span>
              </h1>
              <p
                className="mt-4 text-[15px] leading-relaxed max-w-sm mx-auto"
                style={{ color: "rgba(255,255,255,0.6)" }}
              >
                Score your assigned league nights live from your phone — goals, scorer names and cards — as part
                of the referee team for Christchurch's social small-sided leagues. Monday to Thursday, at the
                United Sports Centre.
              </p>
              <div
                className="mt-5 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide px-3.5 py-1.5 rounded-full"
                style={{ background: "rgba(209,185,110,0.12)", color: GOLD, border: "1px solid rgba(209,185,110,0.35)" }}
              >
                <Sparkles className="h-3.5 w-3.5" /> Paid per game — spots are limited
              </div>
            </div>
          </div>

          {/* ── What it involves ────────────────────────────────────────── */}
          <div className="px-5 pb-10">
            <div className="max-w-md mx-auto space-y-3">
              {WHAT_YOU_DO.map(({ icon: Icon, title, body }) => (
                <div
                  key={title}
                  className="flex items-start gap-3.5 rounded-2xl p-4"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
                >
                  <div
                    className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: "rgba(209,185,110,0.12)", border: "1px solid rgba(209,185,110,0.3)" }}
                  >
                    <Icon className="h-5 w-5" style={{ color: GOLD }} />
                  </div>
                  <div className="min-w-0">
                    <div className="mfl-ref-display text-sm font-bold text-white">{title}</div>
                    <div className="text-[13px] leading-relaxed mt-0.5" style={{ color: "rgba(255,255,255,0.5)" }}>
                      {body}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Sign-up card ─────────────────────────────────────────────── */}
          <div className="px-5 pb-6">
            <div
              className="max-w-md mx-auto rounded-3xl p-6"
              style={{ background: PANEL, border: "1px solid rgba(255,255,255,0.08)" }}
            >
              <div className="text-center mb-6">
                <div className="flex items-center justify-center gap-2 mb-1.5">
                  <ShieldCheck className="h-4 w-4" style={{ color: GOLD }} />
                  <div
                    className="text-[11px] font-bold uppercase tracking-[0.25em]"
                    style={{ color: "rgba(255,255,255,0.45)" }}
                  >
                    Apply Now
                  </div>
                </div>
                <h2 className="mfl-ref-display text-2xl font-extrabold text-white">Create your referee account</h2>
              </div>

              {error && (
                <div
                  className="mb-4 rounded-xl border px-4 py-3 text-sm"
                  style={{ borderColor: "rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.08)", color: "#fca5a5" }}
                >
                  {error}
                </div>
              )}

              <form onSubmit={submit} className="space-y-3">
                <Field label="Full name">
                  <Input
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className={fieldClass}
                    placeholder="Jordan Smith"
                  />
                </Field>
                <Field label="Email">
                  <Input
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={fieldClass}
                    placeholder="you@example.com"
                  />
                </Field>
                <Field label="Phone">
                  <Input
                    type="tel"
                    required
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className={fieldClass}
                    placeholder="021 234 5678"
                  />
                </Field>
                <Field label="Password">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={fieldClass}
                    placeholder="At least 8 characters"
                  />
                  <p
                    className="mt-1.5 text-[11px]"
                    style={{ color: password.length > 0 && password.length < 8 ? "#fca5a5" : "rgba(255,255,255,0.35)" }}
                  >
                    {password.length}/8 characters minimum
                  </p>
                </Field>

                {/* ── Payment details ─────────────────────────────────── */}
                <div className="pt-3 mt-1 border-t" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                  <div className="mb-3">
                    <div
                      className="text-[11px] font-bold uppercase tracking-[0.2em]"
                      style={{ color: GOLD }}
                    >
                      Payment details
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "rgba(255,255,255,0.45)" }}>
                      So we can pay your match fees — this is what goes on your fortnightly invoice.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Field
                      label="Name on bank account"
                      error={attempted && !bankAccountName.trim() ? "Required." : null}
                    >
                      <Input
                        required
                        value={bankAccountName}
                        onChange={(e) => setBankAccountName(e.target.value)}
                        className={fieldClass}
                        placeholder="Jordan Smith"
                      />
                    </Field>
                    <Field label="Bank" error={attempted && !bankName.trim() ? "Required." : null}>
                      <Input
                        required
                        value={bankName}
                        onChange={(e) => setBankName(e.target.value)}
                        className={fieldClass}
                        placeholder="e.g. ANZ, ASB, BNZ, Kiwibank"
                      />
                    </Field>
                    <Field
                      label="Bank account number"
                      error={
                        attempted && !bankAccountNumberValid
                          ? "Enter a valid 15 or 16 digit NZ bank account number."
                          : null
                      }
                    >
                      <Input
                        required
                        inputMode="numeric"
                        autoComplete="off"
                        value={bankAccountNumber}
                        onChange={(e) => setBankAccountNumber(formatBankAccountInput(e.target.value))}
                        className={fieldClass}
                        placeholder="00-0000-0000000-000"
                      />
                    </Field>
                    <Field label="Home address" error={attempted && !address.trim() ? "Required." : null}>
                      <Textarea
                        required
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        className={textareaClass}
                        placeholder="123 Example Street, Christchurch"
                      />
                    </Field>
                    <Field
                      label="GST number"
                      hint="(optional — leave blank if not GST registered)"
                      error={attempted && !gstNumberValid ? "GST number should only contain digits and dashes." : null}
                    >
                      <Input
                        value={gstNumber}
                        onChange={(e) => setGstNumber(e.target.value)}
                        className={fieldClass}
                        placeholder="123-456-789"
                      />
                    </Field>
                  </div>
                </div>

                <Button
                  type="submit"
                  disabled={loading || !valid}
                  className="w-full h-12 rounded-xl text-base font-bold border-none"
                  style={{ background: GOLD, color: INK }}
                >
                  {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "Create account"}
                </Button>
              </form>

              <div className="mt-6 text-center">
                <button
                  onClick={() => navigate("/mfl-ref")}
                  className="text-sm font-medium"
                  style={{ color: "rgba(255,255,255,0.5)" }}
                >
                  Already approved? Sign in
                </button>
              </div>
            </div>
          </div>

          {/* ── Footer note ──────────────────────────────────────────────── */}
          <div className="px-5 pb-12 text-center">
            <p className="max-w-sm mx-auto text-xs leading-relaxed" style={{ color: "rgba(255,255,255,0.3)" }}>
              The MFL team reviews every sign-up before your account is activated.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
