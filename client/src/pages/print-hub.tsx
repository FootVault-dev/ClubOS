import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import type { PrintMaterial } from "@shared/schema";

// Public hub page for United Prints. Lists every active material as a tile.
// Lives at /print on app.usg.co.nz and at the root of order.unitedprints.co.nz
// once the subdomain is connected.

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

const CATEGORY_ACCENT: Record<string, string> = {
  banner: "from-orange-500/15 to-orange-500/5 border-orange-500/20",
  corflute: "from-yellow-500/15 to-yellow-500/5 border-yellow-500/20",
  vinyl_decal: "from-violet-500/15 to-violet-500/5 border-violet-500/20",
  aluminium: "from-slate-500/15 to-slate-500/5 border-slate-500/20",
  garment: "from-emerald-500/15 to-emerald-500/5 border-emerald-500/20",
  rollup: "from-blue-500/15 to-blue-500/5 border-blue-500/20",
  poster: "from-rose-500/15 to-rose-500/5 border-rose-500/20",
  sticker: "from-pink-500/15 to-pink-500/5 border-pink-500/20",
  custom: "from-amber-500/15 to-amber-500/5 border-amber-500/20",
};

function priceFromLabel(m: PrintMaterial): string {
  if (m.pricingMethod === "per_m2" && m.baseRateCents > 0) {
    return `From $${(m.baseRateCents / 100).toFixed(0)}/m²`;
  }
  if (m.pricingMethod === "per_piece_tiered") {
    const tiers = (m.sizeTiersJson as Array<{ priceCents: number }>) ?? [];
    if (tiers.length > 0) {
      const min = Math.min(...tiers.map(t => t.priceCents));
      return `From $${(min / 100).toFixed(0)}`;
    }
  }
  if (m.pricingMethod === "garment_decoration") {
    return `From $${(m.baseRateCents / 100).toFixed(0)}/piece`;
  }
  if (m.pricingMethod === "per_piece" && m.baseRateCents > 0) {
    return `From $${(m.baseRateCents / 100).toFixed(0)}/piece`;
  }
  return "Get a quote";
}

