// ─────────────────────────────────────────────────────────────────────────────
// grapes/editor.ts — the GrapesJS + grapesjs-mjml engine for the ClubOS email
// builder, wrapped in a first-party 3-pane shell (LEFT block palette · CENTER
// canvas · RIGHT style/settings/layers inspector) and a custom top toolbar
// (device toggle · undo/redo · outline · preview · code). The stock GrapesJS
// chrome is HIDDEN (premium.css) and replaced by this shell so it reads as a
// native ClubOS tool, not an embedded widget.
//
// Public API:
//   createEmailEditor({ container, brandKey, initialDoc }) → Editor
//   exportResult(editor)   → { doc:{engine,version,mjml,project}, html, text }
//   loadDoc(editor, doc, brandKey)
//   insertMergeTag(editor, tag)
//
// Persistence: storageManager is OFF — the surface persists the doc itself.
// The doc is BOTH the MJML source (portable, diffable) AND the GrapesJS project
// JSON (richest for re-opening), per the visual-builder spike.
// ─────────────────────────────────────────────────────────────────────────────

import grapesjs, { type Editor } from "grapesjs";
import grapesjsMjml from "grapesjs-mjml";
import "grapesjs/dist/css/grapes.min.css";
import "./premium.css";
import { registerBlocks } from "./blocks";
import { applyBrandTheme, brandCanvasTheme, brandColorPalette, buildStarterMjml } from "./brand";

// ── doc + result shapes ───────────────────────────────────────────────────────

export interface EmailDoc {
  engine: "grapesjs-mjml";
  version: 1;
  /** full <mjml>…</mjml> source — the human-readable, re-compilable source of truth */
  mjml: string;
  /** GrapesJS-native project JSON — richest state for reopening/editing */
  project: unknown;
}

export interface EmailBuilderResult {
  doc: EmailDoc;
  html: string;
  text: string;
}

export interface CreateEmailEditorOpts {
  container: HTMLElement;
  brandKey: string;
  initialDoc?: unknown | null;
}

const SCOPE_CLASS = "clubos-gjs";

// ── shell ─────────────────────────────────────────────────────────────────────

interface Shell {
  root: HTMLElement;
  toolbarLeft: HTMLElement;
  toolbarRight: HTMLElement;
  blocks: HTMLElement;
  canvas: HTMLElement;
  rightTabs: HTMLElement;
  paneStyle: HTMLElement;
  paneSettings: HTMLElement;
  paneLayers: HTMLElement;
  emptyHint: HTMLElement;
}

function buildShell(container: HTMLElement, brand: ReturnType<typeof brandCanvasTheme>): Shell {
  container.classList.add(SCOPE_CLASS);
  container.style.setProperty("--ce-accent", brand.accent);
  container.innerHTML = `
    <div class="ce-shell">
      <div class="ce-topbar">
        <div class="ce-topbar-left" data-ce="toolbar-left"></div>
        <div class="ce-topbar-right" data-ce="toolbar-right"></div>
      </div>
      <div class="ce-main">
        <aside class="ce-left">
          <div class="ce-panel-head">Blocks</div>
          <div class="ce-blocks" data-ce="blocks"></div>
        </aside>
        <div class="ce-canvas" data-ce="canvas"></div>
        <aside class="ce-right">
          <div class="ce-right-tabs" data-ce="right-tabs"></div>
          <div class="ce-right-body">
            <div class="ce-empty" data-ce="empty">
              <div class="ce-empty-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </div>
              <p class="ce-empty-title">Nothing selected</p>
              <p class="ce-empty-sub">Click any block on the canvas to style it, or drag a new one from the left.</p>
            </div>
            <div class="ce-pane" data-ce="pane-style"></div>
            <div class="ce-pane" data-ce="pane-settings"></div>
            <div class="ce-pane" data-ce="pane-layers"></div>
          </div>
        </aside>
      </div>
    </div>
  `;
  const q = (sel: string) => container.querySelector<HTMLElement>(`[data-ce="${sel}"]`)!;
  return {
    root: container,
    toolbarLeft: q("toolbar-left"),
    toolbarRight: q("toolbar-right"),
    blocks: q("blocks"),
    canvas: q("canvas"),
    rightTabs: q("right-tabs"),
    paneStyle: q("pane-style"),
    paneSettings: q("pane-settings"),
    paneLayers: q("pane-layers"),
    emptyHint: q("empty"),
  };
}

