/**
 * A small English suffix stemmer for recall matching.
 *
 * `wordHit` only matches a keyword at a word *start*, so the useful direction is
 * one-way: `patch` finds `patches` but `patches` finds nothing, and `retrieving`
 * never reaches a row about `retrieval`. That is the measured morphology gap
 * (three of three probe queries returned no rows).
 *
 * A full Porter stemmer is the usual answer, but it over-stems for a small
 * personal journal: `organization` collapses to `organ` and starts matching
 * `organic`. This module strips only the inflectional and derivational endings
 * that actually appear in pasted commands and decision notes, with length guards
 * so short words keep their identity. It is deliberately conservative: a missed
 * match costs one paraphrase, a wrong match costs precision the owner has to
 * notice.
 *
 * Everything here is pure, deterministic, and ASCII-only: a token that is not
 * all ASCII letters is returned unchanged, so a CJK run or `ev-0007` is never
 * mangled. Line-for-line mirror of `src/protect_context/stem.py`.
 */

/** Below this length nothing is stripped: "is", "was", "old" keep their identity. */
const MIN_STEM = 4;

const VOWELS = new Set(["a", "e", "i", "o", "u"]);

/** True when `word[index]` is a consonant; `y` flips on the preceding letter. */
function isConsonant(word: string, index: number): boolean {
  const char = word[index] as string;
  if (VOWELS.has(char)) return false;
  if (char !== "y") return true;
  return index === 0 || !isConsonant(word, index - 1);
}

/** True when the word ends in the same consonant twice ("runn", "stopp"). */
function isDoubledFinal(word: string): boolean {
  if (word.length < 2) return false;
  return (
    word[word.length - 1] === word[word.length - 2] &&
    isConsonant(word, word.length - 1)
  );
}

/** True when the word ends consonant-vowel-consonant ("hop", "run"). */
function isCvc(word: string): boolean {
  if (word.length < 3) return false;
  const a = word[word.length - 3] as string;
  const b = word[word.length - 2] as string;
  const c = word[word.length - 1] as string;
  return (
    isConsonant(word, word.length - 3) &&
    !isConsonant(word, word.length - 2) &&
    isConsonant(word, word.length - 1) &&
    !"wxy".includes(c) &&
    a !== "" &&
    b !== ""
  );
}

/** A stem must keep at least one vowel, or word-initial noise survives. */
function isValidStem(word: string): boolean {
  if (word.length < 2) return false;
  for (const char of word) if (VOWELS.has(char)) return true;
  return false;
}

/** Undo -ing/-ed and repair the consonant the suffix swallowed. */
function afterInflection(word: string): string {
  // The collapse keeps three letters: "adding" must reach "add", not "ad",
  // because a three-letter word is below MIN_STEM and is never stripped.
  // -l/-s/-z are kept doubled for short words ("filling" -> "fill", never
  // "fil") but collapse in long ones, which is what joins the British spelling
  // "journalling" to "journal".
  const last = word[word.length - 1] as string;
  const collapse = !"lsz".includes(last) || word.length > 5;
  if (isDoubledFinal(word) && collapse && word.length > 3) {
    return word.slice(0, -1);
  }
  // "hoped" would otherwise stem to "hop" and collide with "hop" itself;
  // restoring the e keeps "hope" and "hop" apart.
  if (isCvc(word)) return `${word}e`;
  return word;
}

/** ASCII letters only, mirroring Python's `str.isalpha()` on a lowercased token. */
function isAsciiAlpha(word: string): boolean {
  if (word === "") return false;
  for (const char of word) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 65 || (code > 90 && code < 97) || code > 122) return false;
  }
  return true;
}

/**
 * Return the stem of `token`. Never throws, never returns "".
 *
 * `Retrieving` -> `retriev`, `retrieval` -> `retriev`, `decisions` -> `decision`,
 * `journalled` -> `journal`.
 */
