// USG Studio — editor. Route: /admin/studio/:id.
//
// Split view: left = a locked, foolproof content editor (Tier-1 inline editing —
// the staffer only ever touches text; brand + layout stay locked), right = the
// live on-brand preview through the SAME <BrandTheme> + <BlockRenderer> pipeline
// the public page uses. Edit → preview updates live → Save (snapshots a version)
// → Publish → copy the /p/:token deliverable link.
//
// DEFERRED (marked below, nothing faked): per-block "rewrite this section"
// (needs a server block-regen endpoint), whole-page chat, streaming generation,
// the pre-render outline gate, and a full version list + one-click rollback
// (no server endpoint lists studio_document_versions — we must not add one here).
import { useEffect, useMemo, useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft, Save, Send, Wand2, Copy, ExternalLink, Monitor, Smartphone,
  Sparkles, History, RefreshCw, Check,
} from "lucide-react";
import type { PageDoc } from "@shared/studio-blocks";
import { BrandTheme } from "@/studio-blocks/theme";
import { BlockRenderer } from "@/studio-blocks/BlockRenderer";
import {
  docFieldGroups, setAtPath, brandName, briefKey, warningsKey,
  type StudioDocRow, type FieldPath,
} from "./studio-shared";

interface GenerateResponse {
  content: PageDoc;
  warnings: string[];
  brandId: string;
}

function fmt(ts: string | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-NZ", { dateStyle: "medium", timeStyle: "short" });
}

