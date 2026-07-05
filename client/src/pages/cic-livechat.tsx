import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { MessageCircle, Send, Phone, Mail, Circle, CheckCircle2, Loader2, ArrowLeft } from "lucide-react";

/**
 * Live Chat admin — manages the two-way conversations started from the brand
 * marketing site's chat widget. Reusable: pass a different `apiBase` + `title`
 * to mount it for another workspace. CIC mounts it at /admin/cic-livechat.
 */
type Conversation = {
  id: number; visitorName: string | null; visitorEmail: string | null; visitorPhone: string | null;
  status: string; agentUnread: number; sourceUrl: string | null;
  lastMessageAt: string; createdAt: string; preview: string; previewSender: string;
};
type Message = {
  id: number; sender: "visitor" | "agent" | "system"; authorName: string | null; body: string; createdAt: string;
};

const fmt = (d: string) => new Date(d).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const fmtTime = (d: string) => new Date(d).toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" });

export default function CicLiveChat() {
  return <LiveChatAdmin apiBase="/api/admin/cic/chat" title="Live Chat" subtitle="Real-time conversations from cicyouth.com — the visitor is emailed when you reply if they've stepped away." />;
}

export function LiveChatAdmin({ apiBase, title, subtitle }: { apiBase: string; title: string; subtitle: string }) {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Conversation list — polls so new chats + unread counts appear live.
  const { data: conversations = [], isLoading } = useQuery<Conversation[]>({
    queryKey: [`${apiBase}/conversations`],
    queryFn: () => fetch(`${apiBase}/conversations`).then((r) => r.json()),
    refetchInterval: 8000,
  });

  const totalUnread = conversations.reduce((n, c) => n + (c.agentUnread || 0), 0);
  const openCount = conversations.filter((c) => c.status === "open").length;

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            {title}
            {totalUnread > 0 && <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-500 text-black">{totalUnread} new</span>}
          </h1>
          <p className="text-sm text-white/40 mt-1 max-w-2xl">{subtitle}</p>
        </div>
        <div className="flex gap-3">
          {[{ label: "Open", value: openCount }, { label: "Unread", value: totalUnread }, { label: "All", value: conversations.length }].map((s) => (
            <div key={s.label} className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-2 text-center">
              <p className="text-[10px] uppercase tracking-wider text-white/30">{s.label}</p>
              <p className="text-lg font-bold text-white">{s.value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid lg:grid-cols-[340px_1fr] gap-4 min-h-[540px]">
        {/* Conversation list */}
        <div className={`rounded-2xl border border-white/5 bg-white/[0.02] overflow-hidden ${selectedId ? "hidden lg:block" : ""}`}>
          {isLoading ? (
            <div className="text-center py-12 text-white/20 text-sm">Loading…</div>
          ) : conversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-white/20 px-6 text-center">
              <MessageCircle className="w-12 h-12 mb-3" />
              <p className="text-sm">No chats yet.</p>
              <p className="text-xs mt-1">Conversations started from the website chat widget land here.</p>
            </div>
          ) : (
            <div className="divide-y divide-white/5 max-h-[70vh] overflow-y-auto">
              {conversations.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={`w-full text-left px-4 py-3.5 flex items-start gap-3 transition-colors ${selectedId === c.id ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"}`}
                  data-testid={`chat-conv-${c.id}`}
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-amber-500/15 text-amber-300 font-bold text-sm">
                    {(c.visitorName || "?").slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-white/90 truncate">{c.visitorName || c.visitorEmail || "Visitor"}</span>
                      {c.agentUnread > 0 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500 text-black shrink-0">{c.agentUnread}</span>}
                      <span className="ml-auto text-[10px] text-white/30 shrink-0">{fmt(c.lastMessageAt)}</span>
                    </div>
                    <div className="text-[12.5px] text-white/50 truncate mt-0.5">
                      {c.previewSender === "agent" && <span className="text-white/35">You: </span>}
                      {c.preview}
                    </div>
                    {c.status === "closed" && <span className="text-[10px] text-white/25 mt-1 inline-block">Closed</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Thread */}
        <div className={`rounded-2xl border border-white/5 bg-white/[0.02] overflow-hidden ${selectedId ? "" : "hidden lg:block"}`}>
          {selectedId ? (
            <ChatThread apiBase={apiBase} id={selectedId} onBack={() => setSelectedId(null)} onChanged={() => queryClient.invalidateQueries({ queryKey: [`${apiBase}/conversations`] })} toast={toast} />
          ) : (
            <div className="hidden lg:flex flex-col items-center justify-center h-full text-white/20 py-20">
              <MessageCircle className="w-12 h-12 mb-3" />
              <p className="text-sm">Select a conversation to reply.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatThread({ apiBase, id, onBack, onChanged, toast }: {
  apiBase: string; id: number; onBack: () => void; onChanged: () => void; toast: ReturnType<typeof useToast>["toast"];
}) {
  const [reply, setReply] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useQuery<{ conversation: any; messages: Message[] }>({
    queryKey: [`${apiBase}/conversations`, id],
    queryFn: () => fetch(`${apiBase}/conversations/${id}`).then((r) => r.json()),
    refetchInterval: 5000, // poll for new visitor messages while open
  });

  const conv = data?.conversation;
  const messages = data?.messages ?? [];

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, id]);

  // Clearing the unread badge happens server-side on open → refresh the list.
  useEffect(() => { onChanged(); /* eslint-disable-next-line */ }, [id]);

  const send = useMutation({
    mutationFn: (body: string) => apiRequest("POST", `${apiBase}/conversations/${id}/reply`, { body }).then((r) => r.json()),
    onSuccess: () => {
      setReply("");
      queryClient.invalidateQueries({ queryKey: [`${apiBase}/conversations`, id] });
      onChanged();
    },
    onError: (e: any) => toast({ title: "Couldn't send", description: e.message, variant: "destructive" }),
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => apiRequest("POST", `${apiBase}/conversations/${id}/status`, { status }).then((r) => r.json()),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: [`${apiBase}/conversations`, id] }); onChanged(); },
  });

  const doSend = () => { const b = reply.trim(); if (b) send.mutate(b); };

  return (
    <div className="flex flex-col h-full max-h-[74vh]">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b border-white/5">
        <button onClick={onBack} className="lg:hidden text-white/40 hover:text-white"><ArrowLeft className="w-5 h-5" /></button>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-amber-500/15 text-amber-300 font-bold text-sm">
          {(conv?.visitorName || "?").slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-white truncate">{conv?.visitorName || "Visitor"}</h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-white/40">
            {conv?.visitorEmail && <a href={`mailto:${conv.visitorEmail}`} className="flex items-center gap-1 hover:text-white/70"><Mail className="w-3 h-3" />{conv.visitorEmail}</a>}
            {conv?.visitorPhone && <a href={`tel:${conv.visitorPhone}`} className="flex items-center gap-1 hover:text-white/70"><Phone className="w-3 h-3" />{conv.visitorPhone}</a>}
          </div>
        </div>
        {conv && (
          <button
            onClick={() => setStatus.mutate(conv.status === "closed" ? "open" : "closed")}
            className="text-[11px] font-medium px-2.5 py-1.5 rounded-lg text-white/50 hover:bg-white/10 flex items-center gap-1.5 shrink-0"
          >
            {conv.status === "closed" ? <><Circle className="w-3 h-3" /> Reopen</> : <><CheckCircle2 className="w-3 h-3" /> Close</>}
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {isLoading && messages.length === 0 ? (
          <div className="text-center py-10 text-white/20 text-sm">Loading…</div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`flex flex-col max-w-[78%] ${m.sender === "agent" ? "ml-auto items-end" : "items-start"}`}>
              {m.sender === "agent" && m.authorName && <span className="text-[10px] text-white/30 mb-0.5 mr-1">{m.authorName}</span>}
              <div className={`px-3.5 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words ${
                m.sender === "agent" ? "bg-amber-500 text-black rounded-br-md"
                : m.sender === "system" ? "bg-transparent border border-dashed border-white/15 text-white/50 text-[13px]"
                : "bg-white/[0.06] text-white/90 rounded-bl-md"}`}>
                {m.body}
              </div>
              <span className="text-[10px] text-white/25 mt-0.5 mx-1">{fmtTime(m.createdAt)}</span>
            </div>
          ))
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-white/5 p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } }}
            placeholder="Type your reply…  (Enter to send, Shift+Enter for a new line)"
            rows={1}
            className="flex-1 resize-none rounded-xl bg-white/[0.04] border border-white/10 focus:border-amber-500/50 outline-none text-sm text-white px-3.5 py-2.5 max-h-32"
          />
          <button
            onClick={doSend}
            disabled={send.isPending || !reply.trim()}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-50 transition-colors"
            aria-label="Send reply"
          >
            {send.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
