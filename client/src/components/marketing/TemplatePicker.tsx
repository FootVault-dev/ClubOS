// ─────────────────────────────────────────────────────────────────────────────
// TemplatePicker — list saved email templates for the current workspace, save
// the current design as a new template, and apply a template back into the
// builder. Self-contained (its own fetch + state) so Phase C can drop it beside
// the composer without extra wiring; requests are auto-scoped to the active
// workspace by apiRequest's X-Workspace-Slug header.
//
// Templates persist the full builder result ({ doc, html, text }) in
// mkt_templates.block_tree — the Tiptap doc is the source of truth, the html is
// the render snapshot. See server/marketing/routes.ts (Templates — Phase D).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import type { EmailBuilderResult } from "./EmailBuilder";

interface MktTemplate {
  id: number;
  name: string;
  channel: string;
  kind: string;
  subject: string | null;
  blockTree: (EmailBuilderResult & Record<string, unknown>) | null;
  updatedAt: string;
}

interface TemplatePickerProps {
  /** Compiled current design — enables "Save current as template". */
  currentResult?: EmailBuilderResult | null;
  /** Apply a chosen template's design back into the builder. */
  onApply: (result: EmailBuilderResult) => void;
  channel?: "email" | "sms";
  className?: string;
}

export default function TemplatePicker({
  currentResult,
  onApply,
  channel = "email",
  className,
}: TemplatePickerProps) {
  const [templates, setTemplates] = useState<MktTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest(
        "GET",
        `/api/admin/marketing/templates?channel=${channel}&kind=template`,
      );
      setTemplates(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load templates.");
    } finally {
      setLoading(false);
    }
  }, [channel]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveCurrent = useCallback(async () => {
    if (!currentResult) return;
    const name = window.prompt("Name this template");
    if (!name?.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest("POST", "/api/admin/marketing/templates", {
        name: name.trim(),
        channel,
        kind: "template",
        blockTree: currentResult,
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the template.");
    } finally {
      setBusy(false);
    }
  }, [currentResult, channel, load]);

  const apply = useCallback(
    (t: MktTemplate) => {
      if (!t.blockTree) return;
      onApply({
        doc: t.blockTree.doc ?? null,
        html: t.blockTree.html ?? "",
        text: t.blockTree.text ?? "",
      });
    },
    [onApply],
  );

  const remove = useCallback(
    async (t: MktTemplate) => {
      if (!window.confirm(`Delete template "${t.name}"?`)) return;
      setBusy(true);
      try {
        await apiRequest("DELETE", `/api/admin/marketing/templates/${t.id}`);
        setTemplates((prev) => prev.filter((x) => x.id !== t.id));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't delete the template.");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return (
    <div className={`flex flex-col gap-2 ${className ?? ""}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Templates</h3>
        <button
          type="button"
          onClick={saveCurrent}
          disabled={!currentResult || busy}
          className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
          title={currentResult ? "Save the current design as a reusable template" : "Save the email first"}
        >
          Save current as template
        </button>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : templates.length === 0 ? (
        <p className="text-xs text-muted-foreground">No templates yet.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {templates.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="truncate text-sm">{t.name}</span>
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => apply(t)}
                  disabled={busy}
                  className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                >
                  Apply
                </button>
                <button
                  type="button"
                  onClick={() => remove(t)}
                  disabled={busy}
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-red-600 disabled:opacity-50"
                  title="Delete template"
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
