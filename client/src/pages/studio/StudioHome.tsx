// USG Studio — home / document list. Route: /admin/studio.
//
// Lists this workspace's proposal pages with a status pill + copy-link for
// published ones, and a prominent "New proposal" button that opens the guided
// create flow (/admin/studio/new). Admin chrome only (dark ClubOS theme) — the
// on-brand studio look lives inside the editor preview + the public page.
import { useMemo } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Sparkles, Plus, Copy, ExternalLink, FileText, Clock, CheckCircle2, ChevronRight,
} from "lucide-react";
import { brandName, type StudioDocRow } from "./studio-shared";

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "text-amber-300 bg-amber-400/10 border-amber-400/25" },
  published: { label: "Published", cls: "text-emerald-300 bg-emerald-400/10 border-emerald-400/25" },
  archived: { label: "Archived", cls: "text-white/40 bg-white/5 border-white/10" },
};

function fmt(ts: string | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-NZ", { dateStyle: "medium", timeStyle: "short" });
}

export default function StudioHome() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { data: docs = [], isLoading } = useQuery<StudioDocRow[]>({ queryKey: ["/api/admin/studio"] });

  const stats = useMemo(() => ({
    total: docs.length,
    published: docs.filter((d) => d.status === "published").length,
    drafts: docs.filter((d) => d.status === "draft").length,
  }), [docs]);

  const copyLink = (token: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/p/${token}`);
    toast({ title: "Link copied", description: "Paste it to your prospect — it opens the live proposal page." });
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <Sparkles className="w-6 h-6 text-amber-400" />
            Studio
          </h1>
          <p className="text-sm text-white/40 mt-1">
            Turn a few notes into a polished, on-brand proposal page — ready to send in minutes.
          </p>
        </div>
        <Button onClick={() => navigate("/admin/studio/new")} className="gap-1.5" data-testid="button-new-proposal">
          <Plus className="w-4 h-4" /> New proposal
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Proposals", value: stats.total, icon: FileText },
          { label: "Published", value: stats.published, icon: CheckCircle2 },
          { label: "Drafts", value: stats.drafts, icon: Clock },
        ].map((s) => (
          <div key={s.label} className="bg-white/[0.03] border border-white/5 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-white/40 text-xs mb-1.5"><s.icon className="w-3.5 h-3.5" /> {s.label}</div>
            <div className="text-2xl font-bold text-white">{s.value}</div>
          </div>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center text-white/30 py-16">Loading…</div>
      ) : docs.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-white/10 rounded-2xl">
          <div className="w-12 h-12 rounded-2xl bg-amber-400/10 text-amber-400 flex items-center justify-center mx-auto mb-3">
            <Sparkles className="w-6 h-6" />
          </div>
          <div className="text-white/70 font-medium">Make your first proposal page</div>
          <p className="text-white/40 text-sm mt-1 max-w-sm mx-auto">
            Pick a brand, answer five short questions, and Studio writes and designs the page for you.
          </p>
          <Button onClick={() => navigate("/admin/studio/new")} className="gap-1.5 mt-5" data-testid="button-new-proposal-empty">
            <Plus className="w-4 h-4" /> New proposal
          </Button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {docs.map((d) => {
            const st = STATUS[d.status] ?? STATUS.draft;
            return (
              <div
                key={d.id}
                className="w-full bg-white/[0.03] border border-white/5 rounded-2xl p-4 hover:bg-white/[0.05] transition-colors flex items-center gap-4"
              >
                <Link
                  href={`/admin/studio/${d.id}`}
                  className="flex items-center gap-4 min-w-0 flex-1"
                  data-testid={`link-studio-doc-${d.id}`}
                >
                  <div className="w-10 h-10 rounded-xl bg-amber-400/10 text-amber-400 flex items-center justify-center shrink-0">
                    <FileText className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-white font-medium truncate">{d.title}</div>
                    <div className="text-white/40 text-xs mt-0.5 truncate">
                      {brandName(d.brandId)} · updated {fmt(d.updatedAt)}
                    </div>
                  </div>
                </Link>
                <span className={`text-[11px] font-medium px-2.5 py-1 rounded-full border shrink-0 ${st.cls}`}>{st.label}</span>
                {d.status === "published" && (
                  <>
                    <button
                      onClick={() => copyLink(d.token)}
                      title="Copy shareable link"
                      className="text-white/30 hover:text-white/70 transition-colors shrink-0"
                      data-testid={`button-copy-link-${d.id}`}
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                    <a
                      href={`/p/${d.token}`}
                      target="_blank"
                      rel="noreferrer"
                      title="Open live page"
                      className="text-white/30 hover:text-white/70 transition-colors shrink-0"
                      data-testid={`link-open-${d.id}`}
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </>
                )}
                <Link href={`/admin/studio/${d.id}`} className="text-white/20 shrink-0">
                  <ChevronRight className="w-4 h-4" />
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
