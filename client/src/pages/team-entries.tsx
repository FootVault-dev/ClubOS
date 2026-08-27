// Team Pay — the staff board.
//
// Every team entered, its squad, who has paid, and the fill-in pool. Isaac runs
// the tournaments, so this is deliberately NOT super-admin locked — it is his
// board, reached in the CIC workspace under the "Ethnic" view.
//
// The three switches at the top are the whole go-live control: entries open,
// payments on, fill-in list open. Payments stay off until the venue is confirmed
// (Daniel's standing call) — with them off, teams can still enter and build
// their squads, which is what makes this testable without taking a cent.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Copy, ExternalLink, Mail, Send, Users, Wallet, UserSearch, ChevronDown, ChevronRight,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { PLAYER_STATUS_LABEL } from "@shared/teampay";

const money = (c: number | null | undefined) => `$${((c ?? 0) / 100).toFixed(2)}`;

const STATUS_STYLE: Record<string, string> = {
  paid: "text-emerald-300 bg-emerald-400/10 border-emerald-400/25",
  opened: "text-amber-300 bg-amber-400/10 border-amber-400/25",
  invited: "text-white/45 bg-white/5 border-white/10",
  declined: "text-rose-300 bg-rose-400/10 border-rose-400/25",
  removed: "text-white/30 bg-white/5 border-white/10",
};

