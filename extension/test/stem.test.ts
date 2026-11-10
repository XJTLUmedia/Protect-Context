/**
 * Suffix stemmer: the morphology layer under recall matching.
 *
 * GOLDEN is duplicated verbatim from tests/test_stem.py. That is deliberate: the
 * two runtimes must produce the same stems or the same journal ranks differently
 * depending on which host asked, so a change here must be mirrored there and
 * will fail one suite until it is.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { stem, stems, tokenize, MIN_STEM } from "../lib/stem.ts";

// (token, expected stem) — mirrored from tests/test_stem.py.
const GOLDEN: Array<[string, string]> = [
  ["retrieving", "retriev"],
  ["retrieval", "retriev"],
  ["retrieve", "retriev"],
  ["retrieved", "retriev"],
  ["decisions", "decision"],
  ["decision", "decision"],
  ["journalling", "journal"],
  ["journalled", "journal"],
  ["journal", "journal"],
  ["memories", "memory"],
  ["memory", "memory"],
  ["verified", "verify"],
  ["verifying", "verify"],
  ["verifies", "verify"],
  ["searched", "search"],
  ["searching", "search"],
  ["rotations", "rotation"],
  ["rotated", "rotat"],
  ["running", "run"],
  ["stopped", "stop"],
  ["adding", "add"],
  ["added", "add"],
  ["moved", "move"],
  ["cached", "cach"],
  ["queues", "queu"],
  // Guarded: too short, or the guard is what keeps them apart.
  ["old", "old"],
  ["is", "is"],
  ["total", "total"],
  ["note", "note"],
  ["normal", "normal"],
  ["formal", "formal"],
  ["organic", "organic"],
  ["organization", "organization"],
  ["hop", "hop"],
  // Not ASCII letters: returned untouched.
  ["ev-0007", "ev-0007"],
  ["src/recall.py", "src/recall.py"],
  ["检索", "检索"],
  ["", ""],
];

test("stem: golden table mirrors Python", () => {
  for (const [token, expected] of GOLDEN) {
    assert.equal(stem(token), expected, `${token} -> ${expected}`);
  }
});

test("stem: inflections of one word share a stem", () => {
  // The measured gap: wordHit() matched a keyword at a word start only, so a
  // query for the inflected form found nothing.
  const families = [
    ["retrieving", "retrieval", "retrieve", "retrieved"],
    ["decisions", "decision"],
    ["journalling", "journalled", "journal"],
    ["memories", "memory"],
    ["verified", "verifying", "verifies"],
    ["adding", "added", "add"],
  ];
  for (const family of families) {
    assert.equal(new Set(family.map(stem)).size, 1, family.join(","));
  }
});

test("stem: distinct words keep distinct stems", () => {
  // Over-stemming is the failure a conservative rule set trades against: these
  // pairs must not collapse, or recall starts answering the wrong entry.
  const pairs: Array<[string, string]> = [
    ["old", "threshold"],
    ["arch", "search"],
    ["normal", "form"],
    ["formal", "form"],
    ["organic", "organization"],
    ["is", "his"],
    ["total", "tot"],
    ["hop", "hoped"],
  ];
  for (const [left, right] of pairs) {
    assert.notEqual(stem(left), stem(right), `${left} vs ${right}`);
  }
});

test("stem: tokenisation splits punctuation but keeps a CJK run whole", () => {
  assert.deepEqual(tokenize("src/recall.py: word_hit"), ["src", "recall", "py", "word", "hit"]);
  assert.deepEqual(tokenize("检索 匹配"), ["检索", "匹配"]);
  assert.deepEqual(tokenize(""), []);
});

test("stem: the membership set used by matching", () => {
  const found = stems("The retrieval path changed after rotation.");
  assert.ok(found.has("retriev"));
  assert.ok(found.has("rotation"));
  assert.ok(stems("retrieving").has("retriev"));
  assert.equal(MIN_STEM, 4);
});
