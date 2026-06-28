import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/format";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Mail, Phone, Users, CreditCard, X, Check, AlertTriangle, ChevronRight, Crown, RotateCw } from "lucide-react";
import type { LeagueCompetition } from "@shared/schema";

type AdminView = "registrations" | "splits";

type LeagueReg = {
  id: number; teamName: string | null; status: string; divisionName: string | null;
  captainName: string; captainEmail: string | null; captainPhone: string | null;
  totalCents: number | null; amountPaid: string | null; paymentMode: string | null;
  depositCents: number | null; balanceCents: number | null; balanceDueDate: string | null;
  balanceStatus: string | null; paymentStatus: string; registeredAt: string;
};

const PAY_BADGE: Record<string, string> = {
  paid_in_full: "bg-green-500/15 text-green-400",
  deposit_paid: "bg-yellow-500/15 text-yellow-400",
  refunded: "bg-red-500/15 text-red-400",
  partially_refunded: "bg-orange-500/15 text-orange-400",
  unpaid: "bg-white/10 text-white/40",
};
const PAY_LABEL: Record<string, string> = {
  paid_in_full: "Paid", deposit_paid: "Deposit", refunded: "Refunded", partially_refunded: "Part. refund", unpaid: "Unpaid",
};

// How the team is paying — Player Pay (split across squad), Play Now Pay Later
// (deposit + weekly instalments), or Card (paid upfront in one go).
const METHOD_BADGE: Record<string, string> = {
  split: "bg-violet-500/15 text-violet-300",
  weekly: "bg-sky-500/15 text-sky-300",
  card: "bg-white/10 text-white/55",
};
const METHOD_LABEL: Record<string, string> = {
  split: "Player Pay", weekly: "Play Now, Pay Later", card: "Card",
};
function methodKey(mode: string | null): "split" | "weekly" | "card" {
  if (mode === "split") return "split";
  if (mode === "deposit_weekly" || mode === "weekly") return "weekly";
  return "card";
}

