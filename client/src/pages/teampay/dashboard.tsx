/**
 * Team Pay — the team manager's dashboard.
 *
 * The heart of Isaac's spec. A manager opens one link and can see, without
 * asking anybody: who has paid, who has opened their link and not paid, and who
 * has not touched it. Then they nudge, one tap, instead of texting fourteen
 * people individually over three weeks.
 *
 * 🔴 Every row carries a NAME. The spec is explicit that an earlier internal
 * build showed the manager status counts only and was useless.
 */
import { useEffect, useMemo, useState } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import {
  Bell, Check, Copy, CreditCard, Loader2, Lock, Plus, Search, Trash2, UserPlus, Users, X,
} from "lucide-react";
import { brandFor, PLAYER_STATUS_LABEL, type FillinPublic } from "@shared/teampay";
import {
  Button, Card, Field, Loading, NotFoundPage, Notice, Progress, StatusPill,
  TeampayShell, inputStyle, money,
} from "./shell";

const STRIPE_PK = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "";
const stripePromise = STRIPE_PK ? loadStripe(STRIPE_PK) : null;

const api = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.message || "Something went wrong.");
  return body;
};

export default function TeampayDashboard() {
  const [, params] = useRoute("/team/:token");
  const token = params?.token || "";
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: "good" | "error"; text: string } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showFillins, setShowFillins] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery<any>({
    queryKey: ["teampay-team", token],
    queryFn: () => api(`/api/public/teampay/team/${token}`),
    enabled: !!token,
    retry: false,
  });

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 5000);
    return () => clearTimeout(t);
  }, [flash]);

  const brand = useMemo(() => brandFor(data?.competition?.brand), [data?.competition?.brand]);

  if (isLoading) return <TeampayShell brand={brand}><Loading brand={brand} /></TeampayShell>;
  if (isError || !data) return <NotFoundPage />;

  const { competition, entry, players, money: m, shareCents, canResize, holds, teamChargeCents } = data;
  const isWhole = entry.paymentMode === "whole";

  const run = async (key: string, fn: () => Promise<any>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      await refetch();
      if (ok) setFlash({ tone: "good", text: ok });
    } catch (e: any) {
      setFlash({ tone: "error", text: e.message });
    } finally {
      setBusy(null);
    }
  };

  // 🔴 Empty in whole mode by definition. Nobody on this squad was ever asked
  // for money, so "Remind everyone unpaid (14)" would send fourteen people a
  // demand for a share their manager has already covered.
  const outstanding = isWhole
    ? []
    : players.filter((p: any) => p.status === "invited" || p.status === "opened");
  const liveHolds = holds.filter((h: any) => h.live);

  return (
    <TeampayShell brand={brand} wide eyebrow={competition.name} title={entry.teamName}>
      {flash && (
        <div className="mb-5">
          <Notice brand={brand} tone={flash.tone}>{flash.text}</Notice>
        </div>
      )}

      {!competition.paymentsEnabled && (
        <div className="mb-5">
          <Notice brand={brand} tone="warn">
            <strong>Payment isn't open yet.</strong> Build your squad now — everyone gets their
            link and can see what they'll owe. We'll email you the moment it opens.
          </Notice>
        </div>
      )}

      {/* ── the money ─────────────────────────────────────────────────────── */}
      <Card brand={brand} className="mb-5 p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <div>
            <div className="text-[13px]" style={{ color: brand.mute }}>Team fee</div>
            <div className="text-[26px] font-bold" style={{ fontFamily: brand.fontHeading }}>
              {money(entry.feeCents)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[13px]" style={{ color: brand.mute }}>
              {isWhole ? "You're paying" : `${entry.squadSize} players · each pays`}
            </div>
            <div className="text-[26px] font-bold" style={{ fontFamily: brand.fontHeading, color: brand.accent }}>
              {money(isWhole ? entry.feeCents : shareCents)}
            </div>
          </div>
        </div>

        <div className="mt-5">
          <Progress brand={brand} percent={m.percentPaid} />
          <div className="mt-2.5 flex flex-wrap justify-between gap-x-4 text-[13px]" style={{ color: brand.mute }}>
            <span>
              <strong style={{ color: brand.ink }}>{money(m.paidCents)}</strong> in
              {/* In whole mode "0 of 16 paid" is a lie about a team whose fee is
                  settled — nobody was ever going to pay a share. */}
              {!isWhole && <>{" · "}{m.paidCount} of {entry.squadSize} paid</>}
            </span>
            <span>{money(m.outstandingCents)} to go</span>
          </div>
        </div>

        {m.isPaidUp ? (
          <div className="mt-4">
            <Notice brand={brand} tone="good">
              <strong>You're paid up.</strong> Nothing left to chase.
            </Notice>
          </div>
        ) : competition.paymentsEnabled && teamChargeCents > 0 ? (
          <div className="mt-5 border-t pt-5" style={{ borderColor: brand.line }}>
            <TeamPayPanel
              brand={brand}
              token={token}
              amountCents={teamChargeCents}
              isWhole={isWhole}
              onPaid={() => { refetch(); setFlash({ tone: "good", text: "Payment received — thank you." }); }}
            />
          </div>
        ) : null}

        {/* Changing your mind is allowed right up until the fee is settled.
            Switching re-prices nobody — both routes settle the same balance. */}
        {!m.isPaidUp && (
          <div className="mt-4 text-center">
            <button
              className="text-[13px] underline underline-offset-2"
              style={{ color: brand.mute, minHeight: 44 }}
              disabled={busy === "mode"}
              onClick={() => run(
                "mode",
                () => api(`/api/public/teampay/team/${token}/payment-mode`, {
                  method: "PATCH",
                  body: JSON.stringify({ paymentMode: isWhole ? "split" : "whole" }),
                }),
                isWhole
                  ? `Switched — your squad will each be asked for ${money(shareCents)}.`
                  : "Switched — you're paying the team fee and nobody else will be asked.",
              )}
            >
              {isWhole
                ? "Actually, split it across the squad instead"
                : "Actually, I'll pay the whole fee myself"}
            </button>
          </div>
        )}
      </Card>

      {/* ── actions ───────────────────────────────────────────────────────── */}
      <div className="mb-5 flex flex-wrap gap-2.5">
        <Button brand={brand} onClick={() => setShowAdd((v) => !v)}>
          <UserPlus size={16} className="mr-2" /> Add players
        </Button>
        {/* 🔴 Hidden, not disabled, in whole mode. A greyed "Remind everyone
            unpaid (0)" is a control that can never do anything on this team —
            nobody is ever going to owe a share — and dead UI makes a manager
            wonder what they have got wrong. */}
        {!isWhole && <Button
          brand={brand}
          variant="ghost"
          disabled={!outstanding.length || busy === "nudge-all"}
          onClick={() => run("nudge-all", async () => {
            const r = await api(`/api/public/teampay/team/${token}/nudge-all`, { method: "POST" });
            setFlash(r.sent
              ? { tone: "good", text: `Reminder sent to ${r.sent} ${r.sent === 1 ? "player" : "players"}.${r.skipped.length ? ` ${r.skipped.length} skipped.` : ""}` }
              : { tone: "error", text: r.skipped[0]?.reason || "Nobody to remind right now." });
          })}
          title={outstanding.length ? undefined : "Everyone has paid"}
        >
          {busy === "nudge-all" ? <Loader2 size={16} className="mr-2 animate-spin" /> : <Bell size={16} className="mr-2" />}
          Remind everyone unpaid ({outstanding.length})
        </Button>}
        {competition.fillinsOpen && (
          <Button brand={brand} variant="ghost" onClick={() => setShowFillins(true)}>
            <Search size={16} className="mr-2" /> Find a fill-in
            {m.emptySlots > 0 && (
              <span className="ml-2 rounded-full px-2 py-0.5 text-[11px]"
                    style={{ background: brand.accent, color: brand.onAccent }}>
                {m.emptySlots} spot{m.emptySlots === 1 ? "" : "s"}
              </span>
            )}
          </Button>
        )}
      </div>

      {liveHolds.length > 0 && (
        <Card brand={brand} className="mb-5 p-4">
          <div className="text-[13px]" style={{ color: brand.mute }}>
            Waiting on an answer from{" "}
            <strong style={{ color: brand.ink }}>
              {liveHolds.map((h: any) => h.firstName).join(", ")}
            </strong>. They've got 48 hours, then they go back on the list.
          </div>
        </Card>
      )}

      {showAdd && (
        <AddPlayers
          brand={brand}
          token={token}
          emptySlots={m.emptySlots}
          onDone={(msg) => { setShowAdd(false); setFlash({ tone: "good", text: msg }); refetch(); }}
          onError={(msg) => setFlash({ tone: "error", text: msg })}
          onClose={() => setShowAdd(false)}
        />
      )}

      {/* ── the squad ─────────────────────────────────────────────────────── */}
      <Card brand={brand} className="overflow-hidden">
        <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: brand.line }}>
          <h2 className="text-[15px] font-semibold">
            <Users size={15} className="mr-2 inline align-[-2px]" />
            Your squad
          </h2>
          <SquadSize
            brand={brand} token={token} current={entry.squadSize} canResize={canResize}
            onDone={(msg, tone) => { setFlash({ tone, text: msg }); refetch(); }}
          />
        </div>

        {players.length === 0 ? (
          <div className="px-5 py-12 text-center text-[14px]" style={{ color: brand.mute }}>
            Nobody on your squad yet. Add your players and each one gets their own payment link.
          </div>
        ) : (
          <ul>
            {players.map((p: any) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2.5 border-b px-4 py-3.5 last:border-b-0 sm:px-5"
                style={{ borderColor: brand.line, opacity: p.status === "removed" ? 0.45 : 1 }}
              >
                {/* 🔴 w-full on a phone, flex-1 from sm up.
                    Sharing one line with a status pill and three icon buttons
                    left roughly 120px for the name at 390px, which broke
                    "Bereket Haile" over two lines and fragmented his email into
                    four ("b@exam / ple.com · / reminded / 1×"). Every automated
                    check passed — no overflow, every tap target 44px — because
                    it was ugly rather than broken. Only looking at it found it. */}
                <div className="w-full min-w-0 sm:flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-words text-[15px] font-medium">{p.name}</span>
                    {p.isManager && (
                      <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                            style={{ background: brand.line, color: brand.mute, letterSpacing: ".08em" }}>
                        You
                      </span>
                    )}
                    {p.source === "fillin" && (
                      <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                            style={{ background: brand.line, color: brand.mute, letterSpacing: ".08em" }}>
                        Fill-in
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 break-words text-[12px]" style={{ color: brand.mute }}>
                    {p.email || p.phone}
                    {p.status === "paid" && p.paidCents != null && ` · ${money(p.paidCents)}`}
                    {p.nudgeCount > 0 && p.status !== "paid" &&
                      ` · reminded ${p.nudgeCount}×`}
                  </div>
                </div>

                {/* Status and actions share a line of their own on a phone, and
                    rejoin the name's line from sm up. */}
                <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
                  <StatusPill brand={brand} status={p.status} label={PLAYER_STATUS_LABEL[p.status as keyof typeof PLAYER_STATUS_LABEL]} />

                  <div className="flex shrink-0 items-center gap-1.5">
                  <CopyLink brand={brand} url={p.payUrl} />
                  {(p.status === "invited" || p.status === "opened") && (
                    <Button
                      brand={brand} variant="ghost" className="!px-3"
                      disabled={!p.nudge.allowed || busy === `n${p.id}`}
                      title={p.nudge.reason}
                      onClick={() => run(`n${p.id}`, () =>
                        api(`/api/public/teampay/team/${token}/players/${p.id}/nudge`, { method: "POST" }),
                        `Reminder sent to ${p.name}.`)}
                    >
                      {busy === `n${p.id}`
                        ? <Loader2 size={15} className="animate-spin" />
                        : <Bell size={15} />}
                    </Button>
                  )}
                  {!p.isManager && p.status !== "paid" && (
                    <Button
                      brand={brand} variant="ghost" className="!px-3"
                      disabled={busy === `r${p.id}`}
                      title={`Remove ${p.name}`}
                      onClick={() => run(`r${p.id}`, () =>
                        api(`/api/public/teampay/team/${token}/players/${p.id}`, { method: "DELETE" }),
                        `${p.name} removed.`)}
                    >
                      <Trash2 size={15} />
                    </Button>
                  )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="mt-5 text-[12px] leading-relaxed" style={{ color: brand.mute }}>
        Anyone with this link can manage your team, so keep it to yourself. Your players each get
        their own separate link — sharing yours would let them edit the squad.
      </p>

      {showFillins && (
        <FillinDrawer
          brand={brand} token={token}
          onClose={() => { setShowFillins(false); refetch(); }}
          onFlash={(tone, text) => setFlash({ tone, text })}
        />
      )}
    </TeampayShell>
  );
}

// ── copy one player's link ────────────────────────────────────────────────────
// The manager's real workflow is pasting a link into a WhatsApp thread. It has
// to be one tap, and it has to say it worked.
/**
 * The manager paying, from their own dashboard.
 *
 * 🔴 Shown in BOTH modes, and that is the point. In whole mode it is the only
 * way the fee gets paid. In split mode it is the escape hatch for a manager who
 * has spent two weeks chasing three players and would rather just settle it —
 * which is the single most-requested thing about splitting a bill.
 *
 * The amount is whatever the server says is outstanding, re-read on every load.
 * The page never computes a price.
 */
function TeamPayPanel({
  brand, token, amountCents, isWhole, onPaid,
}: { brand: any; token: string; amountCents: number; isWhole: boolean; onPaid: () => void }) {
  const [open, setOpen] = useState(isWhole);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    api(`/api/public/teampay/team/${token}/pay-intent`, { method: "POST" })
      .then((r) => { if (live) setSecret(r.clientSecret); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
    // 🔴 amountCents is a dependency: two players paying while this panel sits
    // open changes what is owed, and a stale intent would charge the old figure.
  }, [open, token, amountCents]);

  if (!open) {
    return (
      <div>
        <Button brand={brand} variant="ghost" onClick={() => setOpen(true)} className="w-full">
          <CreditCard size={16} className="mr-2" />
          Pay the rest yourself ({money(amountCents)})
        </Button>
        <p className="mt-2 text-center text-[12px]" style={{ color: brand.mute }}>
          Clears what's left on your card. Anyone who's already paid keeps their payment.
        </p>
      </div>
    );
  }

  if (!STRIPE_PK) {
    return (
      <Notice brand={brand} tone="error">
        Card payments aren't available on this page right now. Please get in touch with us.
      </Notice>
    );
  }
  if (error) {
    return (
      <div className="space-y-3">
        <Notice brand={brand} tone="error">{error}</Notice>
        {!isWhole && (
          <Button brand={brand} variant="quiet" onClick={() => setOpen(false)} className="w-full">
            Never mind
          </Button>
        )}
      </div>
    );
  }
  if (!secret) {
    return (
      <div className="p-2 text-center text-[14px]" style={{ color: brand.mute }}>
        <Loader2 size={18} className="mx-auto mb-2 animate-spin" />
        Getting the payment ready…
      </div>
    );
  }

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret: secret,
        // Pinned dark for the same reason the player page pins it: left to
        // Stripe's default, the card inputs are near-invisible on black.
        appearance: {
          theme: "night",
          variables: {
            colorPrimary: brand.accent,
            colorBackground: brand.bg,
            colorText: brand.ink,
            colorTextPlaceholder: brand.mute,
            colorDanger: "#FF6961",
            fontFamily: "Inter, system-ui, sans-serif",
            borderRadius: "10px",
          },
        },
      }}
    >
      <TeamPayForm
        brand={brand} token={token} amountCents={amountCents}
        isWhole={isWhole} onPaid={onPaid} onCancel={() => setOpen(false)}
      />
    </Elements>
  );
}

function TeamPayForm({
  brand, token, amountCents, isWhole, onPaid, onCancel,
}: {
  brand: any; token: string; amountCents: number;
  isWhole: boolean; onPaid: () => void; onCancel: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);

    const { error: err } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
      confirmParams: { return_url: window.location.href },
    });
    if (err) {
      setError(err.message || "That card was declined. Try another one.");
      setBusy(false);
      return;
    }

    // 🔴 Ask OUR server, which asks Stripe. The browser saying "it worked" is
    // not evidence that money moved.
    try {
      const r = await api(`/api/public/teampay/team/${token}/pay-confirm`, { method: "POST" });
      if (r.paid) onPaid();
      else setError("Your bank is still processing that. Give it a moment and refresh.");
    } catch (e: any) {
      setError(e.message);
    }
    setBusy(false);
  };

  return (
    <div>
      <div className="mb-4 text-[13px]" style={{ color: brand.mute }}>
        Paying <strong style={{ color: brand.ink }}>{money(amountCents)}</strong>
        {isWhole ? " — the whole team fee." : " — everything still owing on your team."}
      </div>
      <PaymentElement options={{ layout: "tabs" }} />
      {error && <div className="mt-4"><Notice brand={brand} tone="error">{error}</Notice></div>}
      <div className="mt-5">
        <Button brand={brand} onClick={submit} disabled={!stripe || busy} className="w-full">
          {busy ? <Loader2 size={17} className="mr-2 animate-spin" /> : <Lock size={15} className="mr-2" />}
          Pay {money(amountCents)}
        </Button>
      </div>
      <p className="mt-3 text-center text-[12px]" style={{ color: brand.mute }}>
        Card details go straight to Stripe. We never see or store them.
      </p>
      {!isWhole && (
        <div className="mt-3 text-center">
          <button className="text-[13px] underline underline-offset-2"
                  style={{ color: brand.mute, minHeight: 44 }} onClick={onCancel}>
            Never mind — I'll keep chasing
          </button>
        </div>
      )}
    </div>
  );
}

