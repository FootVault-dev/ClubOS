import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Inbox, Globe, Mail, Instagram, Facebook, MessageCircle, X, Phone, Reply, Check, Archive } from "lucide-react";

// CUGC (Christchurch United Gymnastics Club) website enquiries from cugc.co.nz.
// Self-contained copy of the CIC inbox, scoped to the CUGC org via the
// /api/admin/cugc/inbox endpoints (leaves the MFL and CIC inboxes untouched).
type Msg = {
  id: number; channel: string; name: string | null; email: string | null; phone: string | null;
  subject: string | null; body: string; status: string; sourceUrl: string | null; createdAt: string;
};

const CHANNEL: Record<string, { label: string; icon: any; cls: string }> = {
  web_form: { label: "Website", icon: Globe, cls: "bg-blue-500/15 text-blue-300" },
  email: { label: "Email", icon: Mail, cls: "bg-violet-500/15 text-violet-300" },
  instagram: { label: "Instagram", icon: Instagram, cls: "bg-pink-500/15 text-pink-300" },
  facebook: { label: "Facebook", icon: Facebook, cls: "bg-sky-500/15 text-sky-300" },
  livechat: { label: "Live chat", icon: MessageCircle, cls: "bg-green-500/15 text-green-300" },
};
const STATUS_CLS: Record<string, string> = {
  new: "bg-amber-500/15 text-amber-300", read: "bg-white/10 text-white/50",
  replied: "bg-green-500/15 text-green-300", archived: "bg-white/[0.06] text-white/30",
};

const fmt = (d: string) => new Date(d).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export default function CugcInbox() {
  const [filter, setFilter] = useState<"all" | "new" | "replied" | "archived">("all");
  const [selected, setSelected] = useState<Msg | null>(null);

  const { data: messages = [], isLoading } = useQuery<Msg[]>({
    queryKey: ["/api/admin/cugc/inbox"],
    queryFn: () => fetch("/api/admin/cugc/inbox").then((r) => r.json()),
  });

  const shown = messages.filter((m) => filter === "all" ? m.status !== "archived" : m.status === filter);
  const stats = [
    { label: "All open", value: messages.filter((m) => m.status !== "archived").length },
    { label: "New", value: messages.filter((m) => m.status === "new").length },
    { label: "Replied", value: messages.filter((m) => m.status === "replied").length },
    { label: "Archived", value: messages.filter((m) => m.status === "archived").length },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Inbox</h1>
          <p className="text-sm text-white/40 mt-1">Enquiries from cugc.co.nz — also emailed to info@cugc.co.nz</p>
        </div>
        <div className="inline-flex rounded-lg border border-white/5 bg-white/[0.02] p-0.5">
          {(["all", "new", "replied", "archived"] as const).map((v) => (
            <button key={v} onClick={() => setFilter(v)} className={`text-xs font-medium px-3 py-1.5 rounded-md capitalize transition-colors ${filter === v ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}>{v}</button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {stats.map((s, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <p className="text-[10px] uppercase tracking-wider text-white/30">{s.label}</p>
            <p className="text-lg font-bold text-white mt-0.5">{s.value}</p>
          </div>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-white/20 text-sm">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <div className="flex flex-col items-center justify-center py-16 text-white/20">
            <Inbox className="w-12 h-12 mb-3" />
            <p className="text-sm">No enquiries yet.</p>
            <p className="text-xs mt-1">Contact, register and newsletter submissions from cugc.co.nz land here.</p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {shown.map((m) => {
            const ch = CHANNEL[m.channel] || CHANNEL.web_form;
            return (
              <button key={m.id} onClick={() => setSelected(m)} className="w-full text-left rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] transition-colors p-4 flex items-start gap-3" data-testid={`cugc-inbox-row-${m.id}`}>
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${ch.cls}`}><ch.icon className="w-4 h-4" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-white/90 truncate">{m.name || m.email || "Unknown"}</span>
                    {m.status === "new" && <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />}
                    <span className="ml-auto text-[11px] text-white/30 shrink-0">{fmt(m.createdAt)}</span>
                  </div>
                  <div className="text-[13px] text-white/55 truncate mt-0.5">{m.subject ? <span className="text-white/70">{m.subject} · </span> : null}{m.body}</div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${ch.cls}`}>{ch.label}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full capitalize ${STATUS_CLS[m.status] || STATUS_CLS.read}`}>{m.status}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {selected && <MessageModal msg={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function MessageModal({ msg, onClose }: { msg: Msg; onClose: () => void }) {
  const { toast } = useToast();
  const ch = CHANNEL[msg.channel] || CHANNEL.web_form;
  const setStatus = useMutation({
    mutationFn: (status: string) => apiRequest("POST", `/api/admin/cugc/inbox/${msg.id}/status`, { status }).then((r) => r.json()),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/cugc/inbox"] }); },
    onError: (e: any) => toast({ title: "Couldn't update", description: e.message, variant: "destructive" }),
  });
  const replyHref = msg.email
    ? `mailto:${msg.email}?subject=${encodeURIComponent("Re: " + (msg.subject || "your enquiry — Christchurch United Gymnastics Club"))}`
    : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-[#011a48] border border-blue-500/20 rounded-2xl w-full max-w-lg shadow-2xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${ch.cls}`}><ch.icon className="w-4 h-4" /></span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-white truncate">{msg.name || msg.email || "Unknown"}</h2>
              <p className="text-xs text-white/40">{ch.label} · {fmt(msg.createdAt)}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-[12px] text-white/50">
            {msg.email && <a href={`mailto:${msg.email}`} className="flex items-center gap-1.5 hover:text-white/80"><Mail className="w-3.5 h-3.5" />{msg.email}</a>}
            {msg.phone && <a href={`tel:${msg.phone}`} className="flex items-center gap-1.5 hover:text-white/80"><Phone className="w-3.5 h-3.5" />{msg.phone}</a>}
          </div>
          {msg.subject && <p className="text-sm font-semibold text-white">{msg.subject}</p>}
          <p className="text-sm leading-relaxed text-white/75 whitespace-pre-wrap">{msg.body}</p>
          {msg.sourceUrl && <p className="text-[11px] text-white/30">via {msg.sourceUrl}</p>}
        </div>
        <div className="p-4 border-t border-white/5 flex flex-wrap items-center gap-2">
          {replyHref && <a href={replyHref} onClick={() => setStatus.mutate("replied")} className="flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg bg-[#d9b10f] text-black hover:brightness-110"><Reply className="w-3.5 h-3.5" /> Reply via email</a>}
          <button onClick={() => setStatus.mutate("replied")} disabled={setStatus.isPending} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-white/10 text-white hover:bg-white/15 disabled:opacity-50"><Check className="w-3.5 h-3.5" /> Mark replied</button>
          <button onClick={() => setStatus.mutate("read")} disabled={setStatus.isPending} className="text-xs font-medium px-3 py-2 rounded-lg text-white/60 hover:bg-white/10">Mark read</button>
          <button onClick={() => { setStatus.mutate("archived"); onClose(); }} disabled={setStatus.isPending} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg text-white/40 hover:text-white/70 ml-auto"><Archive className="w-3.5 h-3.5" /> Archive</button>
        </div>
      </div>
    </div>
  );
}
