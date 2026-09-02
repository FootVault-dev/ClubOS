/**
 * Media Library — CIC's staff photo/video library ("like our Google Drive").
 * Upload, organise by team + custom categories, and publish galleries/assets
 * to feed the public catalog API (/api/public/media/cic/*) a future
 * storefront will read. Dark-launched super-admin-only via the "media" tab
 * lock in shared/tabs.ts — Daniel opens it up to Max in Team once it's shaped.
 *
 * Money: DB is integer cents; the optional per-asset price is edited in
 * dollars via MoneyInput (feedback_money_in_dollars).
 */
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Images, Plus, Trash2, X, Upload, Video, Image as ImageIcon, Star,
  ExternalLink, Loader2, Tag, ChevronUp, ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MoneyInput } from "@/components/ui/money-input";
import { centsToDollarInput, dollarInputToCents } from "@/lib/format";

// This page only ever renders inside the CIC (tournament) workspace, so the
// tab-permission header is hardcoded — same precedent as
// group-budget-cost-centre.tsx for its always-united-sports-group page.
const WORKSPACE_SLUG = "christchurch-international-cup";

// ── Types (admin API shapes) ────────────────────────────────────────────────

type MediaCategoryT = { id: number; name: string; slug: string; sortOrder: number };

type MediaGalleryT = {
  id: number; tournamentId: number | null; teamId: number | null; ageGroup: string | null;
  clubName: string | null; title: string; slug: string; coverAssetId: number | null;
  shootDate: string | null; status: "draft" | "published" | "hidden"; assetCount: number;
  sortOrder: number; coverThumbUrl: string | null;
};

type MediaAssetT = {
  id: number; galleryId: number | null; categoryId: number | null; teamId: number | null;
  kind: "photo" | "video"; originalFilename: string | null; contentType: string | null;
  sizeBytes: number | null; width: number | null; height: number | null; bibNumber: number | null;
  playerName: string | null; priceCents: number | null; status: "draft" | "published";
  sortOrder: number; previewUrl: string | null; thumbUrl: string | null;
};

type TournamentTeamSourceT = {
  id: number; name: string; ageGroup: string | null;
  teams: { id: number; name: string; clubName: string | null; logoUrl: string | null }[];
};

type ViewT = { kind: "all" } | { kind: "unsorted" } | { kind: "gallery"; galleryId: number };

// ── Shared bits ─────────────────────────────────────────────────────────────

const jget = (url: string) => apiRequest("GET", url).then((r) => r.json());

function formatBytes(n: number | null | undefined): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Multipart batch upload via XHR (needed for a real progress bar — fetch
 *  can't report upload progress). Auth is cookie-based; the workspace header
 *  is set manually since this bypasses apiRequest. */
async function uploadFiles(
  files: File[],
  meta: { orgId: number; galleryId?: number | null; categoryId?: number | null; teamId?: number | null },
  onProgress: (pct: number) => void,
): Promise<{ created: MediaAssetT[]; errors: { filename: string; message: string }[] }> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    fd.append("organizationId", String(meta.orgId));
    if (meta.galleryId != null) fd.append("galleryId", String(meta.galleryId));
    if (meta.categoryId != null) fd.append("categoryId", String(meta.categoryId));
    if (meta.teamId != null) fd.append("teamId", String(meta.teamId));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/admin/media/upload");
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Workspace-Slug", WORKSPACE_SLUG);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText || "{}");
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.message || "Upload failed"));
      } catch {
        reject(new Error("Upload failed"));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(fd);
  });
}

const GALLERY_STATUS_META: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-amber-400/10 text-amber-400 border-amber-400/20" },
  published: { label: "Published", cls: "bg-emerald-400/10 text-emerald-400 border-emerald-400/20" },
  hidden: { label: "Hidden", cls: "bg-white/5 text-white/40 border-white/10" },
};

