import { useRoute } from "wouter";

/**
 * Where a programme's admin pages live.
 *
 * One detail page (`admin-camp-detail`) serves every programme type, but the
 * URL it sits under is what decides which sidebar item lights up — the sidebar
 * matches on path, it has no idea what kind of record is on screen. Opening an
 * academy programme at `/admin/camps/123` therefore highlighted **Camps** while
 * the user was in Academy, which is simply wrong: academy programmes are not
 * camps.
 *
 * The fix is that the section owns the URL. Build every programme link with
 * `programDetailPath()` — never hand-write `/admin/camps/${id}` — and read the
 * id back with `useProgramRoute()`, which matches all three prefixes. Old
 * `/admin/camps/:id` links still resolve, so nothing bookmarked breaks.
 */
export const PROGRAM_BASE_PATHS = ["/admin/academy", "/admin/programs", "/admin/camps"] as const;
export type ProgramBasePath = (typeof PROGRAM_BASE_PATHS)[number];

/** The list page a programme belongs to, given its type and the workspace. */
export function programBasePath(
  program: { type?: string | null } | null | undefined,
  orgSlug?: string | null,
): ProgramBasePath {
  // Gymnastics has a single Programs list for everything it runs.
  if (orgSlug === "united-gymnastics") return "/admin/programs";
  if (program?.type === "academy") return "/admin/academy";
  return "/admin/camps";
}

/** Detail page for a programme, under the section that owns it. */
export function programDetailPath(
  program: { id: number; type?: string | null },
  orgSlug?: string | null,
): string {
  return `${programBasePath(program, orgSlug)}/${program.id}`;
}

/**
 * Match the current location against every programme prefix at once.
 *
 * `suffix` appends to the id segment, e.g. `/edit-page` or
 * `/session/:dateId/:sessionType`. Returns the matched base so the page can
 * keep its own links inside the section the user came in through.
 */
export function useProgramRoute(suffix = ""): {
  base: ProgramBasePath;
  id: number;
  params: Record<string, string | undefined>;
} | null {
  // Hook count is fixed and ordered — one useRoute per known prefix.
  const academy = useRoute(`/admin/academy/:id${suffix}`);
  const programs = useRoute(`/admin/programs/:id${suffix}`);
  const camps = useRoute(`/admin/camps/:id${suffix}`);

  const matches: [ProgramBasePath, typeof academy][] = [
    ["/admin/academy", academy],
    ["/admin/programs", programs],
    ["/admin/camps", camps],
  ];

  for (const [base, [matched, params]] of matches) {
    if (matched && params?.id) {
      return { base, id: parseInt(params.id), params: params as Record<string, string | undefined> };
    }
  }
  return null;
}
