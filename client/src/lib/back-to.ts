import { useSearch } from "wouter";

/**
 * "Where did I come from" — carried in the URL as `?from=<path>`.
 *
 * Some records live in one section but are reached from another: a player's
 * contact card sits under /admin/contacts, but you usually open it from a
 * programme's Players tab. Without this, Back dumped you in the full Contacts
 * list and the sidebar silently jumped to Contacts — you lost your place.
 *
 * Putting the origin in the URL (rather than component state) means it
 * survives a refresh and a shared link, and the sidebar can read it too.
 *
 * Only internal admin paths are honoured, so a hand-edited `from` can't be
 * used to bounce someone off-site.
 */
export function isSafeInternalPath(path: string | null | undefined): path is string {
  if (!path) return false;
  // Must be one of ours, and never protocol-relative ("//evil.com").
  return path.startsWith("/admin") && !path.startsWith("//");
}

/** Append the origin to a link. `to` and `from` are both app paths. */
export function withFrom(to: string, from: string | null | undefined): string {
  if (!isSafeInternalPath(from)) return to;
  const sep = to.includes("?") ? "&" : "?";
  return `${to}${sep}from=${encodeURIComponent(from)}`;
}

/** Read `?from=` out of the current URL, or null when absent/unsafe. */
export function fromParam(search: string): string | null {
  const raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("from");
  return isSafeInternalPath(raw) ? raw : null;
}

/**
 * Where Back should go: the page that sent us here, else the section default.
 * `label` is for the button's tooltip so the destination isn't a surprise.
 */
export function useBackTo(fallback: string, fallbackLabel = "Back"): { href: string; label: string } {
  const from = fromParam(useSearch());
  if (!from) return { href: fallback, label: fallbackLabel };
  return { href: from, label: "Back" };
}
