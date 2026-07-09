// ─────────────────────────────────────────────────────────────────────────────
// TemplateGallery — the premium "start from a gorgeous design, not a blank page"
// picker for the visual email builder.
//
// Shows a grid of pre-designed, BRAND-ADAPTIVE starter templates (see
// grapes/templates). Each card renders a LIVE mini-preview: the template's MJML
// is compiled to HTML in-browser (mjml-browser — the same compiler the builder
// uses) and shown in a scaled, non-interactive iframe, so the card is true
// WYSIWYG for the current workspace's brand. "Use this template" hands the chosen
// { engine:'grapesjs-mjml', version:1, mjml } doc back to the builder.
//
// Two presentations from one body:
//   • variant="screen" — the full-panel start screen shown on a fresh builder.
//   • variant="modal"  — an overlay reachable from the builder toolbar any time.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBrandMeta } from "./brand-themes";
import {
  STARTER_TEMPLATES,
  templatesForBrand,
  templateDoc,
  CATEGORY_META,
  type StarterTemplate,
  type StarterTemplateDoc,
  type TemplateCategory,
} from "./grapes/templates";

// ── in-browser MJML compile (lazy — the compiler is a heavy chunk) ───────────────
type Mjml2Html = (mjml: string, opts?: Record<string, unknown>) => { html: string };
let mjmlLoader: Promise<Mjml2Html> | null = null;
function loadMjml(): Promise<Mjml2Html> {
  if (!mjmlLoader) {
    mjmlLoader = import("mjml-browser").then((m) => m.default as unknown as Mjml2Html);
  }
  return mjmlLoader;
}
const HTML_CACHE = new Map<string, string>();
async function compilePreview(t: StarterTemplate, brandKey: string): Promise<string> {
  const key = `${t.id}:${brandKey}`;
  const hit = HTML_CACHE.get(key);
  if (hit != null) return hit;
  const mjml2html = await loadMjml();
  const { mjml } = templateDoc(t, brandKey);
  const html = mjml2html(mjml, { validationLevel: "soft" }).html;
  HTML_CACHE.set(key, html);
  return html;
}

// ── measure a container's width (for crisp iframe scaling) ───────────────────────
function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width ?? el.clientWidth;
      setW(cw);
    });
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const PREVIEW_H = 208; // px of the email top shown on each card

