// Staff Chat v2 — the thread panel, the forward dialog, and the files & links
// browser. Built 2026-08-15 on Travis's feedback (he ran Kerkyra United on
// Slack; these are the three things he missed).
//
// ⚠️ Threads reverse a documented v1 decision — Google Chat shipped
// topic-threading and had to remove it because conversations vanished into
// side-rooms nobody read. The mitigation lives here as much as in the API:
// 🔴 a reply STILL RENDERS IN THE CHANNEL. The panel is a focused view of a
// conversation that is already visible, never the only place it exists.
//
// 🔴 Every modal is PORTALLED to document.body. The chat page sits under a
// header with `backdrop-blur-2xl`, and a backdrop-filter makes an element a
// containing block for its `position: fixed` descendants — an inline overlay
// gets clipped to a 56px strip. Learned twice now (View As, and the coaching
// app's exercise picker).
import { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, workspaceFetch } from "@/lib/queryClient";
import {
  X, Search, Send, Loader2, CornerUpRight, MessageSquare, FileText,
  Image as ImageIcon, Mic, Link2, Paperclip,
} from "lucide-react";

const GOLD = "#c9a43e";
const initials = (n: string) => n.split(" ").filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join("");
const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

// ─────────────────────────────────────────────────────────────────────────────
// Thread panel
// ─────────────────────────────────────────────────────────────────────────────

