// Run with:  node --test
// Synthetic data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEngine } = require("../scripts/load-engine");

const $ = loadEngine();
const plain = v => JSON.parse(JSON.stringify(v));   // drop the sandbox's prototypes
$("overrides = []");

let n = 0;
function row(date, notes, amount, category, sub, { reviewed = true, type = "Expense", method = "Cartão" } = {}) {
  return { transaction_id: `t${++n}`, Date: date, Type: type, Category: category, "Sub-category": sub,
           Method: method, "Amount (€)": amount, Notes: notes,
           "Reviewed At": reviewed ? `${date}T12:00:00` : "", "Review Note": "" };
}

const reviews = [
  row("2026-01-02", "Continente Lisboa", 40, "Alimentação", "Compras"),
  row("2026-01-09", "Continente Lisboa", 35, "Alimentação", "Compras"),
  row("2026-01-10", "Lugar do Monte", 60, "Alimentação", "Restaurantes"),
  row("2026-02-03", "Lugar do Monte Norte", 45, "Alimentação", "Restaurantes"),
  row("2026-02-05", "Padaria Estrela", 3, "Alimentação", "Café/Padaria"),
  row("2026-02-20", "Ginasio Central", 30, "Desporto", "Ginásio"),
];

test("categorizeExplained names the rule that fired", () => {
  assert.equal($("categorizeExplained")("Continente Lisboa", -40).source, "built-in: continente|pingo doce|lidl");
  assert.equal($("categorizeExplained")("Loja XPTO", -5).source, "fallback");
  $(`overrides = [{ keywords: ["xpto"], type: "expense", category: "Lazer", sub_category: "Outros", method: "Cartão" }]`);
  assert.equal($("categorizeExplained")("Loja XPTO", -5).source, "your rule: xpto");
  $("overrides = []");
});

test("only hand-reviewed, non-transfer rows are training data", () => {
  const rows = [...reviews, row("2026-03-01", "Lidl", 9, "Alimentação", "Compras", { reviewed: false }),
                row("2026-03-02", "Transferência entre contas", 100, "Transferências Internas", "Entre contas", { type: "Transfer" })];
  assert.equal($("trainingRows")(rows).length, reviews.length);
});

test("rules: confidence is how often the rule matched your reviews; nothing matched is 0", () => {
  const model = $("trainClassifier")(reviews);
  const hit = plain($("predictRules")(model, row("2026-03-01", "Continente Lisboa", 20, "Outros", "Por Classificar", { reviewed: false })));
  assert.deepEqual([hit.category, hit.sub], ["Alimentação", "Compras"]);
  assert.equal(hit.confidence, 0.75);   // 2 of 2 right, smoothed: (2+1)/(2+2)
  const none = plain($("predictRules")(model, row("2026-03-01", "Casa Nova Lda", 10, "Outros", "Por Classificar", { reviewed: false })));
  assert.equal(none.confidence, 0);
});

test("similar reviews file a merchant the rules don't know, and never vote for the row itself", () => {
  const model = $("trainClassifier")(reviews);
  const p = plain($("predictSimilar")(model, row("2026-03-01", "Lugar do Monte Porto", 50, "Outros", "Por Classificar", { reviewed: false })));
  assert.deepEqual([p.category, p.sub], ["Alimentação", "Restaurantes"]);
  assert.ok(p.confidence > 0.3 && p.confidence <= 1);
  const self = plain($("nearest")(model.index, reviews[2], 5));
  assert.ok(self.every(x => x.row.transaction_id !== reviews[2].transaction_id));
});

test("hybrid takes whichever of rules and similar reviews is more confident", () => {
  const model = $("trainClassifier")(reviews);
  const unknown = row("2026-03-01", "Lugar do Monte Porto", 50, "Outros", "Por Classificar", { reviewed: false });
  assert.equal($("predictWith")(model, "hybrid", unknown).category, "Alimentação");
  const known = row("2026-03-01", "Continente Lisboa", 20, "Outros", "Por Classificar", { reviewed: false });
  assert.match($("predictWith")(model, "hybrid", known).source, /^built-in|^similar/);
});

test("evaluation trains on older reviews and tests on the newest", () => {
  const report = plain($("evaluateMethods")(reviews, ["rules", "similar", "hybrid"], 0.5));
  assert.deepEqual(report.split, { train: 3, test: 3, testFrom: "2026-02-03" });
  for (const m of ["rules", "similar", "hybrid"]) {
    const r = report.results[m];
    assert.ok(r.accuracy >= 0 && r.accuracy <= 1, m);
    assert.equal(r.reliability.reduce((t, b) => t + b.count, 0), 3, m);
  }
});

