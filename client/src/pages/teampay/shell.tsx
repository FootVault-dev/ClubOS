/**
 * Team Pay — the shared chrome for every public page.
 *
 * These pages are opened by members of the public on their phones, from a link
 * in an email, usually once. They carry no ClubOS chrome, no sidebar and no
 * login. The brand comes from the competition row, so the Ethnic Cup renders
 * black and gold and MFL does not, from one component.
 */
import { useEffect, type ReactNode } from "react";
import type { TeampayBrand } from "@shared/teampay";
import { DEFAULT_BRAND } from "@shared/teampay";

export function money(cents: number | null | undefined): string {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}

/** Fonts the brands ask for. Loaded once, and the page reads fine without them. */
function useBrandFonts() {
  useEffect(() => {
    const id = "teampay-fonts";
    if (document.getElementById(id)) return;
    const l = document.createElement("link");
    l.id = id;
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&family=Kanit:wght@500;600;700&display=swap";
    document.head.appendChild(l);
  }, []);
}

export function TeampayShell({
  brand = DEFAULT_BRAND,
  eyebrow,
  title,
  children,
  wide,
}: {
  brand?: TeampayBrand;
  eyebrow?: string;
  title?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useBrandFonts();
  useEffect(() => {
    // The viewer's own page background, not the admin app's.
    const prev = document.body.style.background;
    document.body.style.background = brand.bg;
    return () => { document.body.style.background = prev; };
  }, [brand.bg]);

  return (
    <div
      style={{ background: brand.bg, color: brand.ink, fontFamily: brand.fontBody, minHeight: "100dvh" }}
      className="w-full"
    >
      {/* pb-24 keeps the last control clear of a phone's home indicator. */}
      <div
        className="mx-auto px-4 pt-8 pb-24 sm:px-6"
        style={{ maxWidth: wide ? 980 : 560 }}
      >
        {(eyebrow || title) && (
          <header className="mb-7">
            {eyebrow && (
              <div
                className="text-[11px] font-semibold uppercase"
                style={{ color: brand.accent, letterSpacing: "0.14em" }}
              >
                {eyebrow}
              </div>
            )}
            {title && (
              <h1
                className="mt-2 text-[28px] leading-[1.15] sm:text-[34px]"
                style={{ fontFamily: brand.fontHeading, fontWeight: 700 }}
              >
                {title}
              </h1>
            )}
          </header>
        )}
        {children}
      </div>
    </div>
  );
}

export function Card({
  brand, children, className = "", style,
}: { brand: TeampayBrand; children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div
      className={`rounded-2xl ${className}`}
      style={{ background: brand.card, border: `1px solid ${brand.line}`, ...style }}
    >
      {children}
    </div>
  );
}

export function Button({
  brand, children, onClick, disabled, type = "button", variant = "solid", className = "", title,
}: {
  brand: TeampayBrand;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  variant?: "solid" | "ghost" | "quiet";
  className?: string;
  title?: string;
}) {
  const base = "inline-flex items-center justify-center rounded-full font-semibold transition-opacity disabled:opacity-40 disabled:cursor-not-allowed";
  // 🔴 min-height 44px — nothing interactive on these pages goes under the tap
  // target the admin verifier enforces everywhere else.
  const style: React.CSSProperties =
    variant === "solid"
      ? { background: brand.accent, color: brand.onAccent, minHeight: 44, padding: "0 22px" }
      : variant === "ghost"
      ? { background: "transparent", color: brand.ink, border: `1px solid ${brand.line}`, minHeight: 44, padding: "0 18px" }
      : { background: "transparent", color: brand.mute, minHeight: 44, padding: "0 10px" };
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={`${base} ${className}`} style={style}>
      {children}
    </button>
  );
}

export function Field({
  brand, label, hint, children,
}: { brand: TeampayBrand; label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium" style={{ color: brand.ink }}>{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[12px]" style={{ color: brand.mute }}>{hint}</span>}
    </label>
  );
}

export function inputStyle(brand: TeampayBrand): React.CSSProperties {
  return {
    background: brand.bg,
    color: brand.ink,
    border: `1px solid ${brand.line}`,
    borderRadius: 10,
    padding: "12px 14px",
    width: "100%",
    // 🔴 16px minimum, or iOS Safari zooms the whole page the moment the field
    // takes focus and the layout jumps under the person's thumb.
    fontSize: 16,
    minHeight: 46,
  };
}

/** The three statuses, coloured. Words come from PLAYER_STATUS_LABEL. */
export function StatusPill({ brand, status, label }: { brand: TeampayBrand; status: string; label: string }) {
  const tone =
    status === "paid" ? { bg: "rgba(52,199,89,0.14)", fg: "#34C759", bd: "rgba(52,199,89,0.35)" }
    : status === "opened" ? { bg: "rgba(255,159,10,0.14)", fg: "#FF9F0A", bd: "rgba(255,159,10,0.35)" }
    : status === "invited" ? { bg: "rgba(255,255,255,0.06)", fg: brand.mute, bd: brand.line }
    : { bg: "rgba(255,69,58,0.12)", fg: "#FF6961", bd: "rgba(255,69,58,0.3)" };
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[11px] font-semibold"
      style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.bd}` }}
    >
      {label}
    </span>
  );
}

export function Progress({ brand, percent }: { brand: TeampayBrand; percent: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: brand.line }}>
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.max(0, Math.min(100, percent))}%`, background: brand.accent }}
      />
    </div>
  );
}

export function Notice({
  brand, tone = "info", children,
}: { brand: TeampayBrand; tone?: "info" | "warn" | "error" | "good"; children: ReactNode }) {
  const fg = tone === "error" ? "#FF6961" : tone === "warn" ? "#FF9F0A" : tone === "good" ? "#34C759" : brand.accent;
  return (
    <div
      className="rounded-xl px-4 py-3 text-[14px] leading-relaxed"
      style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${fg}44`, color: brand.ink }}
    >
      {children}
    </div>
  );
}

export function Loading({ brand }: { brand: TeampayBrand }) {
  return (
    <div className="py-24 text-center text-[14px]" style={{ color: brand.mute }}>
      Loading…
    </div>
  );
}

/** What a bad or expired token gets. Says nothing about whether it ever existed. */
export function NotFoundPage({ brand = DEFAULT_BRAND }: { brand?: TeampayBrand }) {
  return (
    <TeampayShell brand={brand} title="We couldn't find that">
      <Card brand={brand} className="p-6">
        <p className="text-[15px] leading-relaxed" style={{ color: brand.mute }}>
          That link doesn't work. It may have expired, or been replaced by a newer one.
          Check the most recent email you were sent, or ask your team manager to send it again.
        </p>
      </Card>
    </TeampayShell>
  );
}