export function ThreadPanel({ rootId, onClose, me, historyKey }: {
  rootId: number; onClose: () => void; me: number; historyKey: string[];
}) {
  const [text, setText] = useState("");
  const key = ["/api/admin/chat/messages", rootId, "thread"];

  const { data, isLoading } = useQuery<any>({
    queryKey: key,
    queryFn: async () => {
      const r = await workspaceFetch(`/api/admin/chat/messages/${rootId}/thread`);
      if (!r.ok) throw new Error("Couldn't open that thread");
      return r.json();
    },
    refetchInterval: 4000, // same polling model as the channel — two Fly machines, no sockets
  });

  const send = useMutation({
    mutationFn: async () => {
      const body = text.trim();
      if (!body) return;
      await apiRequest("POST", `/api/admin/chat/channels/${data.channelId}/messages`, {
        body, parentMessageId: rootId,
      });
    },
    onSuccess: () => {
      setText("");
      queryClient.invalidateQueries({ queryKey: key });
      // The channel shows the reply and the root's count, so refresh it too.
      queryClient.invalidateQueries({ queryKey: historyKey });
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const Row = ({ m, isRoot }: { m: any; isRoot?: boolean }) => (
    <div className={`flex gap-2.5 ${isRoot ? "pb-3 mb-3 border-b border-white/[0.07]" : "py-2"}`}>
      <div className="w-8 h-8 rounded-lg bg-white/[0.06] flex items-center justify-center flex-shrink-0 text-[11px] font-bold text-white/60">
        {initials(m.authorName)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold text-white/85">{m.authorName}</span>
          <span className="text-[11px] text-white/30">{fmtWhen(m.createdAt)}</span>
        </div>
        <div className="text-[13.5px] text-white/80 whitespace-pre-wrap break-words mt-0.5">
          {m.deleted ? <span className="italic text-white/30">Message removed</span> : m.body}
        </div>
        {(m.attachments || []).length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {m.attachments.map((a: any, i: number) => (
              <a key={i} href={a.url} target="_blank" rel="noreferrer"
                 className="text-[11.5px] px-2 py-1 rounded-lg bg-white/[0.05] border border-white/10 text-white/60 hover:text-white/90 flex items-center gap-1.5">
                <Paperclip className="w-3 h-3" />{a.name}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[150] flex justify-end" data-testid="panel-thread">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className="relative w-full sm:w-[430px] h-full bg-[#0b0c0e] border-l border-white/10 flex flex-col shadow-2xl">
        <header className="flex items-center gap-2 px-4 h-14 border-b border-white/[0.07] flex-shrink-0">
          <MessageSquare className="w-4 h-4 text-white/40" />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-white/85">Thread</div>
            {data?.channelName && <div className="text-[11px] text-white/35 truncate">#{data.channelName}</div>}
          </div>
          <button onClick={onClose} data-testid="button-close-thread"
                  className="ml-auto w-8 h-8 rounded-lg hover:bg-white/[0.07] flex items-center justify-center text-white/40">
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {isLoading && <p className="text-[13px] text-white/30">Loading…</p>}
          {data?.root && <Row m={data.root} isRoot />}
          {data?.replies?.length === 0 && (
            <p className="text-[12.5px] text-white/30 py-2">No replies yet — start the thread below.</p>
          )}
          {(data?.replies || []).map((m: any) => <Row key={m.id} m={m} />)}
        </div>

        <div className="p-3 border-t border-white/[0.07] flex-shrink-0">
          <div className="flex items-end gap-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send.mutate(); }
              }}
              rows={2}
              placeholder="Reply in thread…"
              data-testid="input-thread-reply"
              className="flex-1 resize-none bg-white/[0.05] border border-white/10 rounded-xl px-3 py-2 text-[13.5px] text-white/90 placeholder:text-white/25 outline-none focus:border-white/25"
            />
            <button
              onClick={() => send.mutate()}
              disabled={!text.trim() || send.isPending}
              data-testid="button-send-thread-reply"
              className="w-10 h-10 rounded-xl flex items-center justify-center disabled:opacity-40"
              style={{ background: GOLD }}
            >
              {send.isPending ? <Loader2 className="w-4 h-4 animate-spin text-black" /> : <Send className="w-4 h-4 text-black" />}
            </button>
          </div>
          <p className="text-[10.5px] text-white/25 mt-1.5">
            Replies also appear in the channel, so nobody misses them.
          </p>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Forward dialog
// ─────────────────────────────────────────────────────────────────────────────

export function ForwardDialog({ messageId, channels, onClose }: {
  messageId: number;
  channels: { id: number; name: string | null; kind: string; isPrivate?: boolean }[];
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [comment, setComment] = useState("");
  const [done, setDone] = useState<string | null>(null);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return channels.filter((c) => !s || (c.name || "").toLowerCase().includes(s));
  }, [channels, q]);

  const forward = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/chat/messages/${messageId}/forward`, {
      channelIds: picked, comment: comment.trim() || undefined,
    }),
    onSuccess: async (res: any) => {
      const j = await res.json().catch(() => ({}));
      const sent = (j.forwardedTo || []).length;
      const refused = (j.refused || []).length;
      // Report refusals honestly — a silent partial forward is how somebody
      // believes a message landed somewhere it never did.
      setDone(refused
        ? `Sent to ${sent}. ${refused} couldn't be sent — you're not a member, or it's leadership-only.`
        : `Sent to ${sent} conversation${sent === 1 ? "" : "s"}.`);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/chat/bootstrap"] });
      setTimeout(onClose, 1200);
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-start justify-center px-4 pt-[10vh] pb-8"
         onClick={onClose} data-testid="dialog-forward">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0b0c0e] overflow-hidden flex flex-col max-h-[74vh]"
           onClick={(e) => e.stopPropagation()}>
        <header className="px-4 py-3 border-b border-white/[0.07] flex items-center gap-2 flex-shrink-0">
          <CornerUpRight className="w-4 h-4 text-white/40" />
          <span className="text-[13px] font-semibold text-white/85">Forward message</span>
          <button onClick={onClose} className="ml-auto text-white/30 hover:text-white/70"><X className="w-4 h-4" /></button>
        </header>

        {done ? (
          <p className="p-6 text-[13px] text-white/70">{done}</p>
        ) : (
          <>
            <div className="p-3 border-b border-white/[0.06] flex-shrink-0">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-white/25 absolute left-3 top-1/2 -translate-y-1/2" />
                <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
                       placeholder="Search channels and DMs"
                       data-testid="input-forward-search"
                       className="w-full bg-white/[0.05] border border-white/10 rounded-xl pl-9 pr-3 py-2.5 text-[13px] text-white/90 placeholder:text-white/25 outline-none focus:border-white/25" />
              </div>
            </div>

            <div className="overflow-y-auto p-2 flex-1">
              {list.map((c) => {
                const on = picked.includes(c.id);
                return (
                  <button key={c.id}
                          onClick={() => setPicked((p) => on ? p.filter((x) => x !== c.id) : [...p, c.id])}
                          data-testid={`button-forward-target-${c.id}`}
                          className={`w-full text-left px-3 py-2 rounded-xl flex items-center gap-2 ${on ? "bg-white/[0.09]" : "hover:bg-white/[0.05]"}`}>
                    <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] ${on ? "border-transparent text-black" : "border-white/20"}`}
                          style={on ? { background: GOLD } : undefined}>{on ? "✓" : ""}</span>
                    <span className="text-[13px] text-white/80 truncate">
                      {c.kind === "dm" ? "" : "#"}{c.name || "Direct message"}
                    </span>
                  </button>
                );
              })}
              {list.length === 0 && <p className="text-[13px] text-white/30 p-3">Nothing matches.</p>}
            </div>

            <div className="p-3 border-t border-white/[0.06] flex-shrink-0 space-y-2">
              <input value={comment} onChange={(e) => setComment(e.target.value)}
                     placeholder="Add a comment (optional)"
                     data-testid="input-forward-comment"
                     className="w-full bg-white/[0.05] border border-white/10 rounded-xl px-3 py-2.5 text-[13px] text-white/90 placeholder:text-white/25 outline-none focus:border-white/25" />
              <button onClick={() => forward.mutate()} disabled={!picked.length || forward.isPending}
                      data-testid="button-forward-send"
                      className="w-full h-10 rounded-xl text-[13px] font-semibold text-black disabled:opacity-40 flex items-center justify-center gap-2"
                      style={{ background: GOLD }}>
                {forward.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CornerUpRight className="w-4 h-4" />}
                Forward{picked.length ? ` to ${picked.length}` : ""}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** The quoted original shown above a forwarded message. */
export function ForwardedQuote({ ref: fwd }: { ref: NonNullable<any> }) {
  return (
    <div className="mb-1.5 pl-2.5 border-l-2 border-white/15">
      <div className="text-[11px] text-white/35 flex items-center gap-1.5">
        <CornerUpRight className="w-3 h-3" />
        Forwarded from {fwd.channelKind === "dm" ? "a DM" : `#${fwd.channelName}`} · {fwd.authorName}
      </div>
      <div className="text-[12.5px] text-white/55 whitespace-pre-wrap break-words mt-0.5">
        {fwd.deleted ? <span className="italic text-white/25">Original was deleted</span> : fwd.body}
      </div>
      {fwd.attachmentCount > 0 && (
        <div className="text-[11px] text-white/30 mt-0.5">{fwd.attachmentCount} attachment{fwd.attachmentCount === 1 ? "" : "s"}</div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Files & links browser
// ─────────────────────────────────────────────────────────────────────────────

const KIND_TABS = [
  { key: "", label: "All" },
  { key: "image", label: "Images" },
  { key: "file", label: "Documents" },
  { key: "voice", label: "Voice" },
  { key: "link", label: "Links" },
] as const;

const KIND_ICON: Record<string, any> = { image: ImageIcon, file: FileText, voice: Mic, link: Link2 };

export function FilesBrowser({ onClose, onOpenMessage }: {
  onClose: () => void;
  onOpenMessage: (channelId: number, messageId: number) => void;
}) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string>("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/admin/chat/files", debounced, kind],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (debounced) p.set("q", debounced);
      if (kind) p.set("kind", kind);
      const r = await workspaceFetch(`/api/admin/chat/files?${p.toString()}`);
      if (!r.ok) throw new Error("Couldn't load files");
      return r.json();
    },
  });

  const items: any[] = data?.items || [];

  return createPortal(
    <div className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-start justify-center px-4 pt-[8vh] pb-8"
         onClick={onClose} data-testid="dialog-files">
      <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-[#0b0c0e] overflow-hidden flex flex-col max-h-[80vh]"
           onClick={(e) => e.stopPropagation()}>
        <header className="px-4 py-3 border-b border-white/[0.07] flex items-center gap-2 flex-shrink-0">
          <Paperclip className="w-4 h-4 text-white/40" />
          <span className="text-[13px] font-semibold text-white/85">Files &amp; links</span>
          <button onClick={onClose} className="ml-auto text-white/30 hover:text-white/70"><X className="w-4 h-4" /></button>
        </header>

        <div className="p-3 border-b border-white/[0.06] flex-shrink-0 space-y-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-white/25 absolute left-3 top-1/2 -translate-y-1/2" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
                   placeholder="Search everything that's been shared"
                   data-testid="input-files-search"
                   className="w-full bg-white/[0.05] border border-white/10 rounded-xl pl-9 pr-3 py-2.5 text-[13px] text-white/90 placeholder:text-white/25 outline-none focus:border-white/25" />
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {KIND_TABS.map((t) => (
              <button key={t.key} onClick={() => setKind(t.key)}
                      data-testid={`tab-files-${t.key || "all"}`}
                      className={`px-3 py-1.5 rounded-lg text-[12px] ${kind === t.key ? "text-black font-semibold" : "bg-white/[0.05] text-white/50 hover:text-white/80"}`}
                      style={kind === t.key ? { background: GOLD } : undefined}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-y-auto flex-1 p-2">
          {isLoading && <p className="text-[13px] text-white/30 p-3">Loading…</p>}
          {!isLoading && items.length === 0 && (
            <p className="text-[13px] text-white/30 p-3">
              {debounced ? "Nothing shared matches that." : "Nothing has been shared here yet."}
            </p>
          )}
          {items.map((it, i) => {
            const Icon = KIND_ICON[it.type] || FileText;
            return (
              <div key={`${it.type}-${it.messageId}-${i}`}
                   className="px-3 py-2.5 rounded-xl hover:bg-white/[0.05] flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-white/[0.06] flex items-center justify-center flex-shrink-0">
                  <Icon className="w-4 h-4 text-white/45" />
                </div>
                <div className="min-w-0 flex-1">
                  <a href={it.url} target="_blank" rel="noreferrer"
                     className="text-[13px] text-white/85 hover:underline truncate block">
                    {it.name || it.url}
                  </a>
                  <div className="text-[11px] text-white/35 truncate">
                    {it.channelKind === "dm" ? "Direct message" : `#${it.channelName}`} · {it.authorName} · {fmtWhen(it.createdAt)}
                    {it.size ? ` · ${fmtBytes(it.size)}` : ""}
                  </div>
                </div>
                <button onClick={() => { onOpenMessage(it.channelId, it.messageId); onClose(); }}
                        data-testid={`button-open-in-chat-${it.messageId}`}
                        className="text-[11.5px] text-white/40 hover:text-white/80 px-2 py-1 rounded-lg hover:bg-white/[0.06] flex-shrink-0">
                  Open
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
