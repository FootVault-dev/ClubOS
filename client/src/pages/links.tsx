// QR Code Generator (was: AttributionOS Links & QR, T11).
//
// A UNIVERSAL System tab as of 2026-09-03 — one place for every business,
// rather than a copy of the same page in each of the seven workspace sidebars.
// Because it is no longer scoped to where you are standing, the builder asks
// which BUSINESS the code is for and, optionally, which PROGRAMME, and derives
// the destination from that (shared/qr-targets.ts) instead of asking a person
// to remember whether a camp lives at /slug or /slug/class-book.
//
// Every link ever created is still here: the list reads across every business
// the viewer belongs to, so Dima's instant-quote codes and the 860-click
// field-hire one are in the same place as anything made today.
//
// Staff-facing builder for tracked short links (/l/:key) + QR posters + a
// WhatsApp click-to-chat helper. Consumes the T10 admin API
// (/api/admin/links CRUD + :id/stats). All destinations are validated against
// the same open-redirect allow-list the redirect route uses (defence in depth
// — the server re-checks). QR images are generated fully client-side
// (qrcode.react → canvas/svg), never an external QR service.
import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { QRCodeCanvas, QRCodeSVG } from "qrcode.react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Link2,
  Plus,
  Copy,
  Check,
  QrCode,
  Archive,
  ArchiveRestore,
  MessageCircle,
  ExternalLink,
  X,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { CANONICAL_CHANNELS } from "@shared/attribution";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isAllowedDestination, isValidLinkKey } from "@shared/short-links";
import { suggestedDestination, type QrBusiness } from "@shared/qr-targets";
import type { ShortLink } from "@shared/schema";

// Mirror of storage.ts ShortLinkWithClicks (kept local so the client never
// imports server code just for a shape).
type ShortLinkWithClicks = ShortLink & {
  last7dClicks: number;
  organizationName?: string | null;
  organizationSlug?: string | null;
  programName?: string | null;
};

