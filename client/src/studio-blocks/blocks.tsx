// USG Studio — the LOCKED block component library.
//
// One component per block type in `shared/studio-blocks.ts`. Each reads ONLY
// content/data from its block — NO colour or font props. All presentation comes
// from the scoped classes in `studio.css`, which read the brand tokens injected
// by <BrandTheme>. That is the whole point: the same block JSON renders in any
// brand's skin without touching these components.
import { createContext, useContext, type ReactNode } from "react";
import type {
  Block,
  heroBlock,
  sectionBlock,
  statGridBlock,
  quoteBlock,
  imageFeatureBlock,
  logoWallBlock,
  dealOptionsBlock,
  faqBlock,
  proofBlock,
  ctaBlock,
} from "@shared/studio-blocks";
import type { z } from "zod";
import { renderBodyMd } from "./markdown";

type Hero = z.infer<typeof heroBlock>;
type SectionB = z.infer<typeof sectionBlock>;
type StatGridB = z.infer<typeof statGridBlock>;
type QuoteB = z.infer<typeof quoteBlock>;
type ImageFeatureB = z.infer<typeof imageFeatureBlock>;
type LogoWallB = z.infer<typeof logoWallBlock>;
type DealOptionsB = z.infer<typeof dealOptionsBlock>;
type FaqB = z.infer<typeof faqBlock>;
type ProofB = z.infer<typeof proofBlock>;
type CtaB = z.infer<typeof ctaBlock>;

// ── Attribution source ────────────────────────────────────────────────────
// The page passes its `sourceTag` down; only the CTA block needs it (to append
// ?source=<tag> to booking/registration links). Context keeps every block's
// signature uniform (each takes only `block`).
export const StudioSourceContext = createContext<string>("studio");

// ── Asset + CTA resolution ────────────────────────────────────────────────
// `*Ref` fields are stable asset keys. Interim: pass through anything that is
// already a URL / path / data-URI; return null for bare keys (a later asset
// increment resolves those) so components fall back to a themed gradient.
export function resolveAsset(ref?: string | null): string | null {
  if (!ref) return null;
  if (/^(https?:\/\/|data:|\/)/i.test(ref.trim())) return ref.trim();
  return null;
}

function withSource(url: string, sourceTag: string): string {
  const src = encodeURIComponent(sourceTag || "studio");
  return url + (url.includes("?") ? "&" : "?") + "source=" + src;
}

/**
 * Resolve a CTA intent+ref to a real href.
 *  - book_meeting     → https://usg-meet.vercel.app/<ref|daniel/intro-30>?source=<tag>
 *  - register_program → same-origin ClubOS program URL /<ref>?source=<tag>
 *  - external         → the (http/https only) ref, ?source=<tag> appended
 */
export function resolveCta(action: CtaB["action"], sourceTag: string): string {
  const ref = (action.ref || "").trim();
  if (action.kind === "book_meeting") {
    let path = ref || "daniel/intro-30";
    if (/^https?:\/\//i.test(path)) return withSource(path, sourceTag);
    if (!path.includes("/")) path = `daniel/${path}`; // bare event slug → daniel's
    return withSource(`https://usg-meet.vercel.app/${path.replace(/^\//, "")}`, sourceTag);
  }
  if (action.kind === "register_program") {
    if (/^https?:\/\//i.test(ref)) return withSource(ref, sourceTag);
    return withSource(`/${ref.replace(/^\//, "")}`, sourceTag);
  }
  // external — only http/https is allowed; anything else is inert
  if (/^https?:\/\//i.test(ref)) return withSource(ref, sourceTag);
  return "#";
}

const CTA_VERB: Record<CtaB["action"]["kind"], string> = {
  book_meeting: "Book a call with Daniel",
  register_program: "Register now",
  external: "Find out more",
};

// ── Shared scoped primitives ───────────────────────────────────────────────

/** Split a headline on **markers** → serif gold-soft "wink" spans. */
function Accented({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\*\*([^*]+)\*\*$/.exec(p);
        return m ? (
          <span key={i} className="s-serif s-gold-soft">
            {m[1]}
          </span>
        ) : (
          <span key={i}>{p}</span>
        );
      })}
    </>
  );
}

function SectionShell({
  children,
  alt = false,
  className = "",
}: {
  children: ReactNode;
  alt?: boolean;
  className?: string;
}) {
  return (
    <section className={`relative border-t border-white/5 py-20 sm:py-28 ${alt ? "s-alt" : ""} ${className}`}>
      <div className="relative z-10 mx-auto w-full max-w-6xl px-5 sm:px-8">{children}</div>
    </section>
  );
}

function Heading({ text }: { text: string }) {
  return (
    <h2 className="s-display s-reveal text-3xl font-semibold leading-[1.05] tracking-tight text-white sm:text-4xl">
      <Accented text={text} />
    </h2>
  );
}

