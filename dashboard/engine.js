// The categorization engine: everything that turns a bank export into rows of
// the store. Pure functions, no DOM, so tests/engine.test.js can run them in
// Node exactly as the browser does. Reads its tables from rules.js.
//
//   bank export rows ──> rawRowsToTransactions() ──> store rows
//                            │
//                            ├─ isInternal()  -> Type "Transfer" (own accounts)
//                            ├─ categorize()  -> your rules, built-in rules, fallback
//                            └─ makeTransactionId() -> stable id for dedup

// ---------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------

// Lowercase, collapse spaces and strip accents, so every pattern is written
// once, unaccented. JavaScript's \b only knows [A-Za-z0-9_], which is why the
// word boundary below is an explicit ASCII class instead.
const WORD_CHAR = "a-z0-9_";
const ruleCache = new Map();

function normalize(description) {
  return String(description)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function compileRule(patterns) {
  const key = patterns.join("\u0000");
  let re = ruleCache.get(key);
  if (!re) {
    re = new RegExp(`(?<![${WORD_CHAR}])(?:${patterns.join("|")})(?![${WORD_CHAR}])`);
    ruleCache.set(key, re);
  }
  return re;
}

// Your rules hold plain words, not regex: escape them before compiling.
function compileKeywords(keywords) {
  return compileRule(keywords
    .filter(k => String(k).trim())
    .map(k => normalize(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

// ---------------------------------------------------------------------
// Rails, refunds and internal transfers
// ---------------------------------------------------------------------

const RAIL_MBWAY = compileRule(["mbway", "mb way"]);
const RAIL_TRANSFER = compileRule(["transferencia", "transferencias", "trf", "trf imed"]);
const GATEWAY_RE = compileRule(GATEWAY_PATTERNS);
const REFUND_RE = compileRule(REFUND_PATTERNS);

// The payment rail is decided separately from the purpose: "Mbway - Cinemas"
// is Lazer / Cinema AND Method MBWay. The meal card is never read from a
// description: it comes only from the file (see rawRowsToTransactions).
function overlayMethod(normalized, suggestedMethod) {
  if (suggestedMethod === MEAL_CARD_METHOD) suggestedMethod = "Cartão";
  if (RAIL_MBWAY.test(normalized)) return "MBWay";
  if (RAIL_TRANSFER.test(normalized)) return "Transferência";
  return suggestedMethod;
}

// Sub-category of an internal transfer (INTERNAL_RULES in rules.js), or null.
function internalTransferSub(description) {
  const normalized = normalize(description);
  for (const [patterns, sub] of INTERNAL_RULES) {
    if (compileRule(patterns).test(normalized)) return sub;
  }
  return null;
}
function isInternal(description) {
  return internalTransferSub(description) !== null;
}

// A refund is money in that undoes a purchase ("Devolução", "Estorno"). It is
// stored as a NEGATIVE expense under the purchase's category, so totals net.
function isRefund(description, amount) {
  return amount > 0 && REFUND_RE.test(normalize(description));
}
function isRefundRow(r) {
  return r.Type === TYPE_EXPENSE && Number(r["Amount (€)"]) < 0;
}
// Give an incoming row the refund shape (or take it away); true if it changed.
// A purchase is never turned into a refund.
function setRefundShape(r, refund) {
  const currently = isRefundRow(r);
  if (refund === currently || !(currently || r.Type === TYPE_INCOME)) return false;
  const amount = Math.abs(Number(r["Amount (€)"]) || 0);
  r.Type = refund ? TYPE_EXPENSE : TYPE_INCOME;
  r["Amount (€)"] = refund ? -amount : amount;
  return true;
}

// Money in or out of the account, signed: + in, - out.
// Income is stored positive, an expense positive (a refund negative), and an
// internal transfer already signed.
function signedAmount(r) {
  const v = Number(r["Amount (€)"]) || 0;
  if (r.Type === TYPE_INCOME || r.Type === TYPE_TRANSFER) return v;
  return -v;
}

// ---------------------------------------------------------------------
// Counterparty (for MBWay / transfer descriptions)
// ---------------------------------------------------------------------

const MBWAY_NAME_RE = /mb\s*way\s+(?:para|de)\s+(.+)$/i;
const TRANSFER_NAME_RE = /transfer[êe]ncia\s+(?:para|de)\s+(.+)$/i;

function extractCounterparty(description) {
  for (const re of [MBWAY_NAME_RE, TRANSFER_NAME_RE]) {
    const m = re.exec(String(description));
    if (m) {
      const name = m[1].trim().replace(/^[.\s]+|[.\s]+$/g, "");
      if (name) return name;
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Categorization
// ---------------------------------------------------------------------

// Your rules: data/category_overrides.json, created only from the review
// panel's "Remember" box. They are the one learning mechanism: nothing is
// learned unless you save a rule.
let overrides = [];

function matchOverride(normalized, txnType) {
  for (const o of overrides) {
    if (o.type !== txnType && o.type !== "both") continue;
    const keywords = (o.keywords || []).filter(k => String(k).trim());
    if (keywords.length && compileKeywords(keywords).test(normalized)) return o;
  }
  return null;
}

// The rule that classified a row, and its answer. The ladder, top wins:
//   1. payment gateway (the merchant is hidden)  -> review queue
//   2. your rules                                 (category_overrides.json)
//   3. built-in rules                             (PURPOSE_*_RULES in rules.js)
//   4. a transfer to/from a person                -> Transferências Pessoais
//   5. nothing matched                            -> Outros / Por Classificar
// A row you reviewed by hand sits above all of these and is never re-derived.
//
// `source` names the rung and the rule ("your rule: continente",
// "built-in: continente|pingo doce", "fallback"), so the classifier can
// measure how often each rule agrees with your reviews.
function categorizeExplained(description, amount) {
  const normalized = normalize(description);
  const isIncome = amount > 0 && !REFUND_RE.test(normalized);
  const txnType = isIncome ? "income" : "expense";
  const type = isIncome ? TYPE_INCOME : TYPE_EXPENSE;
  const defaultRail = isIncome ? "Transferência" : "Cartão";
  const answer = (category, sub, method, source) => ({ type, category, sub, method, source });

  if (GATEWAY_RE.test(normalized)) {
    return answer(UNCLASSIFIED_CATEGORY, UNCLASSIFIED_SUB, overlayMethod(normalized, defaultRail), "gateway");
  }

  const rule = matchOverride(normalized, txnType);
  if (rule) {
    return answer(rule.category, rule.sub_category, overlayMethod(normalized, rule.method || defaultRail),
                  `your rule: ${rule.keywords.join(", ")}`);
  }

  const rules = isIncome ? PURPOSE_INCOME_RULES : PURPOSE_EXPENSE_RULES;
  const builtIn = rules.find(([patterns]) => compileRule(patterns).test(normalized));
  if (builtIn) {
    const [patterns, category, sub, suggestedMethod] = builtIn;
    return answer(category, sub, overlayMethod(normalized, suggestedMethod),
                  `built-in: ${patterns.slice(0, 3).join("|")}`);
  }

  const method = overlayMethod(normalized, defaultRail);
  if (method === "MBWay" || method === "Transferência") {
    if (isIncome) return answer("Transferências Pessoais", method === "MBWay" ? "MBWay" : "Transferência", method, "person transfer in");
    return answer(UNCLASSIFIED_CATEGORY, "Transferências Pessoais", method, "person transfer out");
  }
  return answer(UNCLASSIFIED_CATEGORY, UNCLASSIFIED_SUB, method, "fallback");
}

// [category, sub_category, method] for one bank row.
function categorize(description, amount) {
  const r = categorizeExplained(description, amount);
  return [r.category, r.sub, r.method];
}

// ---------------------------------------------------------------------
// Transaction id
// ---------------------------------------------------------------------

// SHA-1, synchronous (crypto.subtle is async and needs a secure context).
function sha1Hex(message) {
  function rotl(n, s) { return (n << s) | (n >>> (32 - s)); }
  const utf8 = unescape(encodeURIComponent(message));
  const bytes = [];
  for (let i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i));
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push((bitLen / Math.pow(2, i * 8)) & 0xff);

  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  for (let chunkStart = 0; chunkStart < bytes.length; chunkStart += 64) {
    const w = new Array(80).fill(0);
    for (let i = 0; i < 16; i++) {
      w[i] = (bytes[chunkStart + i * 4] << 24) | (bytes[chunkStart + i * 4 + 1] << 16) |
             (bytes[chunkStart + i * 4 + 2] << 8) | (bytes[chunkStart + i * 4 + 3]);
    }
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = temp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map(n => n.toString(16).padStart(8, "0")).join("");
}

// The id is a hash of the transaction itself, so re-importing a file is a
// no-op and overlapping exports de-duplicate on their own.
//
// `occurrence` separates genuinely repeated transactions inside one file (two
// -8,00 € at the same place on the same day). The first keeps the plain key, so
// every id created before this existed is unchanged; the second gets "|2", the
// third "|3". Re-importing the same file numbers them the same way.
function makeTransactionId(dateIso, description, amount, occurrence = 1) {
  let key = `${dateIso}|${description.trim().toLowerCase()}|${amount.toFixed(2)}`;
  if (occurrence > 1) key += `|${occurrence}`;
  return sha1Hex(key).slice(0, 16);
}

// ---------------------------------------------------------------------
// Reading a bank export
// ---------------------------------------------------------------------

const DATE_ALIASES = ["Data Operação", "Data de Operação", "Data", "Date"];
const DESCRIPTION_ALIASES = ["Descrição", "Descricao", "Descrição da transação", "Description"];
const AMOUNT_ALIASES = ["Montante( EUR )", "Montante(EUR)", "Montante (EUR)", "Montante", "Amount", "Valor"];
const BALANCE_ALIASES = ["Saldo Contabilístico( EUR )", "Saldo Contabilístico(EUR)", "Saldo Contabilístico",
                         "Saldo( EUR )", "Saldo", "Balance"];

function findColumn(columns, aliases) {
  return aliases.find(a => columns.includes(a));
}

// ISO date from a Date cell, an ISO string or a day-first "dd-mm-yyyy".
function parseDateFlexible(value) {
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (value instanceof Date) return iso(value.getFullYear(), value.getMonth() + 1, value.getDate());
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return iso(m[3], m[2], m[1]);
  const d = new Date(s);
  return isNaN(d) ? null : iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

// Amount from a number or from text in either convention: "1.424,00" or
// "1,424.00". Whichever separator comes last is the decimal point. A trailing
// minus ("12,34-") is a debit.
const AMOUNT_TEXT_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function parseAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let text = String(value ?? "").trim().replace(/ /g, "").replace(/ /g, "");
  if (!text || ["nan", "none", "null", "undefined"].includes(text.toLowerCase())) return null;
  const negative = text.endsWith("-") || text.startsWith("-");
  text = text.replace(/^[-+]+|[-+]+$/g, "");
  const lastDot = text.lastIndexOf("."), lastComma = text.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    text = text.split(thousands).join("").split(decimal).join(".");
  } else if (lastComma >= 0) {
    text = text.split(",").join(".");
  }
  if (!AMOUNT_TEXT_RE.test(text)) return null;
  const amount = Number(text);
  return negative && amount > 0 ? -amount : amount;
}

const round2 = v => Math.round(v * 100) / 100;

// A meal card (Cartão Alimentação) export, told by its file name. The upload
// also has a checkbox for a file whose name doesn't say so.
function isMealCardFile(fileName) {
  return /alim|refei|meal|coverflex|edenred/i.test(String(fileName));
}

// Bank export rows -> { rows, skipped }. `skipped` counts rows whose date or
// amount could not be read, so the import report can say so out loud.
//
// mealCard: the file is the meal card account's export. Every row then gets
// Method "Cartão Alimentação" (the only way a row gets it, besides your old
// tracker), and money in is the meal allowance: Salário Alimentação.
function rawRowsToTransactions(rawRows, sourceFileName, { mealCard = false } = {}) {
  if (!rawRows.length) return { rows: [], skipped: 0 };
  const columns = Object.keys(rawRows[0]);
  const dateCol = findColumn(columns, DATE_ALIASES);
  const descCol = findColumn(columns, DESCRIPTION_ALIASES);
  const amountCol = findColumn(columns, AMOUNT_ALIASES);
  const balanceCol = findColumn(columns, BALANCE_ALIASES);
  if (!dateCol || !descCol || !amountCol) {
    throw new Error(`Could not find date/description/amount columns. Found: ${columns.join(", ")}`);
  }

  const rows = [];
  const seen = new Map();   // base key -> how many times it appeared in this file
  let skipped = 0;
  for (const raw of rawRows) {
    const dateIso = parseDateFlexible(raw[dateCol]);
    const amount = parseAmount(raw[amountCol]);
    const description = String(raw[descCol] ?? "");
    if (!dateIso || amount === null) { skipped++; continue; }

    const baseKey = `${dateIso}|${description.trim().toLowerCase()}|${amount.toFixed(2)}`;
    const occurrence = (seen.get(baseKey) || 0) + 1;
    seen.set(baseKey, occurrence);

    const balance = balanceCol ? parseAmount(raw[balanceCol]) : null;
    const [year, month] = dateIso.split("-").map(Number);
    const row = {
      transaction_id: makeTransactionId(dateIso, description, amount, occurrence),
      Date: dateIso,
      Notes: description,
      [REVIEW_NOTE]: "",
      [REVIEWED_AT]: "",
      Month: month,
      Year: year,
      "Source File": sourceFileName,
      "Balance (€)": balance === null ? "" : round2(balance),
    };

    const internalSub = internalTransferSub(description);
    if (internalSub) {
      Object.assign(row, {
        Type: TYPE_TRANSFER, Category: INTERNAL_CATEGORY, "Sub-category": internalSub,
        Method: "Transferência", "Amount (€)": round2(amount),
      });
    } else {
      let [category, subCategory, method] = categorize(description, amount);
      const refund = isRefund(description, amount);
      const income = amount > 0 && !refund;
      if (mealCard) {
        method = MEAL_CARD_METHOD;
        if (income) [category, subCategory] = ["Salário Alimentação", "Salário Alimentação"];
      }
      const stored = round2(Math.abs(amount));
      Object.assign(row, {
        Type: income ? TYPE_INCOME : TYPE_EXPENSE,
        Category: category, "Sub-category": subCategory, Method: method,
        "Amount (€)": refund ? -stored : stored,
      });
    }
    rows.push(row);
  }
  return { rows, skipped };
}

// An existing row the user never reviewed whose description is an internal
// transfer, but which was stored before transfers had their own type (as
// income or an expense). Reshaped in place; true if it changed.
function reshapeAsTransfer(r) {
  if (r.Type === TYPE_TRANSFER || r[REVIEWED_AT]) return false;
  const sub = internalTransferSub(r.Notes);
  if (!sub) return false;
  const amount = signedAmount(r);
  Object.assign(r, { Type: TYPE_TRANSFER, Category: INTERNAL_CATEGORY, "Sub-category": sub,
                     Method: "Transferência", "Amount (€)": round2(amount) });
  return true;
}

// ---------------------------------------------------------------------
// Bank balance
// ---------------------------------------------------------------------

// The bank's own balance after the most recent transaction, from the
// "Saldo Contabilístico" column: { date, balance } or null when no export
// carried one. Within the last day the rows' order is unknown, so the closing
// row is the one whose balance is not the starting point of another row.
function latestBankBalance(rows) {
  const withBalance = rows.filter(hasBankBalance);
  if (!withBalance.length) return null;
  const lastDate = withBalance.reduce((max, r) => (r.Date > max ? r.Date : max), "");
  const day = withBalance.filter(r => r.Date === lastDate);
  const cents = v => Math.round(Number(v) * 100);
  const before = new Set(day.map(r => cents(r["Balance (€)"]) - cents(signedAmount(r))));
  const closing = day.find(r => !before.has(cents(r["Balance (€)"]))) || day[day.length - 1];
  return { date: lastDate, balance: Number(closing["Balance (€)"]) };
}

// The bank's balance before the first transaction it reported: the earliest
// day's row whose starting balance is not another row's closing balance.
function earliestOpeningBalance(rows) {
  const withBalance = rows.filter(hasBankBalance);
  if (!withBalance.length) return null;
  const firstDate = withBalance.reduce((min, r) => (r.Date < min ? r.Date : min), withBalance[0].Date);
  const day = withBalance.filter(r => r.Date === firstDate);
  const cents = v => Math.round(Number(v) * 100);
  const closings = new Set(day.map(r => cents(r["Balance (€)"])));
  const first = day.find(r => !closings.has(cents(r["Balance (€)"]) - cents(signedAmount(r)))) || day[0];
  return { date: firstDate, balance: round2(Number(first["Balance (€)"]) - signedAmount(first)) };
}

function hasBankBalance(r) {
  return r["Balance (€)"] !== "" && r["Balance (€)"] != null && Number.isFinite(Number(r["Balance (€)"]));
}

// Check the store against the bank: closing balance - opening balance must
// equal the sum of every transaction the bank reported in between. A gap means
// a transaction is missing or counted twice (or the exports leave a period
// uncovered). Only rows that carry a bank balance take part: cash, the meal
// card and manual entries live in other pockets.
function reconcileWithBank(rows) {
  const opening = earliestOpeningBalance(rows);
  const closing = latestBankBalance(rows);
  if (!opening || !closing) return null;
  const flows = round2(rows.filter(hasBankBalance).reduce((t, r) => t + signedAmount(r), 0));
  const expected = round2(closing.balance - opening.balance);
  return { from: opening.date, to: closing.date, opening: opening.balance, closing: closing.balance,
           flows, gap: round2(expected - flows) };
}

// ---------------------------------------------------------------------
// Encryption of the store (AES-256-GCM, key from your passphrase via PBKDF2).
// File layout: salt (16) | nonce (12) | ciphertext.
// ---------------------------------------------------------------------

const PBKDF2_ITERATIONS = 200000;
const SALT_SIZE = 16;
const NONCE_SIZE = 12;

async function deriveAesKey(passphrase, salt, usage) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial, { name: "AES-GCM", length: 256 }, false, [usage]
  );
}

async function encryptToBlob(plaintextBytes, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_SIZE));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_SIZE));
  const key = await deriveAesKey(passphrase, salt, "encrypt");
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintextBytes));
  const out = new Uint8Array(salt.length + nonce.length + ciphertext.length);
  out.set(salt, 0); out.set(nonce, salt.length); out.set(ciphertext, salt.length + nonce.length);
  return out;
}

async function decryptBlob(blobBytes, passphrase) {
  const salt = blobBytes.slice(0, SALT_SIZE);
  const nonce = blobBytes.slice(SALT_SIZE, SALT_SIZE + NONCE_SIZE);
  const ciphertext = blobBytes.slice(SALT_SIZE + NONCE_SIZE);
  const key = await deriveAesKey(passphrase, salt, "decrypt");
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  } catch (e) {
    throw new Error("Decryption failed: wrong passphrase, or the file is corrupted.");
  }
}
