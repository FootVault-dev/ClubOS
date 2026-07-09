// Pure-logic tests for shared/accounting-codes.ts.
// Run: npx tsx script/test-accounting-codes.ts   (exits non-zero on failure)
import assert from "node:assert/strict";
import {
  ACCT_CODE_TREE,
  MIRRORED_CODES,
  INCOME_ONLY_CODES,
  COST_CENTRES_NO_INCOME,
  SHARED_OVERHEAD_CODES,
  expenseCodeFor,
  validateCodeTree,
} from "../shared/accounting-codes";

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

// ── The single highest-value test: no naive `income + 30` ──────────────────
ok("13 Donations has no expense mirror", () => assert.equal(expenseCodeFor("13"), null));
ok("14 Reimbursement has no expense mirror", () => assert.equal(expenseCodeFor("14"), null));
ok("15 Other Income has no expense mirror", () => assert.equal(expenseCodeFor("15"), null));
ok("01 Academy mirrors to 31", () => assert.equal(expenseCodeFor("01"), "31"));
ok("12 Media Company mirrors to 42", () => assert.equal(expenseCodeFor("12"), "42"));
ok("unknown code mirrors to null, never a guess", () =>
  assert.equal(expenseCodeFor("99"), null),
);

ok("all 12 mirrored pairs are 01-12 -> 31-42", () => {
  assert.equal(MIRRORED_CODES.length, 12);
  for (const rule of MIRRORED_CODES) {
    const incomeNum = Number(rule.incomeCode);
    const expenseNum = Number(rule.expenseCode);
    assert.ok(incomeNum >= 1 && incomeNum <= 12, `${rule.incomeCode} out of 01-12`);
    assert.equal(expenseNum, incomeNum + 30, `${rule.incomeCode} -> ${rule.expenseCode}`);
  }
});

ok("43 and 44 have no income counterpart", () => {
  assert.ok(COST_CENTRES_NO_INCOME["43"], "43 missing from cost centres");
  assert.ok(COST_CENTRES_NO_INCOME["44"], "44 missing from cost centres");
  for (const rule of MIRRORED_CODES) {
    assert.notEqual(rule.expenseCode, "43");
    assert.notEqual(rule.expenseCode, "44");
  }
});

ok("13/14/15 are income-only, not mirrored", () => {
  for (const code of Object.keys(INCOME_ONLY_CODES)) {
    assert.ok(!MIRRORED_CODES.some((r) => r.incomeCode === code), `${code} should not mirror`);
  }
});

ok("21/22/23 are shared overheads, mirrored by nothing", () => {
  for (const code of ["21", "22", "23"]) {
    assert.ok(SHARED_OVERHEAD_CODES[code], `${code} missing from shared overheads`);
    assert.ok(!MIRRORED_CODES.some((r) => r.expenseCode === code), `${code} should not mirror`);
    assert.ok(!MIRRORED_CODES.some((r) => r.incomeCode === code), `${code} should not mirror`);
  }
});

// ── Tree integrity ──────────────────────────────────────────────────────────
ok("805 rows ported", () => assert.equal(ACCT_CODE_TREE.length, 805));

ok("every parent_code exists in the tree, or is null at level 1", () => {
  const errors = validateCodeTree();
  assert.deepEqual(errors, []);
});

ok("32 level-1 roots: income 01-15, expense 21-23 and 31-44", () => {
  const l1 = ACCT_CODE_TREE.filter((n) => n.level === 1);
  assert.equal(l1.length, 32);
  const income = l1.filter((n) => n.type === "income").map((n) => n.code).sort();
  const expense = l1.filter((n) => n.type === "expense").map((n) => n.code).sort();
  assert.deepEqual(
    income,
    ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15"],
  );
  assert.deepEqual(
    expense,
    ["21", "22", "23", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44"],
  );
});

ok("a broken tree is caught (regression guard on validateCodeTree itself)", () => {
  const broken = [...ACCT_CODE_TREE.slice(0, 5), { ...ACCT_CODE_TREE[5], parentCode: "not-a-real-code" }];
  const errors = validateCodeTree(broken as any);
  assert.ok(errors.length > 0);
});

console.log(`${passed} passed`);
if (process.exitCode) {
  console.error("FAILED");
} else {
  console.log("OK");
}
