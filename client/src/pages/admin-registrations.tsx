import { useState, useMemo, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatCurrency } from "@/lib/format";
import {
  OFFICE_PAYMENT_METHODS, isOfficePaymentMethod, paymentMethodLabel, describePaymentMethod,
} from "@shared/payments";
import { RegisterPlayerModal } from "./admin-register-player";
import {
  ClipboardCheck, Search, ChevronDown, ChevronUp, User, Phone, Mail,
  MapPin, Calendar, Clock, Baby, CreditCard, Pencil, X, Plus, Trash2, Check, Save,
  RotateCcw, AlertTriangle, Loader2,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/ui/money-input";

type RegItem = {
  id: number;
  childId: number;
  campDateId: number;
  productType: string;
  refundedAmountCents?: number | null;
  child?: { id: number; firstName: string; lastName: string; dateOfBirth?: string; gender?: string };
  campDate?: { id: number; date: string; campId: number };
};

type CampPricingItem = {
  id: number;
  campId: number;
  productType: string;
  priceCents: number;
};

type RegChild = {
  id: number;
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  gender?: string;
};

type Registration = {
  id: number;
  orderNumber?: number | null;
  programId: number;
  contactId: number;
  status: string;
  subtotalCents: number | null;
  discountCents: number | null;
  totalCents: number | null;
  registeredAt: string;
  registrationLocation?: string | null;
  referralSource?: string | null;
  refundedAt?: string | null;
  refundedAmountCents?: number | null;
  refundReason?: string | null;
  // Resolved server-side from refundedBy at read time. Null for refunds issued
  // before the audit trail existed.
  refundedByName?: string | null;
  stripeRefundId?: string | null;
  stripeRefundStatus?: string | null;
  stripePaymentIntentId?: string | null;
  // Office / walk-up payments: how it was tendered and who took it.
  paymentMethod?: string | null;
  paymentReference?: string | null;
  servedByUserId?: number | null;
  servedByName?: string | null;
  paidAt?: string | null;
  amountPaid?: string | null;
  contact?: { id?: number; firstName: string; lastName: string; email?: string; phone?: string; address?: string; dateOfBirth?: string; emergencyContact?: string; emergencyPhone?: string };
  // Present only when the parent is a DIFFERENT contact from the registration's
  // own contact — i.e. an academy enrolment, where the contact is the player.
  guardian?: { id?: number; firstName: string; lastName: string; email?: string; phone?: string; emergencyContact?: string; emergencyPhone?: string };
  program?: { id: number; name: string };
  items?: RegItem[];
  children?: RegChild[];
};

function formatDate(dateStr: string) {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" });
}

function formatProductType(pt: string) {
  if (pt === "FULL_DAY" || pt === "full_day") return "Full Day";
  if (pt === "MORNING" || pt === "morning") return "Morning";
  if (pt === "AFTERNOON" || pt === "afternoon") return "Afternoon";
  return pt;
}

function calcAge(dob: string | undefined | null) {
  if (!dob) return null;
  const birth = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

type CampDateOption = { id: number; date: string };

type EditItem = { childId: number; campDateId: number; productType: string };

function RefundDialog({
  reg,
  open,
  onOpenChange,
}: {
  reg: Registration;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmStep, setConfirmStep] = useState(false);
  // "items" only makes sense for camp registrations, which are sold as per-day
  // sessions. An ACADEMY term enrolment writes no registration_items at all, so
  // before these modes existed the dialog rendered "No items to refund" with a
  // permanently disabled button — the whole feature was unreachable for exactly
  // the registrations Olga needed to refund.
  const [mode, setMode] = useState<"full" | "amount" | "items">("full");
  const [customAmount, setCustomAmount] = useState("");

  const items = reg.items || [];
  const totalCents = reg.totalCents || 0;
  const subtotalCents = reg.subtotalCents || totalCents;
  const alreadyRefundedCents = reg.refundedAmountCents || 0;
  const remainingCents = totalCents - alreadyRefundedCents;

  const { data: pricing, isLoading: pricingLoading } = useQuery<CampPricingItem[]>({
    queryKey: ["/api/admin/camps", reg.programId, "pricing"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${reg.programId}/pricing`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load pricing");
      return res.json();
    },
    enabled: open,
  });

  const priceMap = useMemo(() => {
    const m = new Map<string, number>();
    (pricing || []).forEach((p) => m.set(p.productType, p.priceCents));
    return m;
  }, [pricing]);

  // Compute item refund value (with proportional discount applied)
  const itemRefundValue = useCallback((it: RegItem) => {
    const base = priceMap.get(it.productType) || 0;
    if (subtotalCents > 0 && totalCents !== subtotalCents) {
      return Math.round((base * totalCents) / subtotalCents);
    }
    return base;
  }, [priceMap, subtotalCents, totalCents]);

  const toggleItem = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const refundableItems = items.filter((it) => !(it.refundedAmountCents && it.refundedAmountCents > 0));

  const selectAll = () => setSelectedIds(new Set(refundableItems.map((it) => it.id)));
  const clearAll = () => setSelectedIds(new Set());

  const selectedTotal = useMemo(() => {
    let sum = 0;
    items.forEach((it) => {
      if (selectedIds.has(it.id)) sum += itemRefundValue(it);
    });
    return Math.min(sum, remainingCents);
  }, [items, selectedIds, itemRefundValue, remainingCents]);

  // How much is being refunded, by mode.
  //
  // 🔴 `full` sends NO amount at all — the server refunds the remaining balance
  // it computes itself. Sending a client-computed "full" figure would let a
  // stale page (opened before an earlier partial refund) ask for more than is
  // left, and the server would clamp it to something nobody chose.
  const amountCents = useMemo(() => {
    const n = Math.round(parseFloat(customAmount || "0") * 100);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [customAmount]);

  const refundTotal =
    mode === "full" ? remainingCents : mode === "amount" ? Math.min(amountCents, remainingCents) : selectedTotal;

  const amountTooBig = mode === "amount" && amountCents > remainingCents;

  const refundMut = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { reason: reason.trim() || undefined };
      if (mode === "items") body.itemIds = Array.from(selectedIds);
      else if (mode === "amount") body.amountCents = amountCents;
      // mode === "full": send neither — the server refunds the remainder.
      return apiRequest("POST", `/api/admin/registrations/${reg.id}/refund`, body);
    },
    onSuccess: async (res: any) => {
      const data = await res.json().catch(() => ({}));
      queryClient.invalidateQueries({ queryKey: ["/api/admin/registrations"] });
      toast({
        title: data.isFullRefund ? "Full refund processed" : "Partial refund processed",
        description: `${formatCurrency(data.amountRefunded || 0, { fromCents: true })} refunded via Stripe`,
      });
      handleClose(false);
    },
    onError: (e: Error) => {
      toast({ title: "Refund failed", description: e.message, variant: "destructive" });
      setConfirmStep(false);
    },
  });

  const handleClose = (val: boolean) => {
    onOpenChange(val);
    if (!val) {
      setSelectedIds(new Set());
      setReason("");
      setConfirmStep(false);
      setCustomAmount("");
      setMode(refundableItems.length > 0 ? "items" : "full");
    }
  };

  // Open on the mode that fits what was actually sold: sessions for a camp,
  // whole-amount for a term enrolment.
  useEffect(() => {
    if (open) setMode(refundableItems.length > 0 ? "items" : "full");
  }, [open, refundableItems.length]);

  const canSubmit =
    !refundMut.isPending &&
    refundTotal > 0 &&
    !amountTooBig &&
    (mode !== "items" || selectedIds.size > 0);

  return (
    <AlertDialog open={open} onOpenChange={handleClose}>
      <AlertDialogContent className="bg-[#0a0e1a] border border-red-500/20 text-white/80 max-w-lg" data-testid="dialog-refund">
        {!confirmStep ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2 text-white/90">
                <RotateCcw className="w-5 h-5 text-red-400" />
                Refund — #{reg.orderNumber || reg.id}
              </AlertDialogTitle>
              <AlertDialogDescription className="text-white/50">
                Refund{" "}
                <strong className="text-white/80">
                  {reg.contact?.firstName} {reg.contact?.lastName}
                </strong>
                . They'll get a confirmation email automatically.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="space-y-3 py-1">
              {/* Mode selector */}
              <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-white/[0.03] border border-white/[0.06] p-1">
                {([
                  { key: "full", label: "Full refund" },
                  { key: "amount", label: "Part amount" },
                  { key: "items", label: "By session" },
                ] as const).map((m) => {
                  const disabled = m.key === "items" && refundableItems.length === 0;
                  return (
                    <button
                      key={m.key}
                      onClick={() => !disabled && setMode(m.key)}
                      disabled={disabled}
                      title={disabled ? "This registration isn't sold as individual sessions" : undefined}
                      className={`rounded-lg px-2 py-1.5 text-[12px] font-medium transition-colors ${
                        mode === m.key
                          ? "bg-red-500/15 text-red-300 border border-red-500/30"
                          : disabled
                            ? "text-white/20 cursor-not-allowed border border-transparent"
                            : "text-white/50 hover:text-white/80 border border-transparent"
                      }`}
                      data-testid={`button-refund-mode-${m.key}`}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>

              {/* Summary bar */}
              <div className="flex items-center justify-between text-[11px] text-white/40 px-1">
                <span>
                  Paid: <span className="text-white/70 font-medium">{formatCurrency(totalCents, { fromCents: true })}</span>
                  {alreadyRefundedCents > 0 && (
                    <>
                      {" · Already refunded: "}
                      <span className="text-purple-400/80 font-medium">{formatCurrency(alreadyRefundedCents, { fromCents: true })}</span>
                    </>
                  )}
                </span>
                {mode === "items" && refundableItems.length > 1 && (
                  <div className="flex items-center gap-2">
                    <button onClick={selectAll} className="text-blue-400/70 hover:text-blue-400 transition-colors" data-testid="button-select-all">Select all</button>
                    <span className="text-white/15">·</span>
                    <button onClick={clearAll} className="text-white/40 hover:text-white/60 transition-colors" data-testid="button-clear-all">Clear</button>
                  </div>
                )}
              </div>

              {/* Full refund — nothing to choose, just state the number */}
              {mode === "full" && (
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-4 text-center">
                  <p className="text-[11px] uppercase tracking-wider text-white/35 mb-1">Refunding the full remaining balance</p>
                  <p className="text-[26px] font-semibold text-white/90 tabular-nums">
                    {formatCurrency(remainingCents, { fromCents: true })}
                  </p>
                  {alreadyRefundedCents > 0 && (
                    <p className="text-[11px] text-white/40 mt-1">
                      {formatCurrency(alreadyRefundedCents, { fromCents: true })} was already refunded earlier
                    </p>
                  )}
                </div>
              )}

              {/* Partial amount */}
              {mode === "amount" && (
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3.5 space-y-2">
                  <label className="text-[11px] text-white/50 block">How much to refund</label>
                  <MoneyInput
                    value={customAmount}
                    onChange={setCustomAmount}
                    placeholder="0.00"
                    className="bg-white/[0.03] border-white/[0.08] text-white/90 text-[15px]"
                    data-testid="input-refund-amount"
                  />
                  <div className="flex items-center justify-between text-[11px]">
                    <span className={amountTooBig ? "text-red-400" : "text-white/35"}>
                      {amountTooBig
                        ? `More than the ${formatCurrency(remainingCents, { fromCents: true })} left on this registration`
                        : `Up to ${formatCurrency(remainingCents, { fromCents: true })} available`}
                    </span>
                    <button
                      onClick={() => setCustomAmount((remainingCents / 100).toFixed(2))}
                      className="text-blue-400/70 hover:text-blue-400 transition-colors"
                      data-testid="button-refund-amount-max"
                    >
                      Use max
                    </button>
                  </div>
                </div>
              )}

              {/* Items list */}
              {mode === "items" && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] max-h-[280px] overflow-y-auto divide-y divide-white/[0.04]">
                {pricingLoading ? (
                  <div className="p-3 space-y-2">
                    {[1,2,3].map(i => <Skeleton key={i} className="h-10 w-full rounded-lg bg-white/[0.04]" />)}
                  </div>
                ) : items.length === 0 ? (
                  <div className="p-4 text-center text-[12px] text-white/30">No items to refund</div>
                ) : (
                  items.map((it) => {
                    const isRefunded = !!(it.refundedAmountCents && it.refundedAmountCents > 0);
                    const isSelected = selectedIds.has(it.id);
                    const value = itemRefundValue(it);
                    return (
                      <label
                        key={it.id}
                        className={`flex items-center gap-3 px-3 py-2.5 transition-colors ${
                          isRefunded
                            ? "opacity-50 cursor-not-allowed"
                            : "cursor-pointer hover:bg-white/[0.03]"
                        }`}
                        data-testid={`refund-item-${it.id}`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={isRefunded}
                          onChange={() => toggleItem(it.id)}
                          className="w-4 h-4 rounded border-white/20 bg-white/[0.04] text-red-500 focus:ring-red-500/40 cursor-pointer disabled:cursor-not-allowed"
                          data-testid={`checkbox-refund-item-${it.id}`}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] text-white/75 font-medium truncate">
                              {it.child?.firstName} {it.child?.lastName}
                            </span>
                            {isRefunded && (
                              <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-purple-500/30 text-purple-400/80 bg-purple-500/5">
                                Refunded
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 text-[11px] text-white/40 mt-0.5">
                            <Calendar className="w-3 h-3" />
                            <span>{it.campDate?.date ? formatDate(it.campDate.date) : "Unknown date"}</span>
                            <span className="text-white/15">·</span>
                            <span>{formatProductType(it.productType)}</span>
                          </div>
                        </div>
                        <div className="text-[13px] text-white/70 font-medium">
                          {formatCurrency(value, { fromCents: true })}
                        </div>
                      </label>
                    );
                  })
                )}
              </div>
              )}

              {/* Running total */}
              <div className="flex items-center justify-between rounded-xl bg-red-500/[0.06] border border-red-500/20 px-3.5 py-2.5">
                <span className="text-[12px] text-white/60">
                  {mode === "items"
                    ? selectedIds.size === 0
                      ? "No sessions selected"
                      : `${selectedIds.size} session${selectedIds.size > 1 ? "s" : ""} selected`
                    : mode === "full"
                      ? "Full remaining balance"
                      : "Partial refund"}
                </span>
                <span className="text-[15px] font-semibold text-red-400" data-testid="text-refund-total">
                  {formatCurrency(refundTotal, { fromCents: true })}
                </span>
              </div>

              {/* Reason */}
              <div>
                <label className="text-[11px] text-white/50 mb-1.5 block">Reason (optional, internal note)</label>
                <Textarea
                  placeholder="e.g. Child unwell — medical certificate provided"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  className="bg-white/[0.03] border-white/[0.08] text-white/80 resize-none text-[13px]"
                  data-testid="input-refund-reason"
                />
              </div>
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel
                className="bg-white/[0.04] border-white/10 text-white/70 hover:bg-white/[0.08] hover:text-white/90"
                data-testid="button-refund-cancel"
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); if (canSubmit) setConfirmStep(true); }}
                disabled={!canSubmit}
                className="bg-red-500/90 hover:bg-red-500 text-white border-0 disabled:opacity-40"
                data-testid="button-refund-next"
              >
                Refund {formatCurrency(refundTotal, { fromCents: true })}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2 text-white/90">
                <AlertTriangle className="w-5 h-5 text-amber-400" />
                Confirm refund
              </AlertDialogTitle>
              <AlertDialogDescription className="text-white/55 space-y-2">
                <span className="block">
                  Refund <strong className="text-red-400">{formatCurrency(refundTotal, { fromCents: true })}</strong> to{" "}
                  <strong className="text-white/85">{reg.contact?.firstName} {reg.contact?.lastName}</strong>
                  {mode === "items"
                    ? ` for ${selectedIds.size} session${selectedIds.size > 1 ? "s" : ""}.`
                    : mode === "full"
                      ? " — the full remaining balance."
                      : ` — a partial refund, leaving ${formatCurrency(remainingCents - refundTotal, { fromCents: true })} on the registration.`}
                </span>
                <span className="block text-amber-400/80 text-[12px]">
                  This processes a real refund through Stripe and cannot be undone. The money will appear in their account within 5–10 business days.
                </span>
                <span className="block text-white/40 text-[12px]">
                  They'll be emailed a confirmation, and your name is recorded against this refund.
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>

            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={refundMut.isPending}
                onClick={(e) => { e.preventDefault(); setConfirmStep(false); }}
                className="bg-white/[0.04] border-white/10 text-white/70 hover:bg-white/[0.08] hover:text-white/90"
                data-testid="button-refund-back"
              >
                Back
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); refundMut.mutate(); }}
                disabled={refundMut.isPending}
                className="bg-red-500/90 hover:bg-red-500 text-white border-0"
                data-testid="button-refund-confirm"
              >
                {refundMut.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Processing...</>
                ) : (
                  <>Confirm refund</>
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function EditRegistrationModal({
  reg,
  onClose,
}: {
  reg: Registration;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const grouped = reg.items ? itemsByChild(reg.items) : [];

  const { data: campDates, isLoading: datesLoading } = useQuery<CampDateOption[]>({
    queryKey: ["/api/admin/camps", reg.programId, "dates"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${reg.programId}/dates`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load dates");
      return res.json();
    },
  });

  const [editItems, setEditItems] = useState<EditItem[]>(() =>
    (reg.items || []).map(i => ({ childId: i.childId, campDateId: i.campDateId, productType: i.productType }))
  );

  const saveMutation = useMutation({
    mutationFn: () => apiRequest("PUT", `/api/admin/registrations/${reg.id}/items`, { items: editItems }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/registrations"] });
      toast({ title: "Registration updated" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const childIds = [...new Set(grouped.map(g => g.child?.id).filter(Boolean))] as number[];

  const addSession = (childId: number) => {
    if (!campDates || campDates.length === 0) return;
    setEditItems(prev => [...prev, { childId, campDateId: campDates[0].id, productType: "FULL_DAY" }]);
  };

  const removeSession = (index: number) => {
    setEditItems(prev => prev.filter((_, i) => i !== index));
  };

  const updateSession = (index: number, field: keyof EditItem, value: any) => {
    setEditItems(prev => prev.map((item, i) => i === index ? { ...item, [field]: field === "campDateId" ? parseInt(value) : value } : item));
  };

  const itemsByChildForEdit = (childId: number) => editItems
    .map((item, idx) => ({ ...item, idx }))
    .filter(item => item.childId === childId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto mx-4 shadow-2xl" onClick={e => e.stopPropagation()} data-testid="modal-edit-registration">
        <div className="flex items-center justify-between px-6 py-4 border-b border-blue-500/10">
          <h2 className="text-[15px] font-semibold text-white/80">Edit Sessions — #{reg.orderNumber || reg.id}</h2>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-white/5 transition-colors cursor-pointer" data-testid="button-close-edit-modal">
            <X className="w-4 h-4 text-white/40" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-5">
          {datesLoading ? (
            <Skeleton className="h-20 w-full rounded-xl bg-blue-500/[0.04]" />
          ) : (
            childIds.map(childId => {
              const childInfo = grouped.find(g => g.child?.id === childId)?.child;
              const childItems = itemsByChildForEdit(childId);
              return (
                <div key={childId} className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                        <span className="text-[10px] text-blue-400 font-semibold">{childInfo?.firstName?.[0]}{childInfo?.lastName?.[0]}</span>
                      </div>
                      <span className="text-[13px] text-white/70 font-medium">{childInfo?.firstName} {childInfo?.lastName}</span>
                    </div>
                    <button
                      onClick={() => addSession(childId)}
                      className="flex items-center gap-1 text-[11px] text-blue-400/70 hover:text-blue-400 transition-colors cursor-pointer"
                      data-testid={`button-add-session-${childId}`}
                    >
                      <Plus className="w-3 h-3" /> Add Session
                    </button>
                  </div>

                  <div className="space-y-2 ml-8">
                    {childItems.map(item => (
                      <div key={item.idx} className="flex items-center gap-2" data-testid={`edit-item-${item.idx}`}>
                        <select
                          value={item.campDateId}
                          onChange={e => updateSession(item.idx, "campDateId", e.target.value)}
                          className="flex-1 h-8 px-2 rounded-lg bg-white/[0.03] border border-white/[0.08] text-[12px] text-white/70 focus:outline-none focus:border-blue-500/30 cursor-pointer"
                          data-testid={`select-date-${item.idx}`}
                        >
                          {campDates?.map(d => (
                            <option key={d.id} value={d.id}>{formatDate(d.date)}</option>
                          ))}
                        </select>
                        <select
                          value={item.productType}
                          onChange={e => updateSession(item.idx, "productType", e.target.value)}
                          className="w-32 h-8 px-2 rounded-lg bg-white/[0.03] border border-white/[0.08] text-[12px] text-white/70 focus:outline-none focus:border-blue-500/30 cursor-pointer"
                          data-testid={`select-type-${item.idx}`}
                        >
                          <option value="FULL_DAY">Full Day</option>
                          <option value="MORNING">Morning</option>
                          <option value="AFTERNOON">Afternoon</option>
                        </select>
                        <button
                          onClick={() => removeSession(item.idx)}
                          className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-red-500/10 transition-colors cursor-pointer flex-shrink-0"
                          data-testid={`button-remove-session-${item.idx}`}
                        >
                          <Trash2 className="w-3.5 h-3.5 text-white/20 hover:text-red-400" />
                        </button>
                      </div>
                    ))}
                    {childItems.length === 0 && (
                      <p className="text-[11px] text-white/20 italic">No sessions — click "Add Session" above</p>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-blue-500/10">
          <Button variant="outline" onClick={onClose} className="rounded-xl h-9 text-[13px] border-white/10 text-white/50 hover:bg-white/5" data-testid="button-cancel-edit">
            Cancel
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || editItems.length === 0}
            className="bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 rounded-xl h-9 text-[13px] glow-btn"
            data-testid="button-save-edit"
          >
            <Save className="w-4 h-4 mr-1" />
            {saveMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function itemsByChild(items: RegItem[]) {
  const map = new Map<number, { child: RegItem["child"]; sessions: { date: string; productType: string; campDateId: number; refundedAmountCents?: number | null }[] }>();
  items.forEach(item => {
    if (!map.has(item.childId)) {
      map.set(item.childId, { child: item.child, sessions: [] });
    }
    map.get(item.childId)!.sessions.push({
      date: item.campDate?.date || "",
      productType: item.productType,
      campDateId: item.campDateId,
      refundedAmountCents: item.refundedAmountCents,
    });
  });
  map.forEach(v => v.sessions.sort((a, b) => a.date.localeCompare(b.date)));
  return [...map.values()];
}

type ProgrammeOption = {
  id: number;
  name: string;
  type: string;
  startDate: string | null;
  endDate: string | null;
  registrationCount: number;
};

/**
 * Two live programmes are both called "FUNdamentals Holiday Camp" (April, and
 * the September/October one). The dropdown showed the same words twice with no
 * way to tell them apart, so a date rides along whenever there is one.
 */
function programmeLabel(p: ProgrammeOption): string {
  if (!p.startDate) return p.name;
  const d = new Date(p.startDate + "T00:00:00");
  return `${p.name} · ${d.toLocaleDateString("en-NZ", { month: "short", year: "numeric" })}`;
}

export default function AdminRegistrations() {
  const { toast } = useToast();
  // Every programme in this workspace, not just camps. /api/admin/camps filters
  // to holiday_camp, which is why this page's filter offered camps while the
  // list beneath it was full of academy and league registrations.
  const { data: programmes } = useQuery<ProgrammeOption[]>({
    queryKey: ["/api/admin/registration-programmes"],
  });
  const [selectedCamp, setSelectedCamp] = useState<string>("");
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [filterDay, setFilterDay] = useState<string>("");
  const [filterSession, setFilterSession] = useState<string>("");
  // "How did we take the money" and "who served them" — the two questions the
  // office asks when reconciling the till and the EFTPOS terminal.
  const [filterPayment, setFilterPayment] = useState<string>("");
  const [filterRefund, setFilterRefund] = useState<string>("");
  const [filterServedBy, setFilterServedBy] = useState<string>("");
  const [showRegister, setShowRegister] = useState(false);

  const { data: registrations, isLoading } = useQuery<Registration[]>({
    queryKey: ["/api/admin/registrations", selectedCamp],
    queryFn: async () => {
      const url = selectedCamp ? `/api/admin/registrations?campId=${selectedCamp}` : "/api/admin/registrations";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  // Only offer programmes somebody has actually booked — a filter option that
  // can only ever yield an empty list is noise. Grouped by type so the office
  // can find "the academy one" without knowing every programme name.
  const programmeGroups = useMemo(() => {
    const live = (programmes || []).filter(p => p.registrationCount > 0);
    const groups: { label: string; items: ProgrammeOption[] }[] = [];
    for (const [type, label] of [
      ["holiday_camp", "Holiday camps"],
      ["academy", "Academy & programmes"],
      ["league_team", "Leagues"],
    ] as const) {
      const items = live.filter(p => p.type === type);
      if (items.length) groups.push({ label, items });
    }
    const rest = live.filter(p => !["holiday_camp", "academy", "league_team"].includes(p.type));
    if (rest.length) groups.push({ label: "Other", items: rest });
    return groups;
  }, [programmes]);

  const selectedProgramme = useMemo(
    () => (programmes || []).find(p => String(p.id) === selectedCamp) || null,
    [programmes, selectedCamp],
  );
  // Days and sessions are camp vocabulary — a term enrolment has neither, so
  // those two filters are hidden unless a camp is actually selected.
  const campFiltersApply = selectedProgramme?.type === "holiday_camp";

  const allDates = useMemo(() => {
    if (!registrations) return [];
    const dateMap = new Map<number, { id: number; date: string }>();
    registrations.forEach(r => {
      r.items?.forEach(item => {
        if (item.campDate && !dateMap.has(item.campDate.id)) {
          dateMap.set(item.campDate.id, { id: item.campDate.id, date: item.campDate.date });
        }
      });
    });
    return [...dateMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [registrations]);

  const filtered = useMemo(() => {
    if (!registrations) return [];
    let list = [...registrations];

    list.sort((a, b) => new Date(b.registeredAt).getTime() - new Date(a.registeredAt).getTime());

    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      list = list.filter(r =>
        r.contact?.firstName?.toLowerCase().includes(s) ||
        r.contact?.lastName?.toLowerCase().includes(s) ||
        r.contact?.email?.toLowerCase().includes(s) ||
        String(r.id).includes(s) ||
        r.children?.some(c => c.firstName.toLowerCase().includes(s) || c.lastName.toLowerCase().includes(s))
      );
    }

    if (filterDay) {
      const dayId = parseInt(filterDay);
      list = list.filter(r => r.items?.some(item => item.campDateId === dayId));
    }

    if (filterSession) {
      const ft = filterSession.toUpperCase();
      list = list.filter(r => r.items?.some(item => item.productType.toUpperCase() === ft));
    }

    if (filterRefund) {
      // Refunded money is what the office hunts for when reconciling. Read the
      // amount, not only the status: a partial refund leaves the registration
      // "confirmed" while real money has gone back.
      list = list.filter(r => {
        const cents = r.refundedAmountCents ?? 0;
        const st = String(r.status || "").toLowerCase();
        const refunded = cents > 0 || st === "refunded" || st === "partially_refunded";
        return filterRefund === "refunded" ? refunded : !refunded;
      });
    }

    if (filterPayment) {
      list = filterPayment === "office"
        // Everything taken over the counter, whatever the tender.
        ? list.filter(r => isOfficePaymentMethod(r.paymentMethod))
        : list.filter(r => describePaymentMethod(r).label === paymentMethodLabel(filterPayment));
    }

    if (filterServedBy) {
      const id = parseInt(filterServedBy);
      list = list.filter(r => r.servedByUserId === id);
    }

    return list;
    // 🔴 EVERY filter this memo reads must be in this array. Omitting one does
    // not throw and does not warn — the list simply never recomputes when that
    // control changes, so the filter silently does nothing. `filterRefund` was
    // missing, which is why picking "Refunded" left every confirmed booking on
    // screen. Add the dependency in the same commit as the filter.
  }, [registrations, searchTerm, filterDay, filterSession, filterPayment, filterServedBy, filterRefund]);

  // Only the people who have actually served someone — a dropdown of all 16
  // staff when three of them work the counter is noise, not a filter.
  const servers = useMemo(() => {
    const seen = new Map<number, string>();
    (registrations || []).forEach(r => {
      if (r.servedByUserId && r.servedByName) seen.set(r.servedByUserId, r.servedByName);
    });
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1], "en-NZ"));
  }, [registrations]);

  // What the visible rows add up to, split by tender. This is the number
  // someone cashing up at the end of the day is actually looking for.
  const takings = useMemo(() => {
    const byMethod = new Map<string, number>();
    let total = 0;
    filtered.forEach(r => {
      if (!isOfficePaymentMethod(r.paymentMethod)) return;
      const cents = Math.round(Number(r.amountPaid ?? 0) * 100);
      if (!cents) return;
      byMethod.set(r.paymentMethod!, (byMethod.get(r.paymentMethod!) ?? 0) + cents);
      total += cents;
    });
    return { byMethod: Array.from(byMethod.entries()), total };
  }, [filtered]);

  const statusColors: Record<string, string> = {
    pending: "text-amber-400/70 bg-amber-500/10 border-amber-500/15",
    confirmed: "text-emerald-400/70 bg-emerald-500/10 border-emerald-500/15",
    paid: "text-emerald-400/70 bg-emerald-500/10 border-emerald-500/15",
    cancelled: "text-red-400/70 bg-red-500/10 border-red-500/15",
    refunded: "text-purple-400/70 bg-purple-500/10 border-purple-500/15",
    partially_refunded: "text-purple-400/70 bg-purple-500/10 border-purple-500/15",
  };

  const statusLabel = (s: string) => s === "partially_refunded" ? "Partial Refund" : s;

  const refreshRefundStatusMut = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/registrations/${id}/refund/refresh-status`),
    onSuccess: async (res: any) => {
      const data = await res.json().catch(() => ({}));
      queryClient.invalidateQueries({ queryKey: ["/api/admin/registrations"] });
      toast({ title: "Refund status refreshed", description: `Stripe says: ${data.status || "unknown"}` });
    },
    onError: (e: Error) => toast({ title: "Couldn't refresh status", description: e.message, variant: "destructive" }),
  });

  const [editingReg, setEditingReg] = useState<Registration | null>(null);
  const [refundingReg, setRefundingReg] = useState<Registration | null>(null);
  // Whether to offer the Refund button at all. Cosmetic only — the server
  // re-checks the same flag on every refund call, so this is about not dangling
  // a button in front of someone who'd only get a 403.
  const { data: me } = useQuery<{ canIssueRefunds?: boolean }>({ queryKey: ["/api/auth/me"] });
  const canRefund = !!me?.canIssueRefunds;
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const deleteRegMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/registrations/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/registrations"] });
      setDeleteConfirmId(null);
      setExpandedId(null);
      toast({ title: "Registration deleted" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="p-4 sm:p-8 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-3 flex-wrap animate-fade-in-up" style={{ animationDelay: '0ms', opacity: 0 }}>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-white tracking-tight" data-testid="text-page-title">Registrations</h1>
          <p className="text-blue-400/35 text-[13px] mt-1">View and manage bookings</p>
        </div>
        <Button
          size="sm"
          onClick={() => setShowRegister(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white shrink-0"
          data-testid="button-open-office-registration"
        >
          <Plus className="w-3.5 h-3.5 mr-1" />Register at the office
        </Button>
      </div>

      <div className="flex gap-3 flex-wrap animate-fade-in-up" style={{ animationDelay: '50ms', opacity: 0 }}>
        <select
          value={selectedCamp}
          onChange={e => { setSelectedCamp(e.target.value); setFilterDay(""); setFilterSession(""); }}
          className="h-9 px-3 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/70 focus:outline-none focus:border-blue-500/30 cursor-pointer"
          data-testid="select-camp-filter"
        >
          <option value="">All programmes</option>
          {programmeGroups.map(g => (
            <optgroup key={g.label} label={g.label}>
              {g.items.map(p => (
                <option key={p.id} value={p.id}>{programmeLabel(p)}</option>
              ))}
            </optgroup>
          ))}
        </select>

        {/* Days and sessions only exist for a holiday camp. Showing them against
            a term enrolment offered filters that could only ever empty the list. */}
        {campFiltersApply && (
          <>
            <select
              value={filterDay}
              onChange={e => setFilterDay(e.target.value)}
              className="h-9 px-3 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/70 focus:outline-none focus:border-blue-500/30 cursor-pointer"
              data-testid="select-day-filter"
            >
              <option value="">All days</option>
              {allDates.map(d => <option key={d.id} value={d.id}>{formatDate(d.date)}</option>)}
            </select>

            <select
              value={filterSession}
              onChange={e => setFilterSession(e.target.value)}
              className="h-9 px-3 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/70 focus:outline-none focus:border-blue-500/30 cursor-pointer"
              data-testid="select-session-filter"
            >
              <option value="">All sessions</option>
              <option value="MORNING">Morning</option>
              <option value="AFTERNOON">Afternoon</option>
              <option value="FULL_DAY">Full Day</option>
            </select>
          </>
        )}

        <select
          value={filterRefund}
          onChange={e => setFilterRefund(e.target.value)}
          className="h-9 px-3 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/70 focus:outline-none focus:border-blue-500/30 cursor-pointer"
          data-testid="select-refund-filter"
        >
          <option value="">Refunded or not</option>
          <option value="refunded">Refunded</option>
          <option value="not_refunded">Not refunded</option>
        </select>

        <select
          value={filterPayment}
          onChange={e => setFilterPayment(e.target.value)}
          className="h-9 px-3 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/70 focus:outline-none focus:border-blue-500/30 cursor-pointer"
          data-testid="select-payment-filter"
        >
          <option value="">All payments</option>
          <option value="office">Paid at the office</option>
          {OFFICE_PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>

        {servers.length > 0 && (
          <select
            value={filterServedBy}
            onChange={e => setFilterServedBy(e.target.value)}
            className="h-9 px-3 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/70 focus:outline-none focus:border-blue-500/30 cursor-pointer"
            data-testid="select-served-by-filter"
          >
            <option value="">Anyone served</option>
            {servers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}

        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
          <Input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Search by name or email..." className="pl-10 premium-input text-white/80 rounded-xl h-9" data-testid="input-search-registrations" />
        </div>
      </div>

      {/* Cash-up strip — what the rows on screen add up to, split by tender.
          Only appears once there is something taken over the counter, so it
          never sits there reading $0.00 on an all-online list. */}
      {takings.total > 0 && (
        <div
          className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 rounded-2xl bg-emerald-500/[0.04] border border-emerald-500/15 animate-fade-in-up"
          style={{ animationDelay: '75ms', opacity: 0 }}
          data-testid="panel-office-takings"
        >
          <span className="text-[11px] uppercase tracking-wider text-emerald-300/45 font-semibold">Taken at the office</span>
          {takings.byMethod.map(([m, cents]) => (
            <span key={m} className="text-[12.5px] text-white/55">
              {paymentMethodLabel(m)} <span className="text-white/80 font-medium">{formatCurrency(cents, { fromCents: true })}</span>
            </span>
          ))}
          <span className="text-[12.5px] text-white/40 ml-auto">
            Total <span className="text-emerald-300/80 font-semibold" data-testid="text-office-takings-total">{formatCurrency(takings.total, { fromCents: true })}</span>
          </span>
        </div>
      )}

      <div className="rounded-2xl glass-card overflow-hidden animate-fade-in-up" style={{ animationDelay: '100ms', opacity: 0 }}>
        {isLoading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full rounded-xl bg-blue-500/[0.04]" />)}
          </div>
        ) : filtered && filtered.length > 0 ? (
          <div className="divide-y divide-blue-500/[0.04]">
            {filtered.map((reg) => {
              const grouped = reg.items ? itemsByChild(reg.items) : [];
              return (
                <div key={reg.id}>
                  <div
                    className="flex items-center gap-4 px-5 py-3 row-hover cursor-pointer"
                    onClick={() => setExpandedId(expandedId === reg.id ? null : reg.id)}
                    data-testid={`row-registration-${reg.id}`}
                  >
                    <div className="w-8 h-8 rounded-xl bg-blue-500/8 border border-blue-500/15 flex items-center justify-center flex-shrink-0">
                      <ClipboardCheck className="w-4 h-4 text-blue-400/70" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-white/75" data-testid={`text-reg-name-${reg.id}`}>
                        #{reg.orderNumber || reg.id} — {reg.contact?.firstName} {reg.contact?.lastName}
                      </p>
                      <p className="text-[11px] text-white/25">
                        {reg.program?.name || `Camp #${reg.programId}`}
                        {reg.items?.length ? ` · ${reg.items.length} session${reg.items.length !== 1 ? "s" : ""}` : ""}
                        {" · "}
                        {new Date(reg.registeredAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {isOfficePaymentMethod(reg.paymentMethod) && (
                        <span
                          className="hidden sm:inline-flex items-center gap-1 text-[9.5px] px-1.5 py-0.5 rounded-md border border-emerald-500/15 bg-emerald-500/[0.07] text-emerald-300/70 whitespace-nowrap"
                          data-testid={`badge-reg-payment-${reg.id}`}
                        >
                          {paymentMethodLabel(reg.paymentMethod)}
                          {reg.servedByName ? ` · ${reg.servedByName}` : ""}
                        </span>
                      )}
                      <span className="text-[13px] font-medium text-white/60" data-testid={`text-reg-total-${reg.id}`}>
                        {formatCurrency(reg.totalCents || 0, { fromCents: true })}
                      </span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-md border uppercase tracking-wider ${statusColors[reg.status] || statusColors.pending}`} data-testid={`badge-reg-status-${reg.id}`}>
                        {statusLabel(reg.status)}
                      </span>
                      {expandedId === reg.id ? <ChevronUp className="w-4 h-4 text-white/20" /> : <ChevronDown className="w-4 h-4 text-white/20" />}
                    </div>
                  </div>

                  {expandedId === reg.id && (
                    <div className="px-5 pb-4 space-y-3 animate-fade-in-up" style={{ animationDelay: '0ms', opacity: 0 }}>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div className="rounded-xl bg-white/[0.02] border border-white/[0.04] p-4 space-y-3">
                          {/* On an academy enrolment the registration's contact
                              is the PLAYER and the parent is on `guardian`; on a
                              camp they are the same person. Show whoever is
                              actually the adult here, so this panel always
                              carries a number someone can ring. */}
                          {(() => {
                            const adult = reg.guardian ?? reg.contact;
                            const player = reg.guardian ? reg.contact : null;
                            return (
                              <>
                                <p className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Parent / Guardian</p>
                                <div className="flex items-center gap-3">
                                  <User className="w-4 h-4 text-white/20 flex-shrink-0" />
                                  <span className="text-[13px] text-white/60" data-testid={`text-reg-parent-${reg.id}`}>{adult?.firstName} {adult?.lastName}</span>
                                </div>
                                {adult?.email && (
                                  <div className="flex items-center gap-3">
                                    <Mail className="w-4 h-4 text-white/20 flex-shrink-0" />
                                    <a href={`mailto:${adult.email}`} className="text-[13px] text-blue-400/60 hover:text-blue-400 truncate" data-testid={`text-reg-email-${reg.id}`}>{adult.email}</a>
                                  </div>
                                )}
                                {adult?.phone && (
                                  <div className="flex items-center gap-3">
                                    <Phone className="w-4 h-4 text-white/20 flex-shrink-0" />
                                    <a href={`tel:${adult.phone}`} className="text-[13px] text-blue-400/60 hover:text-blue-400" data-testid={`text-reg-phone-${reg.id}`}>{adult.phone}</a>
                                  </div>
                                )}
                                {player && (
                                  <div className="flex items-center gap-3 pt-1 border-t border-white/[0.04]">
                                    <Baby className="w-4 h-4 text-white/20 flex-shrink-0" />
                                    <span className="text-[13px] text-white/60" data-testid={`text-reg-player-${reg.id}`}>
                                      Player: {player.firstName} {player.lastName}
                                      {player.dateOfBirth ? ` (${calcAge(player.dateOfBirth)})` : ""}
                                    </span>
                                  </div>
                                )}
                                {(adult?.emergencyContact || reg.contact?.emergencyContact) && (
                                  <div className="flex items-center gap-3 pt-1 border-t border-white/[0.04]">
                                    <Phone className="w-4 h-4 text-amber-400/30 flex-shrink-0" />
                                    <span className="text-[12px] text-white/40 break-words min-w-0">
                                      Emergency: {adult?.emergencyContact || reg.contact?.emergencyContact}{" "}
                                      {(adult?.emergencyPhone || reg.contact?.emergencyPhone) ? `(${adult?.emergencyPhone || reg.contact?.emergencyPhone})` : ""}
                                    </span>
                                  </div>
                                )}
                              </>
                            );
                          })()}
                        </div>

                        <div className="rounded-xl bg-white/[0.02] border border-white/[0.04] p-4 space-y-3">
                          <p className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold flex items-center gap-1.5">
                            <CreditCard className="w-3 h-3" /> Pricing
                          </p>
                          <div className="space-y-1">
                            <p className="text-[12px] text-white/40">Subtotal: {formatCurrency(reg.subtotalCents || 0, { fromCents: true })}</p>
                            {(reg.discountCents || 0) > 0 && <p className="text-[12px] text-emerald-400/60">Discount: -{formatCurrency(reg.discountCents || 0, { fromCents: true })}</p>}
                            <p className="text-[13px] text-white/70 font-medium">Total: {formatCurrency(reg.totalCents || 0, { fromCents: true })}</p>
                            {/* How the money came in. Shown for every registration:
                                an online one reads as a card payment from its
                                PaymentIntent, an older row with neither honestly
                                reads "Not recorded" rather than being guessed at. */}
                            <div className="pt-2 mt-1 border-t border-white/[0.04] space-y-1">
                              <p className="text-[12px] text-white/40" data-testid={`text-reg-method-${reg.id}`}>
                                Paid by: <span className={describePaymentMethod(reg).known ? "text-white/60" : "text-white/30 italic"}>
                                  {describePaymentMethod(reg).label}
                                </span>
                                {Number(reg.amountPaid ?? 0) > 0 && (
                                  <span className="text-white/40"> · {formatCurrency(Math.round(Number(reg.amountPaid) * 100), { fromCents: true })} taken</span>
                                )}
                              </p>
                              {reg.paymentReference && (
                                <p className="text-[12px] text-white/40 break-words">Ref: <span className="text-white/60">{reg.paymentReference}</span></p>
                              )}
                              {reg.servedByName && (
                                <p className="text-[12px] text-white/40" data-testid={`text-reg-servedby-${reg.id}`}>
                                  Served by: <span className="text-white/60">{reg.servedByName}</span>
                                </p>
                              )}
                            </div>
                            {reg.refundedAt && (reg.refundedAmountCents || 0) > 0 && (
                              <div className="rounded-lg bg-purple-500/[0.06] border border-purple-500/20 p-2.5 mt-2 space-y-1.5" data-testid={`refund-summary-${reg.id}`}>
                                <div className="flex items-center justify-between">
                                  <span className={`text-[10px] uppercase tracking-wider font-semibold ${reg.status === "refunded" ? "text-purple-400/90" : "text-amber-400/90"}`}>
                                    {reg.status === "refunded" ? "Fully Refunded" : "Partially Refunded"}
                                  </span>
                                  <span className="text-[12px] font-semibold text-purple-400" data-testid={`text-refunded-${reg.id}`}>
                                    {formatCurrency(reg.refundedAmountCents || 0, { fromCents: true })}
                                  </span>
                                </div>
                                <p className="text-[10px] text-white/40">
                                  {/* Who did this, and when — to the minute. A refund is a
                                      named act; "someone refunded this in August" is not an
                                      audit trail. Falls back to the date alone for refunds
                                      issued before the trail existed, which reads honestly as
                                      "we don't know" rather than blaming nobody. */}
                                  {reg.refundedByName
                                    ? `${reg.refundedByName} refunded this on `
                                    : ""}
                                  {new Date(reg.refundedAt).toLocaleString("en-NZ", {
                                    day: "numeric", month: "short", year: "numeric",
                                    hour: "2-digit", minute: "2-digit",
                                  })}
                                  {reg.status === "partially_refunded" && (
                                    <span className="text-white/30"> · {formatCurrency(((reg.totalCents || 0) - (reg.refundedAmountCents || 0)), { fromCents: true })} remaining</span>
                                  )}
                                </p>
                                {reg.refundReason && (
                                  <p className="text-[10px] text-white/40 italic">"{reg.refundReason}"</p>
                                )}
                                {reg.stripeRefundStatus && (
                                  <div className="flex items-center justify-between pt-1.5 border-t border-purple-500/10">
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-[10px] text-white/40">Stripe status:</span>
                                      <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 ${
                                        reg.stripeRefundStatus === "succeeded"
                                          ? "border-emerald-500/30 text-emerald-400/90 bg-emerald-500/5"
                                          : reg.stripeRefundStatus === "failed" || reg.stripeRefundStatus === "canceled"
                                          ? "border-red-500/30 text-red-400/90 bg-red-500/5"
                                          : "border-amber-500/30 text-amber-400/90 bg-amber-500/5"
                                      }`} data-testid={`badge-stripe-status-${reg.id}`}>
                                        {reg.stripeRefundStatus === "succeeded" ? "Completed" : reg.stripeRefundStatus === "pending" ? "Processing" : reg.stripeRefundStatus}
                                      </Badge>
                                    </div>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); refreshRefundStatusMut.mutate(reg.id); }}
                                      disabled={refreshRefundStatusMut.isPending}
                                      className="text-[10px] text-blue-400/70 hover:text-blue-400 transition-colors flex items-center gap-1 disabled:opacity-40"
                                      data-testid={`button-refresh-status-${reg.id}`}
                                    >
                                      {refreshRefundStatusMut.isPending && refreshRefundStatusMut.variables === reg.id
                                        ? <><Loader2 className="w-2.5 h-2.5 animate-spin" /> Checking</>
                                        : <><RotateCcw className="w-2.5 h-2.5" /> Refresh</>}
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                          {canRefund && reg.status !== "refunded" && (reg.totalCents || 0) > (reg.refundedAmountCents || 0) && reg.stripePaymentIntentId && (
                            <button
                              onClick={(e) => { e.stopPropagation(); setRefundingReg(reg); }}
                              className="w-full flex items-center justify-center gap-1.5 text-[11px] text-red-400/70 hover:text-red-400 hover:bg-red-500/10 border border-red-500/15 hover:border-red-500/30 rounded-lg py-1.5 transition-colors cursor-pointer"
                              data-testid={`button-refund-${reg.id}`}
                            >
                              <RotateCcw className="w-3 h-3" /> {reg.status === "partially_refunded" ? "Refund More" : "Refund"}
                            </button>
                          )}
                          <div className="pt-1 border-t border-white/[0.04] space-y-1.5">
                            <div className="flex items-center justify-between">
                              <p className="text-[11px] text-white/25">
                                Registered: {new Date(reg.registeredAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                              </p>
                              {reg.registrationLocation && (
                                <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 ${
                                  reg.registrationLocation === "cufc_office"
                                    ? "border-amber-500/25 text-amber-400/70 bg-amber-500/5"
                                    : "border-sky-500/25 text-sky-400/70 bg-sky-500/5"
                                }`} data-testid={`badge-source-${reg.id}`}>
                                  {reg.registrationLocation === "cufc_office" ? "CUFC Office" : "Online"}
                                </Badge>
                              )}
                            </div>
                            {reg.referralSource && (
                              <div className="flex items-center gap-1.5" data-testid={`referral-source-${reg.id}`}>
                                <span className="text-[10px] text-white/20">Heard via:</span>
                                <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-violet-500/25 text-violet-400/70 bg-violet-500/5">
                                  {reg.referralSource.startsWith("Other:") ? reg.referralSource : reg.referralSource.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())}
                                </Badge>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {grouped.length > 0 && (
                        <div className="rounded-xl bg-white/[0.02] border border-white/[0.04] p-4 space-y-4">
                          <div className="flex items-center justify-between">
                            <p className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold flex items-center gap-1.5">
                              <Baby className="w-3 h-3" /> Children & Sessions
                            </p>
                            <button
                              onClick={e => { e.stopPropagation(); setEditingReg(reg); }}
                              className="flex items-center gap-1 text-[11px] text-blue-400/60 hover:text-blue-400 transition-colors cursor-pointer"
                              data-testid={`button-edit-registration-${reg.id}`}
                            >
                              <Pencil className="w-3 h-3" /> Edit
                            </button>
                          </div>
                          {grouped.map((g, gi) => (
                            <div key={gi} className={gi > 0 ? "pt-3 border-t border-white/[0.04]" : ""}>
                              <div className="flex items-center gap-2 mb-2">
                                <div className="w-6 h-6 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                                  <span className="text-[10px] text-blue-400 font-semibold">{g.child?.firstName?.[0]}{g.child?.lastName?.[0]}</span>
                                </div>
                                <span className="text-[13px] text-white/70 font-medium" data-testid={`text-reg-child-${reg.id}-${gi}`}>
                                  {g.child?.firstName} {g.child?.lastName}
                                </span>
                                {g.child?.dateOfBirth && (
                                  <span className="text-[11px] text-white/25 ml-1">
                                    (Age {calcAge(g.child.dateOfBirth)})
                                  </span>
                                )}
                              </div>
                              <div className="ml-8 space-y-1">
                                {g.sessions.map((s: { date: string; productType: string; campDateId: number; refundedAmountCents?: number | null }, si: number) => {
                                  const sessionItemRefunded = !!(s.refundedAmountCents && s.refundedAmountCents > 0);
                                  return (
                                    <div key={si} className={`flex items-center gap-2 text-[12px] ${sessionItemRefunded ? "opacity-60" : ""}`} data-testid={`session-row-${reg.id}-${gi}-${si}`}>
                                      <Calendar className="w-3 h-3 text-white/15" />
                                      <span className={`${sessionItemRefunded ? "text-white/30 line-through" : "text-white/35"}`}>{reg.program?.name}</span>
                                      <span className="text-white/15">—</span>
                                      <span className={`${sessionItemRefunded ? "text-white/30 line-through" : "text-white/45"}`}>{formatDate(s.date)}</span>
                                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-5 ${
                                        s.productType.toUpperCase() === "FULL_DAY"
                                          ? "border-blue-500/20 text-blue-400/70 bg-blue-500/5"
                                          : s.productType.toUpperCase() === "MORNING"
                                          ? "border-amber-500/20 text-amber-400/70 bg-amber-500/5"
                                          : "border-purple-500/20 text-purple-400/70 bg-purple-500/5"
                                      }`} data-testid={`badge-session-${reg.id}-${gi}-${si}`}>
                                        {formatProductType(s.productType)}
                                      </Badge>
                                      {sessionItemRefunded && (
                                        <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-purple-500/30 text-purple-400/80 bg-purple-500/5" data-testid={`badge-item-refunded-${reg.id}-${gi}-${si}`}>
                                          Refunded {formatCurrency(s.refundedAmountCents || 0, { fromCents: true })}
                                        </Badge>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {reg.children && reg.children.length > 0 && grouped.length === 0 && (
                        <div className="rounded-xl bg-white/[0.02] border border-white/[0.04] p-4 space-y-2">
                          <p className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Children</p>
                          {reg.children.map(c => (
                            <div key={c.id} className="flex items-center gap-2 text-[13px] text-white/50">
                              <Baby className="w-3.5 h-3.5 text-white/20" />
                              {c.firstName} {c.lastName}
                              {c.dateOfBirth && <span className="text-[11px] text-white/25">(Age {calcAge(c.dateOfBirth)})</span>}
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="flex justify-end pt-1">
                        {deleteConfirmId === reg.id ? (
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] text-red-400/70">Delete this registration and all session bookings?</span>
                            <Button
                              variant="outline"
                              onClick={e => { e.stopPropagation(); setDeleteConfirmId(null); }}
                              className="rounded-xl h-7 text-[11px] border-white/10 text-white/50 hover:bg-white/5 px-3"
                              data-testid={`button-cancel-delete-reg-${reg.id}`}
                            >
                              Cancel
                            </Button>
                            <Button
                              onClick={e => { e.stopPropagation(); deleteRegMutation.mutate(reg.id); }}
                              disabled={deleteRegMutation.isPending}
                              className="rounded-xl h-7 text-[11px] bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 px-3"
                              data-testid={`button-confirm-delete-reg-${reg.id}`}
                            >
                              {deleteRegMutation.isPending ? "Deleting..." : "Yes, Delete"}
                            </Button>
                          </div>
                        ) : (
                          <button
                            onClick={e => { e.stopPropagation(); setDeleteConfirmId(reg.id); }}
                            className="flex items-center gap-1 text-[11px] text-red-400/50 hover:text-red-400 transition-colors cursor-pointer"
                            data-testid={`button-delete-reg-${reg.id}`}
                          >
                            <Trash2 className="w-3 h-3" /> Delete Registration
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <ClipboardCheck className="w-12 h-12 text-blue-400/10 mb-4" />
            <h3 className="text-[15px] font-medium text-white/40 mb-1">No registrations</h3>
            <p className="text-[12px] text-white/20">Bookings will appear here once parents register</p>
          </div>
        )}
      </div>

      {filtered && filtered.length > 0 && (
        <p className="text-[11px] text-white/20 text-center">
          Showing {filtered.length} of {registrations?.length || 0} registration{(registrations?.length || 0) !== 1 ? "s" : ""}
        </p>
      )}

      {editingReg && (
        <EditRegistrationModal reg={editingReg} onClose={() => setEditingReg(null)} />
      )}
      {refundingReg && (
        <RefundDialog
          reg={refundingReg}
          open={!!refundingReg}
          onOpenChange={(open) => { if (!open) setRefundingReg(null); }}
        />
      )}
      <RegisterPlayerModal open={showRegister} onClose={() => setShowRegister(false)} scope="all" />
    </div>
  );
}
