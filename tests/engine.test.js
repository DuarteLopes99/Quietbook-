// Run with:  node --test
// Synthetic data only: nothing here reads data/ or a real bank export.
const test = require("node:test");
const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const { loadEngine } = require("../scripts/load-engine");

const $ = loadEngine();
const engine = {
  categorize: $("categorize"),
  parseAmount: $("parseAmount"),
  parseDateFlexible: $("parseDateFlexible"),
  makeTransactionId: $("makeTransactionId"),
  rawRowsToTransactions: $("rawRowsToTransactions"),
  reshapeAsTransfer: $("reshapeAsTransfer"),
  latestBankBalance: $("latestBankBalance"),
  reconcileWithBank: $("reconcileWithBank"),
  signedAmount: $("signedAmount"),
};
const setRules = rules => $(`overrides = ${JSON.stringify(rules)}`);

// A bank export as SheetJS hands it over: newest first, with the running balance.
function bankRow(date, description, amount, balance) {
  return { "Data Operação": date, "Descrição": description, "Montante( EUR )": amount,
           "Saldo Contabilístico( EUR )": balance };
}

test("amounts are read in either convention", () => {
  assert.equal(engine.parseAmount("1.234,56"), 1234.56);
  assert.equal(engine.parseAmount("1,234.56"), 1234.56);
  assert.equal(engine.parseAmount("3,50"), 3.5);
  assert.equal(engine.parseAmount("12,34-"), -12.34);
  assert.equal(engine.parseAmount(-8), -8);
  assert.equal(engine.parseAmount("abc"), null);
  assert.equal(engine.parseAmount(""), null);
});

test("dates are read day-first or ISO", () => {
  assert.equal(engine.parseDateFlexible("06-04-2026"), "2026-04-06");
  assert.equal(engine.parseDateFlexible("2026-04-06"), "2026-04-06");
  assert.equal(engine.parseDateFlexible("not a date"), null);
});

test("transaction id is sha1 of date|description|amount, unchanged for a first occurrence", () => {
  const key = "2026-04-06|hamburgueria teste|-8.00";
  const expected = nodeCrypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
  assert.equal(engine.makeTransactionId("2026-04-06", "Hamburgueria Teste", -8), expected);
  assert.equal(engine.makeTransactionId("2026-04-06", "Hamburgueria Teste", -8, 1), expected);
  assert.notEqual(engine.makeTransactionId("2026-04-06", "Hamburgueria Teste", -8, 2), expected);
});

test("built-in rules, rails and fallbacks", () => {
  setRules([]);
  assert.deepEqual([...engine.categorize("Continente Lisboa", -42.1)], ["Alimentação", "Compras", "Cartão"]);
  assert.deepEqual([...engine.categorize("Mbway - Cinemas NOS", -7)], ["Lazer", "Cinema/Espetáculos", "MBWay"]);
  assert.deepEqual([...engine.categorize("Trf. MB WAY para Amigo Exemplo", -10)],
                   ["Outros", "Transferências Pessoais", "MBWay"]);
  assert.deepEqual([...engine.categorize("Transferência de Amigo Exemplo", 10)],
                   ["Transferências Pessoais", "Transferência", "Transferência"]);
  assert.deepEqual([...engine.categorize("Loja Desconhecida XPTO", -5)], ["Outros", "Por Classificar", "Cartão"]);
});

test("your rule wins over the built-in rules, and matches a person's name on a transfer", () => {
  setRules([
    { keywords: ["continente"], type: "expense", category: "Geral", sub_category: "Casa", method: "Cartão" },
    { keywords: ["fisio exemplo"], type: "expense", category: "Saúde", sub_category: "Fisioterapia", method: "" },
  ]);
  assert.deepEqual([...engine.categorize("Continente Lisboa", -42.1)], ["Geral", "Casa", "Cartão"]);
  assert.deepEqual([...engine.categorize("Trf. MB WAY para Fisio Exemplo", -35)],
                   ["Saúde", "Fisioterapia", "MBWay"]);
  setRules([]);
});

test("repeated identical transactions in one file are all kept, and re-importing adds nothing", () => {
  setRules([]);
  const file = [
    bankRow("06-04-2026", "Hamburgueria Teste", -8, 79.05),
    bankRow("06-04-2026", "Hamburgueria Teste", -12.5, 87.5),
    bankRow("06-04-2026", "Hamburgueria Teste", -8, 100.00),
  ];
  const first = engine.rawRowsToTransactions(file, "april.xlsx").rows;
  const again = engine.rawRowsToTransactions(file, "april-again.xlsx").rows;
  assert.equal(first.length, 3);
  assert.equal(new Set(first.map(r => r.transaction_id)).size, 3);
  assert.deepEqual(again.map(r => r.transaction_id), first.map(r => r.transaction_id));
});