export default function TeamEntries() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [tab, setTab] = useState<"entries" | "fillins">("entries");

  const { data, isLoading } = useQuery<any>({ queryKey: ["/api/admin/teampay/overview"] });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: any }) =>
      apiRequest("PATCH", `/api/admin/teampay/competitions/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/admin/teampay/overview"] }),
  });

  const resend = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/teampay/entries/${id}/resend-link`, {}),
  });

  if (isLoading) return <div className="p-8 text-white/50">Loading…</div>;

  const comps = data?.competitions ?? [];
  if (!comps.length) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold text-white">Team Entries</h1>
        <p className="mt-3 max-w-xl text-white/50">
          No competition is set up for team entries in this workspace yet. One row in
          <code className="mx-1 rounded bg-white/10 px-1.5 py-0.5 text-[13px]">teampay_competitions</code>
          turns it on — see <code className="rounded bg-white/10 px-1.5 py-0.5 text-[13px]">script/seed-teampay.ts</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8">
      <h1 className="text-2xl font-semibold text-white">Team Entries</h1>

      {comps.map((c: any) => (
        <div key={c.competition.id} className="mt-6">
          {/* ── switches ─────────────────────────────────────────────────── */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-white">{c.competition.name}</h2>
                <p className="mt-1 text-[13px] text-white/45">
                  {money(c.competition.feeCents)} per team · {c.competition.defaultSquadSize} players
                  by default · {money(Math.ceil(c.competition.feeCents / c.competition.defaultSquadSize))} each
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <LinkChip label="Entry page" url={c.entryUrl} />
                <LinkChip label="Fill-in signup" url={c.fillinUrl} />
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-2.5">
              <Switch label="Entries open" on={c.competition.entriesOpen}
                      onChange={(v) => patch.mutate({ id: c.competition.id, body: { entriesOpen: v } })} />
              <Switch label="Payments on" on={c.competition.paymentsEnabled} money
                      onChange={(v) => patch.mutate({ id: c.competition.id, body: { paymentsEnabled: v } })} />
              <Switch label="Fill-in list open" on={c.competition.fillinsOpen}
                      onChange={(v) => patch.mutate({ id: c.competition.id, body: { fillinsOpen: v } })} />
            </div>

            {!c.competition.paymentsEnabled && (
              <p className="mt-3 text-[13px] text-amber-300/80">
                Payments are off. Teams can enter and build squads; nobody is charged.
              </p>
            )}

            {/* ── totals ─────────────────────────────────────────────────── */}
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Teams in" value={String(c.totals.entries)} icon={Users} />
              <Stat label="Collected" value={money(c.totals.collectedCents)} icon={Wallet} />
              <Stat label="Outstanding" value={money(c.totals.outstandingCents)} />
              <Stat label="Fill-ins waiting" value={String(c.totals.fillinsAvailable)} icon={UserSearch} />
            </div>
          </div>

          {/* ── tabs ───────────────────────────────────────────────────────
              Two views of ONE competition's record — genuinely tabs, not
              primary navigation. The sidebar standard governs moving between
              sections, not between views of one thing. */}
          <div className="mt-5 flex gap-1 border-b border-white/10">
            {(["entries", "fillins"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                      className={`px-4 py-2.5 text-[14px] ${tab === t ? "border-b-2 border-amber-400 text-white" : "text-white/45"}`}>
                {t === "entries" ? `Teams (${c.entries.length})` : `Fill-in pool (${c.fillins.length})`}
              </button>
            ))}
          </div>

          {tab === "entries" ? (
            <div className="mt-4 space-y-2">
              {c.entries.length === 0 && (
                <p className="py-10 text-center text-white/40">No teams have entered yet.</p>
              )}
              {c.entries.map((e: any) => (
                <div key={e.id} className="rounded-xl border border-white/10 bg-white/[0.02]">
                  <button
                    className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 text-left"
                    onClick={() => setOpen((o) => ({ ...o, [e.id]: !o[e.id] }))}
                  >
                    {open[e.id] ? <ChevronDown size={16} className="text-white/40" /> : <ChevronRight size={16} className="text-white/40" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-white">{e.teamName}</div>
                      <div className="truncate text-[12px] text-white/45">
                        {e.managerName} · {e.managerEmail}
                        {e.community ? ` · ${e.community}` : ""}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[14px] text-white">
                        {money(e.money.paidCents)} <span className="text-white/35">/ {money(e.feeCents)}</span>
                      </div>
                      <div className="text-[12px] text-white/45">
                        {e.money.paidCount}/{e.squadSize} paid
                      </div>
                    </div>
                    {e.paidUpAt && (
                      <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-300">
                        Paid up
                      </span>
                    )}
                  </button>

                  {open[e.id] && (
                    <div className="border-t border-white/10 px-4 py-4">
                      <div className="mb-3 flex flex-wrap gap-2">
                        <LinkChip label="Manager's dashboard" url={e.dashboardUrl} />
                        <button
                          className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-[13px] text-white/70 hover:bg-white/5"
                          onClick={() => resend.mutate(e.id)}
                        >
                          <Send size={13} /> {resend.isPending ? "Sending…" : "Email them the link"}
                        </button>
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[560px] text-[13px]">
                          <thead className="text-left text-white/40">
                            <tr>
                              <th className="pb-2 font-medium">Player</th>
                              <th className="pb-2 font-medium">Contact</th>
                              <th className="pb-2 font-medium">Status</th>
                              <th className="pb-2 text-right font-medium">Paid</th>
                              <th className="pb-2 text-right font-medium">Opens / nudges</th>
                            </tr>
                          </thead>
                          <tbody>
                            {e.players.map((p: any) => (
                              <tr key={p.id} className="border-t border-white/5">
                                <td className="py-2 text-white">
                                  {p.name}
                                  {p.isManager && <span className="ml-2 text-[11px] text-white/35">manager</span>}
                                  {p.source === "fillin" && <span className="ml-2 text-[11px] text-amber-300/70">fill-in</span>}
                                </td>
                                <td className="py-2 text-white/50">{p.email || p.phone || "—"}</td>
                                <td className="py-2">
                                  <span className={`rounded-full border px-2 py-0.5 text-[11px] ${STATUS_STYLE[p.status]}`}>
                                    {PLAYER_STATUS_LABEL[p.status as keyof typeof PLAYER_STATUS_LABEL]}
                                  </span>
                                </td>
                                <td className="py-2 text-right text-white/70">
                                  {/* An unpaid player reads "—", never $0.00. */}
                                  {p.paidCents == null ? "—" : money(p.paidCents)}
                                </td>
                                <td className="py-2 text-right text-white/40">{p.openCount} / {p.nudgeCount}</td>
                              </tr>
                            ))}
                            {e.players.length === 0 && (
                              <tr><td colSpan={5} className="py-4 text-white/35">No squad added yet.</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[720px] text-[13px]">
                <thead className="bg-white/[0.03] text-left text-white/40">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Name</th>
                    <th className="px-4 py-2.5 font-medium">Contact</th>
                    <th className="px-4 py-2.5 font-medium">Position</th>
                    <th className="px-4 py-2.5 font-medium">From</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {c.fillins.map((f: any) => (
                    <tr key={f.id} className="border-t border-white/5">
                      <td className="px-4 py-2.5 text-white">{[f.firstName, f.lastName].filter(Boolean).join(" ")}</td>
                      {/* Staff DO see contact details — they are the ones who
                          field the phone call when something goes wrong. Team
                          managers do not, until the player accepts. */}
                      <td className="px-4 py-2.5 text-white/50">{f.email}{f.phone ? ` · ${f.phone}` : ""}</td>
                      <td className="px-4 py-2.5 text-white/60">{f.position || "—"}</td>
                      <td className="px-4 py-2.5 text-white/60">{f.fromWhere || "—"}</td>
                      <td className="px-4 py-2.5 text-white/60">{f.status}</td>
                    </tr>
                  ))}
                  {c.fillins.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-6 text-white/35">Nobody on the fill-in list yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Switch({ label, on, onChange, money: isMoney }: { label: string; on: boolean; onChange: (v: boolean) => void; money?: boolean }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-[13px] ${
        on
          ? isMoney
            ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
            : "border-amber-400/30 bg-amber-400/10 text-amber-300"
          : "border-white/12 text-white/45"
      }`}
      style={{ minHeight: 40 }}
    >
      <span className={`h-2 w-2 rounded-full ${on ? (isMoney ? "bg-emerald-400" : "bg-amber-400") : "bg-white/25"}`} />
      {label}
    </button>
  );
}

function Stat({ label, value, icon: Icon }: { label: string; value: string; icon?: any }) {
  return (
    <div className="rounded-lg border border-white/8 bg-white/[0.02] px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-white/35">
        {Icon && <Icon size={12} />} {label}
      </div>
      <div className="mt-1 text-[18px] font-semibold text-white">{value}</div>
    </div>
  );
}

function LinkChip({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex overflow-hidden rounded-lg border border-white/15">
      <a href={url} target="_blank" rel="noreferrer"
         className="inline-flex items-center gap-1.5 px-3 py-2 text-[13px] text-white/70 hover:bg-white/5">
        <ExternalLink size={13} /> {label}
      </a>
      <button
        className="border-l border-white/15 px-2.5 text-white/50 hover:bg-white/5"
        title="Copy link"
        onClick={async () => {
          try { await navigator.clipboard.writeText(url); } catch { window.prompt("Copy", url); }
          setCopied(true); setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Copy size={13} className={copied ? "text-emerald-400" : ""} />
      </button>
    </span>
  );
}
