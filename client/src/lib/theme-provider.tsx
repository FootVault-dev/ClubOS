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
//
// The public booking flow (book.* subdomain or /book route) is hardcoded
// dark-themed and the shared light-mode polyfill in index.css would flip its
// white text invisible. Same for the CIC Skills Challenge landing page
// (join.cicyouth.com / /skills) — hardcoded near-black, so a light-mode
// phone rendered its white text navy-on-black. These stay dark for everyone,
// regardless of ADMIN_DARK_MODE — they are customer-facing pages with their
// own designed look, not the staff console.
function isPublicDarkSurface(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  const path = window.location.pathname;
  return (
    host.startsWith("book.") ||
    path === "/book" ||
    path.startsWith("/book/") ||
    host.includes("cicyouth") ||
    path === "/skills" ||
    path.startsWith("/skills/")
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