test("Qwen prompt numbers only valid pairs, and the answer maps back to one", () => {
  const model = $("trainClassifier")(reviews);
  const target = row("2026-03-01", "Casa Nova Lda", 10, "Outros", "Por Classificar", { reviewed: false });
  const { messages, choices } = plain($("llmPrompt")(model, target));
  assert.ok(!choices.some(([c, s]) => c === "Outros" && s === "Por Classificar"));
  assert.match(messages[1].content, /Casa Nova Lda/);
  const i = choices.findIndex(([c, s]) => c === "Alimentação" && s === "Restaurantes") + 1;
  const parse = $("parseLlmAnswer");
  const p = plain(parse(`<think>hmm</think>{"choice": ${i}, "confidence": 0.8}`, choices, "Expense"));
  assert.deepEqual([p.category, p.sub, p.confidence, p.source], ["Alimentação", "Restaurantes", 0.8, "qwen"]);
  assert.equal(parse(`{"choice": 9999, "confidence": 1}`, choices, "Expense"), null);
  assert.equal(parse("no json here", choices, "Expense"), null);
});

test("plannedChanges: only unreviewed, same type, sure and different", () => {
  const model = $("trainClassifier")(reviews);
  const unknown = row("2026-03-01", "Lugar do Monte Porto", 50, "Outros", "Por Classificar", { reviewed: false });
  const already = row("2026-03-02", "Continente Lisboa", 20, "Alimentação", "Compras", { reviewed: false });
  const rows = [...reviews, unknown, already];
  const preds = new Map(rows.map(r => [r.transaction_id, $("predictWith")(model, "similar", r)]));
  const planned = plain($("plannedChanges")(rows, preds, 0.3).map(c => c.row.transaction_id));
  assert.deepEqual(planned, [unknown.transaction_id]);           // reviewed rows and agreeing rows left alone
  assert.equal($("plannedChanges")(rows, preds, 1).length, 0);   // nothing is that sure
  const s = plain($("summarizeUnreviewed")(rows, preds, 0.3));
  assert.equal(s.unreviewed, 2);
  assert.equal(s.wouldChange, 1);
});

test("filedBy says where each category came from; a re-run row is never training data", () => {
  $(`overrides = [{ keywords: ["xpto"], type: "expense", category: "Lazer", sub_category: "Outros", method: "Cartão" }]`);
  const filed = $("filedBy");
  assert.equal(filed(reviews[0]), "you");
  assert.equal(filed(reviews[0], true), "copied");
  assert.equal(filed({ ...reviews[0], "Review Note": "From your old tracker" }), "tracker");
  assert.equal(filed(row("2026-03-01", "Continente", 9, "Alimentação", "Compras", { reviewed: false })), "built-in");
  assert.equal(filed(row("2026-03-01", "Loja XPTO", 9, "Lazer", "Outros", { reviewed: false })), "your rule");
  assert.equal(filed(row("2026-03-01", "Loja Nova", 9, "Outros", "Por Classificar", { reviewed: false })), "unfiled");
  assert.equal(filed(row("2026-03-01", "Continente", 9, "Lazer", "Outros", { reviewed: false })), "other");
  const accepted = row("2026-03-01", "Casa Nova", 10, "Alimentação", "Restaurantes", { reviewed: false });
  accepted["Review Note"] = "⚙ filed by Rules + similar reviews, 95% (similar to: x)";
  assert.equal(filed(accepted), "rerun");
  assert.equal($("trainingRows")([...reviews, accepted]).length, reviews.length);
  $("overrides = []");
});

test("top 3: best first, distinct pairs, confidences descending", () => {
  const model = $("trainClassifier")(reviews);
  const target = row("2026-03-01", "Lugar do Monte Padaria", 50, "Outros", "Por Classificar", { reviewed: false });
  for (const m of ["rules", "similar", "hybrid"]) {
    const p = plain($("predictWith")(model, m, target));
    const alts = p.alternatives;
    assert.ok(alts.length >= 1 && alts.length <= 3, m);
    assert.deepEqual([alts[0].category, alts[0].sub, alts[0].confidence], [p.category, p.sub, p.confidence], m);
    assert.equal(new Set(alts.map(a => `${a.category}/${a.sub}`)).size, alts.length, m);
    for (let i = 1; i < alts.length; i++) assert.ok(alts[i - 1].confidence >= alts[i].confidence, m);
  }
});

