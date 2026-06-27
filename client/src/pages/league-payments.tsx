import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { formatCurrency } from "@/lib/format";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Mail, Phone, Users, CreditCard } from "lucide-react";
import type { LeagueCompetition } from "@shared/schema";

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

export default function LeaguePayments() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const [termId, setTermId] = useState<number | null>(null);

  const { data: terms = [] } = useQuery<LeagueCompetition[]>({
    queryKey: ["/api/admin/league/competitions", { orgId }],
    queryFn: () => fetch(`/api/admin/league/competitions?orgId=${orgId}`).then(r => r.json()),
    enabled: !!orgId,
  });

  const activeTermId = termId ?? terms[0]?.id ?? null;

  const { data: regs = [], isLoading } = useQuery<LeagueReg[]>({
    queryKey: ["/api/admin/league/competitions", activeTermId, "registrations"],
    queryFn: () => fetch(`/api/admin/league/competitions/${activeTermId}/registrations`).then(r => r.json()),
    enabled: !!activeTermId,
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
          <p className="text-sm text-white/40 mt-1">What's been collected across the league</p>
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
                {["Team", "League", "Captain", "Status", "Paid", "Balance"].map(h => (
                  <th key={h} className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {regs.map(r => (
                <tr key={r.id} className="border-b border-white/[0.02]" data-testid={`pay-row-${r.id}`}>
                  <td className="px-4 py-2.5 text-sm text-white/80 font-medium">{r.teamName || `#${r.id}`}</td>
                  <td className="px-4 py-2.5 text-sm text-white/50">{r.divisionName || "—"}</td>
                  <td className="px-4 py-2.5 text-sm text-white/60">
                    <div>{r.captainName}</div>
                    <div className="flex items-center gap-3 text-[11px] text-white/30 mt-0.5">
                      {r.captainEmail && <a href={`mailto:${r.captainEmail}`} className="flex items-center gap-1 hover:text-white/50"><Mail className="w-3 h-3" />{r.captainEmail}</a>}
                      {r.captainPhone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{r.captainPhone}</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${PAY_BADGE[r.paymentStatus] || PAY_BADGE.unpaid}`}>
                      {PAY_LABEL[r.paymentStatus] || "Unpaid"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-sm text-white/60">${r.amountPaid || "0.00"}</td>
                  <td className="px-4 py-2.5 text-sm">
                    {r.balanceStatus && r.balanceStatus !== "paid" && r.balanceStatus !== "none" && (r.balanceCents || 0) > 0 ? (
                      <span className="text-yellow-400/80">
                        {formatCurrency(r.balanceCents || 0, { fromCents: true })}
                        {r.paymentMode === "deposit_weekly"
                          ? <span className="text-white/30"> · weekly</span>
                          : r.balanceDueDate && <span className="text-white/30"> · due {new Date(r.balanceDueDate + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}</span>}
                        {r.balanceStatus === "failed" && <span className="text-red-400"> · failed</span>}
                      </span>
                    ) : <span className="text-white/20">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
