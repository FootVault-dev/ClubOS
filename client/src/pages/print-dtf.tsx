// ─────────────────────────────────────────────────────────────────────────────
// UNITED PRINTS — DTF / garment printing, with a live mockup.
//
// shop.unitedprints.co.nz/print/dtf. Pick a garment colour, upload your artwork,
// see it on the shirt at the size it will actually print, break the order down
// by size, and get the price from the shop's own engine.
//
// ── Two honesty rules this page is built around ─────────────────────────────
//
// 🔴 THE GARMENT IS DRAWN, NOT PHOTOGRAPHED. We have no product photography for
// these shirts, and a stock photo of somebody else's tee — or an AI-generated
// one — would be a picture of a garment we are not selling. So the mockup is an
// SVG outline we drew, and it says "placement guide" on it. A customer can see
// exactly where their art sits and how big it is, and cannot mistake it for a
// photo of the finished product.
//
// 🔴 NO GARMENT MEASUREMENTS ARE INVENTED. The scale reference is the PRINT
// AREA in millimetres — a number the customer typed and we honour — never a
// claimed chest width for a size we have not measured. The outline is
// proportional, and labelled as such.
//
// Prices come from POST /api/public/unitedprints/quote-price, the same engine
// that prices a real print order, so a signed-in trade customer automatically
// sees their own rate (the session cookie is first-party on this host).
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

const MATERIALS_URL = "/api/public/unitedprints/quote-materials";
const PRICE_URL = "/api/public/unitedprints/quote-price";

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Garment colours ──────────────────────────────────────────────────────────
// 🔴 These are the colours the MOCKUP can render, not a claim about stock. The
// order is confirmed by the shop, and the page says so — inventing an in-stock
// colour range for a supplier's catalogue would be inventing product data.
const COLOURS = [
  { id: "white", label: "White", hex: "#ffffff", ink: "dark" },
  { id: "black", label: "Black", hex: "#141414", ink: "light" },
  { id: "navy", label: "Navy", hex: "#1c2542", ink: "light" },
  { id: "royal", label: "Royal", hex: "#043bcb", ink: "light" },
  { id: "grey", label: "Grey marle", hex: "#b4b7bd", ink: "dark" },
  { id: "sand", label: "Sand", hex: "#d9cbb3", ink: "dark" },
  { id: "green", label: "Green", hex: "#33cc00", ink: "dark" },
  { id: "red", label: "Red", hex: "#c02128", ink: "light" },
] as const;

const SIZES = ["S", "M", "L", "XL", "2XL", "3XL"] as const;
type SizeKey = (typeof SIZES)[number];

// Common DTF transfer sizes. Width is what the customer chooses; the height
// follows their artwork's own aspect ratio, so nothing is stretched.
const PRESETS = [
  { id: "pocket", label: "Left chest", widthMm: 90 },
  { id: "a4", label: "A4 front", widthMm: 210 },
  { id: "a3", label: "A3 front", widthMm: 297 },
] as const;

/** The widest a transfer can be. Beyond this the shop quotes it by hand. */
const MAX_PRINT_WIDTH_MM = 320;
const MIN_PRINT_WIDTH_MM = 30;

type Material = {
  slug: string;
  name: string;
  description: string | null;
  category: string;
  pricingMethod: string;
  minChargeCents: number;
  turnaroundDays: number;
};

type PriceResponse = {
  lines: { ok: boolean; lineExGstCents: number; breakdown: { label: string; cents: number }[]; message: string | null }[];
  subtotalCents: number;
  gstCents: number;
  totalCents: number;
  needsHumanQuote: boolean;
  accountPricing: { applied: boolean; discountPct: number; tier: string } | null;
};

// ── The mockup ───────────────────────────────────────────────────────────────

/**
 * A drawn tee with the artwork placed on it.
 *
 * The garment outline is proportional, not dimensioned. The ONE real
 * measurement on screen is the print width in mm, and the artwork is scaled
 * against a nominal front-panel width so the relationship between "my logo is
 * 90mm" and "my logo is 297mm" is visually truthful even though the shirt
 * itself is a drawing.
 */
