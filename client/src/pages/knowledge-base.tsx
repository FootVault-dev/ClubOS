// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Base — the club's vault, and Rambo.
//
// Universal tab (every workspace). Brand is a FILTER here, not a workspace:
// "how United Prints sizes a banner" is the same fact whichever workspace you
// happen to be standing in when you need it.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  BookOpen, Bot, Check, ChevronRight, Eye, FileText, Lock, Plus, Search,
  Send, Shield, Sparkles, Tag, Trash2, Pencil, ShieldCheck, X, History, Loader2,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────
interface Brand { key: string; label: string; short: string; orgSlug?: string }
interface ArticleRow {
  id: number; brand: string; category: string | null; title: string;
  summary: string | null; status: string; keywords: string[];
  requiredTab: string | null; requiredWorkspace: string | null;
  viewCount: number; verifiedAt: string | null; updatedAt: string;
  ownerName: string | null;
}
interface FullArticle extends ArticleRow { body: string }
interface ChatMessage {
  id: number; role: string; content: string;
  toolsUsed: string[]; sources: { id: number; title: string; brand: string }[];
  createdAt: string;
}
interface Bootstrap {
  viewer: { userId: number; name: string; isManager: boolean; isSuperAdmin: boolean };
  brands: Brand[];
  statuses: string[];
  categorySuggestions: string[];
  rambo: {
    enabled: boolean;
    canSee: { name: string; title: string }[];
    cannotSee: { name: string; title: string; requiredTab: string | null }[];
  };
}

const ALL_BRAND: Brand = { key: "all", label: "All brands", short: "All" };

// A deliberately small markdown renderer — headings, bullets, bold, code and
// paragraphs. Never dangerouslySetInnerHTML: article bodies are written by
// staff, and a wiki that renders raw HTML is a stored-XSS hole with a nice UI.
function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => text.replace(/\r\n/g, "\n").split("\n"), [text]);
  const inline = (s: string, key: number) => {
    const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
    return (
      <span key={key}>
        {parts.map((p, i) =>
          p.startsWith("**") && p.endsWith("**") ? (
            <strong key={i} className="text-white/95 font-semibold">{p.slice(2, -2)}</strong>
          ) : p.startsWith("`") && p.endsWith("`") ? (
            <code key={i} className="rounded bg-white/10 px-1.5 py-0.5 text-[12px] font-mono text-amber-200">{p.slice(1, -1)}</code>
          ) : (
            <span key={i}>{p}</span>
          ),
        )}
      </span>
    );
  };
  return (
    <div className="space-y-2 text-[14px] leading-relaxed text-white/70">
      {blocks.map((line, i) => {
        const t = line.trim();
        if (!t) return <div key={i} className="h-1" />;
        if (t.startsWith("### ")) return <h4 key={i} className="text-white/90 font-semibold text-[14px] pt-2">{t.slice(4)}</h4>;
        if (t.startsWith("## ")) return <h3 key={i} className="text-white/95 font-semibold text-[15px] pt-3">{t.slice(3)}</h3>;
        if (t.startsWith("# ")) return <h2 key={i} className="text-white font-semibold text-[17px] pt-3">{t.slice(2)}</h2>;
        if (/^[-*]\s+/.test(t)) return <div key={i} className="flex gap-2 pl-1"><span className="text-white/25 select-none">•</span><div>{inline(t.replace(/^[-*]\s+/, ""), i)}</div></div>;
        if (/^\d+\.\s+/.test(t)) return <div key={i} className="flex gap-2 pl-1"><span className="text-white/35 select-none tabular-nums">{t.match(/^\d+/)![0]}.</span><div>{inline(t.replace(/^\d+\.\s+/, ""), i)}</div></div>;
        return <p key={i}>{inline(t, i)}</p>;
      })}
    </div>
  );
}

