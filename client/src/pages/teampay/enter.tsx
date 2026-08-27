/**
 * Team Pay — entering a team.
 *
 * 🔴 Costs nothing and asks for no card. Isaac's spec: "the manager does not
 * need to pay anything upfront to register their team — they enter the team,
 * get the dashboard, and can pay their own share whenever, same as everyone
 * else on the team."
 */
import { useMemo, useState } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { brandFor, shareCents } from "@shared/teampay";
import {
  Button, Card, Field, Loading, NotFoundPage, Notice, TeampayShell, inputStyle, money,
} from "./shell";

const api = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.message || "Something went wrong.");
  return body;
};

export default function TeampayEnterPage() {
  const [, params] = useRoute("/enter/:slug");
  const slug = params?.slug || "";

  const { data: comp, isLoading, isError } = useQuery<any>({
    queryKey: ["teampay-comp", slug],
    queryFn: () => api(`/api/public/teampay/competition/${slug}`),
    enabled: !!slug,
    retry: false,
  });

  const brand = useMemo(() => brandFor(comp?.brand), [comp?.brand]);
  const [form, setForm] = useState({
    teamName: "", community: "", managerName: "", managerEmail: "", managerPhone: "",
    squadSize: "", managerPlays: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (isLoading) return <TeampayShell brand={brand}><Loading brand={brand} /></TeampayShell>;
  if (isError || !comp) return <NotFoundPage />;

  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const size = Number(form.squadSize || comp.defaultSquadSize);
  const per = size > 0 ? shareCents(comp.feeCents, size) : 0;

  if (done) {
    return (
      <TeampayShell brand={brand} eyebrow={comp.name} title="You're entered">
        <Card brand={brand} className="p-6">
          <p className="text-[15px] leading-relaxed">
            <strong>{form.teamName}</strong> is in. We've emailed{" "}
            <strong>{form.managerEmail}</strong> a link to your team page — that's where you add
            your squad and see who has paid.
          </p>
          <div className="mt-5">
            <Button brand={brand} onClick={() => { window.location.href = done; }} className="w-full">
              Open your team page
            </Button>
          </div>
          <p className="mt-3 text-[12px]" style={{ color: brand.mute }}>
            Bookmark it. Anyone with that link can manage your team.
          </p>
        </Card>
      </TeampayShell>
    );
  }

  if (!comp.entriesOpen) {
    return (
      <TeampayShell brand={brand} eyebrow={comp.name} title="Entries aren't open yet">
        <Card brand={brand} className="p-6">
          <p className="text-[15px] leading-relaxed" style={{ color: brand.mute }}>
            Team entries for the {comp.name} haven't opened. Check the tournament page for when
            they do.
          </p>
        </Card>
      </TeampayShell>
    );
  }

  return (
    <TeampayShell brand={brand} eyebrow={comp.name} title="Enter your team">
      <Card brand={brand} className="mb-5 p-5">
        <div className="flex items-baseline justify-between">
          <span className="text-[14px]" style={{ color: brand.mute }}>Team fee</span>
          <span className="text-[24px] font-bold" style={{ fontFamily: brand.fontHeading }}>
            {money(comp.feeCents)}
          </span>
        </div>
        <p className="mt-3 text-[14px] leading-relaxed" style={{ color: brand.mute }}>
          Split across your squad — <strong style={{ color: brand.accent }}>{money(per)} each</strong>{" "}
          for {size} players. <strong style={{ color: brand.ink }}>Nothing to pay now.</strong> Enter
          your team, add your squad, and everyone pays their own share on their own card.
        </p>
        {!comp.paymentsEnabled && (
          <div className="mt-4">
            <Notice brand={brand} tone="warn">
              Payment isn't switched on yet — you can enter and build your squad now.
            </Notice>
          </div>
        )}
      </Card>

      <Card brand={brand} className="p-5 sm:p-6">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true); setError(null);
            try {
              const r = await api(`/api/public/teampay/competition/${slug}/enter`, {
                method: "POST",
                body: JSON.stringify({ ...form, squadSize: size }),
              });
              setDone(r.dashboardUrl);
            } catch (err: any) { setError(err.message); }
            finally { setBusy(false); }
          }}
        >
          <Field brand={brand} label="Team name">
            <input required value={form.teamName} onChange={(e) => set("teamName", e.target.value)}
                   style={inputStyle(brand)} placeholder="e.g. Samoa United" />
          </Field>

          <Field brand={brand} label="Community you're representing" hint="Optional — the point of the Cup.">
            <input value={form.community} onChange={(e) => set("community", e.target.value)}
                   style={inputStyle(brand)} placeholder="e.g. Samoan community" />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field brand={brand} label="Your name">
              <input required value={form.managerName} onChange={(e) => set("managerName", e.target.value)}
                     style={inputStyle(brand)} autoComplete="name" />
            </Field>
            <Field brand={brand} label="Your mobile">
              <input type="tel" value={form.managerPhone} onChange={(e) => set("managerPhone", e.target.value)}
                     style={inputStyle(brand)} autoComplete="tel" />
            </Field>
          </div>

          <Field brand={brand} label="Your email" hint="Your team page link goes here — use one you check.">
            <input required type="email" value={form.managerEmail}
                   onChange={(e) => set("managerEmail", e.target.value)}
                   style={inputStyle(brand)} autoComplete="email" />
          </Field>

          <Field brand={brand} label="How many players in your squad?"
                 hint={`${money(comp.feeCents)} ÷ ${size} = ${money(per)} each. You can change this until someone pays.`}>
            <input type="number" inputMode="numeric" min={1} max={40}
                   value={form.squadSize} placeholder={String(comp.defaultSquadSize)}
                   onChange={(e) => set("squadSize", e.target.value)} style={inputStyle(brand)} />
          </Field>

          {/* The whole label is the tap target — 44px tall, and tapping the words
              toggles the box. The box itself is 22px so a thumb can find it. */}
          <label className="flex items-center gap-3 text-[14px]" style={{ minHeight: 44, cursor: "pointer" }}>
            <input type="checkbox" checked={form.managerPlays}
                   onChange={(e) => set("managerPlays", e.target.checked)}
                   style={{ width: 22, height: 22, flexShrink: 0, accentColor: brand.accent }} />
            <span>I'm playing too — put me on the squad and give me a share to pay.</span>
          </label>

          {error && <Notice brand={brand} tone="error">{error}</Notice>}

          <Button brand={brand} type="submit" disabled={busy} className="w-full">
            {busy ? <Loader2 size={17} className="mr-2 animate-spin" /> : null}
            Enter {form.teamName || "your team"}
          </Button>
        </form>
      </Card>
    </TeampayShell>
  );
}
