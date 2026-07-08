# Marketing email builder (Phase D)

Premium block email builder on `@react-email/editor` v1.6.4 (pinned). Files here:

- **`EmailBuilder.tsx`** — the CONTRACT (`EmailBuilderProps` / `EmailBuilderResult` /
  default export). Phase C `React.lazy()`-imports this. Lightweight wrapper: toolbar,
  merge-tag helper, size guard, mobile/desktop preview, error boundary.
- **`email-editor-surface.tsx`** — the ONLY module that pulls the ~836KB editor
  bundle; `React.lazy()`-loaded by `EmailBuilder` so it streams in on its own chunk.
- **`brand-themes.ts`** — `getBrandTheme(brandKey)` (email content theme) +
  `getBrandChrome()` (editor UI `--re-*` vars). Palettes lifted from `server/email.ts`
  shells + `server/marketing/brand.ts`. Keys: `cufc siu mfl usc cic cugc usg prints`
  (+ `cic7s`), neutral default.
- **`TemplatePicker.tsx`** — list / save-as / apply / delete templates for the workspace.

**Save flow:** `getResult()` → `composeReactEmail({ editor })` → `{ doc: tiptap JSON,
html: UNFORMATTED html, text }`. Store the doc as source of truth; html for sending.
**Size guard:** warns ≥80KB, blocks ≥100KB (Gmail clips ~102KB).
**Merge tags:** `{{first_name}} {{last_name}} {{email}}` inserted as literal text; the
send engine substitutes per recipient — no client-side rendering.
**Theming:** per-brand look applied via the editor `theme` prop before any edit.
**Image upload path (v1 = data URI):** ClubOS's only object store is Replit-based
(mid-migration) and emits webp/avif (not email-safe), so `onUploadImage` downscales to a
≤600px JPEG inlined as a data URI. Fast-follow = a hosted `/api/admin/marketing/upload-image`
route emitting email-safe JPEGs.

**Templates + synced blocks (server):** `server/marketing/routes.ts` → "Templates (Phase D)".
`mkt_templates.block_tree` holds `{ doc, html, text }` (no schema change). Synced blocks are
`kind='synced_block'` with reserved per-workspace names `__synced_header__` / `__synced_footer__`.
