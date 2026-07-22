// ─────────────────────────────────────────────────────────────────────────────
// Staff Chat — the in-house Slack. Universal page (every workspace, System
// section), backed by server/staff-chat-routes.ts.
//
// Product decisions (deep-research 2026-07-22, synthesis.md):
//   · channels + DMs, NO threads · unread bold, numeric badge ONLY for
//     mentions/DMs · quiet by default · no green dots, no read receipts
//   · "Please confirm" messages = the roster-level acknowledgment WhatsApp
//     can't do · voice notes are first-class (phone-first / ESL staff)
// Transport is react-query polling: sidebar sync 6s, open conversation 3.5s.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState, useCallback, Fragment } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Hash, Lock, Megaphone, Plus, Search, Send, Paperclip, Mic, Square, X,
  ChevronLeft, ChevronDown, ChevronRight, Users, Bell, BellOff, Volume2,
  MoreHorizontal, Pencil, Trash2, SmilePlus, CheckCheck, Check, ArchiveX,
  MessagesSquare, LogOut, FileText, Download, ShieldCheck, Loader2, UserPlus,
} from "lucide-react";

// ── Types (mirror server payloads) ───────────────────────────────────────────
interface Person { id: number; name: string; firstName: string; lastName: string; email: string; role: string }
interface ChannelSummary {
  id: number; kind: "channel" | "dm"; name: string | null; topic: string | null;
  isPrivate: boolean; isDefault: boolean; postPolicy: "anyone" | "leadership";
  archived: boolean; lastMessageAt: string | null; joined: boolean;
  notifyLevel: "all" | "mentions" | "muted" | null; unread: number; mentions: number;
  members?: { userId: number; name: string }[];
}
interface Attachment { url: string; name: string; contentType: string; size: number; kind: "image" | "voice" | "file"; durationSec?: number }
interface ChatMessage {
  id: number; channelId: number; authorId: number; authorName: string; body: string;
  attachments: Attachment[] | null; clientMessageId: string | null; requiresAck: boolean;
  editedAt: string | null; deleted: boolean; createdAt: string;
  reactions: { emoji: string; userIds: number[] }[]; ackCount: number; ackedByMe: boolean;
  mentionedUserIds: number[];
  pending?: boolean; failed?: boolean;
}
interface HistoryResponse {
  channel: { id: number; kind: string; name: string | null; topic: string | null; isPrivate: boolean; isDefault: boolean; postPolicy: string; archived: boolean };
  members: { userId: number; role: string; name: string }[];
  messages: ChatMessage[];
  hasMore: boolean;
}
interface Bootstrap { viewer: { userId: number; isLeadership: boolean }; users: Person[]; channels: ChannelSummary[] }

const GOLD = "#c9a43e";
const QUICK_EMOJIS = ["👍", "✅", "🔥", "😂", "🙏", "👀"];

// ── Small helpers ────────────────────────────────────────────────────────────
const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";

