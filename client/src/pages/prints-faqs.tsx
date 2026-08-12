// FAQs — the questions on unitedprints.co.nz and in its live-chat widget.
//
// Both lists used to be hardcoded in the website's source, in two different
// files, so answering a new question meant a code edit and a deploy. Dima edits
// them here; the site picks them up within a minute.
//
// The two surfaces are separate switches because they want different lengths:
// the website answers run long, the chat answers have to be short enough to read
// in a little panel.

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient, workspaceFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, X, Trash2, Globe, MessageCircle, ExternalLink, ChevronUp, ChevronDown, EyeOff,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type Faq = {
  id: number;
  question: string;
  answer: string;
  showOnWebsite: boolean;
  showInChat: boolean;
  isActive: boolean;
  displayOrder: number;
};

function EditModal({ faq, isNew, onClose }: { faq: Faq | null; isNew: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [f, setF] = useState({
    question: faq?.question ?? "",
    answer: faq?.answer ?? "",
    showOnWebsite: faq?.showOnWebsite ?? true,
    showInChat: faq?.showInChat ?? true,
    isActive: faq?.isActive ?? true,
  });

  const save = useMutation({
    mutationFn: async () => {
      const res = isNew
        ? await apiRequest("POST", "/api/admin/faqs", f)
        : await apiRequest("PATCH", `/api/admin/faqs/${faq!.id}`, f);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/faqs"] });
      toast({
        title: isNew ? "Question added" : "Saved",
        description: (f.showOnWebsite || f.showInChat) && f.isActive
          ? "It'll be live on the site within a minute."
          : "Hidden for now — nobody will see it.",
      });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const nowhere = f.isActive && !f.showOnWebsite && !f.showInChat;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl rounded-2xl border border-white/10 bg-[#02060E] p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">{isNew ? "Add a question" : "Edit question"}</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">The question, as a customer would ask it</label>
            <Input value={f.question} onChange={e => setF({ ...f, question: e.target.value })}
              placeholder="e.g. How wide can you print?" className="bg-white/[0.02] border-white/10 text-white" />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">The answer</label>
            <textarea value={f.answer} onChange={e => setF({ ...f, answer: e.target.value })}
              placeholder="Plain English. Say the useful thing first."
              className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm min-h-[140px]" />
            <div className="flex items-center justify-between mt-1">
              <span className="text-[10px] text-white/30">Plain text — no formatting or links.</span>
              <span className={`text-[10px] ${f.answer.length > 400 && f.showInChat ? "text-amber-300" : "text-white/30"}`}>
                {f.answer.length} characters
              </span>
            </div>
            {f.answer.length > 400 && f.showInChat && (
              <div className="mt-1 text-[11px] text-amber-300/90">
                That's long for the chat panel — it reads fine on the website, but consider a shorter version for chat.
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
            <label className={`flex items-start gap-2.5 rounded-xl border p-3 cursor-pointer transition ${
              f.showOnWebsite ? "border-blue-500/40 bg-blue-500/[0.07]" : "border-white/10 bg-white/[0.02]"}`}>
              <input type="checkbox" checked={f.showOnWebsite} onChange={e => setF({ ...f, showOnWebsite: e.target.checked })} className="mt-0.5" />
              <span>
                <span className="flex items-center gap-1.5 text-sm font-semibold text-white">
                  <Globe className="w-3.5 h-3.5 text-blue-300" /> On the website
                </span>
                <span className="block text-[11px] text-white/50 mt-0.5">The FAQ section on the home and contact pages.</span>
              </span>
            </label>
            <label className={`flex items-start gap-2.5 rounded-xl border p-3 cursor-pointer transition ${
              f.showInChat ? "border-blue-500/40 bg-blue-500/[0.07]" : "border-white/10 bg-white/[0.02]"}`}>
              <input type="checkbox" checked={f.showInChat} onChange={e => setF({ ...f, showInChat: e.target.checked })} className="mt-0.5" />
              <span>
                <span className="flex items-center gap-1.5 text-sm font-semibold text-white">
                  <MessageCircle className="w-3.5 h-3.5 text-blue-300" /> In the chat widget
                </span>
                <span className="block text-[11px] text-white/50 mt-0.5">Searchable inside the chat bubble, before they message you.</span>
              </span>
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm text-white/70 pt-1">
            <input type="checkbox" checked={f.isActive} onChange={e => setF({ ...f, isActive: e.target.checked })} />
            Live
            <span className="text-[11px] text-white/35">— untick to hide it everywhere without deleting it</span>
          </label>

          {nowhere && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-[11px] text-amber-200">
              This is live but not shown on either surface, so nobody will ever see it. Tick the website, chat, or both.
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !f.question.trim() || !f.answer.trim()}
            className="bg-blue-600 hover:bg-blue-700">
            {save.isPending ? "Saving..." : isNew ? "Add question" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function PrintsFaqs() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const { toast } = useToast();
  const [editing, setEditing] = useState<Faq | null>(null);
  const [creating, setCreating] = useState(false);

  const { data, isLoading, error } = useQuery<{ faqs: Faq[]; siteUrl: string | null }>({
    queryKey: ["/api/admin/faqs", { orgId }],
    queryFn: async () => {
      const res = await workspaceFetch("/api/admin/faqs");
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        throw new Error(b?.message || `Couldn't load FAQs (HTTP ${res.status})`);
      }
      return res.json();
    },
    enabled: !!orgId,
  });

  const faqs = data?.faqs ?? [];

  const reorder = useMutation({
    mutationFn: async (ids: number[]) => (await apiRequest("PATCH", "/api/admin/faqs/reorder", { ids })).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/faqs"] }),
    onError: (e: Error) => toast({ title: "Couldn't reorder", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: number) => { await apiRequest("DELETE", `/api/admin/faqs/${id}`); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/faqs"] }); toast({ title: "Deleted" }); },
    onError: (e: Error) => toast({ title: "Couldn't delete", description: e.message, variant: "destructive" }),
  });

  // Up/down rather than drag: it's a short list, and arrows work on a tablet.
  const move = (idx: number, dir: -1 | 1) => {
    const next = [...faqs];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    reorder.mutate(next.map(f => f.id));
  };

  const onWeb = faqs.filter(f => f.isActive && f.showOnWebsite).length;
  const onChat = faqs.filter(f => f.isActive && f.showInChat).length;

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">FAQs</h1>
          <p className="text-sm text-white/40 mt-0.5">The questions customers see on the website and in the chat bubble.</p>
        </div>
        <Button onClick={() => setCreating(true)} className="bg-blue-600 hover:bg-blue-700 shrink-0">
          <Plus className="w-4 h-4 mr-1.5" /> Add question
        </Button>
      </div>

      <div className="rounded-xl border border-blue-500/25 bg-blue-500/[0.06] p-3.5 flex items-start gap-3">
        <Globe className="w-4 h-4 text-blue-300 mt-0.5 shrink-0" />
        <div className="text-sm text-white/70 min-w-0">
          <span className="text-white font-semibold">{onWeb} on the website · {onChat} in the chat widget.</span>{" "}
          Edit an answer here and it changes on unitedprints.co.nz within a minute — no deploy, no developer.
          {data?.siteUrl && (
            <a href={`${data.siteUrl}/#faq`} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 ml-1.5 text-blue-300 hover:text-blue-200 underline decoration-blue-300/40">
              See the page <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/[0.06] p-4">
          <div className="text-sm font-semibold text-white">FAQs didn't load</div>
          <div className="mt-1 text-sm text-white/60">{(error as Error).message}</div>
          <Button onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/admin/faqs"] })}
            className="mt-3 bg-blue-600 hover:bg-blue-700">Try again</Button>
        </div>
      ) : isLoading ? (
        <div className="text-white/40 text-sm">Loading...</div>
      ) : faqs.length === 0 ? (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-8 text-center">
          <MessageCircle className="w-8 h-8 text-white/20 mx-auto" />
          <div className="mt-3 text-sm text-white/60">No questions yet.</div>
        </div>
      ) : (
        <div className="space-y-2">
          {faqs.map((f, i) => (
            <div key={f.id}
              className={`rounded-xl border p-4 ${f.isActive ? "border-white/5 bg-white/[0.02]" : "border-white/5 bg-white/[0.01] opacity-60"}`}>
              <div className="flex items-start gap-3">
                <div className="flex flex-col gap-0.5 pt-0.5 shrink-0">
                  <button onClick={() => move(i, -1)} disabled={i === 0 || reorder.isPending}
                    className="text-white/25 hover:text-white disabled:opacity-20" aria-label="Move up">
                    <ChevronUp className="w-4 h-4" />
                  </button>
                  <button onClick={() => move(i, 1)} disabled={i === faqs.length - 1 || reorder.isPending}
                    className="text-white/25 hover:text-white disabled:opacity-20" aria-label="Move down">
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </div>

                <button onClick={() => setEditing(f)} className="min-w-0 flex-1 text-left">
                  <div className="font-semibold text-white text-sm">{f.question}</div>
                  <p className="text-xs text-white/55 mt-1 line-clamp-2">{f.answer}</p>
                  <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                    {f.isActive && f.showOnWebsite && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-200 inline-flex items-center gap-1">
                        <Globe className="w-2.5 h-2.5" /> Website
                      </span>
                    )}
                    {f.isActive && f.showInChat && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-200 inline-flex items-center gap-1">
                        <MessageCircle className="w-2.5 h-2.5" /> Chat
                      </span>
                    )}
                    {!f.isActive && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-500/20 text-zinc-400 inline-flex items-center gap-1">
                        <EyeOff className="w-2.5 h-2.5" /> Hidden
                      </span>
                    )}
                    {f.isActive && !f.showOnWebsite && !f.showInChat && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200">Shown nowhere</span>
                    )}
                  </div>
                </button>

                <button onClick={() => { if (confirm(`Delete "${f.question}"?`)) remove.mutate(f.id); }}
                  className="text-white/25 hover:text-red-400 shrink-0" aria-label="Delete">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(editing || creating) && (
        <EditModal faq={editing} isNew={creating} onClose={() => { setEditing(null); setCreating(false); }}
          key={creating ? "new" : editing?.id} />
      )}
    </div>
  );
}
