// ─────────────────────────────────────────────────────────────────────────────
// The heavy editor surface — the ONLY module in the marketing folder that pulls
// in GrapesJS + grapesjs-mjml + mjml-browser (~725KB gzip). EmailBuilder.tsx
// React.lazy()-loads this file so that weight lands in its own chunk and only
// downloads when the composer actually mounts.
//
// It mounts the GrapesJS drag-and-drop email builder (block palette · canvas ·
// style/settings/layers inspector · device preview · code view) via
// createEmailEditor(), and exposes the SAME imperative handle the wrapper has
// always used (getResult / insertText / isReady) — now backed by the grapes
// helpers. The GrapesJS lifecycle is imperative (Backbone views + a canvas
// iframe): init ONCE in a useEffect, keep the instance in a ref, and
// editor.destroy() on cleanup — an init guard makes it StrictMode-safe.
// ─────────────────────────────────────────────────────────────────────────────

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { Editor } from "grapesjs";
import { createEmailEditor, exportResult, insertMergeTag } from "./grapes/editor";
import type { EmailBuilderResult } from "./EmailBuilder";

export interface EmailEditorSurfaceHandle {
  /** Compile the current document to { doc, html, text }. */
  getResult: () => Promise<EmailBuilderResult>;
  /** Insert a {{merge_tag}} into the selected text (or a new text block). */
  insertText: (text: string) => void;
  /** True once the underlying editor instance is live. */
  isReady: () => boolean;
}

interface SurfaceProps {
  brandKey: string;
  initialDoc?: unknown | null;
  onDirty?: () => void;
}

const EmailEditorSurface = forwardRef<EmailEditorSurfaceHandle, SurfaceProps>(
  function EmailEditorSurface({ brandKey, initialDoc, onDirty }, ref) {
    const holderRef = useRef<HTMLDivElement | null>(null);
    const editorRef = useRef<Editor | null>(null);
    const initedRef = useRef(false);
    // keep the latest onDirty without re-running the init effect
    const onDirtyRef = useRef(onDirty);
    onDirtyRef.current = onDirty;

    useEffect(() => {
      if (initedRef.current || !holderRef.current) return;
      initedRef.current = true;

      const editor = createEmailEditor({
        container: holderRef.current,
        brandKey,
        initialDoc,
      });
      editorRef.current = editor;
      editor.on("update", () => onDirtyRef.current?.());

      return () => {
        try {
          editor.destroy();
        } catch {
          /* ignore teardown races */
        }
        editorRef.current = null;
        initedRef.current = false;
      };
      // Init once per mount. brandKey/initialDoc changes are handled by the
      // wrapper remounting the surface (it passes a `key`), matching the
      // previous surface's behaviour.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(
      ref,
      (): EmailEditorSurfaceHandle => ({
        isReady: () => !!editorRef.current,
        insertText: (text: string) => {
          const editor = editorRef.current;
          if (editor) insertMergeTag(editor, text);
        },
        getResult: async (): Promise<EmailBuilderResult> => {
          const editor = editorRef.current;
          if (!editor) throw new Error("The editor is still loading — try again in a moment.");
          return exportResult(editor);
        },
      }),
      [],
    );

    return <div ref={holderRef} className="mkt-grapes-holder" data-brand={brandKey} />;
  },
);

export default EmailEditorSurface;
