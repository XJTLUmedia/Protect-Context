import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOneLine, trunc } from "../lib/text.ts";
import { truncLine } from "../lib/brief.ts";

test("text: trunc caps length with an ellipsis", () => {
  assert.equal(trunc("short", 200), "short");
  assert.equal(trunc("x".repeat(500), 200), "x".repeat(199) + "…");
  assert.equal(trunc("abcdef", 3).length, 3);
  assert.equal(trunc("abcdef", 3), "ab…");
  assert.equal(trunc("😀😀", 2), "😀😀");
  assert.equal(trunc("😀😀😀", 2), "😀…");
  // A zero cap must not smuggle the ellipsis in: it would exceed the budget.
  assert.equal(trunc("abcdef", 0), "");
  assert.equal(trunc("abcdef", -5), "");
});

test("text: truncLine collapses whitespace first, then caps", () => {
  assert.equal(truncLine("  a\n\tb   c  "), "a b c");
  assert.equal(truncLine("x".repeat(500) + "\nmore", 200), "x".repeat(199) + "…");
});

test("text: normalizeOneLine strips control/format/surrogate characters", () => {
  assert.equal(normalizeOneLine(" a\n\u0000b\u200Bc\ud800 d ", 100), "a b c d");
  assert.equal(normalizeOneLine("abcdef", 3), "abc");
  assert.equal(normalizeOneLine("😀😀", 1), "😀", "cap cannot split a surrogate pair");
});
