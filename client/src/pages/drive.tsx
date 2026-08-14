// ─────────────────────────────────────────────────────────────────────────────
// Club Drive — the club's own file store.
//
// Universal tab (every workspace), same reasoning as the Knowledge Base: a
// sponsorship contract is the club's document whichever workspace you happen to
// be standing in when you need it.
//
// Search is the point, not browsing. The search box is the first thing on the
// page and it searches INSIDE files, so "the thing about the gym partnership"
// finds a PDF nobody named helpfully.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, workspaceFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  ChevronRight, Download, File as FileIcon, FileSpreadsheet, FileText, FileType2,
  Film, Folder, FolderPlus, HardDrive, Home, Image as ImageIcon, Loader2, Lock,
  Music, Package, Pencil, RotateCcw, Search, Trash2, Upload, X,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────
interface Node {
  id: number;
  parentId: number | null;
  kind: "folder" | "file";
  name: string;
  category: string;
  mimeType: string | null;
  sizeBytes: number | null;
  brand: string;
  description: string | null;
  source: string;
  sourceUrl: string | null;
  restricted: boolean;
  restrictedLabel: string | null;
  hasText: boolean;
  extractStatus: string | null;
  trashedAt: string | null;
  updatedAt: string;
  snippet?: string;
  path?: string[];
}

const ICONS: Record<string, any> = {
  folder: Folder, document: FileText, spreadsheet: FileSpreadsheet,
  presentation: FileType2, pdf: FileText, image: ImageIcon,
  video: Film, audio: Music, archive: Package, other: FileIcon,
};

const TINT: Record<string, string> = {
  folder: "text-amber-300", document: "text-blue-300", spreadsheet: "text-emerald-300",
  presentation: "text-orange-300", pdf: "text-red-300", image: "text-purple-300",
  video: "text-pink-300", audio: "text-cyan-300", archive: "text-slate-300",
  other: "text-white/50",
};