/** Image tile that degrades to a themed gradient when the ref isn't a URL. */
function MediaTile({ imageRef, className = "" }: { imageRef?: string | null; className?: string }) {
  const src = resolveAsset(imageRef);
  if (src) {
    return (
      <div
        className={`s-media overflow-hidden rounded-3xl border border-white/[0.08] ${className}`}
        style={{ backgroundImage: `url(${src})` }}
        role="img"
      />
    );
  }
  return <div className={`s-media-fallback overflow-hidden rounded-3xl border border-white/[0.08] ${className}`} />;
}

// ── Block components ───────────────────────────────────────────────────────

export function HeroBlock({ block }: { block: Hero }) {
  const bg = resolveAsset(block.imageRef);
  return (
    <header className="relative min-h-[90svh] overflow-hidden">
      {bg ? (
        <>
          <div className="absolute inset-0 s-media" style={{ backgroundImage: `url(${bg})` }} />
          <div
            className="absolute inset-0"
            style={{ background: "linear-gradient(to bottom, rgba(5,5,5,0.7), rgba(5,5,5,0.82), var(--studio-bg))" }}
          />
          <div
            className="absolute inset-0"
            style={{ background: "linear-gradient(to right, rgba(5,5,5,0.85), rgba(5,5,5,0.35), transparent)" }}
          />
        </>
      ) : null}
      <div className="s-aura" />
      <div className="relative z-10 mx-auto flex min-h-[90svh] w-full max-w-6xl flex-col justify-center px-5 py-20 sm:px-8">
        {block.eyebrow ? <span className="s-eyebrow s-reveal block">{block.eyebrow}</span> : null}
        <h1 className="s-display s-reveal mt-6 max-w-4xl text-5xl font-semibold leading-[0.95] tracking-tighter text-white sm:text-7xl">
          <Accented text={block.headline} />
        </h1>
        {block.subhead ? (
          <p className="s-reveal mt-7 max-w-xl text-lg leading-relaxed text-neutral-300">{block.subhead}</p>
        ) : null}
      </div>
    </header>
  );
}

export function SectionBlock({ block }: { block: SectionB }) {
  return (
    <SectionShell>
      <Heading text={block.heading} />
      <div className="s-prose s-reveal mt-5 max-w-2xl text-lg leading-relaxed text-neutral-300/90">
        {renderBodyMd(block.bodyMd)}
      </div>
    </SectionShell>
  );
}

