// Parent account — join.cufc.co.nz/account
//
// The family's own view of the club: their children, what each one is enrolled
// in, what is paid and what is owed, and the details the club holds — editable,
// so next term's registration is a confirmation rather than a form.
//
// Sign-in is a 6-digit code to the address the club already holds as a
// guardian. No password: families forget them, and a reset flow is a support
// burden the office would carry. No magic link either — a forwarded link is a
// live session; a code paired with the address that asked for it is not.
//
// This page NEVER computes a price or a balance. Every dollar comes from
// /api/public/parent/me, which reads the club's own ledger.

import { useEffect, useState, useCallback } from "react";
import { Link } from "wouter";
import {
  Loader2, Mail, ArrowRight, LogOut, ChevronDown, Check, AlertCircle,
  ShieldCheck, Pencil, X, CalendarDays, Info,
} from "lucide-react";
import {
  centsToDollars, looksLikeEmail, normalizeParentEmail, feeLabelFor,
  type ParentMe, type ParentChild, type ParentRegistration,
} from "@shared/parent";

// ── Brand — CUFC palette, same tokens as the academy checkout ────────────────
const BRAND = {
  navy: "#0C1640",
  ink: "#13182F",
  royal: "#263996",
  gold: "#D4AF37",
  goldBright: "#E8CF6B",
  white: "#FFFFFF",
  line: "#232B4E",
  mute: "#AEB6D4",
  red: "#f0564f",
  green: "#3ecf8e",
};
const FONT_BODY = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";
const FONT_DISPLAY = "'Oswald', 'Arial Narrow', sans-serif";

const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.message || "Something went wrong.");
  return body;
};

// ── Shared bits ─────────────────────────────────────────────────────────────

function Field(props: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string; hint?: string; required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-semibold" style={{ color: BRAND.mute }}>
        {props.label}{props.required && <span style={{ color: BRAND.gold }}> *</span>}
      </span>
      <input
        type={props.type || "text"}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full rounded-xl px-3.5 py-3 text-[16px] outline-none transition focus:ring-2"
        style={{
          background: BRAND.navy, color: BRAND.white,
          border: `1px solid ${BRAND.line}`,
        }}
      />
      {props.hint && <span className="mt-1 block text-[12px]" style={{ color: BRAND.mute }}>{props.hint}</span>}
    </label>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <button
      type="button"
      onClick={() => props.onChange(!props.checked)}
      className="flex w-full items-start gap-3 rounded-xl p-3 text-left transition"
      style={{ background: BRAND.navy, border: `1px solid ${BRAND.line}` }}
    >
      <span
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition"
        style={{
          background: props.checked ? BRAND.gold : "transparent",
          border: `1px solid ${props.checked ? BRAND.gold : BRAND.line}`,
        }}
      >
        {props.checked && <Check className="h-3.5 w-3.5" strokeWidth={3} style={{ color: BRAND.navy }} />}
      </span>
      <span>
        <span className="block text-[14px] font-semibold" style={{ color: BRAND.white }}>{props.label}</span>
        {props.hint && <span className="mt-0.5 block text-[12px]" style={{ color: BRAND.mute }}>{props.hint}</span>}
      </span>
    </button>
  );
}

function Notice({ kind, children }: { kind: "error" | "info" | "ok"; children: React.ReactNode }) {
  const c = kind === "error" ? BRAND.red : kind === "ok" ? BRAND.green : BRAND.gold;
  const Icon = kind === "error" ? AlertCircle : kind === "ok" ? Check : Info;
  return (
    <div
      className="flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-[13px]"
      style={{ background: `${c}14`, border: `1px solid ${c}44`, color: BRAND.white }}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: c }} />
      <span>{children}</span>
    </div>
  );
}

// ── Sign in ─────────────────────────────────────────────────────────────────

