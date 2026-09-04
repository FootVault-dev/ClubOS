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
import { brandFor, shareCents, type PaymentMode } from "@shared/teampay";
import {
  Button, Card, Field, Loading, NotFoundPage, Notice, TeampayShell, inputStyle, money,
} from "./shell";

const api = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.message || "Something went wrong.");
  return body;
};

/**
 * One of the two ways to pay.
 *
 * 🔴 A radio, not a toggle — two named choices where neither is a "setting" the
 * other is the absence of. And the whole card is the tap target (56px, well over
 * the 44px floor), because this is read on a phone with one thumb.
 */
function ModeChoice({
  brand, checked, onSelect, title, detail,
}: {
  brand: ReturnType<typeof brandFor>;
  checked: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
}) {
  return (
    <label
      className="flex cursor-pointer items-start gap-3 rounded-[10px] border p-3.5 transition-colors"
      style={{
        minHeight: 56,
        borderColor: checked ? brand.accent : brand.line,
        background: checked ? `${brand.accent}14` : "transparent",
      }}
    >
      <input
        type="radio"
        name="paymentMode"
        checked={checked}
        onChange={onSelect}
        style={{ width: 20, height: 20, flexShrink: 0, marginTop: 2, accentColor: brand.accent }}
      />
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold" style={{ color: brand.ink }}>{title}</span>
        <span className="mt-0.5 block text-[13px] leading-snug" style={{ color: brand.mute }}>{detail}</span>
      </span>
    </label>
  );
}

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
    // Split is the default because it is the one that needs no money on the
    // day — a manager who has not collected from anyone yet can still enter.
    paymentMode: "split" as PaymentMode,
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
            <strong>{form.managerEmail}</strong> a link to your team page — that's where{" "}
            {form.paymentMode === "whole"
              ? "you pay the team fee and add your squad."
              : "you add your squad and see who has paid."}
          </p>
          <div className="mt-5">
            <Button brand={brand} onClick={() => { window.location.href = done; }} className="w-full">
              {form.paymentMode === "whole" ? "Open your team page and pay" : "Open your team page"}
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
          {form.paymentMode === "whole" ? (
            <>
              You're paying the <strong style={{ color: brand.accent }}>{money(comp.feeCents)}</strong>{" "}
              team fee yourself. <strong style={{ color: brand.ink }}>Nothing to pay now.</strong> Enter
              your team, then pay it from your team page whenever you're ready.
            </>
          ) : (
            <>
              Split across your squad — <strong style={{ color: brand.accent }}>{money(per)} each</strong>{" "}
              for {size} players. <strong style={{ color: brand.ink }}>Nothing to pay now.</strong> Enter
              your team, add your squad, and everyone pays their own share on their own card.
            </>
          )}
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

          {/* 🔴 Asked BEFORE squad size, because it decides whether the squad
              size is a price at all. In whole mode it is just a roster count. */}
          <Field brand={brand} label="How do you want to pay?">
            <div className="space-y-2">
              <ModeChoice
                brand={brand}
                checked={form.paymentMode === "split"}
                onSelect={() => set("paymentMode", "split")}
                title="Everyone pays their own share"
                detail={`Each player pays ${money(per)} on their own card. You'll see who has paid and can chase the stragglers.`}
              />
              <ModeChoice
                brand={brand}
                checked={form.paymentMode === "whole"}
                onSelect={() => set("paymentMode", "whole")}
                title="I'll pay the whole team fee"
                detail={`One payment of ${money(comp.feeCents)} from you. Nobody on your squad gets asked for anything.`}
              />
            </div>
          </Field>

          <Field brand={brand} label="How many players in your squad?"
                 hint={form.paymentMode === "whole"
                   ? "Just so we know how many to expect — it doesn't change what you pay."
                   : `${money(comp.feeCents)} ÷ ${size} = ${money(per)} each. You can change this until someone pays.`}>
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
            <span>
              {form.paymentMode === "whole"
                ? "I'm playing too — put me on the team sheet."
                : "I'm playing too — put me on the squad and give me a share to pay."}
            </span>
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