function bytes(n: number | null): string {
  if (n === null || n === undefined) return "";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Drive() {
  const { toast } = useToast();
  const [folderId, setFolderId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [showTrash, setShowTrash] = useState(false);
  const [detail, setDetail] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const searching = debounced.length > 0;

  const listing = useQuery<{ parentId: number | null; breadcrumbs: { id: number; name: string }[]; items: Node[] }>({
    queryKey: ["/api/admin/drive/list", folderId],
    queryFn: async () => {
      const r = await workspaceFetch(`/api/admin/drive/list${folderId ? `?parentId=${folderId}` : ""}`);
      if (!r.ok) throw new Error("Couldn't open that folder");
      return r.json();
    },
    enabled: !searching && !showTrash,
  });

  const results = useQuery<{ query: string; items: Node[] }>({
    queryKey: ["/api/admin/drive/search", debounced],
    queryFn: async () => {
      const r = await workspaceFetch(`/api/admin/drive/search?q=${encodeURIComponent(debounced)}`);
      if (!r.ok) throw new Error("Search failed");
      return r.json();
    },
    enabled: searching,
  });

  const trash = useQuery<{ items: Node[] }>({
    queryKey: ["/api/admin/drive/trash"],
    queryFn: async () => {
      const r = await workspaceFetch("/api/admin/drive/trash");
      if (!r.ok) throw new Error("Couldn't load the bin");
      return r.json();
    },
    enabled: showTrash,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/drive/list"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/drive/search"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/drive/trash"] });
  };

  // ── Upload ─────────────────────────────────────────────────────────────────
  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(list.length);
    let ok = 0;
    for (const f of list) {
      try {
        const fd = new FormData();
        fd.append("file", f);
        if (folderId) fd.append("parentId", String(folderId));
        const r = await workspaceFetch("/api/admin/drive/upload", { method: "POST", body: fd });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.message ?? "Upload failed");
        }
        ok++;
      } catch (e: any) {
        toast({ title: `Couldn't upload ${f.name}`, description: e.message, variant: "destructive" });
      }
      setUploading((n) => n - 1);
    }
    if (ok) toast({ title: ok === 1 ? "Uploaded" : `${ok} files uploaded` });
    refresh();
  }, [folderId, toast]);

  const newFolder = useMutation({
    mutationFn: async (name: string) => {
      const r = await workspaceFetch("/api/admin/drive/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, parentId: folderId }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? "Couldn't create the folder");
      return r.json();
    },
    onSuccess: () => { toast({ title: "Folder created" }); refresh(); },
    onError: (e: any) => toast({ title: "Couldn't create the folder", description: e.message, variant: "destructive" }),
  });

  const act = async (id: number, action: "trash" | "restore") => {
    const r = await workspaceFetch(`/api/admin/drive/node/${id}/${action}`, { method: "POST" });
    if (!r.ok) return toast({ title: "That didn't work", variant: "destructive" });
    toast({ title: action === "trash" ? "Moved to the bin" : "Restored" });
    refresh();
  };

  const rename = async (n: Node) => {
    const name = window.prompt("New name", n.name);
    if (!name || name === n.name) return;
    const r = await workspaceFetch(`/api/admin/drive/node/${n.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) return toast({ title: (await r.json().catch(() => ({}))).message ?? "Couldn't rename", variant: "destructive" });
    refresh();
  };

  const items = showTrash ? (trash.data?.items ?? []) : searching ? (results.data?.items ?? []) : (listing.data?.items ?? []);
  const loading = showTrash ? trash.isLoading : searching ? results.isLoading : listing.isLoading;
  const crumbs = listing.data?.breadcrumbs ?? [];

  return (
    <div
      className="min-h-screen bg-[#0a0f1c] text-white"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files); }}
    >
      {/* Header */}
      <div className="sticky top-0 z-20 border-b border-white/10 bg-[#0a0f1c]/95 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2.5">
              <div className="grid h-9 w-9 place-items-center rounded-lg bg-amber-400/15">
                <HardDrive className="h-[18px] w-[18px] text-amber-300" />
              </div>
              <div>
                <h1 className="text-[17px] font-semibold leading-tight">Club Drive</h1>
                <p className="text-[11px] text-white/40">Every file the club keeps</p>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => { const n = window.prompt("Folder name"); if (n?.trim()) newFolder.mutate(n.trim()); }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-[13px] text-white/70 transition hover:bg-white/5 hover:text-white"
              >
                <FolderPlus className="h-4 w-4" /> <span className="hidden sm:inline">New folder</span>
              </button>
              <button
                onClick={() => fileInput.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-3 py-2 text-[13px] font-semibold text-black transition hover:bg-amber-300"
              >
                <Upload className="h-4 w-4" /> Upload
              </button>
              <input
                ref={fileInput} type="file" multiple className="hidden"
                onChange={(e) => { if (e.target.files) uploadFiles(e.target.files); e.target.value = ""; }}
              />
            </div>
          </div>

          {/* Search — first, because finding beats browsing */}
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setShowTrash(false); }}
              placeholder="Search names and inside files — try a phrase you remember"
              className="w-full rounded-lg border border-white/10 bg-white/[0.04] py-2.5 pl-9 pr-9 text-[14px] placeholder:text-white/25 focus:border-amber-400/40 focus:outline-none"
            />
            {query && (
              <button onClick={() => setQuery("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Breadcrumbs / context */}
          <div className="mt-2.5 flex flex-wrap items-center gap-1 text-[12px]">
            {searching ? (
              <span className="text-white/40">
                {loading ? "Searching…" : `${items.length} result${items.length === 1 ? "" : "s"} for “${debounced}”`}
              </span>
            ) : showTrash ? (
              <button onClick={() => setShowTrash(false)} className="text-amber-300 hover:underline">← Back to files</button>
            ) : (
              <>
                <button
                  onClick={() => setFolderId(null)}
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition hover:bg-white/5 ${folderId === null ? "text-white" : "text-white/45"}`}
                >
                  <Home className="h-3.5 w-3.5" /> Drive
                </button>
                {crumbs.map((c) => (
                  <span key={c.id} className="flex items-center gap-1">
                    <ChevronRight className="h-3 w-3 text-white/20" />
                    <button
                      onClick={() => setFolderId(c.id)}
                      className={`rounded px-1.5 py-0.5 transition hover:bg-white/5 ${c.id === folderId ? "text-white" : "text-white/45"}`}
                    >
                      {c.name}
                    </button>
                  </span>
                ))}
                <button onClick={() => { setShowTrash(true); setQuery(""); }} className="ml-auto text-white/30 hover:text-white/60">
                  Bin
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
        {uploading > 0 && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[13px] text-amber-200">
            <Loader2 className="h-4 w-4 animate-spin" /> Uploading {uploading} file{uploading === 1 ? "" : "s"}…
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20 text-white/30">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 px-6 py-16 text-center">
            <HardDrive className="mx-auto h-8 w-8 text-white/15" />
            <p className="mt-3 text-[14px] text-white/50">
              {searching ? `Nothing matched “${debounced}”.`
                : showTrash ? "The bin is empty."
                : "This folder is empty."}
            </p>
            {!searching && !showTrash && (
              <p className="mt-1 text-[12px] text-white/25">Drag files anywhere on this page to upload them.</p>
            )}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-white/10">
            {items.map((n, i) => {
              const Icon = ICONS[n.category] ?? FileIcon;
              return (
                <div
                  key={n.id}
                  className={`group flex items-center gap-3 px-3 py-2.5 transition hover:bg-white/[0.03] ${i > 0 ? "border-t border-white/[0.06]" : ""}`}
                >
                  <button
                    onClick={() => {
                      if (showTrash) return;
                      if (n.kind === "folder") { setFolderId(n.id); setQuery(""); }
                      else setDetail(n.id);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <Icon className={`h-[18px] w-[18px] shrink-0 ${TINT[n.category] ?? TINT.other}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[14px] text-white/90">{n.name}</span>
                        {n.restricted && (
                          <span title={n.restrictedLabel ?? "Restricted"}>
                            <Lock className="h-3 w-3 shrink-0 text-amber-300/70" />
                          </span>
                        )}
                      </div>
                      {n.snippet ? (
                        <p className="mt-0.5 truncate text-[11.5px] text-white/35">{n.snippet}</p>
                      ) : n.path?.length ? (
                        <p className="mt-0.5 truncate text-[11.5px] text-white/25">/{n.path.join("/")}</p>
                      ) : n.description ? (
                        <p className="mt-0.5 truncate text-[11.5px] text-white/35">{n.description}</p>
                      ) : null}
                    </div>
                  </button>

                  <span className="hidden shrink-0 text-[11.5px] tabular-nums text-white/25 sm:block">
                    {n.kind === "file" ? bytes(n.sizeBytes) : ""}
                  </span>
                  <span className="hidden shrink-0 text-[11.5px] tabular-nums text-white/25 md:block">
                    {when(n.updatedAt)}
                  </span>

                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                    {showTrash ? (
                      <button onClick={() => act(n.id, "restore")} title="Restore"
                        className="rounded p-1.5 text-white/40 hover:bg-white/10 hover:text-white">
                        <RotateCcw className="h-4 w-4" />
                      </button>
                    ) : (
                      <>
                        {n.kind === "file" && (
                          <a href={`/api/admin/drive/file/${n.id}/download`} title="Download"
                            className="rounded p-1.5 text-white/40 hover:bg-white/10 hover:text-white">
                            <Download className="h-4 w-4" />
                          </a>
                        )}
                        <button onClick={() => rename(n)} title="Rename"
                          className="rounded p-1.5 text-white/40 hover:bg-white/10 hover:text-white">
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button onClick={() => act(n.id, "trash")} title="Move to bin"
                          className="rounded p-1.5 text-white/40 hover:bg-white/10 hover:text-red-300">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-black/60 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-amber-400/50 px-10 py-8 text-center">
            <Upload className="mx-auto h-8 w-8 text-amber-300" />
            <p className="mt-2 text-[15px] font-medium">Drop to upload</p>
          </div>
        </div>
      )}

      {detail !== null && <DetailSheet id={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

// ── File detail ──────────────────────────────────────────────────────────────
function DetailSheet({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/admin/drive/node", id],
    queryFn: async () => {
      const r = await workspaceFetch(`/api/admin/drive/node/${id}`);
      if (!r.ok) throw new Error("Not found");
      return r.json();
    },
  });

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const Icon = data ? (ICONS[data.category] ?? FileIcon) : FileIcon;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div
        className="h-full w-full max-w-md overflow-y-auto border-l border-white/10 bg-[#0d1424] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-[15px] font-semibold leading-snug">{data?.name ?? "…"}</h2>
          <button onClick={onClose} className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        {isLoading ? (
          <div className="py-16 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-white/30" /></div>
        ) : !data ? (
          <p className="py-16 text-center text-[13px] text-white/40">Not found.</p>
        ) : (
          <>
            <div className="mt-4 grid place-items-center rounded-xl border border-white/10 bg-white/[0.02] py-8">
              <Icon className={`h-10 w-10 ${TINT[data.category] ?? TINT.other}`} />
            </div>

            <div className="mt-4 flex gap-2">
              <a href={`/api/admin/drive/file/${id}/open`} target="_blank" rel="noreferrer"
                className="flex-1 rounded-lg bg-amber-400 py-2 text-center text-[13px] font-semibold text-black hover:bg-amber-300">
                Open
              </a>
              <a href={`/api/admin/drive/file/${id}/download`}
                className="flex-1 rounded-lg border border-white/10 py-2 text-center text-[13px] text-white/80 hover:bg-white/5">
                Download
              </a>
            </div>

            {data.restricted && (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2.5">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                <p className="text-[12px] text-amber-200/90">{data.restrictedLabel}</p>
              </div>
            )}

            <dl className="mt-4 space-y-2 text-[12.5px]">
              {[
                ["Where", data.breadcrumbs?.length ? "/" + data.breadcrumbs.map((b: any) => b.name).join("/") : "/ Drive"],
                ["Size", bytes(data.sizeBytes)],
                ["Type", data.mimeType ?? "—"],
                ["Added", when(data.createdAt)],
                ["Owner", data.owner ?? "—"],
                ["From", data.source === "google_drive" ? "Imported from Google Drive" : "Uploaded to ClubOS"],
              ].map(([k, v]) => (
                <div key={k as string} className="flex gap-3">
                  <dt className="w-20 shrink-0 text-white/35">{k}</dt>
                  <dd className="min-w-0 flex-1 break-words text-white/75">{v as string}</dd>
                </div>
              ))}
            </dl>

            {/* Being honest about searchability is the point — a file nobody can
                search is a file nobody will find, and staff should know which. */}
            <div className="mt-4 rounded-lg border border-white/10 px-3 py-2.5">
              <p className="text-[11px] uppercase tracking-wide text-white/30">Searchable contents</p>
              {data.extractStatus === "done" ? (
                <p className="mt-1 text-[12.5px] text-emerald-300/80">Yes — the text inside this file is searchable.</p>
              ) : data.extractStatus === "unsupported" ? (
                <p className="mt-1 text-[12.5px] text-white/45">Name and description only — this file type has no readable text.</p>
              ) : data.extractStatus === "failed" ? (
                <p className="mt-1 text-[12.5px] text-amber-200/70">Couldn't be read. Name and description are still searchable.</p>
              ) : (
                <p className="mt-1 text-[12.5px] text-white/45">Not indexed.</p>
              )}
              {data.textPreview && (
                <p className="mt-2 line-clamp-6 whitespace-pre-wrap text-[11.5px] leading-relaxed text-white/35">
                  {data.textPreview.slice(0, 500)}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
