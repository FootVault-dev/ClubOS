// ─────────────────────────────────────────────────────────────────────────────
// HIRING — job postings and the people who apply to them.
//
// A generic careers engine, not a one-off form. A `hiring_jobs` row is a posting
// (brand-scoped, with its own custom application questions); a
// `hiring_applications` row is one person's submission against it. Any brand
// site can render a careers page from /api/public/hiring/:brand/... and post
// back to it — the first is Christchurch United's Club Commentator advert on
// footballinstitute.co.nz.
//
// Deliberately separate from the Volunteers module. A volunteer signs up once as
// a person and is later rostered onto task-types by day; an applicant applies to
// one specific posting and is moved through a selection pipeline for it. Same
// English word, different shape — merging them would ruin both.
// ─────────────────────────────────────────────────────────────────────────────

// ── Which workspace sees which brand ─────────────────────────────────────────
//
// The Hiring tab appears in two kinds of workspace, and they mean different
// things.
//
// United Sports Group is the GROUP workspace: its tab is the whole club's
// hiring, every brand, and a member can be narrowed to a subset of brands
// (user_organizations.hiring_brands).
//
// Mini Football Leagues is a BRAND workspace: its tab is a view onto that same
// data narrowed to its own brand. Note what it deliberately does NOT do — filter
// by the owning org. Every posting today is owned by the group org, so a tab
// that filtered on the MFL org would render permanently empty. Brand is the
// namespace; the owning org is just who manages the row.

/** Workspace slug → the single brand its Hiring tab shows. */
export const HIRING_WORKSPACE_BRAND: Record<string, string> = {
  "mini-football-leagues": "mfl",
};

/** The workspace whose Hiring tab is the whole club's, across every brand. */
export const HIRING_GROUP_WORKSPACE = "united-sports-group";

/**
 * The brands a caller may see in a given workspace. `null` means every brand.
 *
 * Three rules, in order:
 *  1. A brand workspace never widens. Even a super admin sees only that brand
 *     there, because that is what the workspace MEANS — they switch to the
 *     group workspace to see everything. A member narrowed to brands that
 *     don't include it sees nothing.
 *  2. The group workspace shows everything, minus the member's own brand scope.
 *  3. Anything else — a workspace that somehow has the tab but is neither the
 *     group nor bound to a brand — sees NOTHING. Fail closed: the failure mode
 *     of guessing here is showing one brand's applicants to another's staff.
 */
export function hiringBrandFilter(
  workspaceSlug: string,
  memberBrands: string[] | null,
  isSuperAdmin: boolean,
): string[] | null {
  const workspaceBrand = HIRING_WORKSPACE_BRAND[workspaceSlug];
  if (workspaceBrand) {
    if (isSuperAdmin || memberBrands === null) return [workspaceBrand];
    return memberBrands.includes(workspaceBrand) ? [workspaceBrand] : [];
  }
  if (workspaceSlug === HIRING_GROUP_WORKSPACE) {
    return isSuperAdmin ? null : memberBrands;
  }
  return [];
}

