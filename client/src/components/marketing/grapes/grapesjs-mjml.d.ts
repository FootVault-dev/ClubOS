// grapesjs-mjml ships a dist/index.d.ts but declares no `types` field in its
// package.json, so TS can't resolve it. This ambient shim types the default
// export as a GrapesJS plugin function. Keep it minimal — the plugin is invoked
// as `grapesjsMjml(editor, opts)` inside a `plugins: [...]` entry.
declare module "grapesjs-mjml" {
  import type { Editor } from "grapesjs";
  const plugin: (editor: Editor, opts?: Record<string, unknown>) => void;
  export default plugin;
}
