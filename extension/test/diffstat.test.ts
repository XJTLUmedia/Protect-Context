import { test } from "node:test";
import assert from "node:assert/strict";

import { boundedDiffStat, changedSpan, formatDiffStat, lineCount } from "../lib/diffstat.ts";

test("diffstat: counts a replacement without double counting shared lines", () => {
  // The same fixture is asserted in tests/test_diffstat.py: a changed middle
  // line must read as one added and one removed, not as a whole-file rewrite.
  assert.deepEqual(boundedDiffStat("a\nb\nc\n", "a\nB\nc\n"), { added: 1, removed: 1 });
});

test("diffstat: appends and deletions are counted separately", () => {
  assert.deepEqual(boundedDiffStat("a\n", "a\nb\nc\n"), { added: 2, removed: 0 });
  assert.deepEqual(boundedDiffStat("a\nb\nc\n", "a\n"), { added: 0, removed: 2 });
});

test("diffstat: creating and emptying a file", () => {
  assert.deepEqual(boundedDiffStat("", "x\ny\n"), { added: 2, removed: 0 });
  assert.deepEqual(boundedDiffStat("x\ny\n", ""), { added: 0, removed: 2 });
  assert.deepEqual(boundedDiffStat("same\n", "same\n"), { added: 0, removed: 0 });
});

test("diffstat: the ledger form is compact and empty changes are omitted", () => {
  assert.equal(formatDiffStat({ added: 12, removed: 3 }), "+12/-3");
  assert.equal(formatDiffStat({ added: 0, removed: 0 }), null);
  assert.equal(formatDiffStat(null), null);
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("a"), 1);
});

test("diffstat: the changed span names where the edit landed", () => {
  // Line numbers refer to the new text; the same fixture is asserted in
  // tests/test_diffstat.py.
  const span = changedSpan("a\nb\nc\nd\n", "a\nb\nC\nd\n");
  assert.equal(span.startLine, 3);
  assert.equal(span.endLine, 3);
  assert.equal(span.firstLine, "C");
});

test("diffstat: an insertion reports the inserted lines, a deletion the seat", () => {
  const ins = changedSpan("a\nb\n", "a\nnew1\nnew2\nb\n");
  assert.equal(ins.startLine, 2);
  assert.equal(ins.endLine, 3);
  assert.equal(ins.firstLine, "new1");

  const del = changedSpan("a\nb\nc\n", "a\nc\n");
  assert.equal(del.startLine, 2, "a deletion reports where it happened");
  assert.equal(del.firstLine, "a", "and the line it followed");

  assert.equal(changedSpan("same\n", "same\n").startLine, 0);
});
