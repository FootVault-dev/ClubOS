// ─────────────────────────────────────────────────────────────────────────────
// THE TEE MOCKUP — a drawn garment that reads as a real photograph of fabric,
// without being a photograph of a garment we cannot show.
//
// 🔴 WHY IT IS DRAWN. We have no product photography of the AS Colour Staple,
// and a stock photo or an AI-generated one would be a picture of a shirt we are
// not selling — which is a Fair Trading problem, not a taste one. So this is
// built rather than borrowed, and the caption under it says "preview".
//
// What makes it look real is not the outline, it is the four things printers'
// own mockup generators do:
//
//   1. FABRIC TEXTURE — fractal noise at low opacity, so the surface is not a
//      flat vector fill.
//   2. FORM SHADING — gradients for the shoulder roll, the sleeve shadow, the
//      hollow under the collar and the fall at the sides.
//   3. THE PRINT IS DISPLACED BY THE FABRIC — the artwork runs through a
//      displacement map driven by the same noise, so its edges ripple slightly
//      the way ink on a woven surface does.
//   4. THE SHADING SITS ON TOP OF THE PRINT. This is the one that matters most.
//      Artwork pasted over a shirt reads as a sticker; artwork with the
//      garment's own shadows falling across it reads as printed on.
//
// 🔴 NO GARMENT MEASUREMENT IS INVENTED. Nothing here claims a chest width for
// a size we have not measured. The only real number is the print width in
// millimetres the customer chose, scaled against a nominal print panel.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

export type TeeColour = {
  id: string;
  label: string;
  hex: string;
  /** Is the fabric dark enough that white ink reads on it? */
  dark: boolean;
};

// 🔴 These are the colours the MOCKUP can render, not a claim about stock. The
// shop confirms shade and availability before printing, and the page says so.
export const TEE_COLOURS: TeeColour[] = [
  { id: "white", label: "White", hex: "#f4f4f2", dark: false },
  { id: "black", label: "Black", hex: "#17181a", dark: true },
  { id: "navy", label: "Navy", hex: "#1b2440", dark: true },
  { id: "royal", label: "Royal blue", hex: "#0b3fbf", dark: true },
  { id: "grey", label: "Grey marle", hex: "#b9bcc1", dark: false },
  { id: "sand", label: "Sand", hex: "#d8c9b0", dark: false },
  { id: "forest", label: "Forest", hex: "#25543a", dark: true },
  { id: "maroon", label: "Maroon", hex: "#6c1f2c", dark: true },
  { id: "red", label: "Red", hex: "#bf2330", dark: true },
  { id: "green", label: "Bright green", hex: "#33cc00", dark: false },
];

export type Placement = {
  /** Print width in real millimetres — the one honest measurement on screen. */
  widthMm: number;
  /** Centre of the print, as a fraction of the print panel (0-1, 0.5 = middle). */
  x: number;
  y: number;
};

export type TeeArtwork =
  | { kind: "none" }
  | { kind: "image"; url: string; aspect: number }
  | {
      kind: "text";
      lines: string[];
      font: string;
      colour: string;
      weight: number;
      letterSpacing: number;
      lineHeight: number;
    };

/** Nominal printable panel across the chest, used ONLY to scale the preview. */
const PANEL_MM = 400;

// The garment occupies this box in SVG user units.
const PANEL = { x: 148, y: 150, w: 204, h: 258 };

