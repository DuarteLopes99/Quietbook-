// Re-classifying transactions, with a confidence score, by several methods.
// Pure functions (no DOM): the dashboard's "Re-run" card and
// scripts/evaluate.js (the notebook) call the same code.
//
//   rules   Current rules (default). What the store already uses. Confidence:
//           how often that rule agreed with your reviews.
//   similar Similar past reviews. Nearest reviewed transactions by text
//           (TF-IDF over character n-grams), voting with their similarity.
//   hybrid  Rules, then similar reviews when the rules are less sure.
//   qwen    Hybrid, then a local Qwen (Ollama) for what is still unsure,
//           shown the most similar reviews as examples (RAG).
//
// Every method learns only from rows you reviewed by hand (Reviewed At set):
// never from rule-filed rows or from its own answers, so it cannot learn the
// rules' mistakes or its own.

const CLASSIFIER_METHODS = {
  rules: "Current rules",
  similar: "Similar past reviews",
  hybrid: "Rules + similar reviews",
  qwen: "Rules + similar reviews + Qwen (local)",
};

// What each method trusts, for the dashboard's method guide.
const METHOD_GUIDE = {
  rules: "Your rules and the built-in keyword rules, exactly what files every import. "
    + "Sure when the rule that fired has agreed with your reviews before.",
  similar: "The 5 transactions you reviewed that read most like this one vote. "
    + "Sure when they are close matches and agree; knows nothing about merchants you never reviewed.",
  hybrid: "Per transaction, whichever of the two above is more sure.",
  qwen: "The combined answer, plus a local Qwen model for what it is unsure about, shown your most similar "
    + "reviews as examples. Can place merchants you never reviewed; its confidence is its own claim.",
};

// Below this confidence the qwen method asks the model.
const QWEN_THRESHOLD = 0.6;

// The note on a row filed by an accepted re-run. Such a row is never
// "reviewed", so it never becomes training data.
const RERUN_MARKER = "⚙ filed by";
function isRerunAccepted(row) {
  return !row[REVIEWED_AT] && String(row[REVIEW_NOTE] || "").startsWith(RERUN_MARKER);
}

const pairKey = (type, category, sub) => `${type}|${category}|${sub}`;
const rowKey = r => pairKey(r.Type, r.Category, r["Sub-category"]);

// Rows a method can learn from: reviewed by hand, not an internal transfer.
function trainingRows(rows) {
  return rows.filter(r => r[REVIEWED_AT] && r.Type !== TYPE_TRANSFER);
}

// ---------------------------------------------------------------------
// Features and similarity
// ---------------------------------------------------------------------

function amountBucket(r) {
  const a = Math.abs(Number(r["Amount (€)"]) || 0);
  return a < 5 ? "<5" : a < 15 ? "<15" : a < 40 ? "<40" : a < 100 ? "<100" : a < 500 ? "<500" : "500+";
}

// Words, character 3- to 5-grams (so "restaurante" and "rest." share
// something), the amount band and the payment method.
function features(r) {
  const text = normalize(r.Notes || "");
  const padded = ` ${text} `;
  const out = new Map();
  const add = f => out.set(f, (out.get(f) || 0) + 1);
  for (const w of text.split(" ")) if (w.length > 1 && !/^\d+$/.test(w)) add("w:" + w);
  for (let n = 3; n <= 5; n++) {
    for (let i = 0; i + n <= padded.length; i++) add("c:" + padded.slice(i, i + n));
  }
  add("amount:" + amountBucket(r));
  add("method:" + (r.Method || ""));
  return out;
}

