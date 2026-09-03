// ─────────────────────────────────────────────────────────────────────────────
// UNITED PRINTS — the shop's chrome, matched to unitedprints.co.nz.
//
// The shop is served by ClubOS but has to feel like one business with the
// marketing site. ClubOS has none of the site's Tailwind tokens (royal, navy,
// grass, mist) so every value here is an arbitrary hex — taken VERBATIM from
// apps/united-print-website/tailwind.config.js rather than eyeballed:
//
//   royal #043bcb · navy #012583 · bright #0033cc · grass #33cc00
//   volt  #adff00 · slate #4a5265 · mist  #f7faff · cloud #cbd1de
//
// Poppins is already loaded by ClubOS's index.html, so the typeface matches
// with no new font request.
//
// 🔴 Everything brand lives HERE, once. A page that re-declares #043bcb is a
// page that will drift the next time the brand moves.
// ─────────────────────────────────────────────────────────────────────────────
import { Link, useLocation } from "wouter";

export const UP = {
  royal: "#043bcb",
  navy: "#012583",
  bright: "#0033cc",
  grass: "#33cc00",
  volt: "#adff00",
  slate: "#4a5265",
  mist: "#f7faff",
  cloud: "#cbd1de",
} as const;

/** The site's own button classes, rebuilt with arbitrary values. */
export const upBtn = {
  green:
    "inline-flex items-center justify-center gap-2 rounded-full bg-[#33cc00] px-7 py-3 text-sm font-extrabold uppercase tracking-wide text-white transition hover:brightness-110 active:scale-[0.98] min-h-[44px]",
  royal:
    "inline-flex items-center justify-center gap-2 rounded-full bg-[#043bcb] px-7 py-3.5 text-sm font-bold uppercase tracking-wide text-white transition hover:bg-[#0033cc] active:scale-[0.98] min-h-[44px]",
  white:
    "inline-flex items-center justify-center gap-2 rounded-full bg-white px-7 py-3.5 text-sm font-bold uppercase tracking-wide text-[#012583] ring-1 ring-[#cbd1de] transition hover:bg-[#f7faff] active:scale-[0.98] min-h-[44px]",
};

export const upField =
  "w-full rounded-xl border border-[#cbd1de] bg-white px-4 py-3 text-sm text-[#012583] placeholder:text-[#4a5265]/40 focus:border-[#043bcb] focus:outline-none focus:ring-2 focus:ring-[#043bcb]/15 disabled:opacity-50";

export const upLabel =
  "mb-2 block text-[11px] font-bold uppercase tracking-[0.14em] text-[#043bcb]";

/** The site's heavy display heading. */
export const upDisplay = "font-extrabold uppercase leading-[0.95] tracking-tight";

const SITE = "https://unitedprints.co.nz";

export function UpNav() {
  const [loc] = useLocation();
  const isStudio = loc.startsWith("/print/studio");
  return (
    <header className="sticky top-0 z-40 px-4 pt-4 sm:px-6 sm:pt-5">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 rounded-full border border-black/5 bg-[#f7faff]/95 px-4 py-2.5 shadow-lg shadow-[#012583]/5 backdrop-blur sm:px-6">
        <a href="/print" className="flex shrink-0 items-center" aria-label="United Prints shop">
          <img src="/up/logo.svg" alt="United Prints" className="h-5 w-auto sm:h-6" />
        </a>

        <nav className="hidden items-center gap-7 md:flex">
          <a href="/print" className="text-sm font-semibold text-[#012583]/85 transition hover:text-[#043bcb]">Products</a>
          <a href="/print/studio" className={`text-sm font-semibold transition hover:text-[#043bcb] ${isStudio ? "text-[#043bcb]" : "text-[#012583]/85"}`}>
            Custom tees
          </a>
          <a href={`${SITE}/about`} className="text-sm font-semibold text-[#012583]/85 transition hover:text-[#043bcb]">About</a>
          <a href={`${SITE}/contact`} className="text-sm font-semibold text-[#012583]/85 transition hover:text-[#043bcb]">Contact</a>
        </nav>

        <div className="flex items-center gap-1 sm:gap-2">
          <a
            href="/account"
            className="hidden min-h-[44px] items-center rounded-full px-4 text-sm font-semibold text-[#012583]/85 transition hover:bg-[#012583]/5 hover:text-[#043bcb] sm:inline-flex"
          >
            My account
          </a>
          <a href="/print/studio" className={`${upBtn.green} !px-5 !text-[13px]`}>Design a tee</a>
        </div>
      </div>
    </header>
  );
}

export function UpFooter() {
  return (
    <footer className="mt-20 bg-[#012583] px-5 py-14 text-white sm:px-8">
      <div className="mx-auto max-w-6xl">
        <img src="/up/logo.svg" alt="United Prints" className="h-6 w-auto brightness-0 invert" />
        <p className="mt-5 max-w-md text-[15px] leading-relaxed text-white/75">
          Every time you print with us, you invest directly in youth sport across New Zealand.
        </p>
        <div className="mt-8 flex flex-wrap gap-x-8 gap-y-3 text-sm font-semibold">
          <a href="/print" className="text-white/80 hover:text-white">Products</a>
          <a href="/print/studio" className="text-white/80 hover:text-white">Custom tees</a>
          <a href="/account" className="text-white/80 hover:text-white">My account</a>
          <a href={`${SITE}/contact`} className="text-white/80 hover:text-white">Contact</a>
        </div>
        <div className="mt-8 border-t border-white/15 pt-6 text-[13px] leading-relaxed text-white/55">
          466 Yaldhurst Road, Hornby, Christchurch · <a href="tel:0800800199" className="hover:text-white">0800 800 199</a> ·{" "}
          <a href="mailto:orders@unitedprints.co.nz" className="hover:text-white">orders@unitedprints.co.nz</a>
          <br />
          2025 © United Prints is a trading name of Christchurch United Football Club.
        </div>
      </div>
    </footer>
  );
}

/** Page wrapper: the site's mist background + Poppins, nav and footer. */
export function UpShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f7faff] font-[Poppins,system-ui,-apple-system,'Segoe_UI',sans-serif] text-[#4a5265] antialiased">
      <UpNav />
      <main>{children}</main>
      <UpFooter />
    </div>
  );
}

export { Link };