function CopyLink({ brand, url }: { brand: any; url: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      brand={brand} variant="ghost" className="!px-3"
      title="Copy this player's payment link"
      onClick={async () => {
        try { await navigator.clipboard.writeText(url); }
        catch {
          // clipboard is blocked outside a secure context and on some in-app
          // browsers — fall back rather than silently doing nothing.
          window.prompt("Copy this link", url);
        }
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? <Check size={15} style={{ color: "#34C759" }} /> : <Copy size={15} />}
    </Button>
  );
}

// ── squad size ────────────────────────────────────────────────────────────────
function SquadSize({
  brand, token, current, canResize, onDone,
}: { brand: any; token: string; current: number; canResize: boolean; onDone: (m: string, t: "good" | "error") => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(current));
  const [saving, setSaving] = useState(false);

  if (!canResize) {
    return (
      <span className="text-[12px]" style={{ color: brand.mute }}
            title="Someone has paid, so everyone's share is locked in">
        {current} players · locked
      </span>
    );
  }
  if (!editing) {
    return (
      <button className="text-[12px] underline underline-offset-2" style={{ color: brand.mute, minHeight: 44 }}
              onClick={() => setEditing(true)}>
        {current} players · change
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <input
        type="number" inputMode="numeric" min={1} max={40} value={value}
        onChange={(e) => setValue(e.target.value)}
        style={{ ...inputStyle(brand), width: 84, padding: "8px 10px", minHeight: 40 }}
      />
      <Button
        brand={brand} className="!px-4" disabled={saving}
        onClick={async () => {
          setSaving(true);
          try {
            await api(`/api/public/teampay/team/${token}/squad-size`, {
              method: "PATCH", body: JSON.stringify({ squadSize: Number(value) }),
            });
            setEditing(false);
            onDone(`Squad set to ${value} — that's ${""}each player's share updated.`, "good");
          } catch (e: any) { onDone(e.message, "error"); }
          finally { setSaving(false); }
        }}
      >
        {saving ? <Loader2 size={15} className="animate-spin" /> : "Save"}
      </Button>
      <Button brand={brand} variant="quiet" className="!px-2" onClick={() => setEditing(false)}>
        <X size={16} />
      </Button>
    </div>
  );
}

// ── add players ───────────────────────────────────────────────────────────────
function AddPlayers({
  brand, token, emptySlots, onDone, onError, onClose,
}: {
  brand: any; token: string; emptySlots: number;
  onDone: (m: string) => void; onError: (m: string) => void; onClose: () => void;
}) {
  const [rows, setRows] = useState([{ name: "", email: "", phone: "" }]);
  const [saving, setSaving] = useState(false);

  const set = (i: number, k: string, v: string) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, [k]: v } : row)));

  return (
    <Card brand={brand} className="mb-5 p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[15px] font-semibold">Add players</h3>
          <p className="mt-1 text-[13px]" style={{ color: brand.mute }}>
            An email or a mobile — either is enough. We'll only email the ones with an
            address; for the rest, copy their link and text it.
          </p>
        </div>
        <Button brand={brand} variant="quiet" className="!px-2" onClick={onClose}><X size={18} /></Button>
      </div>

      <div className="space-y-3">
        {rows.map((row, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1.1fr_1.4fr_1fr]">
            <input placeholder="Name" value={row.name} onChange={(e) => set(i, "name", e.target.value)}
                   style={inputStyle(brand)} autoComplete="off" />
            <input placeholder="Email (optional)" type="email" value={row.email}
                   onChange={(e) => set(i, "email", e.target.value)} style={inputStyle(brand)} autoComplete="off" />
            <input placeholder="Mobile (optional)" type="tel" value={row.phone}
                   onChange={(e) => set(i, "phone", e.target.value)} style={inputStyle(brand)} autoComplete="off" />
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <Button brand={brand} variant="ghost"
                onClick={() => setRows((r) => [...r, { name: "", email: "", phone: "" }])}>
          <Plus size={15} className="mr-1.5" /> Another
        </Button>
        <Button
          brand={brand} disabled={saving || rows.every((r) => !r.name.trim())}
          onClick={async () => {
            setSaving(true);
            try {
              const r = await api(`/api/public/teampay/team/${token}/players`, {
                method: "POST",
                body: JSON.stringify({ players: rows.filter((x) => x.name.trim()) }),
              });
              // 🔴 Partial success is the normal case — three good rows and one
              // duplicate. Say exactly what happened to which player rather than
              // a blanket "saved" or a blanket failure.
              if (r.added && !r.rejected.length) onDone(`${r.added} player${r.added === 1 ? "" : "s"} added.`);
              else if (r.added) onDone(`${r.added} added. Not added: ${r.rejected.map((x: any) => `${x.name} (${x.reason})`).join(", ")}`);
              else onError(r.rejected.map((x: any) => `${x.name}: ${x.reason}`).join(" · ") || "Nothing added.");
              setRows([{ name: "", email: "", phone: "" }]);
            } catch (e: any) { onError(e.message); }
            finally { setSaving(false); }
          }}
        >
          {saving ? <Loader2 size={15} className="mr-2 animate-spin" /> : null}
          Add to squad
        </Button>
        <span className="text-[12px]" style={{ color: brand.mute }}>
          {emptySlots} spot{emptySlots === 1 ? "" : "s"} left
        </span>
      </div>
    </Card>
  );
}

// ── the fill-in marketplace ───────────────────────────────────────────────────
function FillinDrawer({
  brand, token, onClose, onFlash,
}: { brand: any; token: string; onClose: () => void; onFlash: (t: "good" | "error", m: string) => void }) {
  const [asking, setAsking] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [openNote, setOpenNote] = useState<number | null>(null);

  const { data, isLoading, refetch } = useQuery<any>({
    queryKey: ["teampay-fillins", token],
    queryFn: () => api(`/api/public/teampay/team/${token}/fill-ins`),
    retry: false,
  });

  const fillins: FillinPublic[] = data?.fillins ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
         style={{ background: "rgba(0,0,0,0.72)" }} onClick={onClose}>
      <div
        className="max-h-[88dvh] w-full overflow-y-auto rounded-t-2xl sm:max-w-2xl sm:rounded-2xl"
        style={{ background: brand.card, border: `1px solid ${brand.line}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-start justify-between gap-4 border-b px-5 py-4"
             style={{ background: brand.card, borderColor: brand.line }}>
          <div>
            <h3 className="text-[16px] font-semibold" style={{ color: brand.ink }}>Players looking for a team</h3>
            <p className="mt-1 text-[13px]" style={{ color: brand.mute }}>
              Ask one and we'll email them your team's details. They say yes or no — you'll get
              their contact details when they accept.
            </p>
          </div>
          <Button brand={brand} variant="quiet" className="!px-2" onClick={onClose}><X size={18} /></Button>
        </div>

        <div className="p-5">
          {typeof data?.holdsLeft === "number" && data.holdsLeft === 0 && (
            <div className="mb-4">
              <Notice brand={brand} tone="warn">
                You've asked as many players as you can at once. Wait for one to answer.
              </Notice>
            </div>
          )}

          {isLoading ? (
            <Loading brand={brand} />
          ) : fillins.length === 0 ? (
            <p className="py-10 text-center text-[14px]" style={{ color: brand.mute }}>
              Nobody on the list right now. Check back — players join it all the time.
            </p>
          ) : (
            <ul className="space-y-3">
              {fillins.map((f) => (
                <li key={f.id} className="rounded-xl p-4" style={{ border: `1px solid ${brand.line}` }}>
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <span className="text-[15px] font-semibold" style={{ color: brand.ink }}>{f.firstName}</span>
                    {f.position && <span className="text-[13px]" style={{ color: brand.accent }}>{f.position}</span>}
                    {f.ability && <span className="text-[12px]" style={{ color: brand.mute }}>· {f.ability}</span>}
                  </div>
                  <div className="mt-1.5 space-y-0.5 text-[13px]" style={{ color: brand.mute }}>
                    {f.highestLevel && <div>Highest level: {f.highestLevel}</div>}
                    {f.fromWhere && <div>From: {f.fromWhere}</div>}
                    {f.motivation && <div>Wants to: {f.motivation.toLowerCase()}</div>}
                    {f.note && <div className="italic" style={{ color: brand.ink }}>“{f.note}”</div>}
                  </div>

                  {openNote === f.id ? (
                    <div className="mt-3 space-y-2.5">
                      <textarea
                        placeholder="Add a note — where and when you train, what position you need…"
                        value={note} onChange={(e) => setNote(e.target.value)} rows={3}
                        style={{ ...inputStyle(brand), minHeight: 80, resize: "vertical" }}
                      />
                      <div className="flex gap-2">
                        <Button
                          brand={brand} disabled={asking === f.id}
                          onClick={async () => {
                            setAsking(f.id);
                            try {
                              await api(`/api/public/teampay/team/${token}/fill-ins/${f.id}/request`, {
                                method: "POST", body: JSON.stringify({ note }),
                              });
                              onFlash("good", `Asked ${f.firstName}. They've got 48 hours to answer.`);
                              setOpenNote(null); setNote("");
                              refetch();
                            } catch (e: any) { onFlash("error", e.message); refetch(); }
                            finally { setAsking(null); }
                          }}
                        >
                          {asking === f.id ? <Loader2 size={15} className="mr-2 animate-spin" /> : null}
                          Send the ask
                        </Button>
                        <Button brand={brand} variant="quiet" onClick={() => setOpenNote(null)}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3">
                      <Button brand={brand} variant="ghost" disabled={data?.holdsLeft === 0}
                              onClick={() => { setOpenNote(f.id); setNote(""); }}>
                        Ask {f.firstName} to join
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