// A TF-IDF index of the training rows.
function buildIndex(examples) {
  const df = new Map();
  const counted = examples.map(row => {
    const tf = features(row);
    for (const f of tf.keys()) df.set(f, (df.get(f) || 0) + 1);
    return { row, tf };
  });
  const n = counted.length;
  const vector = tf => {
    const v = new Map();
    let norm = 0;
    for (const [f, c] of tf) {
      const w = (1 + Math.log(c)) * (Math.log((n + 1) / ((df.get(f) || 0) + 1)) + 1);
      v.set(f, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [f, w] of v) v.set(f, w / norm);
    return v;
  };
  const docs = counted.map(d => ({ row: d.row, vec: vector(d.tf) }));
  // Inverted index (feature -> [doc number, weight]), so a query only visits
  // the documents it shares a feature with.
  const postings = new Map();
  docs.forEach((d, i) => {
    for (const [f, w] of d.vec) {
      if (!postings.has(f)) postings.set(f, []);
      postings.get(f).push([i, w]);
    }
  });
  return { docs, postings, vector: row => vector(features(row)) };
}

// The k most similar training rows of the same type, excluding the row
// itself, as [{ row, similarity }].
function nearest(index, r, k = 5) {
  const q = index.vector(r);
  const sums = new Float64Array(index.docs.length);
  for (const [f, w] of q) {
    const list = index.postings.get(f);
    if (list) for (const [i, x] of list) sums[i] += w * x;
  }
  const scored = [];
  for (let i = 0; i < sums.length; i++) {
    const d = index.docs[i];
    if (sums[i] <= 0 || d.row.Type !== r.Type || d.row.transaction_id === r.transaction_id) continue;
    scored.push({ row: d.row, similarity: sums[i] });
  }
  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, k);
}

// ---------------------------------------------------------------------
// The methods
// ---------------------------------------------------------------------

// What the rules file a stored row as, including what only the import knows:
// money into the meal card is the meal allowance (see rawRowsToTransactions).
function rulesAnswer(r) {
  const p = categorizeExplained(r.Notes, signedAmount(r));
  if (r.Type === TYPE_INCOME && isMealCardFile(r["Source File"])) {
    return { ...p, category: "Salário Alimentação", sub: "Salário Alimentação", source: "meal card import" };
  }
  return p;
}

// Everything a method needs, learned from the training rows.
function trainClassifier(examples) {
  // How often each rule's answer matched your review: { source: {fires, hits} }.
  const ruleStats = new Map();
  for (const r of examples) {
    const p = rulesAnswer(r);
    const s = ruleStats.get(p.source) || { fires: 0, hits: 0 };
    s.fires++;
    if (pairKey(p.type, p.category, p.sub) === rowKey(r)) s.hits++;
    ruleStats.set(p.source, s);
  }
  return { index: buildIndex(examples), ruleStats };
}

const candidate = (type, category, sub, confidence, source) =>
  ({ type, category, sub, confidence: Math.round(confidence * 1000) / 1000, source });

// The best answer, plus up to 3 candidates (best first) for "top 3" displays.
function prediction(type, category, sub, confidence, source, alternatives) {
  const best = candidate(type, category, sub, confidence, source);
  return { ...best, alternatives: (alternatives || [best]).slice(0, 3) };
}

// Rule confidence: the share of your reviews the rule got right, smoothed
// toward one half so a rule seen once or twice doesn't claim certainty.
// Rows the rules couldn't file (fallback, gateway) get 0.
function predictRules(model, r) {
  const p = rulesAnswer(r);
  if (p.source === "fallback" || p.source === "gateway") return prediction(p.type, p.category, p.sub, 0, p.source);
  const s = model.ruleStats.get(p.source) || { fires: 0, hits: 0 };
  return prediction(p.type, p.category, p.sub, (s.hits + 1) / (s.fires + 2), p.source);
}

// Similar reviews: each of the 5 nearest votes with its similarity.
// Confidence = the winning label's share of the votes x the best similarity,
// so a unanimous vote by distant neighbours still reads as unsure.
function predictSimilar(model, r) {
  const near = nearest(model.index, r, 5);
  if (!near.length) return null;
  const votes = new Map();
  for (const n of near) votes.set(rowKey(n.row), (votes.get(rowKey(n.row)) || 0) + n.similarity);
  const total = near.reduce((t, n) => t + n.similarity, 0);
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]).map(([label, weight]) => {
    const [type, category, sub] = label.split("|");
    const example = near.find(n => rowKey(n.row) === label);
    return candidate(type, category, sub, (weight / total) * near[0].similarity, `similar to: ${example.row.Notes}`);
  });
  const top = ranked[0];
  return prediction(top.type, top.category, top.sub, top.confidence, top.source, ranked);
}