function StatusPill({ status }: { status: string }) {
  const meta = GALLERY_STATUS_META[status] || { label: status, cls: "bg-white/5 text-white/50 border-white/10" };
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap uppercase tracking-wide ${meta.cls}`}>
      {meta.label}
    </span>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function MediaLibrary() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;

  const [view, setView] = useState<ViewT>({ kind: "all" });
  const [categoryFilter, setCategoryFilter] = useState<number | null>(null);
  const [newGalleryOpen, setNewGalleryOpen] = useState(false);
  const [manageCategoriesOpen, setManageCategoriesOpen] = useState(false);

  const { data: categories = [] } = useQuery<MediaCategoryT[]>({
    queryKey: ["/api/admin/media/categories", { orgId }],
    queryFn: () => jget(`/api/admin/media/categories?orgId=${orgId}`),
    enabled: !!orgId,
  });

  const { data: galleries = [] } = useQuery<MediaGalleryT[]>({
    queryKey: ["/api/admin/media/galleries", { orgId }],
    queryFn: () => jget(`/api/admin/media/galleries?orgId=${orgId}`),
    enabled: !!orgId,
  });

  const { data: stats } = useQuery<{
    totalAssets: number; publishedAssets: number; photoCount: number; videoCount: number;
    totalGalleries: number; publishedGalleries: number; totalBytes: number;
  }>({
    queryKey: ["/api/admin/media/stats", { orgId }],
    queryFn: () => jget(`/api/admin/media/stats?orgId=${orgId}`),
    enabled: !!orgId,
  });

  const grouped = useMemo(() => {
    const byAge = new Map<string, MediaGalleryT[]>();
    for (const g of galleries) {
      const key = g.ageGroup || "Other";
      if (!byAge.has(key)) byAge.set(key, []);
      byAge.get(key)!.push(g);
    }
    return Array.from(byAge.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [galleries]);

  if (!orgId) return null;

  const selectedGallery = view.kind === "gallery" ? galleries.find((g) => g.id === view.galleryId) || null : null;

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2" data-testid="text-media-title">
            <Images className="w-6 h-6 text-blue-400" /> Media Library
          </h1>
          <p className="text-sm text-white/40 mt-1">Upload, organise and publish CIC photos & video — by team, by shoot, by custom category.</p>
        </div>
        <div className="flex items-center gap-3">
          {[
            { label: "Galleries", value: String(stats?.totalGalleries ?? 0) },
            { label: "Published", value: String(stats?.publishedGalleries ?? 0) },
            { label: "Photos", value: String(stats?.photoCount ?? 0) },
            { label: "Videos", value: String(stats?.videoCount ?? 0) },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-blue-500/10 bg-white/[0.02] px-4 py-2.5 min-w-[80px]">
              <p className="text-[10px] text-white/30 uppercase tracking-wider font-semibold">{s.label}</p>
              <p className="text-base font-bold text-white mt-0.5" data-testid={`stat-${s.label.toLowerCase()}`}>{s.value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4 items-start">
        {/* Left rail */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Button onClick={() => setNewGalleryOpen(true)} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white gap-2" data-testid="button-new-gallery">
              <Plus className="w-4 h-4" /> New Gallery
            </Button>
            <Button
              onClick={() => setManageCategoriesOpen(true)}
              variant="outline"
              size="icon"
              className="border-white/10 text-white/60 hover:text-white"
              title="Manage categories"
              data-testid="button-manage-categories"
            >
              <Tag className="w-4 h-4" />
            </Button>
          </div>

          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-2 space-y-1">
            <button
              onClick={() => setView({ kind: "all" })}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
                view.kind === "all" ? "bg-blue-500/15 text-blue-300" : "text-white/60 hover:bg-white/[0.03] hover:text-white/80"
              }`}
              data-testid="nav-view-all"
            >
              <span>All Content</span>
              <span className="text-white/30 text-xs">{stats?.totalAssets ?? 0}</span>
            </button>
            <button
              onClick={() => setView({ kind: "unsorted" })}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
                view.kind === "unsorted" ? "bg-blue-500/15 text-blue-300" : "text-white/60 hover:bg-white/[0.03] hover:text-white/80"
              }`}
              data-testid="nav-view-unsorted"
            >
              <span>Unsorted</span>
            </button>
          </div>

          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-2 space-y-3 max-h-[60vh] overflow-y-auto">
            {galleries.length === 0 && (
              <p className="text-xs text-white/30 px-2 py-3">No galleries yet — create one from a team or start a custom gallery.</p>
            )}
            {grouped.map(([ageGroup, rows]) => (
              <div key={ageGroup}>
                <p className="text-[10px] text-white/25 uppercase tracking-wider font-semibold px-2 mb-1">{ageGroup}</p>
                <div className="space-y-0.5">
                  {rows.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => setView({ kind: "gallery", galleryId: g.id })}
                      className={`w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-lg text-sm transition-colors ${
                        view.kind === "gallery" && view.galleryId === g.id
                          ? "bg-blue-500/15 text-blue-300"
                          : "text-white/60 hover:bg-white/[0.03] hover:text-white/80"
                      }`}
                      data-testid={`nav-gallery-${g.id}`}
                    >
                      <div className="w-6 h-6 rounded overflow-hidden bg-white/5 flex-shrink-0">
                        {g.coverThumbUrl && <img src={g.coverThumbUrl} alt="" className="w-full h-full object-cover" />}
                      </div>
                      <span className="flex-1 truncate">{g.title}</span>
                      {g.status !== "draft" && <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${g.status === "published" ? "bg-emerald-400" : "bg-white/20"}`} />}
                      <span className="text-[10px] text-white/25 flex-shrink-0">{g.assetCount}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Main panel */}
        <GalleryPanel
          orgId={orgId}
          view={view}
          galleries={galleries}
          categories={categories}
          categoryFilter={categoryFilter}
          setCategoryFilter={setCategoryFilter}
          selectedGallery={selectedGallery}
        />
      </div>

      <NewGalleryDialog
        open={newGalleryOpen}
        onOpenChange={setNewGalleryOpen}
        orgId={orgId}
        onCreated={(g) => setView({ kind: "gallery", galleryId: g.id })}
      />
      <ManageCategoriesDialog
        open={manageCategoriesOpen}
        onOpenChange={setManageCategoriesOpen}
        orgId={orgId}
        categories={categories}
      />
    </div>
  );
}