/** The scaled, non-interactive live preview of a compiled template. */
function MiniPreview({ t, brandKey }: { t: StarterTemplate; brandKey: string }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [html, setHtml] = useState<string | null>(() => HTML_CACHE.get(`${t.id}:${brandKey}`) ?? null);

  useEffect(() => {
    if (html != null) return;
    let alive = true;
    compilePreview(t, brandKey)
      .then((h) => alive && setHtml(h))
      .catch(() => alive && setHtml(""));
    return () => {
      alive = false;
    };
  }, [t, brandKey, html]);

  const scale = width > 0 ? width / 600 : 0;

  return (
    <div
      ref={wrapRef}
      className="relative w-full overflow-hidden bg-white"
      style={{ height: PREVIEW_H }}
    >
      {html && scale > 0 ? (
        <iframe
          title={`${t.name} preview`}
          aria-hidden
          tabIndex={-1}
          sandbox=""
          scrolling="no"
          srcDoc={html}
          style={{
            width: 600,
            height: Math.ceil(PREVIEW_H / scale),
            border: 0,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            pointerEvents: "none",
          }}
        />
      ) : (
        <div className="absolute inset-0 animate-pulse bg-gradient-to-b from-muted/60 to-muted/20" />
      )}
      {/* soft fade so the clipped email bottom doesn't look cut off */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/10 to-transparent" />
    </div>
  );
}

// ── one template card ────────────────────────────────────────────────────────────
function TemplateCard({
  t,
  brandKey,
  accent,
  onAccent,
  onUse,
}: {
  t: StarterTemplate;
  brandKey: string;
  accent: string;
  onAccent: string;
  onUse: (t: StarterTemplate) => void;
}) {
  return (
    <div className="group flex flex-col overflow-hidden rounded-xl border bg-card shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="relative border-b">
        <MiniPreview t={t} brandKey={brandKey} />
        <span
          className="absolute left-2.5 top-2.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide shadow-sm"
          style={{ backgroundColor: accent, color: onAccent }}
        >
          {CATEGORY_META[t.category].label}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3.5">
        <h4 className="text-sm font-semibold leading-tight">{t.name}</h4>
        <p className="mb-2 line-clamp-2 text-xs text-muted-foreground">{t.description}</p>
        <button
          type="button"
          onClick={() => onUse(t)}
          className="mt-auto w-full rounded-lg px-3 py-2 text-xs font-semibold transition hover:opacity-90"
          style={{ backgroundColor: accent, color: onAccent }}
          data-testid={`mkt-template-use-${t.id}`}
        >
          Use this template
        </button>
      </div>
    </div>
  );
}

// ── the shared body (grid + filters + blank tile) ────────────────────────────────
function GalleryBody({
  brandKey,
  onUse,
  onBlank,
}: {
  brandKey: string;
  onUse: (doc: StarterTemplateDoc) => void;
  onBlank: () => void;
}) {
  const brand = getBrandMeta(brandKey);
  const templates = useMemo(() => templatesForBrand(brandKey), [brandKey]);
  const [filter, setFilter] = useState<TemplateCategory | "all">("all");

  const categories = useMemo(() => {
    const seen = new Set<TemplateCategory>();
    for (const t of templates) seen.add(t.category);
    return Array.from(seen);
  }, [templates]);

  const shown = filter === "all" ? templates : templates.filter((t) => t.category === filter);

  const use = useCallback(
    (t: StarterTemplate) => onUse(templateDoc(t, brandKey)),
    [brandKey, onUse],
  );

  return (
    <>
      {/* category filter */}
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip active={filter === "all"} accent={brand.accent} onAccent={brand.onAccent} onClick={() => setFilter("all")}>
          All designs
        </FilterChip>
        {categories.map((c) => (
          <FilterChip
            key={c}
            active={filter === c}
            accent={brand.accent}
            onAccent={brand.onAccent}
            onClick={() => setFilter(c)}
          >
            {CATEGORY_META[c].label}
          </FilterChip>
        ))}
      </div>

      {/* grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((t) => (
          <TemplateCard
            key={t.id}
            t={t}
            brandKey={brandKey}
            accent={brand.accent}
            onAccent={brand.onAccent}
            onUse={use}
          />
        ))}

        {/* start-from-blank tile */}
        <button
          type="button"
          onClick={onBlank}
          data-testid="mkt-template-blank"
          className="flex min-h-[280px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center transition hover:border-solid hover:bg-muted/40"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-full border text-xl text-muted-foreground">
            +
          </span>
          <span className="text-sm font-semibold">Start from blank</span>
          <span className="text-xs text-muted-foreground">
            Begin with a clean, on-brand {brand.name} layout and build it your way.
          </span>
        </button>
      </div>
    </>
  );
}

function FilterChip({
  active,
  accent,
  onAccent,
  onClick,
  children,
}: {
  active: boolean;
  accent: string;
  onAccent: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
        active ? "border-transparent" : "text-muted-foreground hover:bg-muted"
      }`}
      style={active ? { backgroundColor: accent, color: onAccent } : undefined}
    >
      {children}
    </button>
  );
}

// ── public component ─────────────────────────────────────────────────────────────
export interface TemplateGalleryProps {
  brandKey: string;
  /** "screen" = full inline start panel; "modal" = dismissable overlay */
  variant?: "screen" | "modal";
  onUse: (doc: StarterTemplateDoc) => void;
  onBlank: () => void;
  /** modal only — close without choosing */
  onClose?: () => void;
}

export default function TemplateGallery({
  brandKey,
  variant = "screen",
  onUse,
  onBlank,
  onClose,
}: TemplateGalleryProps) {
  // Esc closes the modal.
  useEffect(() => {
    if (variant !== "modal" || !onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant, onClose]);

  const count = STARTER_TEMPLATES.filter(
    (t) => t.brandKeys === "all" || t.brandKeys.includes(brandKey),
  ).length;

  const heading = (
    <div>
      <h3 className="text-base font-semibold">Start with a template</h3>
      <p className="text-xs text-muted-foreground">
        {count} premium {getBrandMeta(brandKey).name} designs — ready to send, easy to make yours.
      </p>
    </div>
  );

  if (variant === "modal") {
    return (
      <div
        className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:p-8"
        onClick={onClose}
        data-testid="mkt-template-gallery-modal"
      >
        <div
          className="my-auto w-full max-w-5xl rounded-2xl border bg-background shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-3 border-b p-5">
            {heading}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border px-2.5 py-1 text-sm font-medium text-muted-foreground hover:bg-muted"
                aria-label="Close template gallery"
              >
                ✕
              </button>
            )}
          </div>
          <div className="flex flex-col gap-4 p-5">
            <GalleryBody brandKey={brandKey} onUse={onUse} onBlank={onBlank} />
          </div>
        </div>
      </div>
    );
  }

  // screen
  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-muted/20 p-5" data-testid="mkt-template-gallery">
      {heading}
      <GalleryBody brandKey={brandKey} onUse={onUse} onBlank={onBlank} />
    </div>
  );
}
