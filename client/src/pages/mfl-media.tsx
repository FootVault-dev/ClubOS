// ─────────────────────────────────────────────────────────────────────────────
// MFL PHOTOS — the "Photos" admin tab, Mini Football Leagues workspace
// (/admin/mfl-media). A simple media library for league-night photos: an
// add-by-URL form (paste a hosted image URL + optional caption/date),
// a thumbnail grid, a publish toggle (draft vs live), and delete. Backed by
// GET/POST/PATCH/DELETE /api/admin/league/media
// {url, caption?, takenAt?, competitionId?, sortOrder?, published?}.
//
// Deliberately kept to a single simple file — this isn't a full DAM, just a
// home for "here are some league-night photos" until something bigger is
// needed. House style + react-query/apiRequest patterns match the other
// admin pages built alongside it (mfl-referees.tsx, mfl-game-feed.tsx).
// ─────────────────────────────────────────────────────────────────────────────
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Images, Eye, EyeOff, Trash2, Plus, ImageOff } from "lucide-react";

interface LeagueMediaItem {
  id: number;
  url: string;
  caption: string | null;
  takenAt: string | null;
  competitionId: number | null;
  sortOrder: number | null;
  published: boolean;
  createdAt: string;
}

function apiErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "Something went wrong");
  const idx = raw.indexOf(": ");
  const body = idx >= 0 ? raw.slice(idx + 2) : raw;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return raw;
}

const inputCls = "w-full rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50";

export default function MflMedia() {
  const { toast } = useToast();
  const queryKey = ["/api/admin/league/media"];
  const { data, isLoading } = useQuery<{ media: LeagueMediaItem[] }>({ queryKey });
  const media = (data?.media ?? []).slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  const [url, setUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [takenAt, setTakenAt] = useState("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const addMut = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/admin/league/media", {
        url: url.trim(),
        caption: caption.trim() || undefined,
        takenAt: takenAt || undefined,
      }),
    onSuccess: () => {
      invalidate();
      setUrl("");
      setCaption("");
      setTakenAt("");
      toast({ title: "Photo added" });
    },
    onError: (e: unknown) => toast({ title: "Couldn't add photo", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, published }: { id: number; published: boolean }) =>
      apiRequest("PATCH", `/api/admin/league/media/${id}`, { published }),
    onSuccess: () => invalidate(),
    onError: (e: unknown) => toast({ title: "Couldn't update photo", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/league/media/${id}`),
    onSuccess: () => {
      invalidate();
      toast({ title: "Photo removed" });
    },
    onError: (e: unknown) => toast({ title: "Couldn't remove photo", description: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto text-white/90">
      <div className="mb-5">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Images className="w-5 h-5 text-blue-400" /> Photos
        </h1>
        <p className="text-[13px] text-white/40 mt-1 max-w-xl">
          League-night photos — paste a hosted image URL to add one, then publish it live or keep it as a draft.
        </p>
      </div>

      <div className="mb-6 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
        <div className="text-[12px] font-semibold text-white/70 mb-3 flex items-center gap-1.5">
          <Plus className="w-3.5 h-3.5" /> Add a photo
        </div>
        <div className="grid gap-2 sm:grid-cols-[2fr_2fr_1fr_auto]">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Image URL"
            className={inputCls}
          />
          <Input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Caption (optional)"
            className={inputCls}
          />
          <DatePickerInput
            value={takenAt}
            onChange={(e) => setTakenAt(e.target.value)}
            className={inputCls}
          />
          <Button
            onClick={() => addMut.mutate()}
            disabled={!url.trim() || addMut.isPending}
            className="h-9 rounded-lg text-[13px] font-semibold border-none bg-blue-500/80 hover:bg-blue-500 text-white"
          >
            Add
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-white/30 text-sm py-16 text-center">Loading…</div>
      ) : !media.length ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
          <ImageOff className="w-8 h-8 text-white/20 mx-auto mb-3" />
          <div className="text-white/50 text-sm">No photos yet — add one above.</div>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {media.map((m) => (
            <div
              key={m.id}
              className="rounded-xl overflow-hidden border border-white/[0.06] bg-white/[0.02] group relative"
              data-testid={`card-media-${m.id}`}
            >
              <div className="aspect-square bg-black/40">
                <img src={m.url} alt={m.caption ?? "League photo"} className="w-full h-full object-cover" loading="lazy" />
              </div>
              <div className="p-2.5 space-y-1.5">
                {m.caption && <div className="text-[12px] text-white/80 truncate">{m.caption}</div>}
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
                    style={
                      m.published
                        ? { background: "rgba(34,197,94,0.15)", color: "#4ade80" }
                        : { background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.4)" }
                    }
                  >
                    {m.published ? "Live" : "Draft"}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => toggleMut.mutate({ id: m.id, published: !m.published })}
                      className="w-7 h-7 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/[0.06] flex items-center justify-center"
                      title={m.published ? "Unpublish" : "Publish"}
                    >
                      {m.published ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      onClick={() => {
                        if (confirm("Remove this photo? This can't be undone.")) deleteMut.mutate(m.id);
                      }}
                      className="w-7 h-7 rounded-lg text-white/30 hover:text-red-400 hover:bg-white/[0.06] flex items-center justify-center"
                      title="Delete photo"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