// ═══ Main panel — upload zone + asset grid + bulk toolbar ═══════════════════

function GalleryPanel({
  orgId, view, galleries, categories, categoryFilter, setCategoryFilter, selectedGallery,
}: {
  orgId: number;
  view: ViewT;
  galleries: MediaGalleryT[];
  categories: MediaCategoryT[];
  categoryFilter: number | null;
  setCategoryFilter: (v: number | null) => void;
  selectedGallery: MediaGalleryT | null;
}) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [openAssetId, setOpenAssetId] = useState<number | null>(null);

  const galleryId = view.kind === "gallery" ? view.galleryId : null;

  useEffect(() => {
    setSelected(new Set());
    setOpenAssetId(null);
  }, [view]);

  const { data: rawAssets = [], isLoading } = useQuery<MediaAssetT[]>({
    queryKey: ["/api/admin/media/assets", { orgId, galleryId: galleryId ?? undefined }],
    queryFn: () => jget(`/api/admin/media/assets?orgId=${orgId}${galleryId ? `&galleryId=${galleryId}` : ""}`),
    enabled: !!orgId,
  });

  const assets = useMemo(() => {
    let rows = rawAssets;
    if (view.kind === "unsorted") rows = rows.filter((a) => a.galleryId == null);
    if (categoryFilter != null) rows = rows.filter((a) => a.categoryId === categoryFilter);
    return rows;
  }, [rawAssets, view, categoryFilter]);

  const invalidateAssets = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/media/assets"] });
  const invalidateGalleries = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/media/galleries", { orgId }] });
  const invalidateStats = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/media/stats", { orgId }] });

  const doUpload = async (files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    setUploadPct(0);
    try {
      const result = await uploadFiles(list, {
        orgId,
        galleryId,
        categoryId: categoryFilter,
        teamId: selectedGallery?.teamId ?? null,
      }, setUploadPct);
      invalidateAssets(); invalidateGalleries(); invalidateStats();
      if (result.errors.length > 0) {
        toast({
          title: `${result.created.length} uploaded, ${result.errors.length} failed`,
          description: result.errors.map((e) => e.filename).join(", "),
          variant: "destructive",
        });
      } else {
        toast({ title: `${result.created.length} file${result.created.length === 1 ? "" : "s"} uploaded` });
      }
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
      setUploadPct(0);
    }
  };

  const galleryPatchMut = useMutation({
    mutationFn: (patch: Record<string, any>) => apiRequest("PATCH", `/api/admin/media/galleries/${selectedGallery!.id}`, patch),
    onSuccess: () => { invalidateGalleries(); toast({ title: "Gallery updated" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const deleteGalleryMut = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/admin/media/galleries/${selectedGallery!.id}`),
    onSuccess: () => { invalidateGalleries(); invalidateAssets(); toast({ title: "Gallery deleted — assets kept, now ungrouped" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const bulkMut = useMutation({
    mutationFn: (patch: Record<string, any>) => apiRequest("PATCH", "/api/admin/media/assets/bulk", { ids: Array.from(selected), patch }),
    onSuccess: () => { invalidateAssets(); invalidateGalleries(); setSelected(new Set()); toast({ title: "Updated" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const bulkDeleteMut = useMutation({
    mutationFn: async () => { for (const id of Array.from(selected)) await apiRequest("DELETE", `/api/admin/media/assets/${id}`); },
    onSuccess: () => { invalidateAssets(); invalidateGalleries(); invalidateStats(); setSelected(new Set()); toast({ title: "Deleted" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  // Manual reorder only makes sense inside a single gallery — sortOrder is a
  // flat column, so reordering across "All Content"/"Unsorted" (which mix
  // multiple galleries) would scramble other galleries' display order.
  const reorderMut = useMutation({
    mutationFn: (ids: number[]) => apiRequest("POST", "/api/admin/media/assets/reorder", { ids }),
    onSuccess: invalidateAssets,
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const moveAsset = (index: number, dir: -1 | 1) => {
    const ids = assets.map((a) => a.id);
    const target = index + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorderMut.mutate(ids);
  };

  const toggleSelect = (id: number) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const title = view.kind === "all" ? "All Content" : view.kind === "unsorted" ? "Unsorted" : selectedGallery?.title || "Gallery";

  return (
    <div className="space-y-4">
      {selectedGallery ? (
        <GalleryHeader
          gallery={selectedGallery}
          onPatch={(p) => galleryPatchMut.mutate(p)}
          onDelete={() => {
            if (confirm(`Delete gallery "${selectedGallery.title}"? Assets stay — they just become ungrouped.`)) deleteGalleryMut.mutate();
          }}
        />
      ) : (
        <h2 className="text-lg font-semibold text-white" data-testid="text-panel-title">{title}</h2>
      )}

      {categories.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setCategoryFilter(null)}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
              categoryFilter == null ? "bg-blue-500/15 text-blue-300 border-blue-500/30" : "bg-white/[0.02] text-white/50 border-white/10 hover:text-white/80"
            }`}
            data-testid="chip-category-all"
          >
            All categories
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setCategoryFilter(c.id)}
              className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
                categoryFilter === c.id ? "bg-blue-500/15 text-blue-300 border-blue-500/30" : "bg-white/[0.02] text-white/50 border-white/10 hover:text-white/80"
              }`}
              data-testid={`chip-category-${c.id}`}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); doUpload(e.dataTransfer.files); }}
        onClick={() => fileInputRef.current?.click()}
        className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors cursor-pointer ${
          dragOver ? "border-blue-400/60 bg-blue-500/5" : "border-white/10 hover:border-white/20"
        }`}
        data-testid="dropzone-upload"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="hidden"
          onChange={(e) => { doUpload(e.target.files); e.target.value = ""; }}
          data-testid="input-upload-files"
        />
        {uploading ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
            <p className="text-sm text-white/60">Uploading… {uploadPct}%</p>
            <div className="w-full max-w-xs h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full bg-blue-500 transition-all" style={{ width: `${uploadPct}%` }} />
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-white/40">
            <Upload className="w-6 h-6" />
            <p className="text-sm">Drop photos or video here, or click to browse</p>
            <p className="text-[11px] text-white/25">
              {galleryId
                ? `Uploading to "${selectedGallery?.title}"`
                : view.kind === "unsorted"
                  ? "Uploading to Unsorted"
                  : "Uploading unsorted — pick a gallery on the left to sort as you go"}
              {" · up to 50MB per file"}
            </p>
          </div>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-white/30">Loading…</p>
      ) : assets.length === 0 ? (
        <p className="text-sm text-white/30 py-8 text-center">No content here yet.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 pb-20">
          {assets.map((a, i) => (
            <AssetTile
              key={a.id}
              asset={a}
              categories={categories}
              selected={selected.has(a.id)}
              onToggleSelect={() => toggleSelect(a.id)}
              onOpen={() => setOpenAssetId(a.id)}
              isCover={selectedGallery?.coverAssetId === a.id}
              onSetCover={selectedGallery ? () => galleryPatchMut.mutate({ coverAssetId: a.id }) : undefined}
              onMove={selectedGallery ? (dir) => moveAsset(i, dir) : undefined}
              canMoveUp={i > 0}
              canMoveDown={i < assets.length - 1}
            />
          ))}
        </div>
      )}

      {selected.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 flex-wrap justify-center rounded-xl border border-blue-500/20 bg-[#0a0e1a] shadow-2xl shadow-black/50 px-4 py-3 max-w-[95vw]">
          <span className="text-sm text-white/70 whitespace-nowrap">{selected.size} selected</span>
          <Select onValueChange={(v) => bulkMut.mutate({ categoryId: v === "none" ? null : parseInt(v) })}>
            <SelectTrigger className="premium-input text-white h-8 w-[150px] text-xs" data-testid="select-bulk-category"><SelectValue placeholder="Set category…" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No category</SelectItem>
              {categories.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select onValueChange={(v) => bulkMut.mutate({ galleryId: v === "none" ? null : parseInt(v) })}>
            <SelectTrigger className="premium-input text-white h-8 w-[150px] text-xs" data-testid="select-bulk-gallery"><SelectValue placeholder="Move to gallery…" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Unsorted</SelectItem>
              {galleries.map((g) => <SelectItem key={g.id} value={String(g.id)}>{g.title}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => bulkMut.mutate({ status: "published" })} className="bg-emerald-600 hover:bg-emerald-700 text-white h-8" data-testid="button-bulk-publish">Publish</Button>
          <Button size="sm" onClick={() => bulkMut.mutate({ status: "draft" })} variant="outline" className="border-white/10 text-white/70 h-8" data-testid="button-bulk-unpublish">Unpublish</Button>
          <Button
            size="sm"
            onClick={() => { if (confirm(`Delete ${selected.size} item(s)? This can't be undone.`)) bulkDeleteMut.mutate(); }}
            variant="outline"
            className="border-red-500/20 text-red-400 hover:bg-red-500/10 h-8"
            data-testid="button-bulk-delete"
          >
            Delete
          </Button>
          <button onClick={() => setSelected(new Set())} className="text-white/30 hover:text-white/60"><X className="w-4 h-4" /></button>
        </div>
      )}

      {openAssetId != null && (
        <AssetDetailDrawer
          assetId={openAssetId}
          assets={assets}
          galleries={galleries}
          categories={categories}
          onClose={() => setOpenAssetId(null)}
        />
      )}
    </div>
  );
}

