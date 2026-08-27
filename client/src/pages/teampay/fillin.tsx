/**
 * Team Pay — the fill-in signup, and the reply page a held player lands on.
 *
 * Replaces Isaac's informal "fill-ins" group chat. The questions are his, from
 * the spec — including "where are you from", which is there because several
 * fill-ins are newcomers to Christchurch with nobody to form a team with, and
 * that is exactly the context a manager picks them on.
 */
import { useMemo, useState } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import {
  brandFor, FILLIN_ABILITIES, FILLIN_MOTIVATIONS, FILLIN_POSITIONS,
} from "@shared/teampay";
import {
  Button, Card, Field, Loading, NotFoundPage, Notice, TeampayShell, inputStyle, money,
} from "./shell";

const api = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.message || "Something went wrong.");
  return body;
};

// ── signup ────────────────────────────────────────────────────────────────────

export default function TeampayFillinPage() {
  const [, params] = useRoute("/fill-in/:slug");
  const slug = params?.slug || "";

  const { data: comp, isLoading, isError } = useQuery<any>({
    queryKey: ["teampay-comp", slug],
    queryFn: () => api(`/api/public/teampay/competition/${slug}`),
    enabled: !!slug,
    retry: false,
  });

  const brand = useMemo(() => brandFor(comp?.brand), [comp?.brand]);
  const [f, setF] = useState({
    firstName: "", lastName: "", email: "", phone: "",
    position: "", ability: "", highestLevel: "", fromWhere: "", motivation: "", note: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (isLoading) return <TeampayShell brand={brand}><Loading brand={brand} /></TeampayShell>;
  if (isError || !comp) return <NotFoundPage />;

  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  if (done) {
    return (
      <TeampayShell brand={brand} eyebrow={comp.name} title="You're on the list">
        <Card brand={brand} className="p-6 text-center">
          <CheckCircle2 size={40} className="mx-auto mb-3" style={{ color: "#34C759" }} />
          <p className="text-[15px] leading-relaxed">
            Team managers who are short a player will see your profile. If one wants you, we'll
            email you their team's details and you decide.
          </p>
          <p className="mt-4 text-[13px]" style={{ color: brand.mute }}>
            Managers can't see your email address or phone number until you say yes.
          </p>
        </Card>
      </TeampayShell>
    );
  }

  if (!comp.fillinsOpen) {
    return (
      <TeampayShell brand={brand} eyebrow={comp.name} title="Not open yet">
        <Card brand={brand} className="p-6">
          <p className="text-[15px]" style={{ color: brand.mute }}>
            The fill-in list for the {comp.name} isn't open yet. Check back closer to the tournament.
          </p>
        </Card>
      </TeampayShell>
    );
  }

  return (
    <TeampayShell brand={brand} eyebrow={comp.name} title="No team? Get on the list">
      <Card brand={brand} className="mb-5 p-5">
        <p className="text-[14px] leading-relaxed" style={{ color: brand.mute }}>
          Tell us a bit about yourself and team managers who are a player short can ask you to
          join them. You'll get their team's details and can say yes or no — nothing is decided
          without you.
          <br /><br />
          If you join a team, you pay one share of that team's fee, the same as everyone else on it.
        </p>
      </Card>

      <Card brand={brand} className="p-5 sm:p-6">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true); setError(null);
            try {
              await api(`/api/public/teampay/competition/${slug}/fill-in`, {
                method: "POST", body: JSON.stringify(f),
              });
              setDone(true);
            } catch (err: any) { setError(err.message); }
            finally { setBusy(false); }
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field brand={brand} label="First name">
              <input required value={f.firstName} onChange={(e) => set("firstName", e.target.value)}
                     style={inputStyle(brand)} autoComplete="given-name" />
            </Field>
            <Field brand={brand} label="Last name">
              <input value={f.lastName} onChange={(e) => set("lastName", e.target.value)}
                     style={inputStyle(brand)} autoComplete="family-name" />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field brand={brand} label="Email">
              <input required type="email" value={f.email} onChange={(e) => set("email", e.target.value)}
                     style={inputStyle(brand)} autoComplete="email" />
            </Field>
            <Field brand={brand} label="Mobile">
              <input type="tel" value={f.phone} onChange={(e) => set("phone", e.target.value)}
                     style={inputStyle(brand)} autoComplete="tel" />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field brand={brand} label="Where do you play?">
              <select value={f.position} onChange={(e) => set("position", e.target.value)} style={inputStyle(brand)}>
                <option value="">Choose…</option>
                {FILLIN_POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
            <Field brand={brand} label="How would you rate yourself?">
              <select value={f.ability} onChange={(e) => set("ability", e.target.value)} style={inputStyle(brand)}>
                <option value="">Choose…</option>
                {FILLIN_ABILITIES.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </Field>
          </div>

          <Field brand={brand} label="Highest level you've played"
                 hint="Optional — club, school, national league, wherever.">
            <input value={f.highestLevel} onChange={(e) => set("highestLevel", e.target.value)}
                   style={inputStyle(brand)} placeholder="e.g. club first team back home" />
          </Field>

          <Field brand={brand} label="Where are you from?"
                 hint="New to Christchurch? Say so — teams like knowing.">
            <input value={f.fromWhere} onChange={(e) => set("fromWhere", e.target.value)}
                   style={inputStyle(brand)} placeholder="e.g. Colombia, here 3 months" />
          </Field>

          <Field brand={brand} label="What are you after?">
            <select value={f.motivation} onChange={(e) => set("motivation", e.target.value)} style={inputStyle(brand)}>
              <option value="">Choose…</option>
              {FILLIN_MOTIVATIONS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>

          <Field brand={brand} label="Anything else?" hint="Optional. A line or two is plenty.">
            <textarea value={f.note} onChange={(e) => set("note", e.target.value)} rows={3}
                      style={{ ...inputStyle(brand), minHeight: 84, resize: "vertical" }} />
          </Field>

          {error && <Notice brand={brand} tone="error">{error}</Notice>}

          <Button brand={brand} type="submit" disabled={busy} className="w-full">
            {busy ? <Loader2 size={17} className="mr-2 animate-spin" /> : null}
            Put me on the list
          </Button>
          <p className="text-center text-[12px]" style={{ color: brand.mute }}>
            Your contact details stay private until you accept a team.
          </p>
        </form>
      </Card>
    </TeampayShell>
  );
}

// ── the reply page ────────────────────────────────────────────────────────────

/**
 * A held player's yes-or-no. This is the consent step that lets the browse list
 * stay anonymous: contact details are exchanged here and nowhere earlier.
 */
export function TeampayHoldPage() {
  const [, params] = useRoute("/fill-in/reply/:token");
  const token = params?.token || "";
  const [busy, setBusy] = useState<"yes" | "no" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery<any>({
    queryKey: ["teampay-hold", token],
    queryFn: () => api(`/api/public/teampay/hold/${token}`),
    enabled: !!token,
    retry: false,
  });

  const brand = useMemo(() => brandFor(data?.competition?.brand), [data?.competition?.brand]);

  if (isLoading) return <TeampayShell brand={brand}><Loading brand={brand} /></TeampayShell>;
  if (isError || !data) return <NotFoundPage />;

  const { competition, state, team, you, shareCents: share, managerNote } = data;

  if (state === "accepted") {
    return (
      <TeampayShell brand={brand} eyebrow={competition.name} title={`You're in ${team.name}`}>
        <Card brand={brand} className="p-6">
          <CheckCircle2 size={36} className="mb-3" style={{ color: "#34C759" }} />
          <p className="text-[15px] leading-relaxed">
            You're on the squad. Your manager is <strong>{team.managerName}</strong>
            {team.managerEmail ? <> — {team.managerEmail}</> : null}
            {team.managerPhone ? <>, {team.managerPhone}</> : null}.
          </p>
          <p className="mt-3 text-[14px]" style={{ color: brand.mute }}>
            Your share of the team fee is {money(share)}. Check your email for your payment link.
          </p>
        </Card>
      </TeampayShell>
    );
  }

  if (state !== "active") {
    return (
      <TeampayShell brand={brand} eyebrow={competition.name} title="Nothing to answer">
        <Card brand={brand} className="p-6">
          <p className="text-[15px] leading-relaxed" style={{ color: brand.mute }}>
            {state === "declined"
              ? "You turned this one down — you're still on the fill-in list for other teams."
              : "This invitation ran out of time, so you went back on the list. Another team can ask you any time."}
          </p>
        </Card>
      </TeampayShell>
    );
  }

  const answer = async (yes: boolean) => {
    setBusy(yes ? "yes" : "no");
    setError(null);
    try {
      await api(`/api/public/teampay/hold/${token}/${yes ? "accept" : "decline"}`, { method: "POST" });
      await refetch();
    } catch (e: any) { setError(e.message); await refetch(); }
    finally { setBusy(null); }
  };

  return (
    <TeampayShell brand={brand} eyebrow={competition.name} title="A team wants you">
      <Card brand={brand} className="mb-5 p-5 sm:p-6">
        <p className="text-[15px] leading-relaxed">
          Hi {you.firstName} — <strong>{team.name}</strong>
          {team.community ? ` (${team.community})` : ""} is a player short for the{" "}
          {competition.name} and would like you in their squad.
        </p>

        {managerNote && (
          <blockquote className="mt-4 border-l-2 pl-4 text-[14px] italic leading-relaxed"
                      style={{ borderColor: brand.accent }}>
            “{managerNote}”
            <footer className="mt-1.5 not-italic text-[12px]" style={{ color: brand.mute }}>
              — {team.managerName}, manager
            </footer>
          </blockquote>
        )}

        <div className="mt-5 flex items-baseline justify-between border-t pt-4" style={{ borderColor: brand.line }}>
          <span className="text-[13px]" style={{ color: brand.mute }}>Your share of the team fee</span>
          <span className="text-[22px] font-bold" style={{ fontFamily: brand.fontHeading, color: brand.accent }}>
            {money(share)}
          </span>
        </div>
      </Card>

      {error && <div className="mb-4"><Notice brand={brand} tone="error">{error}</Notice></div>}

      <div className="flex flex-col gap-2.5 sm:flex-row">
        <Button brand={brand} disabled={!!busy} onClick={() => answer(true)} className="flex-1">
          {busy === "yes" ? <Loader2 size={16} className="mr-2 animate-spin" /> : null}
          Yes, I'm in
        </Button>
        <Button brand={brand} variant="ghost" disabled={!!busy} onClick={() => answer(false)} className="flex-1">
          {busy === "no" ? <Loader2 size={16} className="mr-2 animate-spin" /> : null}
          No thanks
        </Button>
      </div>
      <p className="mt-4 text-center text-[12px] leading-relaxed" style={{ color: brand.mute }}>
        Say yes and we'll swap contact details with your manager. Say no and you stay on the list.
        Don't answer within 48 hours and you go back on the list automatically.
      </p>
    </TeampayShell>
  );
}
