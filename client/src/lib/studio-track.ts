// USG Studio — "Signal" tracking beacon (client capture half).
//
// Dependency-free engagement tracker for public proposal pages. Batches events
// and ships them with navigator.sendBeacon to
//   POST /api/public/studio/:token/track
// (that endpoint is built in the SERVER increment — until then beacons are
// fire-and-forget and simply no-op). NO PII is collected client-side; geo/IP is
// derived server-side. Respects Do-Not-Track and marks internal/staff views so
// the server can flag them as isInternal and keep them out of real analytics.

export interface StudioTrackOptions {
  token: string;
  sourceTag: string;
  /** force-mark as an internal view (e.g. author preview) */
  internal?: boolean;
}

interface StudioEvent {
  t: string;
  ts: number;
  blockId?: string;
  dwellMs?: number;
  scrollPct?: number;
  scrollVelocity?: number;
  meta?: Record<string, unknown>;
}

const VID_KEY = "usg_studio_vid"; // persistent visitor id (localStorage, ~2yr)
const SID_KEY = "usg_studio_sid"; // per-session id (sessionStorage)
const FLUSH_MS = 5000;
const HEARTBEAT_MS = 10000;
const SCROLL_THROTTLE_MS = 500;
const BATCH_MAX = 12;

function uuid(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function isDnt(): boolean {
  try {
    const w = window as unknown as { doNotTrack?: string };
    const n = navigator as unknown as { doNotTrack?: string; msDoNotTrack?: string };
    return n.doNotTrack === "1" || w.doNotTrack === "1" || n.msDoNotTrack === "1";
  } catch {
    return false;
  }
}

/**
 * Start the Signal tracker. Returns a cleanup function that detaches everything
 * and sends a final flush. Safe to call once per public page mount.
 */
export function startStudioTracking(opts: StudioTrackOptions): () => void {
  if (typeof window === "undefined") return () => {};

  const dnt = isDnt();
  const endpoint = `/api/public/studio/${encodeURIComponent(opts.token)}/track`;

  // ── identity ──────────────────────────────────────────────────────────
  // DNT: still count the visit, but do NOT persist a stable visitor id.
  let visitorId: string;
  if (dnt) {
    visitorId = "anon-" + uuid();
  } else {
    let vid: string | null = null;
    try {
      vid = localStorage.getItem(VID_KEY);
      if (!vid) {
        vid = uuid();
        localStorage.setItem(VID_KEY, vid);
      }
    } catch {
      vid = "anon-" + uuid();
    }
    visitorId = vid;
  }

  let sessionId: string;
  try {
    let sid = sessionStorage.getItem(SID_KEY);
    if (!sid) {
      sid = uuid();
      sessionStorage.setItem(SID_KEY, sid);
    }
    sessionId = sid;
  } catch {
    sessionId = "sess-" + uuid();
  }

  // internal view: explicit flag, ?preview=1, or a logged-in staff signal.
  let internal = !!opts.internal;
  try {
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("preview") === "1" || qs.has("preview")) internal = true;
    if (localStorage.getItem("clubos_workspace")) internal = true;
  } catch {
    /* ignore */
  }

  // ── queue + flush ─────────────────────────────────────────────────────
  let queue: StudioEvent[] = [];
  let stopped = false;

  function enqueue(t: string, extra?: Partial<StudioEvent>) {
    if (stopped) return;
    queue.push({ t, ts: Date.now(), ...extra });
    if (queue.length >= BATCH_MAX) flush();
  }

  function flush() {
    if (queue.length === 0) return;
    const payload = {
      token: opts.token,
      visitorId,
      sessionId,
      sourceTag: opts.sourceTag,
      internal,
      dnt,
      sentAt: Date.now(),
      events: queue,
    };
    queue = [];
    const body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        const ok = navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
        if (ok) return;
      }
    } catch {
      /* fall through to fetch */
    }
    try {
      void fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
        credentials: "same-origin",
      }).catch(() => {});
    } catch {
      /* give up silently */
    }
  }

  // ── pageview ──────────────────────────────────────────────────────────
  enqueue("pageview", {
    meta: {
      path: window.location.pathname,
      referrer: document.referrer || null,
      title: document.title,
      screenW: window.screen?.width ?? null,
      screenH: window.screen?.height ?? null,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      lang: navigator.language || null,
      tz: (() => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
        } catch {
          return null;
        }
      })(),
    },
  });

  // ── per-section dwell (visibility-aware) ──────────────────────────────
  const dwell = new Map<string, { activeSince: number | null; accum: number }>();
  let sectionObserver: IntersectionObserver | null = null;

  if (typeof IntersectionObserver !== "undefined") {
    sectionObserver = new IntersectionObserver(
      (entries) => {
        const now = Date.now();
        const visible = document.visibilityState === "visible";
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.blockId;
          if (!id) continue;
          if (e.isIntersecting) {
            if (!dwell.has(id)) {
              dwell.set(id, { activeSince: visible ? now : null, accum: 0 });
              enqueue("section_enter", { blockId: id });
            }
          } else {
            const s = dwell.get(id);
            if (s) {
              if (s.activeSince != null) s.accum += now - s.activeSince;
              enqueue("section_exit", { blockId: id, dwellMs: Math.round(s.accum) });
              dwell.delete(id);
            }
          }
        }
      },
      { threshold: 0.5 },
    );
    document.querySelectorAll<HTMLElement>("[data-block-id]").forEach((el) => sectionObserver!.observe(el));
  }

  // ── scroll (throttled) + reached_end ──────────────────────────────────
  let lastScrollY = window.scrollY;
  let lastScrollTs = Date.now();
  let scrollTimer: number | null = null;
  let reachedEnd = false;

  function onScroll() {
    if (scrollTimer != null) return;
    scrollTimer = window.setTimeout(() => {
      scrollTimer = null;
      const now = Date.now();
      const y = window.scrollY;
      const docH = document.documentElement.scrollHeight - window.innerHeight;
      const pct = docH > 0 ? Math.min(1, Math.max(0, y / docH)) : 0;
      const dt = (now - lastScrollTs) / 1000;
      const velocity = dt > 0 ? Math.round(Math.abs(y - lastScrollY) / dt) : 0;
      lastScrollY = y;
      lastScrollTs = now;
      enqueue("scroll", { scrollPct: Math.round(pct * 1000) / 1000, scrollVelocity: velocity });
      if (!reachedEnd && pct >= 0.98) {
        reachedEnd = true;
        enqueue("reached_end", { scrollPct: 1 });
      }
    }, SCROLL_THROTTLE_MS);
  }
  window.addEventListener("scroll", onScroll, { passive: true });

  // ── heartbeat (engaged time, visible only) ────────────────────────────
  const heartbeat = window.setInterval(() => {
    if (document.visibilityState === "visible") enqueue("heartbeat", { meta: { engagedMs: HEARTBEAT_MS } });
  }, HEARTBEAT_MS);

  // ── visibility ────────────────────────────────────────────────────────
  function onVisibility() {
    const now = Date.now();
    if (document.visibilityState === "hidden") {
      // pause + bank dwell for any on-screen sections
      dwell.forEach((s) => {
        if (s.activeSince != null) {
          s.accum += now - s.activeSince;
          s.activeSince = null;
        }
      });
      enqueue("hidden");
      flush();
    } else {
      dwell.forEach((s) => {
        s.activeSince = now;
      });
      enqueue("visible");
    }
  }
  document.addEventListener("visibilitychange", onVisibility);

  // ── click / cta_click delegation ──────────────────────────────────────
  function onClick(ev: MouseEvent) {
    const target = ev.target as HTMLElement | null;
    const el = target?.closest?.("a, button, [data-studio-cta]") as HTMLElement | null;
    if (!el) return;
    const href = el instanceof HTMLAnchorElement ? el.href : el.getAttribute("href");
    const label = (el.textContent || "").trim().slice(0, 80);
    const isCta =
      el.hasAttribute("data-studio-cta") ||
      (!!href && (href.includes("usg-meet.vercel.app") || /[?&]source=/.test(href)));
    const meta: Record<string, unknown> = {
      tag: el.tagName.toLowerCase(),
      href: href || null,
      label: label || null,
    };
    if (isCta) {
      meta.ctaKind = el.getAttribute("data-cta-kind") || null;
      enqueue("cta_click", { meta });
      flush(); // navigation may follow — get it out now
    } else {
      enqueue("click", { meta });
    }
  }
  document.addEventListener("click", onClick, true);

  // ── periodic + unload flush ───────────────────────────────────────────
  const flushTimer = window.setInterval(flush, FLUSH_MS);
  function onPageHide() {
    flush();
  }
  window.addEventListener("pagehide", onPageHide);

  // ── cleanup ───────────────────────────────────────────────────────────
  return () => {
    if (stopped) return;
    stopped = true;
    window.removeEventListener("scroll", onScroll);
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("click", onClick, true);
    window.removeEventListener("pagehide", onPageHide);
    window.clearInterval(heartbeat);
    window.clearInterval(flushTimer);
    if (scrollTimer != null) window.clearTimeout(scrollTimer);
    sectionObserver?.disconnect();
    // bank any open dwell then final flush
    const now = Date.now();
    dwell.forEach((s, id) => {
      if (s.activeSince != null) s.accum += now - s.activeSince;
      queue.push({ t: "section_exit", ts: now, blockId: id, dwellMs: Math.round(s.accum) });
    });
    dwell.clear();
    stopped = false; // allow the final flush to send
    flush();
    stopped = true;
  };
}
