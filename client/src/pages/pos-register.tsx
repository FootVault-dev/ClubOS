// The Register — one till for every brand, every programme, every counter.
//
// Left: what is for sale (every brand's merch, the programmes, the events, a
// custom line), searchable, scannable. Right: the cart, the customer, the
// money. A sale is bound to one money account; the server refuses a line from
// a brand that banks elsewhere and this page says so in plain words.
//
// Designed for an iPad in landscape at the office counter and a phone in
// portrait at a merch stand. Every control is drawn by us. Light mode only.
// Hooks live ABOVE every early return (a hook below one blanks the tree).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency, dollarInputToCents, centsToDollarInput } from "@/lib/format";
import { RegisterPlayerModal } from "./admin-register-player";
import { feedWedgeKey, shouldIgnoreWedgeTarget, EMPTY_WEDGE, type WedgeState } from "@/lib/wedge-scanner";
import { roundCashToTenCents } from "@shared/pos";
import {
  ShoppingBag, Search, ScanLine, X, Plus, Minus, Trash2, Receipt, Banknote, CreditCard, Landmark,
  MoreHorizontal, Loader2, CheckCircle2, AlertTriangle, UserRound, Percent, RotateCcw, Camera, CameraOff,
} from "lucide-react";

// ── Types (JSON shapes from server/pos-routes.ts) ───────────────────────────
interface Brand { id: number; slug: string; name: string; account: string | null }
interface Register { id: number; name: string; location: string | null; defaultOrgId: number | null; hasReader: boolean; openShift: { id: number; openedAt: string; openingFloatCents: number; openedByName: string | null } | null }
interface Bootstrap {
  registers: Register[]; brands: Brand[];
  tenders: { value: string; label: string; rounds: boolean; needsReference: boolean }[];
  manualTenders: { value: string; label: string; rounds: boolean; needsReference: boolean }[];
  declineReasons: { value: string; label: string }[];
  seller: { legalName: string; gstNumber: string };
  me: { id: number; name: string; canIssueRefunds: boolean };
}
interface Variant { id: number; size: string; sku: string | null; stock: number; priceCents: number }
interface Colour { id: number; name: string; swatchHex: string | null; image: string | null; variants: Variant[] }
interface Product { id: number; orgId: number; title: string; subtitle: string | null; type: string; priceCents: number; image: string | null; colours: Colour[] }
interface Programme { id: number; orgId: number; name: string; type: string; registrationOpen: boolean; options: { id: number; name: string; fullPriceCents: number }[] }
interface EventRow { id: number; orgId: number; name: string; startsAt: string; ticketTypes: { id: number; name: string; priceCents: number }[] }
interface Catalogue { products: Product[]; programmes: Programme[]; events: EventRow[]; codeHit: { variantId: number; productId: number } | null }
interface Line { id: number; kind: string; organizationId: number; brand: string; title: string; detail: string | null; unitCents: number; qty: number; lineCents: number; variantId: number | null; registrationId: number | null; meta: any }
interface Payment { id: number; method: string; label: string; amountCents: number; reference: string | null; status: string; stripePaymentIntentId: string | null }
interface Sale {
  id: number; saleNumber: string; token: string; status: string; moneyAccount: string;
  subtotalCents: number; discountCents: number; discountReason: string | null; roundingCents: number; totalCents: number; gstCents: number; paidCents: number; refundedCents: number;
  remainingCents: number; refundableCents: number;
  customerName: string | null; customerEmail: string | null; customerPhone: string | null; marketingOptInAt: string | null; contactId: number | null;
  lines: Line[]; payments: Payment[]; refunds: { id: number; amountCents: number; reason: string; method: string }[];
  receiptUrl: string; receiptSentAt: string | null; paidAt: string | null; servedByName: string | null;
  register: { id: number; name: string; hasReader: boolean } | null;
}
interface Summary {
  shift: { id: number; openedAt: string; closedAt: string | null; openingFloatCents: number; openedByName: string | null };
  sales: { total: number; paid: number; open: number; void: number; refunded: number };
  takenCents: number; refundedCents: number; gstCents: number;
  byTender: { method: string; label: string; cents: number; count: number; refundedCents: number }[];
  byBrand: { name: string; cents: number; lines: number }[];
  cash: { openingFloatCents: number; inCents: number; outCents: number; expectedCents: number; countedCents: number | null; varianceCents: number | null };
  declines: { total: number; byReason: Record<string, number> };
}

const $ = (c: number) => formatCurrency(c, { fromCents: true });
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await apiRequest(method, url, body);
  return res.json();
}
function errMessage(e: any): string {
  const m = String(e?.message ?? e ?? "");
  // apiRequest throws `${status}: ${body}` — pull the JSON message out if there is one.
  const i = m.indexOf(": ");
  const body = i > 0 ? m.slice(i + 2) : m;
  try { return JSON.parse(body).message || body; } catch { return body; }
}

// ── Shared bits ─────────────────────────────────────────────────────────────
const btn = "inline-flex items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none select-none";
const btnPrimary = `${btn} h-11 px-4 bg-blue-600 text-white hover:bg-blue-700`;
const btnGhost = `${btn} h-11 px-4 bg-white border border-neutral-200 text-neutral-800 hover:bg-neutral-50`;
const btnIcon = `${btn} h-11 w-11 bg-white border border-neutral-200 text-neutral-700 hover:bg-neutral-50`;
const inputCls = "h-11 w-full rounded-xl border border-neutral-200 bg-white px-3 text-[15px] text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30";

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={`h-9 shrink-0 rounded-full px-3.5 text-[13px] font-medium transition-colors ${active ? "bg-neutral-900 text-white" : "bg-white border border-neutral-200 text-neutral-700 hover:bg-neutral-50"}`}>{children}</button>;
}