export function StatGridBlock({ block }: { block: StatGridB }) {
  const n = block.stats.length;
  const cols = n >= 4 ? "sm:grid-cols-4" : n === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";
  return (
    <SectionShell>
      <div
        className={`s-reveal grid grid-cols-2 divide-white/[0.06] overflow-hidden rounded-3xl border border-white/[0.08] bg-white/[0.02] ${cols}`}
      >
        {block.stats.map((s, i) => (
          <div key={i} className="border-b border-white/[0.06] px-5 py-7 text-center sm:border-b-0">
            <div className="s-display s-gold text-2xl font-semibold tracking-tight sm:text-3xl">{s.value}</div>
            <div className="mt-1.5 text-[11px] uppercase leading-snug tracking-wider text-neutral-400">{s.label}</div>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

export function QuoteBlock({ block }: { block: QuoteB }) {
  return (
    <SectionShell>
      <div className="s-panel s-panel-gold s-reveal mx-auto max-w-4xl rounded-3xl p-8 sm:p-12">
        <p className="s-serif text-2xl leading-snug text-neutral-100 sm:text-3xl">“{block.quote}”</p>
        <p className="s-eyebrow mt-6">
          {block.attribution}
          {block.role ? ` · ${block.role}` : ""}
        </p>
      </div>
    </SectionShell>
  );
}

export function ImageFeatureBlock({ block }: { block: ImageFeatureB }) {
  const hasText = !!(block.heading || block.bodyMd || block.caption);
  if (!hasText) {
    return (
      <SectionShell>
        <MediaTile imageRef={block.imageRef} className="s-reveal min-h-[320px] w-full" />
      </SectionShell>
    );
  }
  return (
    <SectionShell>
      <div className="grid grid-cols-1 items-stretch gap-5 lg:grid-cols-2">
        <MediaTile imageRef={block.imageRef} className="s-reveal min-h-[280px]" />
        <div className="s-panel s-reveal flex flex-col justify-center rounded-3xl p-8">
          {block.heading ? (
            <h3 className="s-display text-xl font-semibold tracking-tight text-white">{block.heading}</h3>
          ) : null}
          {block.bodyMd ? (
            <div className="s-prose mt-3 text-sm leading-relaxed text-neutral-400">{renderBodyMd(block.bodyMd)}</div>
          ) : null}
          {block.caption ? <p className="s-eyebrow mt-6">{block.caption}</p> : null}
        </div>
      </div>
    </SectionShell>
  );
}

export function LogoWallBlock({ block }: { block: LogoWallB }) {
  return (
    <SectionShell alt>
      {block.heading ? <span className="s-eyebrow s-reveal mb-8 block text-center">{block.heading}</span> : null}
      <div className="s-reveal flex flex-wrap items-center justify-center gap-x-12 gap-y-8">
        {block.logoRefs.map((ref, i) => {
          const src = resolveAsset(ref);
          return src ? (
            <img
              key={i}
              src={src}
              alt=""
              className="h-9 w-auto opacity-60 grayscale transition-all duration-500 hover:opacity-100 hover:grayscale-0 sm:h-11"
            />
          ) : (
            <div key={i} className="h-9 w-24 rounded-lg bg-white/[0.04] sm:h-11" />
          );
        })}
      </div>
    </SectionShell>
  );
}

export function DealOptionsBlock({ block }: { block: DealOptionsB }) {
  const featuredIdx = block.options.length === 3 ? 1 : -1;
  return (
    <SectionShell>
      {block.heading ? <Heading text={block.heading} /> : null}
      <div
        className={`mt-12 grid grid-cols-1 gap-5 ${block.options.length >= 3 ? "md:grid-cols-3" : "md:grid-cols-2"}`}
      >
        {block.options.map((o, i) => {
          const featured = i === featuredIdx;
          return (
            <div
              key={i}
              className={`s-panel s-reveal flex flex-col rounded-3xl p-8 transition-all duration-500 hover:-translate-y-1 ${
                featured ? "s-panel-gold" : ""
              }`}
            >
              <div className={`s-eyebrow ${featured ? "is-gold" : ""}`}>{o.name}</div>
              {o.price ? (
                <div className="s-display mt-4 text-4xl font-semibold tracking-tight text-white">{o.price}</div>
              ) : null}
              {o.summary ? <p className="mt-3 text-sm leading-relaxed text-neutral-400">{o.summary}</p> : null}
              <ul className="mt-6 space-y-3">
                {o.features.map((f, fi) => (
                  <li key={fi} className="flex gap-3 text-sm leading-relaxed text-neutral-300">
                    <span className={`s-bullet ${featured ? "s-bullet-gold" : ""}`} />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
}

export function FaqBlock({ block }: { block: FaqB }) {
  return (
    <SectionShell>
      <div className="s-reveal mx-auto max-w-3xl divide-y divide-white/[0.08] overflow-hidden rounded-3xl border border-white/[0.08] bg-white/[0.02]">
        {block.items.map((it, i) => (
          <details key={i} className="group px-6 py-5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-medium text-white">
              <span>{it.q}</span>
              <span className="s-gold shrink-0 text-xl leading-none transition-transform duration-300 group-open:rotate-45">
                +
              </span>
            </summary>
            <div className="s-prose mt-3 text-sm leading-relaxed text-neutral-400">{renderBodyMd(it.a)}</div>
          </details>
        ))}
      </div>
    </SectionShell>
  );
}

export function ProofBlock({ block }: { block: ProofB }) {
  const n = block.items.length;
  const cols = n >= 4 ? "lg:grid-cols-4" : n === 3 ? "lg:grid-cols-3" : "lg:grid-cols-2";
  return (
    <SectionShell alt>
      {block.heading ? <Heading text={block.heading} /> : null}
      <div className={`mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 ${cols}`}>
        {block.items.map((it, i) => (
          <div
            key={i}
            className="s-panel s-reveal rounded-3xl p-6 transition-all duration-500 hover:-translate-y-1 hover:border-white/20"
          >
            <div className="s-eyebrow is-gold leading-relaxed">{it.label}</div>
            <p className="mt-3 text-sm leading-relaxed text-neutral-400">{it.detail}</p>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

export function CtaBlock({ block }: { block: CtaB }) {
  const sourceTag = useContext(StudioSourceContext);
  const href = resolveCta(block.action, sourceTag);
  return (
    <section className="relative overflow-hidden border-t border-white/5 py-24 sm:py-32">
      <div className="s-aura" />
      <div className="s-grid" />
      <div className="relative z-10 mx-auto w-full max-w-3xl px-5 text-center sm:px-8">
        <span className="s-eyebrow s-reveal block">Next step</span>
        <h2 className="s-display s-reveal mt-6 text-4xl font-semibold tracking-tighter text-white sm:text-5xl">
          <Accented text={block.label} />
        </h2>
        {block.sublabel ? (
          <p className="s-reveal mx-auto mt-6 max-w-md leading-relaxed text-neutral-400">{block.sublabel}</p>
        ) : null}
        <div className="s-reveal mt-10 flex flex-wrap items-center justify-center gap-4">
          <a
            href={href}
            data-studio-cta="1"
            data-cta-kind={block.action.kind}
            className="s-btn-primary rounded-full px-9 py-4 text-sm font-semibold transition-colors"
          >
            {CTA_VERB[block.action.kind]}
          </a>
        </div>
      </div>
    </section>
  );
}

/** type → component map used by <BlockRenderer>. */
export const BLOCK_COMPONENTS: {
  [K in Block["type"]]: (props: { block: Extract<Block, { type: K }> }) => ReactNode;
} = {
  hero: HeroBlock,
  section: SectionBlock,
  stat_grid: StatGridBlock,
  quote: QuoteBlock,
  image_feature: ImageFeatureBlock,
  logo_wall: LogoWallBlock,
  deal_options: DealOptionsBlock,
  faq: FaqBlock,
  proof: ProofBlock,
  cta: CtaBlock,
};
