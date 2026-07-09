// ─────────────────────────────────────────────────────────────────────────────
// EmailBuilder — the premium drag-and-drop block email builder (Phase D).
//
// This file is the CONTRACT between the Marketing tab pages (Phase C) and the
// editor. Phase C React.lazy()-imports this path; the exported
// EmailBuilderProps / EmailBuilderResult / default export are the agreed surface
// and MUST stay compatible with the original stub.
//
// The engine is GrapesJS + grapesjs-mjml (a true section/row/column drag canvas
// that compiles to Outlook-hardened MJML→HTML) — it lives in
// ./email-editor-surface and is itself React.lazy()-loaded here, so this wrapper
// (action bar, size guard, merge-tag helper, error boundary, mobile fallback)
// renders instantly and the heavy editor chunk streams in behind a spinner.
//
// GrapesJS owns the canvas, the device (mobile/desktop) preview, and the code
// view in its own toolbar — so this wrapper no longer renders a separate preview
// iframe. It keeps: the Gmail size guard on save, the merge-tag affordance, the
// error boundary, and a graceful plain-HTML fallback on phones (the 3-pane
// builder is unusable below ~768px).
// ─────────────────────────────────────────────────────────────────────────────

import React, { Component, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { getBrandMeta } from "./brand-themes";
import TemplateGallery from "./TemplateGallery";
import type { StarterTemplateDoc } from "./grapes/templates";
import type { EmailEditorSurfaceHandle } from "./email-editor-surface";

/** What the builder hands back on save: the doc (source of truth, persisted to
 *  mkt_templates.block_tree / campaign drafts) plus the compiled email-safe HTML
 *  + plaintext (persisted to mkt_campaigns.body_html for sending).
 *
 *  With the GrapesJS engine `doc` is `{ engine:'grapesjs-mjml', version, mjml,
 *  project }`; on the mobile plain-HTML fallback it is `{ engine:'html', html }`.
 *  Typed `unknown` so the store stays engine-agnostic. */
export interface EmailBuilderResult {
  doc: unknown;
  html: string;
  text: string;
}

export interface EmailBuilderProps {
  workspaceId: number;
  /** brand key from shared/org-domains.ts — drives the per-brand editor theme */
  brandKey: string;
  /** existing doc when editing a draft/template; null for blank */
  initialDoc?: unknown | null;
  /** called with doc + compiled html/text whenever the user saves */
  onSave: (result: EmailBuilderResult) => void | Promise<void>;
  /** optional: notify parent of unsaved changes */
  onDirty?: () => void;
}

// Gmail clips emails whose raw HTML crosses ~102KB. Warn early, block before it.
const WARN_BYTES = 80 * 1024;
const BLOCK_BYTES = 100 * 1024;

const MERGE_TAGS: { label: string; tag: string }[] = [
  { label: "First name", tag: "{{first_name}}" },
  { label: "Last name", tag: "{{last_name}}" },
  { label: "Email", tag: "{{email}}" },
  { label: "Unsubscribe URL", tag: "{{unsubscribe_url}}" },
];

function byteLength(s: string): number {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length;
  }
}
function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)}KB`;
}
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when an initialDoc carries real content — so we skip the template gallery
 *  (editing an existing design) and open straight into the builder. */
function isMeaningfulDoc(doc: unknown): boolean {
  if (!doc) return false;
  if (typeof doc === "string") return doc.trim().length > 0;
  if (typeof doc === "object") {
    const d = doc as Record<string, unknown>;
    if (typeof d.mjml === "string" && d.mjml.trim()) return true;
    if (d.project) return true;
    if (typeof d.html === "string" && d.html.trim()) return true;
    if (d.type === "doc") return true; // legacy Tiptap
  }
  return false;
}

/** True below ~768px, where the 3-pane builder is too cramped to use. */
function useIsNarrow(maxWidth = 767): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return narrow;
}

// Lazy boundary for the heavy editor package.
const LazySurface = React.lazy(() => import("./email-editor-surface"));

// ── Local error boundary so a package fault degrades gracefully ───────────────
class SurfaceErrorBoundary extends Component<
  { children: React.ReactNode; onRetry: () => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error("[EmailBuilder] editor crashed:", error);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12 text-center text-sm">
          <p className="font-medium">The email editor hit a snag.</p>
          <p className="text-muted-foreground">
            Your saved content is safe. Reload the editor to keep going.
          </p>
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            onClick={() => {
              this.setState({ error: null });
              this.props.onRetry();
            }}
          >
            Reload editor
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function LoadingSurface() {
  return (
    <div className="mkt-grapes-holder flex items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">
      Loading the email builder…
    </div>
  );
}

export default function EmailBuilder({
  brandKey,
  initialDoc,
  onSave,
  onDirty,
}: EmailBuilderProps) {
  const surfaceRef = useRef<EmailEditorSurfaceHandle | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sizeNote, setSizeNote] = useState<string | null>(null);
  const [surfaceKey, setSurfaceKey] = useState(0);
  const isNarrow = useIsNarrow();

  // Template gallery: a fresh builder (no meaningful initialDoc) opens on the
  // "start from a template or blank" screen instead of a blank canvas. Once a
  // starting point is chosen, `activeDoc` is what the surface loads; the gallery
  // is reachable again from the toolbar (replaces the design after a confirm).
  const startedWithDoc = isMeaningfulDoc(initialDoc);
  const [activeDoc, setActiveDoc] = useState<unknown | null>(initialDoc ?? null);
  const [chosen, setChosen] = useState<boolean>(startedWithDoc);
  const [galleryOpen, setGalleryOpen] = useState<boolean>(false);

  const applyTemplate = useCallback((doc: StarterTemplateDoc) => {
    setActiveDoc(doc);
    setChosen(true);
    setGalleryOpen(false);
    setSurfaceKey((k) => k + 1); // remount the surface with the chosen doc
  }, []);
  const startBlank = useCallback(() => {
    setActiveDoc(null); // null → the on-brand blank starter (grapes/brand buildStarterMjml)
    setChosen(true);
    setGalleryOpen(false);
    setSurfaceKey((k) => k + 1);
  }, []);
  // Reopened from the toolbar — replacing existing work needs a confirm.
  const replaceWithTemplate = useCallback(
    (doc: StarterTemplateDoc) => {
      if (!window.confirm("Start from this template? It replaces your current design.")) return;
      applyTemplate(doc);
    },
    [applyTemplate],
  );
  const replaceWithBlank = useCallback(() => {
    if (!window.confirm("Start from a blank layout? It replaces your current design.")) return;
    startBlank();
  }, [startBlank]);

  // Mobile plain-HTML fallback state (seeded from a legacy html-shaped doc).
  const seededHtml =
    initialDoc && typeof initialDoc === "object" && typeof (initialDoc as { html?: unknown }).html === "string"
      ? ((initialDoc as { html: string }).html)
      : "";
  const [mobileHtml, setMobileHtml] = useState<string>(seededHtml);

  const brand = getBrandMeta(brandKey);

  const insertTag = useCallback((tag: string) => {
    surfaceRef.current?.insertText(tag);
  }, []);

  // Shared guard + persist for BOTH desktop and mobile save paths.
  const commit = useCallback(
    async (result: EmailBuilderResult): Promise<void> => {
      const bytes = byteLength(result.html);
      if (bytes >= BLOCK_BYTES) {
        setError(
          `This email is ${kb(bytes)} — Gmail clips emails over 102KB. Trim images or content before sending.`,
        );
        setSizeNote(null);
        return;
      }
      setSizeNote(
        bytes >= WARN_BYTES
          ? `Heads up: this email is ${kb(bytes)}. Gmail clips over 102KB — keep it lean.`
          : null,
      );
      await onSave(result);
    },
    [onSave],
  );

  const handleSaveDesktop = useCallback(async () => {
    const surface = surfaceRef.current;
    if (!surface?.isReady()) {
      setError("The editor is still loading — try again in a moment.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await surface.getResult();
      await commit(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the email.");
    } finally {
      setSaving(false);
    }
  }, [commit]);

  const handleSaveMobile = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await commit({
        doc: { engine: "html", html: mobileHtml },
        html: mobileHtml,
        text: stripHtml(mobileHtml),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the email.");
    } finally {
      setSaving(false);
    }
  }, [commit, mobileHtml]);

  return (
    <div className="flex flex-col gap-3">
      {/* Action bar — hidden on the desktop template-gallery start screen */}
      {(isNarrow || chosen) && (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2">
        {!isNarrow && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">Personalise:</span>
            {MERGE_TAGS.map((m) => (
              <button
                key={m.tag}
                type="button"
                onClick={() => insertTag(m.tag)}
                className="rounded-full border px-2.5 py-1 font-mono text-[11px] hover:bg-muted"
                title={`Insert ${m.tag} — swapped for each recipient's ${m.label.toLowerCase()} at send`}
              >
                {m.tag}
              </button>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {!isNarrow && chosen && (
            <button
              type="button"
              onClick={() => setGalleryOpen(true)}
              className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
              data-testid="mkt-open-template-gallery"
              title="Browse starter templates"
            >
              Templates
            </button>
          )}
          <span
            className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"
            title={`This builder is themed for ${brand.name}`}
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: brand.accent }}
            />
            {brand.name}
          </span>
          <button
            type="button"
            onClick={isNarrow ? handleSaveMobile : handleSaveDesktop}
            disabled={saving}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      )}

      {/* Messages */}
      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}
      {sizeNote && !error && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          {sizeNote}
        </div>
      )}

      {isNarrow ? (
        /* ── Mobile / narrow fallback ──────────────────────────────────────── */
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-dashed bg-muted/20 p-4 text-sm">
            <p className="font-medium">The visual builder is designed for a larger screen.</p>
            <p className="mt-1 text-muted-foreground">
              Open this on a laptop to drag-and-drop your design. On a phone you can still edit the
              raw HTML below and preview it — merge tags like{" "}
              <code className="font-mono text-[11px]">{"{{first_name}}"}</code> and{" "}
              <code className="font-mono text-[11px]">{"{{unsubscribe_url}}"}</code> work here too.
            </p>
          </div>
          <textarea
            value={mobileHtml}
            onChange={(e) => {
              setMobileHtml(e.target.value);
              onDirty?.();
            }}
            rows={12}
            placeholder="<p>Write or paste your email HTML here…</p>"
            className="w-full rounded-lg border bg-background p-3 font-mono text-xs"
          />
          <div className="rounded-lg border bg-neutral-100 p-3 dark:bg-neutral-900">
            <p className="mb-2 text-[11px] font-medium text-muted-foreground">Preview</p>
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={
                mobileHtml ||
                "<p style='font-family:sans-serif;padding:24px;color:#888'>Nothing to preview yet.</p>"
              }
              className="w-full rounded-md border-0 bg-white"
              style={{ height: 420, boxShadow: "0 4px 24px rgba(0,0,0,0.12)" }}
            />
          </div>
        </div>
      ) : !chosen ? (
        /* ── Template gallery start screen (fresh campaign, desktop) ────────── */
        <TemplateGallery
          variant="screen"
          brandKey={brandKey}
          onUse={applyTemplate}
          onBlank={startBlank}
        />
      ) : (
        /* ── Desktop 3-pane builder ────────────────────────────────────────── */
        <>
          <SurfaceErrorBoundary onRetry={() => setSurfaceKey((k) => k + 1)}>
            <Suspense fallback={<LoadingSurface />}>
              <LazySurface
                key={surfaceKey}
                ref={surfaceRef}
                brandKey={brandKey}
                initialDoc={activeDoc}
                onDirty={onDirty}
              />
            </Suspense>
          </SurfaceErrorBoundary>
          {galleryOpen && (
            <TemplateGallery
              variant="modal"
              brandKey={brandKey}
              onUse={replaceWithTemplate}
              onBlank={replaceWithBlank}
              onClose={() => setGalleryOpen(false)}
            />
          )}
        </>
      )}
    </div>
  );
}
