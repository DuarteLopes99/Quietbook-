// Loads the dashboard's engine into Node the way the browser loads it: the
// same files, as classic scripts, in one shared scope. Used by the tests and
// by scripts/evaluate.js, so both run exactly the dashboard's code.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DASHBOARD = path.join(__dirname, "..", "dashboard");
const FILES = ["rules.js", "engine.js", "classifier.js"];

// Returns $: $("expression") evaluates inside that scope; $.context holds it,
// so large values can be handed over as $.context.name = value.
function loadEngine({ papaparse = false } = {}) {
  const context = vm.createContext({ crypto: globalThis.crypto, TextEncoder, fetch: globalThis.fetch });
  context.self = context;   // PapaParse's UMD wrapper looks for `self`
  const files = (papaparse ? ["vendor/papaparse.min.js"] : []).concat(FILES);
  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(DASHBOARD, file), "utf8"), context, { filename: file });
  }
  const $ = expression => vm.runInContext(expression, context);
  $.context = context;
  return $;
}

module.exports = { loadEngine };
