// CIC referee sign-up — /ref/signup. Self-service account request; a CIC
// staffer approves it before the referee can log in and score (see
// server/cic-referee-routes.ts — POST /api/public/cic-referees/signup
// always creates a 'pending' row). No token is issued here.
import { useState, type FormEvent, type ReactNode } from "react";
import { useLocation } from "wouter";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { refPost, RefApiError } from "./ref-api";

const GOLD = "#C9A43E";
const INK = "#141511";

const FONT_STYLE = `
  @import url('https://fonts.googleapis.com/css2?family=Kanit:wght@600;700;800;900&family=Inter:wght@400;500;600;700;800&display=swap');
  .cic-ref-display { font-family: 'Kanit', 'Inter', sans-serif; }
  .cic-ref-body { font-family: 'Inter', sans-serif; }
`;

const fieldClass =
  "h-12 text-base rounded-xl bg-white/5 border-white/10 text-white placeholder:text-white/30 focus-visible:ring-[#C9A43E] focus-visible:ring-offset-0";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label
        className="block text-xs font-semibold uppercase tracking-wide mb-1.5"
        style={{ color: "rgba(255,255,255,0.5)" }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

export default function RefSignup() {
  const [, navigate] = useLocation();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const valid = fullName.trim() && email.trim() && phone.trim() && password.length >= 8;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setError(null);
    setLoading(true);
    try {
      await refPost("/api/public/cic-referees/signup", {
        fullName: fullName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        password,
      });
      setDone(true);
    } catch (e: any) {
      setError(e instanceof RefApiError ? e.message : "Something went wrong creating your account.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="cic-ref-body min-h-screen w-full" style={{ background: INK }}>
      <style>{FONT_STYLE}</style>
      <div className="h-1.5 w-full" style={{ background: `linear-gradient(90deg, #8a6a1f, ${GOLD}, #e9d38a)` }} />
      <div className="min-h-screen flex flex-col items-center justify-center px-5 py-10">
        <div className="w-full max-w-sm">
          {done ? (
            <div className="text-center">
              <div
                className="mx-auto mb-4 h-16 w-16 rounded-2xl flex items-center justify-center"
                style={{ background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.35)" }}
              >
                <CheckCircle2 className="h-8 w-8" style={{ color: "#4ade80" }} />
              </div>
              <h1 className="cic-ref-display text-2xl font-extrabold text-white mb-2">
                Thanks{fullName.trim() ? `, ${fullName.trim().split(" ")[0]}` : ""}
              </h1>
              <p className="text-sm leading-relaxed" style={{ color: "rgba(255,255,255,0.55)" }}>
                Your referee account is pending approval. We'll email you when it's active.
              </p>
              <button
                onClick={() => navigate("/ref")}
                className="mt-6 text-sm font-semibold"
                style={{ color: GOLD }}
              >
                ← Back to sign in
              </button>
            </div>
          ) : (
            <>
              <div className="text-center mb-8">
                <div
                  className="mx-auto mb-3 h-14 w-14 rounded-2xl flex items-center justify-center"
                  style={{ background: "rgba(201,164,62,0.12)", border: "1px solid rgba(201,164,62,0.35)" }}
                >
                  <ShieldCheck className="h-7 w-7" style={{ color: GOLD }} />
                </div>
                <div className="text-xs uppercase tracking-[0.25em]" style={{ color: "rgba(255,255,255,0.4)" }}>
                  Christchurch International Cup
                </div>
                <h1 className="cic-ref-display text-3xl font-extrabold text-white mt-1">Referee Sign Up</h1>
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
                  onClick={() => navigate("/ref")}
                  className="text-sm font-medium"
                  style={{ color: "rgba(255,255,255,0.5)" }}
                >
                  Already approved? Sign in
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
