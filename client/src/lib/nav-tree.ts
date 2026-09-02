/**
 * The sidebar's section tree.
 *
 * A nav row may carry `children`, which makes it a SECTION: the row still
 * navigates to its own page, and clicking it also reveals the rows underneath —
 * the Shopify admin pattern, which keeps a long nav short without putting any
 * destination behind a hamburger.
 *
 * 🔴 NESTING IS PRESENTATION ONLY. This file exists so that rule is a function
 * with a test rather than a paragraph in a review. Moving a row under a parent
 * must never change who can open it:
 *
 *   - a child is judged on its OWN tab slug, exactly as when it sat at the top
 *   - a child whose PARENT the person cannot reach is PROMOTED back to the top
 *     level, never dropped
 *   - a parent whose children are all invisible renders as an ordinary link
 *
 * The middle rule is the one worth the file. `canAccessTab` already fails open
 * for admin/manager roles, so the quiet failure here is the opposite shape: a
 * person who legitimately holds `squads` but not `academy` silently losing the
 * only link to it because someone tidied the menu.
 */
export type NavItem = {
  tab: string;
  title: string;
  url: string;
  icon: any;
  children?: NavItem[];
};

export function buildNav(
  items: NavItem[],
  canSee: (item: NavItem) => boolean,
): NavItem[] {
  return items.flatMap((item) => {
    const kids = (item.children ?? []).filter(canSee);
    if (canSee(item)) return [{ ...item, children: kids }];
    return kids.map((k) => ({ ...k, children: [] as NavItem[] }));
  });
}

/** Every destination a person can reach, flattened — what a test compares. */
export function reachable(items: NavItem[]): string[] {
  return items.flatMap((i) => [i.tab, ...(i.children ?? []).map((c) => c.tab)]).sort();
}