/** Where an applicant is in the selection process. Ordered. */
export const APPLICATION_STATUSES = [
  "new",
  "reviewing",
  "shortlisted",
  "trial",
  "offered",
  "hired",
  "declined",
  "withdrawn",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Statuses that mean we are done with this applicant. */
export const CLOSED_APPLICATION_STATUSES = new Set<string>(["hired", "declined", "withdrawn"]);

export const JOB_STATUSES = ["draft", "open", "closed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const isApplicationStatus = (v: unknown): v is ApplicationStatus =>
  typeof v === "string" && (APPLICATION_STATUSES as readonly string[]).includes(v);

export const isJobStatus = (v: unknown): v is JobStatus =>
  typeof v === "string" && (JOB_STATUSES as readonly string[]).includes(v);

// ── Custom questions ─────────────────────────────────────────────────────────
// Each job defines its own extra questions. The applicant's replies land in
// `hiring_applications.answers` keyed by question id, so adding a question to a
// future job needs no migration and no code change.
//
// "file-or-url" is the audition primitive: paste a link, or upload a file. The
// upload is stored in object storage and only ever served back through a
// tab-gated admin endpoint.

export const QUESTION_TYPES = ["text", "textarea", "select", "url", "checkbox", "file-or-url"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export type HiringQuestion = {
  id: string;
  label: string;
  type: QuestionType;
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: string[];
  minLength?: number;
  maxLength?: number;
  /** file-or-url only */
  accept?: string;
  maxBytes?: number;
};

/** Hard ceilings applied server-side regardless of what a job's schema claims. */
export const HIRING_LIMITS = {
  maxQuestions: 40,
  maxAnswerChars: 5000,
  // 60 MB. A 60–90s phone clip at 1080p is ~10–30 MB; audio is a fraction of
  // that. Multer buffers the upload in RAM before it reaches object storage, so
  // this cap is a memory ceiling on the Fly machine, not just a politeness.
  maxAuditionBytes: 60 * 1024 * 1024,
  maxApplicationsPerIpPerHour: 5,
} as const;

/** Mime prefixes we accept for an audition upload. */
export const AUDITION_MIME_PREFIXES = ["audio/", "video/"];

/**
 * NZ law does not fix a minimum working age for this kind of casual engagement,
 * but the club's own rule is that anyone under this age needs a parent or
 * guardian to consent and to be contactable. Applied server-side, never trusted
 * from the browser.
 */
export const GUARDIAN_CONSENT_UNDER_AGE = 16;

/** Whole years old on `on`, from an ISO yyyy-mm-dd date of birth. Null if unparseable. */
export function ageOnDate(dobIso: string, on: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobIso.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Compare calendar parts directly — never via Date arithmetic, which shifts
  // across the NZ/UTC boundary and can age someone by a year.
  let age = on.getFullYear() - y;
  const beforeBirthday =
    on.getMonth() + 1 < mo || (on.getMonth() + 1 === mo && on.getDate() < d);
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 120 ? age : null;
}

export function needsGuardianConsent(dobIso: string, on: Date): boolean {
  const age = ageOnDate(dobIso, on);
  // Unparseable or missing DOB → require consent. Fail safe, not open.
  if (age === null) return true;
  return age < GUARDIAN_CONSENT_UNDER_AGE;
}

/** Validate a submitted answer bag against a job's question schema. Returns error strings. */
export function validateAnswers(
  questions: HiringQuestion[],
  answers: Record<string, unknown>,
  opts: { hasAuditionFile?: boolean } = {},
): string[] {
  const errors: string[] = [];
  for (const q of questions.slice(0, HIRING_LIMITS.maxQuestions)) {
    const raw = answers[q.id];

    if (q.type === "checkbox") {
      if (q.required && raw !== true) errors.push(`"${q.label}" must be ticked.`);
      continue;
    }

    if (q.type === "file-or-url") {
      const hasUrl = typeof raw === "string" && raw.trim() !== "";
      if (q.required && !hasUrl && !opts.hasAuditionFile) {
        errors.push(`"${q.label}" needs either a link or an uploaded file.`);
      }
      if (hasUrl && !/^https?:\/\/\S+$/i.test(String(raw).trim())) {
        errors.push(`"${q.label}" must be a link starting with http:// or https://`);
      }
      continue;
    }

    const value = typeof raw === "string" ? raw.trim() : "";
    if (q.required && value === "") {
      errors.push(`"${q.label}" is required.`);
      continue;
    }
    if (value === "") continue;

    if (value.length > Math.min(q.maxLength ?? HIRING_LIMITS.maxAnswerChars, HIRING_LIMITS.maxAnswerChars)) {
      errors.push(`"${q.label}" is too long.`);
    }
    if (q.minLength && value.length < q.minLength) {
      errors.push(`"${q.label}" needs a bit more — at least ${q.minLength} characters.`);
    }
    if (q.type === "url" && !/^https?:\/\/\S+$/i.test(value)) {
      errors.push(`"${q.label}" must be a link starting with http:// or https://`);
    }
    if (q.type === "select" && q.options?.length && !q.options.includes(value)) {
      errors.push(`"${q.label}" is not one of the options.`);
    }
  }
  return errors;
}

/** Coerce an arbitrary parsed body into a safe answers bag, bounded and stringified. */
export function sanitiseAnswers(
  questions: HiringQuestion[],
  raw: unknown,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  if (!raw || typeof raw !== "object") return out;
  const bag = raw as Record<string, unknown>;
  for (const q of questions.slice(0, HIRING_LIMITS.maxQuestions)) {
    const v = bag[q.id];
    if (v === undefined || v === null) continue;
    if (q.type === "checkbox") {
      out[q.id] = v === true || v === "true" || v === "on";
    } else if (typeof v === "string") {
      const t = v.trim();
      if (t !== "") out[q.id] = t.slice(0, HIRING_LIMITS.maxAnswerChars);
    }
  }
  return out;
}
