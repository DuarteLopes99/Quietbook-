# Categorization

How a bank description becomes a Category / Sub-category / Method. Code: `categorize()` in
`dashboard/engine.js`. Tables: `dashboard/rules.js`.

## The taxonomy comes first

`TAXONOMY` in rules.js lists every Category → Sub-category pair that may exist, per type
(`Expense`, `Income`, `Transfer`). Every writer refuses a pair outside it: the import (rules must
point at valid pairs, enforced by `tests/rules.test.js`), the review panel's pickers, and the data
health check. A free-text category is how a store ends up with "Gasoleo" next to "Gasóleo".

## Two questions, never mixed

1. **What was it for?** → Category / Sub-category, from purpose keywords only.
2. **How was it paid?** → Method, from rail keywords (`mbway`, `transferencia`, `coverflex`...).

"Mbway - Cinemas NOS" is Lazer / Cinema-Espetáculos **and** MBWay. MBWay and Transferência are
only ever a Method, never a category.

## The ladder

Top wins:

| # | Rung | Source |
|---|---|---|
| 0 | Your review | `review_decisions.json`. Never overwritten by anything below. |
| 1 | Internal transfer | `INTERNAL_RULES` → Type Transfer (see pipeline-overview.md) |
| 2 | Payment gateway | `GATEWAY_PATTERNS`: the merchant is hidden, so it goes to review |
| 3 | Your rules | `category_overrides.json`, saved with "Remember as a rule" |
| 4 | Built-in rules | `PURPOSE_EXPENSE_RULES` / `PURPOSE_INCOME_RULES`, first match wins |
| 5 | Transfer to/from a person | Income → Transferências Pessoais; expense → Outros / Transferências Pessoais |
| 6 | Nothing matched | Outros / Por Classificar: the Needs review queue |

Rules re-run over unreviewed rows in the review queue on every load and after every new rule, so a
rule you add today also files what is already in the store.

## Refunds

Money **in** with a refund word (`devolucao`, `estorno`) is not income. It is categorized on the
expense side and stored as a **negative expense** under the purchase's pair, so it lowers that
category's spending. In the review panel, any incoming row can be marked as a refund.

## Matching

- Descriptions are **normalized**: lowercase, spaces collapsed, accents stripped. Patterns are
  written without accents.
- Each pattern is a regex fragment wrapped in ASCII word boundaries, so `bar` matches
  "Bar do Largo" but not "Barbearia". Avoid `\b`, `\w` and `\p{...}` (the tests check).
- Your rules hold plain keywords (escaped, not regex); several keywords, comma-separated, are
  alternatives.

## How it learns: your rules

The only learning mechanism. In the review panel, tick **Remember as a rule** and edit the keyword
to its distinctive part ("continente", not "continente lisboa 1234"). The rule is saved with the
pair and, for a card payment, the method. On an MBWay or Transferência row the keyword starts as
the person's name and the method is left to each description.

The box is always unticked: a person can send you rent one month and a gift the next, so whether
a rule holds is your call. "Apply to identical items" in the panel is a one-off and saves no rule.

## Adding a built-in rule

Edit `dashboard/rules.js`:

```js
// [patterns, category, sub_category, suggestedMethod]
[["padel", "padel club"], "Desporto", "Outros", "Cartão"],
```

Order matters: the first matching rule wins, so put a specific rule above a general one
(`uber eats` before `uber`). Then run `node --test`.

## Changing the taxonomy

Add or rename pairs in `TAXONOMY`. When you rename one, add the old name to `LEGACY_ALIASES`
(`"Type|Old category|old sub": ["New category", "New sub"]`) so review decisions saved under the
old name still land in the right place.

## Auditing what the rules decided

Transactions → review filter **Auto-classified, unchecked**: rows a rule filed that nobody has
looked at. Filter to one category to audit a rule you just wrote.

## Re-run the classification (Review tab)

The rules file every import. The **Re-run the classification** card runs every method over
every transaction at once and shows, side by side, what each would file and how sure it is.
Nothing changes until you preview a re-run and confirm it. Code: `dashboard/classifier.js`.

What the card shows:

1. **A guide** to what each method trusts.
2. **Which method to trust**: per method, how often it was right on your newest reviews (trained
   on the older ones), how often it was right when it said it was sure, its average confidence on
   the rows you haven't reviewed, how many of those it is sure about, and how many it would change.
   A sentence below says which is most accurate and which methods' sure answers are safe to apply
   (right at least 95% of the time). "Sure" is a level you set (default 90%).
3. **Where the methods differ**, row by row: every method's answer and confidence next to the
   current category and where it came from, followed by its next two candidates ("then ..."). The default filter shows rows where the methods
   disagree and at least one of them is sure.
