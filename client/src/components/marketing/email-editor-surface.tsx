// ─────────────────────────────────────────────────────────────────────────────
// The heavy editor surface — the ONLY module in the marketing folder that pulls
// in @react-email/editor (~836KB gzipped, per the editor spike). EmailBuilder.tsx
// React.lazy()-loads this file so that weight lands in its own chunk and only
// downloads when the composer actually mounts.
//
// It renders the batteries-included <EmailEditor> (StarterKit blocks, slash
// commands, bubble menus, per-brand theming) and exposes an imperative handle so
// the lightweight wrapper can pull a save result or insert a merge tag.
//
// Save uses composeReactEmail() from @react-email/editor/core directly (not the
// ref's getEmail()) so we can persist the UNFORMATTED html — the package's own
// docs flag that Prettier formatting inflates byte size 5–10× on nested table
// layouts and matters for the Gmail 102KB clip limit (see 06-editor-spike.md).
// ─────────────────────────────────────────────────────────────────────────────

import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { EmailEditor, type EmailEditorProps, type EmailEditorRef } from "@react-email/editor";
import { composeReactEmail } from "@react-email/editor/core";
import "@react-email/editor/themes/default.css";
import { getBrandChrome, getBrandTheme } from "./brand-themes";
import type { EmailBuilderResult } from "./EmailBuilder";

export interface EmailEditorSurfaceHandle {
  /** Compile the current document to { doc, html (unformatted), text }. */
  getResult: () => Promise<EmailBuilderResult>;
  /** Insert plain text (e.g. a {{merge_tag}}) at the cursor. */
  insertText: (text: string) => void;
  /** True once the underlying editor instance is live. */
  isReady: () => boolean;
}

interface SurfaceProps {
  brandKey: string;
  initialDoc?: unknown | null;
  onDirty?: () => void;
}

/**
 * Client-side image handling (v1). ClubOS's only object-storage path is the
 * Replit-based uploader, which is mid-migration AND emits webp/avif only (not
 * email-safe), so instead of a hosted URL we downscale to a ≤600px-wide JPEG and
 * inline it as a data URI. The builder's size guard keeps these from blowing the
 * Gmail clip limit; a hosted /api/admin/marketing/upload-image route emitting
 * email-safe JPEGs is the documented fast-follow.
 */
async function downscaleToDataUri(file: File): Promise<{ url: string }> {
  const MAX_W = 600;
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not read that image"));
      el.src = objectUrl;
    });

    let w = Math.min(img.naturalWidth || MAX_W, MAX_W);
    let h = Math.round((img.naturalHeight / (img.naturalWidth || 1)) * w) || w;

    const render = (targetW: number, targetH: number, quality: number): string => {
      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");
      // Flatten onto white so transparent PNGs don't turn black under JPEG.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, targetW, targetH);
      ctx.drawImage(img, 0, 0, targetW, targetH);
      return canvas.toDataURL("image/jpeg", quality);
    };

    // ~150KB budget: base64 chars ≈ bytes × 4/3, so 150KB ≈ 205k chars.
    const CHAR_BUDGET = 205_000;
    let quality = 0.82;
    let out = render(w, h, quality);
    while (out.length > CHAR_BUDGET && quality > 0.4) {
      quality -= 0.12;
      out = render(w, h, quality);
    }
    // Still too big? shrink the pixels and try once more at a modest quality.
    if (out.length > CHAR_BUDGET) {
      w = Math.round(w * 0.75);
      h = Math.round(h * 0.75);
      out = render(w, h, 0.7);
    }
    return { url: out };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

const EmailEditorSurface = forwardRef<EmailEditorSurfaceHandle, SurfaceProps>(
  function EmailEditorSurface({ brandKey, initialDoc, onDirty }, ref) {
    const editorRef = useRef<EmailEditorRef | null>(null);

    const handleReady = useCallback((r: EmailEditorRef) => {
      editorRef.current = r;
    }, []);

    const handleUpdate = useCallback(
      (r: EmailEditorRef) => {
        editorRef.current = r;
        onDirty?.();
      },
      [onDirty],
    );

    useImperativeHandle(
      ref,
      (): EmailEditorSurfaceHandle => ({
        isReady: () => !!editorRef.current?.editor,
        insertText: (text: string) => {
          const editor = editorRef.current?.editor;
          if (!editor) return;
          editor.chain().focus().insertContent(text).run();
        },
        getResult: async (): Promise<EmailBuilderResult> => {
          const editor = editorRef.current?.editor;
          if (!editor) throw new Error("The editor is still loading — try again in a moment.");
          const { text, unformattedHtml } = await composeReactEmail({ editor });
          return { doc: editor.getJSON(), html: unformattedHtml, text };
        },
      }),
      [],
    );

    return (
      <div
        className="mkt-email-editor"
        style={getBrandChrome(brandKey)}
        // colorScheme keeps native form controls (colour pickers etc.) legible.
        data-brand={brandKey}
      >
        <EmailEditor
          ref={editorRef}
          theme={getBrandTheme(brandKey)}
          content={(initialDoc ?? undefined) as EmailEditorProps["content"]}
          onReady={handleReady}
          onUpdate={handleUpdate}
          onUploadImage={downscaleToDataUri}
          placeholder="Press '/' for blocks — heading, button, image, columns…"
        />
      </div>
    );
  },
);

export default EmailEditorSurface;