// ── toolbar + inspector wiring ────────────────────────────────────────────────

function icon(inner: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
const ICONS = {
  desktop: icon(`<rect x="2.5" y="4.5" width="19" height="12" rx="2"/><path d="M8 20.5h8M12 16.5v4"/>`),
  mobile: icon(`<rect x="7" y="3" width="10" height="18" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/>`),
  undo: icon(`<path d="M9 7L4 12l5 5"/><path d="M4 12h11a5 5 0 0 1 0 10h-1"/>`),
  redo: icon(`<path d="M15 7l5 5-5 5"/><path d="M20 12H9a5 5 0 0 0 0 10h1"/>`),
  outline: icon(`<rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke-dasharray="3 2.5"/>`),
  preview: icon(`<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="2.6"/>`),
  code: icon(`<path d="M9 8l-4 4 4 4"/><path d="M15 8l4 4-4 4"/>`),
};

function makeBtn(html: string, title: string, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `ce-tb-btn ${cls}`.trim();
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = html;
  return b;
}

function wireToolbar(editor: Editor, shell: Shell): void {
  // Device toggle (segmented)
  const seg = document.createElement("div");
  seg.className = "ce-seg";
  const bDesktop = makeBtn(ICONS.desktop, "Desktop preview", "is-active");
  const bMobile = makeBtn(ICONS.mobile, "Mobile preview");
  seg.append(bDesktop, bMobile);
  const setDevice = (name: "Desktop" | "Mobile", active: HTMLElement, other: HTMLElement) => {
    editor.setDevice(name);
    active.classList.add("is-active");
    other.classList.remove("is-active");
  };
  bDesktop.onclick = () => setDevice("Desktop", bDesktop, bMobile);
  bMobile.onclick = () => setDevice("Mobile", bMobile, bDesktop);
  shell.toolbarLeft.append(seg);

  // Undo / redo
  const grp1 = document.createElement("div");
  grp1.className = "ce-tb-grp";
  const bUndo = makeBtn(ICONS.undo, "Undo");
  const bRedo = makeBtn(ICONS.redo, "Redo");
  bUndo.onclick = () => editor.runCommand("core:undo");
  bRedo.onclick = () => editor.runCommand("core:redo");
  grp1.append(bUndo, bRedo);

  // Outline · Preview · Code
  const grp2 = document.createElement("div");
  grp2.className = "ce-tb-grp";
  const bOutline = makeBtn(ICONS.outline, "Toggle block outlines", "is-active");
  let outlineOn = true;
  bOutline.onclick = () => {
    outlineOn = !outlineOn;
    editor.runCommand(outlineOn ? "sw-visibility" : "sw-visibility"); // toggle: run then stop
    if (outlineOn) editor.runCommand("sw-visibility");
    else editor.stopCommand("sw-visibility");
    bOutline.classList.toggle("is-active", outlineOn);
  };

  const bPreview = makeBtn(ICONS.preview, "Preview (hide the editor chrome)");
  let previewing = false;
  bPreview.onclick = () => {
    previewing = !previewing;
    if (previewing) {
      editor.runCommand("preview");
      shell.root.classList.add("ce-previewing");
    } else {
      editor.stopCommand("preview");
      shell.root.classList.remove("ce-previewing");
    }
    bPreview.classList.toggle("is-active", previewing);
  };

  const bCode = makeBtn(ICONS.code, "View / export code");
  bCode.onclick = () => editor.runCommand("export-template");

  grp2.append(bOutline, bPreview, bCode);
  shell.toolbarRight.append(grp1, grp2);
}

type RightTab = "style" | "settings" | "layers";

function wireInspector(editor: Editor, shell: Shell): void {
  let activeTab: RightTab = "style";
  const tabs: { id: RightTab; label: string }[] = [
    { id: "style", label: "Style" },
    { id: "settings", label: "Settings" },
    { id: "layers", label: "Layers" },
  ];
  const tabBtns: Record<string, HTMLButtonElement> = {};
  tabs.forEach((t) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ce-tab";
    btn.textContent = t.label;
    btn.onclick = () => {
      activeTab = t.id;
      update();
    };
    tabBtns[t.id] = btn;
    shell.rightTabs.append(btn);
  });

  const hasSelection = () => !!editor.getSelected();

  const update = () => {
    Object.entries(tabBtns).forEach(([id, btn]) => btn.classList.toggle("is-active", id === activeTab));
    const sel = hasSelection();
    const showLayers = activeTab === "layers";
    const showStyle = activeTab === "style" && sel;
    const showSettings = activeTab === "settings" && sel;
    const showEmpty = !showLayers && !sel;
    shell.paneLayers.classList.toggle("ce-hidden", !showLayers);
    shell.paneStyle.classList.toggle("ce-hidden", !showStyle);
    shell.paneSettings.classList.toggle("ce-hidden", !showSettings);
    shell.emptyHint.classList.toggle("ce-hidden", !showEmpty);
  };

  editor.on("component:selected", update);
  editor.on("component:deselected", update);
  editor.on("load", update);
  update();
}