function GalleryHeader({
  gallery, onPatch, onDelete,
}: { gallery: MediaGalleryT; onPatch: (p: Record<string, any>) => void; onDelete: () => void }) {
  const [title, setTitle] = useState(gallery.title);
  const [ageGroup, setAgeGroup] = useState(gallery.ageGroup || "");
  const [clubName, setClubName] = useState(gallery.clubName || "");
  const [shootDate, setShootDate] = useState(gallery.shootDate || "");

  useEffect(() => {
    setTitle(gallery.title);
    setAgeGroup(gallery.ageGroup || "");
    setClubName(gallery.clubName || "");
    setShootDate(gallery.shootDate || "");
  }, [gallery.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = title !== gallery.title
    || ageGroup !== (gallery.ageGroup || "")
    || clubName !== (gallery.clubName || "")
    || shootDate !== (gallery.shootDate || "");

  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-[220px] space-y-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} className="premium-input text-white text-lg font-semibold h-10" data-testid="input-gallery-title" />
          <div className="flex items-center gap-2 flex-wrap">
            <Input value={ageGroup} onChange={(e) => setAgeGroup(e.target.value)} placeholder="Age group" className="premium-input text-white h-8 w-32 text-xs" data-testid="input-gallery-age-group" />
            <Input value={clubName} onChange={(e) => setClubName(e.target.value)} placeholder="Club name" className="premium-input text-white h-8 w-40 text-xs" data-testid="input-gallery-club-name" />
            <DatePickerInput value={shootDate} onChange={(e) => setShootDate(e.target.value)} className="premium-input text-white h-8 w-36 text-xs" data-testid="input-gallery-shoot-date" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Select value={gallery.status} onValueChange={(v) => onPatch({ status: v })}>
            <SelectTrigger className="premium-input text-white h-9 w-[130px]" data-testid="select-gallery-status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="published">Published</SelectItem>
              <SelectItem value="hidden">Hidden</SelectItem>
            </SelectContent>
          </Select>
          <StatusPill status={gallery.status} />
          <Button variant="outline" size="icon" onClick={onDelete} className="border-red-500/20 text-red-400 hover:bg-red-500/10" data-testid="button-delete-gallery">
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>
      {dirty && (
        <Button
          size="sm"
          onClick={() => onPatch({ title, ageGroup: ageGroup || null, clubName: clubName || null, shootDate: shootDate || null })}
          className="bg-blue-600 hover:bg-blue-700 text-white"
          data-testid="button-save-gallery-meta"
        >
          Save changes
        </Button>
      )}
    </div>
  );
}

