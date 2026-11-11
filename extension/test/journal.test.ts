import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendJournal,
  boundedReadLimit,
  countJournal,
  detectIntent,
  hasAgentTag,
  intentWithTotal,
  readJournal,
  READ_LIMIT_DEFAULT,
  READ_LIMIT_MAX,
  recentAgentEntries,
  recentCorrections,
  recentDecisions,
  recentJournal,
  recentTrustedEntries,
  renderIntent,
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

test("journal: rejects an unknown type at runtime (no unreadable rows)", () => {
  const dir = tmpStore();
  try {
    assert.throws(
      () => appendJournal(dir, { type: "lesson" as never, text: "not a frozen type" }),
      /unknown journal type/,
    );
    assert.deepEqual(readJournal(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal: the reserved agent tag is matched case-insensitively, past the display cap", () => {
  const tags = ["Agent"];
  assert.equal(hasAgentTag(tags), true, "a stored `Agent` tag is provenance too");
  assert.equal(hasAgentTag([...Array.from({ length: 10 }, (_, i) => `t${i}`), "AGENT"]), true);
  assert.equal(hasAgentTag(["agentic"]), false);
  const journal = [
    { ts: "1", type: "decision" as const, text: "owner row", tags: ["scope"] },
    { ts: "2", type: "decision" as const, text: "model row", tags: ["Agent"] },
  ];
  assert.deepEqual(recentDecisions(journal, 5).map((entry) => entry.text), ["owner row"]);
  assert.deepEqual(recentAgentEntries(journal, 5).map((entry) => entry.text), ["model row"]);
});

test("journal: a zero cap selects no trusted rows", () => {
  const journal = [
    { ts: "1", type: "decision" as const, text: "one", tags: [] },
    { ts: "2", type: "decision" as const, text: "two", tags: [] },
  ];
  assert.deepEqual(recentTrustedEntries(journal, "decision", 0), []);
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

test("journal: owner intent is detected without a query (mirrors journal.detect_intent)", () => {
  assert.deepEqual(detectIntent("owner wants the broad fix"), ["owner-want"]);
  assert.deepEqual(detectIntent("the user needs both runtimes green"), ["owner-need"]);
  assert.deepEqual(detectIntent("I prefer minimal diffs"), ["owner-preference"]);
  assert.deepEqual(detectIntent("CORRECTION (owner): you are wrong about tags"), [
    "owner-correction",
  ]);
  // An agent's own plan is not owner intent, and neither is a plain result.
  assert.deepEqual(detectIntent("I want to check the ledger"), []);
  assert.deepEqual(detectIntent("ran pytest: 258 passed"), []);
  // Naming the tag is not expressing the intent: with `\b` the tag literal
  // "owner-want" matched (boundary between "owner" and "-want").
  assert.deepEqual(detectIntent("tags: owner-want and owner-need"), []);
  assert.deepEqual(detectIntent("the owner-preference tag is set"), []);
  // A quotation is about intent, not an expression of it.
  assert.deepEqual(detectIntent('the test text "owner wants X" is a fixture'), []);
  assert.deepEqual(detectIntent("the fixture `owner wants X` is copy-pasted"), []);
  // ... but quoting inside a real request keeps the request.
  assert.deepEqual(detectIntent('fix the "flaky" test', true), ["owner-want"]);
});

test("journal: owner-authored text needs no attribution (paraphrase is captured)", () => {
  // Only the owner's own prompt may relax the attribution rule; journal prose
  // written by the agent must still require an owner/user noun.
  assert.deepEqual(detectIntent("ship it faster", true), ["owner-want"]);
  assert.deepEqual(detectIntent("ship it faster"), []);
  assert.deepEqual(detectIntent("I'd rather split this into two commits", true), [
    "owner-preference",
  ]);
  assert.deepEqual(detectIntent("I need both runtimes green", true), ["owner-need"]);
  assert.deepEqual(detectIntent("this is wrong", true), ["owner-correction"]);
  assert.deepEqual(detectIntent("unrelated bookkeeping", true), []);
});

test("journal: owner prompts open with connectives and non-code verbs", () => {
  // These are the owner's real prompts; the first detector recognized none of
  // them because it knew 17 verbs and required the verb at position 0.
  assert.deepEqual(detectIntent("now audit the full plugin", true), ["owner-want"]);
  assert.deepEqual(detectIntent("Reinstall the venv from scratch", true), ["owner-want"]);
  assert.deepEqual(detectIntent("now reload the extension and audit", true), ["owner-want"]);
  assert.deepEqual(detectIntent("review the retrieval path", true), ["owner-want"]);
  // A start-anchored negation is a standing constraint, not a correction.
  assert.deepEqual(detectIntent("never commit straight to main", true), ["owner-constraint"]);
  assert.deepEqual(detectIntent("Do not touch the README; use the vendor folder", true), [
    "owner-constraint",
  ]);
  // Owner-typed only: the same words in agent prose stay unclassified.
  assert.deepEqual(detectIntent("never commit straight to main"), []);
  assert.deepEqual(detectIntent("audit the full plugin"), []);
});

test("journal: a captured owner intent is tagged, and provenance survives the cap", () => {
  const dir = tmpStore();
  try {
    const entry = appendJournal(dir, { type: "correction", text: "owner wants the broad fix", tags: ["agent"] });
    assert.deepEqual(entry.tags, ["owner-want", "agent"]);

    const crowded = appendJournal(dir, {
      type: "note",
      text: "owner needs the audit",
      tags: [...Array.from({ length: 10 }, (_, i) => `t${i}`), "agent"],
    });
    assert.equal(crowded.tags.length, TAG_COUNT_CAP);
    assert.equal(crowded.tags.at(-1), "agent", "provenance survives a full tag list");
    assert.equal(crowded.tags[0], "owner-need");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal: intent view groups counts, labels provenance and bounds the page", () => {
  const rows = [
    { ts: "2026-01-01T00:00:00Z", type: "decision" as const, text: "owner approved layering", tags: ["agent"] },
    { ts: "2026-01-02T00:00:00Z", type: "note" as const, text: "owner prefers broad fixes", tags: [] },
    { ts: "2026-01-03T00:00:00Z", type: "note" as const, text: "unrelated entry", tags: [] },
  ];
  const { rows: page, total, counts } = intentWithTotal(rows, 5);
  const text = renderIntent(page, total, counts);
  assert.equal(total, 2);
  assert.equal(counts["owner-want"], 1);
  assert.equal(counts["owner-preference"], 1);
  assert.match(text.split("\n")[0]!, /^PC intent · 2 of 2 owner statements · want 1 · need 0 · preference 1 · constraint 0 · correction 0 · statement 0 · owner 1 · agent 1$/);
  assert.match(text, /\[agent\]/);
  assert.match(text, /\[owner\]/);
  // Newest first, so today's want is easier to act on than last week's.
  assert.ok(text.indexOf("owner-preference") < text.indexOf("owner-want"));
  assert.match(text.split("\n").at(-1)!, /^Nudge: /);

  const zero = intentWithTotal(rows, 0);
  const zeroText = renderIntent(zero.rows, zero.total, zero.counts);
  assert.match(zeroText, /0 of 2 owner statements/);
  assert.match(zeroText, /raise the limit/);
});

test("journal: an owner-prompt row is always an owner statement", () => {
  // Captured owner prompts used to be invisible here: the row was journaled
  // trusted under `owner-prompt`, and no reader classified that tag, so the
  // literal request never reached `intent` or the brief (audit 2026-11-10).
  const rows = [
    {
      ts: "2026-01-01T00:00:00Z",
      type: "note" as const,
      text: "cold start on the parser",
      tags: ["owner-prompt"],
    },
    {
      ts: "2026-01-02T00:00:00Z",
      type: "note" as const,
      text: "now audit the full plugin",
      tags: ["owner-want", "owner-prompt"],
    },
    {
      ts: "2026-01-03T00:00:00Z",
      type: "decision" as const,
      text: "Owner approved the upgrade",
      tags: ["agent"],
    },
    {
      // Provenance outranks the claim: a model row cannot borrow the tag.
      ts: "2026-01-04T00:00:00Z",
      type: "note" as const,
      text: "audit the plugin",
      tags: ["owner-prompt", "agent"],
    },
  ];
  const { rows: page, total, counts } = intentWithTotal(rows, 5);
  const text = renderIntent(page, total, counts);

  assert.equal(total, 3, "the prompt joins the two intent rows");
  assert.equal(counts["owner-statement"], 1);
  assert.equal(counts["owner-want"], 2, "the audit prompt and the agent's paraphrase");
  assert.equal(counts.owner, 2, "both owner-typed rows are trusted");
  assert.equal(counts.agent, 1);
  assert.match(text, /owner-statement · 2026-01-01T00:00:00Z · cold start on the parser \[owner\]/);
});

test("journal: every entry carries a stable, citable id", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-journal-id-"));
  try {
    // The id is the journal's ev-NNNN: without it a decision can only be
    // referenced by recency position, which shifts as rows land.
    const first = appendJournal(dir, { type: "decision", text: "raise the journal cap" });
    const second = appendJournal(dir, { type: "note", text: "and give each row an id" });
    assert.match(String(first.id), /^jn-\d{4,}$/);
    assert.match(String(second.id), /^jn-\d{4,}$/);
    assert.notEqual(first.id, second.id, "ids are unique");
    assert.ok(
      Number(second.id!.slice(3)) === Number(first.id!.slice(3)) + 1,
      "ids increase by one per write",
    );

    // Long text survives the cap instead of being cut mid-sentence.
    const long = appendJournal(dir, { type: "note", text: "z".repeat(1200) });
    assert.equal(Array.from(long.text).length, 1200, "1200 chars is under the 4000 cap");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal: detectIntent reads 中文 statements (mirrors Python)", () => {
  // The English patterns anchor on \b, which has no meaning between Chinese
  // characters, so a 中文 correction was stored and never classified.
  assert.deepEqual(detectIntent("我要求先拆小改动再提交，400 行以上必须拆分", true), [
    "owner-want",
    "owner-constraint",
  ]);
  assert.deepEqual(detectIntent("不要再把版本号和非版本改动混在一个提交里", true), [
    "owner-constraint",
  ]);
  assert.deepEqual(detectIntent("最好先跑一遍完整测试再提交", true), ["owner-preference"]);
  // 我需要 must read as a need, not reach the bare 要 and report a want.
  assert.deepEqual(detectIntent("我需要两个运行时都通过", true), ["owner-need"]);
  assert.deepEqual(detectIntent("主人要求每个改动都要有验证证据"), ["owner-want"]);
  assert.deepEqual(detectIntent("必须重新运行整套测试"), []);
  assert.deepEqual(detectIntent("必须重新运行整套测试", true), ["owner-constraint"]);
  assert.deepEqual(detectIntent("他说「不要提交」", true), []);
});

test("journal: a correction can carry the check that proves it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-journal-check-"));
  try {
    const entry = appendJournal(dir, {
      type: "correction",
      text: "split changes over 400 lines",
      check: "true",
    });
    assert.equal(entry.check, "true");
    assert.equal(readJournal(dir).at(-1)?.check, "true");

    // One line: a second line would be a shell script, not a check.
    const multiline = appendJournal(dir, {
      type: "correction",
      text: "no publish",
      check: "echo a\necho b",
    });
    assert.equal(multiline.check, "echo a echo b");

    // A check on anything but a correction would execute with nothing to prove.
    assert.throws(
      () => appendJournal(dir, { type: "note", text: "a note", check: "true" }),
      /check applies to a correction/,
    );
    assert.equal(
      appendJournal(dir, { type: "note", text: "no check" }).check,
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