function SignIn({ onDone }: { onDone: () => void }) {
  const [stage, setStage] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestCode = async () => {
    setError(null);
    if (!looksLikeEmail(email)) return setError("Please enter a valid email address.");
    setBusy(true);
    try {
      await api("/api/public/parent/request-code", {
        method: "POST",
        body: JSON.stringify({ email: normalizeParentEmail(email) }),
      });
      setStage("code");
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const verify = async () => {
    setError(null);
    if (!/^\d{6}$/.test(code.trim())) return setError("Enter the 6-digit code from your email.");
    setBusy(true);
    try {
      await api("/api/public/parent/verify", {
        method: "POST",
        body: JSON.stringify({ email: normalizeParentEmail(email), code: code.trim() }),
      });
      onDone();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto w-full max-w-[420px] px-5 py-10">
      <div className="mb-7 text-center">
        <img src="/logos/christchurch-united.png" alt="" className="mx-auto mb-4 h-14 w-14 object-contain"
             onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
        <h1 className="text-[26px] font-extrabold uppercase leading-tight"
            style={{ fontFamily: FONT_DISPLAY, color: BRAND.white, letterSpacing: "0.02em" }}>
          Your club account
        </h1>
        <p className="mt-2 text-[14px]" style={{ color: BRAND.mute }}>
          {stage === "email"
            ? "Sign in to manage your children, see your fees, and register faster next term."
            : `We've sent a 6-digit code to ${email}.`}
        </p>
      </div>

      <div className="rounded-2xl p-5" style={{ background: BRAND.ink, border: `1px solid ${BRAND.line}` }}>
        {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}

        {stage === "email" ? (
          <>
            <Field
              label="Email address" type="email" required
              value={email} onChange={setEmail}
              placeholder="you@example.com"
              hint="Use the address the club already has for you."
            />
            <button
              onClick={requestCode} disabled={busy}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-[15px] font-bold transition disabled:opacity-60"
              style={{ background: BRAND.gold, color: BRAND.navy }}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
              {busy ? "Sending…" : "Email me a code"}
            </button>
          </>
        ) : (
          <>
            <Field
              label="6-digit code" value={code} onChange={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              hint="It expires in 15 minutes."
            />
            <button
              onClick={verify} disabled={busy}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-[15px] font-bold transition disabled:opacity-60"
              style={{ background: BRAND.gold, color: BRAND.navy }}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              {busy ? "Checking…" : "Sign in"}
            </button>
            <button
              onClick={() => { setStage("email"); setCode(""); setError(null); }}
              className="mt-3 w-full text-center text-[13px] underline"
              style={{ color: BRAND.mute }}
            >
              Use a different email
            </button>
          </>
        )}
      </div>

      <p className="mt-5 text-center text-[12px] leading-relaxed" style={{ color: BRAND.mute }}>
        Can't sign in? Your account uses the email the club holds for you.
        Email <a href="mailto:academy@cufc.co.nz" style={{ color: BRAND.gold }}>academy@cufc.co.nz</a> and we'll sort it.
      </p>
    </div>
  );
}

// ── A child's programmes and money ──────────────────────────────────────────

// 🔴 This row states a shortfall ONLY for a real recorded part-payment. A
// confirmed registration with no payment on file shows its FEE, not a debt —
// 245 of the club's 414 confirmed registrations have no amount_paid recorded,
// most of them paid in cash at the counter or through a camp checkout that
// never wrote the field.
function RegistrationRow({ reg }: { reg: ParentRegistration }) {
  const tone =
    reg.feeState === "paid" ? BRAND.green
    : reg.feeState === "part_paid" ? BRAND.gold
    : reg.feeState === "incomplete" ? BRAND.gold
    : BRAND.mute;
  const label = feeLabelFor(reg.feeState, reg.totalCents, reg.owingCents, centsToDollars);

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5"
         style={{ borderTop: `1px solid ${BRAND.line}` }}>
      <div className="min-w-0">
        <p className="truncate text-[14px] font-semibold"
           style={{ color: reg.feeState === "cancelled" ? BRAND.mute : BRAND.white }}>
          {reg.programName}
        </p>
        <p className="text-[12px]" style={{ color: BRAND.mute }}>
          {reg.registeredAt ? `Registered ${reg.registeredAt}` : "Registered"}
          {reg.paymentMode === "weekly" && " · weekly plan"}
        </p>
      </div>
      <span className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-bold"
            style={{ background: `${tone}1f`, color: tone }}>
        {label}
      </span>
    </div>
  );
}

function ChildCard({ child, onSaved }: { child: ParentChild; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState(child.details);

  useEffect(() => { setForm(child.details); }, [child.details]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await api(`/api/public/parent/children/${encodeURIComponent(child.key)}`, {
        method: "PATCH",
        body: JSON.stringify(form),
      });
      setSaved(true); setEditing(false); onSaved();
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="rounded-2xl" style={{ background: BRAND.ink, border: `1px solid ${BRAND.line}` }}>
      <div className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <h3 className="truncate text-[17px] font-extrabold uppercase"
              style={{ fontFamily: FONT_DISPLAY, color: BRAND.white, letterSpacing: "0.02em" }}>
            {child.firstName} {child.lastName}
          </h3>
          <p className="mt-0.5 text-[12.5px]" style={{ color: BRAND.mute }}>
            {child.ageGrade ? `U${child.ageGrade}` : "Age not recorded"}
            {child.dateOfBirth && ` · born ${child.dateOfBirth}`}
          </p>
        </div>
        {child.owingCents > 0 && (
          <span className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-bold"
                style={{ background: `${BRAND.gold}1f`, color: BRAND.gold }}>
            {centsToDollars(child.owingCents)} to pay
          </span>
        )}
      </div>

      <div className="px-4 pb-1">
        {child.registrations.length === 0 ? (
          <p className="pb-3 text-[13px]" style={{ color: BRAND.mute }}>
            Not currently enrolled in anything.
          </p>
        ) : (
          child.registrations.map((r) => <RegistrationRow key={r.id} reg={r} />)
        )}
      </div>

      {child.needsIdentity && !editing && (
        <div className="px-4 pb-3 pt-2">
          <Notice kind="info">
            We're missing a few details New Zealand Football asks us to hold for {child.firstName}.
            Adding them here saves you doing it at your next registration.
          </Notice>
        </div>
      )}

      <button
        onClick={() => { setOpen((v) => !v); setEditing(false); }}
        className="flex w-full items-center justify-between px-4 py-3 text-[13.5px] font-semibold transition"
        style={{ borderTop: `1px solid ${BRAND.line}`, color: BRAND.mute }}
      >
        <span>{child.firstName}'s details</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="px-4 pb-4">
          {saved && <div className="mb-3"><Notice kind="ok">Saved.</Notice></div>}
          {error && <div className="mb-3"><Notice kind="error">{error}</Notice></div>}

          {!editing ? (
            <>
              <dl className="text-[13.5px]">
                {([
                  ["Allergies", child.details.allergies],
                  ["Medical notes", child.details.medicalNotes],
                  ["Emergency contact", child.details.emergencyContact],
                  ["Emergency phone", child.details.emergencyPhone],
                  ["School", child.details.school],
                  ["Country of birth", child.details.countryOfBirth],
                  ["Nationality", child.details.nationality],
                  ["Ethnicity", child.details.ethnicity],
                ] as const).map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-4 py-1.5"
                       style={{ borderBottom: `1px solid ${BRAND.line}` }}>
                    <dt style={{ color: BRAND.mute }}>{label}</dt>
                    <dd className="text-right" style={{ color: value ? BRAND.white : BRAND.mute }}>
                      {value || "—"}
                    </dd>
                  </div>
                ))}
                <div className="flex justify-between gap-4 py-1.5">
                  <dt style={{ color: BRAND.mute }}>Photo consent</dt>
                  <dd style={{ color: BRAND.white }}>{child.details.photoConsent ? "Given" : "Not given"}</dd>
                </div>
              </dl>
              <button
                onClick={() => setEditing(true)}
                className="mt-3 flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-[13.5px] font-bold"
                style={{ background: BRAND.navy, border: `1px solid ${BRAND.line}`, color: BRAND.white }}
              >
                <Pencil className="h-3.5 w-3.5" /> Update details
              </button>
            </>
          ) : (
            <div className="grid gap-3">
              <Field label="Allergies" value={form.allergies ?? ""} onChange={(v) => set("allergies", v)}
                     placeholder="None" />
              <Field label="Medical notes" value={form.medicalNotes ?? ""} onChange={(v) => set("medicalNotes", v)}
                     placeholder="Anything our coaches should know" />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Emergency contact" value={form.emergencyContact ?? ""}
                       onChange={(v) => set("emergencyContact", v)} placeholder="Name" />
                <Field label="Emergency phone" value={form.emergencyPhone ?? ""} type="tel"
                       onChange={(v) => set("emergencyPhone", v)} placeholder="021 …" />
              </div>
              <Field label="School" value={form.school ?? ""} onChange={(v) => set("school", v)} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Country of birth" value={form.countryOfBirth ?? ""}
                       onChange={(v) => set("countryOfBirth", v)} placeholder="New Zealand" />
                <Field label="Nationality" value={form.nationality ?? ""}
                       onChange={(v) => set("nationality", v)} placeholder="New Zealand" />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Ethnicity" value={form.ethnicity ?? ""} onChange={(v) => set("ethnicity", v)}
                       hint="As you'd describe it — NZ Football asks us for this." />
                <Field label="Iwi / specific group" value={form.subEthnicity ?? ""}
                       onChange={(v) => set("subEthnicity", v)} placeholder="Optional" />
              </div>
              <Toggle label="Photo consent" checked={form.photoConsent}
                      onChange={(v) => set("photoConsent", v)}
                      hint="We may photograph training and matches for club channels." />
              <Toggle label="Medical consent" checked={form.medicalConsent}
                      onChange={(v) => set("medicalConsent", v)}
                      hint="Staff may arrange treatment if we can't reach you in an emergency." />

              <div className="flex gap-2 pt-1">
                <button
                  onClick={save} disabled={busy}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-[14px] font-bold disabled:opacity-60"
                  style={{ background: BRAND.gold, color: BRAND.navy }}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Save
                </button>
                <button
                  onClick={() => { setEditing(false); setForm(child.details); setError(null); }}
                  className="rounded-xl px-4 py-3 text-[14px] font-bold"
                  style={{ background: BRAND.navy, border: `1px solid ${BRAND.line}`, color: BRAND.mute }}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── My details ──────────────────────────────────────────────────────────────

function ProfileCard({ me, onSaved }: { me: ParentMe; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState(me.profile);

  useEffect(() => { setForm(me.profile); }, [me.profile]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await api("/api/public/parent/profile", { method: "PATCH", body: JSON.stringify(form) });
      setSaved(true); setEditing(false); onSaved();
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="rounded-2xl p-4" style={{ background: BRAND.ink, border: `1px solid ${BRAND.line}` }}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-extrabold uppercase"
            style={{ fontFamily: FONT_DISPLAY, color: BRAND.white, letterSpacing: "0.03em" }}>
          Your details
        </h2>
        {!editing && (
          <button onClick={() => setEditing(true)}
                  className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: BRAND.gold }}>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
        )}
      </div>

      {saved && <div className="mb-3"><Notice kind="ok">Saved.</Notice></div>}
      {error && <div className="mb-3"><Notice kind="error">{error}</Notice></div>}

      {!editing ? (
        <dl className="text-[13.5px]">
          {([
            ["Name", `${me.profile.firstName} ${me.profile.lastName}`.trim()],
            ["Email", me.profile.email],
            ["Phone", me.profile.phone],
            ["Other phone", me.profile.alternatePhone],
            ["Address", me.profile.address],
          ] as const).map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 py-1.5"
                 style={{ borderBottom: `1px solid ${BRAND.line}` }}>
              <dt style={{ color: BRAND.mute }}>{label}</dt>
              <dd className="text-right" style={{ color: value ? BRAND.white : BRAND.mute }}>{value || "—"}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First name" required value={form.firstName} onChange={(v) => set("firstName", v)} />
            <Field label="Last name" required value={form.lastName} onChange={(v) => set("lastName", v)} />
          </div>
          <Field label="Phone" required type="tel" value={form.phone ?? ""} onChange={(v) => set("phone", v)} />
          <Field label="Other phone" type="tel" value={form.alternatePhone ?? ""}
                 onChange={(v) => set("alternatePhone", v)} />
          <Field label="Address" value={form.address ?? ""} onChange={(v) => set("address", v)} />
          <p className="text-[12px]" style={{ color: BRAND.mute }}>
            Your email is how you sign in, so it can't be changed here — email{" "}
            <a href="mailto:academy@cufc.co.nz" style={{ color: BRAND.gold }}>academy@cufc.co.nz</a> to change it.
          </p>
          <div className="flex gap-2">
            <button onClick={save} disabled={busy}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-[14px] font-bold disabled:opacity-60"
                    style={{ background: BRAND.gold, color: BRAND.navy }}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save
            </button>
            <button onClick={() => { setEditing(false); setForm(me.profile); setError(null); }}
                    className="rounded-xl px-4 py-3 text-[14px] font-bold"
                    style={{ background: BRAND.navy, border: `1px solid ${BRAND.line}`, color: BRAND.mute }}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── The page ────────────────────────────────────────────────────────────────

export default function ParentAccountPage() {
  const [me, setMe] = useState<ParentMe | null>(null);
  const [state, setState] = useState<"loading" | "out" | "in">("loading");

  const load = useCallback(async () => {
    try {
      const data = await api("/api/public/parent/me");
      setMe(data); setState("in");
    } catch { setMe(null); setState("out"); }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => { document.title = "Your account — Christchurch United FC"; }, []);

  const signOut = async () => {
    await api("/api/public/parent/logout", { method: "POST" }).catch(() => {});
    setMe(null); setState("out");
  };

  if (state === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: BRAND.navy }}>
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: BRAND.gold }} />
      </div>
    );
  }

  if (state === "out" || !me) {
    return (
      <div className="min-h-screen" style={{ background: BRAND.navy, fontFamily: FONT_BODY }}>
        <SignIn onDone={load} />
      </div>
    );
  }

  const firstName = me.profile.firstName || "there";

  return (
    <div className="min-h-screen" style={{ background: BRAND.navy, color: BRAND.white, fontFamily: FONT_BODY }}>
      <header className="sticky top-0 z-30 backdrop-blur"
              style={{ background: `${BRAND.navy}e6`, borderBottom: `1px solid ${BRAND.line}` }}>
        <div className="mx-auto flex max-w-[760px] items-center justify-between gap-3 px-5 py-3.5">
          <a href="https://cufc.co.nz" className="flex min-w-0 items-center gap-2.5">
            <img src="/logos/christchurch-united.png" alt="" className="h-8 w-8 shrink-0 object-contain"
                 onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
            <span className="truncate text-[13px] font-bold uppercase"
                  style={{ fontFamily: FONT_DISPLAY, letterSpacing: "0.05em" }}>
              Christchurch United
            </span>
          </a>
          <button onClick={signOut}
                  className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-semibold"
                  style={{ border: `1px solid ${BRAND.line}`, color: BRAND.mute }}>
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[760px] px-5 py-7">
        <h1 className="text-[26px] font-extrabold uppercase leading-tight"
            style={{ fontFamily: FONT_DISPLAY, letterSpacing: "0.02em" }}>
          Kia ora, {firstName}
        </h1>
        <p className="mt-1.5 text-[14px]" style={{ color: BRAND.mute }}>
          {me.children.length === 0
            ? "We don't have any children linked to your account yet."
            : `${me.children.length} ${me.children.length === 1 ? "child" : "children"} on your account.`}
        </p>

        {/* Shown only when a genuine part-payment is on file. There is no
            account-level "outstanding balance" here on purpose — see the note
            on ParentFeeState. */}
        {me.owingCents > 0 && (
          <div className="mt-5 rounded-2xl p-4"
               style={{ background: `${BRAND.gold}12`, border: `1px solid ${BRAND.gold}40` }}>
            <p className="text-[13px] font-semibold" style={{ color: BRAND.mute }}>Part-paid registrations</p>
            <p className="mt-0.5 text-[28px] font-extrabold" style={{ fontFamily: FONT_DISPLAY, color: BRAND.white }}>
              {centsToDollars(me.owingCents)}
            </p>
            <p className="mt-1.5 text-[13px]" style={{ color: BRAND.mute }}>
              still to pay across your registrations. To settle it, email{" "}
              <a href="mailto:academy@cufc.co.nz" style={{ color: BRAND.gold }}>academy@cufc.co.nz</a>{" "}
              or pay at the office.
            </p>
          </div>
        )}

        <section className="mt-6 grid gap-3">
          {me.children.map((c) => <ChildCard key={c.key} child={c} onSaved={load} />)}
        </section>

        {me.children.length === 0 && (
          <div className="mt-4"><Notice kind="info">
            If your child should be here, they may be recorded under a different email.
            Email <a href="mailto:academy@cufc.co.nz" style={{ color: BRAND.gold }}>academy@cufc.co.nz</a> and we'll link them up.
          </Notice></div>
        )}

        <section className="mt-6"><ProfileCard me={me} onSaved={load} /></section>

        <section className="mt-6 rounded-2xl p-4"
                 style={{ background: BRAND.ink, border: `1px solid ${BRAND.line}` }}>
          <h2 className="text-[15px] font-extrabold uppercase"
              style={{ fontFamily: FONT_DISPLAY, letterSpacing: "0.03em" }}>
            Register for next term
          </h2>
          <p className="mt-1.5 text-[13.5px]" style={{ color: BRAND.mute }}>
            You're signed in, so we'll fill in your details and let you pick a child you've
            already registered — no retyping.
          </p>
          <a href="https://cufc.co.nz/register"
             className="mt-3 inline-flex items-center gap-2 rounded-xl px-4 py-3 text-[14px] font-bold"
             style={{ background: BRAND.gold, color: BRAND.navy }}>
            <CalendarDays className="h-4 w-4" /> See programmes
          </a>
        </section>

        <p className="mt-8 flex items-center justify-center gap-1.5 text-center text-[12px]"
           style={{ color: BRAND.mute }}>
          <ShieldCheck className="h-3.5 w-3.5" />
          Only you can see this page. <Link href="/privacy" className="underline">Privacy</Link>
        </p>
      </main>
    </div>
  );
}