export default function KnowledgeBase() {
  const { toast } = useToast();
  const [brand, setBrand] = useState("all");
  const [view, setView] = useState<"browse" | "rambo">("browse");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Partial<FullArticle> | null>(null);
  const [showScopes, setShowScopes] = useState(false);

  const { data: boot } = useQuery<Bootstrap>({ queryKey: ["/api/admin/kb/bootstrap"] });
  const brands = useMemo(() => [ALL_BRAND, ...(boot?.brands ?? [])], [boot]);

  const listKey = ["/api/admin/kb/articles", brand, search, category] as const;
  const { data: list, isLoading } = useQuery<{ articles: ArticleRow[] }>({
    queryKey: listKey,
    queryFn: async () => {
      const p = new URLSearchParams({ brand, includeDrafts: "1" });
      if (search.trim()) p.set("q", search.trim());
      if (category) p.set("category", category);
      const r = await fetch(`/api/admin/kb/articles?${p}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load");
      return r.json();
    },
  });

  const articles = list?.articles ?? [];
  const categories = useMemo(
    () => Array.from(new Set(articles.map((a) => a.category).filter(Boolean) as string[])).sort(),
    [articles],
  );

  const saveArticle = useMutation({
    mutationFn: async (a: Partial<FullArticle>) => {
      const body = {
        title: a.title, summary: a.summary, body: a.body, brand: a.brand,
        category: a.category, keywords: a.keywords, status: a.status,
      };
      if (a.id) return apiRequest("PATCH", `/api/admin/kb/articles/${a.id}`, body);
      return apiRequest("POST", "/api/admin/kb/articles", body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/kb/articles"] });
      setEditing(null);
      toast({ title: "Saved" });
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  const removeArticle = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/admin/kb/articles/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/kb/articles"] });
      setOpenId(null);
      toast({ title: "Deleted" });
    },
  });

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-amber-400" /> Knowledge Base
          </h1>
          <p className="text-[13px] text-white/40 mt-1 max-w-2xl">
            How the club does things — written down once, so nobody has to be interrupted for the answer.
          </p>
        </div>
        <button
          onClick={() => setEditing({ brand: brand === "all" ? "all" : brand, status: "published", keywords: [] })}
          data-testid="button-new-article"
          className="inline-flex items-center gap-2 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-300 px-4 py-2 text-sm font-medium hover:bg-amber-500/25 transition-colors"
        >
          <Plus className="w-4 h-4" /> Add an article
        </button>
      </div>

      {/* Brand switcher */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {brands.map((b) => (
          <button
            key={b.key}
            onClick={() => setBrand(b.key)}
            data-testid={`brand-${b.key}`}
            className={`rounded-lg px-3 py-1.5 text-[12px] font-medium border transition-colors ${
              brand === b.key
                ? "bg-amber-500/15 border-amber-500/40 text-amber-200"
                : "bg-white/[0.02] border-white/[0.06] text-white/40 hover:text-white/70"
            }`}
          >
            {b.short}
          </button>
        ))}
      </div>

      {/* View switch */}
      <div className="flex items-center gap-1 mb-4 rounded-xl bg-white/[0.03] border border-white/[0.06] p-1 w-fit">
        {([["browse", "Browse", FileText], ["rambo", "Ask Rambo", Bot]] as const).map(([k, label, Icon]) => (
          <button
            key={k}
            onClick={() => setView(k)}
            data-testid={`view-${k}`}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
              view === k ? "bg-white/[0.09] text-white/90" : "text-white/40 hover:text-white/70"
            }`}
          >
            <Icon className="w-3.5 h-3.5" /> {label}
          </button>
        ))}
      </div>

      {view === "browse" ? (
        <>
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {categories.length > 0 && (
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => setCategory(null)}
                  className={`rounded-lg px-3 py-1.5 text-[12px] font-medium border transition-colors ${
                    !category ? "bg-white/[0.08] border-white/20 text-white/90" : "bg-white/[0.02] border-white/[0.06] text-white/40 hover:text-white/70"
                  }`}
                >
                  All topics
                </button>
                {categories.map((c) => (
                  <button
                    key={c}
                    onClick={() => setCategory(category === c ? null : c)}
                    className={`rounded-lg px-3 py-1.5 text-[12px] font-medium border transition-colors ${
                      category === c ? "bg-white/[0.08] border-white/20 text-white/90" : "bg-white/[0.02] border-white/[0.06] text-white/40 hover:text-white/70"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
            <div className="relative ml-auto">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search the vault…"
                data-testid="input-kb-search"
                className="rounded-lg bg-white/[0.03] border border-white/10 pl-8 pr-3 py-1.5 text-[13px] text-white/90 placeholder:text-white/25 focus:outline-none focus:border-amber-500/50 w-full sm:w-56"
              />
            </div>
          </div>

          {isLoading ? (
            <div className="text-white/30 text-sm py-16 text-center">Loading…</div>
          ) : articles.length === 0 ? (
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 px-6 text-center">
              <BookOpen className="w-8 h-8 text-white/20 mx-auto mb-3" />
              <div className="text-white/50 text-sm">
                {search ? "Nothing matches that." : "Nothing written down here yet."}
              </div>
              <button
                onClick={() => setEditing({ brand: brand === "all" ? "all" : brand, status: "published", keywords: [] })}
                className="text-amber-400 text-[13px] mt-2 hover:underline"
              >
                Write the first article →
              </button>
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {articles.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setOpenId(a.id)}
                  data-testid={`article-${a.id}`}
                  className="text-left rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 hover:bg-white/[0.04] hover:border-white/[0.12] transition-colors group"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5 mb-1">
                        <span className="text-[10px] uppercase tracking-wide text-amber-300/70 font-medium">
                          {brands.find((b) => b.key === a.brand)?.short ?? a.brand}
                        </span>
                        {a.category && (
                          <span className="text-[10px] text-white/30 inline-flex items-center gap-1">
                            <Tag className="w-2.5 h-2.5" /> {a.category}
                          </span>
                        )}
                        {a.status === "draft" && (
                          <span className="text-[10px] rounded px-1.5 py-0.5 bg-white/[0.06] text-white/40">Draft</span>
                        )}
                        {a.requiredTab && (
                          <span className="text-[10px] rounded px-1.5 py-0.5 bg-rose-500/15 text-rose-300 inline-flex items-center gap-1">
                            <Lock className="w-2.5 h-2.5" /> {a.requiredTab}
                          </span>
                        )}
                      </div>
                      <div className="text-[14px] font-medium text-white/90 truncate">{a.title}</div>
                      {a.summary && <div className="text-[12.5px] text-white/45 mt-1 line-clamp-2">{a.summary}</div>}
                    </div>
                    <ChevronRight className="w-4 h-4 text-white/20 group-hover:text-white/50 shrink-0 mt-0.5" />
                  </div>
                  <div className="flex items-center gap-3 mt-3 text-[11px] text-white/25">
                    {a.verifiedAt && (
                      <span className="inline-flex items-center gap-1 text-emerald-400/60">
                        <ShieldCheck className="w-3 h-3" /> Verified {new Date(a.verifiedAt).toLocaleDateString("en-NZ")}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1"><Eye className="w-3 h-3" /> {a.viewCount}</span>
                    {a.ownerName && <span className="truncate">Kept by {a.ownerName}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <RamboPanel brand={brand} boot={boot} showScopes={showScopes} setShowScopes={setShowScopes} onOpenArticle={setOpenId} />
      )}

      {/* Article reader */}
      <ArticleDialog
        id={openId}
        onClose={() => setOpenId(null)}
        onEdit={(a) => { setOpenId(null); setEditing(a); }}
        onDelete={(id) => removeArticle.mutate(id)}
        canManage={boot?.viewer.isManager ?? false}
        brands={brands}
      />

      {/* Editor */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl bg-[#0d1117] border-white/10 max-h-[90vh] overflow-y-auto">
          {editing && (
            <ArticleEditor
              draft={editing}
              brands={boot?.brands ?? []}
              categorySuggestions={boot?.categorySuggestions ?? []}
              saving={saveArticle.isPending}
              onChange={setEditing}
              onSave={() => saveArticle.mutate(editing)}
              onCancel={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Rambo ────────────────────────────────────────────────────────────────────
function RamboPanel({
  brand, boot, showScopes, setShowScopes, onOpenArticle,
}: {
  brand: string;
  boot?: Bootstrap;
  showScopes: boolean;
  setShowScopes: (v: boolean) => void;
  onOpenArticle: (id: number) => void;
}) {
  const { toast } = useToast();
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery<{ messages: ChatMessage[] }>({
    queryKey: ["/api/admin/kb/sessions", sessionId],
    queryFn: async () => {
      if (!sessionId) return { messages: [] };
      const r = await fetch(`/api/admin/kb/sessions/${sessionId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: sessionId != null,
  });
  const messages = data?.messages ?? [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending]);

  const ask = useMutation({
    mutationFn: async (question: string) => {
      const r = await apiRequest("POST", "/api/admin/kb/ask", { question, brand, sessionId });
      return r.json();
    },
    onSuccess: (res: any) => {
      setSessionId(res.sessionId);
      setPending(null);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/kb/sessions", res.sessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/kb/sessions"] });
    },
    onError: (e: any) => {
      setPending(null);
      toast({ title: "Rambo couldn't answer", description: e.message, variant: "destructive" });
    },
  });

  const send = () => {
    const q = input.trim();
    if (!q || ask.isPending) return;
    setInput("");
    setPending(q);
    ask.mutate(q);
  };

  const suggestions = [
    "What size can we print a banner up to?",
    "What file format does Dima need for artwork?",
    "How much bleed on a pull-up banner?",
    "What's the turnaround on corflute?",
  ];

  if (!boot?.rambo.enabled) {
    return (
      <div className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-6 text-center">
        <Bot className="w-8 h-8 text-amber-400/50 mx-auto mb-3" />
        <div className="text-white/70 text-sm font-medium">Rambo isn't switched on yet</div>
        <div className="text-white/40 text-[13px] mt-1">
          The server needs an <code className="text-amber-200/80">ANTHROPIC_API_KEY</code>. Browsing and searching articles works regardless.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden flex flex-col" style={{ minHeight: "60vh" }}>
      {/* Rambo header + the honest boundary */}
      <div className="border-b border-white/[0.06] px-4 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/30 grid place-items-center">
            <Bot className="w-4 h-4 text-amber-300" />
          </div>
          <div>
            <div className="text-[13px] font-medium text-white/90">Rambo</div>
            <div className="text-[11px] text-white/35">
              Reads the knowledge base{boot.rambo.canSee.length > 1 ? " and the live numbers you can already see" : ""}
            </div>
          </div>
        </div>
        <button
          onClick={() => setShowScopes(!showScopes)}
          data-testid="button-rambo-scopes"
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-white/45 hover:text-white/80 transition-colors"
        >
          <Shield className="w-3 h-3" /> What can Rambo see?
        </button>
      </div>

      {showScopes && (
        <div className="border-b border-white/[0.06] bg-white/[0.015] px-4 py-3 text-[12px] space-y-2">
          <p className="text-white/45">
            Rambo can only tell you what you could already find yourself in ClubOS. Your access decides this — asking a
            different way won't change it.
          </p>
          <div>
            <div className="text-emerald-400/80 font-medium mb-1">Available to you</div>
            <div className="flex flex-wrap gap-1">
              {boot.rambo.canSee.map((t) => (
                <span key={t.name} className="rounded px-2 py-0.5 bg-emerald-500/10 text-emerald-300/80 text-[11px]">{t.title}</span>
              ))}
            </div>
          </div>
          {boot.rambo.cannotSee.length > 0 && (
            <div>
              <div className="text-white/35 font-medium mb-1">Not available to you</div>
              <div className="flex flex-wrap gap-1">
                {boot.rambo.cannotSee.map((t) => (
                  <span key={t.name} className="rounded px-2 py-0.5 bg-white/[0.04] text-white/30 text-[11px] inline-flex items-center gap-1">
                    <Lock className="w-2.5 h-2.5" /> {t.title}
                  </span>
                ))}
              </div>
              <div className="text-white/25 mt-1.5 text-[11px]">Ask Daniel if you need one of these opened up.</div>
            </div>
          )}
        </div>
      )}

      {/* Conversation */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && !pending && (
          <div className="py-8 text-center">
            <Sparkles className="w-7 h-7 text-amber-400/40 mx-auto mb-3" />
            <div className="text-white/50 text-[13px] mb-4">Ask anything about how the club works.</div>
            <div className="flex flex-wrap gap-1.5 justify-center max-w-lg mx-auto">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => { setInput(s); }}
                  className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-[12px] text-white/50 hover:text-white/80 hover:border-white/20 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
            {m.role === "user" ? (
              <div className="rounded-2xl rounded-br-md bg-amber-500/15 border border-amber-500/20 px-3.5 py-2 text-[13.5px] text-white/90 max-w-[85%]">
                {m.content}
              </div>
            ) : (
              <div className="max-w-[92%]">
                <Markdown text={m.content} />
                {m.sources?.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {m.sources.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => onOpenArticle(s.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[11px] text-white/45 hover:text-white/80 hover:border-white/20 transition-colors"
                      >
                        <FileText className="w-2.5 h-2.5" /> {s.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {pending && (
          <>
            <div className="flex justify-end">
              <div className="rounded-2xl rounded-br-md bg-amber-500/15 border border-amber-500/20 px-3.5 py-2 text-[13.5px] text-white/90 max-w-[85%]">
                {pending}
              </div>
            </div>
            <div className="flex items-center gap-2 text-white/35 text-[13px]">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Rambo is looking it up…
            </div>
          </>
        )}
        <div ref={endRef} />
      </div>

      {/* Composer */}
      <div className="border-t border-white/[0.06] p-3 flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          rows={1}
          placeholder="Ask Rambo…"
          data-testid="input-rambo"
          className="flex-1 resize-none rounded-xl bg-white/[0.03] border border-white/10 px-3 py-2.5 text-[14px] text-white/90 placeholder:text-white/25 focus:outline-none focus:border-amber-500/50 max-h-32"
          style={{ minHeight: 42 }}
        />
        <button
          onClick={send}
          disabled={!input.trim() || ask.isPending}
          data-testid="button-rambo-send"
          className="rounded-xl bg-amber-500/20 border border-amber-500/30 text-amber-200 w-[42px] h-[42px] grid place-items-center disabled:opacity-30 hover:bg-amber-500/30 transition-colors shrink-0"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ── Article reader ───────────────────────────────────────────────────────────
function ArticleDialog({
  id, onClose, onEdit, onDelete, canManage, brands,
}: {
  id: number | null;
  onClose: () => void;
  onEdit: (a: FullArticle) => void;
  onDelete: (id: number) => void;
  canManage: boolean;
  brands: Brand[];
}) {
  const { toast } = useToast();
  const { data } = useQuery<{ article: FullArticle; revisions: any[] }>({
    queryKey: ["/api/admin/kb/articles", id],
    queryFn: async () => {
      const r = await fetch(`/api/admin/kb/articles/${id}`, { credentials: "include" });
      if (!r.ok) throw new Error("Not found");
      return r.json();
    },
    enabled: id != null,
  });

  const verify = useMutation({
    mutationFn: async () => apiRequest("PATCH", `/api/admin/kb/articles/${id}`, { verified: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/kb/articles"] });
      toast({ title: "Marked as still accurate" });
    },
  });

  const a = data?.article;
  return (
    <Dialog open={id != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-[#0d1117] border-white/10 max-h-[90vh] overflow-y-auto">
        {!a ? (
          <div className="py-12 text-center text-white/30 text-sm">Loading…</div>
        ) : (
          <div>
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              <span className="text-[10px] uppercase tracking-wide text-amber-300/70 font-medium">
                {brands.find((b) => b.key === a.brand)?.short ?? a.brand}
              </span>
              {a.category && <span className="text-[10px] text-white/30">· {a.category}</span>}
              {a.requiredTab && (
                <span className="text-[10px] rounded px-1.5 py-0.5 bg-rose-500/15 text-rose-300 inline-flex items-center gap-1">
                  <Lock className="w-2.5 h-2.5" /> Restricted to {a.requiredTab}
                </span>
              )}
            </div>
            <h2 className="text-lg font-semibold text-white/95 mb-1 pr-8">{a.title}</h2>
            {a.summary && <p className="text-[13px] text-white/45 mb-4">{a.summary}</p>}

            <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-4 mb-4">
              <Markdown text={a.body || "_Nothing written yet._"} />
            </div>

            {a.keywords?.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-4">
                {a.keywords.map((k) => (
                  <span key={k} className="text-[11px] rounded px-2 py-0.5 bg-white/[0.04] text-white/35">{k}</span>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 text-[11px] text-white/25 mb-4">
              <span>Updated {new Date(a.updatedAt).toLocaleDateString("en-NZ")}</span>
              {a.ownerName && <span>· kept by {a.ownerName}</span>}
              {a.verifiedAt ? (
                <span className="text-emerald-400/60 inline-flex items-center gap-1">
                  · <ShieldCheck className="w-3 h-3" /> facts confirmed {new Date(a.verifiedAt).toLocaleDateString("en-NZ")}
                </span>
              ) : (
                <span className="text-amber-400/50">· nobody has confirmed these facts yet</span>
              )}
              {data.revisions.length > 0 && (
                <span className="inline-flex items-center gap-1">· <History className="w-3 h-3" /> {data.revisions.length} edits</span>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => onEdit(a)}
                data-testid="button-edit-article"
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-[12px] text-white/60 hover:text-white/90 transition-colors"
              >
                <Pencil className="w-3 h-3" /> Edit
              </button>
              <button
                onClick={() => verify.mutate()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-1.5 text-[12px] text-emerald-300/80 hover:bg-emerald-500/[0.12] transition-colors"
              >
                <Check className="w-3 h-3" /> Still accurate
              </button>
              {canManage && (
                <button
                  onClick={() => { if (confirm(`Delete "${a.title}"?`)) onDelete(a.id); }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/20 bg-rose-500/[0.06] px-3 py-1.5 text-[12px] text-rose-300/70 hover:bg-rose-500/[0.12] transition-colors ml-auto"
                >
                  <Trash2 className="w-3 h-3" /> Delete
                </button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Editor ───────────────────────────────────────────────────────────────────
function ArticleEditor({
  draft, brands, categorySuggestions, saving, onChange, onSave, onCancel,
}: {
  draft: Partial<FullArticle>;
  brands: Brand[];
  categorySuggestions: string[];
  saving: boolean;
  onChange: (d: Partial<FullArticle>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (k: keyof FullArticle, v: any) => onChange({ ...draft, [k]: v });
  const field = "w-full rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2 text-[13.5px] text-white/90 placeholder:text-white/25 focus:outline-none focus:border-amber-500/50";

  return (
    <div>
      <h2 className="text-base font-semibold text-white/95 mb-4">
        {draft.id ? "Edit article" : "New article"}
      </h2>
      <div className="space-y-3">
        <input
          value={draft.title ?? ""}
          onChange={(e) => set("title", e.target.value)}
          placeholder="Title — what someone would search for"
          data-testid="input-article-title"
          className={field}
        />
        <input
          value={draft.summary ?? ""}
          onChange={(e) => set("summary", e.target.value)}
          placeholder="One line summary (optional)"
          className={field}
        />
        <div className="grid grid-cols-2 gap-2">
          <select value={draft.brand ?? "all"} onChange={(e) => set("brand", e.target.value)} className={field}>
            <option value="all">All brands</option>
            {brands.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
          </select>
          <input
            value={draft.category ?? ""}
            onChange={(e) => set("category", e.target.value)}
            placeholder="Topic"
            list="kb-categories"
            className={field}
          />
          <datalist id="kb-categories">
            {categorySuggestions.map((c) => <option key={c} value={c} />)}
          </datalist>
        </div>
        <textarea
          value={draft.body ?? ""}
          onChange={(e) => set("body", e.target.value)}
          rows={14}
          placeholder={"The answer itself.\n\nUse ## for headings, - for bullets, **bold** for the numbers that matter."}
          data-testid="input-article-body"
          className={field + " font-mono text-[13px] leading-relaxed"}
        />
        <input
          value={(draft.keywords ?? []).join(", ")}
          onChange={(e) => set("keywords", e.target.value.split(",").map((k) => k.trim()).filter(Boolean))}
          placeholder="Search terms people might type, comma separated"
          className={field}
        />
        <select value={draft.status ?? "published"} onChange={(e) => set("status", e.target.value)} className={field}>
          <option value="published">Published — everyone can find it, Rambo can read it</option>
          <option value="draft">Draft — only visible here, Rambo ignores it</option>
          <option value="archived">Archived — out of the way</option>
        </select>
      </div>
      <div className="flex gap-2 mt-4">
        <button
          onClick={onSave}
          disabled={saving || !draft.title?.trim()}
          data-testid="button-save-article"
          className="inline-flex items-center gap-2 rounded-xl bg-amber-500/20 border border-amber-500/30 text-amber-200 px-4 py-2 text-sm font-medium disabled:opacity-30 hover:bg-amber-500/30 transition-colors"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save
        </button>
        <button
          onClick={onCancel}
          className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-sm text-white/50 hover:text-white/80 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
