// ─────────────────────────────────────────────────────────────────────────────
// EmailBuilder — the premium block email builder (Phase D).
//
// This file is the CONTRACT between the Marketing tab pages (Phase C) and the
// editor. Phase C React.lazy()-imports this path; the exported
// EmailBuilderProps / EmailBuilderResult / default export are the agreed surface
// and MUST stay compatible with the original stub.
//
// The heavy @react-email/editor bundle (~836KB gzip) lives in
// ./email-editor-surface and is itself React.lazy()-loaded here, so this wrapper
// (toolbar, size guard, merge-tag helper, preview, error boundary) renders
// instantly and the editor chunk streams in behind a spinner.
// ─────────────────────────────────────────────────────────────────────────────

import React, { Component, Suspense, useCallback, useRef, useState } from "react";
import { getBrandMeta } from "./brand-themes";
import type { EmailEditorSurfaceHandle } from "./email-editor-surface";

/** What the builder hands back on save: the Tiptap JSON doc (source of truth,
 *  persisted to mkt_templates.block_tree / campaign drafts) plus the compiled
 *  email-safe HTML + plaintext (persisted to mkt_campaigns.body_html for sending). */
export interface EmailBuilderResult {
  doc: unknown;
  html: string;
  text: string;
}

export interface EmailBuilderProps {
  workspaceId: number;
  /** brand key from shared/org-domains.ts — drives the per-brand editor theme */
  brandKey: string;
  /** existing Tiptap JSON doc when editing a draft/template; null for blank */
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
    <div className="flex items-center justify-center rounded-lg border border-dashed p-12 text-sm text-muted-foreground">
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
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [device, setDevice] = useState<"mobile" | "desktop">("desktop");
  const [previewHtml, setPreviewHtml] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sizeNote, setSizeNote] = useState<string | null>(null);
  const [surfaceKey, setSurfaceKey] = useState(0);

  const brand = getBrandMeta(brandKey);

  const insertTag = useCallback((tag: string) => {
    surfaceRef.current?.insertText(tag);
  }, []);

  const handleSave = useCallback(async () => {
    const surface = surfaceRef.current;
    if (!surface?.isReady()) {
      setError("The editor is still loading — try again in a moment.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await surface.getResult();
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the email.");
    } finally {
      setSaving(false);
    }
  }, [onSave]);

  const handlePreview = useCallback(async () => {
    const surface = surfaceRef.current;
    if (!surface?.isReady()) {
      setError("The editor is still loading — try again in a moment.");
      return;
    }
    setError(null);
    try {
      const result = await surface.getResult();
      setPreviewHtml(result.html);
      setMode("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't render the preview.");
    }
  }, []);

  const previewWidth = device === "mobile" ? 390 : 640;

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMode("edit")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              mode === "edit" ? "bg-background shadow-sm" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={handlePreview}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              mode === "preview" ? "bg-background shadow-sm" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            Preview
          </button>
        </div>

        {mode === "preview" && (
          <div className="flex items-center gap-1 border-l pl-2">
            <button
              type="button"
              onClick={() => setDevice("mobile")}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium ${
                device === "mobile" ? "bg-background shadow-sm" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              Mobile
            </button>
            <button
              type="button"
              onClick={() => setDevice("desktop")}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium ${
                device === "desktop" ? "bg-background shadow-sm" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              Desktop
            </button>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span
            className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"
            title={`This editor is themed for ${brand.name}`}
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: brand.accent }}
            />
            {brand.name}
          </span>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* Merge-tag helper (only while editing) */}
      {mode === "edit" && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Personalise:</span>
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
          <span className="text-muted-foreground">
            Tags are filled in per recipient when the email sends.
          </span>
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

      {/* Image note */}
      {mode === "edit" && (
        <p className="text-[11px] text-muted-foreground">
          Images are embedded inline for now (a hosted image CDN is a fast-follow). Keep uploads
          small — large images push the email toward Gmail's clip limit.
        </p>
      )}

      {/* Editor (kept mounted) + preview overlay */}
      <div className={mode === "preview" ? "hidden" : "block"}>
        <SurfaceErrorBoundary onRetry={() => setSurfaceKey((k) => k + 1)}>
          <Suspense fallback={<LoadingSurface />}>
            <LazySurface
              key={surfaceKey}
              ref={surfaceRef}
              brandKey={brandKey}
              initialDoc={initialDoc}
              onDirty={onDirty}
            />
          </Suspense>
        </SurfaceErrorBoundary>
      </div>

      {mode === "preview" && (
        <div className="flex justify-center overflow-auto rounded-lg border bg-neutral-100 p-4 dark:bg-neutral-900">
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={previewHtml || "<p style='font-family:sans-serif;padding:24px;color:#888'>Nothing to preview yet.</p>"}
            style={{
              width: previewWidth,
              maxWidth: "100%",
              height: 720,
              border: "0",
              background: "#fff",
              borderRadius: 8,
              boxShadow: "0 4px 24px rgba(0,0,0,0.12)",
            }}
          />
        </div>
      )}
    </div>
  );
}
