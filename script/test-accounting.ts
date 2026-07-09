// Pure-logic tests for shared/accounting.ts (the mapping engine).
// Run: npx tsx script/test-accounting.ts   (exits non-zero on failure)
import assert from "node:assert/strict";
import { resolve, AcctMappingError, type AcctMappingRule } from "../shared/accounting";

let passed = 0;
function ok(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e: any) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

function rule(overrides: Partial<AcctMappingRule>): AcctMappingRule {
  return {
    id: 1,
    organizationId: 1,
    programId: null,
    programOptionId: null,
    programType: null,
    paymentMethod: null,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    code: "01",
    xeroAccountCode: null,
    tracking1: null,
    tracking2: null,
    taxType: null,
    version: 1,
    ...overrides,
  };
}

const BASE_INPUT = {
  orgId: 1,
  programId: 10,
  optionId: 100,
  paymentMethod: "stripe_card",
  occurredAt: "2026-06-01",
};

// ── Effective dating ─────────────────────────────────────────────────────────
ok("a 2027-effective rule does not code a 2026 posting", () => {
  const rules = [
    rule({ id: 1, programId: 10, code: "OLD", version: 1, effectiveFrom: "2026-01-01" }),
    rule({ id: 2, programId: 10, code: "NEW", version: 2, effectiveFrom: "2027-01-01" }),
  ];
  const result = resolve(BASE_INPUT, rules);
  assert.equal(result.code, "OLD");
  assert.equal(result.ruleVersion, 1);
});

ok("only a future-dated rule exists -> unmapped, throws", () => {
  const rules = [rule({ id: 1, programId: 10, code: "NEW", effectiveFrom: "2027-01-01" })];
  assert.throws(() => resolve(BASE_INPUT, rules), AcctMappingError);
});

ok("effectiveTo excludes the boundary date", () => {
  const rules = [
    rule({ id: 1, programId: 10, code: "OLD", effectiveFrom: "2026-01-01", effectiveTo: "2026-06-01" }),
  ];
  assert.throws(() => resolve(BASE_INPUT, rules), AcctMappingError, "2026-06-01 is not effective (exclusive end)");
  const dayBefore = resolve({ ...BASE_INPUT, occurredAt: "2026-05-31" }, rules);
  assert.equal(dayBefore.code, "OLD");
});

// ── Unmapped programme ───────────────────────────────────────────────────────
ok("an unmapped programme throws and names the programme", () => {
  try {
    resolve(BASE_INPUT, []);
    assert.fail("expected throw");
  } catch (e: any) {
    assert.ok(e instanceof AcctMappingError);
    assert.ok(e.message.includes("10"), `error should name programme 10: ${e.message}`);
  }
});

// ── Specificity tiers ────────────────────────────────────────────────────────
ok("option-level rule beats programme-level rule", () => {
  const rules = [
    rule({ id: 1, programId: 10, code: "PROGRAMME", version: 1 }),
    rule({ id: 2, programId: 10, programOptionId: 100, code: "OPTION", version: 2 }),
  ];
  const result = resolve(BASE_INPUT, rules);
  assert.equal(result.code, "OPTION");
  assert.equal(result.ruleVersion, 2);
});

ok("programme-level rule beats programme-type rule", () => {
  const rules = [
    rule({ id: 1, programType: "academy", code: "TYPE" }),
    rule({ id: 2, programId: 10, code: "PROGRAMME" }),
  ];
  const result = resolve({ ...BASE_INPUT, programType: "academy" }, rules);
  assert.equal(result.code, "PROGRAMME");
});

ok("programme-type rule beats org default", () => {
  const rules = [
    rule({ id: 1, code: "ORG_DEFAULT" }),
    rule({ id: 2, programType: "academy", code: "TYPE" }),
  ];
  const result = resolve({ ...BASE_INPUT, programType: "academy" }, rules);
  assert.equal(result.code, "TYPE");
});

ok("org default is used when nothing more specific matches", () => {
  const rules = [rule({ id: 1, code: "ORG_DEFAULT" })];
  const result = resolve(BASE_INPUT, rules);
  assert.equal(result.code, "ORG_DEFAULT");
});

ok("a programme-type rule for a different type does not match", () => {
  const rules = [rule({ id: 1, programType: "holiday_camp", code: "TYPE" })];
  assert.throws(() => resolve({ ...BASE_INPUT, programType: "academy" }, rules), AcctMappingError);
});

ok("a different org's rule never matches", () => {
  const rules = [rule({ id: 1, organizationId: 2, code: "OTHER_ORG" })];
  assert.throws(() => resolve(BASE_INPUT, rules), AcctMappingError);
});

// ── Payment method specificity ───────────────────────────────────────────────
ok("a payment-method-specific rule beats a wildcard rule in the same tier", () => {
  const rules = [
    rule({ id: 1, programId: 10, paymentMethod: null, code: "ANY_METHOD" }),
    rule({ id: 2, programId: 10, paymentMethod: "stripe_card", code: "CARD_ONLY" }),
  ];
  const result = resolve(BASE_INPUT, rules);
  assert.equal(result.code, "CARD_ONLY");
});

ok("a wildcard rule matches when no payment-method-specific rule exists", () => {
  const rules = [rule({ id: 1, programId: 10, paymentMethod: "bank_transfer", code: "BANK" })];
  assert.throws(() => resolve(BASE_INPUT, rules), AcctMappingError);
  const wildcard = [rule({ id: 1, programId: 10, paymentMethod: null, code: "ANY" })];
  assert.equal(resolve(BASE_INPUT, wildcard).code, "ANY");
});

// ── Ambiguity is a data error, never a guess ─────────────────────────────────
ok("two equally-specific rules tie -> throws rather than picking one", () => {
  const rules = [
    rule({ id: 1, programId: 10, code: "A" }),
    rule({ id: 2, programId: 10, code: "B" }),
  ];
  assert.throws(() => resolve(BASE_INPUT, rules), AcctMappingError);
});

// ── Full resolved shape ──────────────────────────────────────────────────────
ok("resolved coding carries xero fields and rule version through", () => {
  const rules = [
    rule({
      id: 1,
      programId: 10,
      code: "01",
      xeroAccountCode: "4000",
      tracking1: "MFL",
      tracking2: "T3",
      taxType: "OUTPUT2",
      version: 7,
    }),
  ];
  const result = resolve(BASE_INPUT, rules);
  assert.deepEqual(result, {
    code: "01",
    xeroAccountCode: "4000",
    tracking1: "MFL",
    tracking2: "T3",
    taxType: "OUTPUT2",
    ruleVersion: 7,
  });
});

console.log(`${passed} passed`);
if (process.exitCode) {
  console.error("FAILED");
} else {
  console.log("OK");
}
