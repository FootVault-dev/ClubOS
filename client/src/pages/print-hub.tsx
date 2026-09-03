// The United Prints shop front — shop.unitedprints.co.nz (and /print anywhere else).
//
// Wears the same brand as unitedprints.co.nz (royal/navy/grass, Poppins, the
// white pill nav) via components/up-shell.tsx, so a customer moving between the
// marketing site and the shop never notices a seam. Every product tile comes
// from the Materials tab in ClubOS, so Dima adds a product and it appears here
// with no deploy.
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import type { PrintMaterial } from "@shared/schema";
import { UpShell, upBtn, upDisplay } from "@/components/up-shell";

const CATEGORY_LABEL: Record<string, string> = {
  banner: "Banner",
  corflute: "Corflute Sign",
  vinyl_decal: "Vinyl Decal",
  aluminium: "Aluminium Panel",
  garment: "Garment Print",
  rollup: "Roll-up Banner",
  poster: "Poster",
  sticker: "Sticker",
  custom: "Custom",
};

function priceFromLabel(m: PrintMaterial): string {
  if (m.pricingMethod === "per_m2" && m.baseRateCents > 0) return `From $${(m.baseRateCents / 100).toFixed(0)}/m²`;
  if (m.pricingMethod === "per_piece_tiered") {
    const tiers = (m.sizeTiersJson as Array<{ priceCents: number }>) ?? [];
    if (tiers.length > 0) return `From $${(Math.min(...tiers.map((t) => t.priceCents)) / 100).toFixed(0)}`;
  }
  if (m.pricingMethod === "garment_decoration") return `From $${(m.baseRateCents / 100).toFixed(0)}/piece`;
  if (m.pricingMethod === "per_piece" && m.baseRateCents > 0) return `From $${(m.baseRateCents / 100).toFixed(0)}/piece`;
  return "Get a quote";
}

