// USG Studio — guided create flow. Route: /admin/studio/new.
//
// Foolproof by design: never a blank prompt box. Pick a brand, pick the format,
// answer five short questions, hit Generate. Studio writes + themes the page and
// drops you into the editor. Admin chrome only (dark ClubOS theme).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Sparkles, ArrowLeft, Check, Wand2, FileText, FileSignature, LayoutTemplate, ExternalLink,
} from "lucide-react";
import type { PageDoc } from "@shared/studio-blocks";
import {
  BRAND_CARDS, TONES, buildBrief, slugify, briefKey, warningsKey,
  type ToneId,
} from "./studio-shared";

interface GenerateResponse {
  content: PageDoc;
  warnings: string[];
  contentHash: string;
  brandId: string;
}

const NARRATION = [
  "Reading your brief…",
  "Framing their upside first…",
  "Writing the offer…",
  "Choosing the sections…",
  "Applying the brand theme…",
  "Almost there…",
];

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="text-sm font-medium text-white/80">{label}</label>
      {hint && <p className="text-xs text-white/35 mt-0.5 mb-1.5">{hint}</p>}
      <div className={hint ? "" : "mt-1.5"}>{children}</div>
    </div>
  );
}

export default function StudioNew() {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const [brand, setBrand] = useState<string>("");
  const [partner, setPartner] = useState("");
  const [dealOneLiner, setDealOneLiner] = useState("");
  const [upside, setUpside] = useState("");
  const [ask, setAsk] = useState("");
  const [notes, setNotes] = useState("");
  const [tone, setTone] = useState<ToneId>("warm");

  const [narrateIdx, setNarrateIdx] = useState(0);
  const narrateTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const canGenerate = !!brand && partner.trim() && dealOneLiner.trim() && upside.trim();

  const generate = useMutation({
    mutationFn: async () => {
      // 1) Generate the page from the assembled brief.
      const brief = buildBrief({ partner, dealOneLiner, upside, ask, notes, tone });
      const genRes = await apiRequest("POST", "/api/admin/studio/generate", { brief });
      const gen: GenerateResponse = await genRes.json();

      // 2) Persist as a draft. The picked brand drives the render theme; the
      //    generated meta.title becomes the doc title.
      const title = gen.content?.meta?.title?.slice(0, 200) || `${partner.trim()} — Partnership Proposal`;
      const sourceTag = `${slugify(partner) || "partner"}-proposal`;
      const createRes = await apiRequest("POST", "/api/admin/studio", {
        brandId: brand,
        title,
        slug: sourceTag,
        sourceTag,
        format: "proposal",
        contentJson: gen.content,
      });
      const created: { id: number; token: string } = await createRes.json();
      return { id: created.id, warnings: gen.warnings ?? [], brief };
    },
    onSuccess: ({ id, warnings, brief }) => {
      // Stash the brief so the editor's whole-page regenerate can reuse it, plus
      // any do-not-say warnings for a one-time banner. (Neither is persisted
      // server-side in v1.)
      try {
        localStorage.setItem(briefKey(id), brief);
        localStorage.setItem(warningsKey(id), JSON.stringify(warnings));
      } catch {
        /* localStorage may be unavailable — non-fatal */
      }
      queryClient.invalidateQueries({ queryKey: ["/api/admin/studio"] });
      if (warnings.length) {
        toast({
          title: "Draft ready — a couple of words to check",
          description: warnings.join(" · "),
        });
      }
      navigate(`/admin/studio/${id}`);
    },
    onError: (e: any) => {
      toast({ title: "Couldn't generate the page", description: friendlyErr(e), variant: "destructive" });
    },
  });

  // Cycle the loading narration while generating.
  useEffect(() => {
    if (generate.isPending) {
      setNarrateIdx(0);
      narrateTimer.current = setInterval(() => setNarrateIdx((i) => Math.min(i + 1, NARRATION.length - 1)), 2200);
    } else if (narrateTimer.current) {
      clearInterval(narrateTimer.current);
      narrateTimer.current = null;
    }
    return () => {
      if (narrateTimer.current) clearInterval(narrateTimer.current);
    };
  }, [generate.isPending]);

  if (generate.isPending) {
    return (
      <div className="p-6">
        <div className="max-w-md mx-auto text-center py-24">
          <div className="w-14 h-14 rounded-2xl bg-amber-400/10 text-amber-400 flex items-center justify-center mx-auto mb-5 animate-pulse">
            <Wand2 className="w-7 h-7" />
          </div>
          <div className="text-white font-semibold text-lg">Building your proposal</div>
          <p className="text-amber-300/80 text-sm mt-2 h-5 transition-all">{NARRATION[narrateIdx]}</p>
          <p className="text-white/30 text-xs mt-6">This usually takes 15–30 seconds.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate("/admin/studio")} className="text-white/40 hover:text-white/70 transition-colors" data-testid="button-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <Sparkles className="w-6 h-6 text-amber-400" /> New proposal
          </h1>
          <p className="text-sm text-white/40 mt-1">Five short answers is all it takes.</p>
        </div>
      </div>

      {/* 1 — Brand */}
      <section className="bg-white/[0.03] border border-white/5 rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-white/80">1. Which brand is this for?</div>
          {brand && (
            <span className="text-[11px] font-medium px-2.5 py-1 rounded-full border border-amber-400/25 bg-amber-400/10 text-amber-300 flex items-center gap-1">
              <Check className="w-3 h-3" /> {BRAND_CARDS.find((b) => b.id === brand)?.name}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {BRAND_CARDS.map((b) => {
            const active = brand === b.id;
            return (
              <button
                key={b.id}
                onClick={() => setBrand(b.id)}
                className={`text-left rounded-xl border p-4 transition-all ${
                  active
                    ? "border-amber-400/50 bg-amber-400/10 shadow-[0_0_12px_rgba(212,175,55,0.12)]"
                    : "border-white/8 bg-white/[0.02] hover:bg-white/[0.05]"
                }`}
                data-testid={`button-brand-${b.id}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white">{b.name}</span>
                  {b.packed ? (
                    <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-400/15 text-emerald-300">Live</span>
                  ) : (
                    <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/8 text-white/40">Interim</span>
                  )}
                </div>
                <div className="text-xs text-white/40 mt-1">{b.note}</div>
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-white/30">More brand packs are coming — until then, other brands use the house look.</p>
      </section>

      {/* 2 — Format */}
      <section className="bg-white/[0.03] border border-white/5 rounded-2xl p-5 space-y-3">
        <div className="text-sm font-semibold text-white/80">2. What are we making?</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-xl border border-amber-400/50 bg-amber-400/10 p-4">
            <LayoutTemplate className="w-5 h-5 text-amber-400" />
            <div className="font-semibold text-white mt-2 text-sm">Partner proposal page</div>
            <div className="text-xs text-white/40 mt-0.5">A full web page you send as a link.</div>
          </div>
          {[
            { icon: FileText, name: "One-pager", note: "Print / PDF summary" },
            { icon: FileSignature, name: "E-sign agreement", note: "Signable contract" },
          ].map((f) => (
            <div key={f.name} className="rounded-xl border border-white/8 bg-white/[0.01] p-4 opacity-50">
              <f.icon className="w-5 h-5 text-white/40" />
              <div className="font-semibold text-white/60 mt-2 text-sm flex items-center gap-1.5">
                {f.name}
                <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/8 text-white/40">Soon</span>
              </div>
              <div className="text-xs text-white/30 mt-0.5">{f.note}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 3 — Guided brief */}
      <section className="bg-white/[0.03] border border-white/5 rounded-2xl p-5 space-y-5">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-white/80">3. Tell Studio the essentials</div>
          <a
            href="/studio-preview"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-amber-300/80 hover:text-amber-300 inline-flex items-center gap-1"
            data-testid="link-see-example"
          >
            See an example <ExternalLink className="w-3 h-3" />
          </a>
        </div>

        <Field label="Who are you pitching?">
          <Input value={partner} onChange={(e) => setPartner(e.target.value)} placeholder="e.g. Go Rentals" data-testid="input-partner" />
        </Field>

        <Field label="The deal in one line">
          <Input value={dealOneLiner} onChange={(e) => setDealOneLiner(e.target.value)} placeholder="e.g. Naming partner for our Saturday kids' league" data-testid="input-deal" />
        </Field>

        <Field label="The one thing they get" hint="Their biggest upside — the page leads with this, not with what we need.">
          <Textarea value={upside} onChange={(e) => setUpside(e.target.value)} rows={2} placeholder="e.g. Your brand in front of 1,200 local families every Saturday, in the happiest two hours of their week." data-testid="input-upside" />
        </Field>

        <Field label="The ask (optional)" hint="Cash or in-kind, plus a rough number if you have one.">
          <Input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="e.g. $7,500 / year, or vehicles for the season" data-testid="input-ask" />
        </Field>

        <Field label="Anything to say or avoid? (optional)">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="e.g. They care about community, not logos on billboards. Don't mention our deficit." data-testid="input-notes" />
        </Field>

        <div>
          <label className="text-sm font-medium text-white/80">Tone</label>
          <div className="flex flex-wrap gap-2 mt-2">
            {TONES.map((t) => (
              <button
                key={t.id}
                onClick={() => setTone(t.id)}
                title={t.hint}
                className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-all ${
                  tone === t.id
                    ? "border-amber-400/50 bg-amber-400/10 text-amber-300"
                    : "border-white/10 bg-white/[0.02] text-white/50 hover:text-white/70"
                }`}
                data-testid={`button-tone-${t.id}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="flex items-center justify-between gap-3 pb-4">
        <p className="text-xs text-white/30">
          {canGenerate ? "Ready when you are." : "Pick a brand and fill the first three fields to continue."}
        </p>
        <Button disabled={!canGenerate || generate.isPending} onClick={() => generate.mutate()} className="gap-1.5" data-testid="button-generate">
          <Wand2 className="w-4 h-4" /> Generate proposal
        </Button>
      </div>
    </div>
  );
}

// apiRequest throws `Error("<status>: <body>")` — turn that into something a
// non-technical staffer can act on.
function friendlyErr(e: any): string {
  const msg = String(e?.message || "");
  if (/^429/.test(msg)) return "The writer is busy right now. Give it a few seconds and try again.";
  if (/^503/.test(msg)) return "The writing service isn't switched on yet. Ask Daniel to add the API key.";
  if (/^422/.test(msg)) return "The page came back malformed. Try again, or simplify the brief.";
  return "Something went wrong. Try again in a moment.";
}