export function TeeMockup({
  colour,
  artwork,
  placement,
  onPlacementChange,
  back = false,
}: {
  colour: TeeColour;
  artwork: TeeArtwork;
  placement: Placement;
  onPlacementChange?: (p: Placement) => void;
  back?: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  const id = (n: string) => `${n}-${uid}`;

  const shade = shadeStrength(colour.hex);
  const frac = Math.min(1, Math.max(0.02, placement.widthMm / PANEL_MM));
  const artW = PANEL.w * frac;

  // Only the image branch needs a box height — text measures and centres
  // itself (see TeeText).
  const artH = artW * (artwork.kind === "image" ? artwork.aspect : 1);

  const cx = PANEL.x + PANEL.w * placement.x;
  const cy = PANEL.y + PANEL.h * placement.y;
  const artX = cx - artW / 2;
  const artY = cy - artH / 2;

  // Drag to reposition. Pointer events so it works with a finger as well as a
  // mouse, and the maths goes through the SVG's own coordinate space so it
  // stays correct at every screen size.
  function startDrag(e: React.PointerEvent<SVGSVGElement>) {
    if (!onPlacementChange || artwork.kind === "none") return;
    const svg = e.currentTarget;
    svg.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      const ux = ((ev.clientX - r.left) / r.width) * 500;
      const uy = ((ev.clientY - r.top) / r.height) * 620;
      onPlacementChange({
        ...placement,
        // Clamped so the print can never be dragged off the garment.
        x: clamp((ux - PANEL.x) / PANEL.w, 0.12, 0.88),
        y: clamp((uy - PANEL.y) / PANEL.h, 0.06, 0.94),
      });
    };
    const up = () => {
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", up);
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
  }

  const BODY =
    "M172 92 L112 124 L74 208 L134 236 L148 202 L148 486 Q148 500 162 500 L338 500 Q352 500 352 486 L352 202 L366 236 L426 208 L388 124 L328 92 Q312 84 300 84 Q290 116 250 116 Q210 116 200 84 Q188 84 172 92 Z";

  return (
    <svg
      viewBox="0 0 500 620"
      className={`w-full select-none ${onPlacementChange && artwork.kind !== "none" ? "cursor-move touch-none" : ""}`}
      onPointerDown={startDrag}
      role="img"
      aria-label={`${colour.label} t-shirt preview`}
    >
      <defs>
        {/* Woven fabric grain. */}
        <filter id={id("weave")} x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="7" result="n" />
          <feColorMatrix in="n" type="saturate" values="0" result="g" />
          <feComponentTransfer in="g" result="soft">
            <feFuncA type="linear" slope="0.16" intercept="0" />
          </feComponentTransfer>
          <feComposite in="soft" in2="SourceGraphic" operator="in" />
        </filter>

        {/* 🔴 The print rides the weave. Without this the artwork's edges are
            vector-perfect and the whole thing reads as a sticker. */}
        <filter id={id("press")} x="-15%" y="-15%" width="130%" height="130%">
          <feTurbulence type="fractalNoise" baseFrequency="0.055" numOctaves="2" seed="3" result="warp" />
          <feDisplacementMap in="SourceGraphic" in2="warp" scale="3.2" xChannelSelector="R" yChannelSelector="G" />
        </filter>

        {/* Shoulder roll + the fall down each side. */}
        <linearGradient id={id("acrossBody")} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#000" stopOpacity="0.30" />
          <stop offset="16%" stopColor="#000" stopOpacity="0.05" />
          <stop offset="38%" stopColor="#fff" stopOpacity="0.10" />
          <stop offset="62%" stopColor="#fff" stopOpacity="0.10" />
          <stop offset="84%" stopColor="#000" stopOpacity="0.05" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.30" />
        </linearGradient>

        {/* The hollow beneath the collar, and the light gathering at the hem. */}
        <linearGradient id={id("downBody")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#000" stopOpacity="0.26" />
          <stop offset="14%" stopColor="#000" stopOpacity="0.04" />
          <stop offset="70%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.16" />
        </linearGradient>

        {/* Sleeve shadow where the arm meets the body. */}
        <radialGradient id={id("pit")} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#000" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#000" stopOpacity="0" />
        </radialGradient>

        <clipPath id={id("body")}><path d={BODY} /></clipPath>
        <clipPath id={id("panel")}>
          <rect x={PANEL.x} y={PANEL.y} width={PANEL.w} height={PANEL.h} rx="4" />
        </clipPath>

        <filter id={id("cast")} x="-25%" y="-15%" width="150%" height="140%">
          <feDropShadow dx="0" dy="10" stdDeviation="14" floodColor="#012583" floodOpacity="0.16" />
        </filter>
      </defs>

      <g filter={`url(#${id("cast")})`}>
        {/* 1 — the fabric */}
        <path d={BODY} fill={colour.hex} />

        <g clipPath={`url(#${id("body")})`}>
          {/* 2 — grain */}
          <rect x="0" y="0" width="500" height="620" filter={`url(#${id("weave")})`} fill="#808080" opacity="0.5" />

          {/* 3 — the print, pressed into the weave */}
          {artwork.kind !== "none" && (
            <g clipPath={`url(#${id("panel")})`} filter={`url(#${id("press")})`} opacity="0.97">
              {artwork.kind === "image" ? (
                <image
                  href={artwork.url}
                  x={artX} y={artY} width={artW} height={artH}
                  preserveAspectRatio="xMidYMid meet"
                />
              ) : (
                <TeeText art={artwork} x={cx} cy={cy} width={artW} />
              )}
            </g>
          )}

          {/* 4 — 🔴 shading OVER the print, so the garment's own shadows fall
                  across the ink. This is what stops it reading as a sticker. */}
          <g opacity={shade}>
            <path d={BODY} fill={`url(#${id("acrossBody")})`} style={{ mixBlendMode: "overlay" }} />
            <path d={BODY} fill={`url(#${id("downBody")})`} style={{ mixBlendMode: "multiply" }} />
            {/* Tucked into the sleeve seam and much smaller than they were —
                at the old size they read as two dark blobs on a light shirt
                rather than the shadow under an arm. */}
            <ellipse cx="158" cy="226" rx="30" ry="38" fill={`url(#${id("pit")})`} style={{ mixBlendMode: "multiply" }} />
            <ellipse cx="342" cy="226" rx="30" ry="38" fill={`url(#${id("pit")})`} style={{ mixBlendMode: "multiply" }} />
          </g>
        </g>

        {/* 5 — construction: collar rib, seams, hems */}
        <path
          d="M200 84 Q250 128 300 84"
          fill="none"
          stroke={colour.dark ? "rgba(255,255,255,.16)" : "rgba(0,0,0,.16)"}
          strokeWidth="9"
          strokeLinecap="round"
        />
        <path
          d="M200 84 Q250 128 300 84"
          fill="none"
          stroke={colour.dark ? "rgba(0,0,0,.35)" : "rgba(0,0,0,.10)"}
          strokeWidth="1.2"
          strokeDasharray="3 3"
        />
        {[
          "M148 202 L134 236", "M352 202 L366 236",
          "M134 236 L74 208", "M366 236 L426 208",
        ].map((d, i) => (
          <path key={i} d={d} fill="none" stroke="rgba(0,0,0,.18)" strokeWidth="1.2" />
        ))}
        <path d="M162 492 L338 492" fill="none" stroke="rgba(0,0,0,.14)" strokeWidth="1.2" strokeDasharray="4 4" />
        <path d="M92 200 L128 216" fill="none" stroke="rgba(0,0,0,.14)" strokeWidth="1.2" strokeDasharray="4 4" />
        <path d="M408 200 L372 216" fill="none" stroke="rgba(0,0,0,.14)" strokeWidth="1.2" strokeDasharray="4 4" />

        {/* Rim light along the outline keeps a black tee from turning into a hole. */}
        <path
          d={BODY}
          fill="none"
          stroke={colour.dark ? "rgba(255,255,255,.20)" : "rgba(0,0,0,.16)"}
          strokeWidth="1.4"
        />
      </g>

      {/* The print area, shown only while there is nothing in it. */}
      {artwork.kind === "none" && (
        <>
          <rect
            x={PANEL.x + 34} y={PANEL.y + 10} width={PANEL.w - 68} height={124}
            fill="none"
            stroke={colour.dark ? "rgba(255,255,255,.45)" : "rgba(4,59,203,.4)"}
            strokeWidth="1.5" strokeDasharray="7 6" rx="3"
          />
          <text
            x="250" y={PANEL.y + 78} textAnchor="middle"
            fill={colour.dark ? "rgba(255,255,255,.7)" : "rgba(1,37,131,.5)"}
            fontSize="13" fontWeight="700"
            style={{ fontFamily: "Poppins, sans-serif" }}
          >
            {back ? "Back print area" : "Your design goes here"}
          </text>
        </>
      )}
    </svg>
  );
}

// ── Text artwork ─────────────────────────────────────────────────────────────

/**
 * Text sized to FILL the print width the customer chose.
 *
 * 🔴 It MEASURES the rendered glyphs rather than estimating them. The first
 * version assumed a fixed character width, and Anton — a condensed face — came
 * out at roughly 60% of the box it had been given, so a "210mm A4 front" drew
 * a print noticeably smaller than 210mm. Since the print width in millimetres
 * is the one honest measurement this component makes, it has to be true on
 * screen, and only the browser knows how wide a glyph actually is.
 *
 * 🔴 It waits for document.fonts.ready. Measuring before the webfont lands
 * measures the fallback, which is a different width — the text would size
 * itself correctly and then visibly jump when Anton arrived.
 */
const NOMINAL_EM = 0.55; // first-paint guess, replaced by the measurement

function fontSizeFor(art: Extract<TeeArtwork, { kind: "text" }>, boxWidth: number): number {
  const lines = art.lines.length ? art.lines : [" "];
  const widest = Math.max(1, ...lines.map((l) => l.length));
  return boxWidth / (widest * (NOMINAL_EM + art.letterSpacing));
}

function TeeText({
  art, x, cy, width,
}: {
  art: Extract<TeeArtwork, { kind: "text" }>;
  /** Horizontal centre. */ x: number;
  /** VERTICAL CENTRE of the block, not its top — see below. */ cy: number;
  width: number;
}) {
  const lines = art.lines.length ? art.lines : [" "];
  const base = fontSizeFor(art, width);
  const ref = useRef<SVGTextElement>(null);
  const [fit, setFit] = useState(1);

  const measure = () => {
    const el = ref.current;
    if (!el) return;
    let widest = 0;
    for (const child of Array.from(el.childNodes) as SVGTSpanElement[]) {
      const len = typeof (child as any).getComputedTextLength === "function"
        ? (child as any).getComputedTextLength()
        : 0;
      if (len > widest) widest = len;
    }
    if (widest > 0) {
      // Divide out the scale already applied, so this converges in one pass
      // instead of shrinking a little more on every render.
      const natural = widest / fit;
      const next = width / natural;
      if (Math.abs(next - fit) > 0.01) setFit(next);
    }
  };

  useLayoutEffect(measure);
  useEffect(() => {
    const fonts = (document as any).fonts;
    if (fonts?.ready?.then) fonts.ready.then(measure).catch(() => {});
  }, [art.font, art.lines.join("\n"), art.letterSpacing, width]);

  const size = base * fit;
  const lineH = size * art.lineHeight;

  // 🔴 The block centres itself from its MEASURED size. The parent cannot do
  // this: it only knows the nominal size, and once the measurement scales the
  // font (Anton lands about 1.6× its estimate) a parent-computed top edge puts
  // the text visibly low on the chest.
  const totalH = lineH * lines.length;
  const firstBaseline = cy - totalH / 2 + size * 0.82;

  return (
    <text
      ref={ref}
      x={x}
      y={firstBaseline}
      textAnchor="middle"
      fill={art.colour}
      style={{
        fontFamily: art.font,
        fontWeight: art.weight,
        fontSize: size,
        letterSpacing: `${art.letterSpacing}em`,
      }}
    >
      {lines.map((l, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : lineH}>
          {l || " "}
        </tspan>
      ))}
    </text>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * How hard the garment's shadows should fall.
 *
 * 🔴 One strength for every colour turns a white tee grey. The same gradients
 * that give a black shirt its form read as dirt on a light one, because the
 * eye judges a shadow against the fabric it sits on, not against black. So the
 * shading is scaled by the fabric's own luminance — heavy on a dark shirt,
 * about a third of that on a white one. Caught by looking at a white tee next
 * to a black one, not by any check.
 */
function shadeStrength(hex: string): number {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  // L 0 (black) → 1.0 ; L 1 (white) → 0.34
  return clamp(1 - L * 0.66, 0.34, 1);
}