// Every candidate from both methods, each pair at its highest confidence;
// the most confident wins (the rules on a tie).
function predictHybrid(model, r) {
  const rules = predictRules(model, r);
  const similar = predictSimilar(model, r);
  const best = new Map();
  for (const c of [...rules.alternatives, ...(similar ? similar.alternatives : [])]) {
    const key = pairKey(c.type, c.category, c.sub);
    if (c.confidence > 0 && !(best.has(key) && best.get(key).confidence >= c.confidence)) best.set(key, c);
  }
  const ranked = [...best.values()].sort((a, b) => b.confidence - a.confidence);
  if (!ranked.length) return rules;
  const top = ranked[0];
  return prediction(top.type, top.category, top.sub, top.confidence, top.source, ranked);
}

// Synchronous methods. qwen starts from hybrid; the caller then sends rows
// below QWEN_THRESHOLD to the model (see llmPrompt / parseLlmAnswer).
function predictWith(model, method, r) {
  if (method === "rules") return predictRules(model, r);
  if (method === "similar") return predictSimilar(model, r) || prediction(r.Type, UNCLASSIFIED_CATEGORY, UNCLASSIFIED_SUB, 0, "no similar review");
  return predictHybrid(model, r);
}

// ---------------------------------------------------------------------
// Qwen through Ollama (local, free). The prompt numbers the allowed
// categories, so the answer is always a valid pair.
// ---------------------------------------------------------------------

function llmChoices(type) {
  return Object.entries(TAXONOMY[type] || {})
    .flatMap(([category, subs]) => subs.map(sub => [category, sub]))
    .filter(([c, s]) => !(c === UNCLASSIFIED_CATEGORY && s === UNCLASSIFIED_SUB));
}

function llmPrompt(model, r) {
  const choices = llmChoices(r.Type);
  const examples = nearest(model.index, r, 8);
  const eur = row => `${Math.abs(Number(row["Amount (€)"]) || 0).toFixed(2)} EUR`;
  const system = "You file Portuguese bank transactions into a fixed list of categories. "
    + "Reply with JSON only, no other text: {\"choice\": <number from the list>, \"confidence\": <0 to 1>}.";
  const user = [
    "Categories:",
    ...choices.map(([c, s], i) => `${i + 1}. ${c} / ${s}`),
    "",
    "Similar transactions already filed by the owner:",
    ...(examples.length ? examples.map(n => `- "${n.row.Notes}", ${eur(n.row)} -> ${n.row.Category} / ${n.row["Sub-category"]}`)
                        : ["(none)"]),
    "",
    `Transaction: "${r.Notes}", ${eur(r)}, ${r.Type === TYPE_INCOME ? "money in" : "money out"}, paid by ${r.Method || "unknown"}.`,
    "Which category number?",
  ].join("\n");
  return { messages: [{ role: "system", content: system }, { role: "user", content: user }], choices };
}

// The body for Ollama's /api/chat, minus the model name (the caller adds the
// one it was configured with). Thinking off and JSON output: the answer is a
// number, and a long reasoning trace would only make it slower.
function ollamaBody(messages) {
  return { messages, stream: false, think: false, format: "json", options: { temperature: 0 } };
}

// The model's reply -> a prediction, or null when it isn't usable. Any
// thinking block is dropped. The model's own confidence is not a measured
// probability: the notebook shows how far it can be trusted.
function parseLlmAnswer(text, choices, type) {
  const clean = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const match = clean.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  let answer;
  try { answer = JSON.parse(match[0]); } catch (e) { return null; }
  const i = Number(answer.choice) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= choices.length) return null;
  const confidence = Math.min(Math.max(Number(answer.confidence) || 0, 0), 1);
  return prediction(type, choices[i][0], choices[i][1], confidence, "qwen");
}

