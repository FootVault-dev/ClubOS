// The workspace THIS TAB is showing.
//
// localStorage is shared by every tab on the origin, so a second tab switching
// to Mini Football silently rewrote the X-Workspace-Slug header that every
// request from a Christchurch United tab was sending: its sidebar still said
// CUFC while every list on it came back scoped to MFL — the Academy page showed
// four Ballers age groups and nothing of CUFC's (Daniel, 2026-09-09). The tab's
// own workspace wins; localStorage is only the starting point for a tab that has
// not resolved one yet, and the thing the NEXT tab opens with.
let active: string | null = null;
export function setActiveWorkspaceSlug(slug: string | null): void { active = slug; }
export function getActiveWorkspaceSlug(): string | null { return active; }
