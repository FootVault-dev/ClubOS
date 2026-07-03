import { useState } from "react";
import { CheckCircle2, Mail, QrCode, Users, MoreHorizontal } from "lucide-react";
import { SiFacebook, SiInstagram, SiGoogle, SiWhatsapp } from "react-icons/si";
import { HDYHAU_OPTIONS } from "@shared/attribution";
import type { IconType } from "react-icons";

/**
 * Reusable "How did you hear about us?" (HDYHAU) capture card — T17.
 *
 * One-tap, skippable, fires ONCE per conversion. Mounts on success screens
 * (MFL, camp, waitlist, venue). Tapping an option immediately writes the answer
 * to the right conversion row via `POST /api/public/hdyhau` (best-effort — the
 * answer is never required and a failure is swallowed). Answered/skipped state
 * is remembered in localStorage so a refresh never re-asks.
 *
 * The option vocabulary lives in `shared/attribution.ts` (`HDYHAU_OPTIONS`) and
 * is classifier-aligned (see `script/test-attribution-hdyhau.ts`).
 */

type HdyhauType = "registration" | "waitlist" | "booking_request";

interface HdyhauCardProps {
  /** Which conversion table the answer belongs to. */
  type: HdyhauType;
  /** The conversion row id. If missing, the card renders nothing. */
  id: number | null | undefined;
  /** Visual theme — dark (MFL/venue) or light (camp). Defaults to dark. */
  variant?: "dark" | "light";
  /** Brand accent colour (hex) for the selected/hover state + confirmation tick. */
  accent?: string;
  /** Pass true when the row already has a self-report so we never re-ask. */
  answered?: boolean;
  className?: string;
}

// Per-option icon + brand tint, keyed by the shared option id.
const ICONS: Record<string, { Icon: IconType; tint?: string }> = {
  friend_teammate: { Icon: Users },
  facebook: { Icon: SiFacebook, tint: "#1877F2" },
  instagram: { Icon: SiInstagram, tint: "#E4405F" },
  google: { Icon: SiGoogle, tint: "#4285F4" },
  email: { Icon: Mail },
  whatsapp: { Icon: SiWhatsapp, tint: "#25D366" },
  poster_qr: { Icon: QrCode },
  other: { Icon: MoreHorizontal },
};

function storageKey(type: HdyhauType, id: number) {
  return `usg_hdyhau_${type}_${id}`;
}

function readDismissed(type: HdyhauType, id: number): boolean {
  try {
    return !!window.localStorage.getItem(storageKey(type, id));
  } catch {
    return false;
  }
}

function markDismissed(type: HdyhauType, id: number, state: "answered" | "skipped") {
  try {
    window.localStorage.setItem(storageKey(type, id), state);
  } catch {
    /* private mode — the card just won't remember, which is fine */
  }
}

export default function HdyhauCard({ type, id, variant = "dark", accent = "#d1b96e", answered, className }: HdyhauCardProps) {
  const validId = typeof id === "number" && Number.isFinite(id) && id > 0 ? id : null;
  // Compute the initial hidden state once (lazy init) so we never re-ask.
  const [done, setDone] = useState<null | "answered" | "skipped">(() => {
    if (!validId) return "skipped";
    if (answered) return "answered";
    return readDismissed(type, validId) ? "answered" : null;
  });

  if (!validId) return null;
  if (done === "skipped" && !answered) {
    // Skipped this session → collapse entirely (no residual UI).
    return null;
  }

  const isLight = variant === "light";
  const theme = isLight
    ? {
        panelBg: "#ffffff",
        panelBorder: "#e2e8f0",
        title: "#0f172a",
        sub: "#64748b",
        optBg: "#f8fafc",
        optBorder: "#e2e8f0",
        optText: "#334155",
        skip: "#94a3b8",
      }
    : {
        panelBg: "rgba(255,255,255,0.02)",
        panelBorder: "rgba(255,255,255,0.10)",
        title: "#ffffff",
        sub: "rgba(255,255,255,0.60)",
        optBg: "rgba(255,255,255,0.04)",
        optBorder: "rgba(255,255,255,0.10)",
        optText: "rgba(255,255,255,0.90)",
        skip: "rgba(255,255,255,0.45)",
      };

  const submit = (value: string) => {
    setDone("answered");
    markDismissed(type, validId, "answered");
    // Fire-and-forget — the answer is optional; never block or surface errors.
    fetch("/api/public/hdyhau", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, id: validId, value }),
    }).catch(() => {});
  };

  const skip = () => {
    setDone("skipped");
    markDismissed(type, validId, "skipped");
  };

  if (done === "answered") {
    return (
      <div
        className={`rounded-2xl p-5 text-center ${className || ""}`}
        style={{ background: theme.panelBg, border: `1px solid ${theme.panelBorder}` }}
        data-testid="hdyhau-thanks"
      >
        <div className="w-10 h-10 rounded-full mx-auto mb-2 flex items-center justify-center" style={{ background: `${accent}22` }}>
          <CheckCircle2 className="w-5 h-5" style={{ color: accent }} />
        </div>
        <p className="text-sm font-semibold" style={{ color: theme.title }}>Thanks — that helps us reach more families 🙌</p>
      </div>
    );
  }

  return (
    <div
      className={`rounded-2xl p-5 sm:p-6 text-left ${className || ""}`}
      style={{ background: theme.panelBg, border: `1px solid ${theme.panelBorder}` }}
      data-testid="hdyhau-card"
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-[15px] sm:text-base font-bold tracking-tight" style={{ color: theme.title }} data-testid="text-hdyhau-title">
            How did you hear about us?
          </h3>
          <p className="text-[12px] mt-0.5" style={{ color: theme.sub }}>One tap — it helps us reach more families like yours.</p>
        </div>
        <button
          type="button"
          onClick={skip}
          className="text-[12px] font-medium shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
          style={{ color: theme.skip }}
          data-testid="button-hdyhau-skip"
        >
          Skip
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2.5" data-testid="hdyhau-options">
        {HDYHAU_OPTIONS.map((opt) => {
          const meta = ICONS[opt.id] || { Icon: MoreHorizontal };
          const Icon = meta.Icon;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => submit(opt.id)}
              className="flex items-center gap-2.5 px-3.5 py-3 rounded-xl border text-left transition-all duration-150 cursor-pointer hover:-translate-y-px"
              style={{ background: theme.optBg, borderColor: theme.optBorder }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = accent; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = theme.optBorder; }}
              data-testid={`hdyhau-option-${opt.id}`}
            >
              <Icon className="w-4 h-4 shrink-0" style={{ color: meta.tint || accent }} />
              <span className="text-[13px] font-semibold leading-tight" style={{ color: theme.optText }}>{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