// ---------------------------------------------------------------------
// Evaluation: train on the older reviews, test on the newest.
// ---------------------------------------------------------------------

// The newest `testShare` of your reviewed rows are the test set: the model
// meets them the way it will meet next month's import.
function splitByDate(rows, testShare = 0.25) {
  const reviewed = trainingRows(rows).slice().sort((a, b) => String(a.Date).localeCompare(String(b.Date)));
  const cut = Math.round(reviewed.length * (1 - testShare));
  return { train: reviewed.slice(0, cut), test: reviewed.slice(cut) };
}

// Scores for one method given predictions aligned with the test rows.
function scorePredictions(test, predictions, train, thresholds = [0.5, 0.8, 0.9]) {
  const seen = new Set(train.map(r => normalize(r.Notes)));
  const right = (r, p) => p && pairKey(p.type, p.category, p.sub) === rowKey(r);
  const acc = list => (list.length ? list.filter(([r, p]) => right(r, p)).length / list.length : null);
  const pairs = test.map((r, i) => [r, predictions[i]]);
  const conf = p => (p ? p.confidence : 0);
  const at = t => {
    const kept = pairs.filter(([, p]) => conf(p) >= t);
    return { threshold: t, coverage: kept.length / pairs.length, accuracy: acc(kept) };
  };
  const bins = [0, 0.2, 0.4, 0.6, 0.8].map(lo => {
    const inBin = pairs.filter(([, p]) => conf(p) >= lo && conf(p) < lo + 0.2 + (lo === 0.8 ? 1e-9 : 0));
    return { from: lo, to: lo + 0.2, count: inBin.length, accuracy: acc(inBin) };
  });
  const byCategory = {};
  for (const [r, p] of pairs) {
    const c = byCategory[r.Category] || (byCategory[r.Category] = { count: 0, right: 0 });
    c.count++;
    if (right(r, p)) c.right++;
  }
  return {
    accuracy: acc(pairs),
    newMerchants: { count: pairs.filter(([r]) => !seen.has(normalize(r.Notes))).length,
                    accuracy: acc(pairs.filter(([r]) => !seen.has(normalize(r.Notes)))) },
    thresholds: thresholds.map(at),
    reliability: bins,
    byCategory,
  };
}

// Train on the older reviews, score every synchronous method on the newest.
// (qwen is scored by scripts/evaluate.js, which can wait for the model.)
function evaluateMethods(rows, methods = ["rules", "similar", "hybrid"], testShare = 0.25, thresholds) {
  const { train, test } = splitByDate(rows, testShare);
  const model = trainClassifier(train);
  const results = {};
  for (const m of methods) results[m] = scorePredictions(test, test.map(r => predictWith(model, m, r)), train, thresholds);
  return { split: { train: train.length, test: test.length, testFrom: test.length ? test[0].Date : null }, results };
}

// ---------------------------------------------------------------------
// Comparing methods over the whole store, and what applying one would do
// ---------------------------------------------------------------------

// Every method's answer for every transaction (internal transfers aside),
// all trained on the same reviews: { trainedOn, model, predictions: {method: Map(id -> prediction)} }.
function compareMethods(rows, methods = ["rules", "similar", "hybrid"]) {
  const examples = trainingRows(rows);
  const model = trainClassifier(examples);
  const predictions = {};
  for (const m of methods) {
    predictions[m] = new Map(rows.filter(r => r.Type !== TYPE_TRANSFER)
      .map(r => [String(r.transaction_id), predictWith(model, m, r)]));
  }
  return { trainedOn: examples.length, model, predictions };
}

const samePair = (r, p) => Boolean(p) && p.type === r.Type && p.category === r.Category && p.sub === r["Sub-category"];