test("escapedFromReviews finds identical descriptions your review did not reach", () => {
  const a = row("2026-03-01", "Trf. MB WAY para Amigo", 20, "Saúde", "Fisioterapia");
  const b = row("2026-03-08", "Trf. MB WAY para Amigo", 20, "Outros", "Transferências Pessoais", { reviewed: false });
  const c = row("2026-03-09", "Trf. MB WAY para Amigo", 20, "Saúde", "Fisioterapia", { reviewed: false });
  const d = row("2026-03-10", "Trf. MB WAY para Colega", 20, "Outros", "Transferências Pessoais", { reviewed: false });
  const found = plain($("escapedFromReviews")([a, b, c, d]));
  assert.deepEqual(found.map(e => [e.row.transaction_id, e.category, e.sub]), [[b.transaction_id, "Saúde", "Fisioterapia"]]);
});

test("re-run scope: not yours, not a hard rule; a person transfer or an unmatched row is in", () => {
  const scope = $("inRerunScope");
  assert.equal(scope(row("2026-03-01", "Continente Lisboa", 20, "Alimentação", "Compras", { reviewed: false })), false);
  assert.equal(scope(row("2026-03-01", "Casa Nova Lda", 10, "Outros", "Por Classificar", { reviewed: false })), true);
  assert.equal(scope(row("2026-03-01", "Casa Nova Lda", 10, "Lazer", "Outros")), false);   // reviewed
  assert.equal(scope(row("2026-03-01", "MB WAY para Vizinho", 10, "Outros", "Transferências Pessoais",
    { reviewed: false, method: "MBWay" })), true);
  $(`overrides = [{ keywords: ["casa nova"], type: "expense", category: "Casa", sub_category: "Outros", method: "Cartão" }]`);
  assert.equal(scope(row("2026-03-01", "Casa Nova Lda", 10, "Casa", "Outros", { reviewed: false })), false);
  $("overrides = []");
});

test("versions: a run keeps only sure, in-scope answers; rules only puts them back", () => {
  const unknown = row("2026-03-01", "Lugar do Monte Porto", 50, "Outros", "Por Classificar", { reviewed: false });
  const ruled = row("2026-03-02", "Continente Lisboa", 20, "Alimentação", "Compras", { reviewed: false });
  const rows = [...reviews, unknown, ruled];
  const preds = new Map([
    [unknown.transaction_id, { type: "Expense", category: "Alimentação", sub: "Restaurantes", confidence: 0.8, source: "similar" }],
    [ruled.transaction_id, { type: "Expense", category: "Lazer", sub: "Outros", confidence: 0.99, source: "similar" }],
  ]);
  const run = plain($("makeRun")(rows, preds, "similar", 0.7, "2026-03-05T10:00:00"));
  assert.deepEqual(Object.keys(run.answers), [unknown.transaction_id]);   // the ruled row is out of scope
  assert.equal(plain($("makeRun")(rows, preds, "similar", 0.9, "x")).answers[unknown.transaction_id], undefined);

  const on = plain($("versionTargets")(rows, run));
  assert.equal(on.length, 1);
  assert.deepEqual([on[0].category, on[0].sub], ["Alimentação", "Restaurantes"]);

  // Applied: the row carries the re-run mark. Rules only takes it back.
  unknown.Category = "Alimentação"; unknown["Sub-category"] = "Restaurantes";
  unknown["Review Note"] = "⚙ filed by Similar past reviews, 80% (similar)";
  assert.equal($("versionTargets")(rows, run).length, 0);
  const off = plain($("versionTargets")(rows, null));
  assert.deepEqual([off[0].category, off[0].sub, off[0].answer], ["Outros", "Por Classificar", null]);
});

test("categoryFit flags a row whose close reviews sit in another category", () => {
  const model = $("trainClassifier")(reviews);
  const misfiled = plain($("categoryFit")(model, row("2026-03-01", "Lugar do Monte Porto", 50, "Desporto", "Ginásio", { reviewed: false })));
  assert.equal(misfiled.off, true);
  assert.deepEqual([misfiled.elsewhere.category, misfiled.elsewhere.sub, misfiled.here], ["Alimentação", "Restaurantes", 0]);
  const fits = plain($("categoryFit")(model, row("2026-03-01", "Lugar do Monte Porto", 50, "Alimentação", "Restaurantes", { reviewed: false })));
  assert.deepEqual([fits.off, fits.here], [false, 2]);
  // Nothing reads alike: no neighbours, so no opinion.
  const alone = plain($("categoryFit")(model, row("2026-03-01", "Farmacia Sol", 9, "Saúde", "Farmácia", { reviewed: false })));
  assert.deepEqual([alone.neighbours, alone.off], [0, false]);
});