const avatarHue = (id: number) => (id * 137.508) % 360; // golden-angle spread

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase();
}
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long" });
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function fmtDuration(sec?: number): string {
  if (!sec || !Number.isFinite(sec)) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
const dmName = (c: ChannelSummary, me: number) => {
  const others = (c.members ?? []).filter((m) => m.userId !== me);
  return others.length ? others.map((m) => m.name).join(", ") : "Just you";
};
const channelLabel = (c: ChannelSummary, me: number) => (c.kind === "dm" ? dmName(c, me) : c.name ?? "channel");

// Render body text: linkify URLs + highlight mentions (names of mentioned
// members + @channel tokens). React escapes everything else for us.
function renderBody(body: string, mentionNames: string[], highlightSelf: boolean) {
  const parts: (string | JSX.Element)[] = [];
  const urlRe = /(https?:\/\/[^\s<>"')\]]+)/g;
  let key = 0;
  const mentionRe =
    mentionNames.length > 0
      ? new RegExp(`(@(?:channel|everyone|all)\\b|${mentionNames.map((n) => "@" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g")
      : /(@(?:channel|everyone|all)\b)/g;

  for (const chunk of body.split(urlRe)) {
    if (urlRe.test(chunk) && chunk.startsWith("http")) {
      parts.push(
        <a key={key++} href={chunk} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline break-all">
          {chunk}
        </a>,
      );
      continue;
    }
    for (const seg of chunk.split(mentionRe)) {
      if (!seg) continue;
      if (seg.startsWith("@")) {
        parts.push(
          <span key={key++} className="rounded px-1 py-[1px] font-semibold" style={{ color: GOLD, background: "rgba(201,164,62,0.12)" }}>
            {seg}
          </span>,
        );
      } else {
        parts.push(<Fragment key={key++}>{seg}</Fragment>);
      }
    }
  }
  return <span className={highlightSelf ? "" : ""}>{parts}</span>;
}

async function uploadFile(file: File | Blob, name: string, durationSec?: number): Promise<Attachment> {
  const fd = new FormData();
  fd.append("file", file, name);
  if (durationSec != null) fd.append("durationSec", String(durationSec));
  const res = await fetch("/api/admin/chat/upload", { method: "POST", body: fd, credentials: "include" });
  if (!res.ok) throw new Error((await res.text()) || "Upload failed");
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
export default function StaffChat() {
  const { toast } = useToast();
  const [activeId, setActiveId] = useState<number | null>(() => {
    const c = new URLSearchParams(window.location.search).get("c");
    return c ? parseInt(c, 10) || null : null;
  });
  const [mobilePane, setMobilePane] = useState<"list" | "chat">(activeId ? "chat" : "list");
  const [searchQ, setSearchQ] = useState("");

  const { data: boot } = useQuery<Bootstrap>({ queryKey: ["/api/admin/chat/bootstrap"], staleTime: 5 * 60_000 });
  const { data: sync } = useQuery<{ channels: ChannelSummary[] }>({
    queryKey: ["/api/admin/chat/sync"],
    refetchInterval: 6000,
    refetchIntervalInBackground: false,
  });

  const me = boot?.viewer.userId ?? -1;
  const isLeadership = boot?.viewer.isLeadership ?? false;
  const users = boot?.users ?? [];
  const channels = sync?.channels ?? boot?.channels ?? [];

  const active = channels.find((c) => c.id === activeId) ?? null;

  const openChannel = useCallback((id: number) => {
    setActiveId(id);
    setMobilePane("chat");
    setSearchQ("");
    const url = new URL(window.location.href);
    url.searchParams.set("c", String(id));
    window.history.replaceState(null, "", url.toString());
  }, []);

  // First load with no ?c= → open the busiest default (announcements/general).
  useEffect(() => {
    if (activeId == null && channels.length > 0 && window.matchMedia("(min-width: 768px)").matches) {
      const first =
        channels.find((c) => c.joined && c.kind === "channel" && c.name === "general") ??
        channels.find((c) => c.joined);
      if (first) setActiveId(first.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels.length]);

  return (
    <div className="h-full flex overflow-hidden text-white">
      <ChannelListPane
        channels={channels}
        users={users}
        me={me}
        isLeadership={isLeadership}
        activeId={activeId}
        openChannel={openChannel}
        searchQ={searchQ}
        setSearchQ={setSearchQ}
        className={`${mobilePane === "list" ? "flex" : "hidden"} md:flex`}
      />
      <div className={`flex-1 min-w-0 ${mobilePane === "chat" ? "flex" : "hidden"} md:flex flex-col`}>
        {active ? (
          <ConversationPane
            key={active.id}
            channel={active}
            me={me}
            isLeadership={isLeadership}
            users={users}
            onBack={() => setMobilePane("list")}
            toast={toast}
          />
        ) : (
          <WelcomePane />
        )}
      </div>
    </div>
  );
}

// ── Welcome / empty state ────────────────────────────────────────────────────
function WelcomePane() {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="w-14 h-14 mx-auto rounded-2xl flex items-center justify-center mb-5"
          style={{ background: "rgba(201,164,62,0.12)", border: "1px solid rgba(201,164,62,0.3)" }}>
          <MessagesSquare className="w-7 h-7" style={{ color: GOLD }} />
        </div>
        <h2 className="text-xl font-bold mb-2">The staff room, minus the noise</h2>
        <p className="text-sm text-white/50 leading-relaxed mb-6">
          Our own chat — every conversation stays in the club, searchable forever.
          Pick a channel to catch up, or start a direct message.
        </p>
        <div className="text-left text-[13px] text-white/45 space-y-2.5 bg-white/[0.03] border border-white/[0.06] rounded-2xl p-5">
          <p><span className="font-semibold text-white/70">Quiet by default.</span> You're only pinged for @mentions and direct messages — channels just badge.</p>
          <p><span className="font-semibold text-white/70">Away? We email you.</span> Mentions and DMs reach your inbox if you're not in ClubOS (never 8pm–8am).</p>
          <p><span className="font-semibold text-white/70">Must-see posts</span> ask for a one-tap confirmation — so "sent" finally means "seen".</p>
          <p><span className="font-semibold text-white/70">Hold the mic</span> to send a voice note, same as WhatsApp.</p>
        </div>
      </div>
    </div>
  );
}

// ── Left pane: search + channel & DM lists ───────────────────────────────────
function ChannelListPane(props: {
  channels: ChannelSummary[]; users: Person[]; me: number; isLeadership: boolean;
  activeId: number | null; openChannel: (id: number) => void;
  searchQ: string; setSearchQ: (s: string) => void; className?: string;
}) {
  const { channels, users, me, isLeadership, activeId, openChannel, searchQ, setSearchQ } = props;
  const [showBrowse, setShowBrowse] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [newChannelOpen, setNewChannelOpen] = useState(false);

  const joinedChannels = channels
    .filter((c) => c.kind === "channel" && c.joined && !c.archived)
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  const browsable = channels.filter((c) => c.kind === "channel" && !c.joined && !c.archived);
  const dms = channels
    .filter((c) => c.kind === "dm" && c.joined)
    .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));

  const { data: searchRes, isFetching: searching } = useQuery<{ results: { id: number; channelId: number; channelName: string | null; channelKind: string; authorName: string; body: string; createdAt: string }[] }>({
    queryKey: [`/api/admin/chat/search?q=${encodeURIComponent(searchQ)}`],
    enabled: searchQ.trim().length >= 2,
    staleTime: 10_000,
  });

  return (
    <aside className={`w-full md:w-72 lg:w-80 shrink-0 flex-col border-r border-white/[0.06] bg-black/20 ${props.className ?? ""}`}>
      <div className="p-3 pb-2 flex items-center gap-2">
        <h1 className="text-[15px] font-bold tracking-tight flex-1 px-1">Chat</h1>
        {isLeadership && (
          <button
            onClick={() => setNewChannelOpen(true)}
            title="New channel"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 hover:text-white/80 hover:bg-white/[0.06] transition-colors"
          >
            <Hash className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={() => setNewDmOpen(true)}
          title="New direct message"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[#0b0b08] transition-transform hover:scale-105"
          style={{ background: GOLD }}
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/25" />
          <input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search messages…"
            className="w-full h-9 pl-9 pr-8 rounded-xl bg-white/[0.04] border border-white/[0.07] text-[13px] placeholder:text-white/25 focus:outline-none focus:border-white/20"
          />
          {searchQ && (
            <button onClick={() => setSearchQ("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {searchQ.trim().length >= 2 ? (
          <div className="px-1 pt-1">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/25 font-semibold px-2 pb-2">
              {searching ? "Searching…" : `Results (${searchRes?.results.length ?? 0})`}
            </p>
            {(searchRes?.results ?? []).map((r) => (
              <button
                key={r.id}
                onClick={() => openChannel(r.channelId)}
                className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-white/[0.05] transition-colors"
              >
                <p className="text-[11px] text-white/40 mb-0.5">
                  {r.channelKind === "dm" ? "Direct message" : `#${r.channelName}`} · {r.authorName} ·{" "}
                  {new Date(r.createdAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}
                </p>
                <p className="text-[13px] text-white/70 leading-snug">{r.body}</p>
              </button>
            ))}
            {!searching && (searchRes?.results.length ?? 0) === 0 && (
              <p className="text-[13px] text-white/35 px-3 py-4">Nothing found for “{searchQ}”.</p>
            )}
          </div>
        ) : (
          <>
            <SectionLabel>Channels</SectionLabel>
            {joinedChannels.map((c) => (
              <ChannelRow key={c.id} c={c} me={me} active={activeId === c.id} onClick={() => openChannel(c.id)} />
            ))}
            {browsable.length > 0 && (
              <button
                onClick={() => setShowBrowse((v) => !v)}
                className="w-full flex items-center gap-1.5 px-3 py-2 text-[12px] text-white/35 hover:text-white/60 transition-colors"
              >
                {showBrowse ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                Browse channels ({browsable.length})
              </button>
            )}
            {showBrowse &&
              browsable.map((c) => <BrowseRow key={c.id} c={c} onJoined={() => openChannel(c.id)} />)}

            <SectionLabel className="mt-4">Direct messages</SectionLabel>
            {dms.map((c) => (
              <ChannelRow key={c.id} c={c} me={me} active={activeId === c.id} onClick={() => openChannel(c.id)} />
            ))}
            {dms.length === 0 && (
              <p className="text-[12px] text-white/30 px-3 py-2 leading-relaxed">
                No direct messages yet — tap <span style={{ color: GOLD }}>+</span> to message someone.
              </p>
            )}
          </>
        )}
      </div>

      <NewDmDialog open={newDmOpen} onClose={() => setNewDmOpen(false)} users={users} me={me} onOpened={openChannel} />
      {isLeadership && (
        <NewChannelDialog open={newChannelOpen} onClose={() => setNewChannelOpen(false)} onCreated={openChannel} />
      )}
    </aside>
  );
}

function SectionLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`text-[10px] uppercase tracking-[0.18em] text-white/25 font-semibold px-3 pt-1 pb-1.5 ${className}`}>
      {children}
    </p>
  );
}