function AssetTile({
  asset, categories, selected, onToggleSelect, onOpen, isCover, onSetCover, onMove, canMoveUp, canMoveDown,
}: {
  asset: MediaAssetT;
  categories: MediaCategoryT[];
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  isCover: boolean;
  onSetCover?: () => void;
  onMove?: (dir: -1 | 1) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}) {
  const category = categories.find((c) => c.id === asset.categoryId);
  const thumb = asset.thumbUrl || asset.previewUrl;

  return (
    <div
      className={`group relative rounded-xl border overflow-hidden bg-black/20 ${selected ? "border-blue-400/60 ring-2 ring-blue-400/30" : "border-white/5"}`}
      data-testid={`asset-tile-${asset.id}`}
    >
      <div className="absolute top-2 left-2 z-10" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={selected} onCheckedChange={onToggleSelect} className="bg-black/50 border-white/30" data-testid={`checkbox-asset-${asset.id}`} />
      </div>
      {isCover && (
        <span className="absolute top-2 right-2 z-10 text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-400/90 text-black">COVER</span>
      )}
      <button onClick={onOpen} className="w-full aspect-square block relative">
        {thumb ? (
          <img src={thumb} alt={asset.originalFilename || ""} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white/20">
            {asset.kind === "video" ? <Video className="w-8 h-8" /> : <ImageIcon className="w-8 h-8" />}
          </div>
        )}
        {asset.kind === "video" && (
          <span className="absolute bottom-2 left-2 flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-black/60 text-white">
            <Video className="w-3 h-3" /> Video
          </span>
        )}
      </button>
      <div className="p-2 space-y-1">
        <p className="text-[11px] text-white/60 truncate">{asset.originalFilename}</p>
        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-1 flex-wrap min-w-0">
            {category && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/5 text-white/40 truncate">{category.name}</span>}
            {asset.bibNumber != null && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-300 flex-shrink-0">#{asset.bibNumber}</span>}
          </div>
          <span className={`text-[9px] font-semibold uppercase flex-shrink-0 ${asset.status === "published" ? "text-emerald-400" : "text-white/30"}`}>
            {asset.status === "published" ? "Live" : "Draft"}
          </span>
        </div>
      </div>
      {onSetCover && !isCover && (
        <button
          onClick={(e) => { e.stopPropagation(); onSetCover(); }}
          className="absolute top-2 right-2 z-10 hidden group-hover:flex w-6 h-6 items-center justify-center rounded-full bg-black/60 text-white/60 hover:text-amber-400"
          title="Set as gallery cover"
          data-testid={`button-set-cover-${asset.id}`}
        >
          <Star className="w-3.5 h-3.5" />
        </button>
      )}
      {onMove && (
        <div className="absolute bottom-2 right-2 z-10 hidden group-hover:flex flex-col rounded-lg overflow-hidden border border-white/10">
          <button
            onClick={(e) => { e.stopPropagation(); onMove(-1); }}
            disabled={!canMoveUp}
            className="w-6 h-5 flex items-center justify-center bg-black/70 text-white/60 hover:text-white disabled:opacity-30 disabled:pointer-events-none"
            title="Move earlier"
            data-testid={`button-move-up-${asset.id}`}
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onMove(1); }}
            disabled={!canMoveDown}
            className="w-6 h-5 flex items-center justify-center bg-black/70 text-white/60 hover:text-white disabled:opacity-30 disabled:pointer-events-none"
            title="Move later"
            data-testid={`button-move-down-${asset.id}`}
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function AssetDetailDrawer({
  assetId, assets, galleries, categories, onClose,
}: {
  assetId: number;
  assets: MediaAssetT[];
  galleries: MediaGalleryT[];
  categories: MediaCategoryT[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const asset = assets.find((a) => a.id === assetId);
  const [bib, setBib] = useState(asset?.bibNumber != null ? String(asset.bibNumber) : "");
  const [playerName, setPlayerName] = useState(asset?.playerName || "");
  const [price, setPrice] = useState(centsToDollarInput(asset?.priceCents));

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/media/assets"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/media/galleries"] });
  };

  const patchMut = useMutation({
    mutationFn: (patch: Record<string, any>) => apiRequest("PATCH", `/api/admin/media/assets/${assetId}`, patch),
    onSuccess: () => { invalidate(); toast({ title: "Saved" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const deleteMut = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/admin/media/assets/${assetId}`),
    onSuccess: () => { invalidate(); toast({ title: "Deleted" }); onClose(); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const viewOriginal = async () => {
    try {
      const res = await apiRequest("GET", `/api/admin/media/assets/${assetId}/original-url`);
      const { url } = await res.json();
      window.open(url, "_blank", "noopener");
    } catch (e: any) {
      toast({ title: "Couldn't open original", description: e.message, variant: "destructive" });
    }
  };

  if (!asset) return null;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl bg-[#0a0e1a] border-white/10 max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle className="text-white truncate pr-6">{asset.originalFilename}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="rounded-lg overflow-hidden bg-black/30 aspect-square flex items-center justify-center">
            {asset.previewUrl ? (
              <img src={asset.previewUrl} alt="" className="w-full h-full object-contain" />
            ) : (
              <div className="text-white/20">
                {asset.kind === "video" ? <Video className="w-12 h-12" /> : <ImageIcon className="w-12 h-12" />}
              </div>
            )}
          </div>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/40">
              <span>Kind: <span className="text-white/70">{asset.kind}</span></span>
              <span>Size: <span className="text-white/70">{formatBytes(asset.sizeBytes)}</span></span>
              {asset.width && asset.height && <span>Dimensions: <span className="text-white/70">{asset.width}×{asset.height}</span></span>}
            </div>

            <div className="space-y-1">
              <p className="text-[10px] text-white/30 uppercase tracking-wider font-semibold">Publish</p>
              <div className="flex items-center gap-2">
                <Switch
                  checked={asset.status === "published"}
                  onCheckedChange={(v) => patchMut.mutate({ status: v ? "published" : "draft" })}
                  data-testid="switch-asset-publish"
                />
                <span className="text-sm text-white/60">
                  {asset.status === "published" ? "Published — visible in the public catalog" : "Draft — hidden from the public catalog"}
                </span>
              </div>
            </div>

            <div className="space-y-1">
              <p className="text-[10px] text-white/30 uppercase tracking-wider font-semibold">Gallery</p>
              <Select
                value={asset.galleryId != null ? String(asset.galleryId) : "none"}
                onValueChange={(v) => patchMut.mutate({ galleryId: v === "none" ? null : parseInt(v) })}
              >
                <SelectTrigger className="premium-input text-white" data-testid="select-asset-gallery"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unsorted</SelectItem>
                  {galleries.map((g) => <SelectItem key={g.id} value={String(g.id)}>{g.title}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <p className="text-[10px] text-white/30 uppercase tracking-wider font-semibold">Category</p>
              <Select
                value={asset.categoryId != null ? String(asset.categoryId) : "none"}
                onValueChange={(v) => patchMut.mutate({ categoryId: v === "none" ? null : parseInt(v) })}
              >
                <SelectTrigger className="premium-input text-white" data-testid="select-asset-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No category</SelectItem>
                  {categories.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <p className="text-[10px] text-white/30 uppercase tracking-wider font-semibold">Bib number</p>
                <Input
                  value={bib}
                  onChange={(e) => setBib(e.target.value.replace(/[^0-9]/g, ""))}
                  onBlur={() => patchMut.mutate({ bibNumber: bib ? parseInt(bib) : null })}
                  className="premium-input text-white"
                  data-testid="input-asset-bib"
                />
              </div>
              <div className="space-y-1">
                <p className="text-[10px] text-white/30 uppercase tracking-wider font-semibold">Price (optional)</p>
                <MoneyInput
                  value={price}
                  onChange={setPrice}
                  onBlur={() => patchMut.mutate({ priceCents: price ? dollarInputToCents(price) : null })}
                  data-testid="input-asset-price"
                />
              </div>
            </div>

            <div className="space-y-1">
              <p className="text-[10px] text-white/30 uppercase tracking-wider font-semibold">Player name — internal only, never shown publicly</p>
              <Input
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                onBlur={() => patchMut.mutate({ playerName })}
                className="premium-input text-white"
                data-testid="input-asset-player-name"
              />
            </div>

            <div className="flex items-center gap-2 pt-2 flex-wrap">
              <Button variant="outline" onClick={viewOriginal} className="border-white/10 text-white/70 gap-2" data-testid="button-view-original">
                <ExternalLink className="w-3.5 h-3.5" /> View original
              </Button>
              <Button
                variant="outline"
                onClick={() => { if (confirm("Delete this file? This can't be undone.")) deleteMut.mutate(); }}
                className="border-red-500/20 text-red-400 hover:bg-red-500/10 gap-2"
                data-testid="button-delete-asset"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ═══ New gallery dialog — from a CIC team, or a custom grouping ═════════════

function NewGalleryDialog({
  open, onOpenChange, orgId, onCreated,
}: { open: boolean; onOpenChange: (v: boolean) => void; orgId: number; onCreated: (g: MediaGalleryT) => void }) {
  const { toast } = useToast();
  const [mode, setMode] = useState<"team" | "custom">("team");
  const [tournamentId, setTournamentId] = useState<string>("");
  const [teamId, setTeamId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [ageGroup, setAgeGroup] = useState("");
  const [clubName, setClubName] = useState("");
  const [shootDate, setShootDate] = useState("");

  const { data: source = [] } = useQuery<TournamentTeamSourceT[]>({
    queryKey: ["/api/admin/media/tournament-teams", { orgId }],
    queryFn: () => jget(`/api/admin/media/tournament-teams?orgId=${orgId}`),
    enabled: open && !!orgId,
  });

  const teams = source.find((t) => String(t.id) === tournamentId)?.teams || [];

  const reset = () => {
    setMode("team"); setTournamentId(""); setTeamId("");
    setTitle(""); setAgeGroup(""); setClubName(""); setShootDate("");
  };

  const fromTeamMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/media/galleries/from-team", {
      organizationId: orgId, tournamentId: parseInt(tournamentId), teamId: parseInt(teamId),
    }).then((r) => r.json()),
    onSuccess: (g) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/media/galleries", { orgId }] });
      toast({ title: "Gallery created" });
      reset(); onOpenChange(false); onCreated(g);
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const customMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/media/galleries", {
      organizationId: orgId, title, ageGroup: ageGroup || null, clubName: clubName || null, shootDate: shootDate || null,
    }).then((r) => r.json()),
    onSuccess: (g) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/media/galleries", { orgId }] });
      toast({ title: "Gallery created" });
      reset(); onOpenChange(false); onCreated(g);
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md bg-[#0a0e1a] border-white/10">
        <DialogHeader><DialogTitle className="text-white">New gallery</DialogTitle></DialogHeader>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMode("team")}
            className={`flex-1 text-sm font-medium px-3 py-2 rounded-lg border transition-colors ${mode === "team" ? "bg-blue-500/15 text-blue-300 border-blue-500/30" : "bg-white/[0.02] text-white/50 border-white/10"}`}
            data-testid="button-mode-team"
          >
            From a CIC team
          </button>
          <button
            onClick={() => setMode("custom")}
            className={`flex-1 text-sm font-medium px-3 py-2 rounded-lg border transition-colors ${mode === "custom" ? "bg-blue-500/15 text-blue-300 border-blue-500/30" : "bg-white/[0.02] text-white/50 border-white/10"}`}
            data-testid="button-mode-custom"
          >
            Custom gallery
          </button>
        </div>

        {mode === "team" ? (
          <div className="space-y-3">
            {source.length === 0 && <p className="text-xs text-white/30">No CIC tournaments/teams found for this org yet.</p>}
            <Select value={tournamentId} onValueChange={(v) => { setTournamentId(v); setTeamId(""); }}>
              <SelectTrigger className="premium-input text-white" data-testid="select-new-gallery-tournament"><SelectValue placeholder="Age group / tournament" /></SelectTrigger>
              <SelectContent>
                {source.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}{t.ageGroup ? ` (${t.ageGroup})` : ""}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={teamId} onValueChange={setTeamId} disabled={!tournamentId}>
              <SelectTrigger className="premium-input text-white" data-testid="select-new-gallery-team"><SelectValue placeholder="Team" /></SelectTrigger>
              <SelectContent>
                {teams.map((tm) => <SelectItem key={tm.id} value={String(tm.id)}>{tm.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button
              onClick={() => fromTeamMut.mutate()}
              disabled={!tournamentId || !teamId || fromTeamMut.isPending}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white"
              data-testid="button-create-team-gallery"
            >
              {fromTeamMut.isPending ? "Creating…" : "Create gallery"}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Gallery title" className="premium-input text-white" data-testid="input-new-gallery-title" />
            <div className="grid grid-cols-2 gap-2">
              <Input value={ageGroup} onChange={(e) => setAgeGroup(e.target.value)} placeholder="Age group (optional)" className="premium-input text-white" data-testid="input-new-gallery-age-group" />
              <Input value={clubName} onChange={(e) => setClubName(e.target.value)} placeholder="Club name (optional)" className="premium-input text-white" data-testid="input-new-gallery-club-name" />
            </div>
            <DatePickerInput value={shootDate} onChange={(e) => setShootDate(e.target.value)} className="premium-input text-white" data-testid="input-new-gallery-shoot-date" />
            <Button
              onClick={() => customMut.mutate()}
              disabled={!title.trim() || customMut.isPending}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white"
              data-testid="button-create-custom-gallery"
            >
              {customMut.isPending ? "Creating…" : "Create gallery"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ═══ Manage categories dialog ════════════════════════════════════════════

function ManageCategoriesDialog({
  open, onOpenChange, orgId, categories,
}: { open: boolean; onOpenChange: (v: boolean) => void; orgId: number; categories: MediaCategoryT[] }) {
  const { toast } = useToast();
  const [name, setName] = useState("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/media/categories", { orgId }] });

  const createMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/media/categories", { organizationId: orgId, name }),
    onSuccess: () => { invalidate(); setName(""); toast({ title: "Category added" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/media/categories/${id}`),
    onSuccess: () => { invalidate(); toast({ title: "Category deleted" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-[#0a0e1a] border-white/10">
        <DialogHeader><DialogTitle className="text-white">Categories</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Match Action, Portraits…"
              className="premium-input text-white"
              onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) createMut.mutate(); }}
              data-testid="input-new-category"
            />
            <Button onClick={() => createMut.mutate()} disabled={!name.trim() || createMut.isPending} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-add-category">
              <Plus className="w-4 h-4" />
            </Button>
          </div>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {categories.length === 0 && <p className="text-xs text-white/30 py-2">No categories yet.</p>}
            {categories.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                <span className="text-sm text-white/70">{c.name}</span>
                <button
                  onClick={() => { if (confirm(`Delete category "${c.name}"? Assets keep their file, just lose the tag.`)) deleteMut.mutate(c.id); }}
                  className="text-white/25 hover:text-red-400"
                  data-testid={`button-delete-category-${c.id}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
