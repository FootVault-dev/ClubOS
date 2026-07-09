// The posting emitter (T4) — the only place acct_postings rows get written.
// Pure mechanics: given an already-resolved coding (shared/accounting.ts's
// resolve()) and a transaction's money, writes one append-only row. Never
// calls Xero — Phase 1 doesn't touch that API at all (see PLAN.md rule 1).
//
// DRY-RUN BY DEFAULT: gated on ACCOUNTING_SUBLEDGER=1 so a fresh deploy of
// this code changes nothing until a human flips the flag. With the flag off,
// emitPosting is a pure no-op — it returns immediately and never even opens
// the db module.
//
// Idempotency is a DB constraint (acct_postings.idempotency_key UNIQUE, see
// migrations/2026-07-10_accounting_subledger.sql), not application logic: a
// replayed Stripe webhook calling emitPosting twice with the same key must be
// mechanically incapable of writing a second row. onConflictDoNothing() +
// .returning() detects "the row already existed" without a racy
// SELECT-then-INSERT.
//
// `database` is dependency-injected (default: the real db, resolved lazily
// inside the function body) so this module never imports "../db" at the top
// level — the same lazy-import trick T13/T14 use elsewhere in this repo to
// keep a module loadable (and testable) without DATABASE_URL. See
// script/test-accounting-post.ts, which injects a fake enforcing the same
// unique-idempotency-key constraint the real migration does.

import { acctPostings } from "@shared/schema";
import type { ResolvedCoding } from "@shared/accounting";
import type { db as realDb } from "../db";

export type AcctSourceType = "registration" | "print" | "booking" | "member" | "shop";

/** The slice of the real db this module touches. Deriving it from the real
 *  db's type (a type-only import, erased at runtime) keeps the production
 *  call path type-checked against drizzle's actual insert/onConflict API. */
export type AccountingDb = Pick<typeof realDb, "insert">;

export interface EmitPostingInput {
  organizationId: number;
  sourceType: AcctSourceType;
  sourceId: number;
  /** Must be stable across webhook replays — e.g. the Stripe PaymentIntent id. */
  idempotencyKey: string;
  /** The transaction's NZ business date ("YYYY-MM-DD"). Derive via nzTodayIso()
   *  (shared/academy.ts) or the payment's own dated field — never
   *  new Date().toISOString(). This module has no clock access; it trusts the
   *  caller. */
  occurredAt: string;
  /** Output of shared/accounting.ts's resolve() for this transaction. */
  coding: ResolvedCoding;
  grossCents: number;
  feeCents: number;
  netCents: number;
  taxCents?: number | null;
  currency?: string;
}

export interface EmitPostingResult {
  /** true = this call wrote the row. false = the flag is off (dryRun) or the
   *  idempotency key already existed — a replayed webhook is correctly a no-op. */
  inserted: boolean;
  posting: typeof acctPostings.$inferSelect | null;
  dryRun: boolean;
}

export function isAccountingSubledgerEnabled(): boolean {
  return process.env.ACCOUNTING_SUBLEDGER === "1";
}

function assertIntegerCents(name: string, value: number | null | undefined): void {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value)) {
    throw new Error(`accounting/post: ${name} must be integer cents, got ${value}`);
  }
}

function buildPostingRow(input: EmitPostingInput): typeof acctPostings.$inferInsert {
  assertIntegerCents("grossCents", input.grossCents);
  assertIntegerCents("feeCents", input.feeCents);
  assertIntegerCents("netCents", input.netCents);
  assertIntegerCents("taxCents", input.taxCents);
  return {
    organizationId: input.organizationId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
    code: input.coding.code,
    xeroAccountCode: input.coding.xeroAccountCode,
    tracking1: input.coding.tracking1,
    tracking2: input.coding.tracking2,
    taxType: input.coding.taxType,
    grossCents: input.grossCents,
    feeCents: input.feeCents,
    netCents: input.netCents,
    taxCents: input.taxCents ?? null,
    currency: input.currency ?? "NZD",
    mappingRuleVersion: input.coding.ruleVersion,
  };
}

/**
 * Write one acct_postings row. Never calls Xero. Behind ACCOUNTING_SUBLEDGER=1
 * — with the flag off this is a pure no-op (dryRun: true) and never touches
 * the database module, so a fresh deploy of this code changes nothing.
 *
 * Idempotent: calling this twice with the same idempotencyKey writes exactly
 * one row (see script/test-accounting-post.ts).
 */
export async function emitPosting(
  input: EmitPostingInput,
  database?: AccountingDb,
): Promise<EmitPostingResult> {
  if (!isAccountingSubledgerEnabled()) {
    return { inserted: false, posting: null, dryRun: true };
  }
  const row = buildPostingRow(input);
  const db: AccountingDb = database ?? (await import("../db")).db;
  const [posting] = await db
    .insert(acctPostings)
    .values(row)
    .onConflictDoNothing({ target: acctPostings.idempotencyKey })
    .returning();
  return { inserted: !!posting, posting: posting ?? null, dryRun: false };
}