function ChannelRow({ c, me, active, onClick }: { c: ChannelSummary; me: number; active: boolean; onClick: () => void }) {
  const label = channelLabel(c, me);
  const important = c.kind === "dm" ? c.unread : c.mentions;
  const hasUnread = c.unread > 0;
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl transition-colors text-left ${
        active ? "bg-white/[0.08]" : "hover:bg-white/[0.04]"
      }`}
    >
      {c.kind === "dm" ? (
        <div
          className="w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-bold shrink-0"
          style={{ background: `hsl(${avatarHue(c.id)} 45% 28%)`, color: "rgba(255,255,255,0.9)" }}
        >
          {initials(label)}
        </div>
      ) : c.postPolicy === "leadership" ? (
        <Megaphone className={`w-4 h-4 shrink-0 ${hasUnread ? "text-white/80" : "text-white/30"}`} />
      ) : c.isPrivate ? (
        <Lock className={`w-4 h-4 shrink-0 ${hasUnread ? "text-white/80" : "text-white/30"}`} />
      ) : (
        <Hash className={`w-4 h-4 shrink-0 ${hasUnread ? "text-white/80" : "text-white/30"}`} />
      )}
      <span className={`flex-1 truncate text-[13.5px] ${hasUnread ? "font-bold text-white" : "text-white/60"} ${c.notifyLevel === "muted" ? "opacity-50" : ""}`}>
        {label}
      </span>
      {c.notifyLevel === "muted" && <BellOff className="w-3 h-3 text-white/25 shrink-0" />}
      {important > 0 ? (
        <span className="min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center leading-none shrink-0"
          style={{ background: GOLD, color: "#0b0b08" }}>
          {important > 99 ? "99+" : important}
        </span>
      ) : hasUnread ? (
        <span className="w-1.5 h-1.5 rounded-full bg-white/50 shrink-0" />
      ) : null}
    </button>
  );
}

function BrowseRow({ c, onJoined }: { c: ChannelSummary; onJoined: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-2.5 px-3 py-1.5 group">
      <Hash className="w-4 h-4 text-white/25 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[13px] text-white/55 truncate">{c.name}</p>
        {c.topic && <p className="text-[11px] text-white/30 truncate">{c.topic}</p>}
      </div>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await apiRequest("POST", `/api/admin/chat/channels/${c.id}/join`);
            await queryClient.invalidateQueries({ queryKey: ["/api/admin/chat/sync"] });
            onJoined();
          } finally {
            setBusy(false);
          }
        }}
        className="text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-white/15 text-white/60 hover:text-white hover:border-white/30 transition-colors"
      >
        {busy ? "…" : "Join"}
      </button>
    </div>
  );
}

// ── Conversation pane ────────────────────────────────────────────────────────
function ConversationPane(props: {
  channel: ChannelSummary; me: number; isLeadership: boolean; users: Person[];
  onBack: () => void; toast: ReturnType<typeof useToast>["toast"];
}) {
  const { channel, me, isLeadership, users, onBack, toast } = props;
  const channelId = channel.id;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [older, setOlder] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const historyKey = [`/api/admin/chat/channels/${channelId}/messages`];
  const { data: hist } = useQuery<HistoryResponse>({
    queryKey: historyKey,
    refetchInterval: 3500,
    refetchIntervalInBackground: false,
  });

  const members = hist?.members ?? [];
  const mentionNames = useMemo(() => members.map((m) => m.name), [members]);

  // Merge: paged-older + latest page + optimistic pending (dedupe by id/client id).
  const messages = useMemo(() => {
    const byId = new Map<number, ChatMessage>();
    for (const m of older) byId.set(m.id, m);
    for (const m of hist?.messages ?? []) byId.set(m.id, m);
    const list = Array.from(byId.values()).sort((a, b) => a.id - b.id);
    const clientIds = new Set(list.map((m) => m.clientMessageId).filter(Boolean));
    return [...list, ...pending.filter((p) => !clientIds.has(p.clientMessageId))];
  }, [older, hist?.messages, pending]);

  // Auto-scroll: stick to bottom unless the reader has scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, channelId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Mark read when the latest message is on screen and the tab has focus.
  const lastMarked = useRef<number>(0);
  useEffect(() => {
    const latest = messages.filter((m) => !m.pending).at(-1)?.id ?? 0;
    if (latest > lastMarked.current && document.hasFocus()) {
      lastMarked.current = latest;
      apiRequest("POST", `/api/admin/chat/channels/${channelId}/read`)
        .then(() => queryClient.invalidateQueries({ queryKey: ["/api/admin/chat/sync"] }))
        .catch(() => {});
    }
  }, [messages, channelId]);
  useEffect(() => {
    const onFocus = () => {
      lastMarked.current = 0; // re-mark on focus
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const loadOlder = async () => {
    const oldest = messages.find((m) => !m.pending)?.id;
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(`/api/admin/chat/channels/${channelId}/messages?before=${oldest}&limit=50`, { credentials: "include" });
      const page: HistoryResponse = await res.json();
      const el = scrollRef.current;
      const prevHeight = el?.scrollHeight ?? 0;
      setOlder((cur) => [...page.messages, ...cur]);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight; // keep the view anchored
      });
    } finally {
      setLoadingOlder(false);
    }
  };

  // ── Send ───────────────────────────────────────────────────────────────────
  const sendMutation = useMutation({
    mutationFn: async (payload: { body: string; attachments: Attachment[]; mentionUserIds: number[]; requiresAck: boolean; clientMessageId: string }) => {
      const res = await apiRequest("POST", `/api/admin/chat/channels/${channelId}/messages`, payload);
      return res.json();
    },
    onMutate: (payload) => {
      stickToBottom.current = true;
      setPending((cur) => [
        ...cur,
        {
          id: -Date.now(),
          channelId,
          authorId: me,
          authorName: "You",
          body: payload.body,
          attachments: payload.attachments.length ? payload.attachments : null,
          clientMessageId: payload.clientMessageId,
          requiresAck: payload.requiresAck,
          editedAt: null,
          deleted: false,
          createdAt: new Date().toISOString(),
          reactions: [],
          ackCount: 0,
          ackedByMe: false,
          mentionedUserIds: [],
          pending: true,
        },
      ]);
    },
    onSuccess: async (_data, payload) => {
      setPending((cur) => cur.filter((p) => p.clientMessageId !== payload.clientMessageId));
      await queryClient.invalidateQueries({ queryKey: historyKey });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/chat/sync"] });
    },
    onError: (e: any, payload) => {
      setPending((cur) => cur.map((p) => (p.clientMessageId === payload.clientMessageId ? { ...p, failed: true, pending: false } : p)));
      toast({ title: "Message didn't send", description: e.message, variant: "destructive" });
    },
  });

  const retryFailed = (m: ChatMessage) => {
    setPending((cur) => cur.filter((p) => p.clientMessageId !== m.clientMessageId));
    sendMutation.mutate({
      body: m.body,
      attachments: m.attachments ?? [],
      mentionUserIds: [],
      requiresAck: m.requiresAck,
      clientMessageId: m.clientMessageId!,
    });
  };

  const canPost = channel.postPolicy !== "leadership" || isLeadership;
  const title = channelLabel(channel, me);

  // Group consecutive messages by author within 5 minutes.
  const grouped = useMemo(() => {
    const out: { dateLabel?: string; msg: ChatMessage; grouped: boolean }[] = [];
    let prev: ChatMessage | undefined;
    for (const m of messages) {
      const dl = !prev || dayLabel(prev.createdAt) !== dayLabel(m.createdAt) ? dayLabel(m.createdAt) : undefined;
      const sameGroup =
        !dl && prev && prev.authorId === m.authorId && !prev.deleted && !m.requiresAck && !prev.requiresAck &&
        new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
      out.push({ dateLabel: dl, msg: m, grouped: !!sameGroup });
      prev = m;
    }
    return out;
  }, [messages]);

  return (
    <>
      {/* Header */}
      <div className="h-14 shrink-0 border-b border-white/[0.06] flex items-center gap-2 px-3 sm:px-4 bg-black/10">
        <button onClick={onBack} className="md:hidden w-8 h-8 -ml-1 rounded-lg flex items-center justify-center text-white/50 hover:bg-white/[0.06]">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {channel.kind === "dm" ? (
            <div className="w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-bold shrink-0"
              style={{ background: `hsl(${avatarHue(channel.id)} 45% 28%)` }}>
              {initials(title)}
            </div>
          ) : channel.postPolicy === "leadership" ? (
            <Megaphone className="w-4.5 h-4.5 w-5 h-5 text-white/40 shrink-0" />
          ) : channel.isPrivate ? (
            <Lock className="w-5 h-5 text-white/40 shrink-0" />
          ) : (
            <Hash className="w-5 h-5 text-white/40 shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-[14.5px] font-bold truncate leading-tight">{title}</p>
            {channel.kind === "channel" && (
              <p className="text-[11px] text-white/35 truncate leading-tight">
                {channel.topic || (channel.postPolicy === "leadership" ? "Announcements — leadership posts" : " ")}
              </p>
            )}
          </div>
        </div>

        {channel.kind === "channel" && (
          <button
            onClick={() => setMembersOpen(true)}
            className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-white/45 hover:text-white/80 hover:bg-white/[0.06] transition-colors"
          >
            <Users className="w-4 h-4" />
            <span className="text-[12px] font-semibold">{members.length}</span>
          </button>
        )}

        <NotifyMenu channel={channel} />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="w-8 h-8 rounded-lg flex items-center justify-center text-white/45 hover:text-white/80 hover:bg-white/[0.06]">
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {channel.kind === "channel" && isLeadership && (
              <>
                <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
                  <Pencil className="w-3.5 h-3.5 mr-2" /> Channel settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {channel.kind === "channel" && !channel.isDefault && (
              <DropdownMenuItem
                onClick={async () => {
                  await apiRequest("POST", `/api/admin/chat/channels/${channelId}/leave`);
                  queryClient.invalidateQueries({ queryKey: ["/api/admin/chat/sync"] });
                  onBack();
                }}
              >
                <LogOut className="w-3.5 h-3.5 mr-2" /> Leave channel
              </DropdownMenuItem>
            )}
            {channel.kind === "channel" && channel.isDefault && (
              <DropdownMenuItem disabled>
                <ShieldCheck className="w-3.5 h-3.5 mr-2" /> Everyone's in this one
              </DropdownMenuItem>
            )}
            {channel.kind === "dm" && (
              <DropdownMenuItem disabled>
                <Users className="w-3.5 h-3.5 mr-2" /> {members.map((m) => m.name.split(" ")[0]).join(", ")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Messages */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 sm:px-5 py-4">
        {hist?.hasMore || older.length > 0 ? (
          <div className="text-center pb-3">
            {hist?.hasMore && (
              <button onClick={loadOlder} disabled={loadingOlder}
                className="text-[12px] text-white/40 hover:text-white/70 px-3 py-1.5 rounded-lg border border-white/10 hover:border-white/20 transition-colors">
                {loadingOlder ? "Loading…" : "Load earlier messages"}
              </button>
            )}
          </div>
        ) : messages.length > 0 ? (
          <div className="pb-4 pt-2">
            <p className="text-[13px] text-white/35">
              This is the very beginning of {channel.kind === "dm" ? `your conversation with ${title}` : `#${channel.name}`}.
            </p>
          </div>
        ) : null}

        {messages.length === 0 && (
          <div className="h-full flex items-center justify-center">
            <p className="text-[13.5px] text-white/35">
              {channel.kind === "dm" ? `Say hello to ${title} 👋` : `#${channel.name} is quiet — start it off.`}
            </p>
          </div>
        )}

        {grouped.map(({ dateLabel, msg, grouped: isGrouped }) => (
          <Fragment key={msg.id}>
            {dateLabel && (
              <div className="flex items-center gap-3 py-3">
                <div className="flex-1 h-px bg-white/[0.06]" />
                <span className="text-[11px] font-semibold text-white/35">{dateLabel}</span>
                <div className="flex-1 h-px bg-white/[0.06]" />
              </div>
            )}
            <MessageRow
              msg={msg}
              me={me}
              isLeadership={isLeadership}
              grouped={isGrouped}
              mentionNames={mentionNames}
              memberCount={members.length}
              editing={editingId === msg.id}
              setEditing={(on) => setEditingId(on ? msg.id : null)}
              historyKey={historyKey}
              retryFailed={retryFailed}
              toast={toast}
            />
          </Fragment>
        ))}
      </div>

      {/* Composer */}
      {channel.archived ? (
        <div className="shrink-0 border-t border-white/[0.06] p-4 text-center text-[13px] text-white/40">
          <ArchiveX className="w-4 h-4 inline mr-1.5 -mt-0.5" /> This channel is archived — read-only.
        </div>
      ) : canPost ? (
        <Composer
          channel={channel}
          members={members}
          me={me}
          isLeadership={isLeadership}
          onSend={(p) => sendMutation.mutate(p)}
          toast={toast}
        />
      ) : (
        <div className="shrink-0 border-t border-white/[0.06] p-4 text-center text-[13px] text-white/40">
          <Megaphone className="w-4 h-4 inline mr-1.5 -mt-0.5" style={{ color: GOLD }} />
          Only leadership posts here — everyone reads.
        </div>
      )}

      <MembersDialog
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        channelId={channelId}
        members={members}
        users={users}
        historyKey={historyKey}
      />
      {isLeadership && (
        <ChannelSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} channel={channel} onBack={onBack} />
      )}
    </>
  );
}