4. **Re-run** ("Re-run all transactions..."): files every transaction **in scope** with the chosen
   method, previews every change, then keeps the result as a **version**. In scope means neither
   yours nor filed by a hard rule: not reviewed (nor copied from a review, nor from the old
   tracker), and not filed by one of your rules or a built-in rule. What is left is what the rules
   could only guess: nothing matched, a person transfer, a hidden payment gateway, or a row an
   earlier re-run filed (`inRerunScope` in classifier.js). Only answers at or above the "sure" level
   are kept; the rest keep the rules' answer.
5. **Versions**: every re-run, with its method, date, sure level and how many rows it filed, plus
   "Rules only". "Make active" re-files every row in scope by that version (the rules' answer where
   it had none) and the whole dashboard follows (`versionTargets`). Kept in
   `data/classification_runs.json` (gitignored); the active version's answers are also review
   decisions with source `rerun`, so they survive a rebuild. Re-run answers made before versions
   existed are kept as a version of their own.

Above the card, **How your transactions are classified** counts every transaction by where its
category comes from (the Filed by list below), how many of each a re-run may change, and which
version is active.

Below it, **By category** lists each Category / Sub-category as a group. Each row shows how well it
fits: its 5 nearest reviews of yours that read alike (similarity at least 0.2), how many sit in the
same category, and "looks like X" when at least two agree on one other category, more than on this
one (`categoryFit`). Groups with such rows come first. "Mark checked" folds a group away (kept in
`data/checked_groups.json`, gitignored) until a new transaction joins it; it stamps nothing as
reviewed, so rules and re-runs can still change those rows.

| Method | What it does | Confidence |
|---|---|---|
| Current rules (default) | The ladder above, exactly what the store uses | Share of your reviews the rule that fired got right, smoothed: `(right + 1) / (fired + 2)`. 0 when no rule matched. |
| Similar past reviews | The 5 nearest reviewed transactions (TF-IDF over words, character 3- to 5-grams, amount band, method) vote with their similarity | Winning label's share of the vote x the best similarity |
| Rules + similar reviews | Whichever of the two is more confident, per row | That method's |
| + Qwen (local) | The above, then a local Qwen for rows below 60%, shown the 8 most similar reviews as examples (RAG) | The model's own figure: not a measured probability, check it in the notebook |

Rules to keep it honest:

- **Every method learns only from rows you reviewed by hand** (`Reviewed At` set). Never from
  rule-filed rows or from accepted predictions, so it cannot learn the rules' mistakes or its own.
- On a reviewed row the method never votes for the row itself.
- An applied answer marks the row `⚙ filed by ...` and is saved in `review_decisions.json` without a
  review timestamp (with the category it replaced): it survives a rebuild, shows as "Re-run ⚙" in
  every section, and never becomes training data. Data health checks that this holds.
- Rows where a sure method disagrees with your review are the ones to look at: a confident rule that
  disagrees with you is a rule to fix.

### Top 3 in the review panel

When you open a transaction to review it, the panel lists the combined method's top 3 (your rules
and similar reviews), best first, with their confidence. A click fills the pickers; nothing is
saved until Save. On the newest quarter of your reviews the right answer was first 60% of the
time and within the top 3 76% of the time.

### Where every category came from

The Transactions table has a **Filed by** column, and Data health counts them: You, Your review
(copied to an identical description), Your old tracker (rows seeded from the Excel tracker you kept before the dashboard; they count as
reviewed, so they are training data and nothing overwrites them),
Your rule, Built-in rule, Person transfer, Re-run ⚙, Internal transfer, Not filed yet, and
Earlier rules (an unreviewed row the current rules would now file differently). The review filter
"Filed by a re-run (⚙)" lists every re-run answer.

### Measuring which method is best

`notebook/tests_and_evaluation.ipynb` runs `scripts/evaluate.js`: train on the older 75% of your
reviews, test on the newest 25%, and report accuracy, accuracy on merchants never seen in training,
coverage and accuracy at each acceptance threshold, and accuracy per confidence band. It prints
aggregates only.

```bash
node scripts/evaluate.js              # rules, similar, hybrid
node scripts/evaluate.js --qwen 40    # also Qwen, on at most 40 unsure test rows
```

The test set is rows you reviewed, and you mostly review what the rules could not file, so it
measures the hard cases, not how often the rules are right overall.

### The local Qwen

Free and local: the dashboard server forwards the prompt to Ollama on this machine
(`/api/llm/chat`, only accepted from the dashboard page). Default model: Qwen3.5-9B, 4-bit GGUF from
Hugging Face (about 6 GB), which fits a 16 GB Mac. Qwen3.8-27B needs about 17 GB for its 4-bit
weights alone, so it needs a 32 GB machine.

```bash
brew install ollama        # or the app from ollama.com
ollama pull hf.co/bartowski/Qwen_Qwen3.5-9B-GGUF:Q4_K_M
# another model: set FINANCE_OLLAMA_MODEL (and FINANCE_OLLAMA_URL) before starting the dashboard
```