// The rows applying a method would change: not reviewed by you, same type,
// at or above the threshold, and a different category or sub-category.
function plannedChanges(rows, predictions, threshold) {
  return rows
    .filter(r => r.Type !== TYPE_TRANSFER && !r[REVIEWED_AT])
    .map(r => ({ row: r, prediction: predictions.get(String(r.transaction_id)) }))
    .filter(({ row, prediction: p }) => p && p.type === row.Type && p.confidence > 0
      && p.confidence >= threshold && !samePair(row, p));
}

// How sure a method is about the rows you haven't reviewed.
function summarizeUnreviewed(rows, predictions, threshold) {
  const targets = rows.filter(r => r.Type !== TYPE_TRANSFER && !r[REVIEWED_AT]);
  const confs = targets.map(r => (predictions.get(String(r.transaction_id)) || { confidence: 0 }).confidence);
  return {
    unreviewed: targets.length,
    meanConfidence: confs.length ? confs.reduce((t, c) => t + c, 0) / confs.length : 0,
    sure: confs.filter(c => c >= threshold).length,
    wouldChange: plannedChanges(rows, predictions, threshold).length,
  };
}

// How a row got its current category, for every section of the dashboard.
// `copied` says whether the review was copied from an identical description.
const FILED_BY = {
  you: "You",
  copied: "Your review, copied",
  rerun: "Re-run ⚙",
  transfer: "Internal transfer",
  "your rule": "Your rule",
  "built-in": "Built-in rule",
  person: "Person transfer",
  tracker: "Your old tracker",
  unfiled: "Not filed yet",
  other: "Earlier rules",
};

// The review note on rows seeded from the Excel tracker you kept before the
// dashboard. They count as reviewed: the categories are yours.
const TRACKER_NOTE = "From your old tracker";

function filedBy(row, copied = false) {
  if (row.Type === TYPE_TRANSFER) return "transfer";
  if (row[REVIEWED_AT]) {
    if (String(row[REVIEW_NOTE] || "").startsWith(TRACKER_NOTE)) return "tracker";
    return copied ? "copied" : "you";
  }
  if (isRerunAccepted(row)) return "rerun";
  if (row.Category === UNCLASSIFIED_CATEGORY && row["Sub-category"] === UNCLASSIFIED_SUB) return "unfiled";
  const p = rulesAnswer(row);
  if (!samePair(row, p)) return "other";
  if (p.source.startsWith("your rule")) return "your rule";
  if (p.source.startsWith("built-in") || p.source === "meal card import") return "built-in";
  if (p.source.startsWith("person transfer")) return "person";
  return "other";
}

// Unreviewed transactions with exactly the same description (and type) as one
// you reviewed, but filed under another category: a review that did not reach
// them. Transfers to people are left out: the same person can be paid for
// different things, so a different category there is expected.
function escapedFromReviews(rows) {
  const reviewed = new Map();   // type|description -> Map(pair -> count)
  for (const r of rows) {
    if (!r[REVIEWED_AT] || r.Type === TYPE_TRANSFER || !String(r.Notes || "").trim()) continue;
    const key = `${r.Type}|${normalize(r.Notes)}`;
    if (!reviewed.has(key)) reviewed.set(key, new Map());
    reviewed.get(key).set(rowKey(r), (reviewed.get(key).get(rowKey(r)) || 0) + 1);
  }
  const out = [];
  for (const r of rows) {
    if (r[REVIEWED_AT] || r.Type === TYPE_TRANSFER) continue;
    // A person can be paid for different things; only a rule you saved
    // ("Remember as a rule") says otherwise.
    if (r.Method === "MBWay" || r.Method === "Transferência") continue;
    const answers = reviewed.get(`${r.Type}|${normalize(r.Notes)}`);
    if (!answers || answers.has(rowKey(r))) continue;
    const [label, times] = [...answers.entries()].sort((a, b) => b[1] - a[1])[0];
    const [, category, sub] = label.split("|");
    out.push({ row: r, category, sub, times });
  }
  return out;
}