// ── Notification level ───────────────────────────────────────────────────────
function NotifyMenu({ channel }: { channel: ChannelSummary }) {
  const level = channel.notifyLevel ?? "mentions";
  const set = async (l: string) => {
    await apiRequest("POST", `/api/admin/chat/channels/${channel.id}/notify`, { level: l });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/chat/sync"] });
  };
  const Icon = level === "muted" ? BellOff : level === "all" ? Volume2 : Bell;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          title="Notifications"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white/45 hover:text-white/80 hover:bg-white/[0.06]"
        >
          <Icon className="w-4 h-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {[
          { key: "all", label: "Everything", hint: "Badge + email for every message", icon: Volume2 },
          { key: "mentions", label: "Mentions only", hint: "The default — @you and must-sees", icon: Bell },
          { key: "muted", label: "Muted", hint: "Badge only. @mentions still reach you", icon: BellOff },
        ].map((o) => (
          <DropdownMenuItem key={o.key} onClick={() => set(o.key)} className="items-start gap-2.5 py-2">
            <o.icon className={`w-4 h-4 mt-0.5 ${level === o.key ? "" : "opacity-40"}`} style={level === o.key ? { color: GOLD } : {}} />
            <div className="flex-1">
              <p className={`text-[13px] ${level === o.key ? "font-bold" : ""}`}>{o.label}</p>
              <p className="text-[11px] text-white/40">{o.hint}</p>
            </div>
            {level === o.key && <Check className="w-3.5 h-3.5 mt-1" style={{ color: GOLD }} />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── One message row ──────────────────────────────────────────────────────────
function MessageRow(props: {
  msg: ChatMessage; me: number; isLeadership: boolean; grouped: boolean;
  mentionNames: string[]; memberCount: number;
  editing: boolean; setEditing: (on: boolean) => void;
  historyKey: string[]; retryFailed: (m: ChatMessage) => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const { msg, me, isLeadership, grouped, mentionNames, memberCount, editing, setEditing, historyKey, retryFailed, toast } = props;
  const mine = msg.authorId === me;
  const mentionsMe = msg.mentionedUserIds.includes(me);
  const [editText, setEditText] = useState(msg.body);
  const [ackOpen, setAckOpen] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: historyKey });

  const react = async (emoji: string) => {
    await apiRequest("POST", `/api/admin/chat/messages/${msg.id}/reactions`, { emoji });
    refresh();
  };
  const remove = async () => {
    await apiRequest("DELETE", `/api/admin/chat/messages/${msg.id}`);
    refresh();
  };
  const saveEdit = async () => {
    try {
      await apiRequest("PATCH", `/api/admin/chat/messages/${msg.id}`, { body: editText });
      setEditing(false);
      refresh();
    } catch (e: any) {
      toast({ title: "Couldn't edit", description: e.message, variant: "destructive" });
    }
  };
  const ack = async () => {
    await apiRequest("POST", `/api/admin/chat/messages/${msg.id}/ack`);
    refresh();
  };

  if (msg.deleted) {
    return (
      <div className={`flex gap-3 px-1 ${grouped ? "py-0.5" : "pt-2 pb-0.5"}`}>
        <div className="w-9 shrink-0" />
        <p className="text-[13px] italic text-white/25">message removed</p>
      </div>
    );
  }

  const canEdit = mine && !msg.pending && !msg.failed && Date.now() - new Date(msg.createdAt).getTime() < 60 * 60 * 1000;

  return (
    <div
      className={`group relative flex gap-3 px-1 rounded-xl transition-colors ${grouped ? "py-0.5" : "pt-2.5 pb-0.5"} ${
        mentionsMe && !mine ? "bg-[rgba(201,164,62,0.05)]" : "hover:bg-white/[0.025]"
      } ${msg.requiresAck ? "my-1.5 border rounded-2xl p-3" : ""}`}
      style={msg.requiresAck ? { borderColor: "rgba(201,164,62,0.35)", background: "rgba(201,164,62,0.045)" } : {}}
    >
      {!grouped || msg.requiresAck ? (
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center text-[12px] font-bold shrink-0 mt-0.5"
          style={{ background: `hsl(${avatarHue(msg.authorId)} 42% 30%)` }}
        >
          {initials(msg.authorName)}
        </div>
      ) : (
        <div className="w-9 shrink-0 text-right">
          <span className="hidden group-hover:inline text-[10px] text-white/30 leading-[22px]">{fmtTime(msg.createdAt)}</span>
        </div>
      )}

      <div className="flex-1 min-w-0">
        {(!grouped || msg.requiresAck) && (
          <p className="leading-tight mb-0.5">
            <span className="text-[13.5px] font-bold">{mine ? "You" : msg.authorName}</span>
            <span className="text-[11px] text-white/30 ml-2">{fmtTime(msg.createdAt)}</span>
            {msg.requiresAck && (
              <span className="ml-2 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ color: GOLD, background: "rgba(201,164,62,0.12)" }}>
                Please confirm
              </span>
            )}
          </p>
        )}

        {editing ? (
          <div className="mt-1">
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={2}
              autoFocus
              className="w-full rounded-xl bg-white/[0.05] border border-white/15 p-2.5 text-[13.5px] focus:outline-none focus:border-white/30 resize-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(); }
                if (e.key === "Escape") setEditing(false);
              }}
            />
            <div className="flex gap-2 mt-1">
              <button onClick={saveEdit} className="text-[11px] font-bold px-2.5 py-1 rounded-lg" style={{ background: GOLD, color: "#0b0b08" }}>Save</button>
              <button onClick={() => setEditing(false)} className="text-[11px] px-2.5 py-1 rounded-lg border border-white/15 text-white/60">Cancel</button>
            </div>
          </div>
        ) : (
          <>
            {msg.body && (
              <p className={`text-[13.5px] leading-relaxed whitespace-pre-wrap break-words text-white/85 ${msg.pending ? "opacity-50" : ""} ${msg.failed ? "opacity-60" : ""}`}>
                {renderBody(msg.body, mentionNames, mentionsMe)}
                {msg.editedAt && <span className="text-[10px] text-white/30 ml-1.5">(edited)</span>}
              </p>
            )}
            {(msg.attachments ?? []).map((a, i) => (
              <AttachmentView key={i} a={a} />
            ))}
            {msg.failed && (
              <button onClick={() => retryFailed(msg)} className="text-[11px] font-semibold text-red-400 hover:text-red-300 mt-1">
                Failed to send — tap to retry
              </button>
            )}
          </>
        )}

        {/* Reactions */}
        {msg.reactions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {msg.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => react(r.emoji)}
                className={`h-6 px-2 rounded-full text-[12px] flex items-center gap-1 border transition-colors ${
                  r.userIds.includes(me)
                    ? "border-[rgba(201,164,62,0.5)] bg-[rgba(201,164,62,0.12)]"
                    : "border-white/10 bg-white/[0.04] hover:border-white/25"
                }`}
              >
                {r.emoji} <span className="font-semibold text-white/60">{r.userIds.length}</span>
              </button>
            ))}
          </div>
        )}

        {/* Acknowledgment */}
        {msg.requiresAck && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
            {!mine && !msg.ackedByMe && !msg.pending && (
              <button onClick={ack} className="h-8 px-3.5 rounded-xl text-[12.5px] font-bold flex items-center gap-1.5 transition-transform hover:scale-[1.02]"
                style={{ background: GOLD, color: "#0b0b08" }}>
                <CheckCheck className="w-4 h-4" /> Confirm you've seen this
              </button>
            )}
            {!mine && msg.ackedByMe && (
              <span className="text-[12px] font-semibold flex items-center gap-1" style={{ color: GOLD }}>
                <CheckCheck className="w-4 h-4" /> Confirmed
              </span>
            )}
            <Popover open={ackOpen} onOpenChange={setAckOpen}>
              <PopoverTrigger asChild>
                <button className="text-[12px] text-white/45 hover:text-white/75 underline-offset-2 hover:underline">
                  {msg.ackCount} of {Math.max(memberCount - 1, 0)} confirmed
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-0" align="start">
                {ackOpen && <AckRoster messageId={msg.id} />}
              </PopoverContent>
            </Popover>
          </div>
        )}
      </div>

      {/* Hover actions */}
      {!msg.pending && !msg.failed && !editing && (
        <div className="absolute -top-3 right-2 hidden group-hover:flex items-center gap-0.5 bg-[#16171a] border border-white/10 rounded-xl p-0.5 shadow-xl">
          <Popover>
            <PopoverTrigger asChild>
              <button className="w-7 h-7 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/[0.07]" title="React">
                <SmilePlus className="w-3.5 h-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1.5 flex gap-1" align="end">
              {QUICK_EMOJIS.map((e) => (
                <button key={e} onClick={() => react(e)} className="w-8 h-8 text-[17px] rounded-lg hover:bg-white/[0.08]">
                  {e}
                </button>
              ))}
            </PopoverContent>
          </Popover>
          {canEdit && (
            <button onClick={() => { setEditText(msg.body); setEditing(true); }} className="w-7 h-7 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/[0.07]" title="Edit">
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
          {(mine || isLeadership) && (
            <button onClick={remove} className="w-7 h-7 rounded-lg flex items-center justify-center text-white/50 hover:text-red-400 hover:bg-white/[0.07]" title="Delete">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AckRoster({ messageId }: { messageId: number }) {
  const { data } = useQuery<{ acked: { userId: number; name: string; ackedAt: string }[]; pending: { userId: number; name: string }[] }>({
    queryKey: [`/api/admin/chat/messages/${messageId}/acks`],
    staleTime: 5000,
  });
  if (!data) return <p className="text-[12px] text-white/40 p-3">Loading…</p>;
  return (
    <div className="max-h-72 overflow-y-auto p-2">
      {data.acked.length > 0 && (
        <>
          <p className="text-[10px] uppercase tracking-wider font-bold px-2 py-1" style={{ color: GOLD }}>Confirmed</p>
          {data.acked.map((p) => (
            <p key={p.userId} className="text-[13px] px-2 py-1 flex items-center justify-between">
              {p.name}
              <span className="text-[10px] text-white/35">{fmtTime(p.ackedAt)}</span>
            </p>
          ))}
        </>
      )}
      {data.pending.length > 0 && (
        <>
          <p className="text-[10px] uppercase tracking-wider font-bold text-white/35 px-2 py-1 mt-1">Hasn't confirmed yet</p>
          {data.pending.map((p) => (
            <p key={p.userId} className="text-[13px] text-white/55 px-2 py-1">{p.name}</p>
          ))}
        </>
      )}
      {data.acked.length === 0 && data.pending.length === 0 && <p className="text-[12px] text-white/40 p-2">Nobody else here yet.</p>}
    </div>
  );
}

function AttachmentView({ a }: { a: Attachment }) {
  if (a.kind === "image") {
    return (
      <a href={a.url} target="_blank" rel="noopener noreferrer" className="block mt-1.5 max-w-[320px]">
        <img src={a.url} alt={a.name} loading="lazy" className="rounded-xl max-h-64 border border-white/[0.07]" />
      </a>
    );
  }
  if (a.kind === "voice") {
    return (
      <div className="mt-1.5 flex items-center gap-2.5 max-w-[340px] rounded-2xl border border-white/[0.08] bg-white/[0.04] px-3 py-2">
        <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: "rgba(201,164,62,0.15)" }}>
          <Mic className="w-4 h-4" style={{ color: GOLD }} />
        </div>
        <audio controls preload="none" src={a.url} className="h-9 flex-1 min-w-0" />
        {a.durationSec ? <span className="text-[11px] text-white/40 shrink-0">{fmtDuration(a.durationSec)}</span> : null}
      </div>
    );
  }
  return (
    <a
      href={a.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1.5 inline-flex items-center gap-2.5 rounded-xl border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.07] px-3 py-2.5 transition-colors max-w-full"
    >
      <FileText className="w-4.5 h-4.5 w-5 h-5 text-white/40 shrink-0" />
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold truncate">{a.name}</span>
        <span className="block text-[11px] text-white/35">{fmtBytes(a.size)}</span>
      </span>
      <Download className="w-3.5 h-3.5 text-white/30 shrink-0" />
    </a>
  );
}

// ── Composer ─────────────────────────────────────────────────────────────────
function Composer(props: {
  channel: ChannelSummary;
  members: { userId: number; name: string }[];
  me: number;
  isLeadership: boolean;
  onSend: (p: { body: string; attachments: Attachment[]; mentionUserIds: number[]; requiresAck: boolean; clientMessageId: string }) => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const { channel, members, me, isLeadership, onSend, toast } = props;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [mentions, setMentions] = useState<{ id: number; name: string }[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [requiresAck, setRequiresAck] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const recRef = useRef<{ recorder: MediaRecorder; chunks: Blob[]; timer: ReturnType<typeof setInterval>; start: number } | null>(null);

  const otherMembers = members.filter((m) => m.userId !== me);
  const mentionMatches =
    mentionQuery != null
      ? otherMembers.filter((m) => m.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6)
      : [];

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = Math.min(ta.scrollHeight, 180) + "px";
  };

  const updateMentionQuery = (value: string, caret: number) => {
    const upto = value.slice(0, caret);
    const m = upto.match(/@([^\s@]{0,24})$/);
    setMentionQuery(m ? m[1] : null);
    setMentionIdx(0);
  };

  const pickMention = (person: { userId: number; name: string }) => {
    const ta = taRef.current;
    if (!ta) return;
    const caret = ta.selectionStart;
    const upto = text.slice(0, caret).replace(/@([^\s@]{0,24})$/, `@${person.name} `);
    const next = upto + text.slice(caret);
    setText(next);
    setMentions((cur) => (cur.some((x) => x.id === person.userId) ? cur : [...cur, { id: person.userId, name: person.name }]));
    setMentionQuery(null);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = upto.length;
      autoGrow();
    });
  };

  const addFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (f.size > 25 * 1024 * 1024) {
        toast({ title: "Too big", description: `${f.name} is over 25MB`, variant: "destructive" });
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const att = await uploadFile(f, f.name);
        setAttachments((cur) => [...cur, att]);
      } catch (e: any) {
        toast({ title: "Upload failed", description: e.message, variant: "destructive" });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
      recorder.start(250);
      const start = Date.now();
      const timer = setInterval(() => setRecSeconds(Math.round((Date.now() - start) / 1000)), 500);
      recRef.current = { recorder, chunks, timer, start };
      setRecSeconds(0);
      setRecording(true);
    } catch {
      toast({ title: "Microphone blocked", description: "Allow mic access in your browser to send voice notes.", variant: "destructive" });
    }
  };

  const stopRecording = async (send: boolean) => {
    const rec = recRef.current;
    if (!rec) return;
    clearInterval(rec.timer);
    setRecording(false);
    const done = new Promise<void>((resolve) => {
      rec.recorder.onstop = () => resolve();
    });
    rec.recorder.stop();
    rec.recorder.stream.getTracks().forEach((t) => t.stop());
    await done;
    recRef.current = null;
    if (!send) return;
    const durationSec = Math.round((Date.now() - rec.start) / 1000);
    if (durationSec < 1) return;
    const mime = rec.recorder.mimeType || "audio/webm";
    const blob = new Blob(rec.chunks, { type: mime });
    setUploading((n) => n + 1);
    try {
      const att = await uploadFile(blob, `voice-note.${mime.includes("mp4") ? "m4a" : "webm"}`, durationSec);
      setAttachments((cur) => [...cur, att]);
    } catch (e: any) {
      toast({ title: "Voice note failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading((n) => n - 1);
    }
  };

  const doSend = () => {
    const body = text.trimEnd();
    if ((!body && attachments.length === 0) || uploading > 0) return;
    const mentionUserIds = mentions.filter((m) => body.includes(`@${m.name}`)).map((m) => m.id);
    onSend({
      body,
      attachments,
      mentionUserIds,
      requiresAck,
      clientMessageId: crypto.randomUUID(),
    });
    setText("");
    setAttachments([]);
    setMentions([]);
    setRequiresAck(false);
    setMentionQuery(null);
    requestAnimationFrame(autoGrow);
  };

  const placeholder =
    channel.kind === "dm" ? "Message…" : channel.postPolicy === "leadership" ? `Post an announcement…` : `Message #${channel.name}`;

  return (
    <div className="shrink-0 border-t border-white/[0.06] p-3 sm:p-4 relative">
      {/* Mention autocomplete */}
      {mentionMatches.length > 0 && (
        <div className="absolute bottom-full left-4 right-4 sm:right-auto sm:w-72 mb-1 rounded-xl border border-white/10 bg-[#16171a] shadow-2xl overflow-hidden z-10">
          {mentionMatches.map((m, i) => (
            <button
              key={m.userId}
              onMouseDown={(e) => { e.preventDefault(); pickMention(m); }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-left ${i === mentionIdx ? "bg-white/[0.08]" : "hover:bg-white/[0.05]"}`}
            >
              <div className="w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-bold" style={{ background: `hsl(${avatarHue(m.userId)} 42% 30%)` }}>
                {initials(m.name)}
              </div>
              <span className="text-[13px]">{m.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Attachment chips */}
      {(attachments.length > 0 || uploading > 0) && (
        <div className="flex flex-wrap gap-2 pb-2.5">
          {attachments.map((a, i) => (
            <div key={i} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] pl-2.5 pr-1.5 py-1.5">
              {a.kind === "image" ? (
                <img src={a.url} alt="" className="w-7 h-7 rounded-lg object-cover" />
              ) : a.kind === "voice" ? (
                <Mic className="w-4 h-4" style={{ color: GOLD }} />
              ) : (
                <FileText className="w-4 h-4 text-white/50" />
              )}
              <span className="text-[12px] text-white/70 max-w-[140px] truncate">
                {a.kind === "voice" ? `Voice note ${fmtDuration(a.durationSec)}` : a.name}
              </span>
              <button onClick={() => setAttachments((cur) => cur.filter((_, j) => j !== i))} className="w-5 h-5 rounded-md flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10">
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
          {uploading > 0 && (
            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-white/50" />
              <span className="text-[12px] text-white/50">Uploading…</span>
            </div>
          )}
        </div>
      )}

      {/* Must-see toggle */}
      {requiresAck && (
        <div className="flex items-center gap-2 pb-2 text-[12px] font-semibold" style={{ color: GOLD }}>
          <CheckCheck className="w-4 h-4" /> Everyone will be asked to confirm they've seen this.
          <button onClick={() => setRequiresAck(false)} className="text-white/40 hover:text-white/70 underline underline-offset-2 font-normal">undo</button>
        </div>
      )}

      {recording ? (
        <div className="flex items-center gap-3 h-12 rounded-2xl border px-4" style={{ borderColor: "rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.06)" }}>
          <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
          <span className="text-[13.5px] font-semibold text-white/85 flex-1">Recording… {fmtDuration(recSeconds)}</span>
          <button onClick={() => stopRecording(false)} className="h-8 px-3 rounded-xl text-[12px] font-semibold text-white/60 hover:text-white border border-white/15">
            Cancel
          </button>
          <button onClick={() => stopRecording(true)} className="h-8 px-3.5 rounded-xl text-[12px] font-bold flex items-center gap-1.5" style={{ background: GOLD, color: "#0b0b08" }}>
            <Square className="w-3 h-3" /> Stop & attach
          </button>
        </div>
      ) : (
        <div className="flex items-end gap-1.5">
          <div className="flex-1 min-w-0 flex items-end rounded-2xl border border-white/10 bg-white/[0.04] focus-within:border-white/25 transition-colors">
            <button
              onClick={() => fileRef.current?.click()}
              title="Attach a file"
              className="w-10 h-11 flex items-center justify-center text-white/40 hover:text-white/80 shrink-0"
            >
              <Paperclip className="w-[18px] h-[18px]" />
            </button>
            <textarea
              ref={taRef}
              value={text}
              rows={1}
              placeholder={placeholder}
              className="flex-1 min-w-0 bg-transparent py-3 pr-2 text-[14px] placeholder:text-white/25 focus:outline-none resize-none leading-snug"
              onChange={(e) => {
                setText(e.target.value);
                updateMentionQuery(e.target.value, e.target.selectionStart);
                autoGrow();
              }}
              onKeyDown={(e) => {
                if (mentionMatches.length > 0) {
                  if (e.key === "ArrowDown") { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentionMatches.length); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length); return; }
                  if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(mentionMatches[mentionIdx]); return; }
                  if (e.key === "Escape") { setMentionQuery(null); return; }
                }
                if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(pointer: fine)").matches) {
                  e.preventDefault();
                  doSend();
                }
              }}
              onClick={(e) => updateMentionQuery(text, (e.target as HTMLTextAreaElement).selectionStart)}
            />
            {isLeadership && channel.kind === "channel" && !requiresAck && (
              <button
                onClick={() => setRequiresAck(true)}
                title="Ask everyone to confirm they've seen this"
                className="w-10 h-11 hidden min-[360px]:flex items-center justify-center text-white/35 hover:text-[#c9a43e] shrink-0"
              >
                <CheckCheck className="w-[18px] h-[18px]" />
              </button>
            )}
            <button
              onClick={startRecording}
              title="Record a voice note"
              className="w-10 h-11 flex items-center justify-center text-white/40 hover:text-white/80 shrink-0"
            >
              <Mic className="w-[18px] h-[18px]" />
            </button>
          </div>
          <button
            onClick={doSend}
            disabled={(!text.trim() && attachments.length === 0) || uploading > 0}
            className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 transition-all disabled:opacity-25 hover:scale-105 disabled:hover:scale-100"
            style={{ background: GOLD, color: "#0b0b08" }}
            title="Send"
          >
            <Send className="w-[18px] h-[18px]" />
          </button>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) addFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

// ── Dialogs ──────────────────────────────────────────────────────────────────
function NewDmDialog(props: { open: boolean; onClose: () => void; users: Person[]; me: number; onOpened: (id: number) => void }) {
  const { open, onClose, users, me, onOpened } = props;
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Person[]>([]);
  const [busy, setBusy] = useState(false);

  const options = users
    .filter((u) => u.id !== me && !picked.some((p) => p.id === u.id))
    .filter((u) => u.name.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 12);

  const start = async () => {
    if (picked.length === 0) return;
    setBusy(true);
    try {
      const res = await apiRequest("POST", "/api/admin/chat/dms", { userIds: picked.map((p) => p.id) });
      const { id } = await res.json();
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/chat/sync"] });
      onClose();
      setPicked([]);
      setQ("");
      onOpened(id);
    } catch (e) {
      // toast handled upstream if needed
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
        <div className="p-4 pb-3 border-b border-white/[0.07]">
          <h2 className="text-[15px] font-bold">New direct message</h2>
          <p className="text-[12px] text-white/40 mt-0.5">Message one person, or up to 8 for a small group.</p>
        </div>
        <div className="p-4">
          {picked.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pb-2.5">
              {picked.map((p) => (
                <span key={p.id} className="flex items-center gap-1.5 text-[12px] font-semibold rounded-lg pl-2 pr-1 py-1" style={{ background: "rgba(201,164,62,0.12)", color: GOLD }}>
                  {p.name}
                  <button onClick={() => setPicked((cur) => cur.filter((x) => x.id !== p.id))} className="hover:opacity-70">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search people…"
            autoFocus
            className="w-full h-10 px-3.5 rounded-xl bg-white/[0.05] border border-white/10 text-[13.5px] placeholder:text-white/25 focus:outline-none focus:border-white/25"
          />
          <div className="mt-2 max-h-60 overflow-y-auto">
            {options.map((u) => (
              <button
                key={u.id}
                onClick={() => picked.length < 8 && setPicked((cur) => [...cur, u])}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl hover:bg-white/[0.05] text-left"
              >
                <div className="w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-bold" style={{ background: `hsl(${avatarHue(u.id)} 42% 30%)` }}>
                  {initials(u.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] truncate">{u.name}</p>
                  <p className="text-[11px] text-white/35 truncate">{u.email}</p>
                </div>
              </button>
            ))}
            {options.length === 0 && <p className="text-[12.5px] text-white/35 px-2 py-4">No one matches “{q}”.</p>}
          </div>
        </div>
        <div className="p-4 pt-0">
          <button
            onClick={start}
            disabled={picked.length === 0 || busy}
            className="w-full h-11 rounded-xl font-bold text-[14px] disabled:opacity-30 transition-opacity"
            style={{ background: GOLD, color: "#0b0b08" }}
          >
            {busy ? "Opening…" : picked.length > 1 ? `Start group message (${picked.length})` : "Start conversation"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NewChannelDialog(props: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const { open, onClose, onCreated } = props;
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [announceOnly, setAnnounceOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const res = await apiRequest("POST", "/api/admin/chat/channels", {
        name,
        topic: topic || undefined,
        isPrivate,
        postPolicy: announceOnly ? "leadership" : "anyone",
      });
      const { id } = await res.json();
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/chat/sync"] });
      onClose();
      setName(""); setTopic(""); setIsPrivate(false); setAnnounceOnly(false);
      onCreated(id);
    } catch (e: any) {
      toast({ title: "Couldn't create channel", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
        <div className="p-4 pb-3 border-b border-white/[0.07]">
          <h2 className="text-[15px] font-bold">New channel</h2>
          <p className="text-[12px] text-white/40 mt-0.5">A place for one topic or one team — keep it tight.</p>
        </div>
        <div className="p-4 space-y-3">
          <div className="relative">
            <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="match-day-ops"
              autoFocus
              className="w-full h-10 pl-9 pr-3 rounded-xl bg-white/[0.05] border border-white/10 text-[13.5px] placeholder:text-white/25 focus:outline-none focus:border-white/25"
            />
          </div>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="What's it for? (optional)"
            className="w-full h-10 px-3.5 rounded-xl bg-white/[0.05] border border-white/10 text-[13.5px] placeholder:text-white/25 focus:outline-none focus:border-white/25"
          />
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} className="mt-1" />
            <span>
              <span className="text-[13px] font-semibold flex items-center gap-1.5"><Lock className="w-3.5 h-3.5" /> Private</span>
              <span className="text-[11.5px] text-white/40 block">Invite-only — hidden from Browse.</span>
            </span>
          </label>
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="checkbox" checked={announceOnly} onChange={(e) => setAnnounceOnly(e.target.checked)} className="mt-1" />
            <span>
              <span className="text-[13px] font-semibold flex items-center gap-1.5"><Megaphone className="w-3.5 h-3.5" /> Announcements only</span>
              <span className="text-[11.5px] text-white/40 block">Leadership posts, everyone reads.</span>
            </span>
          </label>
        </div>
        <div className="p-4 pt-1">
          <button
            onClick={create}
            disabled={!name.trim() || busy}
            className="w-full h-11 rounded-xl font-bold text-[14px] disabled:opacity-30"
            style={{ background: GOLD, color: "#0b0b08" }}
          >
            {busy ? "Creating…" : "Create channel"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MembersDialog(props: {
  open: boolean; onClose: () => void; channelId: number;
  members: { userId: number; role: string; name: string }[];
  users: Person[]; historyKey: string[];
}) {
  const { open, onClose, channelId, members, users, historyKey } = props;
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const memberIds = new Set(members.map((m) => m.userId));
  const addable = users.filter((u) => !memberIds.has(u.id)).filter((u) => u.name.toLowerCase().includes(q.toLowerCase()));

  const add = async (userId: number) => {
    setBusy(userId);
    try {
      await apiRequest("POST", `/api/admin/chat/channels/${channelId}/members`, { userIds: [userId] });
      await queryClient.invalidateQueries({ queryKey: historyKey });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
        <div className="p-4 pb-3 border-b border-white/[0.07]">
          <h2 className="text-[15px] font-bold flex items-center gap-2"><Users className="w-4 h-4" /> Members ({members.length})</h2>
        </div>
        <div className="p-4 max-h-[26rem] overflow-y-auto">
          {members.map((m) => (
            <div key={m.userId} className="flex items-center gap-2.5 py-1.5">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-bold" style={{ background: `hsl(${avatarHue(m.userId)} 42% 30%)` }}>
                {initials(m.name)}
              </div>
              <span className="text-[13.5px] flex-1 truncate">{m.name}</span>
              {m.role === "owner" && <span className="text-[10px] uppercase font-bold tracking-wider text-white/30">owner</span>}
            </div>
          ))}
          <div className="mt-3 pt-3 border-t border-white/[0.07]">
            <p className="text-[11px] uppercase tracking-wider font-bold text-white/30 mb-2 flex items-center gap-1.5">
              <UserPlus className="w-3.5 h-3.5" /> Add people
            </p>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search staff…"
              className="w-full h-9 px-3 rounded-xl bg-white/[0.05] border border-white/10 text-[13px] placeholder:text-white/25 focus:outline-none focus:border-white/25"
            />
            {addable.slice(0, 8).map((u) => (
              <div key={u.id} className="flex items-center gap-2.5 py-1.5">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-bold" style={{ background: `hsl(${avatarHue(u.id)} 42% 30%)` }}>
                  {initials(u.name)}
                </div>
                <span className="text-[13.5px] flex-1 truncate">{u.name}</span>
                <button
                  disabled={busy === u.id}
                  onClick={() => add(u.id)}
                  className="text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-white/15 text-white/60 hover:text-white hover:border-white/30"
                >
                  {busy === u.id ? "…" : "Add"}
                </button>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChannelSettingsDialog(props: { open: boolean; onClose: () => void; channel: ChannelSummary; onBack: () => void }) {
  const { open, onClose, channel, onBack } = props;
  const { toast } = useToast();
  const [name, setName] = useState(channel.name ?? "");
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [announceOnly, setAnnounceOnly] = useState(channel.postPolicy === "leadership");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(channel.name ?? "");
      setTopic(channel.topic ?? "");
      setAnnounceOnly(channel.postPolicy === "leadership");
    }
  }, [open, channel]);

  const save = async () => {
    setBusy(true);
    try {
      await apiRequest("PATCH", `/api/admin/chat/channels/${channel.id}`, {
        name,
        topic,
        postPolicy: announceOnly ? "leadership" : "anyone",
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/chat/sync"] });
      queryClient.invalidateQueries({ queryKey: [`/api/admin/chat/channels/${channel.id}/messages`] });
      onClose();
    } catch (e: any) {
      toast({ title: "Couldn't save", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    setBusy(true);
    try {
      await apiRequest("PATCH", `/api/admin/chat/channels/${channel.id}`, { archived: true });
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/chat/sync"] });
      onClose();
      onBack();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
        <div className="p-4 pb-3 border-b border-white/[0.07]">
          <h2 className="text-[15px] font-bold">Channel settings</h2>
        </div>
        <div className="p-4 space-y-3">
          <div className="relative">
            <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="w-full h-10 pl-9 pr-3 rounded-xl bg-white/[0.05] border border-white/10 text-[13.5px] focus:outline-none focus:border-white/25" />
          </div>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic"
            className="w-full h-10 px-3.5 rounded-xl bg-white/[0.05] border border-white/10 text-[13.5px] placeholder:text-white/25 focus:outline-none focus:border-white/25" />
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="checkbox" checked={announceOnly} onChange={(e) => setAnnounceOnly(e.target.checked)} className="mt-1" />
            <span>
              <span className="text-[13px] font-semibold flex items-center gap-1.5"><Megaphone className="w-3.5 h-3.5" /> Announcements only</span>
              <span className="text-[11.5px] text-white/40 block">Leadership posts, everyone reads.</span>
            </span>
          </label>
        </div>
        <div className="p-4 pt-1 space-y-2">
          <button onClick={save} disabled={!name.trim() || busy}
            className="w-full h-11 rounded-xl font-bold text-[14px] disabled:opacity-30" style={{ background: GOLD, color: "#0b0b08" }}>
            {busy ? "Saving…" : "Save changes"}
          </button>
          {!channel.isDefault && (
            <button onClick={archive} disabled={busy}
              className="w-full h-10 rounded-xl text-[13px] font-semibold text-red-400/80 hover:text-red-400 border border-red-500/20 hover:border-red-500/40 transition-colors">
              Archive channel
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