export default function PrintHub() {
  const [, setLocation] = useLocation();
  const { data: materials = [], isLoading } = useQuery<PrintMaterial[]>({
    queryKey: ["/api/print/materials"],
    queryFn: () => fetch("/api/print/materials").then(r => r.json()),
  });

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-zinc-900 flex items-center justify-center">
              <span className="text-white font-black text-sm">UP</span>
            </div>
            <div>
              <div className="font-bold text-base">United Prints</div>
              <div className="text-[10px] text-zinc-500 -mt-0.5">Christchurch</div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <a href="/account" className="text-sm font-semibold text-zinc-900 hover:text-zinc-600">
              My account
            </a>
            <a href="tel:0800800199" className="hidden text-sm font-medium text-zinc-900 hover:text-zinc-600 sm:block">
              0800 800 199
            </a>
          </div>
        </div>
      </header>

      <section className="border-b border-zinc-200">
        <div className="max-w-6xl mx-auto px-6 py-16 sm:py-24">
          <h1 className="text-4xl sm:text-6xl font-black tracking-tight max-w-4xl">
            Custom signs & banners.<br />
            <span className="text-zinc-500">Quoted instantly.</span>
          </h1>
          <p className="mt-6 text-lg text-zinc-600 max-w-2xl">
            Made in Christchurch. Pickup from Yaldhurst or delivered. No "fill out a form and wait" — pick what you need, see the price, pay online.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="#products"
              className="px-6 py-3 rounded-full bg-zinc-900 text-white font-semibold hover:bg-zinc-800 transition"
            >
              Get a quote →
            </a>
            <a
              href="/print/dtf"
              className="px-6 py-3 rounded-full bg-[#33cc00] text-white font-semibold hover:brightness-95 transition"
            >
              Printed tees →
            </a>
            <a
              href="tel:0800800199"
              className="px-6 py-3 rounded-full bg-white text-zinc-900 font-semibold border border-zinc-300 hover:border-zinc-900 transition"
            >
              Talk to us
            </a>
          </div>
        </div>
      </section>

      <section className="border-b border-zinc-200 bg-zinc-50">
        <div className="max-w-6xl mx-auto px-6 py-8 grid grid-cols-2 md:grid-cols-4 gap-6">
          {[
            { label: "Made in Christchurch", sub: "466 Yaldhurst Road, Hornby" },
            { label: "Quoted instantly", sub: "No forms, no waiting" },
            { label: "Pickup or delivery", sub: "Free pickup from our shop" },
            { label: "Reprint guarantee", sub: "100% reprint if it's our fault" },
          ].map((item) => (
            <div key={item.label}>
              <div className="text-sm font-semibold text-zinc-900">{item.label}</div>
              <div className="text-xs text-zinc-500 mt-0.5">{item.sub}</div>
            </div>
          ))}
        </div>
      </section>

      <section id="products" className="max-w-6xl mx-auto px-6 py-16 sm:py-24">
        <div className="mb-8 sm:mb-12">
          <h2 className="text-3xl sm:text-4xl font-black tracking-tight">Pick your product</h2>
          <p className="mt-2 text-zinc-500">Live pricing, made-to-size, NZ-wide delivery.</p>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-64 rounded-2xl bg-zinc-100 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {materials.map((m) => (
              <button
                key={m.id}
                onClick={() => setLocation(`/print/configure/${m.slug}`)}
                className={`group text-left rounded-2xl border bg-gradient-to-br ${CATEGORY_ACCENT[m.category] ?? "from-zinc-50 to-white border-zinc-200"} p-6 hover:shadow-lg hover:scale-[1.01] transition-all`}
              >
                <div className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500 mb-3">
                  {CATEGORY_LABEL[m.category] ?? m.category}
                </div>
                <h3 className="text-xl font-bold text-zinc-900 mb-2">{m.name}</h3>
                <p className="text-sm text-zinc-600 line-clamp-3 mb-4 min-h-[3.6em]">
                  {m.description}
                </p>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-zinc-900">{priceFromLabel(m)}</span>
                  <span className="text-sm font-medium text-zinc-500 group-hover:text-zinc-900 transition">
                    Configure →
                  </span>
                </div>
              </button>
            ))}

            <div className="rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 p-6 flex flex-col">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500 mb-3">
                Anything else
              </div>
              <h3 className="text-xl font-bold text-zinc-900 mb-2">Custom job</h3>
              <p className="text-sm text-zinc-600 mb-4">
                Vehicle wraps, oversized signs, or something we haven't listed? Tell us what you need.
              </p>
              <a
                href="mailto:orders@unitedprints.co.nz"
                className="text-sm font-medium text-zinc-900 hover:underline mt-auto"
              >
                Email us →
              </a>
            </div>
          </div>
        )}
      </section>

      <section className="border-t border-zinc-200 bg-zinc-50">
        <div className="max-w-6xl mx-auto px-6 py-12 grid grid-cols-1 md:grid-cols-3 gap-8">
          <div>
            <div className="text-sm font-bold mb-3">United Prints</div>
            <p className="text-sm text-zinc-600">
              466 Yaldhurst Road<br />
              Hornby, Christchurch<br />
              0800 800 199<br />
              orders@unitedprints.co.nz
            </p>
          </div>
          <div>
            <div className="text-sm font-bold mb-3">Hours</div>
            <p className="text-sm text-zinc-600">
              Monday – Friday · 8:30am – 5pm<br />
              Saturday · By appointment<br />
              Closed Sundays + public holidays
            </p>
          </div>
          <div>
            <div className="text-sm font-bold mb-3">A brand of</div>
            <p className="text-sm text-zinc-600">
              Christchurch United Football Club Inc.<br />
              Established 1976. Christchurch's home for sport.
            </p>
          </div>
        </div>
        <div className="border-t border-zinc-200">
          <div className="max-w-6xl mx-auto px-6 py-4 text-xs text-zinc-500 flex flex-wrap items-center justify-between gap-2">
            <span>© 2026 Christchurch United Football Club Inc.</span>
            <span>Made in Christchurch · Reprint guarantee · Pay securely with Stripe</span>
          </div>
        </div>
      </section>
    </div>
  );
}