export default function StudioEditor() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [, params] = useRoute("/admin/studio/:id");
  const id = Number(params?.id);

  const { data, isLoading, isError } = useQuery<StudioDocRow>({
    queryKey: ["/api/admin/studio", String(id)],
    enabled: Number.isFinite(id),
  });

  const [doc, setDoc] = useState<PageDoc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Load the document's content into local editable state once per document.
  useEffect(() => {
    if (data?.contentJson && doc === null) {
      setDoc(data.contentJson);
    }
  }, [data, doc]);

  // One-time do-not-say banner handed over from the create flow.
  useEffect(() => {
    if (!Number.isFinite(id)) return;
    try {
      const raw = localStorage.getItem(warningsKey(id));
      if (raw) {
        const w = JSON.parse(raw);
        if (Array.isArray(w) && w.length) setWarnings(w);
        localStorage.removeItem(warningsKey(id));
      }
    } catch {
      /* ignore */
    }
  }, [id]);

  const groups = useMemo(() => (doc ? docFieldGroups(doc) : []), [doc]);
  const brandId = data?.brandId ?? "nexus-dark";
  const sourceTag = data?.sourceTag ?? data?.slug ?? data?.token ?? "studio";
  const shareUrl = data ? `${window.location.origin}/p/${data.token}` : "";
  const savedBrief = (() => {
    try { return Number.isFinite(id) ? localStorage.getItem(briefKey(id)) : null; } catch { return null; }
  })();

  const updateField = (path: FieldPath, value: string) => {
    setDoc((prev) => (prev ? setAtPath(prev, path, value) : prev));
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/admin/studio/${id}`, { contentJson: doc });
      return res.json();
    },
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/studio", String(id)] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/studio"] });
      toast({ title: "Saved", description: "Your changes are saved and snapshotted." });
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: friendlyErr(e), variant: "destructive" }),
  });

  const publish = useMutation({
    mutationFn: async () => {
      if (dirty) {
        await apiRequest("PATCH", `/api/admin/studio/${id}`, { contentJson: doc });
        setDirty(false);
      }
      const res = await apiRequest("POST", `/api/admin/studio/${id}/publish`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/studio", String(id)] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/studio"] });
      toast({ title: "Published", description: "Your proposal is live. Copy the link and send it." });
    },
    onError: (e: any) => toast({ title: "Couldn't publish", description: friendlyErr(e), variant: "destructive" }),
  });

  const regenerate = useMutation({
    mutationFn: async () => {
      if (!savedBrief) throw new Error("no-brief");
      const res = await apiRequest("POST", "/api/admin/studio/generate", { brief: savedBrief });
      const gen: GenerateResponse = await res.json();
      return gen;
    },
    onSuccess: (gen) => {
      setDoc(gen.content);
      setDirty(true);
      if (gen.warnings?.length) setWarnings(gen.warnings);
      toast({ title: "Rewritten", description: "Fresh draft — review it, then Save." });
    },
    onError: (e: any) =>
      toast({ title: "Couldn't rewrite", description: e?.message === "no-brief" ? "The original brief isn't available for this page." : friendlyErr(e), variant: "destructive" }),
  });

  const copyLink = () => {
    navigator.clipboard.writeText(shareUrl);
    toast({ title: "Link copied" });
  };

  const onRegenerate = () => {
    if (!savedBrief) return;
    if (window.confirm("Rewrite the whole page from your original brief? This replaces the current text (you can still Save or discard after reviewing).")) {
      regenerate.mutate();
    }
  };

  if (isLoading || (!doc && !isError)) {
    return <div className="p-10 text-center text-white/30">Loading…</div>;
  }
  if (isError || !data || !doc) {
    return (
      <div className="p-10 text-center">
        <p className="text-white/50">This proposal couldn't be found.</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/admin/studio")}>Back to Studio</Button>
      </div>
    );
  }

  const published = data.status === "published";

  return (
    <div className="lg:h-[calc(100vh-3.5rem)] lg:flex lg:flex-col">
      {/* Toolbar */}
      <div className="shrink-0 border-b border-white/5 bg-white/[0.02] px-4 py-3 flex items-center gap-3 flex-wrap">
        <button onClick={() => navigate("/admin/studio")} className="text-white/40 hover:text-white/70 transition-colors" data-testid="button-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-white font-semibold truncate flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="truncate">{data.title}</span>
          </div>
          <div className="text-[11px] text-white/35">
            {brandName(brandId)} · {published ? "Published" : "Draft"}{dirty ? " · unsaved changes" : ""}
          </div>
        </div>

        {/* device toggle */}
        <div className="flex items-center gap-1 p-1 rounded-lg bg-white/[0.03] border border-white/[0.06]">
          {([["desktop", Monitor], ["mobile", Smartphone]] as const).map(([d, Icon]) => (
            <button
              key={d}
              onClick={() => setDevice(d)}
              className={`px-2 py-1 rounded-md transition-all ${device === d ? "bg-amber-400/15 text-amber-300" : "text-white/40 hover:text-white/60"}`}
              title={d === "desktop" ? "Desktop preview" : "Phone preview"}
              data-testid={`button-device-${d}`}
            >
              <Icon className="w-4 h-4" />
            </button>
          ))}
        </div>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={!savedBrief || regenerate.isPending}
          title={savedBrief ? "Rewrite the whole page from your brief" : "The original brief isn't available for this page"}
          onClick={onRegenerate}
          data-testid="button-regenerate"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${regenerate.isPending ? "animate-spin" : ""}`} /> Rewrite page
        </Button>
        <Button
          size="sm"
          variant={dirty ? "default" : "outline"}
          className="gap-1.5"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
          data-testid="button-save"
        >
          <Save className="w-3.5 h-3.5" /> {dirty ? "Save" : "Saved"}
        </Button>
        <Button size="sm" className="gap-1.5" disabled={publish.isPending} onClick={() => publish.mutate()} data-testid="button-publish">
          <Send className="w-3.5 h-3.5" /> {published ? "Re-publish" : "Publish"}
        </Button>
      </div>

      {/* Split body */}
      <div className="grid grid-cols-1 lg:grid-cols-2 lg:flex-1 lg:min-h-0">
        {/* Left — controls */}
        <div className="lg:overflow-y-auto border-r border-white/5 p-4 space-y-4">
          {warnings.length > 0 && (
            <div className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-3">
              <div className="text-xs font-semibold text-amber-300 mb-1">A couple of words to check</div>
              <ul className="text-xs text-white/60 space-y-0.5 list-disc pl-4">
                {warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
              <button onClick={() => setWarnings([])} className="text-[11px] text-white/40 hover:text-white/60 mt-1.5">Dismiss</button>
            </div>
          )}

          {published && (
            <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/5 p-3.5">
              <div className="text-xs font-semibold text-emerald-300 mb-1.5 flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5" /> Your shareable link
              </div>
              <div className="flex items-center gap-2">
                <code className="text-[11px] text-white/70 bg-black/30 rounded px-2 py-1.5 truncate flex-1">{shareUrl}</code>
                <button onClick={copyLink} className="text-white/50 hover:text-white shrink-0" title="Copy"><Copy className="w-4 h-4" /></button>
                <a href={shareUrl} target="_blank" rel="noreferrer" className="text-white/50 hover:text-white shrink-0" title="Open"><ExternalLink className="w-4 h-4" /></a>
              </div>
              <p className="text-[11px] text-white/35 mt-1.5">
                Tracks engagement with <span className="text-white/50">?source={sourceTag}</span>. Works once ClubOS is deployed to its live domain.
              </p>
            </div>
          )}

          <div className="text-[11px] text-white/40 uppercase tracking-wider font-semibold px-1">Edit the words</div>

          {groups.map((g, gi) => (
            <div key={g.blockId} className="rounded-xl border border-white/8 bg-white/[0.02] p-3.5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-white/70">{g.title}</div>
                {/* DEFERRED: per-block regenerate needs a server block-regen
                    endpoint — shown as a roadmap affordance, disabled. */}
                <button
                  disabled
                  title="Coming soon — rewrite just this section"
                  className="text-[10px] text-white/25 flex items-center gap-1 cursor-not-allowed"
                >
                  <Wand2 className="w-3 h-3" /> Rewrite
                </button>
              </div>
              {g.fields.length === 0 ? (
                <p className="text-[11px] text-white/30">Nothing to edit here — this section is set by its images or layout.</p>
              ) : (
                g.fields.map((f) => (
                  <div key={f.path.join(".")}>
                    <label className="text-[11px] text-white/45">{f.label}</label>
                    {f.multiline ? (
                      <Textarea
                        value={f.value}
                        onChange={(e) => updateField(f.path, e.target.value)}
                        rows={f.value.length > 120 ? 4 : 2}
                        className="mt-1 text-sm"
                        data-testid={`field-${gi}-${f.path.join("-")}`}
                      />
                    ) : (
                      <Input
                        value={f.value}
                        onChange={(e) => updateField(f.path, e.target.value)}
                        className="mt-1 text-sm h-9"
                        data-testid={`field-${gi}-${f.path.join("-")}`}
                      />
                    )}
                  </div>
                ))
              )}
            </div>
          ))}

          {/* Version history — v1 shows what the document row provides. A full
              version list + one-click rollback is DEFERRED (no server endpoint
              lists studio_document_versions; we must not add routes here). */}
          <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3.5">
            <button onClick={() => setShowHistory((s) => !s)} className="w-full flex items-center justify-between text-xs font-semibold text-white/70">
              <span className="flex items-center gap-1.5"><History className="w-3.5 h-3.5" /> History</span>
              <span className="text-white/30">{showHistory ? "Hide" : "Show"}</span>
            </button>
            {showHistory && (
              <div className="mt-3 space-y-1.5 text-[11px] text-white/45">
                <div>Last saved: <span className="text-white/70">{fmt(data.updatedAt)}</span></div>
                <div>Published: <span className="text-white/70">{fmt(data.publishedAt)}</span></div>
                <div>Created: <span className="text-white/70">{fmt(data.createdAt)}</span></div>
                <p className="text-white/30 pt-1">
                  Every save and publish is snapshotted automatically. A full version list with one-click rollback is coming.
                </p>
                <Button variant="outline" size="sm" disabled className="mt-1 gap-1.5 cursor-not-allowed">
                  <History className="w-3.5 h-3.5" /> Restore a version (soon)
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Right — live preview */}
        <div className="lg:overflow-y-auto bg-black min-h-[60vh]">
          <div
            className="mx-auto transition-all"
            style={{ width: device === "mobile" ? 400 : "100%", maxWidth: "100%" }}
          >
            <BrandTheme brand={brandId} grain={false} flat>
              <BlockRenderer blocks={doc.blocks} sourceTag={sourceTag} flat />
            </BrandTheme>
          </div>
        </div>
      </div>
    </div>
  );
}

// apiRequest throws `Error("<status>: <body>")` — friendly, non-technical text.
function friendlyErr(e: any): string {
  const msg = String(e?.message || "");
  if (/^429/.test(msg)) return "The writer is busy right now. Wait a few seconds and try again.";
  if (/^503/.test(msg)) return "The writing service isn't switched on yet. Ask Daniel to add the API key.";
  if (/^422/.test(msg)) return "That change made the page invalid. Undo your last edit and try again.";
  if (/^40[13]/.test(msg)) return "You don't have access to do that.";
  return "Something went wrong. Try again in a moment.";
}