function TeeMockup({
  colour,
  artworkUrl,
  printWidthMm,
  artAspect,
}: {
  colour: (typeof COLOURS)[number];
  artworkUrl: string | null;
  printWidthMm: number;
  artAspect: number; // height / width
}) {
  // Nominal printable panel across the chest, used only to scale the preview.
  const PANEL_MM = 380;
  const panelFrac = Math.min(1, printWidthMm / PANEL_MM);

  // SVG user units: the front panel spans x = 130 → 370 (240 units).
  const panelUnits = 240;
  const artW = panelUnits * panelFrac;
  const artH = artW * (artAspect || 1);
  const artX = 250 - artW / 2;
  const artY = 150; // just below the collar

  const seam = colour.ink === "light" ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.16)";

  return (
    <div className="relative">
      <svg viewBox="0 0 500 560" className="w-full" role="img" aria-label={`${colour.label} t-shirt placement guide`}>
        <defs>
          <clipPath id="tee-panel">
            <rect x="130" y="120" width="240" height="300" />
          </clipPath>
        </defs>

        {/* Body + sleeves — one path, drawn by us. */}
        <path
          d="M175 95 L120 125 L85 205 L140 230 L152 200 L152 470 Q152 482 164 482 L336 482 Q348 482 348 470 L348 200 L360 230 L415 205 L380 125 L325 95 Q310 88 300 88 Q290 118 250 118 Q210 118 200 88 Q190 88 175 95 Z"
          fill={colour.hex}
          stroke={colour.ink === "light" ? "rgba(255,255,255,.28)" : "rgba(0,0,0,.22)"}
          strokeWidth="2"
        />
        {/* Collar */}
        <path d="M200 88 Q250 128 300 88" fill="none" stroke={seam} strokeWidth="7" strokeLinecap="round" />
        {/* Sleeve seams */}
        <path d="M152 200 L140 230" stroke={seam} strokeWidth="2" fill="none" />
        <path d="M348 200 L360 230" stroke={seam} strokeWidth="2" fill="none" />

        {/* The print area guide — always visible, so an empty state still teaches. */}
        <rect
          x={artX} y={artY} width={artW} height={artH || 60}
          fill="none"
          stroke={colour.ink === "light" ? "rgba(255,255,255,.5)" : "rgba(4,59,203,.45)"}
          strokeWidth="1.5"
          strokeDasharray="6 5"
          rx="2"
        />

        {artworkUrl && (
          <g clipPath="url(#tee-panel)">
            <image
              href={artworkUrl}
              x={artX} y={artY} width={artW} height={artH}
              preserveAspectRatio="xMidYMid meet"
            />
          </g>
        )}

        {!artworkUrl && (
          <text
            x="250" y={artY + 34}
            textAnchor="middle"
            fill={colour.ink === "light" ? "rgba(255,255,255,.65)" : "rgba(0,0,0,.45)"}
            fontSize="13"
            fontWeight="600"
          >
            Your artwork here
          </text>
        )}
      </svg>

      {/* 🔴 Says what it is. A customer must never think this is a photograph
          of the shirt they will receive. */}
      <p className="mt-2 text-center text-[12px] leading-relaxed text-slate-500">
        Placement guide — not a photo. Print width <span className="font-semibold text-slate-700">{printWidthMm}mm</span>;
        garment shown proportionally.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function PrintDtfPage() {
  const [colourId, setColourId] = useState<string>("black");
  const [printWidthMm, setPrintWidthMm] = useState(210);
  const [qty, setQty] = useState<Record<SizeKey, number>>(
    () => Object.fromEntries(SIZES.map((s) => [s, 0])) as Record<SizeKey, number>,
  );
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
  const [artworkName, setArtworkName] = useState<string | null>(null);
  const [artAspect, setArtAspect] = useState(1);
  const [artError, setArtError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const colour = COLOURS.find((c) => c.id === colourId) ?? COLOURS[1];
  const totalQty = useMemo(() => Object.values(qty).reduce((a, b) => a + b, 0), [qty]);

  // ── The garment product, from ClubOS ──────────────────────────────────────
  const { data: materials, isLoading: matLoading, isError: matError } = useQuery<Material[]>({
    queryKey: [MATERIALS_URL],
    queryFn: async () => {
      const r = await fetch(MATERIALS_URL, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      return Array.isArray(d?.materials) ? d.materials : [];
    },
  });

  const garment = useMemo(
    () => (materials ?? []).find((m) => m.pricingMethod === "garment_decoration" || m.category === "garment"),
    [materials],
  );

  // ── Live price ────────────────────────────────────────────────────────────
  const [price, setPrice] = useState<PriceResponse | null>(null);
  const [pricing, setPricing] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);

  const repriceRef = useRef<AbortController | null>(null);
  const reprice = useCallback(async () => {
    if (!garment || totalQty < 1) { setPrice(null); setPriceError(null); return; }
    repriceRef.current?.abort();
    const ac = new AbortController();
    repriceRef.current = ac;
    setPricing(true); setPriceError(null);
    try {
      const r = await fetch(PRICE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Same-origin, so the account cookie rides along and a trade customer
        // is priced at their own rate by the server.
        credentials: "same-origin",
        signal: ac.signal,
        body: JSON.stringify({
          items: [{ materialSlug: garment.slug, widthMm: printWidthMm, heightMm: Math.round(printWidthMm * artAspect), quantity: totalQty }],
        }),
      });
      if (!r.ok) throw new Error(String(r.status));
      setPrice(await r.json());
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setPriceError("We couldn't price that just now.");
      setPrice(null);
    } finally {
      if (!ac.signal.aborted) setPricing(false);
    }
  }, [garment, totalQty, printWidthMm, artAspect]);

  useEffect(() => {
    const t = setTimeout(() => { void reprice(); }, 350);
    return () => clearTimeout(t);
  }, [reprice]);

  // ── Artwork ───────────────────────────────────────────────────────────────
  // Read locally into a data URL for the preview only. Nothing is uploaded from
  // this page — the real artwork goes through the existing upload portal once
  // the order exists, which is where it is stored and versioned.
  function onFile(file: File | undefined) {
    setArtError(null);
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) {
      setArtError("Use a PNG, JPG, WEBP or SVG. For the sharpest print, PNG with a transparent background.");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setArtError("That file is over 12MB — send it through with your order instead and we'll take it from there.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const img = new Image();
      img.onload = () => {
        setArtAspect(img.height && img.width ? img.height / img.width : 1);
        setArtworkUrl(url);
        setArtworkName(file.name);
      };
      // 🔴 A file that will not decode must not silently become a broken
      // preview the customer reads as "accepted".
      img.onerror = () => setArtError("We couldn't read that image. Try exporting it again as a PNG.");
      img.src = url;
    };
    reader.onerror = () => setArtError("We couldn't read that file.");
    reader.readAsDataURL(file);
  }

  const inputCls =
    "w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-[15px] text-slate-900 outline-none transition focus:border-[#043bcb] focus:ring-4 focus:ring-[#043bcb]/12";

  // ── States ────────────────────────────────────────────────────────────────
  // 🔴 Four of them, never 200-with-zeros. "Not on sale online yet" is a real
  // answer and gets its own screen — it is what a customer sees until Dima
  // publishes the garment, and it must not look like a crash.
  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-[#f7faff] font-[Poppins,system-ui,-apple-system,'Segoe_UI',sans-serif] antialiased">
      <div className="mx-auto w-full max-w-5xl px-5 py-10 sm:py-14">{children}</div>
    </div>
  );

  if (matLoading) {
    return shell(<p className="py-24 text-center text-[15px] text-slate-500">Loading…</p>);
  }
  if (matError) {
    return shell(
      <div className="py-20 text-center">
        <p className="text-[18px] font-bold text-slate-900">We couldn't load the shop</p>
        <p className="mt-2 text-[14px] text-slate-600">That's on our end. Try again in a moment.</p>
      </div>,
    );
  }
  if (!garment) {
    return shell(
      <div className="mx-auto max-w-lg py-16 text-center">
        <h1 className="text-[28px] font-extrabold tracking-tight text-slate-900">Printed tees &amp; DTF transfers</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
          Not on sale online just yet — we're finishing the garment range and pricing. Send us what you
          need and we'll quote it the same day.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <a href="https://unitedprints.co.nz/contact"
             className="inline-flex min-h-[48px] items-center rounded-full bg-[#33cc00] px-6 text-[14px] font-bold uppercase tracking-wide text-white transition hover:brightness-95">
            Ask for a quote
          </a>
          <a href="tel:0800800199"
             className="inline-flex min-h-[48px] items-center rounded-full border border-slate-300 px-6 text-[14px] font-semibold text-slate-700 transition hover:bg-white">
            0800 800 199
          </a>
        </div>
      </div>,
    );
  }

  const overWidth = printWidthMm > MAX_PRINT_WIDTH_MM;

  return shell(
    <>
      <header className="mb-8">
        <p className="text-[13px] font-bold uppercase tracking-[0.14em] text-[#043bcb]">United Prints</p>
        <h1 className="mt-1 text-[30px] font-extrabold leading-tight tracking-tight text-slate-900 sm:text-[36px]">
          Printed tees, done properly
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-slate-600">
          {garment.description ?? "Full-colour DTF transfers on quality cotton tees."} Build it below and
          see your price as you go — every order funds youth football in Christchurch.
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* ── Mockup ── */}
        <div className="lg:order-2">
          <div className="sticky top-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,.04),0_12px_32px_-16px_rgba(4,59,203,.16)]">
            <TeeMockup colour={colour} artworkUrl={artworkUrl} printWidthMm={printWidthMm} artAspect={artAspect} />
          </div>
        </div>

        {/* ── Controls ── */}
        <div className="space-y-8 lg:order-1">
          {/* Colour */}
          <section>
            <h2 className="text-[17px] font-extrabold tracking-tight text-slate-900">1. Garment colour</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {COLOURS.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setColourId(c.id)}
                  aria-pressed={colourId === c.id}
                  title={c.label}
                  className={`flex min-h-[44px] items-center gap-2 rounded-full border px-3 text-[13px] font-semibold transition ${
                    colourId === c.id
                      ? "border-[#043bcb] bg-[#043bcb]/6 text-[#043bcb]"
                      : "border-slate-300 text-slate-700 hover:border-slate-400"
                  }`}
                >
                  <span className="h-5 w-5 rounded-full border border-black/15" style={{ background: c.hex }} />
                  {c.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-slate-500">
              We'll confirm the exact shade and stock with you before printing.
            </p>
          </section>

          {/* Artwork */}
          <section>
            <h2 className="text-[17px] font-extrabold tracking-tight text-slate-900">2. Your artwork</h2>
            <div className="mt-3">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="sr-only"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
              <button
                onClick={() => fileRef.current?.click()}
                className="min-h-[52px] w-full rounded-xl border-2 border-dashed border-slate-300 bg-white px-5 text-[14px] font-semibold text-slate-700 transition hover:border-[#043bcb] hover:text-[#043bcb]"
              >
                {artworkName ? `${artworkName} — choose another` : "Upload your design"}
              </button>
              {artworkUrl && (
                <button
                  onClick={() => { setArtworkUrl(null); setArtworkName(null); setArtAspect(1); }}
                  className="mt-2 min-h-[44px] text-[13px] font-semibold text-slate-500 underline-offset-4 hover:underline"
                >
                  Remove
                </button>
              )}
              {artError && (
                <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-[13px] text-rose-700">{artError}</p>
              )}
              <p className="mt-2 text-[12px] leading-relaxed text-slate-500">
                Preview only — nothing is uploaded yet. We'll ask for the print-ready file once your order
                is placed, and we'll check it before we print.
              </p>
            </div>
          </section>

          {/* Size on the garment */}
          <section>
            <h2 className="text-[17px] font-extrabold tracking-tight text-slate-900">3. How big on the shirt</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPrintWidthMm(p.widthMm)}
                  aria-pressed={printWidthMm === p.widthMm}
                  className={`min-h-[44px] rounded-full border px-4 text-[13px] font-semibold transition ${
                    printWidthMm === p.widthMm
                      ? "border-[#043bcb] bg-[#043bcb]/6 text-[#043bcb]"
                      : "border-slate-300 text-slate-700 hover:border-slate-400"
                  }`}
                >
                  {p.label} · {p.widthMm}mm
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <label htmlFor="dtf-w" className="shrink-0 text-[14px] font-semibold text-slate-800">Width</label>
              <input
                id="dtf-w" inputMode="numeric" value={printWidthMm}
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/[^\d]/g, "").slice(0, 3));
                  setPrintWidthMm(Number.isFinite(n) ? n : 0);
                }}
                className={`${inputCls} w-28 text-center tabular-nums`}
              />
              <span className="text-[14px] text-slate-500">mm across</span>
            </div>
            {printWidthMm > 0 && printWidthMm < MIN_PRINT_WIDTH_MM && (
              <p className="mt-2 text-[13px] text-amber-700">That's smaller than {MIN_PRINT_WIDTH_MM}mm — fine detail may not hold.</p>
            )}
            {overWidth && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[13px] leading-relaxed text-amber-800">
                Over {MAX_PRINT_WIDTH_MM}mm is wider than our standard transfer. We can still do it — send it
                through and we'll quote it by hand.
              </p>
            )}
          </section>

          {/* Sizes */}
          <section>
            <h2 className="text-[17px] font-extrabold tracking-tight text-slate-900">4. Sizes &amp; quantities</h2>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
              {SIZES.map((size) => (
                <div key={size} className="rounded-xl border border-slate-200 bg-white p-2 text-center">
                  <label htmlFor={`q-${size}`} className="block text-[13px] font-bold text-slate-700">{size}</label>
                  <input
                    id={`q-${size}`} inputMode="numeric" value={qty[size] || ""} placeholder="0"
                    onChange={(e) => {
                      const n = Number(e.target.value.replace(/[^\d]/g, "").slice(0, 4)) || 0;
                      setQty({ ...qty, [size]: n });
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-200 py-2 text-center text-[15px] font-semibold tabular-nums text-slate-900 outline-none focus:border-[#043bcb]"
                  />
                </div>
              ))}
            </div>
            <p className="mt-2 text-[13px] font-semibold text-slate-700">
              {totalQty} shirt{totalQty === 1 ? "" : "s"} total
            </p>
          </section>

          {/* Price */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="text-[17px] font-extrabold tracking-tight text-slate-900">Your price</h2>

            {totalQty < 1 ? (
              <p className="mt-2 text-[14px] leading-relaxed text-slate-600">Add some sizes above and the price appears here.</p>
            ) : pricing ? (
              <p className="mt-2 text-[14px] text-slate-500">Working it out…</p>
            ) : priceError ? (
              <div className="mt-2">
                <p className="text-[14px] text-rose-700">{priceError}</p>
                <button onClick={() => void reprice()} className="mt-2 min-h-[44px] text-[14px] font-semibold text-[#043bcb] underline-offset-4 hover:underline">
                  Try again
                </button>
              </div>
            ) : price && price.lines[0]?.ok ? (
              <>
                {price.accountPricing?.applied && (
                  <p className="mt-2 inline-flex rounded-full bg-[#33cc00]/12 px-3 py-1 text-[13px] font-bold text-[#1f7a00]">
                    Your {price.accountPricing.discountPct}% account rate is applied
                  </p>
                )}
                <ul className="mt-3 space-y-1.5 border-t border-slate-100 pt-3">
                  {price.lines[0].breakdown.map((b, i) => (
                    <li key={i} className="flex justify-between gap-4 text-[14px]">
                      <span className="text-slate-600">{b.label}</span>
                      <span className={`tabular-nums font-semibold ${b.cents < 0 ? "text-emerald-700" : "text-slate-900"}`}>
                        {b.cents < 0 ? "−" : ""}{money(Math.abs(b.cents))}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 space-y-1 border-t border-slate-100 pt-3">
                  <div className="flex justify-between text-[14px] text-slate-600">
                    <span>Subtotal</span><span className="tabular-nums">{money(price.subtotalCents)}</span>
                  </div>
                  <div className="flex justify-between text-[14px] text-slate-600">
                    <span>GST</span><span className="tabular-nums">{money(price.gstCents)}</span>
                  </div>
                  <div className="flex justify-between text-[18px] font-extrabold text-slate-900">
                    <span>Total</span><span className="tabular-nums">{money(price.totalCents)}</span>
                  </div>
                  {totalQty > 0 && (
                    <p className="pt-1 text-[13px] text-slate-500">
                      {money(Math.round(price.totalCents / totalQty))} per shirt, incl. GST
                    </p>
                  )}
                </div>
                <p className="mt-3 text-[13px] text-slate-500">
                  Ready in about {garment.turnaroundDays} working days once artwork is approved.
                </p>
              </>
            ) : price?.lines[0]?.message ? (
              <p className="mt-2 text-[14px] leading-relaxed text-slate-700">{price.lines[0].message}</p>
            ) : null}

            <a
              href={`https://unitedprints.co.nz/contact?product=dtf-tee&qty=${totalQty}&width=${printWidthMm}&colour=${colour.id}`}
              className="mt-5 inline-flex min-h-[52px] w-full items-center justify-center rounded-full bg-[#33cc00] px-6 text-[15px] font-bold uppercase tracking-wide text-white transition hover:brightness-95"
            >
              {totalQty > 0 ? "Send this order through" : "Talk to us about your order"}
            </a>
            <p className="mt-2 text-center text-[12px] leading-relaxed text-slate-500">
              We'll confirm sizes, stock and artwork before anything is charged.
            </p>
          </section>
        </div>
      </div>
    </>,
  );
}
