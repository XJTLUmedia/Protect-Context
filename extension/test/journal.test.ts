import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendJournal,
  boundedReadLimit,
  countJournal,
  readJournal,
  READ_LIMIT_DEFAULT,
  READ_LIMIT_MAX,
  recentAgentEntries,
  recentCorrections,
  recentDecisions,
  recentJournal,
  renderJournal,
  sanitizeTags,
  tagsWithRequired,
  TAG_COUNT_CAP,
  TAG_TEXT_CAP,
} from "../lib/journal.ts";

function tmpStore(): string {
  return mkdtempSync(join(tmpdir(), "pc-journal-"));
}

test("journal: rejects blank/control-only text", () => {
  const dir = tmpStore();
  try {
    assert.throws(() => appendJournal(dir, { type: "note", text: " \n\t\u0000 " }), /must not be blank/);
    assert.deepEqual(readJournal(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal: tags are single-line, deduplicated and bounded", () => {
  const dirty = [" alpha\n beta ", "alpha beta", "", "x".repeat(100), ...Array.from({ length: 20 }, (_, i) => `t${i}`)];
  const clean = sanitizeTags(dirty);
  assert.equal(clean.length, TAG_COUNT_CAP);
  assert.equal(clean[0], "alpha beta");
  assert.equal(clean[1]?.length, TAG_TEXT_CAP);
  assert.equal(new Set(clean).size, clean.length);
  assert.equal(clean.some((tag) => /[\n\r\t]/.test(tag)), false);
  assert.deepEqual(sanitizeTags("agent"), ["agent"], "legacy scalar tag stays one tag, not five characters");
});

test("journal: required agent provenance cannot be crowded out", () => {
  const tags = tagsWithRequired(Array.from({ length: 20 }, (_, i) => `tag-${i}`), "agent");
  assert.equal(tags.length, TAG_COUNT_CAP);
  assert.equal(tags.at(-1), "agent");
  assert.equal(tags.filter((tag) => tag === "agent").length, 1);
});

test("journal: trusted decision/correction selectors exclude agent-tagged entries", () => {
  const journal = [
    { ts: "1", type: "decision" as const, text: "owner old", tags: [] },
    { ts: "2", type: "decision" as const, text: "model decision", tags: ["agent"] },
    { ts: "3", type: "decision" as const, text: "owner new", tags: ["architecture"] },
    { ts: "4", type: "correction" as const, text: "owner correction", tags: [] },
    { ts: "5", type: "correction" as const, text: "model correction", tags: ["agent"] },
  ];
  assert.deepEqual(recentDecisions(journal, 3).map((entry) => entry.text), ["owner new", "owner old"]);
  assert.deepEqual(recentCorrections(journal, 3).map((entry) => entry.text), ["owner correction"]);
});

test("journal: agent notes are readable, risk entries are not memory", () => {
  const journal = [
    { ts: "1", type: "decision" as const, text: "owner decision", tags: [] },
    { ts: "2", type: "decision" as const, text: "model reasoning", tags: ["agent"] },
    { ts: "3", type: "risk" as const, text: "risky command", tags: ["agent"] },
    { ts: "4", type: "note" as const, text: "model note", tags: ["agent", "docs"] },
  ];
  assert.deepEqual(recentAgentEntries(journal, 5).map((entry) => entry.text), ["model note", "model reasoning"]);
  assert.deepEqual(recentAgentEntries(journal, 1).map((entry) => entry.text), ["model note"]);
  assert.deepEqual(recentAgentEntries(journal, 0), [], "no agent notes without a positive cap");
});

test("journal: read limit is bounded like the Python boundary", () => {
  assert.equal(boundedReadLimit(undefined), READ_LIMIT_DEFAULT);
  assert.equal(boundedReadLimit(500), READ_LIMIT_MAX);
  assert.equal(boundedReadLimit(-3), 0);
  assert.equal(boundedReadLimit(7.9), 7);
  assert.equal(boundedReadLimit(Number.NaN), READ_LIMIT_DEFAULT);
  const journal = Array.from({ length: 30 }, (_, i) => ({
    ts: `t${i}`,
    type: "note" as const,
    text: `entry ${i}`,
    tags: [],
  }));
  assert.equal(recentJournal(journal, 5).length, 5);
  assert.equal(recentJournal(journal, 500).length, READ_LIMIT_MAX, "never returns more than the cap");
  assert.deepEqual(recentJournal(journal, 0), []);
  assert.equal(countJournal(journal, "decision"), 0);
  assert.equal(countJournal(journal), 30);
});

test("journal: render is one line per entry with a Nudge tail", () => {
  const dir = tmpStore();
  try {
    appendJournal(dir, { type: "decision", text: "keep parser untouched", tags: ["scope"] });
    const journal = readJournal(dir);
    const rendered = renderJournal(recentJournal(journal, 5), countJournal(journal));
    const lines = rendered.split("\n");
    assert.equal(lines.length, 3, "header + one entry + nudge");
    assert.match(lines[0]!, /^PC journal · last 1 of 1$/);
    assert.match(lines[1]!, /^.+ · decision · keep parser untouched \[scope\]$/);
    assert.match(lines[2]!, /^Nudge: /);
    const filtered = renderJournal(recentJournal(journal, 5, "correction"), countJournal(journal, "correction"), "correction");
    assert.match(filtered.split("\n")[0]!, /^PC journal correction · last 0 of 0$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
