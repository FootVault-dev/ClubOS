# Marketing email builder (Phase D)

Premium drag-and-drop, section/row/column visual email builder on **GrapesJS +
grapesjs-mjml** (pinned `grapesjs@0.23.2`, `grapesjs-mjml@1.0.8`) — a true
Beefree/Stripo-class canvas that compiles to Outlook-hardened MJML→HTML. Replaces
the previous Tiptap (`@react-email/editor`) prose editor.

## Files

- **`EmailBuilder.tsx`** — the CONTRACT (`EmailBuilderProps` / `EmailBuilderResult` /
  default export). Phase C `React.lazy()`-imports this. Lightweight wrapper: action bar,
  merge-tag pills, size guard, error boundary, and a plain-HTML **mobile fallback** (<768px).
  GrapesJS owns the canvas + device preview + code view, so the wrapper no longer renders a
  separate preview iframe.
- **`email-editor-surface.tsx`** — the ONLY module that pulls the ~725KB GrapesJS bundle;
  `React.lazy()`-loaded by `EmailBuilder` so it streams in on its own chunk. Mounts
  `createEmailEditor()` and exposes the imperative handle (`getResult` / `insertText` / `isReady`).
- **`grapes/editor.ts`** — `createEmailEditor({ container, brandKey, initialDoc })` → the
  GrapesJS `Editor`, mounted in a custom **3-pane shell** (LEFT palette · CENTER canvas ·
  RIGHT style/settings/layers inspector) + custom toolbar (device toggle · undo/redo ·
  outline · preview · code). Plus `exportResult(editor)`, `loadDoc(editor, doc, brandKey)`,
  `insertMergeTag(editor, tag)`.
- **`grapes/blocks.ts`** — `registerBlocks(editor, brandKey, ctx)` + the **extension API**
  `registerBlock(editor, def)` / `EmailBlockDef` (add club blocks — fixture/product/OTT cards
  — WITHOUT touching core). Includes an example "Highlight card".
- **`grapes/brand.ts`** — `brandCanvasTheme` · `buildStarterMjml` (on-brand starter email) ·
  `brandColorPalette` (colour-picker swatches) · `applyBrandTheme`. Reads `../brand-themes.ts`.
- **`grapes/premium.css`** — restyles stock GrapesJS into first-party ClubOS chrome (scoped
  under `.clubos-gjs`, driven by ClubOS design tokens + the per-brand `--ce-accent`).
- **`brand-themes.ts`** — `getBrandMeta(brandKey)` + `BRAND_THEMES` palette rows (source of
  truth for both the builder canvas and the sent-email shells). Keys: `cufc siu mfl usc cic
  cugc usg prints` (+ `cic7s`), neutral default.
- **`TemplatePicker.tsx`** — list / save-as / apply / delete templates for the workspace.

## Doc shape (persisted to `mkt_templates.block_tree` / campaign drafts)

```ts
doc = { engine: "grapesjs-mjml", version: 1, mjml: "<mjml>…</mjml>", project: <GrapesJS JSON> }
```

`mjml` is the portable, diffable source of truth; `project` is the richest state for
reopening. On open, `loadDoc` prefers `project`, falls back to `mjml`, and starts from a
clean brand template for anything else (legacy Tiptap docs still SEND from their stored HTML).
The mobile fallback saves `{ engine: "html", html }`.

**Save flow:** `getResult()` → `exportResult(editor)` → `{ doc, html (mjml-code-to-html),
text (stripped, links kept) }`. Store the doc as source of truth; html for sending.
**Size guard:** warns ≥80KB, blocks ≥100KB (Gmail clips ~102KB) on the compiled html.
**Merge tags:** `{{first_name}} {{last_name}} {{email}} {{unsubscribe_url}}` inserted as literal
text; the send engine substitutes per recipient.
**Theming:** per-brand look applied via the brand starter + explicit block colours before any edit.

**Templates + synced blocks (server):** `server/marketing/routes.ts` → "Templates (Phase D)".
`mkt_templates.block_tree` holds `{ doc, html, text }` (no schema change).
