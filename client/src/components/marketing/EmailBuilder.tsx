// CONTRACT STUB — Phase D replaces this file with the real @react-email/editor integration.
// The props/exports below are the agreed interface between the Marketing tab pages (Phase C)
// and the email builder (Phase D). Phase C lazy-imports this path and must not depend on
// anything beyond this contract.
import React from "react";

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

export default function EmailBuilder(_props: EmailBuilderProps) {
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed p-12 text-sm text-muted-foreground">
      Email builder loading…
    </div>
  );
}