export default function PrintHub() {
  const [, setLocation] = useLocation();
  const { data: materials = [], isLoading, isError } = useQuery<PrintMaterial[]>({
    queryKey: ["/api/print/materials"],
    queryFn: () =>
      fetch("/api/print/materials").then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      }),
  });

  const garment = materials.find((m) => m.pricingMethod === "garment_decoration" || m.category === "garment");
  const rest = materials.filter((m) => m !== garment);

  return (
    <UpShell>
      {/* ── Hero, in the site's own royal-blue-with-stripes treatment ── */}
      <section className="relative overflow-hidden bg-[#043bcb] px-5 pb-20 pt-16 text-white sm:px-8 sm:pb-28 sm:pt-24">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "repeating-linear-gradient(115deg, rgba(255,255,255,.05) 0px, rgba(255,255,255,.05) 2px, transparent 2px, transparent 26px)",
          }}
        />
        <div className="relative mx-auto max-w-6xl">
          <h1 className={`${upDisplay} max-w-3xl text-4xl sm:text-6xl`}>
            Signs, banners <span className="whitespace-nowrap">&amp; tees.</span>
            <br />
            <span className="mt-2 inline-block bg-[#adff00] px-3 text-[#012583]">Quoted instantly.</span>
          </h1>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-white/85 sm:text-lg">
            Made in Christchurch. Pickup from Yaldhurst or delivered. No "fill out a form and
            wait" — pick what you need, see the price, order online.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <a href="/print/studio" className={upBtn.green}>Design a custom tee →</a>
            <a href="#products" className={upBtn.white}>See all products</a>
          </div>
        </div>
      </section>

      {/* ── Trust strip, the same four claims the site makes ── */}
      <section className="border-b border-[#cbd1de]/60 bg-white">
        <div className="mx-auto grid max-w-6xl gap-6 px-5 py-9 sm:grid-cols-2 sm:px-8 lg:grid-cols-4">
          {[
            ["Made in Christchurch", "466 Yaldhurst Road, Hornby"],
            ["Quoted instantly", "No forms, no waiting"],
            ["Pickup or delivery", "Free pickup from our shop"],
            ["Backs youth football", "Every order funds the club"],
          ].map(([t, s]) => (
            <div key={t}>
              <p className="text-[14px] font-extrabold text-[#012583]">{t}</p>
              <p className="mt-0.5 text-[13px] text-[#4a5265]">{s}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Custom tees, given its own billing ── */}
      {garment && (
        <section className="mx-auto max-w-6xl px-5 pt-16 sm:px-8 sm:pt-20">
          <a
            href="/print/studio"
            className="group grid gap-7 overflow-hidden rounded-3xl bg-[#012583] p-7 text-white transition hover:brightness-110 sm:grid-cols-[1fr_auto] sm:items-center sm:p-10"
          >
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#adff00]">New · design it yourself</p>
              <h2 className={`${upDisplay} mt-3 text-3xl sm:text-4xl`}>Custom printed tees</h2>
              <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-white/80">
                Your photo, your logo or your words on a quality cotton tee. Design it in the
                studio, see it on the shirt, send it through. Good for Christmas, team gear,
                birthdays and staff uniforms.
              </p>
              <span className={`${upBtn.green} mt-6`}>Open the studio →</span>
            </div>
            {/* A drawn tee, not a stock photo — same reason as the mockup itself. */}
            <svg viewBox="0 0 200 220" className="mx-auto h-40 w-auto opacity-90 sm:h-52" aria-hidden="true">
              <path
                d="M70 26 L44 40 L28 76 L52 88 L58 74 L58 196 Q58 202 64 202 L136 202 Q142 202 142 196 L142 74 L148 88 L172 76 L156 40 L130 26 Q124 22 118 22 Q114 36 100 36 Q86 36 82 22 Q76 22 70 26 Z"
                fill="#ffffff" fillOpacity="0.14" stroke="#adff00" strokeWidth="2"
              />
              <rect x="76" y="82" width="48" height="46" fill="none" stroke="#adff00" strokeWidth="1.6" strokeDasharray="5 4" />
            </svg>
          </a>
        </section>
      )}

      {/* ── Everything else ── */}
      <section id="products" className="mx-auto max-w-6xl px-5 pt-16 sm:px-8 sm:pt-20">
        <h2 className={`${upDisplay} text-3xl text-[#012583] sm:text-4xl`}>Pick your product</h2>
        <p className="mt-2 text-[15px]">Live pricing, made to size, NZ-wide delivery.</p>

        {/* 🔴 Four states, never 200-with-zeros: loading, failed, genuinely
            empty, and real products. An empty catalogue is a real answer. */}
        {isLoading ? (
          <p className="py-16 text-center text-[15px] text-[#4a5265]/70">Loading products…</p>
        ) : isError ? (
          <div className="mt-6 rounded-2xl border border-[#cbd1de] bg-white p-8 text-center">
            <p className="font-bold text-[#012583]">We couldn't load the products</p>
            <p className="mt-2 text-[14px]">That's on our end. Give us a call on 0800 800 199 and we'll sort it.</p>
          </div>
        ) : rest.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-[#cbd1de] bg-white p-8 text-center">
            <p className="font-bold text-[#012583]">Nothing listed just yet</p>
            <p className="mt-2 text-[14px]">Tell us what you need and we'll quote it the same day.</p>
          </div>
        ) : (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rest.map((m) => (
              <button
                key={m.id}
                onClick={() => setLocation(`/print/configure/${m.slug}`)}
                className="group rounded-2xl border border-[#cbd1de]/70 bg-white p-6 text-left transition hover:-translate-y-0.5 hover:border-[#043bcb] hover:shadow-[0_12px_28px_-14px_rgba(1,37,131,.35)]"
              >
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#043bcb]">
                  {CATEGORY_LABEL[m.category] ?? m.category}
                </p>
                <h3 className="mt-2 text-[19px] font-extrabold leading-tight text-[#012583]">{m.name}</h3>
                {m.description && (
                  <p className="mt-2 line-clamp-3 text-[14px] leading-relaxed text-[#4a5265]">{m.description}</p>
                )}
                <div className="mt-5 flex items-center justify-between">
                  <span className="text-[15px] font-extrabold text-[#012583]">{priceFromLabel(m)}</span>
                  <span className="text-[13px] font-bold text-[#33cc00] transition group-hover:translate-x-0.5">Configure →</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </UpShell>
  );
}
