// Helpers shared between the MFL register page (which creates a split) and the
// Split Pay hub page (which runs the join + card-save + lock flow).

// ── In-memory handoff for the SetupIntent client secret ──────────────────────
// When a split is created (register) or someone joins, the server hands back a
// `setupClientSecret`. We stash it here so the hub can mount the card form
// instantly without an extra round-trip. It's consumed once; if it's lost (e.g.
// the user refreshes), the hub falls back to POST /setup-intent for a fresh one.
const secretStore = new Map<string, string>();

export function stashSetupSecret(code: string, secret: string) {
  secretStore.set(code, secret);
}

export function consumeSetupSecret(code: string): string | undefined {
  const s = secretStore.get(code);
  if (s) secretStore.delete(code);
  return s;
}

// ── Tokens (localStorage) ────────────────────────────────────────────────────
// The organiser gets BOTH tokens from the register response; a joiner gets a
// memberToken from /join. Keyed by split code so multiple splits can coexist.
export interface SplitTokens {
  organiserToken?: string;
  memberToken?: string;
}

const tokenKey = (code: string) => `mfl_split_${code}`;

export function loadSplitTokens(code: string): SplitTokens {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(tokenKey(code)) || "{}");
  } catch {
    return {};
  }
}

export function saveSplitTokens(code: string, t: SplitTokens) {
  if (typeof window === "undefined") return;
  const next = { ...loadSplitTokens(code), ...t };
  localStorage.setItem(tokenKey(code), JSON.stringify(next));
}