// ── public: create ─────────────────────────────────────────────────────────────

export function createEmailEditor({ container, brandKey, initialDoc }: CreateEmailEditorOpts): Editor {
  const brand = brandCanvasTheme(brandKey);
  const shell = buildShell(container, brand);

  const editor = grapesjs.init({
    container: shell.canvas,
    height: "100%",
    fromElement: false,
    storageManager: false,
    // Managers render into OUR shell, not the (hidden) default panels.
    blockManager: { appendTo: shell.blocks },
    styleManager: { appendTo: shell.paneStyle },
    traitManager: { appendTo: shell.paneSettings },
    layerManager: { appendTo: shell.paneLayers },
    colorPicker: {
      showPalette: true,
      palette: brandColorPalette(brandKey),
      hideAfterPaletteSelect: true,
    },
    deviceManager: {
      devices: [
        { id: "desktop", name: "Desktop", width: "600px", widthMedia: "" },
        { id: "mobile", name: "Mobile", width: "375px", widthMedia: "480px" },
      ],
    },
    plugins: [
      (ed: Editor) =>
        grapesjsMjml(ed, {
          resetBlocks: true, // clear defaults — we register our own categorized palette
          resetStyleManager: true, // MJML-appropriate style sectors
          resetDevices: false, // keep OUR desktop(600)/mobile(375) devices
          hideSelector: true, // email styling is per-component, not per-class
          useCustomTheme: false, // premium.css owns the chrome theme
          blocks: [], // no stock blocks
        }),
    ],
  });

  registerBlocks(editor, brandKey, { brand });
  applyBrandTheme(editor, brandKey);
  loadDoc(editor, initialDoc, brandKey);

  wireToolbar(editor, shell);
  wireInspector(editor, shell);

  editor.on("load", () => {
    // Outlines on by default so blocks are easy to see/select while editing.
    try {
      editor.runCommand("sw-visibility");
    } catch {
      /* non-fatal */
    }
    // The selection outline / offsets render INSIDE the canvas iframe, whose
    // document doesn't inherit our parent-scope CSS vars. `.gjs-selected` /
    // `.gjs-hovered` even hardcode GrapesJS blue — so inject a real rule (plus the
    // accent var for the handles/highlighter) so every in-canvas cue is on-brand.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const canvas: any = (editor as any).Canvas;
      const fdoc: Document | undefined =
        canvas?.getFrameEl?.()?.contentDocument ?? canvas?.getDocument?.();
      const rootEl = fdoc?.documentElement as HTMLElement | undefined;
      if (rootEl && fdoc) {
        rootEl.style.setProperty("--gjs-color-blue", brand.accent);
        rootEl.style.setProperty("--gjs-color-highlight", brand.accent);
        // Double the class to out-specify GrapesJS's own blue `.gjs-selected`
        // rule (equal specificity + !important would otherwise lose on order).
        const style = fdoc.createElement("style");
        style.textContent =
          `.gjs-selected.gjs-selected{outline:2px solid ${brand.accent} !important;outline-offset:-2px;}` +
          `.gjs-hovered.gjs-hovered{outline:1px solid ${brand.accent}80 !important;outline-offset:-1px;}`;
        fdoc.head?.appendChild(style);
      }
    } catch {
      /* non-fatal */
    }
  });

  return editor;
}