export function stem(token: string): string {
  if (typeof token !== "string") return "";
  let word = token.trim().toLowerCase();
  if (word.length < MIN_STEM || !isAsciiAlpha(word)) return word;

  // Step 1: plurals and third-person -s.
  if (word.endsWith("ies") && word.length > 4) {
    word = `${word.slice(0, -3)}y`;
  } else if (word.endsWith("ied") && word.length > 4) {
    // "verified" is "verify" + "ied", not "verifi" + "ed"; without this the
    // past tense stops matching the present ("verifying" -> "verify").
    word = `${word.slice(0, -3)}y`;
  } else if (
    word.endsWith("sses") ||
    word.endsWith("xes") ||
    word.endsWith("zes") ||
    word.endsWith("ches") ||
    word.endsWith("shes")
  ) {
    word = word.slice(0, -2);
  } else if (
    word.endsWith("s") &&
    !word.endsWith("ss") &&
    !word.endsWith("us") &&
    !word.endsWith("is")
  ) {
    word = word.slice(0, -1);
  }

  // Step 2: -ing / -ed. The guards are inclusive so a five-letter past tense
  // ("hoped") still reaches its stem; both sides then land on "hope".
  if (word.endsWith("ing") && word.length >= MIN_STEM + 2) {
    word = afterInflection(word.slice(0, -3));
  } else if (word.endsWith("ed") && word.length >= MIN_STEM + 1) {
    word = afterInflection(word.slice(0, -2));
  }

  // Step 3: adjective and adverb endings. The length guards keep "normal" and
  // "formal" intact while still joining "retrieval" to "retrieve".
  if (word.endsWith("est") && word.length > 6) {
    word = word.slice(0, -3);
  } else if (word.endsWith("er") && word.length > 6) {
    word = word.slice(0, -2);
  }
  if (word.endsWith("ly") && word.length > MIN_STEM + 1) {
    word = word.slice(0, -2);
  }
  if (word.endsWith("al") && word.length > 7) {
    word = word.slice(0, -2);
  }

  // Step 4: a trailing -e carries no signal once the suffix is gone, and
  // dropping it is what makes "retrieve" meet "retrieving".
  if (word.endsWith("e") && word.length > MIN_STEM) {
    word = word.slice(0, -1);
  }

  return isValidStem(word) ? word : token.trim().toLowerCase();
}

const WORD_CHAR = /^[\p{L}\p{N}]$/u;

/**
 * Split `text` into lowercased word tokens, dropping punctuation.
 *
 * Splits on every non-alphanumeric character, so `src/recall.py` yields `src`,
 * `recall`, `py`. A run of non-ASCII letters is kept whole: an unsegmented CJK
 * sentence has no spaces and must not be cut apart.
 */
export function tokenize(text: string): string[] {
  if (typeof text !== "string" || text === "") return [];
  const found: string[] = [];
  let current = "";
  for (const char of text.toLowerCase()) {
    if (WORD_CHAR.test(char)) {
      current += char;
    } else if (current !== "") {
      found.push(current);
      current = "";
    }
  }
  if (current !== "") found.push(current);
  return found;
}

/** The set of stems in `text`: the membership test for stem matching. */
export function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of tokenize(text)) out.add(stem(token));
  return out;
}

/**
 * How many word tokens `text` holds, without allocating an array.
 *
 * BM25 needs a document length, and the length must be counted the same way
 * `tokenize` splits, or two rows with identical text would normalise
 * differently.
 */
export function countTokens(text: string): number {
  if (typeof text !== "string" || text === "") return 0;
  let count = 0;
  let inside = false;
  for (const char of text) {
    if (WORD_CHAR.test(char)) {
      if (!inside) {
        count += 1;
        inside = true;
      }
    } else {
      inside = false;
    }
  }
  return count;
}

export {
  isConsonant,
  isDoubledFinal,
  isCvc,
  isValidStem,
  isAsciiAlpha,
  afterInflection,
  MIN_STEM,
};
