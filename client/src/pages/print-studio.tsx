// ─────────────────────────────────────────────────────────────────────────────
// UNITED PRINTS — the custom tee studio.
//
// shop.unitedprints.co.nz/print/studio. Pick a shirt, put your own image or
// your own words on it, see it on the garment straight away, and send the order.
//
// ── How ordering actually works, and why ────────────────────────────────────
//
// The studio previews at screen resolution. It does NOT send that preview to be
// printed, because a web-res PNG is not a print file — and pretending otherwise
// is how a customer ends up with a blurry shirt.
//
// So the order goes down the shop's existing, human-checked route: the full
// spec (garment, colour, sizes, print size, and either the design's words or
// the uploaded file's name) posts to /quote-request, lands in Dima's Quotes tab
// and emails the customer. He confirms it into a job, and the customer sends
// the print-ready file through the upload portal that already exists. That is
// how custom print works everywhere — artwork always gets a human look first.
//
// Prices come from the same engine that prices a real print order, so a
// signed-in trade customer is quoted their own rate automatically.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { UpShell, upBtn, upField, upLabel, upDisplay } from "@/components/up-shell";
import { TeeMockup, TEE_COLOURS, type TeeArtwork, type Placement } from "@/components/tee-mockup";

const MATERIALS_URL = "/api/public/unitedprints/quote-materials";
const PRICE_URL = "/api/public/unitedprints/quote-price";
const ORDER_URL = "/api/public/unitedprints/quote-request";

