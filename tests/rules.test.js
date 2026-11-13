// rules.js is edited by hand, so these checks stand in for the old generator:
// every rule must point at a pair the taxonomy allows, and every pattern must
// be valid, ASCII-safe regex.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEngine } = require("../scripts/load-engine");

const $ = loadEngine();
const TAXONOMY = $("TAXONOMY");
const allows = (type, category, sub) => (TAXONOMY[type]?.[category] || []).includes(sub);

test("every built-in rule files into a pair the taxonomy allows", () => {
  for (const [type, rules] of [["Expense", $("PURPOSE_EXPENSE_RULES")], ["Income", $("PURPOSE_INCOME_RULES")]]) {
    for (const [patterns, category, sub] of rules) {
      assert.ok(allows(type, category, sub), `${type} rule ${patterns[0]} -> ${category} / ${sub}`);
    }
  }
});

test("every internal-transfer rule has a sub-category under Transfer", () => {
  for (const [patterns, sub] of $("INTERNAL_RULES")) {
    assert.ok(allows("Transfer", $("INTERNAL_CATEGORY"), sub), `${patterns[0]} -> ${sub}`);
  }
});

test("patterns compile and avoid the constructs that differ between regex engines", () => {
  const all = [...$("PURPOSE_EXPENSE_RULES"), ...$("PURPOSE_INCOME_RULES")].flatMap(r => r[0])
    .concat($("INTERNAL_RULES").flatMap(r => r[0]), $("GATEWAY_PATTERNS"), $("REFUND_PATTERNS"));
  for (const p of all) {
    assert.doesNotThrow(() => new RegExp(p), p);
    assert.ok(!/\\[bwp]/i.test(p), `avoid \\b, \\w, \\p in "${p}"`);
    assert.equal(p, p.normalize("NFD").replace(/[̀-ͯ]/g, ""), `write "${p}" without accents`);
  }
});

test("every legacy alias points at a pair the taxonomy allows", () => {
  for (const [key, [category, sub]] of Object.entries($("LEGACY_ALIASES"))) {
    assert.ok(allows(key.split("|")[0], category, sub), `${key} -> ${category} / ${sub}`);
  }
});
