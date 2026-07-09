// The single call site every confirm function uses (T5). Wraps the whole
// resolve-then-post pipeline (load this org's rules -> shared/accounting.ts's
// resolve() -> server/accounting/post.ts's emitPosting()) behind one
// NEVER-THROWS function, per PLAN.md T5: "a posting failure must never break
// a parent's payment." Log and continue — the nightly reconciliation job
// (T7) is what catches the resulting gap, not a retry here.
//
// Short-circuits before touching the database at all while
// ACCOUNTING_SUBLEDGER isn't "1" — same dry-run guarantee post.ts's
// emitPosting makes on its own, extended to the rule-load this wrapper adds.
//
// `rulesDb`/`postingDb` are dependency-injected (mirrors post.ts's
// AccountingDb pattern) so this module never imports "../db" at load time —
// tested with fakes in script/test-accounting-hook.ts, no DATABASE_URL needed.

import { acctMappingRules } from "@shared/schema";
import { eq } from "drizzle-orm";
import { resolve, type AcctMappingRule, type ResolveInput } from "@shared/accounting";
import { emitPosting, isAccountingSubledgerEnabled, type AcctSourceType, type AccountingDb } from "./post";
import type { db as realDb } from "../db";

export type RulesDb = Pick<typeof realDb, "select">;

export interface PostAccountingEntryInput {
  organizationId: number;
  sourceType: AcctSourceType;
  sourceId: number;
  /** Must be stable across webhook replays — e.g. the Stripe PaymentIntent id. */
  idempotencyKey: string;
  /** The transaction's NZ business date ("YYYY-MM-DD"). Derive via nzTodayIso()
   *  (shared/academy.ts) — never new Date().toISOString(). */
  occurredAt: string;
  /** The ClubOS program this transaction is for. Sources with no real program
   *  (print orders, venue bookings, memberships) pass a sentinel that can
   *  never equal a real program id (0) and rely on the programType tier or
   *  an org-default rule instead — see AGENTS.md T5 note. */
  programId: number;
  optionId: number | null;
  /** `programs.type` for a program-backed sale, or a source-level pseudo-type
   *  ("print" | "venue_booking" | "membership") for the other three sources.
   *  Not a Xero code — purely a mapping-rule lookup key. */
  programType?: string | null;
  paymentMethod: string;
  grossCents: number;
  /** T6 (Stripe balance-transaction fee capture) fills these in; until then
   *  fee defaults to 0 and net defaults to gross. */
  feeCents?: number;
  netCents?: number;
  taxCents?: number | null;
  currency?: string;
}

async function loadRules(orgId: number, database: RulesDb): Promise<AcctMappingRule[]> {
  const rows = await database
    .select()
    .from(acctMappingRules)
    .where(eq(acctMappingRules.organizationId, orgId));
  return rows;
}

export interface PostAccountingEntryDeps {
  rulesDb?: RulesDb;
  postingDb?: AccountingDb;
}

/**
 * Resolve this transaction's coding and write the posting. Never throws —
 * an unmapped programme (resolve() throwing AcctMappingError) or any other
 * failure is logged and swallowed so the caller's payment confirmation is
 * never affected.
 */
export async function postAccountingEntry(
  input: PostAccountingEntryInput,
  deps?: PostAccountingEntryDeps,
): Promise<void> {
  if (!isAccountingSubledgerEnabled()) return;
  try {
    const rulesDb = deps?.rulesDb ?? (await import("../db")).db;
    const rules = await loadRules(input.organizationId, rulesDb);
    const resolveInput: ResolveInput = {
      orgId: input.organizationId,
      programId: input.programId,
      optionId: input.optionId,
      programType: input.programType ?? null,
      paymentMethod: input.paymentMethod,
      occurredAt: input.occurredAt,
    };
    const coding = resolve(resolveInput, rules);
    const feeCents = input.feeCents ?? 0;
    const netCents = input.netCents ?? input.grossCents - feeCents;
    await emitPosting(
      {
        organizationId: input.organizationId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.occurredAt,
        coding,
        grossCents: input.grossCents,
        feeCents,
        netCents,
        taxCents: input.taxCents ?? null,
        currency: input.currency,
      },
      deps?.postingDb,
    );
  } catch (e: any) {
    console.error(
      `[accounting] posting failed for ${input.sourceType} ${input.sourceId} (org ${input.organizationId}): ${e?.message ?? e}`,
    );
  }
}

export type { AcctSourceType };