export default function LeaguePayments() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const [selected, setSelected] = useState<LeagueReg | null>(null);
  const [termId, setTermId] = useState<number | null>(null);
  const [view, setView] = useState<AdminView>("registrations");

  const { data: terms = [] } = useQuery<LeagueCompetition[]>({
    queryKey: ["/api/admin/league/competitions", { orgId }],
    queryFn: () => fetch(`/api/admin/league/competitions?orgId=${orgId}`).then(r => r.json()),
    enabled: !!orgId,
  });

  const activeTermId = termId ?? terms[0]?.id ?? null;

  const { data: regs = [], isLoading } = useQuery<LeagueReg[]>({
    queryKey: ["/api/admin/league/competitions", activeTermId, "registrations"],
    queryFn: () => fetch(`/api/admin/league/competitions/${activeTermId}/registrations`).then(r => r.json()),
    enabled: !!activeTermId && view === "registrations",
  });

  const paid = regs.filter(r => r.paymentStatus === "paid_in_full").length;
  const deposit = regs.filter(r => r.paymentStatus === "deposit_paid").length;
  const collected = regs.reduce((s, r) => s + (parseFloat(r.amountPaid || "0") || 0), 0);
  const balanceOwed = regs.reduce((s, r) => s + (r.balanceStatus && r.balanceStatus !== "paid" ? (r.balanceCents || 0) : 0), 0);

  const stats = [
    { label: "Teams", value: regs.length },
    { label: "Collected", value: `$${collected.toFixed(2)}` },
    { label: "Paid in full", value: paid },
    { label: "Deposit only", value: deposit },
    { label: "Balance owed", value: formatCurrency(balanceOwed, { fromCents: true }) },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Payments</h1>
          <p className="text-sm text-white/40 mt-1">{view === "splits" ? "Player Pay teams — who's paid, who to follow up" : "What's been collected across the league"}</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="inline-flex rounded-lg border border-white/5 bg-white/[0.02] p-0.5" data-testid="payments-view-toggle">
            {([["registrations", "Registrations"], ["splits", "Player Pay"]] as const).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                data-testid={`view-${v}`}
                className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${view === v ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {terms.length > 0 && (
            <Select value={activeTermId ? String(activeTermId) : ""} onValueChange={v => setTermId(parseInt(v))}>
              <SelectTrigger className="premium-input text-white w-[240px]"><SelectValue placeholder="Term" /></SelectTrigger>
              <SelectContent>
                {terms.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {view === "splits" ? (
        <SplitsView competitionId={activeTermId} />
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {stats.map((s, i) => (
              <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                <p className="text-[10px] uppercase tracking-wider text-white/30">{s.label}</p>
                <p className="text-lg font-bold text-white mt-0.5">{s.value}</p>
              </div>
            ))}
          </div>

          {isLoading ? (
            <div className="text-center py-12 text-white/20 text-sm">Loading…</div>
          ) : regs.length === 0 ? (
            <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
              <div className="flex flex-col items-center justify-center py-16 text-white/20">
                <CreditCard className="w-12 h-12 mb-3" />
                <p className="text-sm">No payments yet</p>
                <p className="text-xs mt-1">Team payments appear here as captains register</p>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-x-auto">
              <table className="w-full min-w-[760px]">
                <thead>
                  <tr className="border-b border-white/5">
                    {["Team", "League", "Signed up", "Captain", "Method", "Status", "Paid", "Balance"].map(h => (
                      <th key={h} className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {regs.map(r => (
                    <tr key={r.id} onClick={() => setSelected(r)} className="border-b border-white/[0.02] hover:bg-white/[0.03] cursor-pointer transition-colors group" data-testid={`pay-row-${r.id}`}>
                      <td className="px-4 py-2.5 text-sm text-white/80 font-medium">{r.teamName || `#${r.id}`}</td>
                      <td className="px-4 py-2.5 text-sm text-white/50">{r.divisionName || "—"}</td>
                      <td className="px-4 py-2.5 text-sm text-white/50 whitespace-nowrap">
                        {r.registeredAt ? (() => { const d = new Date(r.registeredAt); return (<><div>{d.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}</div><div className="text-[11px] text-white/30">{d.toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" })}</div></>); })() : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-white/60">
                        <div>{r.captainName}</div>
                        <div className="flex items-center gap-3 text-[11px] text-white/30 mt-0.5">
                          {r.captainEmail && <a href={`mailto:${r.captainEmail}`} onClick={e => e.stopPropagation()} className="flex items-center gap-1 hover:text-white/50"><Mail className="w-3 h-3" />{r.captainEmail}</a>}
                          {r.captainPhone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{r.captainPhone}</span>}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full ${METHOD_BADGE[methodKey(r.paymentMode)]}`}>
                          {METHOD_LABEL[methodKey(r.paymentMode)]}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full ${PAY_BADGE[r.paymentStatus] || PAY_BADGE.unpaid}`}>
                          {PAY_LABEL[r.paymentStatus] || "Unpaid"}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-sm text-white/60">${r.amountPaid || "0.00"}</td>
                      <td className="px-4 py-2.5 text-sm">
                        {r.balanceStatus && r.balanceStatus !== "paid" && r.balanceStatus !== "none" && (r.balanceCents || 0) > 0 ? (
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <div className="text-yellow-400/80">{formatCurrency(r.balanceCents || 0, { fromCents: true })}{r.balanceStatus === "failed" && <span className="text-red-400"> · failed</span>}</div>
                              <div className="text-[11px] text-white/30">remaining{r.paymentMode === "deposit_weekly" ? " · weekly" : r.balanceDueDate ? ` · due ${new Date(r.balanceDueDate + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}` : ""}</div>
                            </div>
                            <ChevronRight className="w-4 h-4 text-white/20 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                          </div>
                        ) : (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-white/20">—</span>
                            <ChevronRight className="w-4 h-4 text-white/20 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {selected && <PaymentBreakdownModal reg={selected} onClose={() => setSelected(null)} />}
        </>
      )}
    </div>
  );
}

type Breakdown = {
  teamName: string | null; paymentMode: string | null; totalCents: number; depositCents: number;
  weeklyAmountCents: number; weeksTotal: number; weeksPaid: number; paidCents: number; remainingCents: number;
  deposit: { amountCents: number; status: string; paidAt: string | null };
  weeks: { week: number; dueDate: string | null; amountCents: number; status: string; paidAt: string | null }[];
};

const STATUS: Record<string, { bar: string; text: string; label: string }> = {
  paid: { bar: "bg-green-500", text: "text-green-400", label: "Paid" },
  failed: { bar: "bg-red-500", text: "text-red-400", label: "Missed / failed" },
  upcoming: { bar: "bg-amber-500", text: "text-amber-400", label: "Up next" },
  scheduled: { bar: "bg-white/10", text: "text-white/30", label: "Scheduled" },
  pending: { bar: "bg-white/10", text: "text-white/30", label: "Pending" },
};
const fmtDate = (d: string | null) => d ? new Date(d.length <= 10 ? d + "T12:00:00" : d).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "—";

function PaymentBreakdownModal({ reg, onClose }: { reg: LeagueReg; onClose: () => void }) {
  const { data: bd, isLoading } = useQuery<Breakdown>({
    queryKey: ["/api/admin/league/registrations", reg.id, "payment-breakdown"],
    queryFn: () => fetch(`/api/admin/league/registrations/${reg.id}/payment-breakdown`).then(r => r.json()),
  });

  const items = bd ? [
    { label: "Deposit", amountCents: bd.deposit.amountCents, status: bd.deposit.status, date: bd.deposit.paidAt, isPaid: bd.deposit.status === "paid" },
    ...bd.weeks.map(w => ({ label: `Week ${w.week}`, amountCents: w.amountCents, status: w.status, date: w.status === "paid" ? w.paidAt : w.dueDate, isPaid: w.status === "paid" })),
  ] : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-lg shadow-2xl max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-white">{reg.teamName || `#${reg.id}`}</h2>
              <span className={`text-[10px] px-2 py-0.5 rounded-full ${METHOD_BADGE[methodKey(reg.paymentMode)]}`}>{METHOD_LABEL[methodKey(reg.paymentMode)]}</span>
            </div>
            <p className="text-xs text-white/40 mt-0.5">{reg.captainName}{reg.divisionName ? ` · ${reg.divisionName}` : ""}</p>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>

        {isLoading || !bd ? (
          <div className="p-10 text-center text-white/20 text-sm">Loading…</div>
        ) : (
          <div className="p-5 overflow-y-auto flex-1 space-y-5">
            {reg.paymentMode === "split" && (
              <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.06] px-3 py-2.5 text-[11px] text-violet-200/80 leading-relaxed">
                Funded via <span className="font-semibold">Player Pay</span> — each player paid their own share. Open the <span className="font-semibold">Player Pay</span> tab to see who's paid and chase anyone outstanding.
              </div>
            )}
            {/* Summary */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Total", value: formatCurrency(bd.totalCents, { fromCents: true }) },
                { label: "Paid", value: formatCurrency(bd.paidCents, { fromCents: true }), klass: "text-green-400" },
                { label: "Remaining", value: formatCurrency(bd.remainingCents, { fromCents: true }), klass: bd.remainingCents > 0 ? "text-yellow-400" : "text-white/60" },
              ].map((s, i) => (
                <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
                  <p className="text-[10px] uppercase tracking-wider text-white/30">{s.label}</p>
                  <p className={`text-base font-bold mt-0.5 ${s.klass || "text-white"}`}>{s.value}</p>
                </div>
              ))}
            </div>

            {/* Segmented progress bar */}
            <div className="flex gap-1">
              {items.map((it, i) => (
                <div key={i} className={`h-2 flex-1 rounded-full ${STATUS[it.status]?.bar || "bg-white/10"}`} title={`${it.label}: ${STATUS[it.status]?.label || it.status}`} />
              ))}
            </div>

            {/* Per-payment rows */}
            <div className="space-y-1.5">
              {items.map((it, i) => {
                const st = STATUS[it.status] || STATUS.scheduled;
                return (
                  <div key={i} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5">
                    <div className={`w-1.5 h-9 rounded-full flex-shrink-0 ${st.bar}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-white/80">{it.label}</span>
                        <span className="text-sm font-semibold text-white">{formatCurrency(it.amountCents, { fromCents: true })}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-0.5">
                        <span className={`text-[11px] ${st.text}`}>
                          {it.status === "paid" && <Check className="w-3 h-3 inline -mt-0.5 mr-0.5" />}
                          {it.status === "failed" && <AlertTriangle className="w-3 h-3 inline -mt-0.5 mr-0.5" />}
                          {st.label}
                        </span>
                        <span className="text-[11px] text-white/30">{it.isPaid ? "paid" : it.status === "scheduled" || it.status === "upcoming" ? "due" : "due"} {fmtDate(it.date)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {bd.paymentMode === "deposit_weekly" && (
              <p className="text-[11px] text-white/30 leading-relaxed">
                Charged automatically each week to the card on file. The deposit covers the final weeks, so the total comes to exactly {formatCurrency(bd.totalCents, { fromCents: true })}. A red bar means a charge was missed or failed — chase that captain.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Player Pay — monitoring + follow-up view
   Captains split an MFL team fee across their squad; each player pays their own
   share on the spot (charge-on-pay). Coordinators watch progress here — who's
   paid vs outstanding (with contact details to chase) — and can cancel + refund.
   ────────────────────────────────────────────────────────────────────────── */

type SplitRow = {
  id: number; shareCode: string; teamName: string | null; divisionName: string | null;
  status: "open" | "settling" | "settled" | "cancelled" | "failed";
  totalCents: number; targetCount: number | null; joinedCount: number; cardCount: number; paidCount: number;
  collectedCents: number; createdAt: string; lockedAt: string | null; settledAt: string | null;
};

// open=neutral · settling=amber/gold · settled=green · cancelled=grey · failed=red
const SPLIT_BADGE: Record<string, string> = {
  open: "bg-white/10 text-white/60",
  settling: "bg-amber-500/15 text-amber-400",
  settled: "bg-green-500/15 text-green-400",
  cancelled: "bg-white/[0.06] text-white/30",
  failed: "bg-red-500/15 text-red-400",
};
const SPLIT_LABEL: Record<string, string> = {
  open: "Open", settling: "Settling", settled: "Settled", cancelled: "Cancelled", failed: "Failed",
};

function SplitsView({ competitionId }: { competitionId: number | null }) {
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data: splits = [], isLoading } = useQuery<SplitRow[]>({
    queryKey: ["/api/admin/league/splits", competitionId],
    queryFn: () => fetch(`/api/admin/league/splits?competitionId=${competitionId}`).then(r => r.json()),
    enabled: !!competitionId,
  });

  const settled = splits.filter(s => s.status === "settled").length;
  const inProgress = splits.filter(s => s.status === "open" || s.status === "settling").length;
  const collected = splits.reduce((a, s) => a + (s.collectedCents || 0), 0);
  const totalFees = splits.reduce((a, s) => a + (s.totalCents || 0), 0);

  const stats = [
    { label: "Splits", value: splits.length },
    { label: "Collected", value: formatCurrency(collected, { fromCents: true }) },
    { label: "Total fees", value: formatCurrency(totalFees, { fromCents: true }) },
    { label: "Settled", value: settled },
    { label: "In progress", value: inProgress },
  ];

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {stats.map((s, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <p className="text-[10px] uppercase tracking-wider text-white/30">{s.label}</p>
            <p className="text-lg font-bold text-white mt-0.5">{s.value}</p>
          </div>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-white/20 text-sm">Loading…</div>
      ) : splits.length === 0 ? (
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <div className="flex flex-col items-center justify-center py-16 text-white/20">
            <Users className="w-12 h-12 mb-3" />
            <p className="text-sm">No Player Pay teams yet for this term.</p>
            <p className="text-xs mt-1">They appear here when a captain splits a team fee across their squad</p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead>
              <tr className="border-b border-white/5">
                {["Team", "League", "Status", "Progress", "Collected"].map(h => (
                  <th key={h} className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {splits.map(s => {
                return (
                  <tr key={s.id} onClick={() => setSelectedId(s.id)} className="border-b border-white/[0.02] hover:bg-white/[0.03] cursor-pointer transition-colors group" data-testid={`split-row-${s.id}`}>
                    <td className="px-4 py-2.5 text-sm text-white/80 font-medium">{s.teamName || `#${s.id}`}</td>
                    <td className="px-4 py-2.5 text-sm text-white/50">{s.divisionName || "—"}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${SPLIT_BADGE[s.status] || SPLIT_BADGE.open}`}>
                        {SPLIT_LABEL[s.status] || s.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-sm">
                      <div className="text-white/70">{s.paidCount}/{s.targetCount || s.joinedCount} paid</div>
                      <div className="text-[11px] text-white/30">{s.joinedCount} joined{s.targetCount ? ` of ${s.targetCount}` : ""}</div>
                    </td>
                    <td className="px-4 py-2.5 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className={s.collectedCents >= s.totalCents && s.totalCents > 0 ? "text-green-400/80" : "text-white/70"}>
                            {formatCurrency(s.collectedCents, { fromCents: true })}
                          </div>
                          <div className="text-[11px] text-white/30">of {formatCurrency(s.totalCents, { fromCents: true })}</div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-white/20 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selectedId !== null && (
        <SplitDetailModal splitId={selectedId} competitionId={competitionId} onClose={() => setSelectedId(null)} />
      )}
    </>
  );
}

type SplitMember = {
  id: number; name: string | null; email: string | null; phone: string | null;
  role: "organiser" | "member"; status: "joined" | "card_saved" | "paid" | "failed" | "removed";
  chargedCents: number | null; paidAt: string | null; stripeRefundStatus: string | null;
};
type SplitDetail = {
  session: {
    id: number; teamName: string | null; totalCents: number; status: string; shareCode: string;
    targetCount: number | null; shareLockedCents: number | null; lockedAt: string | null;
    settledAt: string | null; deadlineAt: string | null; createdAt: string;
    registrationId: number | null; leagueDivisionId: number;
  };
  members: SplitMember[];
};

const MEMBER_BADGE: Record<string, string> = {
  paid: "bg-green-500/15 text-green-400",
  card_saved: "bg-white/10 text-white/60",
  joined: "bg-white/10 text-white/40",
  failed: "bg-red-500/15 text-red-400",
  removed: "bg-white/[0.06] text-white/30",
};
const MEMBER_LABEL: Record<string, string> = {
  paid: "Paid", card_saved: "Card saved", joined: "Joined", failed: "Failed", removed: "Removed",
};

function SplitDetailModal({ splitId, competitionId, onClose }: { splitId: number; competitionId: number | null; onClose: () => void }) {
  const { toast } = useToast();
  const [collectResult, setCollectResult] = useState<{ charged: number; failed: number } | null>(null);

  const { data: detail, isLoading } = useQuery<SplitDetail>({
    queryKey: ["/api/admin/league/splits", splitId],
    queryFn: () => fetch(`/api/admin/league/splits/${splitId}`).then(r => r.json()),
  });

  // Auto-clear the collect result banner after a few seconds.
  useEffect(() => {
    if (!collectResult) return;
    const t = setTimeout(() => setCollectResult(null), 6000);
    return () => clearTimeout(t);
  }, [collectResult]);

  const refetchAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/league/splits", splitId] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/league/splits", competitionId] });
  };

  const collect = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/league/splits/${splitId}/collect`).then(r => r.json()),
    onSuccess: (r: { charged: number; failed: number }) => {
      setCollectResult({ charged: r.charged ?? 0, failed: r.failed ?? 0 });
      toast({ title: "Shares collected", description: `${r.charged ?? 0} charged · ${r.failed ?? 0} failed` });
      refetchAll();
    },
    onError: (e: any) => toast({ title: "Couldn't collect", description: e.message, variant: "destructive" }),
  });

  const cancel = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/league/splits/${splitId}/cancel`).then(r => r.json()),
    onSuccess: (r: { refunded?: number }) => {
      toast({ title: "Split cancelled", description: r.refunded ? `Refunded ${r.refunded} member${r.refunded === 1 ? "" : "s"}` : "No charges to refund" });
      refetchAll();
      onClose();
    },
    onError: (e: any) => toast({ title: "Couldn't cancel", description: e.message, variant: "destructive" }),
  });

  const s = detail?.session;
  const members = (detail?.members ?? []).filter(m => m.status !== "removed");
  const collected = members.reduce((a, m) => a + (m.status === "paid" ? (m.chargedCents ?? 0) : 0), 0);
  const paidCount = members.filter(m => m.status === "paid").length;
  const busy = collect.isPending || cancel.isPending;

  const handleCancel = () => {
    if (window.confirm("Cancel this split and refund anyone who's already been charged? This can't be undone.")) {
      cancel.mutate();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-lg shadow-2xl max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <div>
            <h2 className="text-lg font-semibold text-white">{s?.teamName || `Split #${splitId}`}</h2>
            <p className="text-xs text-white/40 mt-0.5">
              {s ? <><span className="font-mono">{s.shareCode}</span>{" · "}<span className={`text-[10px] px-1.5 py-0.5 rounded-full ${SPLIT_BADGE[s.status] || SPLIT_BADGE.open}`}>{SPLIT_LABEL[s.status] || s.status}</span></> : "Loading…"}
            </p>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>

        {isLoading || !s ? (
          <div className="p-10 text-center text-white/20 text-sm">Loading…</div>
        ) : (
          <div className="p-5 overflow-y-auto flex-1 space-y-5">
            {/* Summary */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Total", value: formatCurrency(s.totalCents, { fromCents: true }) },
                { label: "Collected", value: formatCurrency(collected, { fromCents: true }), klass: "text-green-400" },
                { label: "Paid", value: `${paidCount}/${s.targetCount || members.length}`, klass: paidCount < (s.targetCount || members.length) ? "text-yellow-400" : "text-white/60" },
              ].map((c, i) => (
                <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
                  <p className="text-[10px] uppercase tracking-wider text-white/30">{c.label}</p>
                  <p className={`text-base font-bold mt-0.5 ${c.klass || "text-white"}`}>{c.value}</p>
                </div>
              ))}
            </div>

            {/* Members */}
            <div className="space-y-1.5">
              {members.length === 0 ? (
                <p className="text-xs text-white/30 text-center py-4">No members have joined this split yet.</p>
              ) : members.map(m => {
                const st = MEMBER_BADGE[m.status] || MEMBER_BADGE.joined;
                return (
                  <div key={m.id} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {m.role === "organiser" && <Crown className="w-3 h-3 text-amber-400 flex-shrink-0" />}
                        <span className="text-sm font-medium text-white/80 truncate">{m.name || "—"}</span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-white/30 mt-0.5">
                        {m.email && <a href={`mailto:${m.email}`} onClick={e => e.stopPropagation()} className="flex items-center gap-1 hover:text-white/50 truncate"><Mail className="w-3 h-3 flex-shrink-0" />{m.email}</a>}
                        {m.phone && <span className="flex items-center gap-1 flex-shrink-0"><Phone className="w-3 h-3" />{m.phone}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {(m.chargedCents ?? 0) > 0 && <span className="text-sm font-semibold text-white">{formatCurrency(m.chargedCents ?? 0, { fromCents: true })}</span>}
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${st}`}>{MEMBER_LABEL[m.status] || m.status}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {collectResult && (
              <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-[11px] text-white/50">
                Last collect run: <span className="text-green-400">{collectResult.charged} charged</span>
                {collectResult.failed > 0 && <> · <span className="text-red-400">{collectResult.failed} failed</span></>}
              </div>
            )}

            {/* Recovery actions */}
            <div className="flex items-center gap-2 pt-1">
              {s.status === "settling" && (
                <button
                  onClick={() => collect.mutate()}
                  disabled={busy}
                  data-testid="split-collect"
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors disabled:opacity-50"
                >
                  <RotateCw className={`w-3.5 h-3.5 ${collect.isPending ? "animate-spin" : ""}`} />
                  {collect.isPending ? "Collecting…" : "Collect outstanding shares"}
                </button>
              )}
              {s.status !== "settled" && s.status !== "cancelled" && (
                <button
                  onClick={handleCancel}
                  disabled={busy}
                  data-testid="split-cancel"
                  className="text-xs font-medium px-3 py-2 rounded-lg text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50 ml-auto"
                >
                  {cancel.isPending ? "Cancelling…" : "Cancel & refund"}
                </button>
              )}
            </div>

            {s.status === "settling" && (
              <p className="text-[11px] text-white/30 leading-relaxed">
                Some members still owe their share. "Collect outstanding shares" re-charges any saved card that hasn't paid and settles the split once everyone's in.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
