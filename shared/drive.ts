// ─────────────────────────────────────────────────────────────────────────────
// Club Drive — the shared vocabulary, and the ONE decider for who may read a
// file.
//
// 🔴 Drive is not a new permission system. It reuses the Knowledge Base's
// decider (`viewerCanReachTab`), which in turn defers to `canAccessTab` — so a
// document can never be more open than the ClubOS tab its contents came from,
// and a person learns through Drive exactly what they could have learned by
// clicking around ClubOS themselves. Three surfaces (Drive, the KB, Rambo), one
// rule, no drift.
// ─────────────────────────────────────────────────────────────────────────────
import { viewerCanReachTab, type Viewer } from "./knowledge-base";

export type DriveKind = "folder" | "file";

/** Where the bytes live. Opaque above the storage adapter. */
export const DRIVE_BACKENDS = ["supabase", "r2", "google"] as const;
export type DriveBackend = (typeof DRIVE_BACKENDS)[number];

// ── Gates ────────────────────────────────────────────────────────────────────
// A gate is encoded `tab@workspace`, workspace optional ("budget@" = judge the
// budget tab in any workspace they belong to). The database view
// `drive_node_gates` produces the accumulated list for every node; this parses
// it. Keeping the encode/decode next to each other is the point — the format
// exists in exactly two places and they are both here.

export interface DriveGate {
  tab: string;
  workspace?: string;
}

export function encodeDriveGate(tab: string, workspace?: string | null): string {
  return `${tab}@${workspace ?? ""}`;
}

export function parseDriveGate(raw: string): DriveGate | null {
  const at = raw.indexOf("@");
  if (at <= 0) return null;
  const tab = raw.slice(0, at);
  const workspace = raw.slice(at + 1);
  return { tab, workspace: workspace === "" ? undefined : workspace };
}

/**
 * May this person read a node?
 *
 * 🔴 EVERY gate must pass, not the nearest one. Gates accumulate down the tree
 * (see the `drive_node_gates` view), so a file sitting in "Club Budgets" is
 * judged on the budget tab even if the file itself carries no gate, and a laxer
 * gate on the child cannot re-open a door the parent closed.
 *
 * An empty list means open to every staff member — the normal case, and the
 * point of having a shared drive at all.
 */
export function viewerCanReadDriveNode(viewer: Viewer, gates: string[] | null | undefined): boolean {
  if (!gates || gates.length === 0) return true;
  return gates.every((raw) => {
    const gate = parseDriveGate(raw);
    // 🔴 Fail CLOSED. An unparseable gate is a gate we do not understand, and
    // the safe reading of "I don't know what this says" is "you may not."
    if (!gate) return false;
    return viewerCanReachTab(viewer, gate.tab, gate.workspace).allowed;
  });
}

/** The human explanation of why something is locked. Never names the contents. */
export function driveGateLabel(gates: string[] | null | undefined): string | null {
  if (!gates || gates.length === 0) return null;
  const tabs = gates.map((g) => parseDriveGate(g)?.tab).filter(Boolean) as string[];
  if (!tabs.length) return "Restricted";
  return `Restricted to staff who can open: ${Array.from(new Set(tabs)).join(", ")}`;
}

// ── File types ───────────────────────────────────────────────────────────────
// Used for the icon, the preview decision, and whether we try to read text out.

export type DriveCategory =
  | "folder" | "document" | "spreadsheet" | "presentation" | "pdf"
  | "image" | "video" | "audio" | "archive" | "other";

export function driveCategory(mime: string | null | undefined, name = ""): DriveCategory {
  const m = (mime ?? "").toLowerCase();
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.includes("spreadsheet") || ["xlsx", "xls", "csv", "numbers"].includes(ext)) return "spreadsheet";
  if (m.includes("presentation") || ["pptx", "ppt", "key"].includes(ext)) return "presentation";
  if (m.includes("word") || m === "text/plain" || m === "text/markdown" || ["docx", "doc", "txt", "md", "rtf", "pages"].includes(ext)) return "document";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "archive";
  return "other";
}

/** Types we can pull text out of. Anything else records `unsupported`, never a lie. */
export function driveIsExtractable(mime: string | null | undefined, name = ""): boolean {
  const cat = driveCategory(mime, name);
  return cat === "pdf" || cat === "spreadsheet" || cat === "document";
}

export function driveFormatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// ── Google Workspace export ──────────────────────────────────────────────────
// A Google Doc has no bytes to download — it must be exported to a real format.
// Mapping lives here so the importer and any future sync agree.
export const GOOGLE_EXPORT: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document":     { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
  "application/vnd.google-apps.spreadsheet":  { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",   ext: "xlsx" },
  "application/vnd.google-apps.presentation": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" },
  "application/vnd.google-apps.drawing":      { mime: "image/png", ext: "png" },
};

export const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";

/** Google types with no export path at all (Forms, Sites…). Recorded as links, never as empty files. */
export function googleIsUnexportable(mime: string): boolean {
  return mime.startsWith("application/vnd.google-apps.") && mime !== GOOGLE_FOLDER_MIME && !GOOGLE_EXPORT[mime];
}


// ── The live Google file ─────────────────────────────────────────────────────
// Every imported node keeps Google's `webViewLink`, and for a Doc, Sheet or
// Slides that link opens the LIVE, EDITABLE document. The kind is derivable
// from the URL itself, so this needs no extra column and no backfill:
//
//   docs.google.com/document/…      → Google Doc      (editable)
//   docs.google.com/spreadsheets/…  → Google Sheet    (editable)
//   docs.google.com/presentation/…  → Google Slides   (editable)
//   drive.google.com/file/…         → an uploaded file, opens in Drive's viewer
//
// 🔴 For a Google-native file the copy WE hold is a SNAPSHOT taken at import
// time, and it drifts the moment anyone edits the original. The UI has to say
// so, or someone edits the download, saves it, and quietly loses the team's
// work. The live link is the primary action; ours is the point-in-time copy.
export type GoogleLinkKind = "doc" | "sheet" | "slides" | "drive" | null;

export function googleLinkKind(url: string | null | undefined): GoogleLinkKind {
  if (!url) return null;
  if (url.includes("docs.google.com/document/")) return "doc";
  if (url.includes("docs.google.com/spreadsheets/")) return "sheet";
  if (url.includes("docs.google.com/presentation/")) return "slides";
  if (url.includes("drive.google.com/")) return "drive";
  return null;
}

/** True when Google holds the editable original and ours is only a snapshot. */
export function googleIsLiveEditable(url: string | null | undefined): boolean {
  const k = googleLinkKind(url);
  return k === "doc" || k === "sheet" || k === "slides";
}

export function googleLinkLabel(url: string | null | undefined): string | null {
  switch (googleLinkKind(url)) {
    case "doc": return "Open in Google Docs";
    case "sheet": return "Open in Google Sheets";
    case "slides": return "Open in Google Slides";
    case "drive": return "Open in Google Drive";
    default: return null;
  }
}

export type { Viewer };
