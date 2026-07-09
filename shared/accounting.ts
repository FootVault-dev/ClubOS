// The mapping engine — pure, no DB, no network. Given the org's effective-dated mapping
// rules and a transaction's context, resolves the accounting coding it should post under.
// Called by server/accounting/post.ts (T4) with rules already loaded from acct_mapping_rules.
//
// Resolution order, most specific first: option -> programme -> programme type -> org default.
// A tie within a tier (payment-method-specific vs wildcard) prefers the specific rule; a
// remaining tie is ambiguous data and throws rather than picking arbitrarily.
//
// Rules are effective-dated and resolution always uses the transaction's occurredAt, never
// "now" — a rule Victor adds in January must never re-code December's revenue. There is no
// fallback account: an unmapped programme throws. A guessed account code is exactly the bug
// this repo already shipped once (server/xero.ts's old `accountCode: "200"`).
//
// `program_type` is not in 02-architecture.md's original acct_mapping_rules column sketch —
// it's added here because the "programme type" specificity tier this task requires cannot be
// resolved without it. T3's migration mirrors this addition (see AGENTS.md).
//
// No DB, no network. Tested by script/test-accounting.ts (npx tsx script/test-accounting.ts).

export type AcctTaxType = string;

export interface AcctMappingRule {
  id: number;
  organizationId: number;
  /** null = this rule matches at the programme-type or org-default tier, not a specific programme. */
  programId: number | null;
  /** null = this rule matches above the option tier. */
  programOptionId: number | null;
  /** `programs.type` enum value ("academy" | "holiday_camp" | ...). null = programme/option/org tier. */
  programType: string | null;
  /** null = matches any payment method. */
  paymentMethod: string | null;
  /** ISO date "YYYY-MM-DD". Inclusive start. */
  effectiveFrom: string;
  /** ISO date "YYYY-MM-DD", exclusive end, or null = still open. */
  effectiveTo: string | null;
  code: string;
  xeroAccountCode: string | null;
  tracking1: string | null;
  tracking2: string | null;
  taxType: AcctTaxType | null;
  version: number;
}

export interface ResolveInput {
  orgId: number;
  programId: number;
  optionId: number | null;
  /** Needed to resolve the programme-type tier; pass the sold programme's `programs.type`. */
  programType?: string | null;
  paymentMethod: string;
  /** ISO date "YYYY-MM-DD" the transaction occurred on — never "now". Derive via nzTodayIso()
   *  (or the payment's own dated field) upstream; this function never reads the clock. */
  occurredAt: string;
}

export interface ResolvedCoding {
  code: string;
  xeroAccountCode: string | null;
  tracking1: string | null;
  tracking2: string | null;
  taxType: AcctTaxType | null;
  ruleVersion: number;
}

export class AcctMappingError extends Error {}

function isEffective(rule: AcctMappingRule, occurredAt: string): boolean {
  if (rule.effectiveFrom > occurredAt) return false;
  if (rule.effectiveTo !== null && rule.effectiveTo <= occurredAt) return false;
  return true;
}

function paymentMethodMatches(rule: AcctMappingRule, paymentMethod: string): boolean {
  return rule.paymentMethod === null || rule.paymentMethod === paymentMethod;
}

type TierMatcher = (rule: AcctMappingRule, input: ResolveInput) => boolean;

/** Most specific first. Each tier is mutually exclusive with the others by construction
 *  (exactly one of programOptionId/programId/programType is the deciding non-null field). */
const TIERS: TierMatcher[] = [
  // 1. option
  (r, i) => r.programOptionId !== null && r.programOptionId === i.optionId,
  // 2. programme
  (r, i) => r.programOptionId === null && r.programId !== null && r.programId === i.programId,
  // 3. programme type
  (r, i) =>
    r.programOptionId === null &&
    r.programId === null &&
    r.programType !== null &&
    i.programType != null &&
    r.programType === i.programType,
  // 4. org default
  (r) => r.programOptionId === null && r.programId === null && r.programType === null,
];

/** Picks the most specific payment-method match within an already-tied specificity tier.
 *  Throws on a genuine tie — two equally-specific rules is bad data, not a coin flip. */
function pickWithinTier(matches: AcctMappingRule[], input: ResolveInput): AcctMappingRule {
  const specific = matches.filter((r) => r.paymentMethod === input.paymentMethod);
  const pool = specific.length > 0 ? specific : matches;
  if (pool.length > 1) {
    throw new AcctMappingError(
      `Ambiguous accounting mapping for programme ${input.programId} (org ${input.orgId}, ` +
        `payment method ${input.paymentMethod}, ${input.occurredAt}): ${pool.length} rules tie ` +
        `(ids ${pool.map((r) => r.id).join(", ")}). Fix the overlapping rules — resolve() will ` +
        `not guess which one wins.`,
    );
  }
  return pool[0];
}

export function resolve(input: ResolveInput, rules: AcctMappingRule[]): ResolvedCoding {
  const candidates = rules.filter(
    (r) =>
      r.organizationId === input.orgId &&
      isEffective(r, input.occurredAt) &&
      paymentMethodMatches(r, input.paymentMethod),
  );

  for (const matchesTier of TIERS) {
    const matches = candidates.filter((r) => matchesTier(r, input));
    if (matches.length === 0) continue;
    const rule = pickWithinTier(matches, input);
    return {
      code: rule.code,
      xeroAccountCode: rule.xeroAccountCode,
      tracking1: rule.tracking1,
      tracking2: rule.tracking2,
      taxType: rule.taxType,
      ruleVersion: rule.version,
    };
  }

  throw new AcctMappingError(
    `No accounting mapping rule for programme ${input.programId} (org ${input.orgId}) as of ` +
      `${input.occurredAt}. Nothing is posted without an explicit rule — see ` +
      `script/seed-accounting.ts to add one.`,
  );
}