// ── public: load ────────────────────────────────────────────────────────────────

function detectEngine(doc: unknown): "grapesjs" | "tiptap" | "empty" {
  if (!doc) return "empty";
  if (typeof doc === "string") return doc.trimStart().startsWith("<mjml") ? "grapesjs" : "empty";
  const d = doc as Record<string, unknown>;
  if (d.engine === "grapesjs-mjml") return "grapesjs";
  if (d.type === "doc" && Array.isArray(d.content)) return "tiptap";
  return "empty";
}

export function loadDoc(editor: Editor, initialDoc: unknown, brandKey: string): void {
  const engine = detectEngine(initialDoc);

  if (engine === "grapesjs") {
    const d = initialDoc as { project?: unknown; mjml?: string } | string;
    // Prefer the richest state (project JSON), fall back to MJML source.
    if (typeof d === "object" && d.project) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor.loadProjectData(d.project as any);
        return;
      } catch (e) {
        console.info("[EmailBuilder] project data failed to load, falling back to MJML", e);
      }
    }
    const mjml = typeof d === "string" ? d : d.mjml;
    if (mjml && mjml.trim()) {
      editor.setComponents(mjml);
      return;
    }
  }

  if (engine === "tiptap") {
    // There are ZERO live GrapesJS templates to migrate; legacy Tiptap docs still
    // SEND from their stored HTML. Opening one for re-edit starts clean, on-brand.
    console.info(
      "[EmailBuilder] legacy Tiptap doc detected — starting from a clean brand template (HTML→MJML import is lossy, so no auto-convert).",
    );
  }

  editor.setComponents(buildStarterMjml(brandKey));
}

// ── public: export ────────────────────────────────────────────────────────────

export function exportResult(editor: Editor): EmailBuilderResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawMjml = editor.runCommand("mjml-code") as any;
  const mjml: string = typeof rawMjml === "string" ? rawMjml : rawMjml?.code ?? rawMjml?.mjml ?? "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawHtml = editor.runCommand("mjml-code-to-html") as any;
  const html: string = typeof rawHtml === "string" ? rawHtml : rawHtml?.html ?? "";

  const project = editor.getProjectData();
  const text = htmlToText(html);

  return {
    doc: { engine: "grapesjs-mjml", version: 1, mjml, project },
    html,
    text,
  };
}

// ── public: merge tags ──────────────────────────────────────────────────────────

/**
 * Insert a merge tag ({{first_name}} etc.). If a text/button is selected, append
 * it into that component's content; otherwise drop a small text block into the
 * body so the tag is never lost.
 */
export function insertMergeTag(editor: Editor, tag: string): void {
  const sel = editor.getSelected();
  const type = sel?.get("type");
  if (sel && (type === "mj-text" || type === "text" || type === "mj-button")) {
    // append as a trailing textnode inside the selected component
    sel.append(` ${tag}`);
    return;
  }
  // No suitable selection — append a compact text section to the body.
  const wrapper = editor.getWrapper();
  const body = wrapper?.find("mj-body")[0] ?? wrapper;
  body?.append(
    `<mj-section><mj-column><mj-text font-size="15px" line-height="1.7">${tag}</mj-text></mj-column></mj-section>`,
  );
}

// ── plaintext derivation (MJML emits none) ──────────────────────────────────────

function htmlToText(html: string): string {
  let s = html;
  const body = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (body) s = body[1];
  // Links → "label (url)" so URLs survive in the text part.
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
    const t = label.replace(/<[^>]+>/g, "").trim();
    return t && href && t !== href ? `${t} (${href})` : href || t;
  });
  // Block boundaries → newlines
  s = s.replace(/<\/(p|div|tr|table|h[1-6]|li)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, " ");
  // Decode the handful of entities MJML emits
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
  // Collapse whitespace per line, drop empties
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}
