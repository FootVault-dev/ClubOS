import { createContext, useContext, useEffect, useState, ReactNode } from "react";

// 🔴 ClubOS ADMIN IS LIGHT ONLY (Daniel, 2026-09-02).
//
// Dark mode was a per-user toggle. Staff complained about the dark rendering
// constantly and nobody has ever complained about light, because a large part
// of this codebase was written dark-first with hardcoded colours
// (`bg-slate-950`, `text-white`, `border-white/10`) rather than tokens — so
// light mode was being patched at the CSS level and leaked black-on-black
// panels wherever the patch didn't reach. One theme, rendered properly, beats
// two themes where one is broken.
//
// Nothing here is deleted. The `.dark` token block still lives in index.css
// and this provider still knows how to resolve and apply a dark theme. To
// bring the toggle back: flip ADMIN_DARK_MODE to true, and re-add the toggle
// button to the profile menu (it was removed from the sidebar footer in the
// same change).
const ADMIN_DARK_MODE = false;

// Theme preference is stored as one of these. Retained for when the toggle
// comes back; while ADMIN_DARK_MODE is false the stored value is ignored.
export type ThemeMode = "light" | "dark" | "system";

type ThemeContextValue = {
  mode: ThemeMode;
  resolved: "light" | "dark"; // what's actually applied right now
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = "clubos-theme";

function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(STORAGE_KEY);
  if (v === "light" || v === "dark" || v === "system") return v;
  return "system";
}

// PUBLIC surfaces are not admin surfaces and are unaffected by the rule above.
// They are customer-facing pages with their own designed look, and they stay
// dark for everyone regardless of ADMIN_DARK_MODE.
//
// 🔴 EVERY dark-designed public page must be listed here.
//
// Admin used to be light-or-dark by preference, so these pages were dark for
// a dark-mode user and already wrong for a light-mode one. Making admin light
// by default would have made them wrong for EVERYONE: the light mapping flips
// their `text-white/70` to dark ink while their own hardcoded `#02060E`
// background stays black, which is the unreadable-panel bug in a full page.
//
// Found by auditing inline `style={{ background: '#…' }}` — a class-based
// mapping cannot reach an inline style, so grepping for classes would have
// missed all of them. `scripts/audit-dark-surfaces.mjs` is that audit, kept.
function isPublicDarkSurface(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  const path = window.location.pathname;

  const startsWithAny = (...prefixes: string[]) =>
    prefixes.some((p) => path === p || path.startsWith(`${p}/`));

  return (
    // Venue booking flow — book.* subdomain, /book and /book/success.
    host.startsWith("book.") ||
    startsWithAny("/book") ||
    // CIC Youth: the whole brand is near-black, plus the Skills Challenge.
    host.includes("cicyouth") ||
    startsWithAny("/skills") ||
    // Referee portals — gold on black, both leagues, and the clean-URL
    // aliases the ref.* hosts redirect through.
    startsWithAny("/mfl-ref", "/ref") ||
    path === "/signup" ||
    path === "/login" ||
    path.startsWith("/game/") ||
    // e-Sign: the signing page and the payables declaration.
    startsWithAny("/sign", "/declaration") ||
    // The members' booking page and the membership purchase page.
    path === "/members" ||
    path === "/membership" ||
    // MFL's public league landing pages — gold on near-black.
    startsWithAny("/league") ||
    // The NZF academy registration page — navy and gold throughout.
    startsWithAny("/academy")
  );
}

function resolveMode(mode: ThemeMode): "light" | "dark" {
  // Public dark surfaces win over everything — see above.
  if (isPublicDarkSurface()) return "dark";

  // Everything else — the whole staff console, every public checkout — is
  // light. The old per-route light-surface allowlist is gone with it: light
  // is now the default rather than something a route had to opt into, which
  // is what let a parent hit a black date-of-birth field on a white page.
  if (!ADMIN_DARK_MODE) return "light";

  if (mode === "system") {
    if (typeof window === "undefined") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode());
  const [resolved, setResolved] = useState<"light" | "dark">(() => resolveMode(readStoredMode()));

  useEffect(() => {
    const r = resolveMode(mode);
    setResolved(r);
    const root = document.documentElement;
    if (r === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    root.setAttribute("data-theme", r);
    root.style.colorScheme = r;
  }, [mode]);

  // Re-resolve when the OS preference changes — only relevant when the toggle
  // is back AND mode = system. Inert while ADMIN_DARK_MODE is false.
  useEffect(() => {
    if (!ADMIN_DARK_MODE || mode !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(resolveMode(mode));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  const setMode = (m: ThemeMode) => {
    window.localStorage.setItem(STORAGE_KEY, m);
    setModeState(m);
  };

  const toggle = () => {
    setMode(resolved === "dark" ? "light" : "dark");
  };

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}

/**
 * For a dark-designed public page whose URL cannot identify it.
 *
 * `/{slug}` serves BOTH the light CUFC camp page and the black SIU one — same
 * route, two designs — so `isPublicDarkSurface()` above cannot classify it,
 * and a page that paints its own full-page black while the light mapping
 * flips its white text to dark ink is unreadable.
 *
 * Rendering this inside such a page declares the requirement where the design
 * that needs it lives, instead of in a central URL list that goes stale the
 * next time somebody adds a route.
 *
 *   export default function SiuCampPage() {
 *     return (<><ForceDarkSurface />…</>);
 *   }
 *
 * ⚠️ There IS a brief light frame before this mounts. Prefer a URL rule when
 * the URL is unambiguous; use this only when it genuinely is not.
 */
export function ForceDarkSurface() {
  useEffect(() => {
    const root = document.documentElement;
    const had = root.classList.contains("dark");
    root.classList.add("dark");
    root.setAttribute("data-theme", "dark");
    root.style.colorScheme = "dark";
    return () => {
      if (!had) {
        root.classList.remove("dark");
        root.setAttribute("data-theme", "light");
        root.style.colorScheme = "light";
      }
    };
  }, []);
  return null;
}