// ── Camera scanner (same engine as the warehouse scan station) ──────────────
const WANTED_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"];
interface DetectorLike { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> }
let detectorPromise: Promise<DetectorLike> | null = null;
async function loadDetector(): Promise<DetectorLike> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const NativeCtor = (window as any).BarcodeDetector;
      if (typeof NativeCtor === "function" && typeof NativeCtor.getSupportedFormats === "function") {
        try {
          const supported: string[] = await NativeCtor.getSupportedFormats();
          const usable = WANTED_FORMATS.filter((f) => supported.includes(f));
          if (usable.length > 0) return new NativeCtor({ formats: usable }) as DetectorLike;
        } catch { /* fall through */ }
      }
      const mod = await import("barcode-detector/pure");
      mod.setZXingModuleOverrides({ locateFile: (path: string) => `/zxing/${path}` });
      return new mod.BarcodeDetector({ formats: [...WANTED_FORMATS] as any }) as unknown as DetectorLike;
    })();
  }
  return detectorPromise;
}
function ScanDialog({ open, onClose, onCode }: { open: boolean; onClose: () => void; onCode: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<"starting" | "running" | "error">("starting");
  const [error, setError] = useState<string | null>(null);
  const lastRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  useEffect(() => {
    if (!open) return;
    let cancelled = false; let stream: MediaStream | null = null; let timer: ReturnType<typeof setInterval> | null = null;
    setStatus("starting"); setError(null);
    (async () => {
      try {
        const detector = await loadDetector();
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
        setStatus("running");
        let busy = false;
        timer = setInterval(async () => {
          if (busy || !videoRef.current || videoRef.current.readyState < 2) return;
          busy = true;
          try {
            const r = await detector.detect(videoRef.current);
            const code = r[0]?.rawValue;
            if (code && (code !== lastRef.current.code || Date.now() - lastRef.current.at > 2500)) { lastRef.current = { code, at: Date.now() }; onCode(code); }
          } catch { /* next tick */ } finally { busy = false; }
        }, 300);
      } catch (e: any) { if (!cancelled) { setStatus("error"); setError(e?.message || "Couldn't access the camera"); } }
    })();
    return () => { cancelled = true; if (timer) clearInterval(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [open, onCode]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md p-0 overflow-hidden">
        <DialogTitle className="sr-only">Scan a barcode</DialogTitle>
        <div className="relative bg-black aspect-[3/4]">
          <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-x-8 top-1/2 -translate-y-1/2 h-24 border-2 border-white/80 rounded-xl pointer-events-none" />
          {status !== "running" && (
            <div className="absolute inset-0 flex items-center justify-center text-white text-sm bg-black/60 px-6 text-center">
              {status === "starting" ? <><Loader2 className="h-5 w-5 animate-spin mr-2" />Starting the camera…</> : <><CameraOff className="h-5 w-5 mr-2" />{error}</>}
            </div>
          )}
        </div>
        <div className="p-3 flex items-center justify-between text-[13px] text-neutral-600">
          <span>Point at the barcode on the tag. A USB or Bluetooth scanner works anywhere on this page.</span>
          <button className={btnGhost} onClick={onClose}><X className="h-4 w-4" />Close</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── The page ────────────────────────────────────────────────────────────────
export default function PosRegister() {
  const { toast } = useToast();
  const boot = useQuery<Bootstrap>({ queryKey: ["/api/admin/pos/bootstrap"] });
  const [registerId, setRegisterId] = useState<number | null>(() => { const v = Number(ls.get("clubos_pos_register")); return Number.isFinite(v) && v > 0 ? v : null; });
  const [saleId, setSaleId] = useState<number | null>(() => { const v = Number(ls.get("clubos_pos_sale")); return Number.isFinite(v) && v > 0 ? v : null; });
  const [tab, setTab] = useState<"products" | "programmes" | "events" | "custom">("products");
  const [brand, setBrand] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [picking, setPicking] = useState<Product | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [tenderOpen, setTenderOpen] = useState(false);
  const [cashupOpen, setCashupOpen] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [openingForPlayer, setOpeningForPlayer] = useState(false);
  const [floatDollars, setFloatDollars] = useState("100.00");
  const [recentOpen, setRecentOpen] = useState(false);

  const register = useMemo(() => boot.data?.registers.find((r) => r.id === registerId) ?? boot.data?.registers[0] ?? null, [boot.data, registerId]);
  useEffect(() => { if (register && register.id !== registerId) { setRegisterId(register.id); ls.set("clubos_pos_register", String(register.id)); } }, [register, registerId]);
  useEffect(() => { if (brand === null && register?.defaultOrgId) setBrand(register.defaultOrgId); }, [register, brand]);
  const shift = register?.openShift ?? null;

  const catalogue = useQuery<Catalogue>({ queryKey: ["/api/admin/pos/catalogue"], staleTime: 60_000 });
  const sale = useQuery<Sale>({ queryKey: ["/api/admin/pos/sales", saleId], queryFn: () => json("GET", `/api/admin/pos/sales/${saleId}`), enabled: !!saleId, retry: false });
  const recent = useQuery<Sale[]>({ queryKey: ["/api/admin/pos/sales", "shift", shift?.id], queryFn: () => json("GET", `/api/admin/pos/sales?shiftId=${shift!.id}`), enabled: !!shift && recentOpen });
  useEffect(() => { if (sale.isError) { setSaleId(null); ls.set("clubos_pos_sale", null); } }, [sale.isError]);

  const refreshSale = useCallback((s?: Sale) => {
    if (s) queryClient.setQueryData(["/api/admin/pos/sales", s.id], s);
    else if (saleId) queryClient.invalidateQueries({ queryKey: ["/api/admin/pos/sales", saleId] });
  }, [saleId]);
  const refreshBoot = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/pos/bootstrap"] });
  const fail = (e: any) => toast({ title: "Couldn't do that", description: errMessage(e), variant: "destructive" });

  const openShift = useMutation({
    mutationFn: () => json("POST", "/api/admin/pos/shifts/open", { registerId: register!.id, openingFloatCents: dollarInputToCents(floatDollars) }),
    onSuccess: () => { refreshBoot(); toast({ title: "Shift open", description: "Take the first sale." }); }, onError: fail,
  });
  const newSale = useMutation({
    mutationFn: (moneyAccount?: string) => json<Sale>("POST", "/api/admin/pos/sales", { registerId: register!.id, moneyAccount }),
    onSuccess: (s) => { setSaleId(s.id); ls.set("clubos_pos_sale", String(s.id)); refreshSale(s); setTenderOpen(false); }, onError: fail,
  });
  const addLine = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      let id = saleId;
      if (!id || sale.data?.status !== "open") { const s = await json<Sale>("POST", "/api/admin/pos/sales", { registerId: register!.id }); id = s.id; setSaleId(s.id); ls.set("clubos_pos_sale", String(s.id)); }
      return json<Sale>("POST", `/api/admin/pos/sales/${id}/lines`, body);
    },
    onSuccess: (s) => { refreshSale(s); setPicking(null); }, onError: fail,
  });
  const removeLine = useMutation({ mutationFn: (lineId: number) => json<Sale>("DELETE", `/api/admin/pos/sales/${saleId}/lines/${lineId}`), onSuccess: refreshSale, onError: fail });
  const setQty = useMutation({ mutationFn: ({ lineId, qty }: { lineId: number; qty: number }) => json<Sale>("PATCH", `/api/admin/pos/sales/${saleId}/lines/${lineId}`, { qty }), onSuccess: refreshSale, onError: fail });
  const patchSale = useMutation({ mutationFn: (body: Record<string, unknown>) => json<Sale>("PATCH", `/api/admin/pos/sales/${saleId}`, body), onSuccess: (s) => { refreshSale(s); setCustomerOpen(false); setDiscountOpen(false); }, onError: fail });
  const voidSale = useMutation({ mutationFn: (reason: string) => json<Sale>("POST", `/api/admin/pos/sales/${saleId}/void`, { reason }), onSuccess: () => { setSaleId(null); ls.set("clubos_pos_sale", null); toast({ title: "Sale cleared" }); }, onError: fail });
  const pay = useMutation({
    mutationFn: (body: { method: string; amountCents: number; reference?: string }) => json<{ sale: Sale; changeCents: number }>("POST", `/api/admin/pos/sales/${saleId}/payments`, body),
    onSuccess: ({ sale: s, changeCents }) => { refreshSale(s); if (changeCents > 0) toast({ title: `Change ${$(changeCents)}` }); if (s.status === "paid") toast({ title: `Paid — ${s.saleNumber}`, description: s.customerEmail ? `Receipt sent to ${s.customerEmail}` : "Add an email to send the receipt." }); },
    onError: fail,
  });
  const [cardPaymentId, setCardPaymentId] = useState<number | null>(null);
  const cardPay = useMutation({
    mutationFn: () => json<{ paymentId: number; viaReader: boolean; clientSecret: string | null }>("POST", `/api/admin/pos/sales/${saleId}/payments/card`, {}),
    onSuccess: (r) => { setCardPaymentId(r.paymentId); refreshSale(); if (!r.viaReader) toast({ title: "No reader on this register", description: "Add a Stripe reader to the register, or use the EFTPOS terminal and record it.", variant: "destructive" }); },
    onError: fail,
  });
  const cancelCard = useMutation({ mutationFn: () => json<Sale>("POST", `/api/admin/pos/sales/${saleId}/payments/${cardPaymentId}/cancel`, {}), onSuccess: (s) => { setCardPaymentId(null); refreshSale(s); }, onError: (e) => { setCardPaymentId(null); fail(e); } });
  useEffect(() => {
    if (!cardPaymentId || !saleId) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await json<{ stripeStatus: string; sale: Sale }>("POST", `/api/admin/pos/sales/${saleId}/payments/${cardPaymentId}/confirm`, {});
        if (stop) return;
        refreshSale(r.sale);
        if (r.stripeStatus === "succeeded") { setCardPaymentId(null); toast({ title: `Paid by card — ${r.sale.saleNumber}` }); }
        else if (r.stripeStatus === "canceled") { setCardPaymentId(null); toast({ title: "Card payment cancelled", variant: "destructive" }); }
      } catch { /* keep polling */ }
    };
    const t = setInterval(tick, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [cardPaymentId, saleId, refreshSale, toast]);
  const complete = useMutation({ mutationFn: () => json<Sale>("POST", `/api/admin/pos/sales/${saleId}/complete`, {}), onSuccess: (x) => { refreshSale(x); toast({ title: `Done — ${x.saleNumber}`, description: "Nothing to pay. Stock and registrations still moved." }); }, onError: fail });
  const refund = useMutation({ mutationFn: (body: { amountCents: number; reason: string }) => json<Sale>("POST", `/api/admin/pos/sales/${saleId}/refunds`, body), onSuccess: (s) => { refreshSale(s); setRefundOpen(false); toast({ title: "Refund recorded" }); }, onError: fail });
  const sendReceipt = useMutation({ mutationFn: (email: string) => json<{ sent: boolean; sale: Sale }>("POST", `/api/admin/pos/sales/${saleId}/receipt`, { email }), onSuccess: (r) => { refreshSale(r.sale); toast({ title: r.sent ? "Receipt sent" : "Receipt not sent", variant: r.sent ? undefined : "destructive" }); }, onError: fail });
  // The office form must link to a sale, so the sale exists BEFORE the form
  // opens — otherwise the form would take the payment itself.
  const startPlayerRegistration = async () => {
    if (s) { setRegisterOpen(true); return; }
    setOpeningForPlayer(true);
    try {
      const created = await json<Sale>("POST", "/api/admin/pos/sales", { registerId: register!.id });
      setSaleId(created.id); ls.set("clubos_pos_sale", String(created.id)); refreshSale(created);
      setRegisterOpen(true);
    } catch (e) { fail(e); } finally { setOpeningForPlayer(false); }
  };
  const decline = useMutation({ mutationFn: (body: Record<string, unknown>) => json("POST", "/api/admin/pos/declines", { registerId: register!.id, ...body }), onSuccess: () => { setDeclineOpen(false); toast({ title: "Noted", description: "That goes in the count for an eftpos integration." }); }, onError: fail });

  // Barcodes: a camera scan or a keyboard-wedge scanner both land here.
  const onCode = useCallback(async (code: string) => {
    try {
      const c = await json<Catalogue>("GET", `/api/admin/pos/catalogue?code=${encodeURIComponent(code)}`);
      if (c.codeHit) { addLine.mutate({ kind: "variant", variantId: c.codeHit.variantId, qty: 1 }); setScanOpen(false); }
      else toast({ title: "Not recognised", description: `No item carries the code ${code}.`, variant: "destructive" });
    } catch (e) { fail(e); }
  }, [addLine, toast]);
  const wedgeRef = useRef<WedgeState>(EMPTY_WEDGE);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreWedgeTarget(e.target)) return;
      const r = feedWedgeKey(wedgeRef.current, { key: e.key, at: e.timeStamp || Date.now() });
      wedgeRef.current = r.state;
      if (r.kind === "scan") onCode(r.code);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCode]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const brands = boot.data?.brands ?? [];
  const brandName = (id: number) => brands.find((b) => b.id === id)?.name ?? "";
  const qq = q.trim().toLowerCase();
  const products = (catalogue.data?.products ?? []).filter((p) => (brand == null || p.orgId === brand) && (!qq || p.title.toLowerCase().includes(qq)));
  const programmes = (catalogue.data?.programmes ?? []).filter((p) => (brand == null || p.orgId === brand) && (!qq || p.name.toLowerCase().includes(qq)));
  const events = (catalogue.data?.events ?? []).filter((e) => (brand == null || e.orgId === brand) && (!qq || e.name.toLowerCase().includes(qq)));
  const s = sale.data && sale.data.status === "open" ? sale.data : null;
  const done = sale.data && sale.data.status !== "open" ? sale.data : null;
  const cardPending = s?.payments.find((p) => p.status === "pending") ?? null;
  useEffect(() => { if (cardPending && cardPaymentId !== cardPending.id) setCardPaymentId(cardPending.id); }, [cardPending, cardPaymentId]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (boot.isLoading) return <div className="p-8 text-neutral-500 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading the register…</div>;
  if (boot.isError || !boot.data) return <div className="p-8 text-red-600">The register could not load. {errMessage(boot.error)}</div>;
  if (!register) return <div className="p-8 text-neutral-600">No register exists yet. Ask Daniel to add one.</div>;

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#ededed] text-neutral-900" data-testid="pos-register">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 bg-white border-b border-neutral-200">
        <ShoppingBag className="h-5 w-5 text-neutral-700" />
        <div className="mr-auto">
          <div className="text-[15px] font-semibold leading-tight">{register.name}</div>
          <div className="text-[12px] text-neutral-500">{shift ? `Shift open · ${shift.openedByName ?? "staff"} · float ${$(shift.openingFloatCents)}` : "No shift open"}</div>
        </div>
        {shift && <button className={btnGhost} onClick={() => setRecentOpen(true)} data-testid="pos-recent"><Receipt className="h-4 w-4" />Sales</button>}
        {shift && <button className={btnGhost} onClick={() => setDeclineOpen(true)} data-testid="pos-decline"><AlertTriangle className="h-4 w-4" />Couldn't pay</button>}
        {shift && <button className={btnGhost} onClick={() => setCashupOpen(true)} data-testid="pos-cashup"><Banknote className="h-4 w-4" />Cash up</button>}
      </div>

      {!shift ? (
        <div className="max-w-md mx-auto mt-10 bg-white rounded-2xl p-6 shadow-sm" data-testid="pos-open-shift">
          <h2 className="text-lg font-semibold">Open the till</h2>
          <p className="text-[13px] text-neutral-600 mt-1">Count the float in the drawer before the first sale. Expected cash at close is the float plus cash taken, worked out for you.</p>
          <label className="block mt-4 text-[13px] font-medium">Opening float</label>
          <div className="relative mt-1"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">$</span><input inputMode="decimal" className={`${inputCls} pl-7`} value={floatDollars} onChange={(e) => setFloatDollars(e.target.value)} data-testid="pos-float" /></div>
          <button className={`${btnPrimary} w-full mt-4`} disabled={openShift.isPending} onClick={() => openShift.mutate()} data-testid="pos-open-shift-btn">{openShift.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Open shift</button>
        </div>
      ) : (
        <div className="grid md:grid-cols-[1fr_400px] gap-3 p-3">
          {/* ── Left: what's for sale ── */}
          <div className="min-w-0">
            <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
              <Chip active={brand == null} onClick={() => setBrand(null)}>All brands</Chip>
              {brands.filter((b) => b.slug !== "united-sports-group").map((b) => <Chip key={b.id} active={brand === b.id} onClick={() => setBrand(b.id)}>{b.name}</Chip>)}
            </div>
            <div className="flex gap-2 mt-1">
              <div className="relative flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" /><input className={`${inputCls} pl-9`} placeholder="Search, or scan with a USB/Bluetooth scanner" value={q} onChange={(e) => setQ(e.target.value)} data-testid="pos-search" /></div>
              <button className={btnIcon} title="Scan with the camera" onClick={() => setScanOpen(true)} data-testid="pos-scan"><ScanLine className="h-5 w-5" /></button>
            </div>
            <div className="flex gap-2 mt-2">
              {(["products", "programmes", "events", "custom"] as const).map((t) => <Chip key={t} active={tab === t} onClick={() => setTab(t)}>{t === "products" ? "Merch" : t === "programmes" ? "Programmes" : t === "events" ? "Events" : "Custom line"}</Chip>)}
            </div>

            {tab === "products" && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mt-3" data-testid="pos-products">
                {catalogue.isLoading && <div className="col-span-full text-neutral-500 text-sm p-4">Loading…</div>}
                {!catalogue.isLoading && products.length === 0 && <div className="col-span-full text-neutral-500 text-sm p-4">Nothing on sale here yet{brand != null ? ` for ${brandName(brand)}` : ""}. CUFC and SIU kit arrives once their Shopify catalogues are imported.</div>}
                {products.map((p) => (
                  <button key={p.id} type="button" onClick={() => setPicking(p)} className="text-left bg-white rounded-xl border border-neutral-200 overflow-hidden hover:border-neutral-400 active:scale-[0.99] transition min-h-[44px]" data-testid={`pos-product-${p.id}`}>
                    {p.image ? <img src={p.image} alt="" className="w-full aspect-square object-cover" /> : <div className="w-full aspect-square bg-neutral-100 flex items-center justify-center text-neutral-300"><ShoppingBag className="h-8 w-8" /></div>}
                    <div className="p-2">
                      <div className="text-[13px] font-medium leading-snug line-clamp-2">{p.title}</div>
                      <div className="flex items-center justify-between mt-1"><span className="text-[11px] text-neutral-500 truncate">{brandName(p.orgId)}</span><span className="text-[13px] font-semibold">{$(p.priceCents)}</span></div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {tab === "programmes" && (
              <div className="mt-3 space-y-2" data-testid="pos-programmes">
                <div className="bg-white rounded-xl border border-neutral-200 p-3 text-[13px] text-neutral-600">A programme is registered on the office form, priced by the same engine as the website, and paid here as part of this sale. Pre-Academy and Academy can be sold here even while invite-only.</div>
                <button className={`${btnPrimary} w-full`} disabled={openingForPlayer} onClick={startPlayerRegistration} data-testid="pos-register-player">{openingForPlayer ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}Register a player for this sale</button>
                {programmes.map((p) => (
                  <div key={p.id} className="bg-white rounded-xl border border-neutral-200 p-3 flex items-center gap-3">
                    <div className="min-w-0 flex-1"><div className="text-[14px] font-medium truncate">{p.name}</div><div className="text-[12px] text-neutral-500">{brandName(p.orgId)} · {p.type === "academy" ? "term programme" : "holiday camp"}{p.registrationOpen ? "" : " · invite-only"}</div></div>
                    <div className="text-[13px] text-neutral-700 whitespace-nowrap">{p.options.length ? `from ${$(Math.min(...p.options.map((o) => o.fullPriceCents)))}` : "priced at checkout"}</div>
                  </div>
                ))}
              </div>
            )}

            {tab === "events" && (
              <div className="mt-3 space-y-2" data-testid="pos-events">
                {events.length === 0 && <div className="text-neutral-500 text-sm p-4">No event has tickets on sale right now.</div>}
                {events.map((e) => <EventCard key={e.id} event={e} brand={brandName(e.orgId)} sale={s} onAdd={(body) => addLine.mutate(body)} />)}
              </div>
            )}

            {tab === "custom" && <CustomLine brands={brands.filter((b) => b.slug !== "sandbox")} defaultOrg={brand ?? register.defaultOrgId ?? 1} onAdd={(body) => addLine.mutate(body)} pending={addLine.isPending} />}
          </div>

          {/* ── Right: the cart ── */}
          <div className="md:sticky md:top-3 self-start">
            <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm overflow-hidden" data-testid="pos-cart">
              <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-100">
                <div className="text-[13px] font-semibold">{s ? s.saleNumber : done ? done.saleNumber : "New sale"}{s && <span className="ml-2 text-[11px] font-normal text-neutral-500">{boot.data.brands.find((b) => b.account === s.moneyAccount && b.slug !== "sandbox") ? (s.moneyAccount === "club" ? "club account" : s.moneyAccount === "cugc" ? "gymnastics account" : "trust account") : s.moneyAccount}</span>}</div>
                {s && s.lines.length > 0 && s.paidCents === 0 && <button className="text-[12px] text-neutral-500 hover:text-red-600" onClick={() => voidSale.mutate("Cleared at the register")} data-testid="pos-clear">Clear</button>}
                {done && <button className="text-[12px] text-blue-700" onClick={() => { setSaleId(null); ls.set("clubos_pos_sale", null); }} data-testid="pos-new-sale">New sale</button>}
              </div>

              {done && (
                <div className="p-4 space-y-3" data-testid="pos-done">
                  <div className="flex items-center gap-2 text-emerald-700"><CheckCircle2 className="h-5 w-5" /><span className="font-semibold">{done.status === "paid" ? "Paid" : done.status === "void" ? "Cleared" : done.status.replace("_", " ")} · {$(done.totalCents)}</span></div>
                  <ul className="text-[13px] text-neutral-700 space-y-1">{done.lines.map((l) => <li key={l.id} className="flex justify-between gap-2"><span className="truncate">{l.qty}× {l.title}{l.detail ? ` · ${l.detail}` : ""}</span><span>{$(l.lineCents)}</span></li>)}</ul>
                  <ul className="text-[12px] text-neutral-500 space-y-0.5">{done.payments.filter((p) => p.status === "succeeded").map((p) => <li key={p.id}>Paid by {p.label}{p.reference ? ` (${p.reference})` : ""} · {$(p.amountCents)}</li>)}{done.refunds.map((r) => <li key={r.id} className="text-red-700">Refunded {$(r.amountCents)} — {r.reason}</li>)}</ul>
                  {done.paidAt && <ReceiptRow sale={done} onSend={(email) => sendReceipt.mutate(email)} pending={sendReceipt.isPending} />}
                  {done.paidAt && done.refundableCents > 0 && (boot.data.me.canIssueRefunds
                    ? <button className={`${btnGhost} w-full`} onClick={() => setRefundOpen(true)} data-testid="pos-refund"><RotateCcw className="h-4 w-4" />Refund</button>
                    : <div className="text-[12px] text-neutral-500">Refunds need the refund permission — ask Daniel, Olga, Travis or Natalia.</div>)}
                </div>
              )}

              {!done && (
                <>
                  <div className="max-h-[38vh] overflow-y-auto divide-y divide-neutral-100">
                    {(!s || s.lines.length === 0) && <div className="p-6 text-center text-[13px] text-neutral-500">Tap an item, scan a tag, or register a player.</div>}
                    {s?.lines.map((l) => (
                      <div key={l.id} className="flex items-center gap-2 px-4 py-2.5" data-testid={`pos-line-${l.id}`}>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium truncate">{l.title}</div>
                          <div className="text-[11px] text-neutral-500 truncate">{[l.detail, l.brand].filter(Boolean).join(" · ")}</div>
                        </div>
                        {l.kind === "variant" || l.kind === "custom" || l.kind === "event_ticket" ? (
                          <div className="flex items-center gap-1">
                            <button className="h-9 w-9 rounded-lg border border-neutral-200 flex items-center justify-center disabled:opacity-40" disabled={s.paidCents > 0} onClick={() => l.qty > 1 ? setQty.mutate({ lineId: l.id, qty: l.qty - 1 }) : removeLine.mutate(l.id)} aria-label="Less" data-testid={`pos-line-minus-${l.id}`}><Minus className="h-4 w-4" /></button>
                            <span className="w-6 text-center text-[13px]" data-testid={`pos-line-qty-${l.id}`}>{l.qty}</span>
                            <button className="h-9 w-9 rounded-lg border border-neutral-200 flex items-center justify-center disabled:opacity-40" disabled={s.paidCents > 0} onClick={() => setQty.mutate({ lineId: l.id, qty: l.qty + 1 })} aria-label="More" data-testid={`pos-line-plus-${l.id}`}><Plus className="h-4 w-4" /></button>
                          </div>
                        ) : null}
                        <div className="w-16 text-right text-[13px] font-medium">{$(l.lineCents)}</div>
                        <button className="h-9 w-9 rounded-lg text-neutral-400 hover:text-red-600 flex items-center justify-center" onClick={() => removeLine.mutate(l.id)} disabled={s.paidCents > 0} aria-label="Remove"><Trash2 className="h-4 w-4" /></button>
                      </div>
                    ))}
                  </div>

                  <div className="px-4 py-3 border-t border-neutral-100 space-y-1.5 text-[13px]">
                    <div className="flex items-center justify-between">
                      <button className="flex items-center gap-1.5 text-neutral-700" onClick={() => s && setCustomerOpen(true)} disabled={!s} data-testid="pos-customer"><UserRound className="h-4 w-4" />{s?.customerName || s?.customerEmail || "Add customer"}</button>
                      <button className="flex items-center gap-1.5 text-neutral-700" onClick={() => s && setDiscountOpen(true)} disabled={!s || s.paidCents > 0} data-testid="pos-discount"><Percent className="h-4 w-4" />{s?.discountCents ? `-${$(s.discountCents)}` : "Discount"}</button>
                    </div>
                    <Row label="Subtotal" value={$(s?.subtotalCents ?? 0)} />
                    {!!s?.discountCents && <Row label={`Discount${s.discountReason ? ` — ${s.discountReason}` : ""}`} value={`-${$(s.discountCents)}`} />}
                    {!!s?.roundingCents && <Row label="Cash rounding" value={`${s.roundingCents > 0 ? "+" : "-"}${$(Math.abs(s.roundingCents))}`} />}
                    {!!s?.paidCents && <Row label="Paid so far" value={$(s.paidCents)} />}
                    <div className="flex items-center justify-between pt-1"><span className="text-[15px] font-semibold">{s?.paidCents ? "Still owing" : "Total"}</span><span className="text-[20px] font-bold" data-testid="pos-total">{$(s ? s.remainingCents : 0)}</span></div>
                    <div className="text-[11px] text-neutral-500">Includes GST of {$(s?.gstCents ?? 0)}</div>
                  </div>
                  <div className="p-3 border-t border-neutral-100">
                    {s && s.lines.length > 0 && s.totalCents === 0
                      ? <button className={`${btnPrimary} w-full h-12 text-[15px]`} disabled={complete.isPending} onClick={() => complete.mutate()} data-testid="pos-complete"><CheckCircle2 className="h-5 w-5" />Nothing to pay — finish</button>
                      : <button className={`${btnPrimary} w-full h-12 text-[15px]`} disabled={!s || s.lines.length === 0} onClick={() => setTenderOpen(true)} data-testid="pos-charge"><CreditCard className="h-5 w-5" />Charge {$(s ? s.remainingCents : 0)}</button>}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Sheets ── */}
      {picking && <VariantSheet product={picking} brand={brandName(picking.orgId)} onClose={() => setPicking(null)} onPick={(variantId) => addLine.mutate({ kind: "variant", variantId, qty: 1 })} pending={addLine.isPending} />}
      <ScanDialog open={scanOpen} onClose={() => setScanOpen(false)} onCode={onCode} />
      {s && <TenderSheet open={tenderOpen} onClose={() => setTenderOpen(false)} sale={s} tenders={boot.data.manualTenders} hasReader={register.hasReader} onPay={(b) => pay.mutate(b)} onCard={() => cardPay.mutate()} onCancelCard={() => cancelCard.mutate()} cardPending={!!cardPending || cardPay.isPending} pending={pay.isPending} />}
      {s && <CustomerDialog open={customerOpen} onClose={() => setCustomerOpen(false)} sale={s} onSave={(b) => patchSale.mutate(b)} pending={patchSale.isPending} />}
      {s && <DiscountDialog open={discountOpen} onClose={() => setDiscountOpen(false)} sale={s} onSave={(b) => patchSale.mutate(b)} pending={patchSale.isPending} />}
      {done && <RefundDialog open={refundOpen} onClose={() => setRefundOpen(false)} sale={done} onSave={(b) => refund.mutate(b)} pending={refund.isPending} />}
      <CashupDialog open={cashupOpen} onClose={() => { setCashupOpen(false); refreshBoot(); }} shiftId={shift?.id ?? null} onClosed={() => { setSaleId(null); ls.set("clubos_pos_sale", null); refreshBoot(); }} />
      <DeclineDialog open={declineOpen} onClose={() => setDeclineOpen(false)} reasons={boot.data.declineReasons} onSave={(b) => decline.mutate(b)} pending={decline.isPending} />
      <RecentDialog open={recentOpen} onClose={() => setRecentOpen(false)} sales={recent.data ?? []} onOpen={(id) => { setSaleId(id); ls.set("clubos_pos_sale", String(id)); setRecentOpen(false); }} />
      {s && <RegisterPlayerModal open={registerOpen} onClose={() => setRegisterOpen(false)} scope="all" posSaleId={s.id}
        onRegistered={(d) => addLine.mutate({ kind: "registration", registrationId: d.registrationId })} />}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between text-neutral-600"><span className="truncate pr-3">{label}</span><span className="whitespace-nowrap">{value}</span></div>;
}

function VariantSheet({ product, brand, onClose, onPick, pending }: { product: Product; brand: string; onClose: () => void; onPick: (variantId: number) => void; pending: boolean }) {
  const [colourId, setColourId] = useState<number>(product.colours[0]?.id);
  const colour = product.colours.find((c) => c.id === colourId) ?? product.colours[0];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle className="text-[16px] font-semibold">{product.title}</DialogTitle>
        <div className="text-[12px] text-neutral-500 -mt-2">{brand} · {$(product.priceCents)}</div>
        {product.colours.length > 1 && (
          <div className="flex flex-wrap gap-2">{product.colours.map((c) => <Chip key={c.id} active={c.id === colour?.id} onClick={() => setColourId(c.id)}>{c.swatchHex && <span className="inline-block h-3 w-3 rounded-full mr-1.5 border border-black/10" style={{ background: c.swatchHex }} />}{c.name}</Chip>)}</div>
        )}
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2" data-testid="pos-sizes">
          {colour?.variants.map((v) => (
            <button key={v.id} type="button" disabled={pending || v.stock <= 0} onClick={() => onPick(v.id)} className={`h-12 rounded-xl border text-[14px] font-medium ${v.stock > 0 ? "bg-white border-neutral-200 hover:border-neutral-500" : "bg-neutral-100 border-neutral-100 text-neutral-400 line-through"}`} data-testid={`pos-size-${v.id}`}>
              {v.size}<div className="text-[10px] font-normal text-neutral-500">{v.stock > 0 ? `${v.stock} left` : "none"}{v.priceCents !== product.priceCents ? ` · ${$(v.priceCents)}` : ""}</div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CustomLine({ brands, defaultOrg, onAdd, pending }: { brands: Brand[]; defaultOrg: number; onAdd: (b: Record<string, unknown>) => void; pending: boolean }) {
  const [orgId, setOrgId] = useState(defaultOrg);
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState(1);
  const cents = dollarInputToCents(price);
  return (
    <div className="mt-3 bg-white rounded-xl border border-neutral-200 p-4 space-y-3 max-w-md" data-testid="pos-custom">
      <div className="text-[13px] text-neutral-600">For anything not on the list — a raffle ticket, a sausage, a replacement sock. It still books to a brand.</div>
      <div className="flex flex-wrap gap-2">{brands.map((b) => <Chip key={b.id} active={orgId === b.id} onClick={() => setOrgId(b.id)}>{b.name}</Chip>)}</div>
      <input className={inputCls} placeholder="What is it?" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="pos-custom-title" />
      <div className="flex gap-2">
        <div className="relative flex-1"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">$</span><input inputMode="decimal" className={`${inputCls} pl-7`} placeholder="0.00" value={price} onChange={(e) => setPrice(e.target.value)} data-testid="pos-custom-price" /></div>
        <div className="flex items-center gap-1"><button className={btnIcon} onClick={() => setQty(Math.max(1, qty - 1))}><Minus className="h-4 w-4" /></button><span className="w-8 text-center">{qty}</span><button className={btnIcon} onClick={() => setQty(qty + 1)}><Plus className="h-4 w-4" /></button></div>
      </div>
      <button className={`${btnPrimary} w-full`} disabled={pending || !title.trim() || !(cents >= 0) || price.trim() === ""} onClick={() => { onAdd({ kind: "custom", orgId, title: title.trim(), unitCents: cents, qty }); setTitle(""); setPrice(""); setQty(1); }} data-testid="pos-custom-add"><Plus className="h-4 w-4" />Add to sale</button>
    </div>
  );
}

function EventCard({ event, brand, sale, onAdd }: { event: EventRow; brand: string; sale: Sale | null; onAdd: (b: Record<string, unknown>) => void }) {
  const [typeId, setTypeId] = useState(event.ticketTypes[0]?.id);
  const [qty, setQty] = useState(1);
  const [name, setName] = useState(sale?.customerName ?? "");
  const [email, setEmail] = useState(sale?.customerEmail ?? "");
  const t = event.ticketTypes.find((x) => x.id === typeId) ?? event.ticketTypes[0];
  return (
    <div className="bg-white rounded-xl border border-neutral-200 p-3 space-y-2">
      <div className="text-[14px] font-medium">{event.name}</div>
      <div className="text-[12px] text-neutral-500">{brand} · {new Date(event.startsAt).toLocaleDateString("en-NZ", { timeZone: "Pacific/Auckland", dateStyle: "medium" })}</div>
      <div className="flex flex-wrap gap-2">{event.ticketTypes.map((tt) => <Chip key={tt.id} active={tt.id === t?.id} onClick={() => setTypeId(tt.id)}>{tt.name} · {$(tt.priceCents)}</Chip>)}</div>
      <div className="grid sm:grid-cols-2 gap-2"><input className={inputCls} placeholder="Buyer's name" value={name} onChange={(e) => setName(e.target.value)} /><input className={inputCls} placeholder="Buyer's email (the ticket goes there)" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
      <div className="flex items-center gap-2">
        <button className={btnIcon} onClick={() => setQty(Math.max(1, qty - 1))}><Minus className="h-4 w-4" /></button><span className="w-8 text-center">{qty}</span><button className={btnIcon} onClick={() => setQty(qty + 1)}><Plus className="h-4 w-4" /></button>
        <button className={`${btnPrimary} ml-auto`} disabled={!t || name.trim().length < 2 || !email.includes("@")} onClick={() => onAdd({ kind: "event_ticket", ticketTypeId: t!.id, qty, buyerName: name.trim(), buyerEmail: email.trim() })}><Plus className="h-4 w-4" />Add {qty > 1 ? `${qty} tickets` : "ticket"}</button>
      </div>
    </div>
  );
}

function TenderSheet({ open, onClose, sale, tenders, hasReader, onPay, onCard, onCancelCard, cardPending, pending }: {
  open: boolean; onClose: () => void; sale: Sale; tenders: Bootstrap["manualTenders"]; hasReader: boolean;
  onPay: (b: { method: string; amountCents: number; reference?: string }) => void; onCard: () => void; onCancelCard: () => void; cardPending: boolean; pending: boolean;
}) {
  const [method, setMethod] = useState<string>("cash");
  const [tendered, setTendered] = useState("");
  const [reference, setReference] = useState("");
  const remaining = sale.remainingCents;
  const rounded = roundCashToTenCents(remaining).roundedCents;
  useEffect(() => { if (open) { setTendered(""); setReference(""); } }, [open, remaining]);
  const tenderedCents = dollarInputToCents(tendered);
  const cash = method === "cash";
  const amount = cash ? (tenderedCents || rounded) : (tenderedCents || remaining);
  const change = cash && tenderedCents > rounded ? tenderedCents - rounded : 0;
  const t = tenders.find((x) => x.value === method);
  const icon = (m: string) => m === "cash" ? <Banknote className="h-4 w-4" /> : m === "eftpos" ? <CreditCard className="h-4 w-4" /> : m === "bank_transfer" ? <Landmark className="h-4 w-4" /> : <MoreHorizontal className="h-4 w-4" />;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !cardPending && onClose()}>
      <DialogContent className="max-w-md" data-testid="pos-tender">
        <DialogTitle className="text-[16px] font-semibold">Take {$(remaining)}</DialogTitle>
        {cardPending ? (
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-[14px]">
            <div className="flex items-center gap-2 font-medium"><Loader2 className="h-4 w-4 animate-spin" />Waiting for the card…</div>
            <div className="text-[12px] text-neutral-600 mt-1">Ask the customer to tap or insert on the reader. This updates by itself.</div>
            <button className={`${btnGhost} mt-3`} onClick={onCancelCard}>Cancel card payment</button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              {tenders.map((x) => <button key={x.value} type="button" onClick={() => setMethod(x.value)} className={`h-12 rounded-xl border text-[14px] font-medium flex items-center justify-center gap-2 ${method === x.value ? "bg-neutral-900 text-white border-neutral-900" : "bg-white border-neutral-200"}`} data-testid={`pos-tender-${x.value}`}>{icon(x.value)}{x.label}</button>)}
              <button type="button" onClick={onCard} disabled={!hasReader} title={hasReader ? "" : "No Stripe reader on this register yet"} className="h-12 rounded-xl border text-[14px] font-medium flex items-center justify-center gap-2 bg-white border-neutral-200 disabled:opacity-40 col-span-2" data-testid="pos-tender-card"><CreditCard className="h-4 w-4" />Card reader{hasReader ? "" : " (not set up)"}</button>
            </div>
            {cash && (
              <div className="space-y-2">
                <div className="text-[12px] text-neutral-600">Cash rounds to the nearest 10c: <b>{$(rounded)}</b>{rounded !== remaining ? ` (was ${$(remaining)})` : ""}.</div>
                <div className="flex flex-wrap gap-2">{[rounded, 2000, 5000, 10000].filter((v, i, a) => a.indexOf(v) === i && v >= rounded).map((v) => <Chip key={v} active={tenderedCents === v} onClick={() => setTendered(centsToDollarInput(v))}>{v === rounded ? "Exact" : $(v)}</Chip>)}</div>
                <div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">$</span><input inputMode="decimal" className={`${inputCls} pl-7`} placeholder={`Cash handed over (${centsToDollarInput(rounded)})`} value={tendered} onChange={(e) => setTendered(e.target.value)} data-testid="pos-tendered" /></div>
                {change > 0 && <div className="text-[15px] font-semibold text-emerald-700">Change {$(change)}</div>}
              </div>
            )}
            {!cash && (
              <div className="space-y-2">
                <div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">$</span><input inputMode="decimal" className={`${inputCls} pl-7`} placeholder={`Amount (${centsToDollarInput(remaining)} owing)`} value={tendered} onChange={(e) => setTendered(e.target.value)} data-testid="pos-amount" /></div>
                {t?.needsReference && <input className={inputCls} placeholder={method === "eftpos" ? "Terminal receipt / slip number" : "Reference"} value={reference} onChange={(e) => setReference(e.target.value)} data-testid="pos-reference" />}
                {method === "eftpos" && <div className="text-[12px] text-neutral-600">Key {$(amount)} into the EFTPOS terminal, then record the slip number here. This is also the way to take an eftpos-only card.</div>}
              </div>
            )}
            <button className={`${btnPrimary} w-full h-12 text-[15px]`} disabled={pending || amount <= 0 || (t?.needsReference && method !== "other" && !reference.trim())} onClick={() => onPay({ method, amountCents: cash ? (tenderedCents || rounded) : amount, reference: reference.trim() || undefined })} data-testid="pos-pay">{pending && <Loader2 className="h-4 w-4 animate-spin" />}Record {$(cash ? Math.min(tenderedCents || rounded, rounded) : amount)} {t?.label.toLowerCase()}</button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReceiptRow({ sale, onSend, pending }: { sale: Sale; onSend: (email: string) => void; pending: boolean }) {
  const [email, setEmail] = useState(sale.customerEmail ?? "");
  return (
    <div className="space-y-2" data-testid="pos-receipt">
      <div className="flex gap-2"><input className={inputCls} placeholder="Email for the receipt" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="pos-receipt-email" /><button className={btnGhost} disabled={pending || !email.includes("@")} onClick={() => onSend(email.trim())} data-testid="pos-receipt-send">{pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Receipt className="h-4 w-4" />}Send</button></div>
      <div className="text-[12px] text-neutral-500">{sale.receiptSentAt ? `Receipt sent ${new Date(sale.receiptSentAt).toLocaleTimeString("en-NZ", { timeZone: "Pacific/Auckland", timeStyle: "short" })}. ` : ""}<a className="text-blue-700" href={sale.receiptUrl} target="_blank" rel="noreferrer">Open the receipt to print</a></div>
    </div>
  );
}

function CustomerDialog({ open, onClose, sale, onSave, pending }: { open: boolean; onClose: () => void; sale: Sale; onSave: (b: Record<string, unknown>) => void; pending: boolean }) {
  const [name, setName] = useState(sale.customerName ?? "");
  const [email, setEmail] = useState(sale.customerEmail ?? "");
  const [phone, setPhone] = useState(sale.customerPhone ?? "");
  const [optIn, setOptIn] = useState(!!sale.marketingOptInAt);
  const [search, setSearch] = useState("");
  const people = useQuery<{ results?: any[] } | any[]>({ queryKey: ["/api/admin/search", search], queryFn: () => json("GET", `/api/admin/search?q=${encodeURIComponent(search)}`), enabled: open && search.trim().length >= 2 });
  const hits: any[] = Array.isArray(people.data) ? people.data : (people.data as any)?.results ?? [];
  useEffect(() => { if (open) { setName(sale.customerName ?? ""); setEmail(sale.customerEmail ?? ""); setPhone(sale.customerPhone ?? ""); setOptIn(!!sale.marketingOptInAt); } }, [open, sale.customerName, sale.customerEmail, sale.customerPhone, sale.marketingOptInAt]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="pos-customer-dialog">
        <DialogTitle className="text-[16px] font-semibold">Customer</DialogTitle>
        <input className={inputCls} placeholder="Find a parent or player already in ClubOS" value={search} onChange={(e) => setSearch(e.target.value)} />
        {hits.length > 0 && <div className="max-h-40 overflow-y-auto divide-y divide-neutral-100 rounded-xl border border-neutral-200">{hits.filter((h) => /contact|parent|player|guardian/i.test(String(h.type ?? h.entity ?? ""))).slice(0, 8).map((h, i) => <button key={i} className="w-full text-left px-3 py-2 text-[13px] hover:bg-neutral-50" onClick={() => { const id = Number(h.id ?? h.entityId); if (Number.isFinite(id)) onSave({ contactId: id, customer: { name, email, phone }, marketingOptIn: optIn }); }}>{h.title ?? h.name ?? h.label}<span className="text-neutral-500"> · {h.subtitle ?? h.type ?? ""}</span></button>)}</div>}
        <input className={inputCls} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} data-testid="pos-customer-name" />
        <input className={inputCls} placeholder="Email (for the receipt)" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="pos-customer-email" />
        <input className={inputCls} placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <label className="flex items-start gap-2 text-[12px] text-neutral-600"><input type="checkbox" className="mt-0.5" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />They asked to hear about club news and offers by email. Left unticked, they only get the receipt.</label>
        <button className={`${btnPrimary} w-full`} disabled={pending} onClick={() => onSave({ customer: { name, email, phone }, marketingOptIn: optIn })} data-testid="pos-customer-save">Save</button>
      </DialogContent>
    </Dialog>
  );
}

function DiscountDialog({ open, onClose, sale, onSave, pending }: { open: boolean; onClose: () => void; sale: Sale; onSave: (b: Record<string, unknown>) => void; pending: boolean }) {
  const [amount, setAmount] = useState(sale.discountCents ? centsToDollarInput(sale.discountCents) : "");
  const [reason, setReason] = useState(sale.discountReason ?? "");
  const cents = dollarInputToCents(amount);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm" data-testid="pos-discount-dialog">
        <DialogTitle className="text-[16px] font-semibold">Discount</DialogTitle>
        <div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">$</span><input inputMode="decimal" className={`${inputCls} pl-7`} placeholder="Amount off" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="pos-discount-amount" /></div>
        <input className={inputCls} placeholder="Why? (goes on the sale)" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="pos-discount-reason" />
        <div className="flex gap-2"><button className={`${btnGhost} flex-1`} onClick={() => onSave({ discountCents: 0 })}>Remove</button><button className={`${btnPrimary} flex-1`} disabled={pending || cents <= 0 || cents > sale.subtotalCents || !reason.trim()} onClick={() => onSave({ discountCents: cents, discountReason: reason.trim() })} data-testid="pos-discount-save">Apply</button></div>
      </DialogContent>
    </Dialog>
  );
}

function RefundDialog({ open, onClose, sale, onSave, pending }: { open: boolean; onClose: () => void; sale: Sale; onSave: (b: { amountCents: number; reason: string }) => void; pending: boolean }) {
  const [amount, setAmount] = useState(centsToDollarInput(sale.refundableCents));
  const [reason, setReason] = useState("");
  const cents = dollarInputToCents(amount);
  const card = sale.payments.find((p) => p.status === "succeeded" && p.method === "card_present");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm" data-testid="pos-refund-dialog">
        <DialogTitle className="text-[16px] font-semibold">Refund {sale.saleNumber}</DialogTitle>
        <div className="text-[12px] text-neutral-600">{$(sale.refundableCents)} can be refunded. {card ? "Card payments go back to the same card through Stripe (5–10 business days)." : "Cash, EFTPOS and bank refunds are recorded here and handed back over the counter or paid from the bank."}</div>
        <div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">$</span><input inputMode="decimal" className={`${inputCls} pl-7`} value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="pos-refund-amount" /></div>
        <input className={inputCls} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="pos-refund-reason" />
        <button className={`${btnPrimary} w-full`} disabled={pending || cents <= 0 || cents > sale.refundableCents || !reason.trim()} onClick={() => onSave({ amountCents: cents, reason: reason.trim() })} data-testid="pos-refund-save">{pending && <Loader2 className="h-4 w-4 animate-spin" />}Refund {$(cents)}</button>
      </DialogContent>
    </Dialog>
  );
}

function CashupDialog({ open, onClose, shiftId, onClosed }: { open: boolean; onClose: () => void; shiftId: number | null; onClosed: () => void }) {
  const { toast } = useToast();
  const summary = useQuery<Summary>({ queryKey: ["/api/admin/pos/shifts", shiftId, "summary"], queryFn: () => json("GET", `/api/admin/pos/shifts/${shiftId}/summary`), enabled: open && !!shiftId });
  const [counted, setCounted] = useState("");
  const [notes, setNotes] = useState("");
  const [result, setResult] = useState<Summary | null>(null);
  const close = useMutation({ mutationFn: () => json<Summary>("POST", `/api/admin/pos/shifts/${shiftId}/close`, { countedCents: dollarInputToCents(counted), notes }), onSuccess: (r) => { setResult(r); onClosed(); }, onError: (e) => toast({ title: "Couldn't close the shift", description: errMessage(e), variant: "destructive" }) });
  const sm = result ?? summary.data;
  const countedCents = dollarInputToCents(counted);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="pos-cashup-dialog">
        <DialogTitle className="text-[16px] font-semibold">{result ? "Shift closed" : "Cash up"}</DialogTitle>
        {!sm ? <div className="text-neutral-500 text-sm">Loading…</div> : (
          <div className="space-y-3 text-[13px]">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Sales" value={String(sm.sales.paid)} /><Stat label="Taken" value={$(sm.takenCents)} /><Stat label="Refunded" value={$(sm.refundedCents)} /><Stat label="GST in takings" value={$(sm.gstCents)} />
            </div>
            <div className="rounded-xl border border-neutral-200 divide-y divide-neutral-100">{sm.byTender.map((t) => <Row2 key={t.method} label={`${t.label} (${t.count})`} value={t.refundedCents ? `${$(t.cents)} − ${$(t.refundedCents)}` : $(t.cents)} />)}{sm.byTender.length === 0 && <div className="p-3 text-neutral-500">No payments yet.</div>}</div>
            {sm.byBrand.length > 0 && <div className="rounded-xl border border-neutral-200 divide-y divide-neutral-100">{sm.byBrand.map((b) => <Row2 key={b.name} label={b.name} value={$(b.cents)} />)}</div>}
            <div className="rounded-xl border border-neutral-200 divide-y divide-neutral-100">
              <Row2 label="Float" value={$(sm.cash.openingFloatCents)} /><Row2 label="Cash in" value={$(sm.cash.inCents)} /><Row2 label="Cash out (refunds)" value={$(sm.cash.outCents)} /><Row2 label="Expected in the drawer" value={$(sm.cash.expectedCents)} strong />
              {result && <Row2 label="Counted" value={$(sm.cash.countedCents ?? 0)} />}
              {result && <Row2 label="Variance" value={`${(sm.cash.varianceCents ?? 0) >= 0 ? "+" : "-"}${$(Math.abs(sm.cash.varianceCents ?? 0))}`} strong />}
            </div>
            {sm.declines.total > 0 && <div className="text-neutral-600">Couldn't pay: {Object.entries(sm.declines.byReason).map(([k, v]) => `${k.replace("_", " ")} ×${v}`).join(", ")}</div>}
            {!result && (
              <>
                <div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">$</span><input inputMode="decimal" className={`${inputCls} pl-7`} placeholder="Cash counted in the drawer" value={counted} onChange={(e) => setCounted(e.target.value)} data-testid="pos-counted" /></div>
                {counted && <div className={`font-medium ${countedCents - sm.cash.expectedCents === 0 ? "text-emerald-700" : "text-amber-700"}`}>Variance {countedCents - sm.cash.expectedCents >= 0 ? "+" : "-"}{$(Math.abs(countedCents - sm.cash.expectedCents))}</div>}
                <input className={inputCls} placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
                <button className={`${btnPrimary} w-full`} disabled={close.isPending || counted.trim() === ""} onClick={() => close.mutate()} data-testid="pos-close-shift">{close.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Close the shift</button>
                <div className="text-[11px] text-neutral-500">Any open, unpaid cart is cleared when the shift closes. A cart that has taken money must be finished first.</div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
function Stat({ label, value }: { label: string; value: string }) { return <div className="rounded-xl bg-neutral-50 border border-neutral-200 p-3"><div className="text-[11px] text-neutral-500">{label}</div><div className="text-[16px] font-semibold">{value}</div></div>; }
function Row2({ label, value, strong }: { label: string; value: string; strong?: boolean }) { return <div className={`flex items-center justify-between px-3 py-2 ${strong ? "font-semibold" : ""}`}><span>{label}</span><span>{value}</span></div>; }

function DeclineDialog({ open, onClose, reasons, onSave, pending }: { open: boolean; onClose: () => void; reasons: { value: string; label: string }[]; onSave: (b: Record<string, unknown>) => void; pending: boolean }) {
  const [reason, setReason] = useState("eftpos_only");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm" data-testid="pos-decline-dialog">
        <DialogTitle className="text-[16px] font-semibold">Couldn't pay</DialogTitle>
        <div className="text-[12px] text-neutral-600">A sale that didn't happen, and why. Eftpos-only cards are counted so we know when an eftpos integration is worth paying for.</div>
        <div className="flex flex-wrap gap-2">{reasons.map((r) => <Chip key={r.value} active={reason === r.value} onClick={() => setReason(r.value)}>{r.label}</Chip>)}</div>
        <div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">$</span><input inputMode="decimal" className={`${inputCls} pl-7`} placeholder="Roughly how much (optional)" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <input className={inputCls} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className={`${btnPrimary} w-full`} disabled={pending} onClick={() => onSave({ reason, amountCents: amount.trim() ? dollarInputToCents(amount) : null, note })} data-testid="pos-decline-save">Log it</button>
      </DialogContent>
    </Dialog>
  );
}

function RecentDialog({ open, onClose, sales, onOpen }: { open: boolean; onClose: () => void; sales: Sale[]; onOpen: (id: number) => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="pos-recent-dialog">
        <DialogTitle className="text-[16px] font-semibold">This shift's sales</DialogTitle>
        <div className="max-h-[60vh] overflow-y-auto divide-y divide-neutral-100 rounded-xl border border-neutral-200">
          {sales.length === 0 && <div className="p-4 text-[13px] text-neutral-500">No sales yet this shift.</div>}
          {sales.map((s) => <button key={s.id} className="w-full text-left px-3 py-2.5 text-[13px] hover:bg-neutral-50 flex items-center justify-between gap-2" onClick={() => onOpen(s.id)}><span>{s.saleNumber}<span className="text-neutral-500"> · {s.status.replace("_", " ")}{s.customerName ? ` · ${s.customerName}` : ""}</span></span><span className="font-medium">{$(s.totalCents)}</span></button>)}
        </div>
      </DialogContent>
    </Dialog>
  );
}
