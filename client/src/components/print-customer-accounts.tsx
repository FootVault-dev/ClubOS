// ─────────────────────────────────────────────────────────────────────────────
// Trade accounts — Dima's panel inside the United Prints CRM tab.
//
// Who has signed in at join.unitedprints.co.nz/account, what they've spent, and
// the one control that matters: the discount they get.
//
// 🔴 Every account starts at 0%. Daniel's rule (2026-09-03) is that signing up
// gets you an account and nothing else — a trade rate is a decision somebody
// here makes. The database refuses to store a discount without an approver, and
// the approver is taken from the session, so this panel cannot grant one
// anonymously even if it tried.
// ─────────────────────────────────────────────────────────────────────────────
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Users, Search, ShieldCheck, Ban, RotateCcw } from "lucide-react";

type Account = {
  id: number;
  email: string;
  name: string | null;
  phone: string | null;
  company: string | null;
  tier: string;
  discountPct: number;
  approvedAt: string | null;
  approvalNote: string | null;
  approvedBy: string | null;
  disabledAt: string | null;
  lastLoginAt: string | null;
  createdAt: string | null;
  orderCount: number;
  paidCents: number;
};

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function when(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
}

export default function PrintCustomerAccounts() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [pct, setPct] = useState("0");
  const [note, setNote] = useState("");

  const { data, isLoading, isError, refetch } = useQuery<{ customers: Account[] }>({
    queryKey: ["/api/admin/print-customers"],
    queryFn: async () => {
      const r = await fetch("/api/admin/print-customers", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load");
      return r.json();
    },
  });

  const save = useMutation({
    mutationFn: async ({ id, ...body }: any) =>
      (await apiRequest("PATCH", `/api/admin/print-customers/${id}`, body)).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/print-customers"] });
      setEditingId(null);
      toast({ title: "Account updated" });
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  const accounts = (data?.customers ?? []).filter((a) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [a.email, a.name, a.company].filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
  });

  // 🔴 Four states, never 200-with-zeros: loading, failed, genuinely empty,
  // and real rows. An empty list here is a real answer — nobody has signed up.
  if (isLoading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Loading accounts…</p>;
  }
  if (isError) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm font-medium">Couldn't load customer accounts</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
          <RotateCcw className="mr-2 h-4 w-4" /> Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Users className="h-5 w-5" /> Trade accounts
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Customers who sign in at join.unitedprints.co.nz/account. Everyone starts on standard
            pricing — set a percentage here to give someone a trade rate.
          </p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, business"
            className="pl-9"
          />
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="font-medium">
            {data?.customers.length === 0 ? "No customer accounts yet" : "Nothing matches that search"}
          </p>
          {data?.customers.length === 0 && (
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              The first customer to sign in at join.unitedprints.co.nz/account will appear here.
            </p>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {accounts.map((a) => {
            const editing = editingId === a.id;
            return (
              <li key={a.id} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <span className="truncate">{a.name || a.email}</span>
                      {a.discountPct > 0 && (
                        <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                          {a.discountPct}% trade
                        </Badge>
                      )}
                      {a.disabledAt && <Badge variant="destructive">Disabled</Badge>}
                    </p>
                    <p className="mt-0.5 truncate text-sm text-muted-foreground">
                      {a.email}
                      {a.company ? ` · ${a.company}` : ""}
                      {a.phone ? ` · ${a.phone}` : ""}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {a.orderCount} order{a.orderCount === 1 ? "" : "s"} · {money(a.paidCents)} paid ·
                      joined {when(a.createdAt)} · last signed in {when(a.lastLoginAt)}
                    </p>
                    {a.discountPct > 0 && (
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-emerald-700">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        {/* Null approver reads as unknown, never as nobody. */}
                        Approved by {a.approvedBy ?? "someone no longer on the team"} on {when(a.approvedAt)}
                        {a.approvalNote ? ` — ${a.approvalNote}` : ""}
                      </p>
                    )}
                  </div>

                  {!editing && (
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => { setEditingId(a.id); setPct(String(a.discountPct)); setNote(a.approvalNote ?? ""); }}
                      >
                        {a.discountPct > 0 ? "Change rate" : "Give trade rate"}
                      </Button>
                      <Button
                        size="sm"
                        variant={a.disabledAt ? "outline" : "ghost"}
                        onClick={() => save.mutate({ id: a.id, disabled: !a.disabledAt })}
                        title={a.disabledAt ? "Re-open this account" : "Close this account and sign them out"}
                      >
                        {a.disabledAt ? <RotateCcw className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
                      </Button>
                    </div>
                  )}
                </div>

                {editing && (
                  <form
                    className="mt-4 space-y-3 border-t pt-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const n = Number(pct);
                      if (!Number.isFinite(n) || n < 0 || n > 100) {
                        toast({ title: "Enter a percentage between 0 and 100", variant: "destructive" });
                        return;
                      }
                      save.mutate({
                        id: a.id,
                        discountPct: Math.round(n),
                        tier: Math.round(n) > 0 ? "trade" : "standard",
                        approvalNote: note || null,
                      });
                    }}
                  >
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="w-32">
                        <label className="mb-1 block text-sm font-medium">Discount %</label>
                        <Input
                          inputMode="numeric"
                          value={pct}
                          onChange={(e) => setPct(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
                        />
                      </div>
                      <div className="min-w-[200px] flex-1">
                        <label className="mb-1 block text-sm font-medium">Why (optional)</label>
                        <Input
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder="e.g. agreed with Dima, 20+ banners a year"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Applies to everything they price while signed in — after any quantity discount,
                      but never below the shop minimum. Setting it to 0 puts them back on standard
                      pricing. Your name is recorded against the change.
                    </p>
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" disabled={save.isPending}>
                        {save.isPending ? "Saving…" : "Save"}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
