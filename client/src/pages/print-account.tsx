// ─────────────────────────────────────────────────────────────────────────────
// UNITED PRINTS — the customer's own account (join.unitedprints.co.nz/account)
//
// Sign in with a code, see your orders, see your price. Self-contained styling
// on purpose: this is a CUSTOMER page wearing the unitedprints.co.nz brand
// (royal #043bcb, grass #33cc00, Poppins), not a ClubOS admin screen, and it
// must not inherit the admin theme or its dark-mode surfaces.
//
// 🔴 Four states, never 200-with-zeros: signing in, failed, signed in with no
// orders yet, and signed in with real orders. "No orders yet" is a real,
// correct answer for a new customer and reads as one — it is not an error and
// it is not a blank screen.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from "react";
import type { PrintAccountMe, PrintAccountOrder } from "@shared/print-account";
import { pricingBadge } from "@shared/print-account";

const BASE = "/api/public/unitedprints/account";

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** 🔴 Formats a BARE ISO date string. Never `new Date(iso)` — that reads the
 *  previous day in NZ for a date the server already resolved correctly. */
function dateLabel(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "—";
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// Statuses a customer would read as "this is finished".
const DONE = new Set(["delivered", "cancelled"]);

function StatusPill({ order }: { order: PrintAccountOrder }) {
  const key = order.status.toLowerCase();
  const tone =
    key === "cancelled" ? "bg-rose-50 text-rose-700 ring-rose-200"
    : key === "delivered" ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
    : key === "ready" ? "bg-[#33cc00]/10 text-[#1f7a00] ring-[#33cc00]/30"
    : key === "artwork_pending" ? "bg-amber-50 text-amber-800 ring-amber-200"
    : "bg-[#043bcb]/8 text-[#043bcb] ring-[#043bcb]/20";
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ring-1 ${tone}`}>
      {order.statusLabel}
    </span>
  );
}

// ── Sign in ──────────────────────────────────────────────────────────────────

function SignIn({ onSignedIn }: { onSignedIn: (me: PrintAccountMe) => void }) {
  const [stage, setStage] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (stage === "code") codeRef.current?.focus();
  }, [stage]);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${BASE}/request-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data?.message ?? "Couldn't send that code."); return; }
      setNote(data?.message ?? "Check your email.");
      setStage("code");
    } catch {
      setError("Couldn't reach us just now. Check your connection and try again.");
    } finally { setBusy(false); }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${BASE}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data?.message ?? "That didn't work."); return; }
      onSignedIn(data.me as PrintAccountMe);
    } catch {
      setError("Couldn't reach us just now. Check your connection and try again.");
    } finally { setBusy(false); }
  }

  const inputCls =
    "w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#043bcb] focus:ring-4 focus:ring-[#043bcb]/12 placeholder:text-slate-400";

  return (
    <div className="mx-auto w-full max-w-md px-5 py-12 sm:py-20">
      <div className="rounded-3xl border border-slate-200 bg-white p-7 shadow-[0_1px_2px_rgba(16,24,40,.04),0_12px_32px_-12px_rgba(4,59,203,.18)] sm:p-9">
        <h1 className="text-[26px] font-extrabold leading-tight tracking-tight text-slate-900">
          {stage === "email" ? "Your United Prints account" : "Check your email"}
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-slate-600">
          {stage === "email"
            ? "Sign in to see your orders, your artwork and your pricing. No password — we'll email you a code."
            : <>We sent a 6-digit code to <span className="font-semibold text-slate-900">{email}</span>. It expires in 10 minutes.</>}
        </p>

        {stage === "email" ? (
          <form onSubmit={requestCode} className="mt-7 space-y-4">
            <div>
              <label htmlFor="up-email" className="mb-2 block text-sm font-semibold text-slate-800">Email address</label>
              <input
                id="up-email" type="email" required autoComplete="email" inputMode="email"
                value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourbusiness.co.nz" className={inputCls}
              />
            </div>
            <button
              type="submit" disabled={busy || !email}
              className="min-h-[52px] w-full rounded-full bg-[#33cc00] px-6 text-[15px] font-bold uppercase tracking-wide text-white transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Sending…" : "Email me a code"}
            </button>
            <p className="pt-1 text-center text-[13px] leading-relaxed text-slate-500">
              New here? Signing in with your email creates your account.
            </p>
          </form>
        ) : (
          <form onSubmit={verify} className="mt-7 space-y-4">
            <div>
              <label htmlFor="up-code" className="mb-2 block text-sm font-semibold text-slate-800">6-digit code</label>
              <input
                ref={codeRef} id="up-code" required inputMode="numeric" autoComplete="one-time-code"
                pattern="\d{6}" maxLength={6} value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                className={`${inputCls} text-center font-mono text-[30px] font-bold tracking-[0.4em]`}
              />
            </div>
            <button
              type="submit" disabled={busy || code.length !== 6}
              className="min-h-[52px] w-full rounded-full bg-[#33cc00] px-6 text-[15px] font-bold uppercase tracking-wide text-white transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Checking…" : "Sign in"}
            </button>
            <button
              type="button"
              onClick={() => { setStage("email"); setCode(""); setError(null); setNote(null); }}
              className="min-h-[44px] w-full text-[14px] font-semibold text-[#043bcb] underline-offset-4 hover:underline"
            >
              Use a different email
            </button>
          </form>
        )}

        {note && !error && (
          <p className="mt-4 rounded-xl bg-[#043bcb]/6 px-4 py-3 text-[14px] leading-relaxed text-[#043bcb]">{note}</p>
        )}
        {error && (
          <p role="alert" className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-[14px] leading-relaxed text-rose-700">{error}</p>
        )}
      </div>

      <p className="mt-6 text-center text-[13px] leading-relaxed text-slate-500">
        Need a hand? <a href="tel:0800800199" className="font-semibold text-[#043bcb]">0800 800 199</a>{" "}
        · <a href="mailto:orders@unitedprints.co.nz" className="font-semibold text-[#043bcb]">orders@unitedprints.co.nz</a>
      </p>
    </div>
  );
}

// ── Signed in ────────────────────────────────────────────────────────────────

function OrderCard({ order }: { order: PrintAccountOrder }) {
  return (
    <li className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,.04)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[16px] font-bold text-slate-900">{order.title}</p>
          <p className="mt-0.5 text-[13px] text-slate-500">
            {order.orderNumber ?? "No reference yet"} · placed {dateLabel(order.placedOn)}
          </p>
        </div>
        <StatusPill order={order} />
      </div>

      {order.lines.length > 0 && (
        <ul className="mt-4 space-y-1.5 border-t border-slate-100 pt-4">
          {order.lines.map((l, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-[14px] text-slate-700">
              <span className="font-semibold text-slate-500">{l.quantity}×</span>
              <span className="min-w-0">{l.description}</span>
              {l.sizeLabel && <span className="text-slate-400">{l.sizeLabel}</span>}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <div className="text-[14px] text-slate-600">
          <span className="font-bold text-slate-900">{money(order.totalCents)}</span>
          <span className="text-slate-400"> incl. GST</span>
        </div>
        {order.outstandingCents > 0 && !DONE.has(order.status.toLowerCase()) ? (
          <span className="rounded-full bg-amber-50 px-3 py-1 text-[13px] font-semibold text-amber-800 ring-1 ring-amber-200">
            {money(order.outstandingCents)} to pay
          </span>
        ) : order.paidCents > 0 ? (
          <span className="text-[13px] font-semibold text-emerald-700">Paid</span>
        ) : null}
      </div>
    </li>
  );
}

function Dashboard({ me, onMe, onSignOut }: {
  me: PrintAccountMe;
  onMe: (me: PrintAccountMe) => void;
  onSignOut: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: me.name ?? "", phone: me.phone ?? "", company: me.company ?? "" });
  const badge = pricingBadge(me);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.me) { onMe(data.me); setEditing(false); }
    } finally { setSaving(false); }
  }

  const open = me.orders.filter((o) => !DONE.has(o.status.toLowerCase()));
  const past = me.orders.filter((o) => DONE.has(o.status.toLowerCase()));
  const inputCls =
    "w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-[15px] text-slate-900 outline-none transition focus:border-[#043bcb] focus:ring-4 focus:ring-[#043bcb]/12";

  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-24 pt-8 sm:pt-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[13px] font-bold uppercase tracking-[0.14em] text-[#043bcb]">United Prints</p>
          <h1 className="mt-1 truncate text-[28px] font-extrabold leading-tight tracking-tight text-slate-900">
            {me.name ? `Hi ${me.name.split(" ")[0]}` : "Your account"}
          </h1>
          <p className="mt-1 truncate text-[14px] text-slate-500">{me.email}</p>
        </div>
        <button
          onClick={onSignOut}
          className="min-h-[44px] rounded-full border border-slate-300 px-5 text-[14px] font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          Sign out
        </button>
      </header>

      {/* Pricing — never claims a discount that is 0. */}
      <div className={`mt-7 rounded-2xl p-5 ${badge.active ? "bg-[#33cc00]/10 ring-1 ring-[#33cc00]/30" : "bg-slate-50 ring-1 ring-slate-200"}`}>
        <p className={`text-[15px] font-bold ${badge.active ? "text-[#1f7a00]" : "text-slate-900"}`}>{badge.label}</p>
        <p className="mt-1 text-[14px] leading-relaxed text-slate-600">{badge.detail}</p>
      </div>

      {/* Totals — derived from the orders shown, so they can never disagree. */}
      <dl className="mt-5 grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <dt className="text-[13px] font-semibold text-slate-500">Orders with us</dt>
          <dd className="mt-1 text-[26px] font-extrabold tabular-nums text-slate-900">{me.orderCount}</dd>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <dt className="text-[13px] font-semibold text-slate-500">Paid to date</dt>
          <dd className="mt-1 text-[26px] font-extrabold tabular-nums text-slate-900">{money(me.lifetimeSpentCents)}</dd>
        </div>
      </dl>

      <section className="mt-9">
        <h2 className="text-[19px] font-extrabold tracking-tight text-slate-900">
          {open.length > 0 ? "In progress" : "Your orders"}
        </h2>

        {me.orders.length === 0 ? (
          // 🔴 A real, correct answer — not an error, and not a blank screen.
          <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
            <p className="text-[16px] font-bold text-slate-900">No orders yet</p>
            <p className="mx-auto mt-2 max-w-sm text-[14px] leading-relaxed text-slate-600">
              Anything you order from us will show up here — what stage it's at, what's due, and what you've paid.
            </p>
            <a
              href="https://unitedprints.co.nz/instant-quote"
              className="mt-5 inline-flex min-h-[48px] items-center rounded-full bg-[#33cc00] px-6 text-[14px] font-bold uppercase tracking-wide text-white transition hover:brightness-95"
            >
              Get an instant quote
            </a>
          </div>
        ) : (
          <ul className="mt-4 space-y-3">
            {(open.length > 0 ? open : past).map((o) => <OrderCard key={o.id} order={o} />)}
          </ul>
        )}

        {open.length > 0 && past.length > 0 && (
          <>
            <h2 className="mt-9 text-[19px] font-extrabold tracking-tight text-slate-900">Completed</h2>
            <ul className="mt-4 space-y-3">
              {past.map((o) => <OrderCard key={o.id} order={o} />)}
            </ul>
          </>
        )}
      </section>

      <section className="mt-10">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[19px] font-extrabold tracking-tight text-slate-900">Your details</h2>
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="min-h-[44px] text-[14px] font-semibold text-[#043bcb] underline-offset-4 hover:underline"
            >
              Edit
            </button>
          )}
        </div>

        {editing ? (
          <form onSubmit={save} className="mt-4 space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
            {([
              ["name", "Name", "name"],
              ["company", "Business", "organization"],
              ["phone", "Phone", "tel"],
            ] as const).map(([key, label, ac]) => (
              <div key={key}>
                <label htmlFor={`up-${key}`} className="mb-2 block text-sm font-semibold text-slate-800">{label}</label>
                <input
                  id={`up-${key}`} autoComplete={ac}
                  value={(form as any)[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  className={inputCls}
                />
              </div>
            ))}
            <div className="flex flex-wrap gap-3 pt-1">
              <button
                type="submit" disabled={saving}
                className="min-h-[48px] flex-1 rounded-full bg-[#043bcb] px-6 text-[14px] font-bold text-white transition hover:brightness-110 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button" onClick={() => setEditing(false)}
                className="min-h-[48px] rounded-full border border-slate-300 px-6 text-[14px] font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <dl className="mt-4 divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white px-5">
            {([
              ["Name", me.name],
              ["Business", me.company],
              ["Phone", me.phone],
            ] as const).map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-4 py-3.5">
                <dt className="text-[14px] font-semibold text-slate-500">{label}</dt>
                {/* Blank is "not told us", never an invented value. */}
                <dd className={`text-[15px] ${value ? "text-slate-900" : "text-slate-400"}`}>{value || "Not set"}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PrintAccountPage() {
  const [me, setMe] = useState<PrintAccountMe | null>(null);
  const [state, setState] = useState<"loading" | "anon" | "ready" | "error">("loading");

  async function load() {
    try {
      const res = await fetch(`${BASE}/me`, { headers: { Accept: "application/json" } });
      if (res.status === 401) { setState("anon"); return; }
      if (!res.ok) { setState("error"); return; }
      const data = await res.json();
      setMe(data.me); setState("ready");
    } catch {
      // 🔴 A failed request is NOT "signed out" — telling someone to sign in
      // again when they already are, because the network blipped, is how a
      // customer concludes the portal is broken.
      setState("error");
    }
  }

  useEffect(() => { void load(); }, []);

  async function signOut() {
    await fetch(`${BASE}/logout`, { method: "POST" }).catch(() => {});
    setMe(null); setState("anon");
  }

  return (
    <div className="min-h-screen bg-[#f7faff] font-[Poppins,system-ui,-apple-system,'Segoe_UI',sans-serif] antialiased">
      {state === "loading" && (
        <div className="flex min-h-screen items-center justify-center px-5">
          <p className="text-[15px] text-slate-500">Loading your account…</p>
        </div>
      )}

      {state === "error" && (
        <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-5 text-center">
          <p className="text-[17px] font-bold text-slate-900">We couldn't load your account</p>
          <p className="mt-2 text-[14px] leading-relaxed text-slate-600">
            That's on our end, not yours — you're still signed in. Try again in a moment.
          </p>
          <button
            onClick={() => { setState("loading"); void load(); }}
            className="mt-6 min-h-[48px] rounded-full bg-[#043bcb] px-7 text-[14px] font-bold text-white transition hover:brightness-110"
          >
            Try again
          </button>
        </div>
      )}

      {state === "anon" && <SignIn onSignedIn={(m) => { setMe(m); setState("ready"); }} />}
      {state === "ready" && me && <Dashboard me={me} onMe={setMe} onSignOut={signOut} />}
    </div>
  );
}
