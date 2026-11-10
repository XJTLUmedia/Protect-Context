/**
 * Near-duplicate suppression: the classifier and the page filter.
 *
 * The fixtures are duplicated in tests/test_dedup.py so both runtimes collapse
 * the same pairs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DocumentFrequencies,
  classify,
  idf,
  normalized,
  suppress,
  words,
} from "../lib/dedup.ts";

function freq(rows: string[]): DocumentFrequencies {
  return new DocumentFrequencies(rows.map((row) => words(row)));
}

test("dedup: identical rewrites collapse to one entry", () => {
  const rows = [
    ...Array<string>(5).fill("Rotation keeps three segments of the ledger."),
    "Rotation also drops pinned lessons last.",
  ];
  const kept = suppress(rows, 5);
  assert.deepEqual(
    kept.map((index) => (rows[index] as string).slice(0, 12)),
    ["Rotation kee", "Rotation als"],
  );
});

test("dedup: opposite sentences sharing every other word stay apart", () => {
  // The failure plain token overlap cannot avoid: same subject, opposite claim.
  // The differing token ("drops" / "keeps") is rare, so the veto fires.
  const left = "rotation drops pinned lessons";
  const right = "rotation keeps pinned lessons";
  assert.equal(classify(left, right, freq([left, right, "unrelated noise about tests"])), "none");
});

test("dedup: exact tier ignores case and punctuation", () => {
  const frequencies = freq(["Rotation keeps three segments."]);
  assert.equal(
    classify("Rotation keeps three segments.", "rotation  keeps three segments", frequencies),
    "exact",
  );
});

test("dedup: punctuation-only rows never auto-merge", () => {
  // An empty normal form identifies nothing, so collapsing it would lose rows.
  assert.equal(classify("!!", "!!", freq(["!!", "!!"])), "none");
});

test("dedup: unrelated rows are not candidates", () => {
  const frequencies = freq(["recall ranking uses bm25 saturation", "recall searches every row"]);
  assert.equal(
    classify("recall ranking uses bm25 saturation", "recall searches every row", frequencies),
    "none",
  );
});

test("dedup: suppress stops at the requested count", () => {
  const rows = ["alpha beta gamma", "delta epsilon zeta", "eta theta iota"];
  assert.deepEqual(suppress(rows, 0), []);
  assert.deepEqual(suppress(rows, 2), [0, 1]);
  assert.deepEqual(suppress(rows, 10), [0, 1, 2]);
});

test("dedup: compound identifiers stay single tokens", () => {
  // Splitting on the hyphen would make "api" look common and disarm the veto.
  assert.deepEqual(words("rdlp-api ffmpeg-7.1.conf"), ["rdlp-api", "ffmpeg-7.1.conf"]);
});

test("dedup: normalized keeps one space between tokens", () => {
  assert.equal(normalized("  Rotation,  keeps: three  "), "rotation keeps three");
});

test("dedup: idf rewards rarity and survives zero frequency", () => {
  const common = idf(50, 100);
  const rare = idf(1, 100);
  assert.ok(rare > common && common > 0);
  assert.ok(idf(0, 100) > rare);
});