// ---------------------------------------------------------------------
// Re-run versions. A re-run files only what no one decided for sure: never a
// row you reviewed, never one your rules or the built-in rules file (those are
// decisions too, made once for every matching description). What is left is
// what the rules could only guess at: nothing matched, a person transfer, a
// hidden payment gateway, or a row an earlier re-run filed.
//
// Each re-run is kept as a version: the method's sure answers for the rows in
// scope. Making a version active files every row in scope by it (the rules'
// answer where it had none); "Rules only" is the version with no answers.
// ---------------------------------------------------------------------

const HARD_RULE_SOURCE = /^(your rule|built-in)\b|^meal card import$/;

function inRerunScope(row) {
  if (row.Type === TYPE_TRANSFER || row[REVIEWED_AT]) return false;
  return !HARD_RULE_SOURCE.test(rulesAnswer(row).source);
}

// A version from one method's predictions. Only answers at or above the
// threshold, of the row's own type, and different from what the rules say
// (an answer equal to the rules' adds nothing to keep).
function makeRun(rows, predictions, method, threshold, now) {
  const answers = {};
  for (const r of rows) {
    if (!inRerunScope(r)) continue;
    const p = predictions.get(String(r.transaction_id));
    if (!p || p.type !== r.Type || !(p.confidence > 0) || p.confidence < threshold) continue;
    const ruled = rulesAnswer(r);
    if (ruled.type === r.Type && ruled.category === p.category && ruled.sub === p.sub) continue;
    answers[String(r.transaction_id)] = { category: p.category, sub: p.sub, confidence: p.confidence, source: p.source };
  }
  return { method, threshold, created_at: now, updated_at: now, active: true, answers };
}

// What making `run` active (null: rules only) would change: for every row in
// scope, or carrying an earlier re-run answer, the category it should have and
// the answer behind it (null when it falls back to the rules). Only rows whose
// category or re-run mark would change are returned.
function versionTargets(rows, run) {
  const out = [];
  for (const r of rows) {
    const scoped = inRerunScope(r);
    if (!scoped && !isRerunAccepted(r)) continue;
    const answer = run && scoped ? run.answers[String(r.transaction_id)] || null : null;
    let category, sub;
    if (answer) ({ category, sub } = answer);
    else {
      const ruled = rulesAnswer(r);
      [category, sub] = ruled.type === r.Type ? [ruled.category, ruled.sub] : [UNCLASSIFIED_CATEGORY, UNCLASSIFIED_SUB];
    }
    const moves = category !== r.Category || sub !== r["Sub-category"];
    if (moves || Boolean(answer) !== isRerunAccepted(r)) out.push({ row: r, category, sub, answer });
  }
  return out;
}

// How well a row sits in its current category: its nearest reviewed
// transactions of the same type that read alike (similarity at least
// FIT_MIN_SIMILARITY: below it two rows share little more than the payment
// method), how many share its category, and the most common other one.
const FIT_MIN_SIMILARITY = 0.2;
function categoryFit(model, r, k = 5) {
  const near = nearest(model.index, r, k).filter(n => n.similarity >= FIT_MIN_SIMILARITY);
  const others = new Map();
  let here = 0;
  for (const n of near) {
    if (rowKey(n.row) === rowKey(r)) here++;
    else others.set(rowKey(n.row), (others.get(rowKey(n.row)) || 0) + 1);
  }
  const top = [...others.entries()].sort((a, b) => b[1] - a[1])[0];
  const elsewhere = top ? { category: top[0].split("|")[1], sub: top[0].split("|")[2], count: top[1] } : null;
  // "Looks elsewhere": at least two close reviews agree on one other
  // category, and more of them than on this one.
  const off = Boolean(elsewhere) && elsewhere.count >= 2 && elsewhere.count > here;
  return { neighbours: near.length, here, elsewhere, off };
}
