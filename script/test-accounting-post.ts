// Pure-logic tests for server/accounting/post.ts (the posting emitter).
// Run: npx tsx script/test-accounting-post.ts   (exits non-zero on failure)
//
// No real DB: the fake below enforces the SAME unique-idempotency-key
// constraint the real migration declares (acct_postings.idempotency_key
// UNIQUE), so "calling emitPosting twice writes exactly one row" is proven
// against our own onConflictDoNothing-then-returning logic, not against
// Postgres itself (this worktree has no DATABASE_URL and cannot reach one).
import assert from "node:assert/strict";
import { emitPosting, isAccountingSubledgerEnabled, type AccountingDb, type EmitPostingInput } from "../server/accounting/post";
import type { ResolvedCoding } from "../shared/accounting";

let passed = 0;
async function ok(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
  } catch (e: any) {
    console.error(`FAIL: ${name}\n  ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

const CODING: ResolvedCoding = {
  code: "01",
  xeroAccountCode: "4000",
  tracking1: "MFL",
  tracking2: null,
  taxType: "OUTPUT2",
  ruleVersion: 3,
};

function input(overrides: Partial<EmitPostingInput> = {}): EmitPostingInput {
  return {
    organizationId: 1,
    sourceType: "registration",
    sourceId: 42,
    idempotencyKey: "pi_test_123",
    occurredAt: "2026-07-10",
    coding: CODING,
    grossCents: 40500,
    feeCents: 1215,
    netCents: 39285,
    ...overrides,
  };
}

/** Mimics db.insert(acctPostings).values(row).onConflictDoNothing({target}).returning() —
 *  a Map keyed by idempotencyKey plays the role of the DB's unique index. */
function fakeDb(): { db: AccountingDb; store: Map<string, any>; insertCalls: number } {
  const store = new Map<string, any>();
  let nextId = 1;
  let insertCalls = 0;
  const db = {
    insert(_table: any) {
      return {
        values(row: any) {
          return {
            onConflictDoNothing(_opts: any) {
              return {
                async returning() {
                  insertCalls++;
                  if (store.has(row.idempotencyKey)) return [];
                  const posting = { id: nextId++, postedAt: new Date(), reversedById: null, ...row };
                  store.set(row.idempotencyKey, posting);
                  return [posting];
                },
              };
            },
          };
        },
      };
    },
  } as unknown as AccountingDb;
  return { db, store, insertCalls };
}

const ORIGINAL_FLAG = process.env.ACCOUNTING_SUBLEDGER;

await ok("flag off by default -> isAccountingSubledgerEnabled() is false", () => {
  delete process.env.ACCOUNTING_SUBLEDGER;
  assert.equal(isAccountingSubledgerEnabled(), false);
});

await ok("flag off -> emitPosting is a dry-run no-op, never touches the db", async () => {
  delete process.env.ACCOUNTING_SUBLEDGER;
  const f = fakeDb();
  const result = await emitPosting(input(), f.db);
  assert.equal(result.dryRun, true);
  assert.equal(result.inserted, false);
  assert.equal(result.posting, null);
  assert.equal(f.store.size, 0, "the fake db must never be inserted into while the flag is off");
});

await ok("flag on -> calling emitPosting twice with the same key writes exactly one row", async () => {
  process.env.ACCOUNTING_SUBLEDGER = "1";
  const f = fakeDb();
  const first = await emitPosting(input(), f.db);
  const second = await emitPosting(input(), f.db);
  assert.equal(first.inserted, true, "first call should insert");
  assert.equal(second.inserted, false, "replayed call should be a no-op, not an error");
  assert.equal(f.store.size, 1, "exactly one row must exist after two calls with the same idempotency key");
  assert.equal(second.dryRun, false);
});

await ok("a different idempotency key writes a second, independent row", async () => {
  process.env.ACCOUNTING_SUBLEDGER = "1";
  const f = fakeDb();
  await emitPosting(input({ idempotencyKey: "pi_a" }), f.db);
  await emitPosting(input({ idempotencyKey: "pi_b" }), f.db);
  assert.equal(f.store.size, 2);
});

await ok("the resolved coding and money carry through onto the row untouched", async () => {
  process.env.ACCOUNTING_SUBLEDGER = "1";
  const f = fakeDb();
  const result = await emitPosting(input(), f.db);
  assert.equal(result.posting?.code, "01");
  assert.equal(result.posting?.xeroAccountCode, "4000");
  assert.equal(result.posting?.tracking1, "MFL");
  assert.equal(result.posting?.tracking2, null);
  assert.equal(result.posting?.taxType, "OUTPUT2");
  assert.equal(result.posting?.mappingRuleVersion, 3);
  assert.equal(result.posting?.grossCents, 40500);
  assert.equal(result.posting?.feeCents, 1215);
  assert.equal(result.posting?.netCents, 39285);
  assert.equal(result.posting?.currency, "NZD");
  assert.equal(result.posting?.taxCents, null);
});

await ok("a non-integer cents value throws rather than posting a fractional cent", async () => {
  process.env.ACCOUNTING_SUBLEDGER = "1";
  const f = fakeDb();
  await assert.rejects(() => emitPosting(input({ grossCents: 405.5 as any }), f.db));
});

await ok("no real db module is ever touched while the flag is off (no ../db import side effect)", async () => {
  delete process.env.ACCOUNTING_SUBLEDGER;
  // no db argument passed at all — if the flag-off short-circuit didn't work,
  // this would try to `import("../db")`, which throws without DATABASE_URL.
  const result = await emitPosting(input());
  assert.equal(result.dryRun, true);
});

if (ORIGINAL_FLAG === undefined) delete process.env.ACCOUNTING_SUBLEDGER;
else process.env.ACCOUNTING_SUBLEDGER = ORIGINAL_FLAG;

console.log(`${passed} passed`);
if (process.exitCode) {
  console.error("FAILED");
} else {
  console.log("OK");
}
