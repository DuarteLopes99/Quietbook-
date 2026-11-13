#!/usr/bin/env node
// Train / test evaluation of the classification methods on your own data.
// Trains on the older 75% of your reviewed transactions, tests on the newest
// 25%, and prints the scores as JSON. notebook/tests_and_evaluation.ipynb
// runs this and draws the results.
//
//   node scripts/evaluate.js                  # rules, similar, hybrid
//   node scripts/evaluate.js --qwen 40        # also qwen, asking it about at most 40 test rows
//   node scripts/evaluate.js --test-share 0.3
//
// Only aggregate scores are printed (no descriptions or amounts), so the
// notebook's outputs carry no personal data.
const fs = require("node:fs");
const path = require("node:path");
const { loadEngine } = require("./load-engine");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const TEST_SHARE = option("--test-share", 0.25);
const QWEN_LIMIT = option("--qwen", 0);
const OLLAMA_URL = (process.env.FINANCE_OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.FINANCE_OLLAMA_MODEL || "hf.co/bartowski/Qwen_Qwen3.5-9B-GGUF:Q4_K_M";

const REPO = path.join(__dirname, "..");
const $ = loadEngine({ papaparse: true });

function loadRows() {
  const text = fs.readFileSync(path.join(REPO, "data", "transactions.csv"), "utf8");
  const rows = $.context.Papa.parse(text, { header: true, skipEmptyLines: true }).data;
  for (const r of rows) r["Amount (€)"] = Number(r["Amount (€)"]);
  let rules = [];
  try { rules = JSON.parse(fs.readFileSync(path.join(REPO, "data", "category_overrides.json"), "utf8")); }
  catch (e) { /* no rules yet */ }
  // `overrides` is a script-level `let`, so it is assigned inside the scope.
  $.context.__rules = rules;
  $("overrides = __rules");
  return rows;
}

async function askQwen(model, row) {
  const { messages, choices } = $.context.llmPrompt(model, row);
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...$.context.ollamaBody(messages), model: OLLAMA_MODEL }),
  });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return $.context.parseLlmAnswer(data.message?.content, choices, row.Type);
}

// qwen = hybrid, plus the model for up to QWEN_LIMIT unsure test rows.
async function evaluateQwen(rows) {
  const { train, test } = $.context.splitByDate(rows, TEST_SHARE);
  const model = $.context.trainClassifier(train);
  const predictions = test.map(r => $.context.predictWith(model, "hybrid", r));
  let asked = 0, unusable = 0, seconds = 0;
  for (let i = 0; i < test.length && asked < QWEN_LIMIT; i++) {
    if (predictions[i].confidence >= $("QWEN_THRESHOLD")) continue;
    const started = Date.now();
    const answer = await askQwen(model, test[i]);
    seconds += (Date.now() - started) / 1000;
    asked++;
    if (answer) predictions[i] = answer; else unusable++;
    process.stderr.write(`qwen ${asked}/${QWEN_LIMIT}\r`);
  }
  return { ...$.context.scorePredictions(test, predictions, train),
           qwen: { model: OLLAMA_MODEL, asked, unusable, secondsPerRow: asked ? seconds / asked : null } };
}

async function main() {
  const rows = loadRows();
  const report = $.context.evaluateMethods(rows, ["rules", "similar", "hybrid"], TEST_SHARE);
  if (QWEN_LIMIT > 0) report.results.qwen = await evaluateQwen(rows);
  // Through JSON so the objects lose the sandbox's prototypes.
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch(e => { console.error(e.message); process.exit(1); });