test("internal transfers get their own type, signed, and never count as income or expense", () => {
  const { rows } = engine.rawRowsToTransactions([
    bankRow("03-09-2026", "Transferência entre contas", 8500, 9000),
    bankRow("14-09-2026", "Reforco Crp", -5, 8995),
  ], "sept.xlsx");
  // JSON round-trip: arrays built inside the sandbox have another realm's prototype.
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map(r => [r.Type, r.Category, r["Sub-category"], r["Amount (€)"]]))), [
    ["Transfer", "Transferências Internas", "Entre contas", 8500],
    ["Transfer", "Transferências Internas", "Reforço CRP", -5],
  ]);
});

test("a refund is stored as a negative expense", () => {
  const { rows } = engine.rawRowsToTransactions([bankRow("01-10-2026", "Devolucao Zara", 30, 100)], "oct.csv");
  assert.equal(rows[0].Type, "Expense");
  assert.equal(rows[0]["Amount (€)"], -30);
  assert.equal(engine.signedAmount(rows[0]), 30);
});

test("unreadable rows are counted, not silently dropped", () => {
  const { rows, skipped } = engine.rawRowsToTransactions([
    bankRow("01-10-2026", "Continente", -10, 90),
    bankRow("not a date", "Continente", -10, 80),
    bankRow("02-10-2026", "Continente", "n/a", 70),
  ], "oct.csv");
  assert.equal(rows.length, 1);
  assert.equal(skipped, 2);
});

test("an old row stored as income is moved to internal transfers; a reviewed one is left alone", () => {
  const old = { Type: "Income", Category: "Transferências Pessoais", "Sub-category": "Transferência",
                Method: "Transferência", "Amount (€)": 1234.56, Notes: "Transferência entre contas",
                "Reviewed At": "" };
  assert.equal(engine.reshapeAsTransfer(old), true);
  assert.equal(old.Type, "Transfer");
  assert.equal(old["Amount (€)"], 1234.56);
  const reviewed = { ...old, Type: "Income", "Reviewed At": "2026-10-02T10:00:00" };
  assert.equal(engine.reshapeAsTransfer(reviewed), false);
});

test("bank balance: latest closing balance and reconciliation", () => {
  // Opening 100. Three movements on the last day, listed in no particular order.
  const { rows } = engine.rawRowsToTransactions([
    bankRow("02-10-2026", "Continente", -20, 60),
    bankRow("02-10-2026", "Salario Empresa", 50, 80),
    bankRow("01-10-2026", "Pingo Doce", -70, 30),
  ], "oct.xlsx");
  assert.deepEqual({ ...engine.latestBankBalance(rows) }, { date: "2026-10-02", balance: 60 });

  const ok = engine.reconcileWithBank(rows);
  assert.equal(ok.opening, 100);
  assert.equal(ok.closing, 60);
  assert.equal(ok.gap, 0);

  // The salary lost: the bank moved -40 overall, the store only sees -90.
  const lost = engine.reconcileWithBank(rows.filter(r => r.Notes !== "Salario Empresa"));
  assert.equal(lost.gap, 50);
});

test("meal card: only from a meal card export; money in there is the meal allowance", () => {
  const file = [bankRow("02-03-2026", "COMPRA *1234 Restaurante Teste", -15.2, 100), bankRow("27-03-2026", "ORDENADO DE EMPRESA SA-1", 211.2, 311.2)];
  const meal = JSON.parse(JSON.stringify(engine.rawRowsToTransactions(file, "x.xlsx", { mealCard: true }).rows));
  assert.deepEqual(meal.map(r => [r.Method, r.Category, r["Sub-category"]]),
    [["Cartão Alimentação", "Alimentação", "Restaurantes"], ["Cartão Alimentação", "Salário Alimentação", "Salário Alimentação"]]);
  const plain = JSON.parse(JSON.stringify(engine.rawRowsToTransactions(file, "x.xlsx").rows));
  assert.ok(plain.every(r => r.Method !== "Cartão Alimentação"));
  // Not from a description, and not from a rule that names it.
  assert.equal(engine.categorize("Pagamento Cartao Alimentacao Edenred", -5)[2], "Cartão");
  setRules([{ keywords: ["restaurante teste"], type: "expense", category: "Alimentação", sub_category: "Restaurantes", method: "Cartão Alimentação" }]);
  assert.equal(engine.categorize("Restaurante Teste", -12)[2], "Cartão");
  setRules([]);
  assert.equal($("isMealCardFile")("MealCard_Alim_Jan.xlsx"), true);
  assert.equal($("isMealCardFile")("Bank_Jan.xls"), false);
});

test("an MBWay the bank names no one for is Outros / Outros", () => {
  assert.deepEqual([...engine.categorize("Trf. MB WAY emitida", -35)], ["Outros", "Outros", "MBWay"]);
});