function publicBase(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

function linkUrlFor(key: string): string {
  return `${publicBase()}/l/${key}`;
}

// URL to encode INSIDE a QR image: our short links get ?qr=1 so the redirect
// stores is_qr and the touch classifies as channel `qr` (scans vs shared-link
// clicks stay separable). Non-short-link URLs (raw wa.me) pass through as-is —
// appending would corrupt their own query params and nothing tracks them anyway.
function qrValueFor(url: string): string {
  if (!url.includes("/l/")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}qr=1`;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-NZ", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const CHANNEL_BADGE: Record<string, string> = {
  facebook: "bg-blue-500/15 text-blue-300 border-blue-500/25",
  instagram: "bg-pink-500/15 text-pink-300 border-pink-500/25",
  google: "bg-emerald-500/15 text-emerald-300 border-emerald-500/25",
  email: "bg-amber-500/15 text-amber-300 border-amber-500/25",
  whatsapp: "bg-green-500/15 text-green-300 border-green-500/25",
  sms: "bg-cyan-500/15 text-cyan-300 border-cyan-500/25",
  qr: "bg-violet-500/15 text-violet-300 border-violet-500/25",
  referral: "bg-indigo-500/15 text-indigo-300 border-indigo-500/25",
  organic: "bg-teal-500/15 text-teal-300 border-teal-500/25",
  direct: "bg-white/10 text-white/60 border-white/15",
  other: "bg-white/10 text-white/50 border-white/15",
};

export default function LinksPage() {
  const { toast } = useToast();

  // ── Builder form state ──────────────────────────────────────────────
  // Which business this code is for. Required — a QR with no business is a URL
  // nobody can attribute, and the destination cannot be derived without it.
  const [orgId, setOrgId] = useState<string>("");
  const [programId, setProgramId] = useState<string>("");
  const [destination, setDestination] = useState("");
  const [channel, setChannel] = useState("");
  const [campaign, setCampaign] = useState("");
  const [medium, setMedium] = useState("");
  const [content, setContent] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [brand, setBrand] = useState("");
  const [note, setNote] = useState("");
  const [qrDefault, setQrDefault] = useState(false);

  // ── WhatsApp click-to-chat helper ───────────────────────────────────
  const [waPhone, setWaPhone] = useState("");
  const [waMsg, setWaMsg] = useState("");
  const waDigits = waPhone.replace(/[^\d]/g, "");
  const waUrl = waDigits
    ? `https://wa.me/${waDigits}${waMsg.trim() ? `?text=${encodeURIComponent(waMsg.trim())}` : ""}`
    : "";

  // ── List state ──────────────────────────────────────────────────────
  const [showArchived, setShowArchived] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [qr, setQr] = useState<{ url: string; name: string } | null>(null);
  const qrWrapRef = useRef<HTMLDivElement>(null);

  // The businesses this person belongs to, each with its live programmes.
  const { data: options } = useQuery<{ businesses: QrBusiness[] }>({
    queryKey: ["/api/admin/qr/options"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/qr/options")).json(),
  });
  const businesses = options?.businesses ?? [];
  const business = businesses.find((b) => String(b.orgId) === orgId) ?? null;
  const programmes = business?.programmes ?? [];

  // Every link across every business the viewer belongs to — NOT just the
  // workspace they happen to be standing in, which is what makes this one tab.
  const { data: links, isLoading } = useQuery<ShortLinkWithClicks[]>({
    queryKey: ["/api/admin/qr/links", showArchived ? "all" : "active"],
    queryFn: async () =>
      (await apiRequest("GET", `/api/admin/qr/links${showArchived ? "?archived=1" : ""}`)).json(),
  });

  // Picking a business (and optionally a programme) fills the destination in.
  // It stays editable: the suggestion is a convenience, never a constraint.
  function chooseBusiness(next: string) {
    setOrgId(next);
    setProgramId("");
    const b = businesses.find((x) => String(x.orgId) === next);
    if (b) {
      const url = suggestedDestination(b.orgId, null);
      if (url) setDestination(url);
      if (!brand) setBrand(b.slug);
    }
  }
  function chooseProgramme(next: string) {
    setProgramId(next);
    if (!business) return;
    const prog = business.programmes.find((p) => String(p.id) === next) ?? null;
    const url = suggestedDestination(business.orgId, prog);
    if (url) setDestination(url);
    if (prog && !campaign) setCampaign(prog.slug);
  }

  const createMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>): Promise<ShortLink> =>
      (await apiRequest("POST", "/api/admin/links", body)).json(),
    onSuccess: (link) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/qr/links"] });
      toast({ title: "Link created", description: linkUrlFor(link.key) });
      // Reset the builder so the next link starts clean.
      setDestination("");
      setChannel("");
      setCampaign("");
      setMedium("");
      setContent("");
      setCustomKey("");
      setBrand("");
      setNote("");
      setQrDefault(false);
      setProgramId("");
    },
    onError: (e: any) =>
      toast({ title: "Couldn't create link", description: e.message, variant: "destructive" }),
  });

  const setActiveMutation = useMutation({
    mutationFn: async ({ id, active }: { id: number; active: boolean }): Promise<ShortLink> =>
      (await apiRequest("PATCH", `/api/admin/links/${id}`, { active })).json(),
    onSuccess: (_l, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/qr/links"] });
      toast({ title: vars.active ? "Link restored" : "Link archived" });
    },
    onError: (e: any) =>
      toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      toast({ title: "Copy failed", description: text, variant: "destructive" });
    }
  }

  function submitBuilder() {
    const dest = destination.trim();
    if (!isAllowedDestination(dest)) {
      toast({
        title: "Destination not allowed",
        description: "Use a full https:// URL on one of our own domains (no open redirects).",
        variant: "destructive",
      });
      return;
    }
    if (!channel || !(CANONICAL_CHANNELS as readonly string[]).includes(channel)) {
      toast({ title: "Pick a channel", description: "Choose where this link will be shared.", variant: "destructive" });
      return;
    }
    const key = customKey.trim();
    if (key && !isValidLinkKey(key)) {
      toast({
        title: "Invalid custom key",
        description: "2–64 letters/numbers/-/_ and not a reserved word.",
        variant: "destructive",
      });
      return;
    }
    if (!orgId) {
      toast({ title: "Pick a business", description: "Every code is reported under a business.", variant: "destructive" });
      return;
    }
    createMutation.mutate({
      organizationId: Number(orgId),
      programId: programId ? Number(programId) : undefined,
      destination: dest,
      channel,
      campaign: campaign.trim() || undefined,
      medium: medium.trim() || undefined,
      content: content.trim() || undefined,
      key: key || undefined,
      brand: brand.trim() || undefined,
      note: note.trim() || undefined,
      qrDefault,
    });
  }

  function downloadPng() {
    const canvas = qrWrapRef.current?.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${qr?.name || "qr"}.png`;
    a.click();
  }

  function downloadSvg() {
    const svg = qrWrapRef.current?.querySelector("svg");
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n', xml], {
      type: "image/svg+xml;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${qr?.name || "qr"}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const inputClass = "premium-input text-white/80 rounded-xl";
  const rows = links || [];

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-white tracking-tight" data-testid="text-page-title">
            QR Code Generator
          </h1>
          <p className="text-sm text-white/40 mt-1">
            Make a QR code or a tracked link for any of our businesses, download the poster, and
            see every scan and click. Works for a whole business or one programme.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Builder */}
        <Card className="premium-card border-white/[0.06] lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-white/90 text-base flex items-center gap-2">
              <Link2 className="w-4 h-4 text-blue-400" />
              New tracked link
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Business first, then programme. Both drive the destination, so
                they sit above it rather than beside it. shadcn Select rather
                than a bare <select> — the standing rule is that every control
                is drawn by us, not by whichever browser the person is on. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-white/40 font-medium mb-1 block">Business</label>
                <Select value={orgId} onValueChange={chooseBusiness}>
                  <SelectTrigger className={inputClass} data-testid="select-qr-business">
                    <SelectValue placeholder="Which business is this for?" />
                  </SelectTrigger>
                  <SelectContent>
                    {businesses.map((b) => (
                      <SelectItem key={b.orgId} value={String(b.orgId)}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-white/30 mt-1">
                  {business ? business.joinHost : "Sets where the code points and who it is reported under."}
                </p>
              </div>
              <div>
                <label className="text-xs text-white/40 font-medium mb-1 block">
                  Programme <span className="text-white/25">(optional)</span>
                </label>
                <Select value={programId} onValueChange={chooseProgramme} disabled={!business}>
                  <SelectTrigger className={inputClass} data-testid="select-qr-programme">
                    <SelectValue placeholder={business ? "Whole business — or pick one" : "Pick a business first"} />
                  </SelectTrigger>
                  <SelectContent>
                    {programmes.map((pr) => (
                      <SelectItem key={pr.id} value={String(pr.id)}>
                        {pr.name}{pr.registrationOpen ? "" : "  · not open"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-white/30 mt-1">
                  {business && programmes.length === 0
                    ? "No live programmes — the code will point at the business."
                    : "Fills the destination with that programme's real page."}
                </p>
              </div>
            </div>

            <div>
              <label className="text-xs text-white/40 font-medium mb-1 block">Destination URL</label>
              <Input
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="https://join.minifootball.co.nz/..."
                className={inputClass}
                data-testid="input-link-destination"
              />
              <p className="text-[11px] text-white/30 mt-1">
                Filled in from the business and programme above. Editable — must be one of our own domains.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-white/40 font-medium mb-1 block">Channel</label>
                <select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  className={`${inputClass} w-full h-10 px-3 bg-white/[0.03] appearance-none`}
                  data-testid="select-link-channel"
                >
                  <option value="" disabled>
                    Select channel…
                  </option>
                  {CANONICAL_CHANNELS.map((c) => (
                    <option key={c} value={c} className="bg-[#0a0e1a]">
                      {titleCase(c)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-white/40 font-medium mb-1 block">Campaign</label>
                <Input
                  value={campaign}
                  onChange={(e) => setCampaign(e.target.value)}
                  placeholder="term-3-2026"
                  className={inputClass}
                  data-testid="input-link-campaign"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-white/40 font-medium mb-1 block">Medium (optional)</label>
                <Input
                  value={medium}
                  onChange={(e) => setMedium(e.target.value)}
                  placeholder="paid_social, poster…"
                  className={inputClass}
                  data-testid="input-link-medium"
                />
              </div>
              <div>
                <label className="text-xs text-white/40 font-medium mb-1 block">Content (optional)</label>
                <Input
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="variant-a"
                  className={inputClass}
                  data-testid="input-link-content"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-white/40 font-medium mb-1 block">Custom key (optional)</label>
                <Input
                  value={customKey}
                  onChange={(e) => setCustomKey(e.target.value)}
                  placeholder="mfl-t3 (auto if blank)"
                  className={inputClass}
                  data-testid="input-link-key"
                />
              </div>
              <div>
                <label className="text-xs text-white/40 font-medium mb-1 block">Brand / note (optional)</label>
                <Input
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  placeholder="MFL"
                  className={inputClass}
                  data-testid="input-link-brand"
                />
              </div>
            </div>

            <div>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Internal note (optional)"
                className={inputClass}
                data-testid="input-link-note"
              />
            </div>

            <div className="flex items-center justify-between gap-3 pt-1">
              <label className="flex items-center gap-2 text-xs text-white/50 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={qrDefault}
                  onChange={(e) => setQrDefault(e.target.checked)}
                  className="accent-blue-500 w-4 h-4"
                  data-testid="checkbox-link-qr-default"
                />
                Primarily for a QR poster
              </label>
              <Button
                onClick={submitBuilder}
                disabled={createMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700 text-white rounded-xl gap-2"
                data-testid="button-create-link"
              >
                <Plus className="w-4 h-4" />
                {createMutation.isPending ? "Creating…" : "Create link"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* WhatsApp helper */}
        <Card className="premium-card border-white/[0.06]">
          <CardHeader className="pb-3">
            <CardTitle className="text-white/90 text-base flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-green-400" />
              WhatsApp link
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label className="text-xs text-white/40 font-medium mb-1 block">Phone (international)</label>
              <Input
                value={waPhone}
                onChange={(e) => setWaPhone(e.target.value)}
                placeholder="+64 21 123 4567"
                className={inputClass}
                data-testid="input-wa-phone"
              />
            </div>
            <div>
              <label className="text-xs text-white/40 font-medium mb-1 block">Pre-filled message</label>
              <textarea
                value={waMsg}
                onChange={(e) => setWaMsg(e.target.value)}
                placeholder="Hi! I'd like to join MFL Term 3 (ref: T3POSTER)"
                rows={3}
                className={`${inputClass} w-full px-3 py-2 bg-white/[0.03] resize-none text-sm`}
                data-testid="input-wa-message"
              />
              <p className="text-[11px] text-white/30 mt-1">
                Add a code to the message to trace replies — outbound WhatsApp clicks can't be cookied.
              </p>
            </div>
            {waUrl && (
              <p className="text-[11px] text-green-300/70 break-all" data-testid="text-wa-url">
                {waUrl}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                onClick={() => copy(waUrl, "wa")}
                disabled={!waUrl}
                variant="outline"
                className="flex-1 border-white/10 text-white/70 rounded-xl gap-2"
                data-testid="button-wa-copy"
              >
                {copiedId === "wa" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                Copy
              </Button>
              <Button
                onClick={() => waUrl && setQr({ url: waUrl, name: `whatsapp-${waDigits}` })}
                disabled={!waUrl}
                variant="outline"
                className="flex-1 border-white/10 text-white/70 rounded-xl gap-2"
                data-testid="button-wa-qr"
              >
                <QrCode className="w-4 h-4" />
                QR
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* List */}
      <Card className="premium-card border-white/[0.06]">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-white/90 text-base">
              Links{" "}
              <span className="text-white/30 text-sm font-normal">({rows.length})</span>
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowArchived((v) => !v)}
              className="border-white/10 text-white/60 rounded-xl gap-2"
              data-testid="button-toggle-archived"
            >
              <Archive className="w-3.5 h-3.5" />
              {showArchived ? "Showing archived" : "Show archived"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-16 w-full rounded-xl bg-white/[0.03]" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center text-white/40 text-sm" data-testid="text-links-empty">
              No links yet. Build your first tracked link above.
            </div>
          ) : (
            <div className="divide-y divide-white/[0.04]">
              {rows.map((l) => {
                const url = linkUrlFor(l.key);
                return (
                  <div
                    key={l.id}
                    className="flex flex-col sm:flex-row sm:items-center gap-3 p-4"
                    data-testid={`row-link-${l.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-white/90 truncate" data-testid={`text-link-key-${l.id}`}>
                          /l/{l.key}
                        </span>
                        {l.channel && (
                          <Badge
                            variant="outline"
                            className={`text-[10px] ${CHANNEL_BADGE[l.channel] || CHANNEL_BADGE.other}`}
                          >
                            {titleCase(l.channel)}
                          </Badge>
                        )}
                        {l.campaign && (
                          <span className="text-[11px] text-white/30">{l.campaign}</span>
                        )}
                        {!l.active && (
                          <Badge variant="outline" className="text-[10px] text-white/40 border-white/10">
                            Archived
                          </Badge>
                        )}
                      </div>
                      <a
                        href={l.destination}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-blue-300/50 hover:text-blue-300 truncate flex items-center gap-1 mt-0.5 max-w-full"
                      >
                        <ExternalLink className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{l.destination}</span>
                      </a>
                      {/* Which business (and programme) this code belongs to.
                          The list spans every business the viewer belongs to,
                          so without this a row is unattributable. Links made
                          before 2026-09-03 carry no programme and say so by
                          simply not rendering one — never a guessed name. */}
                      {(l.organizationName || l.programName) && (
                        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                          {l.organizationName && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-white/15 text-white/50">
                              {l.organizationName}
                            </Badge>
                          )}
                          {l.programName && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-blue-400/25 text-blue-300/70">
                              {l.programName}
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-4 text-center flex-shrink-0">
                      <div>
                        <p className="text-sm font-semibold text-white" data-testid={`text-link-clicks-${l.id}`}>
                          {l.clicks}
                        </p>
                        <p className="text-[9px] uppercase tracking-wider text-white/30">Clicks</p>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-white/90" data-testid={`text-link-leads-${l.id}`}>
                          {l.leads}
                        </p>
                        <p className="text-[9px] uppercase tracking-wider text-white/30">Leads</p>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-emerald-400" data-testid={`text-link-sales-${l.id}`}>
                          {l.sales}
                        </p>
                        <p className="text-[9px] uppercase tracking-wider text-white/30">Sales</p>
                      </div>
                      <div className="hidden sm:block">
                        <p className="text-sm font-semibold text-white/70">{formatCents(l.saleAmountCents)}</p>
                        <p className="text-[9px] uppercase tracking-wider text-white/30">Revenue</p>
                      </div>
                      <div className="hidden md:block">
                        <p className="text-sm font-semibold text-blue-300/80">{l.last7dClicks}</p>
                        <p className="text-[9px] uppercase tracking-wider text-white/30">7-day</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => copy(url, `link-${l.id}`)}
                        className="h-8 w-8 text-white/40 hover:text-white/80 rounded-lg"
                        title="Copy link"
                        data-testid={`button-copy-${l.id}`}
                      >
                        {copiedId === `link-${l.id}` ? (
                          <Check className="w-4 h-4 text-emerald-400" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setQr({ url, name: l.key })}
                        className="h-8 w-8 text-white/40 hover:text-white/80 rounded-lg"
                        title="QR code"
                        data-testid={`button-qr-${l.id}`}
                      >
                        <QrCode className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setActiveMutation.mutate({ id: l.id, active: !l.active })}
                        disabled={setActiveMutation.isPending}
                        className="h-8 w-8 text-white/40 hover:text-white/80 rounded-lg"
                        title={l.active ? "Archive" : "Restore"}
                        data-testid={`button-archive-${l.id}`}
                      >
                        {l.active ? <Archive className="w-4 h-4" /> : <ArchiveRestore className="w-4 h-4" />}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* QR modal — client-side render, PNG (canvas) + SVG download, no external service */}
      {qr && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={() => setQr(null)}
          data-testid="modal-qr"
        >
          <div
            ref={qrWrapRef}
            className="relative rounded-2xl border border-blue-500/15 bg-[#0a0e1a] p-6 w-full max-w-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setQr(null)}
              className="absolute top-3 right-3 w-7 h-7 rounded-lg bg-white/[0.03] border border-white/[0.06] flex items-center justify-center text-white/40 hover:text-white/80"
              data-testid="button-qr-close"
            >
              <X className="w-4 h-4" />
            </button>
            <p className="text-sm text-white/70 mb-3 truncate pr-8">{qr.name}</p>
            <div className="bg-white rounded-xl p-4 flex items-center justify-center">
              <QRCodeSVG value={qrValueFor(qr.url)} size={208} level="M" bgColor="#ffffff" fgColor="#000000" />
            </div>
            {/* Hidden hi-res canvas used only for the PNG export. */}
            <div style={{ position: "absolute", left: -9999, top: -9999 }} aria-hidden>
              <QRCodeCanvas value={qrValueFor(qr.url)} size={512} level="M" bgColor="#ffffff" fgColor="#000000" />
            </div>
            <p className="text-[11px] text-white/40 mt-3 break-all">{qrValueFor(qr.url)}</p>
            <div className="flex gap-2 mt-4">
              <Button
                onClick={downloadPng}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white rounded-xl"
                data-testid="button-qr-download-png"
              >
                PNG
              </Button>
              <Button
                onClick={downloadSvg}
                variant="outline"
                className="flex-1 border-white/10 text-white/70 rounded-xl"
                data-testid="button-qr-download-svg"
              >
                SVG
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