const money = (c: number) =>
  `$${(c / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SIZES = ["S", "M", "L", "XL", "2XL", "3XL"] as const;
type SizeKey = (typeof SIZES)[number];

// Fonts ClubOS already loads — no extra request, and every one of them is a
// typeface we can actually set for print.
const FONTS = [
  { id: "Anton", label: "Anton", weight: 400, css: "Anton, sans-serif" },
  { id: "Poppins", label: "Poppins", weight: 800, css: "Poppins, sans-serif" },
  { id: "Montserrat", label: "Montserrat", weight: 800, css: "Montserrat, sans-serif" },
  { id: "Playfair", label: "Playfair", weight: 700, css: "'Playfair Display', serif" },
  { id: "Space", label: "Space Grotesk", weight: 700, css: "'Space Grotesk', sans-serif" },
  { id: "Oxanium", label: "Oxanium", weight: 700, css: "Oxanium, sans-serif" },
  { id: "Hand", label: "Handwritten", weight: 400, css: "'Architects Daughter', cursive" },
] as const;

const INK = [
  { id: "white", hex: "#ffffff", label: "White" },
  { id: "black", hex: "#141414", label: "Black" },
  { id: "grass", hex: "#33cc00", label: "Green" },
  { id: "royal", hex: "#043bcb", label: "Blue" },
  { id: "gold", hex: "#e0a800", label: "Gold" },
  { id: "red", hex: "#c8102e", label: "Red" },
  { id: "pink", hex: "#ff5fa2", label: "Pink" },
];

const PRESETS = [
  { label: "Left chest", widthMm: 90 },
  { label: "A4 front", widthMm: 210 },
  { label: "A3 front", widthMm: 297 },
];

const MAX_MM = 320;

type Material = {
  slug: string; name: string; description: string | null;
  category: string; pricingMethod: string; minChargeCents: number; turnaroundDays: number;
};
type PriceResponse = {
  lines: { ok: boolean; breakdown: { label: string; cents: number }[]; message: string | null }[];
  subtotalCents: number; gstCents: number; totalCents: number;
  accountPricing: { applied: boolean; discountPct: number } | null;
};

export default function PrintStudioPage() {
  const [colourId, setColourId] = useState("black");
  const [tab, setTab] = useState<"image" | "text">("text");
  const [placement, setPlacement] = useState<Placement>({ widthMm: 210, x: 0.5, y: 0.28 });

  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgName, setImgName] = useState<string | null>(null);
  const [imgAspect, setImgAspect] = useState(1);
  const [imgError, setImgError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [text, setText] = useState("MERRY\nCHRISTMAS");
  const [fontId, setFontId] = useState<string>("Anton");
  const [inkId, setInkId] = useState("white");
  const [tracking, setTracking] = useState(0.02);

  const [qty, setQty] = useState<Record<SizeKey, number>>(
    () => Object.fromEntries(SIZES.map((s) => [s, 0])) as Record<SizeKey, number>,
  );
  const totalQty = useMemo(() => Object.values(qty).reduce((a, b) => a + b, 0), [qty]);

  const colour = TEE_COLOURS.find((c) => c.id === colourId) ?? TEE_COLOURS[1];
  const font = FONTS.find((f) => f.id === fontId) ?? FONTS[0];
  const ink = INK.find((i) => i.id === inkId) ?? INK[0];

  const artwork: TeeArtwork = useMemo(() => {
    if (tab === "image" && imgUrl) return { kind: "image", url: imgUrl, aspect: imgAspect };
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (tab === "text" && lines.length) {
      return { kind: "text", lines, font: font.css, colour: ink.hex, weight: font.weight, letterSpacing: tracking, lineHeight: 1.12 };
    }
    return { kind: "none" };
  }, [tab, imgUrl, imgAspect, text, font, ink, tracking]);

  // ── The product ───────────────────────────────────────────────────────────
  const { data: materials, isLoading, isError } = useQuery<Material[]>({
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
  const acRef = useRef<AbortController | null>(null);

  const reprice = useCallback(async () => {
    if (!garment || totalQty < 1) { setPrice(null); return; }
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    setPricing(true);
    try {
      const r = await fetch(PRICE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        signal: ac.signal,
        body: JSON.stringify({
          items: [{ materialSlug: garment.slug, widthMm: placement.widthMm, heightMm: placement.widthMm, quantity: totalQty }],
        }),
      });
      setPrice(r.ok ? await r.json() : null);
    } catch (e: any) {
      if (e?.name !== "AbortError") setPrice(null);
    } finally {
      if (!ac.signal.aborted) setPricing(false);
    }
  }, [garment, totalQty, placement.widthMm]);

  useEffect(() => {
    const t = setTimeout(() => { void reprice(); }, 350);
    return () => clearTimeout(t);
  }, [reprice]);

  // ── Artwork upload (preview only) ─────────────────────────────────────────
  function onFile(file: File | undefined) {
    setImgError(null);
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) {
      setImgError("Use a PNG, JPG, WEBP or SVG. A PNG with a transparent background prints best.");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setImgError("That's over 12MB. Send it with your order instead and we'll take it from there.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const img = new Image();
      img.onload = () => {
        setImgAspect(img.height && img.width ? img.height / img.width : 1);
        setImgUrl(url); setImgName(file.name); setTab("image");
      };
      // A file that will not decode must not become a broken preview the
      // customer reads as accepted.
      img.onerror = () => setImgError("We couldn't read that image. Try exporting it again as a PNG.");
      img.src = url;
    };
    reader.onerror = () => setImgError("We couldn't read that file.");
    reader.readAsDataURL(file);
  }

  // ── Ordering ──────────────────────────────────────────────────────────────
  const [orderOpen, setOrderOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [who, setWho] = useState({ name: "", email: "", phone: "" });

  function designSummary(): string {
    const sizes = SIZES.filter((s) => qty[s] > 0).map((s) => `${s}×${qty[s]}`).join(", ");
    const art =
      artwork.kind === "image" ? `Uploaded image: ${imgName}`
      : artwork.kind === "text" ? `Text: "${text.replace(/\n/g, " / ")}" — ${font.label}, ${ink.label} ink`
      : "No design yet";
    return [
      `CUSTOM TEE — designed in the studio`,
      `Garment: ${garment?.name ?? "tee"} · ${colour.label}`,
      `Sizes: ${sizes || "not set"} (${totalQty} total)`,
      `Print: ${placement.widthMm}mm wide, front`,
      art,
    ].join("\n");
  }

  async function sendOrder(e: React.FormEvent) {
    e.preventDefault();
    if (!garment) return;
    setSending(true); setOrderError(null);
    try {
      const r = await fetch(ORDER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          name: who.name, email: who.email, phone: who.phone,
          note: designSummary(),
          // So Dima can tell a studio design apart from a banner enquiry in the
          // Quotes tab without opening it.
          source: "tee-studio",
          sourceUrl: typeof window !== "undefined" ? window.location.href : undefined,
          items: [{
            materialSlug: garment.slug,
            widthMm: placement.widthMm,
            heightMm: placement.widthMm,
            quantity: totalQty,
            design: artwork.kind === "text" ? text.replace(/\n/g, " / ") : "Custom uploaded artwork",
            design_file: imgName ?? undefined,
          }],
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setOrderError(data?.message ?? "We couldn't send that. Give us a call on 0800 800 199."); return; }
      setSent(true);
    } catch {
      setOrderError("Couldn't reach us just now. Check your connection and try again.");
    } finally { setSending(false); }
  }

  // ── States ────────────────────────────────────────────────────────────────
  if (isLoading) {
    return <UpShell><p className="py-32 text-center text-[15px]">Loading the studio…</p></UpShell>;
  }
  if (isError) {
    return (
      <UpShell>
        <div className="py-24 text-center">
          <h1 className={`${upDisplay} text-3xl text-[#012583]`}>We couldn't load the studio</h1>
          <p className="mt-3 text-[15px]">That's on our end. Try again in a moment.</p>
        </div>
      </UpShell>
    );
  }
  if (!garment) {
    return (
      <UpShell>
        <div className="mx-auto max-w-lg px-5 py-24 text-center">
          <h1 className={`${upDisplay} text-3xl text-[#012583]`}>Custom tees are nearly ready</h1>
          <p className="mt-3 text-[15px] leading-relaxed">
            We're finishing the garment range and pricing. Tell us what you're after and we'll quote it the same day.
          </p>
          <a href="https://unitedprints.co.nz/contact" className={`${upBtn.green} mt-7`}>Ask for a quote</a>
        </div>
      </UpShell>
    );
  }

  const line = price?.lines?.[0];

  return (
    <UpShell>
      <section className="mx-auto max-w-6xl px-5 pt-10 sm:px-8 sm:pt-14">
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#043bcb]">Design studio</p>
        <h1 className={`${upDisplay} mt-2 text-4xl text-[#012583] sm:text-6xl`}>
          Put anything<br />
          <span className="text-[#33cc00]">on a t-shirt.</span>
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed sm:text-lg">
          Your photo, your logo or your words. Design it here, see it on the shirt, and send it
          through — we check the artwork before anything is printed. Made in Christchurch.
        </p>
      </section>

      <div className="mx-auto mt-10 grid max-w-6xl gap-8 px-5 pb-8 sm:px-8 lg:grid-cols-[minmax(0,1fr)_420px]">
        {/* ── The shirt ── */}
        <div className="lg:order-2">
          <div className="sticky top-24 rounded-3xl border border-[#cbd1de]/70 bg-white p-4 shadow-[0_1px_2px_rgba(1,37,131,.04),0_18px_44px_-20px_rgba(1,37,131,.24)] sm:p-6">
            <TeeMockup colour={colour} artwork={artwork} placement={placement} onPlacementChange={setPlacement} />
            <p className="mt-1 text-center text-[12px] leading-relaxed text-[#4a5265]/70">
              {artwork.kind === "none"
                ? "Add your design on the left and it appears here."
                : "Drag your design to move it. Preview only — colours shift slightly in print."}
            </p>
          </div>
        </div>

        {/* ── The controls ── */}
        <div className="space-y-9 lg:order-1">
          {/* Colour */}
          <section>
            <h2 className={`${upDisplay} text-lg text-[#012583]`}>1 · Shirt colour</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {TEE_COLOURS.map((c) => (
                <button
                  key={c.id} onClick={() => setColourId(c.id)} aria-pressed={colourId === c.id} title={c.label}
                  className={`flex h-11 w-11 items-center justify-center rounded-full border-2 transition ${
                    colourId === c.id ? "border-[#043bcb] scale-110" : "border-black/10 hover:border-black/30"
                  }`}
                >
                  <span className="h-7 w-7 rounded-full border border-black/10" style={{ background: c.hex }} />
                </button>
              ))}
            </div>
            <p className="mt-2 text-[13px] text-[#4a5265]/80">
              <span className="font-semibold text-[#012583]">{colour.label}</span> · we'll confirm the exact shade and stock before printing.
            </p>
          </section>

          {/* Design */}
          <section>
            <h2 className={`${upDisplay} text-lg text-[#012583]`}>2 · Your design</h2>
            <div className="mt-3 inline-flex rounded-full bg-[#012583]/6 p-1">
              {(["text", "image"] as const).map((t) => (
                <button
                  key={t} onClick={() => setTab(t)} aria-pressed={tab === t}
                  className={`min-h-[40px] rounded-full px-5 text-[13px] font-bold uppercase tracking-wide transition ${
                    tab === t ? "bg-white text-[#043bcb] shadow-sm" : "text-[#012583]/60 hover:text-[#012583]"
                  }`}
                >
                  {t === "text" ? "Add text" : "Upload image"}
                </button>
              ))}
            </div>

            {tab === "text" ? (
              <div className="mt-4 space-y-4">
                <div>
                  <label htmlFor="st-text" className={upLabel}>Your words</label>
                  <textarea
                    id="st-text" rows={2} value={text} maxLength={80}
                    onChange={(e) => setText(e.target.value.slice(0, 80))}
                    className={`${upField} resize-none`}
                    placeholder={"DAD\nSINCE 2019"}
                  />
                  <p className="mt-1 text-[12px] text-[#4a5265]/70">One line per row. Up to 80 characters.</p>
                </div>

                <div>
                  <span className={upLabel}>Font</span>
                  <div className="flex flex-wrap gap-2">
                    {FONTS.map((f) => (
                      <button
                        key={f.id} onClick={() => setFontId(f.id)} aria-pressed={fontId === f.id}
                        style={{ fontFamily: f.css, fontWeight: f.weight }}
                        className={`min-h-[44px] rounded-xl border px-4 text-[15px] transition ${
                          fontId === f.id ? "border-[#043bcb] bg-[#043bcb]/6 text-[#043bcb]" : "border-[#cbd1de] text-[#012583] hover:border-[#4a5265]/50"
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <span className={upLabel}>Ink colour</span>
                  <div className="flex flex-wrap gap-2">
                    {INK.map((i) => (
                      <button
                        key={i.id} onClick={() => setInkId(i.id)} aria-pressed={inkId === i.id} title={i.label}
                        className={`flex h-11 w-11 items-center justify-center rounded-full border-2 transition ${
                          inkId === i.id ? "border-[#043bcb] scale-110" : "border-black/10 hover:border-black/30"
                        }`}
                      >
                        <span className="h-7 w-7 rounded-full border border-black/15" style={{ background: i.hex }} />
                      </button>
                    ))}
                  </div>
                  {/* An honest nudge rather than a blocked choice — white ink on a
                      white shirt is a real thing people do by accident. */}
                  {!colour.dark && inkId === "white" && (
                    <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[13px] leading-relaxed text-amber-800">
                      White ink on a light shirt will barely show. Try a darker ink, or a darker shirt.
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="st-track" className={upLabel}>Letter spacing</label>
                  <input
                    id="st-track" type="range" min={-0.04} max={0.3} step={0.01} value={tracking}
                    onChange={(e) => setTracking(Number(e.target.value))}
                    className="w-full accent-[#043bcb]"
                  />
                </div>
              </div>
            ) : (
              <div className="mt-4">
                <input
                  ref={fileRef} type="file" className="sr-only"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  onChange={(e) => onFile(e.target.files?.[0])}
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  className="min-h-[96px] w-full rounded-2xl border-2 border-dashed border-[#cbd1de] bg-white px-5 text-[14px] font-bold text-[#012583] transition hover:border-[#043bcb] hover:text-[#043bcb]"
                >
                  {imgName ? `${imgName} — choose another` : "Upload your photo or logo"}
                </button>
                {imgUrl && (
                  <button
                    onClick={() => { setImgUrl(null); setImgName(null); setImgAspect(1); }}
                    className="mt-2 min-h-[44px] text-[13px] font-semibold text-[#4a5265] underline-offset-4 hover:underline"
                  >
                    Remove image
                  </button>
                )}
                {imgError && (
                  <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-[13px] text-rose-700">{imgError}</p>
                )}
                <p className="mt-2 text-[12px] leading-relaxed text-[#4a5265]/75">
                  This is a preview only — nothing is uploaded yet. We'll ask for the print-ready file once your
                  order is confirmed, and we'll check it before we print.
                </p>
              </div>
            )}
          </section>

          {/* Size + position */}
          <section>
            <h2 className={`${upDisplay} text-lg text-[#012583]`}>3 · Size on the shirt</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => setPlacement({ ...placement, widthMm: p.widthMm })}
                  aria-pressed={placement.widthMm === p.widthMm}
                  className={`min-h-[44px] rounded-full border px-4 text-[13px] font-bold transition ${
                    placement.widthMm === p.widthMm
                      ? "border-[#043bcb] bg-[#043bcb]/6 text-[#043bcb]"
                      : "border-[#cbd1de] text-[#012583] hover:border-[#4a5265]/50"
                  }`}
                >
                  {p.label} · {p.widthMm}mm
                </button>
              ))}
            </div>
            <div className="mt-4">
              <label htmlFor="st-w" className={upLabel}>Print width — {placement.widthMm}mm</label>
              <input
                id="st-w" type="range" min={40} max={MAX_MM} step={5} value={placement.widthMm}
                onChange={(e) => setPlacement({ ...placement, widthMm: Number(e.target.value) })}
                className="w-full accent-[#043bcb]"
              />
            </div>
          </section>

          {/* Sizes */}
          <section>
            <h2 className={`${upDisplay} text-lg text-[#012583]`}>4 · How many, and what sizes</h2>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
              {SIZES.map((size) => (
                <div key={size} className="rounded-xl border border-[#cbd1de] bg-white p-2 text-center">
                  <label htmlFor={`q-${size}`} className="block text-[13px] font-extrabold text-[#012583]">{size}</label>
                  <input
                    id={`q-${size}`} inputMode="numeric" value={qty[size] || ""} placeholder="0"
                    onChange={(e) => setQty({ ...qty, [size]: Number(e.target.value.replace(/[^\d]/g, "").slice(0, 4)) || 0 })}
                    className="mt-1 w-full rounded-lg border border-[#cbd1de] py-2 text-center text-[15px] font-bold tabular-nums text-[#012583] outline-none focus:border-[#043bcb]"
                  />
                </div>
              ))}
            </div>
            <p className="mt-2 text-[13px] font-bold text-[#012583]">{totalQty} shirt{totalQty === 1 ? "" : "s"}</p>
          </section>

          {/* Price */}
          <section className="rounded-2xl border border-[#cbd1de]/70 bg-white p-5">
            <h2 className={`${upDisplay} text-lg text-[#012583]`}>Your price</h2>
            {totalQty < 1 ? (
              <p className="mt-2 text-[14px]">Add some sizes above and the price appears here.</p>
            ) : pricing ? (
              <p className="mt-2 text-[14px] text-[#4a5265]/70">Working it out…</p>
            ) : line?.ok ? (
              <>
                {price?.accountPricing?.applied && (
                  <p className="mt-2 inline-flex rounded-full bg-[#33cc00]/14 px-3 py-1 text-[13px] font-extrabold text-[#1f7a00]">
                    Your {price.accountPricing.discountPct}% account rate is applied
                  </p>
                )}
                <ul className="mt-3 space-y-1.5 border-t border-[#cbd1de]/60 pt-3">
                  {line.breakdown.map((b, i) => (
                    <li key={i} className="flex justify-between gap-4 text-[14px]">
                      <span>{b.label}</span>
                      <span className={`font-bold tabular-nums ${b.cents < 0 ? "text-[#1f7a00]" : "text-[#012583]"}`}>
                        {b.cents < 0 ? "−" : ""}{money(Math.abs(b.cents))}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 border-t border-[#cbd1de]/60 pt-3">
                  <div className="flex justify-between text-[14px]"><span>GST</span><span className="tabular-nums">{money(price!.gstCents)}</span></div>
                  <div className="mt-1 flex justify-between text-[20px] font-extrabold text-[#012583]">
                    <span>Total</span><span className="tabular-nums">{money(price!.totalCents)}</span>
                  </div>
                  <p className="mt-1 text-[13px] text-[#4a5265]/80">
                    {money(Math.round(price!.totalCents / totalQty))} a shirt · ready in about {garment.turnaroundDays} working days
                  </p>
                </div>
              </>
            ) : line?.message ? (
              <p className="mt-2 text-[14px] leading-relaxed">{line.message}</p>
            ) : null}

            <button
              onClick={() => setOrderOpen(true)}
              disabled={totalQty < 1 || artwork.kind === "none"}
              className={`${upBtn.green} mt-5 w-full disabled:cursor-not-allowed disabled:opacity-45`}
            >
              {artwork.kind === "none" ? "Add a design first" : totalQty < 1 ? "Add some sizes first" : "Send my order"}
            </button>
            <p className="mt-2 text-center text-[12px] leading-relaxed text-[#4a5265]/75">
              We'll confirm sizes, stock and artwork, then send you a payment link. Nothing is charged yet.
            </p>
          </section>
        </div>
      </div>

      {/* ── Order sheet ── */}
      {orderOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#012583]/40 p-0 backdrop-blur-sm sm:items-center sm:p-6">
          <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-6 sm:rounded-3xl sm:p-8">
            {sent ? (
              <div className="text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#33cc00]/15 text-3xl">✓</div>
                <h2 className={`${upDisplay} mt-4 text-2xl text-[#012583]`}>We've got it</h2>
                <p className="mt-3 text-[15px] leading-relaxed">
                  Your design is with our team. We'll check it, confirm your sizes and send you a payment
                  link — usually the same day. Keep an eye on <span className="font-semibold text-[#012583]">{who.email}</span>.
                </p>
                <button onClick={() => { setOrderOpen(false); setSent(false); }} className={`${upBtn.royal} mt-6 w-full`}>
                  Done
                </button>
              </div>
            ) : (
              <form onSubmit={sendOrder}>
                <h2 className={`${upDisplay} text-2xl text-[#012583]`}>Send your order</h2>
                <p className="mt-2 text-[14px] leading-relaxed">
                  {totalQty} × {colour.label} tee, {placement.widthMm}mm front print.
                  {price?.totalCents ? <> Around <span className="font-bold text-[#012583]">{money(price.totalCents)}</span> incl GST.</> : null}
                </p>
                <div className="mt-5 space-y-4">
                  <div>
                    <label htmlFor="o-name" className={upLabel}>Your name</label>
                    <input id="o-name" required autoComplete="name" className={upField}
                           value={who.name} onChange={(e) => setWho({ ...who, name: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor="o-email" className={upLabel}>Email</label>
                    <input id="o-email" type="email" required autoComplete="email" className={upField}
                           value={who.email} onChange={(e) => setWho({ ...who, email: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor="o-phone" className={upLabel}>Phone</label>
                    <input id="o-phone" type="tel" required autoComplete="tel" className={upField}
                           value={who.phone} onChange={(e) => setWho({ ...who, phone: e.target.value })} />
                  </div>
                </div>
                {orderError && (
                  <p role="alert" className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-[14px] text-rose-700">{orderError}</p>
                )}
                <button type="submit" disabled={sending} className={`${upBtn.green} mt-6 w-full disabled:opacity-50`}>
                  {sending ? "Sending…" : "Send it through"}
                </button>
                <button type="button" onClick={() => setOrderOpen(false)}
                        className="mt-3 min-h-[44px] w-full text-[14px] font-semibold text-[#4a5265] underline-offset-4 hover:underline">
                  Back to designing
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </UpShell>
  );
}
