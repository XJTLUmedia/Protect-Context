#!/usr/bin/env node
/**
 * Generate `src/protect_context/lexicon.tsv` — the English/中文 term bridge that
 * both runtimes read.
 *
 *   node scripts/build_lexicon.mjs [--check]
 *
 * The curated pairs in `data/curated.tsv` come first, in file order: they are
 * the vocabulary this tool records and they must win over a dictionary sense.
 * They are followed by pairs derived from CC-CEDICT (the `cc-cedict` npm
 * package, a dev dependency used ONLY here — nothing imports it at runtime).
 *
 * CC-CEDICT is a 中文→English dictionary, so the derived pairs are "the English
 * word whose gloss is X". That direction is exactly what a reverse lookup needs,
 * and it is also why the curated list stays in front: a dictionary gives 分所
 * for "branch" where this domain means 分支.
 *
 * `--check` regenerates in memory and fails if the committed file differs, which
 * is what the test suite runs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src/protect_context/lexicon.tsv");
const CURATED = join(ROOT, "data/curated.tsv");
const CEDICT = join(ROOT, "node_modules/cc-cedict/data/all.js");

// A gloss is a definition, not a query term. These openers mark a cross
// reference ("variant of 王") rather than a meaning, so they carry no bridge.
const GLOSS_NOISE = [
  "variant of",
  "old variant",
  "see also",
  "same as",
  "used in",
  "surname",
  "abbr for",
  "also written",
  "also called",
  "classifier for",
  "taiwan pr",
];

// Function words that are never worth a bridge on their own: they appear in a
// hundred glosses and would fan one query out into noise. Deliberately short —
// dropping real content words costs reach, and IDF already discounts a term
// that every row contains.
const TERM_STOP = new Set([
  "kind",
  "sort",
  "thing",
  "part",
  "case",
  "way",
  "place",
  "person",
  "used",
  "also",
  "one",
  "two",
  "many",
  "small",
  "large",
  "old",
  "new",
]);

const CJK = /^[\u3400-\u9fff]+$/;

function readCurated() {
  const pairs = [];
  for (const line of readFileSync(CURATED, "utf8").split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;
    const [english, chinese, extra] = text.split("\t");
    if (!english || !chinese || extra !== undefined) {
      throw new Error(`curated.tsv: expected "english<TAB>中文", got: ${text}`);
    }
    pairs.push([english.trim(), chinese.trim()]);
  }
  return pairs;
}

/** Split a CC-CEDICT gloss into candidate English terms. */
function englishTerms(gloss) {
  if (typeof gloss !== "string") return [];
  const lower = gloss.toLowerCase();
  if (GLOSS_NOISE.some((noise) => lower.startsWith(noise))) return [];
  return lower
    .replace(/\([^)]*\)/g, " ") // "(computing) to roll back" -> " to roll back"
    .split(/[;/,]/)
    .map((part) => part.replace(/^(?:to|a|an|the|be|being)\s+/, "").trim())
    .map((part) => part.replace(/[^a-z0-9 '-]/g, " ").replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 3 && /[a-z]{2}/.test(part))
    // "-mycin", "0 0001 meters", "000 hz": prefixes and unit tables are noise
    // for a query term, so a gloss must start with a letter and hold no digits.
    .filter((part) => /^[a-z]/.test(part) && !/[0-9]/.test(part))
    .filter((part) => part.split(" ").length <= 3)
    .filter((part) => !TERM_STOP.has(part));
}

function dictionaryPairs() {
  const source = readFileSync(CEDICT, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(source.replace(/^export default /, "").replace(/;\s*$/, ""));
  } catch (error) {
    throw new Error(`build_lexicon: cannot parse ${CEDICT}: ${String(error)}`);
  }
  const all = parsed?.all;
  if (!Array.isArray(all)) throw new Error(`build_lexicon: ${CEDICT} has no "all" array`);
  const seen = new Set();
  const pairs = [];
  for (const entry of all) {
    if (!Array.isArray(entry)) continue;
    const [, simplified, , gloss] = entry;
    if (typeof simplified !== "string" || !CJK.test(simplified)) continue;
    // One character is not a term: Chinese substring matching runs both ways,
    // so 库 inside 生产库 would otherwise drag in every 库 sense at once.
    if (simplified.length < 2 || simplified.length > 4) continue;
    for (const english of englishTerms(gloss)) {
      const key = `${english}\t${simplified}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([english, simplified]);
    }
  }
  pairs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0));
  return pairs;
}

function render() {
  const curated = readCurated();
  const curatedKeys = new Set(curated.map(([english, chinese]) => `${english}\t${chinese}`));
  const curatedEnglish = new Set(curated.map(([english]) => english));
  const curatedChinese = new Set(curated.map(([, chinese]) => chinese));
  // A curated pair is authoritative, so a dictionary line that repeats one is
  // dropped; a dictionary pair whose *curated* side already has a bridge keeps
  // its place after it, because both are real senses.
  const dictionary = dictionaryPairs().filter(([english, chinese]) => {
    if (curatedKeys.has(`${english}\t${chinese}`)) return false;
    if (curatedEnglish.has(english) || curatedChinese.has(chinese)) return false;
    return true;
  });
  const lines = [
    "# GENERATED by scripts/build_lexicon.mjs — do not edit by hand.",
    "# English<TAB>中文 term pairs for the recall bridge: curated first, then CC-CEDICT.",
    "# CC-CEDICT is CC BY-SA 4.0 (see NOTICE); the curated pairs above it are MIT.",
    `# curated: ${curated.length} | dictionary: ${dictionary.length}`,
    "",
    "# --- curated (the vocabulary this tool records; returned before any dictionary sense) ---",
  ];
  for (const [english, chinese] of curated) lines.push(`${english}\t${chinese}`);
  lines.push("", "# --- dictionary (derived from CC-CEDICT; capped per query at load time) ---");
  for (const [english, chinese] of dictionary) lines.push(`${english}\t${chinese}`);
  return lines.join("\n") + "\n";
}

const text = render();
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    console.error(`build_lexicon: ${OUT} is missing — run node scripts/build_lexicon.mjs`);
    process.exit(1);
  }
  if (current !== text) {
    console.error("build_lexicon: lexicon.tsv is stale — run node scripts/build_lexicon.mjs");
    process.exit(1);
  }
  console.log("build_lexicon: lexicon.tsv is up to date");
} else {
  writeFileSync(OUT, text);
  const rows = text.split("\n").filter((line) => line !== "" && !line.startsWith("#")).length;
  console.log(`build_lexicon: wrote ${rows} pairs, ${(text.length / 1024).toFixed(0)} KB -> ${OUT}`);
}
